// The `tension` command: argument parsing and dispatch.
//
// The parser is hand-written and small on purpose. Every option here is one this
// version actually implements, and an unknown one is refused rather than
// forwarded — a flag that is accepted and ignored is a flag the user will
// believe is working.

import { ConfigError, loadConfig, projectPaths } from './config.js';
import { bundle } from './bundle.js';
import { doctor } from './doctor.js';
import { dev } from './dev.js';
import { init, TEMPLATES } from './init.js';
import { compiler, findProject, framework, runtime, sessionAsconfig } from './project.js';
import { die, readJson, step } from './util.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = readJson(join(here, '..', 'package.json'), 'JSON')?.version ?? '0.0.0';

const HELP = `usage: tension <command> [options]

The Tension toolchain: scaffold a project, run it, and build it.

commands:
  init [dir]        create a project from a template (default: the 2D starter)
  dev               build, run, and restart on change
  build             compile, pack, and write a self-contained dist/
  doctor            report what this machine resolves, and what is missing

Run \`tension <command> --help\` for a command's own options.

A project is a directory with a package.json and a tension.config.json. The
config is the only project file that belongs to Tension; the runtime itself
takes a .wasm and no app configuration, so the CLI is what turns the config
into the runtime's arguments.`;

const HELP_INIT = `usage: tension init [dir] [options]

Create a project from a template.

options:
  --template <name>   ${Object.keys(TEMPLATES).join(' | ')} (default: starter)
                      aliases: 2d = starter, 3d = ogre
  --name <name>       package name (default: the directory's name)
  --force             write into a directory that is not empty
  --install           run npm install afterwards
  -h, --help          print this help`;

const HELP_DEV = `usage: tension dev [options] [-- <guest args>]

Build the guest, run it, and restart it when src/ or assets/ change.

options:
  --headless          run with no window (the guest gets --headless)
  --no-watch          build and run once; exit when the game exits
  --build-only        build, print the command line, and exit
  --debug             compile with --debug --sourceMap
  --dir <path>        the project directory (default: the working directory)
  -h, --help          print this help

A restart loses state: the runtime is one .wasm per process, so a change
restarts the process. A build that fails leaves the running game alone.`;

const HELP_BUILD = `usage: tension build [options]

Compile the guest, pack the assets, and write a dist/ that runs on its own:
the host binary, any adapter libraries, the volume, and a launcher.

options:
  --debug             compile with --debug --sourceMap
  --out <dir>         where to write (default: dist/)
  --dir <path>        the project directory (default: the working directory)
  -h, --help          print this help`;

const HELP_DOCTOR = `usage: tension doctor [options]

Report the resolved host, adapter, compiler and library paths, and the checks
that fail on this machine. Exits non-zero when a check fails.

options:
  --headless          do not warn about a missing display
  --dir <path>        the project directory (default: the working directory)
  -h, --help          print this help`;

/** Split argv into options and positionals, refusing what it does not know. */
function parse(argv, known, { allowPositionals = false } = {}) {
  const options = { _: [], extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Everything after `--` belongs to the guest, verbatim.
      options.extra = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith('-')) {
      if (!allowPositionals) die(`unexpected argument: '${arg}'`, 'run `tension --help`');
      options._.push(arg);
      continue;
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const spec = known[flag];
    if (!spec) die(`unknown option: '${flag}'`, 'run `tension --help` for the ones this version has');
    // A flag is an object (`flag('force')`); a value option is the key itself.
    if (typeof spec === 'object') {
      options[spec.name] = true;
      continue;
    }
    // A value option: inline (`--out=dir`) or the next argument.
    const value = inline ?? argv[++i];
    if (value === undefined) die(`option '${flag}' needs a value`);
    options[spec] = value;
  }
  return options;
}

const flag = (name) => ({ boolean: true, name });

/** Print a config file's problems, all of them, then exit. */
function configFailure(error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`tension: ${error.path} cannot be used:\n\n`);
  for (const problem of error.problems) {
    process.stderr.write(`  ${problem.where}: ${problem.message}\n`);
  }
  process.stderr.write('\nFix the file and run the command again.\n');
  process.exit(1);
}

/**
 * Everything a build or a run needs, resolved once.
 *
 * `loadConfig` and the resolvers are synchronous except `runtime`, so this is
 * the only async step before a command starts working.
 */
async function context(dir) {
  const { projectDir, pkg } = findProject(dir);
  let config;
  let configPath = null;
  let present = false;
  try {
    const loaded = loadConfig(projectDir, { projectName: pkg.name });
    config = loaded.config;
    configPath = loaded.path;
    present = loaded.present;
  } catch (error) {
    configFailure(error);
  }
  const paths = projectPaths(projectDir, config);
  const fw = framework(projectDir);
  const rt = await runtime(projectDir, config);
  return {
    projectDir,
    pkg,
    config,
    configPath,
    configPresent: present,
    paths,
    fw,
    rt,
    compiler: compiler(projectDir),
    sessionAsconfig: sessionAsconfig(fw.dir, fw.session, config),
  };
}

export async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`tension ${VERSION}\n`);
    return 0;
  }

  try {
    switch (command) {
      case 'init': {
        const options = parse(rest, {
          '--template': 'template',
          '--name': 'name',
          '--force': flag('force'),
          '--install': flag('install'),
          '-h': flag('help'),
          '--help': flag('help'),
        }, { allowPositionals: true });
        if (options.help) { process.stdout.write(`${HELP_INIT}\n`); return 0; }
        init({
          dir: options._[0] ?? '.',
          template: options.template,
          name: options.name,
          force: options.force,
          install: options.install,
        });
        return 0;
      }

      case 'dev': {
        const options = parse(rest, {
          '--headless': flag('headless'),
          '--no-watch': flag('noWatch'),
          '--build-only': flag('buildOnly'),
          '--debug': flag('debug'),
          '--dir': 'dir',
          '-h': flag('help'),
          '--help': flag('help'),
        });
        if (options.help) { process.stdout.write(`${HELP_DEV}\n`); return 0; }
        const ctx = await context(options.dir);
        return await dev(ctx, {
          headless: options.headless,
          watch: !options.noWatch,
          buildOnly: options.buildOnly,
          debug: options.debug,
          extra: options.extra,
        });
      }

      case 'build': {
        const options = parse(rest, {
          '--debug': flag('debug'),
          '--out': 'out',
          '--dir': 'dir',
          '-h': flag('help'),
          '--help': flag('help'),
        });
        if (options.help) { process.stdout.write(`${HELP_BUILD}\n`); return 0; }
        const ctx = await context(options.dir);
        bundle(ctx, { debug: options.debug, outDir: options.out });
        return 0;
      }

      case 'doctor': {
        const options = parse(rest, {
          '--headless': flag('headless'),
          '--dir': 'dir',
          '-h': flag('help'),
          '--help': flag('help'),
        });
        if (options.help) { process.stdout.write(`${HELP_DOCTOR}\n`); return 0; }
        const { projectDir, pkg } = findProject(options.dir);
        let config;
        let configPath = null;
        try {
          const loaded = loadConfig(projectDir, { projectName: pkg.name });
          config = loaded.config;
          configPath = loaded.path;
        } catch (error) {
          configFailure(error);
        }
        return await doctor({
          projectDir,
          pkg,
          config,
          configPath,
          paths: projectPaths(projectDir, config),
        }, { headless: options.headless });
      }

      default:
        step(`tension: unknown command: '${command}'`);
        process.stderr.write(`${HELP}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) configFailure(error);
    // A stack trace is the right output for a bug in the CLI and the wrong
    // output for a missing file, so the message is shown alone unless the
    // environment asks for the rest.
    if (process.env.TENSION_DEBUG) throw error;
    step(`tension: ${error.message}`);
    if (process.env.TENSION_DEBUG !== undefined) step(error.stack);
    return 1;
  }
}
