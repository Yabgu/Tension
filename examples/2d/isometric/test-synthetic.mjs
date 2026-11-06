#!/usr/bin/env node
// test-synthetic.mjs — the isometric scene, without the SSH host.
//
// `test.mjs` is the showcase: it renders LimeZu's art and exits 77 when that art
// is not on the machine. This is the same scene from flat colour pages, so it
// runs in CI with no network and no assets.
//
// What it proves is the same list, at the same coordinates:
//
//   composite     back-facing the hair is on top at the sprite centre and the
//                 backpack at the lower back; front-facing the body is on top
//                 at both. Two probes, because one would not catch a body/
//                 backpack swap: at the centre there is no backpack to swap.
//   depth         the character is in front of the crown slice and behind the
//                 trunk slice — the tree is sliced, and the sort keys say so.
//   multi-atlas   three pages, one draw, one probe each.
//   the sort      two revert runs, each asking for one specific mistake and
//                 each asserting the *colour that mistake produces*.
//
// The scene numbers and the expected colours both come from
// `examples/2d/synthetic/pages.mjs`, so this file states no colour of its own.
//
// The guest is `examples/2d/isometric/src/main.ts`, unchanged. It reads its
// scene table and nothing else, which is the point: the synthetic path exercises
// the same guest code the real one does, so the two cannot drift apart without
// one of them failing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepare, runGuest, REPO } from '../synthetic/runner.mjs';
import { png, downscale } from '../synthetic/png.mjs';

const RUNNER = 'isometric-synthetic';
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(REPO, 'tension-2d', 'test-assets', 'screenshots');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

// ── 1. prepare, pack, run ───────────────────────────────────────────────────

let ctx;
try {
  ctx = prepare(here, { log: (line) => console.log(`${RUNNER}: ${line.trim()}`) });
} catch (error) {
  die(error.message);
}
const s = ctx.scene;

const normal = runGuest(ctx, []);
if (normal.status !== 0) {
  console.error(normal.output);
  die(`tension-core exited ${normal.status}`);
}
for (const line of normal.output.split('\n')) {
  if (line.startsWith('  ') || line.startsWith('===') || line.startsWith('sort keys') ||
      line.startsWith('set_pipeline') || line.startsWith('page ')) {
    console.log(line);
  }
}

const W = s.canvas.w;
const H = s.canvas.h;
const back = normal.frames.get('back');
const front = normal.frames.get('front');
if (!back || !front) die('the guest printed no frames');
for (const [name, frame] of [['back', back], ['front', front]]) {
  if (frame.rgba.length !== W * H * 4) {
    die(`frame ${name}: ${frame.rgba.length} bytes, expected ${W * H * 4}`);
  }
}

// ── 2. assertions ───────────────────────────────────────────────────────────

const pixel = (buf, x, y) => {
  const at = (y * W + x) * 4;
  return [buf[at], buf[at + 1], buf[at + 2]];
};
const close = (a, b, tol = 2) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const show = (c) => `(${c[0]},${c[1]},${c[2]})`;

let failures = 0;
function expectPixel(frame, probe, want, what) {
  const got = pixel(frame, probe.x, probe.y);
  if (close(got, want)) return true;
  console.error(`  FAIL ${what}: (${probe.x},${probe.y}) is ${show(got)}, expected ${show(want)}`);
  failures++;
  return false;
}

const P = s.probes;
const E = s.expect;

expectPixel(back.rgba, P.hair, E.back.hair, 'composite (back): the hair is not on top at the centre');
expectPixel(back.rgba, P.pack, E.back.pack, 'composite (back): the backpack is not on top at the lower back');
expectPixel(front.rgba, P.hair, E.front.hair, 'composite (front): the body is not on top at the centre');
expectPixel(front.rgba, P.pack, E.front.pack, 'composite (front): the body is not on top at the lower back');

// Depth, three probes. The middle two are the claim slicing exists for: in one
// frame the character is drawn over the crown and under the trunk.
expectPixel(back.rgba, P.crownOnly, E.back.crownOnly, 'depth: the crown is not visible beside the character');
expectPixel(back.rgba, P.crownOver, E.back.crownOver, 'depth: the crown covers the character');
expectPixel(back.rgba, P.trunkOver, E.back.trunkOver, 'depth: the trunk does not cover the character');

// Multi-atlas: three pages, three probes, one frame.
expectPixel(back.rgba, P.pageA, E.back.pageA, 'multi-atlas: page A');
expectPixel(back.rgba, P.lantern, E.back.pageB, 'multi-atlas: page B (the lantern)');
expectPixel(back.rgba, P.pack, E.back.pageC, 'multi-atlas: page C (the character)');

// ── 3. revert runs ──────────────────────────────────────────────────────────

function revert(label, guestArgs, frameName, probe, wantWrong, wantRight) {
  const outcome = runGuest(ctx, guestArgs);
  const frame = outcome.frames.get(frameName);
  if (!frame) {
    console.error(`  FAIL ${label}: the guest produced no ${frameName} frame`);
    failures++;
    return;
  }
  const got = pixel(frame.rgba, probe.x, probe.y);
  if (close(got, wantRight)) {
    console.error(
      `  FAIL ${label}: the probe still shows the correct ${show(got)} — ` +
      `the assertion it is meant to break never tested anything`);
    failures++;
    return;
  }
  if (!close(got, wantWrong)) {
    console.error(
      `  FAIL ${label}: the probe shows ${show(got)}, expected the mistake's ` +
      `${show(wantWrong)} (or the correct ${show(wantRight)})`);
    failures++;
    return;
  }
  console.log(`  ${label}: probe is ${show(got)}, the mistake's colour, not ${show(wantRight)} — caught`);
}

revert('revert composite (body above backpack)', ['--swap-composite'], 'back',
  P.pack, E.wrong.compositeSwapped, E.back.pack);

revert('revert sort (lantern behind character)', ['--lantern-behind'], 'back',
  P.lantern, E.wrong.lanternBehind, E.back.lantern);

// ── 4. screenshots, for a human ─────────────────────────────────────────────

mkdirSync(shots, { recursive: true });
writeFileSync(join(shots, 'synthetic-back.png'), png(W, H, back.rgba));
writeFileSync(join(shots, 'synthetic-front.png'), png(W, H, front.rgba));
const preview = downscale(back.rgba, W, H, 2);
writeFileSync(join(shots, 'synthetic-preview.png'), png(preview.width, preview.height, preview.rgba));

if (failures !== 0) {
  console.error(`${RUNNER}: FAIL (${failures} assertion(s))`);
  process.exit(1);
}
console.log(
  `${RUNNER}: PASS — composite (2 probes), depth (3 probes), multi-atlas (3 pages), both revert tests`,
);
