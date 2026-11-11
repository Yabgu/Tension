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

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }
  caseSpawnAndOrder();
  caseCulling();
  caseDestroy();
  caseBudget();

  if (failures != 0) {
    print("scene: " + failures.toString() + " check(s) failed");
    return;
  }
  print("scene: retention, culling, ordering and the budget hold");
  print("OK");
  RuntimeSession.close();
}
