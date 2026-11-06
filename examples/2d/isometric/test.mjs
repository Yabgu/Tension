#!/usr/bin/env node
// test.mjs — run the isometric scene and assert what it proves.
//
// Four claims, each with a pixel:
//
//   1. **composite**        back-facing, the character's probe shows the
//                           backpack colour (z=2); front-facing, the body's.
//   2. **isometric depth**  the tree crown's pixel shows the *character*, so the
//                           character sorts above the crown slice; the lantern's
//                           pixel shows the lantern, so it sorts above the
//                           character.
//   3. **multi-atlas**      three probes, three pages, one frame.
//   4. **the sort is real** the two revert runs ask for a deliberately wrong z
//                           assignment and a deliberately wrong sort key; both
//                           must *fail* the assertion they are aimed at, or the
//                           assertion was never testing anything.
//
// The expected colours come from `scene.json`, which `build.mjs` writes from
// the source art. Nothing here restates a colour by hand, and nothing reads the
// guest's own "expected" line — a guest that computes its expectation from the
// same table that drew the frame would pass while drawing anything.
//
// Exit codes: 0 pass, 1 fail, 77 skip (assets not present).

import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'isometric';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const assets = join(repo, 'tension-2d', 'test-assets');
const shotsDir = join(assets, 'screenshots');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: here, ...opts });
  if (result.error) return null;
  return result;
}

// ── 0. the assets ───────────────────────────────────────────────────────────
const NEEDED = [
  join(assets, 'modernexteriors', 'Modern_Exteriors_Complete_Tileset.png'),
  join(assets, 'characters', 'Bodies', 'Body_01.png'),
];
for (const path of NEEDED) {
  if (existsSync(path)) continue;
  console.error(
    `${RUNNER}: SKIP — the test assets are not here.\n` +
    `  They are third-party art and are not committed. Place them under\n` +
    `  tension-2d/test-assets/modernexteriors/ and .../characters/ by hand.\n` +
    `  For a run with no external assets, use \`npm run test:ci\`.`,
  );
  process.exit(77);
}

// ── 1. build ────────────────────────────────────────────────────────────────
let step = run('node', [join(here, 'build.mjs')], { stdio: 'inherit' });
if (!step || step.status !== 0) die('build.mjs failed');

step = run('node', [join(repo, 'scripts', 'build-2d-guest.mjs')], { stdio: 'inherit' });
if (!step || step.status !== 0) die('the guest did not build');

const dso = join(repo, 'tension-2d', 'build', 'libtension_2d.so');
if (!existsSync(dso)) {
  step = run('node', [join(repo, 'scripts', 'build-2d.mjs')], { stdio: 'inherit', cwd: repo });
  if (!step || step.status !== 0) die('the adapter did not build');
}
const core = join(repo, 'tension-core', 'target', 'debug', 'tension-core');
if (!existsSync(core)) die(`no ${core}\n  Run \`cargo build --manifest-path tension-core/Cargo.toml\`.`);

// ── 2. pack the pages into a resource pak ───────────────────────────────────
// 12 MB of IWI does not belong in the guest's data segment; the pak is what the
// `tension::res` reader exists for, and `ResFile.readAll()` is how the guest
// gets a pointer it can hand to `texture_load`.
step = run('node', [join(repo, 'scripts', 'pack-example.mjs'), '.'], { stdio: 'inherit' });
if (!step || step.status !== 0) die('packing the resource tree failed');
const pak = join(here, 'build', 'isometric.tns');
if (!existsSync(pak)) die(`expected ${pak} after packing`);

const scene = JSON.parse(readFileSync(join(here, 'scene.json'), 'utf8'));

// ── 3. run the guest ────────────────────────────────────────────────────────

function runScene(guestArgs) {
  const result = run(core, [
    '--capability', dso,
    '--res', pak,
    join(here, 'build', 'game.wasm'),
    ...guestArgs,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
  });
  if (!result) die('could not start tension-core');

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const frames = new Map();
  for (const line of (result.stdout ?? '').split('\n')) {
    const m = line.match(/^FRAME (\w+) (\d+) ([0-9a-f]*)$/);
    if (!m) continue;
    const [, name, offset, hex] = m;
    if (!frames.has(name)) frames.set(name, { chunks: [], seen: 0, bytes: 0 });
    const frame = frames.get(name);
    frame.chunks.push({ offset: Number(offset), hex });
  }
  for (const [name, frame] of frames) {
    frame.chunks.sort((a, b) => a.offset - b.offset);
    frame.rgba = Buffer.concat(frame.chunks.map((c) => Buffer.from(c.hex, 'hex')));
  }
  return { status: result.status, output, frames };
}

const normal = runScene([]);
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

const W = scene.canvas.w;
const H = scene.canvas.h;
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

const back = normal.frames.get('back');
const front = normal.frames.get('front');
if (!back || !front) die('the guest printed no frames');
for (const [name, frame] of [['back', back], ['front', front]]) {
  if (frame.rgba.length !== W * H * 4) {
    die(`frame ${name}: ${frame.rgba.length} bytes, expected ${W * H * 4}`);
  }
}

// ── 4. the assertions ───────────────────────────────────────────────────────

expectPixel(back.rgba, scene.probes.composite, scene.expect.compositeBack,
  'composite (back): the backpack is not on top');
expectPixel(front.rgba, scene.probes.composite, scene.expect.compositeFront,
  'composite (front): the body is not on top');

expectPixel(back.rgba, scene.probes.crown, scene.expect.crownBack,
  'depth: the tree crown covers the character');
expectPixel(back.rgba, scene.probes.lantern, scene.expect.lantern,
  'depth: the character covers the lantern');

// Three pages in one frame: grass from page A, the lantern from page B, the
// character (backpack layer) from page C.
expectPixel(back.rgba, scene.probes.pageA, scene.expect.pageA, 'multi-atlas: page A');
expectPixel(back.rgba, scene.probes.lantern, scene.expect.pageB, 'multi-atlas: page B');
expectPixel(back.rgba, scene.probes.composite, scene.expect.pageC, 'multi-atlas: page C');

// ── 5. the revert runs ──────────────────────────────────────────────────────
//
// Each asks the guest for a scene that is wrong in exactly one way, and asserts
// the *wrongness shows*. A revert test that passes because the assertion is
// broken is worse than no revert test, so these check for the specific colour
// the mistake produces, not merely that "something differs".

function revert(label, guestArgs, frameName, probe, wantWrong, wantRight) {
  const runResult = runScene(guestArgs);
  const frame = runResult.frames.get(frameName);
  if (!frame) {
    console.error(`  FAIL ${label}: the guest produced no ${frameName} frame`);
    failures++;
    return;
  }
  const got = pixel(frame.rgba, probe.x, probe.y);
  if (close(got, wantRight)) {
    console.error(
      `  FAIL ${label}: the probe still shows the correct colour ${show(got)} — ` +
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
  scene.probes.composite, scene.expect.compositeFront, scene.expect.compositeBack);

revert('revert sort (lantern behind character)', ['--lantern-behind'], 'back',
  scene.probes.lantern, scene.expect.lanternBehind, scene.expect.lantern);

// ── 6. screenshots ──────────────────────────────────────────────────────────

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function downscale(rgba, width, height, factor) {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const at = ((y * factor + dy) * width + x * factor + dx) * 4;
          r += rgba[at]; g += rgba[at + 1]; b += rgba[at + 2]; a += rgba[at + 3];
        }
      }
      const n = factor * factor;
      const to = (y * w + x) * 4;
      out[to] = Math.round(r / n); out[to + 1] = Math.round(g / n);
      out[to + 2] = Math.round(b / n); out[to + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

mkdirSync(shotsDir, { recursive: true });
writeFileSync(join(shotsDir, 'back.png'), png(W, H, back.rgba));
writeFileSync(join(shotsDir, 'front.png'), png(W, H, front.rgba));

// The preview is the one image that travels with the repository: a 2x2-average
// downscale of the back-facing frame on a dark background, small enough to sit
// in a README.
const preview = downscale(back.rgba, W, H, 2);
writeFileSync(join(shotsDir, 'preview.png'), png(preview.width, preview.height, preview.rgba));
console.log(`${RUNNER}: wrote ${join(shotsDir, 'back.png')}, front.png, preview.png`);

if (failures !== 0) {
  console.error(`${RUNNER}: FAIL (${failures} assertion(s))`);
  process.exit(1);
}
console.log(
  `${RUNNER}: PASS — composite, depth, multi-atlas, and both revert tests`,
);
