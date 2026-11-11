#!/usr/bin/env node
// The window-close gate: the X button must end the process, and every guest
// loop that owns its own lifetime must be able to notice.
//
// ## Why this is a test and not a code review
//
// The bug is invisible to every other kind of check. A guest whose loop reads
// only `present()` compiles, runs, draws correctly, and answers every probe —
// and then refuses to exit when the user clicks the X, so it is killed with
// Ctrl+C and the close path (canvas teardown, `session_close`, the device
// release) is never exercised at all. Three of this tree's own examples shipped
// that shape for a month.
//
// Two phases, because the property has two halves and they fail differently:
//
//   shape   every guest source that presents frames reads `closeRequested`.
//           Static, no display, catches a *new* loop written the old way — the
//           regression this gate exists for.
//   live    one of them, really launched, with a real click on a real titlebar
//           button: the process exits non-zero or late if the shape is wrong, so
//           this is the phase that would have caught it originally.
//
// The live phase needs a display, a window manager and `xdotool`, and it is
// skipped with a printed reason when any of them is missing — the same policy
// `test-input.mjs` uses for its with-display case. CI has no display, and a
// green line from a machine that never opened a window would be a claim this
// runner cannot make.
//
// It also needs an interpreter with `render2d-core`, and that is worth knowing
// before reading a skip as a pass: `scripts/test.mjs` prepares the debug host
// with **`--no-default-features`** (the bisect configuration, where `tension::2d`
// comes from `tension-2d/build/libtension_2d.so`), so after any `npm test` the
// host in `target/debug` cannot answer the 2D imports in-core. This phase says
// so and skips rather than failing the tree for a configuration the runner chose.
// On a rig, run it against the default build:
//
//     cargo build --manifest-path tension-core/Cargo.toml
//     node scripts/test-window-close.mjs --live
//
// `--live` turns the skip into a failure, which is what a rig verification wants.
//
// Usage:
//   node scripts/test-window-close.mjs          both phases
//   node scripts/test-window-close.mjs --shape  the static check only
//   node scripts/test-window-close.mjs --live   both, and a skip fails

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO, WIN, which } from './lib/toolchain.mjs';
import { fail } from './lib/proc.mjs';
const repo = REPO;
const RUNNER = 'window-close';

// ── the guests that own a frame loop ────────────────────────────────────────
//
// The whole tree, not a list: a hardcoded list is the thing that goes stale
// exactly when someone adds the next example. `node_modules` is the only
// exclusion that matters — every vendored compiler ships a `while` loop that
// presents something.
const ROOTS = [
  join(repo, 'examples'),
  join(repo, 'apps'),
  join(repo, 'packages', 'cli', 'templates'),
];

/// Every `.ts` under `dir`, minus node_modules and build output.
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'build' || name === 'dist') continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/// A guest loop is a file that presents frames.
///
/// `present(` covers the 2D API (`canvas.present()`, `gfx.present(h)`) and the
/// framework's own wrappers. The Ogre guests are deliberately *not* matched by
/// `present`: their loop is `await rt.frame()`, driven by the host's
/// `_game_running()`, so there is no exit check for them to forget — the host
/// stops calling the loop. Nothing here to sweep, and the phase below says so
/// rather than silently passing them.
function presents(path) {
  const source = readFileSync(path, 'utf8');
  // A comment mentioning `present(` is not a call. Strip line and block
  // comments before deciding, so the prose in these files (which talks about
  // `present` constantly) cannot make a loop look like it has one.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return code.includes('.present(');
}

/**
 * Whether the guest either asks about the close, or has handed the loop over.
 *
 * `Scene.run` checks `closeRequested` at the top of every frame, so a guest whose
 * loop is the framework's does not repeat the check — and should not. The signal
 * for that is `_game_running`: a guest exports it only to have the *host* drive
 * it, which is exactly the delegation.
 *
 * Deliberately not `scene.run(`: the Ogre guests call `game.run()`, which builds
 * their own loop and would sail through a substring test. `_game_running` is the
 * thing that means what it says.
 */
function noticesClose(path) {
  const source = readFileSync(path, 'utf8');
  return source.includes('closeRequested') || source.includes('_game_running');
}

// ── phase 1: the shape ──────────────────────────────────────────────────────

function shapePhase() {
  const guests = ROOTS.flatMap((root) => walk(root));
  const loops = guests.filter(presents);
  const missing = loops.filter((path) => !noticesClose(path));

  for (const path of loops) {
    const mark = noticesClose(path) ? 'ok  ' : 'MISS';
    console.log(`  ${mark} ${relative(repo, path)}`);
  }
  console.log(`  ${loops.length} presenting guest(s), ${missing.length} without a close check`);

  if (missing.length) {
    fail(RUNNER, [
      `${missing.length} guest loop(s) never read \`closeRequested\`:`,
      ...missing.map((path) => `    ${relative(repo, path)}`),
      'a loop that owns its lifetime and waits on `present()` alone leaves the',
      'window\'s X button doing nothing — `present` only reports a close when',
      'its own pump drained SDL\'s quit event, and the host pumps the same queue',
      'in `RuntimeSession.wait`. Either read `windowInfo().closeRequested` at the',
      'top of the loop, or hand the loop to `scene.run`, which reads it for you.',
    ].join('\n'));
  }
}

// ── phase 2: the live click ─────────────────────────────────────────────────

/// The interpreter, resolved the way every runner in this tree resolves it.
function findCore() {
  const explicit = process.env.TENSION_CORE;
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const profile of ['debug', 'release']) {
    const candidate = join(repo, 'tension-core', 'target', profile, `tension-core${WIN ? '.exe' : ''}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function skipLive(reason) {
  if (process.argv.includes('--live')) {
    fail(RUNNER, `the live phase was asked for and cannot run: ${reason}`);
  }
  console.log(`== live: skipped — ${reason}`);
}

/// Sleep without a busy loop; the phase polls a child at 50 ms.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function livePhase() {
  if (WIN) return skipLive('the X.click harness is X11-only (`xdotool`)');
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return skipLive('no DISPLAY or WAYLAND_DISPLAY');
  }
  const xdotool = which('xdotool');
  if (!xdotool) return skipLive('`xdotool` is not installed');

  // A click on a titlebar is a window manager's job. Without one the click lands
  // on the guest's own client window and nothing closes, which would read as a
  // product failure and is not one.
  const wm = spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { encoding: 'utf8' });
  if (wm.status !== 0 || !/window id/.test(wm.stdout ?? '')) {
    return skipLive('no window manager is running on this display');
  }

  const core = findCore();
  if (!core) {
    return skipLive('no tension-core (cargo build --manifest-path tension-core/Cargo.toml)');
  }

  // The guest: hello-sprites, because it is the smallest window that presents and
  // the one whose window title is a constant. Its build is the same recipe its
  // own suite runs.
  const example = join(repo, 'examples', '2d', 'hello-sprites');
  const built = spawnSync(process.execPath, [join(repo, 'scripts', 'build-2d-guest.mjs')], {
    cwd: example, encoding: 'utf8',
  });
  if (built.status !== 0) {
    process.stderr.write(`${built.stdout ?? ''}${built.stderr ?? ''}`);
    fail(RUNNER, 'the hello-sprites guest did not build');
  }
  const guest = join(example, 'build', 'game.wasm');

  // Windowed, in-core renderer. No `--capability`: with `render2d-core` on by
  // default the binary answers `tension::2d` itself, and the pre-merge DSO
  // calls `SDL_Quit` in its own close, which would make the host's teardown
  // panic and turn this gate into a false alarm about the wrong subsystem.
  const { spawn } = await import('node:child_process');
  const proc = spawn(core, [guest, '--windowed'], {
    cwd: example,
    env: { ...process.env, TENSION_2D_HEADLESS: undefined },
  });

  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });

  // Wait for the window *and* for the guest to say it is holding the frame: a
  // click that arrives before the loop starts tests nothing about the loop.
  let wid = '';
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) {
      // The one early exit that is not a failure: an interpreter built for the
      // bisect answers none of `tension::2d`. Said, not silently tolerated.
      if (output.includes('unknown import: `tension::2d::')) {
        return skipLive('this tension-core was built without `render2d-core` ' +
                        '(the `--no-default-features` host `npm test` prepares); ' +
                        'rebuild with default features and re-run with `--live`');
      }
      fail(RUNNER, `the guest exited before it was ready (${proc.exitCode}):\n${output.trim()}`);
    }
    if (!wid) {
      const found = spawnSync(xdotool, ['search', '--name', '^Hello Sprites$'], { encoding: 'utf8' });
      wid = (found.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
    }
    ready = output.includes('close the window to exit');
    if (wid && ready) break;
    await wait(100);
  }

  if (!wid) {
    proc.kill('SIGKILL');
    fail(RUNNER, `no window appeared within 30 s:\n${output.trim()}`);
  }
  if (!ready) {
    proc.kill('SIGKILL');
    fail(RUNNER, `the window opened but the guest never reached its loop:\n${output.trim()}`);
  }

  // The titlebar's close button, clicked the way a user clicks it. Its position
  // is derived from the client geometry the WM published: the frame's control is
  // just inside the top-right of the client rect's top edge.
  const geometry = spawnSync(xdotool, ['getwindowgeometry', '--shell', wid], { encoding: 'utf8' });
  const field = (name) => Number((geometry.stdout ?? '').match(new RegExp(`^${name}=(-?\\d+)$`, 'm'))?.[1]);
  const x = field('X');
  const y = field('Y');
  const width = field('WIDTH');
  if (![x, y, width].every(Number.isFinite)) {
    proc.kill('SIGKILL');
    fail(RUNNER, `could not read the window's geometry:\n${geometry.stdout ?? ''}${geometry.stderr ?? ''}`);
  }

  const started = Date.now();
  spawnSync(xdotool, ['mousemove', String(x + width - 14), String(y - 14), 'click', '1']);

  // Ten seconds is not a generous timeout, it is a different failure: a guest
  // that has not exited by now is not slow, it never noticed.
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    proc.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });

  if (!exited) {
    proc.kill('SIGKILL');
    fail(RUNNER, [
      'the guest did not exit within 10 s of the window being closed —',
      'this is the X-button bug. The loop must read `windowInfo().closeRequested`',
      'at the top and `present()` for the -ECANCELED case.',
      `last output: ${output.trim().split('\n').slice(-3).join(' | ')}`,
    ].join('\n'));
  }

  const elapsed = Date.now() - started;
  if (exited.code !== 0) {
    fail(RUNNER, [
      `the guest exited ${exited.code}${exited.signal ? ` (${exited.signal})` : ''} after the close,`,
      'so the loop ended without running its teardown to completion:',
      output.trim().split('\n').slice(-6).map((line) => `    ${line}`).join('\n'),
    ].join('\n'));
  }
  // The teardown's own lines: a process that exits 0 through a trap or a signal
  // handler would not have printed these, and "the window closed" and "the
  // process died" are otherwise identical from outside.
  if (!output.includes('session_close() -> 0')) {
    fail(RUNNER, 'the guest exited but never ran `RuntimeSession.close()`:\n' +
                 output.trim().split('\n').slice(-6).map((line) => `    ${line}`).join('\n'));
  }

  console.log(`== live: ok — clicked the titlebar X at ${x + width - 14},${y - 14}; ` +
              `exit 0 in ${elapsed} ms, \`session_close() -> 0\` printed`);
}

// ── run ─────────────────────────────────────────────────────────────────────

console.log('== shape: every guest loop that owns its lifetime');
shapePhase();

if (process.argv.includes('--shape')) {
  console.log(`${RUNNER}: shape checks passed`);
  process.exit(0);
}

await livePhase();
console.log(`${RUNNER}: passed`);
