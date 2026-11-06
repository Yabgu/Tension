#!/usr/bin/env node
// Run the test suites, in parallel where that is safe.
//
//   1. codegen            the generated wire records are current
//   2. tension-framework  the guest fixtures against the host
//   3. tension-ogre guest the capability's suite
//   4. tension-input      the input DSO's suite
//   5. tension-core       cargo test
//   6. tension-ogre unit  the adapter's C++ unit tests
//   7. tension-res        zig build test
//   8. line endings       no CRLF in a text file
//   9. dependency pins    one naga version, not two
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
//     has to run after both. That is a data dependency, not a preference.
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
//   npm test -- --core          one suite
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

  codegen: {
    title: 'codegen',
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

  framework: {
    title: 'tension-framework',
    needs: [],
    holds: [],
    run: () => execute(node, [join(repo, 'scripts', 'test-framework.mjs')],
                       { env: suiteEnv({ TENSION_SESSION_READY: '1' }) }),
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

  res: {
    title: 'tension-res',
    needs: [],
    // `tension-core`'s build script runs `zig build` in the same directory.
    holds: ['zig'],
    run: () => execute('zig', ['build', 'test'],
                       { cwd: join(repo, 'tension-res'), env: suiteEnv() }),
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
  .filter((arg) => !['--serial', '--all', '--list', '--jobs'].includes(arg))
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
  order = requested;
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
  ['framework', 'ogre-guest', 'input', 'core'].includes(name));

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

function readyToRun(name) {
  const suite = SUITES[name];
  if (state.get(name) !== 'waiting') return false;
  if (suite.needs.some((need) => state.get(need) !== 'passed')) return false;
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
      if (blocker) skip(name, `depends on ${SUITES[blocker].title}, which failed`);
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
