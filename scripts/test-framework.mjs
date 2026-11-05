#!/usr/bin/env node
// Build the framework's fixtures and run them against tension-core.
//
// Three steps per fixture (`tension-ogre/DESIGN.md` §10):
//
//   1. the generator derives layout.ts and the asc flags from session.json, with
//      the layout hash `tension-core layout-hash` prints — a disagreement stops
//      the build instead of shipping a guest the host will refuse;
//   2. `tensionscript` compiles each fixture with those flags;
//   3. `tension-core` runs them. The ogre fixture needs `--capability` pointed at
//      the stub adapter, which cargo builds into its own OUT_DIR.
//
// A fixture's contract is "prints OK, exit 0". A trap is a failure with a
// distinct signature, and so is a non-zero exit — both are asserted, because
// "the guest aborted" is only evidence when it aborted for the right reason.
//
// Usage: node scripts/test-framework.mjs [path-to-tension-core] [path-to-stub-adapter]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, npmBin } from './lib/toolchain.mjs';
import { fail, indent, inherit, spawn } from './lib/proc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = REPO;
const framework = join(repo, 'tension-framework');
const build = join(framework, 'build');
const RUNNER = 'test-framework';

const core = process.argv[2] ?? join(repo, 'tension-core', 'target', 'debug', `tension-core${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(core)) {
  fail(RUNNER, `no interpreter at ${core} — build it with:\n` +
               `        cargo build --manifest-path tension-core/Cargo.toml --no-default-features`);
}

/// The stub adapter cargo built. `--capability` needs a path, so this looks for
/// the newest one under the interpreter's target directory unless given one.
function findStub() {
  if (process.argv[3]) return process.argv[3];
  const root = join(repo, 'tension-core', 'target', 'debug', 'build');
  let best = null;
  let bestTime = -1;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('tension-core-')) continue;
    const candidate = join(root, entry.name, 'out', 'libtension_ogre_stub.so');
    if (!existsSync(candidate)) continue;
    const mtime = statSync(candidate).mtimeMs;
    if (mtime > bestTime) {
      best = candidate;
      bestTime = mtime;
    }
  }
  return best;
}

const stub = findStub();
if (!stub || !existsSync(stub)) {
  fail(RUNNER, 'no ogre stub adapter found — build it with:\n' +
               '        cargo build --manifest-path tension-core/Cargo.toml --no-default-features');
}

// ── the generated constants and the asc flags ───────────────────────────────
//
// `TENSION_SESSION_READY=1` means the runner (`scripts/test.mjs`) already built
// the debug host and generated the constants, once, before starting any suite. It
// is set because three suites write the same three files and a concurrent write
// is a truncated file — identical content is still not atomic. Run this script
// on its own and the generation happens here, as it always did.
if (process.env.TENSION_SESSION_READY === '1') {
  if (!existsSync(join(framework, 'assembly', 'runtime', 'layout.ts'))) {
    fail(RUNNER, 'TENSION_SESSION_READY is set but layout.ts is missing — ' +
                 'the runner did not generate it');
  }
  console.log('==> using the session constants the runner generated');
} else {
  const hash = spawn(core, ['layout-hash']).stdout.trim();
  if (!hash) fail(RUNNER, 'tension-core layout-hash printed nothing');
  console.log(`==> generating the runtime's constants (layout hash ${hash})`);
  const gen = inherit(process.execPath, [join(here, 'gen-session.mjs'), '--hash', hash]);
  if (gen.status !== 0) fail(RUNNER, `the framework's generator refused the layout hash (${hash})`);
}

mkdirSync(build, { recursive: true });

const asc = npmBin(framework, 'tensionscript');
if (!existsSync(asc)) {
  fail(RUNNER, 'tensionscript is not installed in tension-framework/node_modules — run: npm run build:framework');
}

const asconfig = join(build, 'session.asconfig.json');

/// Compile one fixture. Returns the compiler's result so the conditional cases
/// can inspect a failure instead of dying on it.
function compile(entry, out, { session = true } = {}) {
  const args = [join(framework, 'tests', entry)];
  if (session) args.push('--config', asconfig);
  else args.push('--runtime', 'incremental', '--target', 'release');
  args.push('-o', join(build, out));
  return spawn(asc, args, { cwd: framework });
}

/// Run a compiled fixture and return the result.
function runGuest(wasm, args = [], options = {}) {
  return spawn(core, [...args, join(build, wasm)], options);
}

/// The drift-check diagnostic, matched whole: it carries the type name and both
/// sizes, so matching the line is evidence the checker fired on the right entry
/// with the right numbers rather than merely that something aborted.
const DRIFT_MESSAGE =
  "the session's manifest does not match this guest's declarations: " +
  'SessionInfo: guest 144 != host 128';

/// The callback guard's message. Same reasoning: a non-zero exit alone is not
/// evidence that the guard refused.
const GUARD_MESSAGE =
  'makeCallbacks: a handler that captures `this` cannot be called by the host';

function compileOrFail(entry, out, options = {}) {
  console.log(`==> compiling ${entry}`);
  const result = compile(entry, out, options);
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(RUNNER, `${entry}: did not compile`);
  }
}

/// A fixture whose contract is "prints OK, exit 0".
function runFixture(entry, out, args = []) {
  compileOrFail(entry, out);
  console.log(`==> running ${out}`);
  const result = runGuest(out, args);
  console.log(indent(result.stdout));
  if (result.status !== 0) {
    console.error(`${RUNNER}: ${entry}: the interpreter exited ${result.status}; stderr:`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  if (!result.stdout.includes('OK')) {
    console.error(`${RUNNER}: ${entry}: the guest did not print OK`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  console.log(`    == ${entry}: OK`);
}

/// A fixture whose contract is a refusal, parameterised on the message. Used for
/// both the drift check and the callback guard: the same three assertions (a
/// non-zero exit, no OK, and the named message) in one place.
///
/// `session` decides how it compiles: the drift fixture is a session guest and
/// needs the arena flags, while the guard fixture is a plain module that defines
/// its own memory.
function runRefusalFixture(entry, out, { message, what, session }) {
  compileOrFail(entry, out, { session });
  console.log(`==> running ${out} (expecting ${what})`);
  const result = runGuest(out);
  if (result.status === 0) {
    console.error(`${RUNNER}: ${entry}: the interpreter exited 0 — ${what} did not fire`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  if (result.stdout.includes('OK')) {
    fail(RUNNER, `${entry}: the fixture printed OK — it was supposed to be refused`);
  }
  if (!result.stderr.includes(message)) {
    console.error(`${RUNNER}: ${entry}: the abort was not ${what}'s message; stderr:`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  console.log(`    == ${entry}: refused by ${what} (exit ${result.status})`);
}

/// A fixture that is not a session guest: it imports only `tension::io` and
/// defines its own memory, so it is compiled without the session's flags and run
/// with no capability. The host treats a module as a session guest only when it
/// imports from the `session` namespace, which is the distinction this makes
/// explicit rather than accidental.
function runPlainFixture(entry, out) {
  compileOrFail(entry, out, { session: false });
  console.log(`==> running ${out}`);
  const result = runGuest(out);
  console.log(indent(result.stdout));
  if (result.status !== 0) {
    console.error(`${RUNNER}: ${entry}: the interpreter exited ${result.status}; stderr:`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  if (!result.stdout.includes('OK')) {
    console.error(`${RUNNER}: ${entry}: the guest did not print OK`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  console.log(`    == ${entry}: OK`);
}

/// Whether a fixture's compile failed because the installed tensionscript's std
/// predates 0.6.1. The missing symbol differs per fixture, so the test is on the
/// *shape* of the error: a missing `__task*` export is the old std, and anything
/// else is a real failure that must not be skipped.
function isOldStdlib(compileResult) {
  return /no exported member '__task/.test(compileResult.stdout + compileResult.stderr);
}

/// A host-loop fixture: compiled with the session flags, run with optional host
/// flags, and asserted on a marker string rather than plain OK.
function runHostLoopFixture({ entry, out, marker, args = [], reason, alternative }) {
  console.log(`==> compiling ${entry}`);
  const compiled = compile(entry, out);
  if (compiled.status !== 0) {
    const log = compiled.stdout + compiled.stderr;
    if (isOldStdlib(compiled) || (alternative && alternative.test(log))) {
      console.log(`    == ${entry.replace(/\.ts$/, '')}: SKIP — ${reason}`);
      return;
    }
    process.stderr.write(log);
    fail(RUNNER, `${entry}: compile failed for a reason other than the expected missing support`);
  }

  console.log(`==> running ${out}`);
  const result = runGuest(out, args);
  console.log(indent(result.stdout));
  if (result.status !== 0) {
    console.error(`${RUNNER}: ${entry}: exited ${result.status}; stderr:`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  if (!result.stdout.includes(marker)) {
    console.error(`${RUNNER}: ${entry}: expected "${marker}"; stderr:`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  console.log(`    == ${entry.replace(/\.ts$/, '')}: OK`);
}

// ── the fixtures ────────────────────────────────────────────────────────────

runFixture('guest-open.ts', 'guest-open.wasm');

// The drift check's three cells, each a real guest run against the real host.
runFixture('guest-drift-refuse.ts', 'guest-drift-refuse.wasm');
runFixture('guest-drift-partial.ts', 'guest-drift-partial.wasm');
runRefusalFixture('guest-drift-fixed.ts', 'guest-drift-fixed.wasm',
                  { message: DRIFT_MESSAGE, what: 'the drift check', session: true });

runFixture('guest-ogre.ts', 'guest-ogre.wasm', ['--capability', stub]);
runFixture('guest-verlet.ts', 'guest-verlet.wasm');
runFixture('guest-physics-units.ts', 'guest-physics-units.wasm');

runPlainFixture('guest-anim-parser.ts', 'guest-anim-parser.wasm');
runPlainFixture('guest-anim-eval.ts', 'guest-anim-eval.wasm');
runPlainFixture('guest-log.ts', 'guest-log.wasm');
runPlainFixture('guest-callbacks.ts', 'guest-callbacks.wasm');
runRefusalFixture('guest-callbacks-guard.ts', 'guest-callbacks-guard.wasm',
                  { message: GUARD_MESSAGE, what: 'the guard', session: false });

// ── the AI stream's controls ────────────────────────────────────────────────
//
// Unlike the other session fixtures this one takes a *guest* argument (the model
// path, which the stub ignores), so it needs its own runner: everything before
// the wasm is a host flag, everything after is the guest's `args`. Run twice —
// once normally (controls 2-4: coalescing, done vs an empty chunk, the ring
// invariant) and once with the adapter stalling (control 1: a parked stream
// woken by an error post).
function runAiFixture(mode = '', env = {}) {
  const args = [join(build, 'guest-ai-stream.wasm'), 'models/unused.gguf'];
  if (mode) args.push(mode);
  console.log(`==> running guest-ai-stream.wasm${mode ? ` (${mode})` : ''}`);
  const result = spawn(core, args, { cwd: framework, env });
  console.log(indent(result.stdout));
  if (result.status !== 0) {
    console.error(`${RUNNER}: guest-ai-stream (${mode}): exited ${result.status}; stderr:`);
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  // Every control line must have measured PASS, not merely compiled.
  if (result.stdout.includes('FAIL')) {
    fail(RUNNER, `guest-ai-stream (${mode}): a control FAILED`);
  }
  if (!result.stdout.includes('OK')) {
    fail(RUNNER, `guest-ai-stream (${mode}): the guest did not print OK`);
  }
  console.log(`    == guest-ai-stream${mode ? ` (${mode})` : ''}: OK`);
}

console.log('==> compiling guest-ai-stream.ts');
{
  const compiled = compile('guest-ai-stream.ts', 'guest-ai-stream.wasm');
  if (compiled.status === 0) {
    runAiFixture();
    runAiFixture('stall', { TENSION_AI_STUB_STALL_MS: '50' });
  } else if (isOldStdlib(compiled)) {
    console.log('    == guest-ai-stream (and stall): SKIP — the installed tensionscript ' +
                'has no push-path std (needs >= 0.6.1)');
  } else {
    process.stderr.write(compiled.stdout + compiled.stderr);
    fail(RUNNER, 'guest-ai-stream: compile failed for a reason other than the missing std');
  }
}

// The push path (0.7.0a): a guest that exports `__taskWake` and `_game_running`,
// so the host owns the loop. `--post-test-events` queues the JOB_DONE records
// before the guest runs; what this proves is the part that is new — the guest
// parks, the host matches `(family, key)` to the task id, and `__taskWake`
// resumes it, with no `__taskTick` call from the guest.
runHostLoopFixture({
  entry: 'guest-push.ts', out: 'guest-push.wasm',
  marker: 'PUSH resumed with 2', args: ['--post-test-events'],
  reason: 'the installed tensionscript has no push-path std (needs >= 0.6.1)',
});

// The frame clock: the guest awaits `rt.frame()`, which parks it on `(FRAME, 0)`.
// The host loop's per-iteration frame add is the only thing that resolves it. The
// guest stops itself after three frames, so a loop that fails to wake it shows up
// as a marker mismatch, not a hang.
runHostLoopFixture({
  entry: 'guest-frame.ts', out: 'guest-frame.wasm',
  marker: 'FRAME loop finished after 3 frames',
  reason: 'the installed tensionscript has no push-path std (needs >= 0.6.1)',
});

// The early-completion table: `--post-test-events` queues three job records before
// the guest runs, and the guest waits two frames before parking — so the record it
// wants was published with nobody waiting. It must still be there when the park
// arrives.
runHostLoopFixture({
  entry: 'guest-early.ts', out: 'guest-early.wasm',
  marker: 'EARLY resumed with 6', args: ['--post-test-events'],
  reason: 'the installed tensionscript has no __taskResume (needs >= 0.6.1)',
});

// The synchronous async function: a task that never parks. A four-slot table
// against twelve tasks is what makes a leaked slot visible.
runHostLoopFixture({
  entry: 'guest-sync.ts', out: 'guest-sync.wasm',
  marker: 'SYNC 12 synchronous awaits summed 504', args: ['--post-test-events'],
  reason: 'the installed tensionscript has no creation guard (needs >= 0.6.1)',
});

// The refused-creation path: two tasks hold both slots and a third is created
// while they do. Capacity bounds *live* tasks, so the third is settled with
// -ENOSPC before its body runs.
runHostLoopFixture({
  entry: 'guest-enospc.ts', out: 'guest-enospc.wasm',
  marker: 'ENOSPC third task settled with -28', args: ['--post-test-events'],
  reason: 'the installed tensionscript has no creation guard (needs >= 0.6.1)',
});

// `break`/`continue` in an await-bearing loop (0.7.1). The `for` pair is the one
// that can go wrong quietly: an instrumented `for` used to append its incrementor
// to the body, so a native `continue` skipped it and the loop spun forever.
runHostLoopFixture({
  entry: 'guest-flow.ts', out: 'guest-flow.wasm',
  marker: 'FLOW PASS',
  reason: 'the installed tensionscript refuses break/continue in async bodies (needs >= 0.7.1)',
  alternative: /break in an async function body/,
});

// The chained await: a task parked on another *suspending guest task's* record.
// No producer key, so the host never hears of it — the guest's own completion has
// to wake it. This is the shape that deadlocked when `wake` filtered on
// `slot >= 0`.
runHostLoopFixture({
  entry: 'guest-chain.ts', out: 'guest-chain.wasm',
  marker: 'CHAIN outer: got 7',
  reason: 'the installed tensionscript has no push-path std (needs >= 0.6.1)',
});

// The drop path: a record the sub-ring refuses must wake its parked task with
// -EIO, not leave it parked. `--post-test-events` queues three job records; the
// guest opens a two-slot ring with no callbacks, so the third is dropped by the
// session, and it parks on exactly that record (job 5).
runHostLoopFixture({
  entry: 'guest-drop.ts', out: 'guest-drop.wasm',
  marker: 'DROP woke with status -5', args: ['--post-test-events'],
  reason: 'the installed tensionscript has no __taskFail (needs >= 0.6.1)',
});

// ── the logger's records ────────────────────────────────────────────────────
// The compiled fixture's records must reach the host's layout and filter: at
// `trace` every level is present, the structured payload lands in the message
// slot, and a non-ASCII message is whole — which is what pins the UTF-8
// byte-length path in `assembly/io.ts` (a UTF-16 length would truncate it).
console.log("==> checking guest-log's records (trace)");
{
  const result = spawn(core, ['--log-level=trace', join(build, 'guest-log.wasm')]);
  const traceErr = `${result.stderr}${result.stdout}`;
  const needles = [
    'TRACE game: trace:',
    'DEBUG game: debug:',
    'WARN  game: warn',
    'FATAL game: fatal',
    'INFO  game: {"tick":1,"ready":true}',
    'unicode: héllo wörld ✓',
  ];
  for (const needle of needles) {
    if (!traceErr.includes(needle)) {
      console.error(`${RUNNER}: guest-log: no record containing: ${needle}`);
      process.stderr.write(traceErr);
      process.exit(1);
    }
  }
  console.log('    == guest-log records: OK');
}

console.log('==> all fixtures OK');
