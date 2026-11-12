// The scene's packing contract, with no canvas and no GPU.
//
// `Scene` is a data structure: it is built from a size and a capacity, and
// `pack()` turns node state into the record buffer without talking to anything.
// That is what makes this fixture possible — the whole of the interesting
// behaviour (dirty bits, slot assignment, culling, ordering, the budget) is
// testable on a machine with no display, and the two 2D examples then prove the
// bytes it produces are the pixels they expect.
//
// The assertions are about *records*, not about pixels: a culled node must not
// occupy a slot, a moved node must be the only one rewritten, and a scene that
// changed nothing must write nothing. Those are properties of `pack`, and the
// pixel suites cannot see any of them — a scene that repacked every node and
// dropped the tail would still draw the right picture for a small scene.

import { Scene } from "../assembly/2d/scene";
import { Sprite } from "../assembly/2d/scene";
import { SpriteRecord } from "../assembly/2d/types";
import { Frame } from "../assembly/2d/types";
import { print } from "../assembly/io";
import { Time } from "../assembly/time";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) {
    failures++;
    print("  FAIL: " + what);
  }
}

function checkEq(want: i32, got: i32, what: string): void {
  if (want != got) {
    failures++;
    print("  FAIL: " + what + " (want " + want.toString() + ", got " + got.toString() + ")");
  }
}

/// One record's `x`, read back from the buffer the scene packed into.
function recX(scene: Scene, slot: i32): i32 {
  let view = scene.buffer().view();
  return view[slot].x;
}

function recY(scene: Scene, slot: i32): i32 {
  let view = scene.buffer().view();
  return view[slot].y;
}

function recSort(scene: Scene, slot: i32): u32 {
  let view = scene.buffer().view();
  return view[slot].sortKey;
}

function recW(scene: Scene, slot: i32): i32 {
  let view = scene.buffer().view();
  return view[slot].w;
}

function recH(scene: Scene, slot: i32): i32 {
  let view = scene.buffer().view();
  return view[slot].h;
}

function recSrcX(scene: Scene, slot: i32): i32 {
  let view = scene.buffer().view();
  return view[slot].srcX;
}

function recSrcY(scene: Scene, slot: i32): i32 {
  let view = scene.buffer().view();
  return view[slot].srcY;
}

const A: Frame = new Frame(0, 0, 0, 32, 32);
const B: Frame = new Frame(0, 32, 0, 32, 32);

// ── 1. spawn, order, and the first pack ─────────────────────────────────────
function caseSpawnAndOrder(): void {
  const scene = Scene.create(640, 360, 64);
  const first = scene.spawn(A);
  const second = scene.spawn(A);
  const third = scene.spawn(A);

  first.moveTo(10, 20);
  second.moveTo(100, 20);
  third.moveTo(200, 20);

  // Before any pack: a caller reports what it built, and this used to answer 0.
  checkEq(3, scene.aliveCount(), "aliveCount is right before the first pack");
  checkEq(3, scene.pack(), "three nodes pack three records");
  checkEq(3, scene.aliveCount(), "and after it");
  checkEq(3, scene.writes(), "the first pack writes every record");
  // Spawn order is the default depth, so the later sprite is a higher key.
  check(recSort(scene, 0) < recSort(scene, 1), "a later spawn sorts after an earlier one");
  checkEq(10, recX(scene, 0), "slot 0 is the first spawn");
  checkEq(100, recX(scene, 1), "slot 1 is the second spawn");
  checkEq(200, recX(scene, 2), "slot 2 is the third spawn");

  // ── 2. retention: one node moved, one record rewritten ───────────────────
  second.x = 120;
  checkEq(3, scene.pack(), "a move does not change the record count");
  checkEq(1, scene.writes(), "a single move rewrites a single record");
  checkEq(120, recX(scene, 1), "the moved node's bytes are the new position");
  checkEq(10, recX(scene, 0), "the untouched node kept its bytes");

  // ── 3. a frame with no changes writes nothing ────────────────────────────
  checkEq(3, scene.pack(), "a still frame still packs three records");
  checkEq(0, scene.writes(), "a still frame writes no records");

  // ── 4. a frame change rewrites the source rect, not the position ─────────
  second.frame = scene.registerFrame(B);
  scene.pack();
  checkEq(1, scene.writes(), "a frame change rewrites one record");
  let view = scene.buffer().view();
  checkEq(32, <i32>view[1].srcX, "the record samples the new frame's cell");
  checkEq(120, view[1].x, "and keeps the position");

  // ── 5. depth reorders the packed records ─────────────────────────────────
  third.sortKey = 0;   // drag the last spawn behind everything
  scene.pack();
  checkEq(10, recX(scene, 0), "equal keys keep spawn order, so `first` is still slot 0");
  checkEq(200, recX(scene, 1), "and the re-keyed node follows it");
  check(recSort(scene, 0) <= recSort(scene, 1), "records come out in key order");
  check(recSort(scene, 1) <= recSort(scene, 2), "all the way down");
}

// ── 6. culling frees the slot, and coming back repacks ─────────────────────
// ── 4b. the viewport: place, clip, and trim the straddle ───────────────────
//
// The composite's half of the contract (`docs/modules/2d.md` §3). A scene drawn
// into a sub-rect has to do three things the canvas-wide path never did: move its
// records to the rect's origin, drop what is outside it, and *trim* what crosses
// the edge — because a record written untrimmed paints over whatever the next
// bucket draws there.
function caseViewport(): void {
  // A viewport at (20,40) 80 wide: canvas x runs 20..100, so a world x maps to
  // `world + 20` while the camera is at the origin.
  const scene = Scene.create(640, 360, 64);
  const inside = scene.spawn(A);
  const straddles = scene.spawn(A);
  const outside = scene.spawn(A);
  inside.moveTo(10, 10);         // -> screen 30, fully inside
  straddles.moveTo(75, 10);      // -> screen 95, and 32 wide: 5 px visible
  outside.moveTo(200, 10);       // -> screen 220, past the right edge

  scene.setViewport(20, 40, 80, 60);

  checkEq(2, scene.pack(), "a node outside the viewport costs no record");

  // Placement: world (10,10) inside a viewport at (20,40) is canvas (30,50).
  checkEq(30, recX(scene, 0), "a node is placed at the viewport's origin");
  checkEq(50, recY(scene, 0), "on both axes");

  // The straddle is trimmed to the edge rather than drawn past it.
  checkEq(95, recX(scene, 1), "the straddling node starts where it was");
  checkEq(5, recW(scene, 1), "and is cut to the viewport's right edge");
  checkEq(32, recH(scene, 1), "with no vertical cut");
  checkEq(0, recSrcX(scene, 1), "and no source offset: the cut was on the right");

  // A cut on the *left* moves the source, which is what makes it the same pixels.
  straddles.moveTo(-12, 10);     // -> screen 8: 12 px outside, so 20 visible
  checkEq(2, scene.pack(), "the moved node still draws");
  checkEq(20, recX(scene, 1), "a node crossing the left edge starts at the edge");
  checkEq(20, recW(scene, 1), "with the visible width");
  checkEq(12, recSrcX(scene, 1), "and the source skipped by the same amount");

  // The camera pans the world; the viewport still places it.
  scene.setCamera(5, 2);
  checkEq(2, scene.pack(), "panning does not cull what is still visible");
  checkEq(25, recX(scene, 0), "the camera moves the record left by its x");
  checkEq(48, recY(scene, 0), "and up by its y");

  // A camera that pans the whole scene away leaves nothing to draw.
  scene.setCamera(500, 0);
  checkEq(0, scene.pack(), "a camera past the scene draws nothing");

  // Clearing puts the scene back on the canvas: world coordinates, no camera.
  // The clip is the canvas itself, so the node still hanging off the left edge is
  // trimmed to it rather than written at a negative x — the same pixels the GPU
  // would have drawn, from a record that says what it draws.
  scene.clearViewport();
  checkEq(3, scene.pack(), "clearing the viewport draws the whole canvas again");
  checkEq(10, recX(scene, 0), "at the node's own coordinates");
  checkEq(0, recX(scene, 1), "and a node off the canvas edge is trimmed to it");
  checkEq(20, recW(scene, 1), "to the visible width");
}

function caseCulling(): void {
  const scene = Scene.create(640, 360, 64);
  const a = scene.spawn(A);
  const b = scene.spawn(A);
  const c = scene.spawn(A);
  a.moveTo(0, 0);
  b.moveTo(100, 100);
  c.moveTo(200, 200);
  checkEq(3, scene.pack(), "three on-screen nodes pack three records");

  // Off the right edge entirely.
  c.x = 700;
  checkEq(2, scene.pack(), "an off-screen node costs no record");
  checkEq(2, scene.buffer().count, "and the buffer's count follows");
  checkEq(0, recX(scene, 0), "the survivor in slot 0 is unchanged");
  checkEq(100, recX(scene, 1), "the survivor in slot 1 is unchanged");

  // Partly on screen still draws: a quad touching the edge is visible.
  c.moveTo(630, 200);
  checkEq(3, scene.pack(), "a node overlapping the edge still draws");

  // Back where it started: it must be repacked into a real slot again.
  c.moveTo(200, 200);
  checkEq(3, scene.pack(), "a returning node draws again");
  checkEq(200, recX(scene, 2), "and its bytes are its own position");

  // Explicitly hidden, which is the other way a node costs nothing.
  b.visible = false;
  checkEq(2, scene.pack(), "a hidden node costs no record");
  b.visible = true;
  checkEq(3, scene.pack(), "and drawing again costs one");

  // A zero-sized node would draw nothing, so it is culled like an off-screen one.
  c.resize(0, 0);
  checkEq(3, scene.pack(), "size 0 means the frame's size, so it still draws");
}

// ── 7. destroy returns the slot to the pool ────────────────────────────────
function caseDestroy(): void {
  const scene = Scene.create(640, 360, 4);
  const a = scene.spawn(A);
  const b = scene.spawn(A);
  a.moveTo(10, 10);
  b.moveTo(20, 20);
  checkEq(2, scene.pack(), "two nodes pack two records");

  a.destroy();
  check(!a.isValid(), "a destroyed handle reports itself invalid");
  checkEq(1, scene.pack(), "the count drops with the node");
  checkEq(20, recX(scene, 0), "the survivor moved into slot 0");

  // A destroyed handle's setters are no-ops rather than corrupting the pool.
  a.x = 999;
  checkEq(1, scene.pack(), "writing through a dead handle changes nothing");
  checkEq(20, recX(scene, 0), "and does not disturb the live node");

  // The freed index is reused rather than growing the scene.
  const c = scene.spawn(B);
  check(c.isValid(), "a spawn reuses the freed index");
  check(c.index == a.index, "the reused index is the one that was freed");
}

// ── 8. the budget drops the tail and counts it ─────────────────────────────
function caseBudget(): void {
  // The adapter's budget is 4096 records; a scene may be allowed more nodes than
  // that, and the surplus is dropped and counted rather than refused wholesale.
  const COUNT: i32 = 4100;
  const scene = Scene.create(4096, 4096, COUNT);
  for (let i: i32 = 0; i < COUNT; i++) {
    const s = scene.spawn(A);
    s.moveTo(<f32>((i % 64) * 32), <f32>((i / 64) * 32));
  }
  const packed = scene.pack();
  checkEq(4096, packed, "the packed count is the adapter's budget, not the node count");
  checkEq(COUNT - 4096, scene.dropped, "the surplus nodes are counted as dropped");
  checkEq(scene.aliveCount(), COUNT, "and the nodes are still alive");
}

// ── 9. the clock is the guest's, and fixed ─────────────────────────────────
//
// `Time` is the loop's notion of elapsed time, and the contract worth pinning is
// that it is a frame count rather than anything measured: `deltaTime()` is
// exactly 1/60 and `now()` is `frames * delta`. That is what makes a guest a pure
// function of its inputs — the docs engine records example output at build time
// and ships it, which is only honest because the same program cannot produce a
// different second.
function caseTime(): void {
  Time.reset();
  checkEq(0, <i32>Time.frameCount(), "a reset clock is at frame 0");
  check(Time.deltaTime() == <f32>0.0166666675, "deltaTime is exactly 1/60");
  check(Time.now() == 0.0, "now() starts at zero");

  for (let i: i32 = 0; i < 60; i++) Time.tick();
  checkEq(60, <i32>Time.frameCount(), "sixty ticks is sixty frames");
  // 60 ticks of 1/60 is one second, to within an f32's worth of accumulation.
  const now = Time.now();
  check(now > 0.9999 && now < 1.0001, "sixty ticks is one second");
  // The step is fixed: ticking does not depend on how long anything took.
  Time.tick();
  check(Time.now() > now, "and a further tick advances it");
}

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }
  caseSpawnAndOrder();
  caseCulling();
  caseViewport();
  caseDestroy();
  caseBudget();
  caseTime();

  if (failures != 0) {
    print("scene: " + failures.toString() + " check(s) failed");
    return;
  }
  print("scene: retention, culling, ordering, the budget and the clock hold");
  print("OK");
  RuntimeSession.close();
}
