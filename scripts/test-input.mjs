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

// And it needs a display: the probe window is the thing under test. On a headless
// host SDL does not fail — it waits — so the suite would hang instead of
// reporting. Measured on WSL2: 34 minutes of silence before a timeout.
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

const hash = spawn(core, ['layout-hash']).stdout.trim();
const generated = inherit(process.execPath,
                          [join(repo, 'scripts', 'gen-session.mjs'), '--hash', hash]);
if (generated.status !== 0) {
  fail(RUNNER, `the framework's generator refused the layout hash (${hash})`);
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
/// machine with no display and no compositor SDL can block instead of failing —
/// measured on WSL2, where the first `npm test` sat for 34 minutes with no
/// output. A test that hangs is worse than one that fails.
function caseRun(name, wantPrefix, env = {}) {
  const result = spawn(core, ['--capability', dso, guest], { env, timeout: 120_000 });
  if (result.signal || result.error?.code === 'ETIMEDOUT') {
    fail(RUNNER, `${name}: timed out after 120 s (SDL could not reach a display)`);
  }
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
// The capability needs a display to open its probe window. On a headless machine
// there is nothing to attach to, and SDL blocks rather than answering, so the
// case is skipped with the reason instead of timing out.
const headless = !WIN && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (headless) {
  console.log('== with-display: skipped — no DISPLAY or WAYLAND_DISPLAY (SDL would block)');
} else {
  const result = caseRun('with-display', 'OK ');
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
