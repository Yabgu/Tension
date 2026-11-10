// Where the CLI finds things: the project, the host, the adapters, the
// compiler, and the environment an Ogre run needs.
//
// **Resolution happens from the project directory, not from the CLI.** A
// `tension` installed globally must drive the runtime the *project* pinned,
// exactly as a guest must be compiled by the compiler that project pinned. So
// every lookup goes through `createRequire(join(projectDir, 'package.json'))`,
// and the CLI's own location is used for one thing only: finding the repository
// it lives in, as a fallback for a checkout that has not been installed yet.
//
// That fallback is what makes this pass work with no publishing: the template's
// `package.json` names its dependencies as `file:` paths into this tree, but a
// hand-run `tension dev` in the repository itself still resolves, because the
// repo layout is tried when npm's does not answer.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUFFIX, capture, die, exists, findBin, step } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The repository this CLI lives in, or `null` when it was installed from a
 * registry into someone else's `node_modules`.
 *
 * Identified by the two manifests that only coexist at the root of this tree:
 * a published `@yabgu_gm/tension` sits in `node_modules/@yabgu_gm/tension`,
 * whose ancestors have neither.
 */
export function repoRoot() {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (exists(join(dir, 'packages', 'core', 'package.json')) &&
        exists(join(dir, 'tension-framework', 'package.json')) &&
        exists(join(dir, 'tension-core', 'Cargo.toml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The project the command runs in. `--dir` overrides the working directory. */
export function findProject(dir) {
  const projectDir = resolve(dir ?? process.cwd());
  if (!exists(join(projectDir, 'package.json'))) {
    die(`no project here: ${projectDir}`,
      ['a Tension project is a directory with a package.json (and usually a ' +
       'tension.config.json).', 'create one with: npx create-tension-app my-game']);
  }
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  return { projectDir, pkg };
}

/** A resolver rooted at the project, so a dependency is the project's. */
function projectRequire(projectDir) {
  return createRequire(join(projectDir, 'package.json'));
}

/**
 * Import one of the `@yabgu_gm/tension-*` resolver modules.
 *
 * Each of those packages exports the *paths* of the platform build it resolved,
 * so nothing here has to know a `.dll` from a `.so` or remember where npm puts
 * a payload. The installed copy wins; the repository's `packages/` directory is
 * the fallback for a checkout whose project has not been installed yet.
 */
async function loadResolver(projectDir, packageName, repoShort) {
  const repo = repoRoot();
  const candidates = [];

  try {
    candidates.push(projectRequire(projectDir).resolve(packageName));
  } catch {
    // Not installed in the project. The repository fallback below is the whole
    // point of local-first, so this is not yet a failure.
  }
  if (repo) candidates.push(join(repo, 'packages', repoShort, 'index.js'));

  const file = candidates.find(exists);
  if (!file) {
    die(`cannot resolve ${packageName} from ${projectDir}`, [
      'it is not in this project\'s node_modules, and no copy of this repository was found',
      `install it:  npm install ${packageName}`,
    ]);
  }
  return { module: await import(pathToFileURL(file).href), path: file };
}

/** `package.json` of a package installed in the project, or a repo fallback. */
function packageJson(projectDir, name, repoRelative) {
  const installed = join(projectDir, 'node_modules', ...name.split('/'), 'package.json');
  const repo = repoRoot();
  const fallbacks = repo && repoRelative ? [join(repo, repoRelative, 'package.json')] : [];
  const file = [installed, ...fallbacks].find(exists);
  return file ? { path: file, json: JSON.parse(readFileSync(file, 'utf8')) } : null;
}

/**
 * The guest SDK.
 *
 * Resolved by directory rather than by Node's resolver: `tension-framework`
 * declares `ascMain`, a TensionScript field, and its `exports` map carries only
 * a `types` condition — there is no runtime entry point to resolve, because a
 * guest imports it at compile time. So the CLI checks for the directory.
 */
export function framework(projectDir) {
  const repo = repoRoot();
  const candidates = [
    join(projectDir, 'node_modules', 'tension-framework'),
    repo && join(repo, 'tension-framework'),
  ].filter(Boolean);
  const dir = candidates.find((candidate) => exists(join(candidate, 'package.json')));
  if (!dir) {
    die('cannot find tension-framework', [
      'the guest imports it, so the project must depend on it:',
      '  npm install tension-framework',
    ]);
  }
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  // `session.json` is the arena geometry both sides are compiled against. It is
  // the framework's, not the project's: a project that could change it would be
  // a project that can silently desynchronise from the host.
  const sessionPath = join(dir, 'session.json');
  if (!exists(sessionPath)) {
    die(`tension-framework at ${dir} has no session.json`, [
      'that file is the arena geometry the guest is compiled against',
      'reinstall the framework:  npm install tension-framework',
    ]);
  }
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  return { dir, package: json, session, sessionPath };
}

/**
 * The TensionScript compiler.
 *
 * Returns `{ command, prefix, version }` where the invocation is
 * `[command, ...prefix, ...args]` — the prefix exists because the fallback is
 * `node <path-to-compiler.js>` rather than a `.bin` shim, and a caller that
 * rebuilt that decision would be the third place the platform spelling of a bin
 * is written down.
 */
export function compiler(projectDir) {
  const repo = repoRoot();
  const candidates = [];

  const shim = findBin(projectDir, 'tensionscript');
  if (shim) candidates.push({ command: shim, prefix: [] });

  // The package's own `bin` field, run through this Node. This is what a
  // project installed by pnpm (which does not use `.bin` symlinks the same way)
  // resolves through, and it needs no shim at all.
  for (const base of [projectDir, repo && join(repo, 'tension-framework')].filter(Boolean)) {
    const pkg = packageJson(base, '@yabgu_gm/tensionscript');
    if (!pkg) continue;
    const binField = pkg.json.bin;
    const rel = typeof binField === 'string' ? binField : binField?.tensionscript;
    if (!rel) continue;
    const js = join(dirname(pkg.path), rel);
    if (exists(js)) candidates.push({ command: process.execPath, prefix: [js] });
  }

  const chosen = candidates[0];
  if (!chosen) {
    die('cannot find the TensionScript compiler', [
      'the guest is written in TensionScript and compiled by its compiler:',
      '  npm install --save-dev @yabgu_gm/tensionscript',
    ]);
  }
  const probe = capture(chosen.command, [...chosen.prefix, '--version']);
  const version = probe.status === 0 ? probe.stdout.trim() : 'unknown';
  if (probe.status !== 0) {
    die(`the TensionScript compiler at ${chosen.command} does not run`,
      probe.stderr.trim() || `exit ${probe.status}`);
  }
  return { ...chosen, version };
}

/**
 * Everything the host needs to run this project: the binary, the adapter, the
 * environment, and the two path sets that differ between the two renderers.
 *
 * Returned as data rather than applied as side effects so `tension build` can
 * record it in the manifest and `tension doctor` can print it.
 */
export async function runtime(projectDir, config, { quiet = false } = {}) {
  const core = await loadResolver(projectDir, '@yabgu_gm/tension-core', 'core');
  const coreModule = core.module;

  if (!coreModule.available) {
    die(`no tension-core build for ${SUFFIX}`, [
      `looked for: ${coreModule.hostPath}`,
      'the interpreter ships as a per-platform package:',
      `  npm install @yabgu_gm/tension-core-${SUFFIX}`,
      'in this repository, build it first:  npm run build:native',
    ]);
  }

  const out = {
    host: coreModule.hostPath,
    // Directories of shared libraries the loader must see. Unix uses
    // LD_LIBRARY_PATH; Windows resolves a DLL's siblings from the process PATH.
    libraryDirs: [],
    env: {},
    adapters: [],
    ogre: null,
  };

  for (const capability of config.capabilities) {
    out.adapters.push(await resolveCapability(projectDir, capability));
  }

  if (config.renderer !== 'ogre') return out;

  // ── Ogre: an adapter DSO plus 40 MB of libraries it links ────────────────
  const ogre = await loadResolver(projectDir, '@yabgu_gm/tension-ogre', 'ogre');
  if (!ogre.module.available) {
    die(`no OGRE adapter for ${SUFFIX}`, [
      `looked for: ${ogre.module.dsoPath}`,
      'the adapter was not built for this platform:',
      `  npm install @yabgu_gm/tension-ogre-${SUFFIX}`,
      'in this repository, build it first:  npm run build',
    ]);
  }
  const ogreNext = await loadResolver(projectDir, '@yabgu_gm/tension-ogre-next', 'ogre-next');
  if (!ogreNext.module.available) {
    die(`no Ogre-Next runtime for ${SUFFIX}`, [
      `looked for: ${ogreNext.module.payloadDir}`,
      `  npm install @yabgu_gm/tension-ogre-next-${SUFFIX}`,
    ]);
  }

  out.adapters.unshift(ogre.module.dsoPath);
  out.ogre = {
    adapter: ogre.module.dsoPath,
    payloadDir: ogre.module.payloadDir,
    libDir: join(ogre.module.payloadDir, 'lib'),
    ogreNext: {
      payloadDir: ogreNext.module.payloadDir,
      libDir: ogreNext.module.libDir,
      pluginDir: ogreNext.module.pluginDir,
      mediaDir: ogreNext.module.mediaDir,
    },
  };

  // The adapter finds its direct dependencies through its own RPATH, and the
  // packaged Ogre libraries carry a RUNPATH that glibc prefers over an
  // inherited RPATH — so the directories are named here as well. On Windows
  // there is no RPATH at all and the loader uses PATH.
  out.libraryDirs = [out.ogre.libDir, ogreNext.module.libDir, ogreNext.module.pluginDir]
    .filter(exists);

  out.env.TENSION_OGRE_PLUGIN_DIR = ogreNext.module.pluginDir;
  out.env.TENSION_OGRE_MEDIA_DIR = ogreNext.module.mediaDir;

  if (!quiet) {
    const missing = [ogreNext.module.pluginDir, ogreNext.module.mediaDir].filter((d) => !exists(d));
    if (missing.length) {
      step(`tension: warning: missing Ogre directories: ${missing.join(', ')}`);
    }
  }
  return out;
}

/**
 * One capability adapter.
 *
 * `input` is the only name the config accepts. The payload package is tried
 * first; the repository's own build directory is the fallback, because that is
 * where `npm run build` puts the DSO and no payload package exists for it yet.
 */
async function resolveCapability(projectDir, name) {
  const short = `input`;
  const repo = repoRoot();
  const dsoName = process.platform === 'win32'
    ? `libtension_${short}.dll`
    : `libtension_${short}.so`;
  try {
    const resolved = await loadResolver(projectDir, `@yabgu_gm/tension-${short}`, short);
    if (resolved.module.available && resolved.module.dsoPath) return resolved.module.dsoPath;
  } catch {
    // Fall through to the repository layout below; the error there is the one
    // worth showing, because it names a path the user can act on.
  }
  const candidates = [
    repo && join(repo, `tension-${short}`, 'build', dsoName),
    repo && join(repo, 'packages', `${short}-${SUFFIX}`, 'lib', dsoName),
  ].filter(Boolean);
  const found = candidates.find(exists);
  if (found) return found;
  die(`capability '${name}' is not built for ${SUFFIX}`, [
    ...candidates.map((candidate) => `looked for: ${candidate}`),
    `build it:  node scripts/build-${short}.mjs   (in the Tension repository)`,
  ]);
}

/**
 * The `asc` flags a session guest is compiled with, generated from the
 * framework's `session.json` rather than copied from a build artifact.
 *
 * `memoryBase` is `max_arena_size` and must stay so: it is where the guest's
 * heap starts, and the arena's region band sits below it. The one field a
 * project chooses is `initialMemory`, which does not move the arena geometry or
 * the layout hash — `examples/2d/hello-sprites` has done exactly this since the
 * raised value was needed for a full-frame readback.
 *
 * Throws away the alternative — reading `build/session.asconfig.json` — because
 * that file is generated and gitignored, so a checkout that has not run
 * `npm run build` would not have one, and "compile fails because a build
 * artifact is missing" is a confusing way to learn about a fresh clone.
 */
export function sessionAsconfig(frameworkDir, session, config) {
  const initial = config.memory.initialPages;
  const ceiling = session.max_arena_size;
  const floor = session.initial_pages;
  const max = session.maximum_pages;

  // Three relations, checked here so the compiler never sees a memory shape the
  // host will refuse at session open (where the message would be about a TLV).
  const problems = [];
  if (!Number.isInteger(ceiling) || ceiling % 16 !== 0) {
    problems.push(`session.json: max_arena_size ${ceiling} is not a positive 16-byte multiple`);
  }
  if (initial < floor) {
    problems.push(`memory.initialPages ${initial} is below the framework's ${floor} ` +
      `(tension-framework/session.json)`);
  }
  if (initial > max) {
    problems.push(`memory.initialPages ${initial} exceeds the framework's maximum of ${max}`);
  }
  if (initial * 65536 <= ceiling) {
    problems.push(`memory.initialPages ${initial} leaves no heap above memoryBase ${ceiling}`);
  }
  if (problems.length) {
    die('this project cannot be compiled as configured', [
      ...problems,
      `set memory.initialPages in tension.config.json (the framework uses ${floor}, ` +
      `the ceiling is ${max})`,
    ]);
  }

  return {
    options: {
      runtime: 'incremental',
      target: 'release',
      optimizeLevel: 2,
      importMemory: true,
      memoryBase: ceiling,
      initialMemory: initial,
      maximumMemory: max,
      exportTable: true,
      exportStart: '__start',
    },
  };
}

/**
 * The host's argument list for this project.
 *
 * Returns `{ before, after }`: `before` are the host's own options and must
 * precede the guest path, `after` are the guest's and must follow it. The
 * runtime's rule is exactly that — everything after `<game.wasm>` is handed to
 * the guest verbatim — so the split is a property of the CLI, not a preference.
 */
export function hostArgs(config, paths, rt, { headless = false, extra = [] } = {}) {
  const before = [];
  const after = [];

  // The Ogre adapter's loader reads the volume through `--tns=`; `--res` is
  // `tension::res`. They are separate tables over the same file, and the host
  // needs both when there are assets.
  const volume = paths.volume && exists(paths.volume) ? paths.volume : null;
  if (volume) before.push('--res', volume);

  for (const adapter of rt.adapters) before.push('--capability', adapter);

  // The window contract: the runtime has no window flag, so the size, the title
  // and "no window at all" travel as guest arguments and `windowRequest()` in
  // the framework reads them.
  after.push(`--window=${config.window.width}x${config.window.height}`);
  after.push(`--title=${config.window.title}`);
  if (headless) after.push('--headless');

  if (config.renderer === 'ogre') {
    if (volume) after.push(`--tns=${volume}`);
    after.push(`--renderer=${headless ? 'null' : 'gl3plus'}`);
  }

  after.push(...extra);
  return { before, after };
}

/**
 * Environment for a host process: the caller's, plus what the renderer needs.
 *
 * A copy rather than a mutation of `process.env` so a single CLI process can
 * spawn several hosts (a restart loop does) without one run's library path
 * leaking into the next.
 */
export function hostEnv(rt) {
  const env = { ...process.env, ...rt.env };
  if (rt.libraryDirs.length) {
    if (process.platform === 'win32') {
      env.PATH = `${rt.libraryDirs.join(delimiter)}${delimiter}${env.PATH ?? ''}`;
    } else {
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${rt.libraryDirs.join(delimiter)}${delimiter}${env.LD_LIBRARY_PATH}`
        : rt.libraryDirs.join(delimiter);
    }
  }
  return env;
}

/** The CLI's own version, for the build manifest. */
export function cliVersion() {
  return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
}
