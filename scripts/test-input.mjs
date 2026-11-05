#!/usr/bin/env node
// tension-input test runner — the DSO's own gate.
//
// Builds the DSO, compiles the guest fixture with the framework's generated
// flags, and runs three cases:
//
//   with-display  input opens, attaches to its own surface (kind 0), reads a
//                 state record, and closes. No renderer is loaded: that is the
//                 point of the capability being its own DSO (INPUT.md §6).
//   no-driver     SDL_VIDEODRIVER names a driver this build cannot provide: the
//                 refusal is -ENODEV, and the guest says so on stdout.
//   no-env        DISPLAY and WAYLAND_DISPLAY unset. On a machine whose Wayland
//                 backend still finds the compositor this comes up anyway; the
//                 case asserts only that the guest answers, and the log says
//                 which driver it got.
//
// The guest handles its own failure, so a non-zero exit here is the bug.
//
// `--edge` runs the end-to-end device probe instead (see scripts/test-input-edge.mjs).
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

// The capability itself is POSIX/X11-only (src/input.cpp dlopens libX11), so
// there is nothing to test here on Windows. A skip with the reason, never a pass.
if (WIN) {
  console.log(`${RUNNER}: SKIPPED — the input capability is POSIX/X11-only today\n` +
              '  (src/input.cpp loads libX11 to size the window SDL created)' );
  process.exit(0);
}

// And it needs a *working* display: the probe window is the thing under test.
//
// `DISPLAY` being set is not the same as the display working. Measured on WSL2
// with WSLg: `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0` were both set, but
// `xdpyinfo` could not connect, SDL's thread never reported startup, and — the
// part that cost the most time — the host did not exit after logging
// "input: init: the SDL thread did not start". It hung until killed. A suite that
// waits on a broken display is worse than one that says so.
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.log(`${RUNNER}: SKIPPED — no DISPLAY or WAYLAND_DISPLAY\n` +
              '  the capability opens a probe window, and SDL blocks rather than failing' );
  process.exit(0);
}


const core = process.env.TENSION_CORE ??
  join(repo, 'tension-core', 'target', 'debug', `tension-core${WIN ? '.exe' : ''}`);
const dso = join(out, WIN ? 'libtension_input.dll' : 'libtension_input.so');

if (!existsSync(core)) {
  fail(RUNNER, 'the interpreter is not built. Run:\n' +
               '    cargo build --manifest-path tension-core/Cargo.toml --no-default-features');
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

const compiled = spawn(asc, [join(suite, 'tests', 'guest-input.ts'),
                             '--config', join(framework, 'build', 'session.asconfig.json'),
                             '-o', join(out, 'guest-input.wasm')]);
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr);
  fail(RUNNER, 'guest-input.ts did not compile');
}

const guest = join(out, 'guest-input.wasm');

/// Run the guest and assert a stdout prefix.
///
/// `timeout` is not optional: the capability opens a window through SDL, and on a
/// machine with no reachable display SDL does not fail — its thread never reports
/// startup, and the host then keeps running. Measured on WSL2: 1,400+ seconds of
/// silence before this change.
///
/// Returns `{ skipped: true }` when the environment could not provide a display.
/// The test is the capability's own diagnostic (`the SDL thread did not start`),
/// not an inference from `DISPLAY`: a broken display and a missing one are the
/// same thing to SDL, and both mean this case cannot be exercised rather than
/// that it regressed. Any other timeout is a failure.
function caseRun(name, wantPrefix, env = {}) {
  const result = spawn(core, ['--capability', dso, guest], { env, timeout: 60_000 });
  const environmentRefused = /SDL thread did not start/.test(result.stderr);

  if (result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT') {
    if (environmentRefused) return { skipped: true };
    fail(RUNNER, `${name}: timed out after 60 s and SDL did not report a reason ` +
                 `(stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  if (environmentRefused) return { skipped: true };
  if (result.status !== 0) {
    fail(RUNNER, `${name}: the interpreter exited ${result.status} ` +
                 `(stderr: ${result.stderr.trim().split('\n').slice(-2).join(' ')})`);
  }
  if (!result.stdout.startsWith(wantPrefix)) {
    fail(RUNNER, `${name}: expected stdout starting "${wantPrefix}", got: ${result.stdout.trim()}`);
  }
  return result;
}

// ── case 1: with a display ────────────────────────────────────────────────────
// The capability needs a display to open its probe window.
const headless = !WIN && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (headless) {
  console.log('== with-display: skipped — no DISPLAY or WAYLAND_DISPLAY (SDL would block)');
} else {
  const result = caseRun('with-display', 'OK ');
  if (result.skipped) {
    console.log('== with-display: SKIPPED — the display is not reachable\n' +
                `  DISPLAY=${process.env.DISPLAY ?? '<unset>'} ` +
                `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? '<unset>'}; ` +
                'SDL reported "the SDL thread did not start"');
    console.log('\ntension-input tests: the display-dependent cases could not run on this host');
    process.exit(0);
  }
  console.log(`== with-display: ok — ${result.stdout.trim()}`);
}

if (!WIN) {
  // ── case 2: a video driver this build cannot provide ────────────────────
  // SDL_Init fails, the DSO's init still returns 0 (the capability loads; the
  // refusal point is the verb), and input_open answers -ENODEV.
  {
    const result = caseRun('no-driver', 'OK headless -ENODEV',
                           { SDL_VIDEODRIVER: 'tension-no-such-driver' });
    console.log(`== no-driver: ok — ${result.stdout.trim()}`);
  }

  // ── case 3: no DISPLAY, no WAYLAND_DISPLAY ─────────────────────────────
  {
    const result = caseRun('no-env', 'OK ',
                           { DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
    const driver = result.stderr.match(/video driver '[^']*'/)?.[0] ?? '(driver not logged)';
    console.log(`== no-env: ok — ${result.stdout.trim()} (${driver})`);
  }
}

console.log('tension-input tests: all cases passed');
