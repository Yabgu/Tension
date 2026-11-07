#!/usr/bin/env node
// test.mjs — is the framework a library over the primitives, or a second
// implementation of them?
//
// The test that answers it is byte-equality. This runner builds two guests from
// the same synthetic scene:
//
//   examples/2d/isometric/            records written by hand
//   examples/2d/isometric-framework/  records written by Tileset + Composite +
//                                     IsometricWorld
//
// and compares their frames pixel for pixel. If they match, every record the
// framework emitted landed in the same place, with the same sort key, the same
// group and the same z as the hand-written scene — because anything else shows
// up as a difference in the rendered frame. That is a stronger claim than "it
// renders": it says the two paths are interchangeable.
//
// Then the usual probes, and four revert levers, each of which must produce the
// *specific* colour its mistake implies.
//
// Exit codes: 0 pass, 1 fail.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepare, runGuest, REPO } from '../synthetic/runner.mjs';
import { png, downscale } from '../synthetic/png.mjs';

const RUNNER = 'isometric-framework';
const here = dirname(fileURLToPath(import.meta.url));
const handDir = resolve(here, '..', 'isometric');
const shots = join(here, 'screenshots');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

let failures = 0;
function fail(message) {
  console.error(`  FAIL ${message}`);
  failures++;
}

// ── 1. the hand-written scene, for comparison ───────────────────────────────

console.log(`${RUNNER}: building the hand-written guest for comparison`);
let handCtx;
let fwCtx;
try {
  handCtx = prepare(handDir, { log: (line) => console.log(`${RUNNER}: [hand] ${line.trim()}`) });
  fwCtx = prepare(here, { log: (line) => console.log(`${RUNNER}: [fw] ${line.trim()}`) });
} catch (error) {
  die(error.message);
}
const s = fwCtx.scene;

const handRun = runGuest(handCtx, []);
if (handRun.status !== 0) {
  console.error(handRun.output);
  die(`the hand-written guest exited ${handRun.status}`);
}

const fwRun = runGuest(fwCtx, []);
if (fwRun.status !== 0) {
  console.error(fwRun.output);
  die(`the framework guest exited ${fwRun.status}`);
}
for (const line of fwRun.output.split('\n')) {
  if (line.startsWith('  ') || line.startsWith('===') || line.startsWith('sort keys') ||
      line.startsWith('set_pipeline') || line.startsWith('pages bound')) {
    console.log(line);
  }
}

const W = s.canvas.w;
const H = s.canvas.h;
for (const [name, frame] of fwRun.frames) {
  if (frame.rgba.length !== W * H * 4) {
    die(`frame ${name}: ${frame.rgba.length} bytes, expected ${W * H * 4}`);
  }
}

// ── 2. byte-identical ───────────────────────────────────────────────────────

function compare(label, a, b) {
  if (!a) return fail(`${label}: the framework guest printed no frame`);
  if (!b) return fail(`${label}: the hand-written guest printed no frame`);
  if (a.rgba.length !== b.rgba.length) {
    return fail(`${label}: ${a.rgba.length} bytes vs ${b.rgba.length}`);
  }
  if (a.rgba.equals(b.rgba)) {
    console.log(`  ${label}: byte-identical (${a.rgba.length} bytes)`);
    return true;
  }
  let differing = 0;
  let first = -1;
  for (let i = 0; i < a.rgba.length; i += 4) {
    if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] ||
        a.rgba[i + 2] !== b.rgba[i + 2] || a.rgba[i + 3] !== b.rgba[i + 3]) {
      if (first < 0) first = i;
      differing++;
    }
  }
  const at = first / 4;
  fail(
    `${label}: ${differing} differing pixels, first at (${at % W},${Math.floor(at / W)}): ` +
    `framework ${[a.rgba[first], a.rgba[first + 1], a.rgba[first + 2]]} vs ` +
    `hand ${[b.rgba[first], b.rgba[first + 1], b.rgba[first + 2]]}`);
  return false;
}

compare('framework back == hand-written back', fwRun.frames.get('back'), handRun.frames.get('back'));
compare('framework front == hand-written front', fwRun.frames.get('front'), handRun.frames.get('front'));

if (fwRun.frames.get('back') && fwRun.frames.get('front') &&
    fwRun.frames.get('back').rgba.equals(fwRun.frames.get('front').rgba)) {
  fail('the two facings render the same frame — the composite is not switching');
}

// ── 3. probes ───────────────────────────────────────────────────────────────

const pixel = (buf, x, y) => {
  const at = (y * W + x) * 4;
  return [buf[at], buf[at + 1], buf[at + 2]];
};
const close = (a, b, tol = 2) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const show = (c) => `(${c[0]},${c[1]},${c[2]})`;

const back = fwRun.frames.get('back');
const front = fwRun.frames.get('front');
const P = s.probes;
const E = s.expect;

function expectPixel(frame, probe, want, what) {
  const got = pixel(frame.rgba, probe.x, probe.y);
  if (close(got, want)) return true;
  fail(`${what}: (${probe.x},${probe.y}) is ${show(got)}, expected ${show(want)}`);
  return false;
}

expectPixel(back, P.hair, E.back.hair, 'composite (back): the hair is not on top at the centre');
expectPixel(back, P.pack, E.back.pack, 'composite (back): the backpack is not on top');
expectPixel(front, P.hair, E.front.hair, 'composite (front): the body is not on top at the centre');
expectPixel(front, P.pack, E.front.pack, 'composite (front): the body is not on top');
expectPixel(back, P.crownOnly, E.back.crownOnly, 'depth: the crown is not visible beside the character');
expectPixel(back, P.crownOver, E.back.crownOver, 'depth: the crown covers the character');
expectPixel(back, P.trunkOver, E.back.trunkOver, 'depth: the trunk does not cover the character');
expectPixel(back, P.pageA, E.back.pageA, 'multi-atlas: page A');
expectPixel(back, P.lantern, E.back.pageB, 'multi-atlas: page B');
expectPixel(back, P.pack, E.back.pageC, 'multi-atlas: page C');

// ── 4. the revert levers ────────────────────────────────────────────────────

function revert(label, guestArgs, frameName, probe, wantWrong, wantRight) {
  const outcome = runGuest(fwCtx, guestArgs);
  const frame = outcome.frames.get(frameName);
  if (!frame) return fail(`${label}: the guest produced no ${frameName} frame`);
  const got = pixel(frame.rgba, probe.x, probe.y);
  if (close(got, wantRight)) {
    return fail(`${label}: the probe still shows the correct ${show(got)} — the assertion it is meant to break never tested anything`);
  }
  if (!close(got, wantWrong)) {
    return fail(`${label}: the probe shows ${show(got)}, expected the mistake's ${show(wantWrong)}`);
  }
  console.log(`  ${label}: probe is ${show(got)}, the mistake's colour, not ${show(wantRight)} — caught`);
}

// Facing, chosen correctly: the front view differs from the back view and shows
// the body where the back shows the pack. This is the "it works" half.
const frontRun = runGuest(fwCtx, ['--facing-front']);
const frontF = frontRun.frames.get('front');
if (frontF && frontRun.frames.get('back') &&
    frontRun.frames.get('back').rgba.equals(frontF.rgba)) {
  fail('--facing-front: both frames identical — setFacing did nothing');
}

// Facing changed, z table not: must render as the back view even though the
// composite was told it faces front.
revert('revert facing (front label, back table)', ['--facing-mislabelled'], 'front',
  P.pack, E.back.pack, E.front.pack);

// Slicing removed: the whole tree sorts at its base, so it covers the character.
revert('revert slicing (sliceHeight 0)', ['--no-slice'], 'back',
  P.crownOver, E.wrong.noSlice, E.back.crownOver);

// One layer in its own, earlier group: the body covers the pack.
revert('revert grouping (backpack in its own group)', ['--break-group'], 'back',
  P.pack, E.wrong.brokenGroup, E.back.pack);

// ── 5. screenshots ──────────────────────────────────────────────────────────

mkdirSync(shots, { recursive: true });
writeFileSync(join(shots, 'framework-back.png'), png(W, H, back.rgba));
writeFileSync(join(shots, 'framework-front.png'), png(W, H, front.rgba));
const preview = downscale(back.rgba, W, H, 2);
writeFileSync(join(shots, 'framework-preview.png'), png(preview.width, preview.height, preview.rgba));

if (failures !== 0) {
  console.error(`${RUNNER}: FAIL (${failures} assertion(s))`);
  process.exit(1);
}
console.log(
  `${RUNNER}: PASS — framework frames are byte-identical to the hand-written scene, ` +
  `probes hold, three revert levers caught`,
);

// ── show it, unless asked not to ────────────────────────────────────────────
//
// Everything above asserted against offscreen frames. This last run is for the
// person who typed `npm start`: one windowed guest, held open until the window
// is closed. `--headless` or a missing display skips it, which is what CI does.
const argv = process.argv.slice(2);
const askedForHeadless = argv.includes('--headless') || process.env.TENSION_2D_HEADLESS === '1';
const hasDisplay =
  process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (!askedForHeadless && hasDisplay && !process.env.TENSION_2D_CHILD) {
  console.log(`${RUNNER}: showing the framework scene — close the window to exit`);
  const shown = spawnSync(fwCtx.core, [
    '--capability', fwCtx.dso,
    '--res', fwCtx.pak,
    fwCtx.guest,
    '--windowed',
  ], { stdio: 'inherit', env: { ...process.env, TENSION_2D_CHILD: '1' } });
  if (shown.error) console.error(`${RUNNER}: could not show the window: ${shown.error.message}`);
}
