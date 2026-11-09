#!/usr/bin/env node
// tension-input test runner — the DSO's own gate.
//
// Builds the DSO, compiles the guest fixture with the framework's generated
// flags, and runs three cases:
//
//   with-display  the guest creates its own 320x200 window, opens input,
//                 attaches, reads a state record and every pad slot, requests
//                 relative mouse mode, and closes. No renderer is loaded.
//   no-driver     SDL_VIDEODRIVER names a video driver this machine does not
//                 have: the host cannot make a window, so `attach` has nothing
//                 to join and the guest prints the headless answer.
//   no-env        DISPLAY and WAYLAND_DISPLAY unset. Same shape: whatever SDL
//                 manages, the guest answers, and the answer is asserted to be
//                 one of the two legal ones.
//
// **The window is the guest's now (v7).** Before this pass the capability made
// one, which is why every case here used to start with "input's probe window
// appears". Nothing in the DSO touches a window, so a case that creates none is
// the `no-window` refusal case, and that is the third scenario below.
//
// `--edge` runs the measurement probe instead (scripts/test-input-edge.mjs).
//
// Usage: node scripts/test-input.mjs [--edge]

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, npmBin } from './lib/toolchain.mjs';
import { fail, inherit, spawn } from './lib/proc.mjs';

if (process.argv.includes('--edge')) {
  const edge = await import('./test-input-edge.mjs');
  await edge.run();
  process.exit(0);
}

const repo = REPO;
const suite = join(repo, 'tension-input');
const framework = join(repo, 'tension-framework');
const out = join(suite, 'build');
const RUNNER = 'tension-input tests';

// The build recipe still refuses Windows until V7c lands the docs that explain
// why the gate can go. A skip with the reason, never a pass.
if (WIN) {
  console.log(`${RUNNER}: SKIPPED — the capability is gated to POSIX until V7c\n` +
              '  (the source is portable as of v7b; the docs are not written yet)');
  process.exit(0);
}

const core = process.env.TENSION_CORE ??
  join(repo, 'tension-core', 'target', 'debug', `tension-core${WIN ? '.exe' : ''}`);
const dso = join(out, 'libtension_input.so');

if (!existsSync(core)) {
  fail(RUNNER, 'the interpreter is not built. Run:\n' +
               '    cargo build --manifest-path tension-core/Cargo.toml');
}

const built = inherit(process.execPath, [join(repo, 'scripts', 'build-input.mjs')]);
if (built.status !== 0) fail(RUNNER, 'the DSO did not build');
if (!existsSync(dso)) fail(RUNNER, `${dso} is missing`);

mkdirSync(out, { recursive: true });

// `TENSION_SESSION_READY=1` means `scripts/test.mjs` generated the session
// constants once before starting the suites; running this script alone generates
// them here.
if (process.env.TENSION_SESSION_READY === '1') {
  console.log('==> using the session constants the runner generated');
} else {
  const hash = spawn(core, ['layout-hash']).stdout.trim();
  const generated = inherit(process.execPath,
                            [join(repo, 'scripts', 'gen-session.mjs'), '--hash', hash]);
  if (generated.status !== 0) {
    fail(RUNNER, `the framework's generator refused the layout hash (${hash})`);
  }
}

const asc = npmBin(framework, 'tensionscript');
if (!existsSync(asc)) fail(RUNNER, 'tensionscript is not installed in tension-framework/node_modules');

const guest = join(out, 'guest-input.wasm');
const compiled = spawn(asc, [join(suite, 'tests', 'guest-input.ts'),
                             '--config', join(framework, 'build', 'session.asconfig.json'),
                             '-o', guest]);
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr);
  fail(RUNNER, 'guest-input.ts did not compile');
}

/// Run the guest and assert a stdout prefix.
///
/// `timeout` is not optional: a broken display does not make SDL fail, it makes
/// it block, and a suite that waits on one is worse than one that says so.
/// Measured on WSL2 before this was added: 1,400+ seconds of silence.
function caseRun(name, args, wantPrefix, env = {}) {
  const result = spawn(core, ['--capability', dso, guest, ...args], { env, timeout: 90_000 });
  if (result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') {
    fail(RUNNER, `${name}: timed out after 90 s ` +
                 `(stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  if (result.status !== 0) {
    fail(RUNNER, `${name}: the interpreter exited ${result.status} ` +
                 `(stdout: ${result.stdout.trim().split('\n').slice(-3).join(' | ')}; ` +
                 `stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  if (!result.stdout.startsWith(wantPrefix)) {
    fail(RUNNER, `${name}: expected stdout starting "${wantPrefix}", got: ${result.stdout.trim()}`);
  }
  return result;
}

// ── case 1: with a display ────────────────────────────────────────────────────
// The guest creates the window, so this is the case that proves the whole path:
// createWindow -> open -> attach -> state.
const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (headless) {
  console.log('== with-display: skipped — no DISPLAY or WAYLAND_DISPLAY');
} else {
  const result = caseRun('with-display', [], 'OK attached');
  console.log(`== with-display: ok — ${result.stdout.trim().split('\n')[0]}`);
}

// ── case 2: no window at all ────────────────────────────────────────────────
// The refusal that replaces "no display": the capability is fine, there is just
// nothing to attach to.
{
  const result = caseRun('no-window', ['--no-window'], 'OK headless -ENODEV');
  console.log(`== no-window: ok — ${result.stdout.trim()}`);
}

// ── case 3: a video driver this machine does not have ───────────────────────
// The host cannot create a window, so the guest's createWindow fails and it
// reports the headless answer instead of attaching.
{
  const result = caseRun('no-driver', [], 'OK headless', { SDL_VIDEODRIVER: 'tension-no-such-driver' });
  console.log(`== no-driver: ok — ${result.stdout.trim()}`);
}

// ── case 4: no DISPLAY, no WAYLAND_DISPLAY ──────────────────────────────────
// Whatever driver SDL finds (the `offscreen` one, usually), the guest answers
// with one of the two legal lines. The log says which driver it got.
{
  const result = caseRun('no-env', [], 'OK ',
                         { DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
  const driver = result.stderr.match(/video driver '[^']*'/)?.[0] ?? '(driver not logged)';
  console.log(`== no-env: ok — ${result.stdout.trim()} (${driver})`);
}

console.log('tension-input tests: all cases passed');
