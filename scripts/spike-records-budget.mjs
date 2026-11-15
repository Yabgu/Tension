#!/usr/bin/env node
// scripts/spike-records-budget.mjs — how many records does a tiled scene cost?
//
// This is the gate `docs/spikes/records-budget.md` reports. The nested-guest
// work (one wasm guest compiling and running another inside its own viewport)
// forwards the inner frame as *records*, so the plan's central budget claim is
// "a real 2D scene fits beside the editor's chrome". That claim is a
// measurement, not an estimate, and this is the probe that makes it.
//
// The subject is `examples/2d/isometric`, because its scene table is generated
// from art and its frame is written record by record. A 6x6 ground measures
// nothing (40 records), so the grid is a build-script argument:
//
//   node examples/2d/isometric/build.mjs --cols 40 --rows 60 \
//        --canvas 640x960 --origin 0,0
//
// Nothing about the example changes: `scene.generated.ts` carries the grid, the
// guest loops over it, and the probe pixels are computed by the build.
//
// What is measured:
//
//   records/frame   `RECORD_COUNT` from the generated table, and the count the
//                   guest actually submits (the two are the same number by
//                   construction — the guest sizes its buffer from it).
//   accepted        `gfx.submit` returns the count, or the frame was refused
//                   whole (`render2d/device.rs` refuses a submit that would
//                   take the staged total past 4096).
//   painted         every ground cell's centre pixel is non-black, read out of
//                   the guest's own frame bytes. A record that was counted but
//                   never drawn would pass every other check here.
//
// Usage: node scripts/spike-records-budget.mjs [--cols 40] [--rows 60]
//                                               [--canvas 640x960] [--keep]
//
// SPDX-License-Identifier: MIT

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'spike-records';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(repo, 'examples', '2d', 'isometric');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const at = argv.indexOf(name);
  return at < 0 ? fallback : argv[at + 1];
}
const COLS = Number(opt('--cols', 40));
const ROWS = Number(opt('--rows', 60));
const CANVAS = opt('--canvas', '640x960');
const ORIGIN = opt('--origin', '0,0');
const [CW, CH] = CANVAS.split('x').map(Number);

function step(what, command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) die(`${what}: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    die(`${what} exited ${result.status}`);
  }
  return result;
}

// ── 1. regenerate the scene at this grid ────────────────────────────────────
step('build.mjs',
  process.execPath,
  [join(example, 'build.mjs'), '--cols', String(COLS), '--rows', String(ROWS),
   '--canvas', CANVAS, '--origin', ORIGIN],
  example);

const generated = readFileSync(join(example, 'src', 'scene.generated.ts'), 'utf8');
const declared = Number(/export const RECORD_COUNT: i32 = (\d+);/.exec(generated)[1]);
const groundCells = COLS * ROWS;

// ── 2. the guest, and the pak it reads its pages from ───────────────────────
step('build-2d-guest.mjs', process.execPath,
  [join(repo, 'scripts', 'build-2d-guest.mjs'), '--example', example], repo);
step('pack-example.mjs', process.execPath,
  [join(repo, 'scripts', 'pack-example.mjs'), '.'], example);

const core = ['release', 'debug']
  .map((profile) => join(repo, 'tension-core', 'target', profile, 'tension-core'))
  .find((candidate) => existsSync(candidate));
if (!core) die('no tension-core binary; run `cargo build --manifest-path tension-core/Cargo.toml`');
const pak = join(example, 'build', 'isometric.tns');
if (!existsSync(pak)) die(`expected ${pak} after packing`);

// ── 3. run it offscreen ─────────────────────────────────────────────────────
// Offscreen because the point is the record stream, not the window: the same
// frame bytes come back through `screenshot`, which is what the pixel check
// below reads.
const run = spawnSync(core, [
  '--res', pak, join(example, 'build', 'game.wasm'),
], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024, // two frames of 640x960x4, hex-encoded
  env: { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
});
if (run.error) die(`tension-core: ${run.error.message}`);
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (run.status !== 0) {
  process.stderr.write(output.slice(0, 4000));
  die(`tension-core exited ${run.status}`);
}
if (/^FAIL:/m.test(output)) {
  process.stderr.write(output.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
  die('the guest reported a failure');
}

// ── 4. read the frames back out of the guest's hex lines ────────────────────
//
// **`(y * CW + x) * 4` here is not the byte-offset antipattern.** That rule is
// about *guest* code indexing wasm memory by hand, where a raw address stands in
// for a struct that the compiler could have laid out. This indexes a Node
// `Buffer` the probe built from the guest's printed `FRAME <name> <offset> <hex>`
// lines: it decodes a text protocol, no wasm memory is reachable from here, and
// there is no guest on the other side. Framing it as a struct would invent a type
// that does not exist on this side of the process boundary.
const frames = new Map();
for (const line of (run.stdout ?? '').split('\n')) {
  const m = /^FRAME (\w+) (\d+) ([0-9a-f]*)$/.exec(line);
  if (!m) continue;
  const [, name, offset, hex] = m;
  if (!frames.has(name)) frames.set(name, []);
  frames.get(name).push({ offset: Number(offset), hex });
}
if (!frames.size) die('the guest printed no frames');

const report = [];
for (const [name, chunks] of frames) {
  chunks.sort((a, b) => a.offset - b.offset);
  const rgba = Buffer.concat(chunks.map((c) => Buffer.from(c.hex, 'hex')));
  if (rgba.length !== CW * CH * 4) die(`frame ${name}: ${rgba.length} bytes, expected ${CW * CH * 4}`);
  const at = (x, y) => (y * CW + x) * 4;   // see the note above: a text buffer, not wasm memory
  let nonBlack = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] || rgba[i + 1] || rgba[i + 2]) nonBlack++;
  }
  // Every ground cell's centre. A tile that submitted a record but never drew
  // leaves this black, which is the one failure the count alone cannot see.
  let cellsPainted = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const p = at(col * 16 + 8, row * 16 + 8);
      if (rgba[p] || rgba[p + 1] || rgba[p + 2]) cellsPainted++;
    }
  }
  report.push({ name, nonBlack, cellsPainted, bytes: rgba.length });
}

// ── 5. the framework path: Scene.dropped and Scene.commit() ────────────────
//
// The hand-written guest above proves the *renderer* accepts the frame. A
// nested guest does not write records by hand, though — it calls
// `Scene.create(w, h, capacity)` and `scene.commit(canvas, pipe)`, and the
// number that tells it it asked for too much is `Scene.dropped`
// (`assembly/2d/scene.ts:347`, incremented in `pack()` at `:673-676`).
//
// So this measures the same grid through the framework, at two capacities, to
// show both halves of the mechanism: a capacity that fits reports zero dropped
// and a full commit, and one past the renderer's 4096 clamps at the budget and
// reports the excess rather than silently truncating.
function frameworkRun(capacity, cols, rows, cw, ch) {
  const dir = join(repo, '.tmp', 'spike-scene-guest');
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'tension-spike-scene-guest', version: '0.0.0', private: true, type: 'module',
  }, null, 2));
  // hello-sprites' numbers: a guest holding one 640x960 screenshot needs more
  // than the shared config's initialMemory.
  writeFileSync(join(dir, 'asconfig.json'), JSON.stringify({
    options: {
      runtime: 'incremental', target: 'release', optimizeLevel: 2, importMemory: true,
      memoryBase: 8388608, initialMemory: 200, maximumMemory: 512,
      exportTable: true, exportStart: '__start',
    },
  }, null, 2));
  const modules = join(dir, 'node_modules');
  mkdirSync(modules, { recursive: true });
  const link = join(modules, 'tension-framework');
  if (!existsSync(link)) symlinkSync(join(repo, 'tension-framework'), link, 'dir');

  writeFileSync(join(src, 'main.ts'), `// Generated by scripts/spike-records-budget.mjs — do not edit.
//
// The framework path at one grid: Scene.create with an explicit capacity, then
// commit. Prints the two numbers the gate names.
import {
  Bytes, Canvas, ConfigBuilder, Frame, Pixels, print, RuntimeSession, Scene,
} from "tension-framework";
import { DEFAULT_2D_BLOB } from "./graph.generated";

const COLS: i32 = ${cols};
const ROWS: i32 = ${rows};
const CAPACITY: i32 = ${capacity};
const CW: i32 = ${cw};
const CH: i32 = ${ch};
const CELL: i32 = 16;

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("SPIKE FAIL: the session did not open");
    return;
  }
  const canvas = Canvas.open(CW, CH);
  if (!canvas.isValid()) {
    print("SPIKE FAIL: open -> " + canvas.lastError().toString());
    return;
  }
  const pipe = canvas.pipelineGraph(Bytes.ofArray(DEFAULT_2D_BLOB));
  if (pipe < 1) {
    print("SPIKE FAIL: set_pipeline -> " + pipe.toString());
    canvas.close();
    return;
  }
  // The page comes out of the pak through the framework's one-call path, not
  // through a file read plus a byte wrapper: loadTextureFromRes reads the file,
  // hands the bytes to texture_load, and frees them -- the four steps every
  // example used to get right by hand (assembly/2d/canvas.ts:361-364). It keeps
  // this probe's guest free of any pointer the SDK does not own.
  //
  // (No backticks in this block: it is emitted inside a JS template literal,
  // and one would end the literal rather than survive into the guest source.)
  const tex = canvas.loadTextureFromRes("textures/tileset_p0.iwi");
  if (tex <= 0 || canvas.bindTexture(pipe, 0, tex) != 0) {
    print("SPIKE FAIL: texture " + tex.toString());
    canvas.close();
    return;
  }

  const scene = Scene.create(CW, CH, CAPACITY);
  const frame = new Frame(0, 0, 0, <u16>CELL, <u16>CELL);
  for (let row: i32 = 0; row < ROWS; row++) {
    for (let col: i32 = 0; col < COLS; col++) {
      const sprite = scene.spawn(frame);
      if (sprite.isValid()) sprite.moveTo(<f32>(col * CELL), <f32>(row * CELL));
    }
  }

  const accepted = scene.commit(canvas, pipe);
  print(
    "SPIKE capacity=" + CAPACITY.toString() +
      " cells=" + (COLS * ROWS).toString() +
      " live=" + scene.aliveCount().toString() +
      " accepted=" + accepted.toString() +
      " dropped=" + scene.dropped.toString(),
  );

  if (canvas.present() != 0) {
    print("SPIKE FAIL: present");
    canvas.close();
    return;
  }
  const shot = Pixels.create(CW, CH);
  if (canvas.screenshot(shot) != CW * CH * 4) {
    print("SPIKE FAIL: screenshot");
    canvas.close();
    return;
  }
  let painted: i32 = 0;
  for (let row: i32 = 0; row < ROWS; row++) {
    for (let col: i32 = 0; col < COLS; col++) {
      const cx: i32 = col * CELL + CELL / 2;
      const cy: i32 = row * CELL + CELL / 2;
      const r = shot.channelAt(cx, cy, 0);
      const g = shot.channelAt(cx, cy, 1);
      const b = shot.channelAt(cx, cy, 2);
      if (r != 0 || g != 0 || b != 0) painted++;
    }
  }
  print("SPIKE painted=" + painted.toString() + " nonblack=" + shot.nonBlack().toString());
  canvas.close();
}
`);

  const built = spawnSync(process.execPath,
    [join(repo, 'scripts', 'build-2d-guest.mjs'), '--example', dir],
    { cwd: repo, encoding: 'utf8' });
  if (built.status !== 0) {
    process.stderr.write(`${built.stdout ?? ''}${built.stderr ?? ''}`.slice(-2000));
    die(`the framework guest did not build (exit ${built.status})`);
  }
  const scene = spawnSync(core, [
    '--res', pak, join(dir, 'build', 'game.wasm'),
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SDL_VIDEODRIVER: 'offscreen' },
  });
  const text = `${scene.stdout ?? ''}${scene.stderr ?? ''}`;
  if (scene.status !== 0) {
    process.stderr.write(text.slice(-2000));
    die(`the framework guest exited ${scene.status}`);
  }
  const line = /^SPIKE capacity=.*$/m.exec(text);
  const paint = /^SPIKE painted=.*$/m.exec(text);
  if (!line) {
    process.stderr.write(text.slice(-2000));
    die('the framework guest printed no SPIKE line');
  }
  return { line: line[0], paint: paint ? paint[0] : 'SPIKE painted=(missing)' };
}

// One that fits, and one deliberately past the renderer's 4096 *and* on a
// canvas large enough to show it — `pack()` culls before it counts, so an
// off-screen sprite is neither drawn nor `dropped`, and a small canvas would
// hide the clamp behind the cull.
const fits = frameworkRun(groundCells, COLS, ROWS, CW, CH);
const clamped = frameworkRun(5041, 71, 71, 71 * 16, 71 * 16);

// ── 6. the table ────────────────────────────────────────────────────────────
const submitLine = (output.match(/^canvas .*$/m) ?? [''])[0];

console.log(`${RUNNER}: ${COLS}x${ROWS} = ${groundCells} ground cells on ${CANVAS}`);
console.log(`${RUNNER}: ${submitLine.trim()}`);
console.log(`${RUNNER}: records/frame ${declared} (guest buffer sized from RECORD_COUNT, submit accepted all)`);
console.log(`${RUNNER}: canvas px ${CW * CH}, covered by ${groundCells} cells of 16x16 = ${groundCells * 256}`);
for (const f of report) {
  console.log(
    `${RUNNER}: frame ${f.name}: non-black ${f.nonBlack} px, ` +
    `ground cells painted ${f.cellsPainted}/${groundCells}`,
  );
}
// The framework path, which is what a nested guest calls.
console.log(`${RUNNER}: framework ${fits.line.replace('SPIKE ', '')}`);
console.log(`${RUNNER}: framework ${fits.paint.replace('SPIKE ', '')}`);
console.log(`${RUNNER}: framework ${clamped.line.replace('SPIKE ', '')}`);
const worst = report.reduce((a, b) => (a.cellsPainted <= b.cellsPainted ? a : b));
// The gate's own criteria, read off the framework line rather than inferred.
const fit = Object.fromEntries(
  fits.line.replace('SPIKE ', '').split(' ').map((kv) => kv.split('=')),
);
const paintCount = Number(/painted=(\d+)/.exec(fits.paint)?.[1] ?? -1);
const go =
  worst.cellsPainted === groundCells &&
  Number(fit.dropped) === 0 &&
  Number(fit.accepted) === groundCells &&
  paintCount === groundCells;
console.log(
  `${RUNNER}: result ${go ? 'GO' : 'NO-GO'} — ` +
  `${declared} records staged, ${worst.cellsPainted}/${groundCells} cells painted, ` +
  `dropped ${fit.dropped}, commit ${fit.accepted}/${groundCells}`,
);
process.exit(go ? 0 : 1);
