#!/usr/bin/env node
// scripts/run-2d-example.mjs — build and run a tension-2d example, and assert
// the frame it produced.
//
// `npm run start` in `examples/2d/hello-sprites` runs this. It is a script
// rather than three shell commands for one reason: **the assertion**. The guest
// prints its pixel count and a verdict, but `tension-core` exits 0 whether the
// guest drew ten sprites or nothing at all — the host has no idea what a
// correct frame looks like. Something has to read the output and decide, and
// that is this file.
//
// The steps, in the order they matter:
//
//   1. the adapter must exist. If it does not, build it — a guest is useless
//      without the DSO whose hash table its `set_pipeline` call has to match.
//   2. the guest (scripts/build-2d-guest.mjs, which also emits the graph blob).
//   3. run it under a real session with the capability loaded.
//   4. parse the guest's numbers and fail on a mismatch.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'run-2d-example';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exampleDir = process.cwd();
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.error) return null;
  return result;
}

function findCore() {
  if (process.env.TENSION_CORE && existsSync(process.env.TENSION_CORE)) {
    return process.env.TENSION_CORE;
  }
  for (const profile of ['debug', 'release']) {
    const candidate = join(repo, 'tension-core', 'target', profile, `tension-core${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── 1. the adapter ──────────────────────────────────────────────────────────
const dso = existsSync(join(repo, 'tension-2d', 'build', WIN ? 'libtension_2d.dll' : 'libtension_2d.so'))
  ? join(repo, 'tension-2d', 'build', WIN ? 'libtension_2d.dll' : 'libtension_2d.so')
  : join(repo, 'tension-2d', 'build', 'libtension_2d.so');
if (!existsSync(dso)) {
  console.log(`${RUNNER}: no adapter, building it...`);
  const built = run('node', [join(repo, 'scripts', 'build-2d.mjs')], { stdio: 'inherit' });
  if (!built || built.status !== 0) die('the adapter did not build');
}

// ── 2. the guest ────────────────────────────────────────────────────────────
const guest = run('node', [join(repo, 'scripts', 'build-2d-guest.mjs')], { stdio: 'inherit' });
if (!guest || guest.status !== 0) die('the guest did not build');

// ── 3. the capability's own suite, first ────────────────────────────────────
//
// The C++ stub renders the same frame. Running it here means a guest failure
// is attributable: if the stub passes and the guest does not, the difference is
// the guest path, not the adapter.
// From the repo root: the stub core takes its blob paths as repo-relative, and
// this script is run from the example's directory.
const suite = run('node', [join(repo, 'scripts', 'test-2d.mjs')], { stdio: 'inherit', cwd: repo });
if (!suite || suite.status !== 0) die('the adapter suite failed, so the guest is not to blame');

// ── 4. the guest, under a real session ──────────────────────────────────────
const core = findCore();
if (!core) {
  die(
    `no tension-core found\n` +
      `  Run \`cargo build --manifest-path tension-core/Cargo.toml\` first.`,
  );
}

const sessionConfig = join(repo, 'tension-framework', 'build', 'session.asconfig.json');
if (!existsSync(sessionConfig)) {
  die(`missing ${sessionConfig}\n  Run \`node scripts/build-framework.mjs\` first.`);
}

// ── 3b. headless or a window ────────────────────────────────────────────────
//
// `npm start` shows a window: the guest is asked for `--windowed`, the adapter
// creates and claims one, and every `present` blits the frame to a swapchain.
// That is the point of running an example by hand.
//
// The suites never do this — they assert pixels, and a window would make the
// result depend on a compositor. So the default here is a window and the opt-out
// is explicit:
//
//   npm start                 a window, and the pixel assertion still runs
//   npm start -- --headless   no window (what CI does)
//   TENSION_2D_HEADLESS=1     same, for a script that cannot pass flags
//
// A machine with no display is detected and treated as headless rather than
// failing: `SDL_Init(SDL_INIT_VIDEO)` failing is not the example's fault.
const args = process.argv.slice(2);
const askedForHeadless =
  args.includes('--headless') || process.env.TENSION_2D_HEADLESS === '1';
const hasDisplay =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const windowed = !askedForHeadless && hasDisplay;

const guestArgs = ['--capability', dso, join(exampleDir, 'build', 'game.wasm')];
if (windowed) guestArgs.push('--windowed');

console.log(
  windowed
    ? `${RUNNER}: running the guest in a window (${args.includes('--headless') ? '' : '--headless to suppress'})`
    : `${RUNNER}: running the guest headless` +
        (askedForHeadless ? '' : ' (no display detected)'),
);

const result = run(core, guestArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  // `offscreen` only when there is no window to show: it is a real video
  // backend with a GPU, so it keeps the headless path identical to a windowed
  // one in everything but presentation. `dummy` would have no GPU at all
  // (`docs/modules/2d.md` §6).
  env: windowed ? process.env : { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
});

if (!result) die('could not start tension-core');
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

// The guest's lines are the interesting ones; the host's INFO lines are noise
// for a reader who ran `npm start` and wants to know whether it worked.
for (const line of (result.stdout ?? '').split('\n')) {
  if (line.trim()) console.log(`  ${line}`);
}

// ── 5. the assertion ────────────────────────────────────────────────────────
if (result.status !== 0) {
  console.error(result.stderr ?? '');
  die(`tension-core exited ${result.status}`);
}

const count = output.match(/screenshot -> \d+ bytes, (\d+) non-black pixels/);
const verdict = output.includes('OK: ten sprites at their recorded positions');

if (!count) {
  console.error(output);
  die('the guest printed no pixel count');
}

const drawn = Number(count[1]);

// **Hard-coded, not read from the guest.** The guest also prints what it
// expects, but that number is computed from the same `SPRITE_SIZE` that
// produced the frame: change both and a self-consistent guest passes while
// drawing something else. Measured — setting SPRITE_SIZE to 48 made the guest
// report "23040, expected 23040" and the first version of this check believed
// it. The reference is the C++ stub's count, and it does not move.
const want = 10240; // 10 sprites x 32x32, from tension-2d/tests/smoke_core.cpp

if (!verdict || drawn !== want) {
  console.error(`${RUNNER}: the guest drew ${drawn} pixels, expected ${want}`);
  die('the frame does not match the C++ smoke test');
}

console.log(`${RUNNER}: ${drawn} non-black pixels — matches the C++ smoke test`);
