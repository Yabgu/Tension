#!/usr/bin/env node
// Run the test suites, in parallel where that is safe.
//
//   1. codegen            the generated wire records are current
//   1b. abi docs          the generated ABI references are current, and the
//                         documented offsets match the C compiler's `offsetof`
//   2. tension-framework  the guest fixtures against the host
//   3. tension-ogre guest the capability's suite
//   4. tension-input      the input DSO's suite
//   5. tension-core       cargo test
//   6. tension-ogre unit  the adapter's C++ unit tests
//   7. tension-res        zig build test
//   8. line endings       no CRLF in a text file
//   9. dependency pins    one naga version, not two
//  10. isometric (CI)    the three 2D problems, from synthetic pages
//  11. isometric frame   the framework library reproduces the scene byte for byte
//  12. starter           a scaffolded project builds and runs: template drift
//  13. box-physics       the rigid-body example's own pixel and solver asserts
//  14. stiff-boxes       the BDF2 example's own asserts, from packed textures
//
// ## What "parallel" may and may not do here
//
// The suites are not independent, and running them simultaneously without saying
// so would produce failures that depend on timing. Two constraints are real:
//
//   * Three suites each run `gen-session.mjs`, which rewrites
//     `assembly/runtime/{layout,manifest}.ts` and `build/session.asconfig.json`.
//     They write identical content, but a concurrent write is still a truncated
//     file. So the generation happens once, up front, and the suites are told to
//     skip it (`TENSION_SESSION_READY=1`).
//   * `tension-core` loads the fixtures the framework and OGRE suites build, so it
//     has to run after both. That is a data dependency, not a preference — and
//     selecting `core` alone **pulls those suites in**, because the alternative is
//     cargo testing a fixture compiled before the last framework change (the
//     `async_await` trap on a retired `ogre::mount_tns` import, which named the
//     fixture rather than the missing build).
//
// Two suites also share a *resource* without sharing data: the OGRE guest suite
// and the OGRE unit suite both own `tension-ogre/build` and `build-cmake`, and
// `tension-res` and `tension-core` both drive `zig` in `tension-res/`. Those are
// declared as exclusive tags, and the scheduler never runs two holders at once.
//
// With that declared, everything else overlaps: the line-ending check, codegen,
// the framework, the input suite and one OGRE suite start together.
//
// Usage:
//   npm test                    every suite, parallel
//   npm test -- --serial        every suite, one at a time
//   npm test -- --core          one suite, and what it needs
//   npm test -- --core --no-deps  one suite, no dependencies (they may be stale)
//   npm test -- --jobs 2        at most two at once
//   npm test -- --list          print the suite names

import { availableParallelism } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { REPO, WIN, baseEnv, which } from './lib/toolchain.mjs';
import { inherit } from './lib/proc.mjs';

const repo = REPO;
const node = process.execPath;

// ── the environment every suite inherits ────────────────────────────────────
//
// The in-tree Ogre-Next lives outside the loader's default path, and both the
// adapter and the `ogre_*` integration tests need it: the tests spawn the
// interpreter directly rather than through a recipe that sets the environment.
// These are *not* written into `process.env`: each suite gets its own copy, so a
// suite cannot observe another's changes and two suites cannot race on the
// parent's environment.
const ogreLibs = [
  join(repo, 'third_party', 'ogre-next-install', 'lib'),
].filter(existsSync);

function suiteEnv(extra = {}) {
  // `baseEnv()`, not `process.env`: it is the environment that carries MSVC
  // (so cargo can link), MSYS2's UCRT64 compilers, and the directory of a Zig
  // installed without a PATH shim. The suites that compile guests and run `zig`
  // need all three, and a suite given the bare parent environment fails with
  // messages that name none of it.
  const env = { ...baseEnv(), ...extra };
  // The 2D examples show a window when a display is present, because `npm start`
  // should show something. A suite must not: it asserts pixels, and a window
  // would make the result depend on a compositor (and pop up during CI).
  env.TENSION_2D_HEADLESS = '1';
  if (!ogreLibs.length) return env;

  if (WIN) {
    env.PATH = `${ogreLibs.join(delimiter)}${delimiter}${env.PATH ?? ''}`;
  } else {
    const existing = env.LD_LIBRARY_PATH;
    env.LD_LIBRARY_PATH = existing
      ? `${ogreLibs.join(delimiter)}${delimiter}${existing}`
      : ogreLibs.join(delimiter);
  }
  return env;
}

/// Run a program to completion, capturing both streams.
///
/// `spawnSync` is deliberately not used: it blocks the event loop, which would
/// serialise the whole schedule regardless of how many children were started.
///
/// The command is resolved through `which()` first, because a tool can be
/// installed and usable without being on the parent's PATH — WinGet's Zig is the
/// measured case.
function execute(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const env = options.env ?? suiteEnv();
    let executable = command;
    if (!command.includes('/') && !command.includes('\\')) {
      executable = which(command) ?? command;
    }
    const child = spawn(executable, args, { ...options, env });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ status: 1, output: `${output}${error.message}\n` }));
    child.on('close', (status) => resolve({ status: status ?? 1, output }));
  });
}

// ── the suites ──────────────────────────────────────────────────────────────
//
// `needs`  suites that must have passed before this one starts. A failed
//          dependency skips the dependent suite rather than reporting a second
//          failure with the same cause.
// `holds`  exclusive resource tags. Two suites with a tag in common never run
//          at the same time.
// `run`    returns a promise for `{ status, output }`.

const SUITES = {
  eol: {
    title: 'line endings',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'normalize-eol.mjs'), '--check', repo]),
  },

  // A dependency-hygiene check rather than a test: cargo links two naga copies
  // silently when `tension-core` and `tension-shadergen` disagree, and the
  // symptom is a confusing "ambiguous" from `cargo tree`, not a compile error.
  // Cheap enough to be a suite, and it belongs where every other gate runs.
  deps: {
    title: 'dependency pins',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'check-naga-pin.mjs')]),
  },

  // The checked-in Win32 overlay for Ogre's generated Vulkan settings header is
  // a copy of a generated file, which is exactly the kind of thing that goes
  // stale in silence: a symbol upstream adds stays undefined here, which still
  // compiles and links, and quietly drops a backend. Cheap to check, so it runs
  // with every other gate rather than only on the machine that cross-compiles.
  'win32-headers': {
    title: 'win32 headers',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'check-win32-headers.mjs')]),
  },

  // The ogre table capacities exist twice — once in the adapter's C++ and once
  // in the guest SDK's TensionScript — and they agree today by inspection. The
  // check parses both files and compares every pair, so a number that moves on
  // one side fails here instead of misreading the other side's table at run
  // time.
  'ogre-capacities': {
    title: 'ogre capacities',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'check-ogre-capacities.mjs')]),
  },

  codegen: {    title: 'codegen',
    needs: [],
    holds: [],
    run: () => execute(node, [
      join(repo, 'tools', 'codegen', 'generate.mjs'),
      '--schema', join(repo, 'schema', 'ogre.json'),
      '--out-ts', join(repo, 'tension-framework', 'assembly', 'ogre', 'generated'),
      '--out-h', join(repo, 'tension-ogre', 'src', 'generated'),
      '--check',
    ]),
  },

  // The ABI references are generated from the header and the registration
  // sites, so the only question is whether they are current — and whether the
  // offset column is right, which the generator alone cannot answer. The check
  // compiles a probe against the real header and compares `offsetof`, so a
  // wrong layout model fails here rather than in a reader's trust.
  'abi-docs': {
    title: 'abi docs',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'test-abi-docs.mjs')]),
  },

  framework: {
    title: 'tension-framework',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'test-framework.mjs')],
                       { env: suiteEnv({ TENSION_SESSION_READY: '1' }) }),
  },

  // The CLI's config contract: `schema/tension.config.json` is what an editor
  // reads and `packages/cli/src/config.js` is what the CLI enforces, and
  // nothing generates one from the other (the CLI has to run before
  // `npm install` has produced a validator). A key, default or enum that moves
  // on one side and not the other is a project that validates in an editor and
  // fails on the command line; the test compares the pair mechanically.
  cli: {
    title: 'tension CLI',
    needs: [],
    holds: [],
    run: () => execute(node, ['--test', join(repo, 'packages', 'cli', 'test')]),
  },

  // The documentation build: Markdown and the SDK's doc comments into a binary
  // bundle, a search index over it, the font atlas the viewer draws with, and a
  // recorded transcript for every `runnable` block. The suite fails when a
  // runnable example does not compile or run, which is what stops a docs page
  // from claiming a program prints something it does not.
  //
  // It installs `marked` on first run (see apps/docs/tools/check.mjs) rather
  // than requiring a manual step, the same way `build-framework` installs
  // `tensionscript`.
  docs: {
    title: 'docs assets',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'apps', 'docs', 'tools', 'check.mjs')]),
  },

  'ogre-guest': {
    title: 'tension-ogre (guest)',
    needs: [],
    // Shares `tension-ogre/build` and `build-cmake` with the unit suite.
    holds: ['tension-ogre-build'],
    run: () => execute(node, [join(repo, 'scripts', 'test-ogre.mjs')],
                       { env: suiteEnv({ TENSION_SESSION_READY: '1' }) }),
  },

  'ogre-unit': {
    title: 'tension-ogre (unit)',
    needs: [],
    holds: ['tension-ogre-build'],
    run: () => execute(node, [join(repo, 'scripts', 'build-ogre.mjs'), '--test'],
                       { env: suiteEnv() }),
  },

  input: {
    title: 'tension-input',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'test-input.mjs')],
                       { env: suiteEnv({ TENSION_SESSION_READY: '1' }) }),
  },

  // The X button, in two halves: every guest loop that presents frames reads
  // `closeRequested` (static, always runs), and one of them is really launched
  // and really clicked shut (needs a display, a window manager and `xdotool`;
  // skipped with a printed reason otherwise).
  //
  // Its own suite rather than a case inside another one because it is the only
  // gate in this tree that opens a *managed* window on purpose: `suiteEnv` tells
  // the 2D suites to stay offscreen, and this one must not inherit that.
  'window-close': {
    title: 'window close',
    needs: [],
    // hello-sprites' guest and shader modules are this suite's inputs too.
    holds: ['tension-2d-build'],
    run: () => execute(node, [join(repo, 'scripts', 'test-window-close.mjs')],
                       { env: suiteEnv() }),
  },

  res: {
    title: 'tension-res',
    needs: [],
    // `tension-core`'s build script runs `zig build` in the same directory.
    holds: ['zig'],
    run: () => execute('zig', ['build', 'test'],
                       { cwd: join(repo, 'tension-res'), env: suiteEnv() }),
  },

  // Ten sprites, one atlas, one frame — the smallest end-to-end 2D guest, and
  // the only suite that asserts an absolute pixel count (10240 = 10 x 32x32)
  // rather than a colour at a probe. The count is the check that catches a
  // renderer which draws every rect at the same place: ten probes can agree
  // while the tenth sprite sits on top of the first.
  'hello-sprites': {
    title: 'hello-sprites',
    needs: [],
    // Writes the shader modules and the guest, in directories the other 2D
    // suites also use.
    holds: ['tension-2d-build'],
    run: () => execute(node, [
      join(repo, 'examples', '2d', 'hello-sprites', 'test.mjs'),
    ], { env: suiteEnv() }),
  },

  // The same scene from generated flat-colour pages: same canvas, same
  // positions, same sort keys, same probes. Its assertions are cheap and its
  // expectations are palette constants, so it catches a renderer bug without
  // needing the art. `isometric-art` is the same scene drawn from the real
  // tileset and catches art-pipeline bugs this one cannot.
  isometric: {
    title: 'isometric (synthetic)',
    needs: [],
    // Builds the adapter and the guest; both live in directories another 2D
    // suite would also write.
    holds: ['tension-2d-build'],
    run: () => execute(node, [
      join(repo, 'examples', '2d', 'isometric', 'test-synthetic.mjs'),
    ], { env: suiteEnv() }),
  },

  // The worked example on the committed tileset. It used to be excluded from
  // this list because the art was third-party and the example exited 77 on any
  // machine without it; the tileset is drawn and committed now, so it runs
  // everywhere the adapter does.
  'isometric-art': {
    title: 'isometric (art)',
    needs: [],
    holds: ['tension-2d-build'],
    run: () => execute(node, [
      join(repo, 'examples', '2d', 'isometric', 'test.mjs'),
    ], { env: suiteEnv() }),
  },

  // The framework layer: `Tileset` + `Composite` + `IsometricWorld` rebuild the
  // same scene and their frames must equal the hand-written guest's, byte for
  // byte. That assertion is the whole test — it fails if the framework's
  // emission differs anywhere, including in fields no probe reads.
  'isometric-framework': {
    title: 'isometric (framework)',
    // No `needs`: this suite builds and runs the hand-written guest itself as
    // its comparison, so depending on the `isometric` suite would run it twice
    // and would make the framework suite un-runnable on its own.
    needs: [],
    holds: ['tension-2d-build'],
    run: () => execute(node, [
      join(repo, 'examples', '2d', 'isometric-framework', 'test.mjs'),
    ], { env: suiteEnv() }),
  },

  // The physics examples' own assertions, which existed as `test.mjs` and ran
  // only by hand until now: a solver regression had no gate. Both build the
  // guest and the adapter, so they take the same exclusive hold as the other 2D
  // suites rather than racing them for `build/`.
  //
  // Their assertions are the interesting part and stay in the examples: the
  // contact count and the rotation count for box-physics, the BDF2 frame count
  // and the packed-volume texture for stiff-boxes. This table only makes them
  // run.
  'box-physics': {
    title: 'box-physics',
    needs: [],
    holds: ['tension-2d-build'],
    run: () => execute(node, [
      join(repo, 'examples', '2d', 'box-physics', 'test.mjs'),
    ], { env: suiteEnv() }),
  },

  'stiff-boxes': {
    title: 'stiff-boxes',
    needs: [],
    holds: ['tension-2d-build'],
    run: () => execute(node, [
      join(repo, 'examples', '2d', 'stiff-boxes', 'test.mjs'),
    ], { env: suiteEnv() }),
  },

  // The template every `tension init` writes, built the way a user builds it:
  // scaffold with the CLI, `npm install`, `npm run build`, then run the
  // *packaged* binary out of `dist/` headless. It covers all three directions the
  // template can drift in at once — the framework's API, the CLI's scaffolding,
  // and the build pipeline — which is why one suite is worth more here than the
  // three narrower ones it looks like.
  //
  // It holds nothing, because it works entirely in a temp directory: the scaffold
  // gets `file:` links into this tree and writes only inside itself, so it shares
  // no build directory with any other suite. `scripts/test-starter.mjs` removes
  // the project on the way out.
  'starter': {
    title: 'starter template',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'test-starter.mjs')],
                       { env: suiteEnv() }),
  },

  // The host's window and surface, in its own suite so a failure is
  // attributable. `cargo test` runs it too (it is a test target), but buries a
  // window-open failure in cargo's output amid 300 other lines.
  //
  // It needs a display *driver that supports Vulkan*: wayland or x11 on a
  // developer machine, x11 under CI's Xvfb. `offscreen` also passes and is
  // reported as headless rather than as WSI; `dummy` cannot and fails, which is
  // what the probe's own negative-control mode asserts.
  'platform-surface': {
    title: 'platform surface',
    needs: [],
    holds: [],
    run: () => execute('cargo', [
      'test', '--manifest-path', 'tension-core/Cargo.toml',
      ...(process.env.TENSION_AI === '1'
        ? ['--features', 'ai']
        : ['--no-default-features', '--features', 'audio']),
      '--test', 'platform_surface',
    ], { env: suiteEnv() }),
  },

  // The pump: does the host notice a resize? `platform-surface` proves the
  // surface can be created; this proves the window is serviced.
  'platform-window': {
    title: 'platform window',
    needs: [],
    holds: [],
    run: () => execute('cargo', [
      'test', '--manifest-path', 'tension-core/Cargo.toml',
      ...(process.env.TENSION_AI === '1'
        ? ['--features', 'ai']
        : ['--no-default-features', '--features', 'audio']),
      '--test', 'platform_window',
    ], { env: suiteEnv() }),
  },

  // The guest's window API: create, -EBUSY on a second, info() on nothing,
  // close, and a Vulkan window's surface. Its own step for the same reason as
  // the others — and because `cargo test` stops at the first failing target, so
  // a probe that only ran there would be invisible whenever an earlier target
  // is red.
  'platform-create': {
    title: 'platform create',
    needs: [],
    holds: [],
    run: () => execute('cargo', [
      'test', '--manifest-path', 'tension-core/Cargo.toml',
      ...(process.env.TENSION_AI === '1'
        ? ['--features', 'ai']
        : ['--no-default-features', '--features', 'audio']),
      '--test', 'platform_create',
    ], { env: suiteEnv() }),
  },

  // The control bus: a message from any source reaches the window.
  'platform-control': {
    title: 'platform control',
    needs: [],
    holds: [],
    run: () => execute('cargo', [
      'test', '--manifest-path', 'tension-core/Cargo.toml',
      ...(process.env.TENSION_AI === '1'
        ? ['--features', 'ai']
        : ['--no-default-features', '--features', 'audio']),
      '--test', 'platform_control',
    ], { env: suiteEnv() }),
  },

  core: {
    title: 'tension-core',
    // The `ogre_*` integration tests read the fixtures the two suites above
    // build, so this one runs after them or not at all.
    needs: ['framework', 'ogre-guest'],
    holds: ['zig'],
    // `ai` is a default feature and pulls a vendored llama.cpp build that needs
    // libclang — a heavy dependency AGENTS.md explicitly excludes from the test
    // suite. The tests therefore run with the feature set the shipped host is
    // built with, which is also what makes this portable: on a Windows box
    // without libclang the default-feature build fails before a single test runs.
    //
    // Set TENSION_AI=1 to include the ai-gated tests on a machine that has it.
    run: () => execute('cargo', [
      'test', '--manifest-path', 'tension-core/Cargo.toml',
      ...(process.env.TENSION_AI === '1'
        ? ['--features', 'ai']
        : ['--no-default-features', '--features', 'audio']),
    ], { env: suiteEnv() }),
  },
};

// ── command line ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const name of Object.keys(SUITES)) console.log(name);
  process.exit(0);
}

// ── how wide to run ────────────────────────────────────────────────────────
//
// Local machines parallelise; CI runs serially by default. The reason is not
// speed on CI — it is diagnosis. A failing CI job is read by someone who was not
// there, often from a log tail, and interleaved output from four suites plus a
// 4-way compile often hides which one broke. Locally the same person knows what
// they just changed and reads the whole log.
//
// CI also tends to have fewer cores than a dev box, so the parallelism buys less
// there anyway.
//
// `--serial` and `--jobs N` override either default, so the choice is never taken
// away: `npm test -- --jobs 4` on CI is one flag.
const SERIAL_FLAG = argv.includes('--serial');
const jobsFlag = argv.indexOf('--jobs');
const requestedJobs = jobsFlag >= 0 ? Number(argv[jobsFlag + 1]) : 0;

/// Whether this looks like a CI run.
///
/// The conventional variables, not one vendor's: `CI` is set by GitHub Actions,
/// GitLab, CircleCI, Travis, Buildkite and most others; the vendor-specific ones
/// are here because a few set only their own.
const CI = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS',
            'BUILDKITE', 'TF_BUILD', 'JENKINS_URL']
  .some((name) => {
    const value = process.env[name];
    return value !== undefined && value !== '' && value !== 'false' && value !== '0';
  });

const JOBS = SERIAL_FLAG ? 1
  : requestedJobs > 0 ? requestedJobs
  : CI ? 1
  : Math.max(1, Math.min(4, availableParallelism()));

/// `--core` or `core` selects one suite. The filter strips the `--` prefix from
/// every argument that is not an option, so `--codegen` selects codegen. A
/// selector that silently means "everything" is worse than one that errors, so
/// unknown names are refused.
const optionValues = new Set();
if (jobsFlag >= 0) optionValues.add(String(requestedJobs));
const requested = argv
  .filter((arg) => !['--serial', '--all', '--list', '--jobs', '--no-deps'].includes(arg))
  .filter((arg) => !optionValues.has(arg))
  .map((arg) => arg.replace(/^--/, ''))
  .filter(Boolean);

let order = Object.keys(SUITES);
if (requested.length) {
  const unknown = requested.filter((name) => !(name in SUITES));
  if (unknown.length) {
    console.error(`test: unknown suite(s): ${unknown.join(', ')}`);
    console.error(`      known: ${Object.keys(SUITES).join(', ')}`);
    process.exit(1);
  }
  // **Selecting a suite selects what it needs.** `core` reads the fixtures the
  // `framework` and `ogre-guest` suites build, so `node scripts/test.mjs core` on
  // a tree whose OGRE guest was compiled before the framework changed used to run
  // cargo against a *stale* fixture — and the failure (`async_await` trapping on a
  // retired import) named the fixture, not the missing build. The dependency was
  // declared in `needs` and then ignored for anything not in the selection.
  //
  // So the closure is taken: each requested suite pulls its `needs` in, and theirs
  // in turn, in dependency order (a need is listed before the suite that needs it,
  // which is also the order the scheduler would have picked anyway).
  const noDeps = argv.includes('--no-deps');
  const expanded = [];
  const visit = (name, chain) => {
    if (expanded.includes(name) || chain.includes(name)) return;   // a cycle is a bug, not a hang
    for (const need of SUITES[name].needs) visit(need, [...chain, name]);
    expanded.push(name);
  };
  if (noDeps) expanded.push(...requested);
  else for (const name of requested) visit(name, []);
  if (!noDeps && expanded.length > requested.length) {
    const pulled = expanded.filter((name) => !requested.includes(name));
    console.log(`test: ${requested.join(', ')} needs ${pulled.join(', ')} — running those first`);
  }
  order = expanded;
}

// ── shared preparation ──────────────────────────────────────────────────────
//
// Two things every guest suite wants, done once so they cannot race on them:
//
//   1. the debug host, because the fixtures are its guests and `layout-hash` is
//      what the generator validates against;
//   2. the generated session constants, because three suites would otherwise
//      rewrite the same files concurrently.
//
// The build goes through this process's toolchain environment, which is what puts
// `zig` on cargo's PATH (cargo's build script runs it by name).

const needsPreparation = order.some((name) =>
  ['framework', 'ogre-guest', 'input', 'core', 'isometric', 'isometric-framework'].includes(name));

function banner(text) {
  console.log('\n======================================================================');
  console.log(`==> ${text}`);
  console.log('======================================================================');
}

if (needsPreparation) {
  banner('Preparing (debug host + generated session constants)');
  const built = inherit('cargo', ['build', '--manifest-path', 'tension-core/Cargo.toml',
                                  '--no-default-features'], { env: suiteEnv() });
  if (built.status !== 0) {
    console.error('test: could not build the debug host; the guest suites cannot run');
    process.exit(1);
  }

  const debugHost = join(repo, 'tension-core', 'target', 'debug',
                         `tension-core${WIN ? '.exe' : ''}`);
  const hash = await new Promise((resolve) => {
    execute(debugHost, ['layout-hash']).then((r) => resolve(r.output.trim()));
  });
  if (!hash) {
    console.error('test: the debug host printed no layout hash');
    process.exit(1);
  }
  const generated = await execute(node, [join(repo, 'scripts', 'gen-session.mjs'), '--hash', hash]);
  if (generated.status !== 0) {
    process.stdout.write(generated.output);
    console.error('test: the session generator refused the layout hash');
    process.exit(1);
  }
}

// ── the schedule ────────────────────────────────────────────────────────────

const state = new Map(order.map((name) => [name, 'waiting']));
const results = new Map();
const held = new Set();
const running = new Map();
const startedAt = new Map();

/// Whether a `needs` entry is satisfied.
///
/// Every need is in `order`: the selection above takes the dependency closure, so
/// a suite is only ever scheduled with its dependencies in the run. A need that is
/// somehow absent still counts as met rather than blocking for ever — a tool that
/// hangs is worse than one that runs a suite whose fixture it cannot see, and the
/// suite itself fails loudly in that case.
function needSatisfied(need) {
  if (!state.has(need)) return true;
  return state.get(need) === 'passed';
}

function readyToRun(name) {
  const suite = SUITES[name];
  if (state.get(name) !== 'waiting') return false;
  if (suite.needs.some((need) => !needSatisfied(need))) return false;
  if (suite.holds.some((tag) => held.has(tag))) return false;
  return true;
}

function finish(name, status, output, elapsed) {
  const suite = SUITES[name];
  for (const tag of suite.holds) held.delete(tag);
  running.delete(name);

  console.log(`\n----- ${suite.title} (${(elapsed / 1000).toFixed(1)}s) -----`);
  process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);

  if (status === 0) {
    state.set(name, 'passed');
    results.set(name, { ok: true });
    console.log(`==> ${suite.title}: PASSED`);
  } else {
    state.set(name, 'failed');
    results.set(name, { ok: false });
    console.log(`==> ${suite.title}: FAILED`);
  }
}

function skip(name, reason) {
  state.set(name, 'skipped');
  results.set(name, { ok: false, reason });
  console.log(`\n==> ${SUITES[name].title}: SKIPPED — ${reason}`);
}

console.log(`test: ${order.length} suite(s), ${JOBS} at a time`
  + (JOBS === 1 && CI && !SERIAL_FLAG && requestedJobs <= 0 ? ' (CI: serial by default; --jobs N to override)' : '')
  + (SERIAL_FLAG ? ' (--serial)' : ''));

let runningCount = 0;

await new Promise((resolve) => {
  const pump = () => {
    // Skip anything whose dependencies failed: a second failure with the same
    // cause is noise, and it hides which suite actually broke.
    for (const name of order) {
      if (state.get(name) !== 'waiting') continue;
      const blocker = SUITES[name].needs.find((need) => state.get(need) === 'failed');
      if (blocker) {
        skip(name, `depends on ${SUITES[blocker].title}, which failed — ` +
                   `run \`node scripts/test.mjs ${blocker}\` and fix it first`);
      }
    }

    while (running.size < JOBS) {
      const next = order.find(readyToRun);
      if (!next) break;

      const suite = SUITES[next];
      for (const tag of suite.holds) held.add(tag);
      state.set(next, 'running');
      startedAt.set(next, Date.now());
      runningCount++;
      console.log(`==> starting ${suite.title}`);

      suite.run().then(({ status, output }) => {
        finish(next, status, output, Date.now() - startedAt.get(next));
        pump();
      });
      running.set(next, true);
    }

    const settled = order.every((name) => state.get(name) !== 'waiting' && !running.has(name));
    if (settled) resolve();
  };
  pump();
});
void runningCount;

// ── summary ─────────────────────────────────────────────────────────────────

const passed = order.filter((name) => state.get(name) === 'passed');
const failed = order.filter((name) => state.get(name) === 'failed');
const skipped = order.filter((name) => state.get(name) === 'skipped');

banner('Test Summary');
for (const name of passed) console.log(`  [PASS] ${SUITES[name].title}`);
for (const name of failed) console.log(`  [FAIL] ${SUITES[name].title}`);
for (const name of skipped) {
  console.log(`  [SKIP] ${SUITES[name].title} — ${results.get(name).reason}`);
}

if (failed.length) {
  console.error(`==> ${failed.length} test suite(s) failed.`);
  process.exit(1);
}
if (skipped.length) {
  console.error(`==> ${skipped.length} test suite(s) skipped.`);
  process.exit(1);
}
console.log(`==> All ${passed.length} test suite(s) passed successfully.`);
