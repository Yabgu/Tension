// Generate the session runtime's constants and compile the framework guest.
//
// Two steps that belong together because the second consumes the first: the
// guest is compiled against `assembly/runtime/layout.ts`, which the generator
// rewrites from session.json. Running them as one npm script is what keeps a
// stale constant table from reaching a guest.
//
// The dependency install is here for the same reason `build-examples.mjs`
// installs per example: `tensionscript` is a devDependency of this package, and
// a fresh clone has no node_modules. Doing it in the build rather than
// documenting it means `npm run build` is the whole first-run story.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const framework = join(repo, 'tension-framework');
const WIN = process.platform === 'win32';

function die(message) {
  console.error(`build-framework: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  // `shell` is opt-in and only ever used for `npm`, which is a `.cmd` shim on
  // Windows and cannot be spawned without one. An absolute path to node.exe
  // must not go through the shell: `C:\Program Files\...` would be split on
  // the space.
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) die(`${command}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(' ')} failed (exit ${result.status})`);
}

const npm = (args, options = {}) => run('npm', args, { shell: WIN, ...options });

// 1. The generated constants and the asc flags.
run(process.execPath, [join(repo, 'scripts', 'gen-session.mjs'), ...process.argv.slice(2)]);

// 2. The guest's build dependencies.
const compiler = join(framework, 'node_modules', '.bin',
                      WIN ? 'tensionscript.cmd' : 'tensionscript');
if (!existsSync(compiler)) {
  console.log('build-framework: installing tension-framework dependencies');
  npm(['install', '--no-audit', '--no-fund'], { cwd: framework });
}

// 3. The framework guest itself.
npm(['run', 'build'], { cwd: framework });
