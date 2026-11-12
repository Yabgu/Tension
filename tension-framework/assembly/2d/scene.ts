// tension-framework/assembly/2d/scene.ts — nodes you mutate, records you do not.
//
// ## The shape
//
// ```ts
// const scene = Scene.create(640, 360, 64);   // canvas size, then node capacity
// const hero = scene.spawn(heroFrame);        // -> Sprite, a handle
// hero.x += 10;                               // marks one node dirty
// scene.commit(canvas, pipe);                 // packs and submits
// canvas.present();
// ```
//
// A `Sprite` holds `(scene, index)` and nothing else. Every setter writes one
// array slot and sets a dirty bit; there is no per-node object to allocate, so a
// thousand sprites cost a thousand floats and no garbage. Two handles for one
// index alias each other, which is the same contract `physics.Body` already has.
//
// ## What the dirty bits are for, measured rather than assumed
//
// **They do not reduce wire traffic.** The adapter clears its staging on
// `present` (`render2d/device.rs`: "then clear the staging state"), so every
// frame submits the whole record set and the host copies all of it. Retained mode
// on the wire would be a new verb, which is an ABI change and not this pass.
//
// What they buy is that **the out buffer is the cache**. This class does not
// rebuild its records: the `RecordBuffer` keeps last frame's bytes, and a node
// that did not move keeps its slot and its bytes. So a frame where nothing moved
// writes **zero records** and still submits a complete set — and a frame where
// ten of a thousand nodes moved writes ten. `pack()` is the whole of that logic.
//
// The alternative is what the examples did before: rewrite every record every
// frame, because nothing knew which ones were already right.
//
// ## Ordering is the adapter's
//
// The host sorts each bucket by `(sort_key, group_id, z)` with a stable sort
// (`render2d/device.rs:583`: "`sort_by` is stable, which is what makes a frame
// reproducible: equal keys keep submission order"). So this class does not sort
// records — it sorts *nodes* by `(sortKey, spawn order)` and writes them in that
// order, which is the only thing it can do that the adapter cannot: fix the
// tie-break. A sprite spawned later draws on top of one spawned earlier, by
// default, because that is what a DOM does.
//
// The sort is only recomputed when `sortKey`, `z` or `groupId` changes — the
// `ORDER` bit. A scene that moves sprites around never pays for it.
//
// ## Culling is a slot decision
//
// A node outside the canvas gets no slot, so it costs no record. Its *slot* is
// recomputed every pack, and a node whose slot changed is repacked — that is the
// one thing that makes culling interact with retention, and it is handled in one
// place (`assignSlot`).
//
// ## One bucket
//
// Every node submits to bucket 0. A bucket is one draw call and one pipeline
// (`tension_2d.h:161-170`), so buckets separate *pipelines*, not depth — and a
// scene has one pipeline. Depth is `sortKey`/`z`, which the adapter sorts on.
// The `layer` idea from the design review is deferred with the second pipeline.

import { Canvas } from "./canvas";
import { Frame, RECORD_SIZE } from "./types";
import { RecordBuffer } from "./buffers";
import { print } from "../io";
import * as platform from "../platform";
import { rt } from "../runtime/rt";
import { RuntimeSession } from "../runtime";
import { Time } from "../time";
import { __taskBindTable } from "~lib/task-rt";

// ── the adopted loop's exports ──────────────────────────────────────────────
//
// The host drives a guest only when the guest exports *both* `__taskWake` and
// `_game_running`, and refuses half an adoption at load (`main.rs:1905-1925`):
// a guest with the wake and no running-flag exits 0 having done nothing, which
// reads as success. `_game_running` is the one this module can define.
//
// **`__taskWake` cannot be provided from here**, and that is a property of the
// toolchain rather than a choice: only the *entry module's* exports reach the
// wasm export section, so a framework re-export is invisible to the host. This
// was measured, not assumed — a guest whose `main.ts` imports `Scene` and does
// nothing else exports `_start_game` alone:
//
//     import { Scene } ...                     -> [_start_game]
//     export { __taskWake, … } from "tension-framework"   -> [_start_game, __taskWake,
//                                                  __taskResume, __taskFail, _game_running]   +1.5 KB
//     export * from "tension-framework"         -> the same, +63 KB (no DCE)
//
// So a guest adopting the loop writes one line, and it is the line that *is* the
// adoption:
//
//     export { __taskWake, __taskResume, __taskFail, _game_running } from "tension-framework";
//
// `export *` also works and was rejected: 63 KB of the framework that no game
// calls, retained because an exported symbol is a reason to keep it.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

/** 1 while the guest wants the host to drive it; 0 once the loop has ended. */
export function _game_running(): i32 {
  return loopRunning ? 1 : 0;
}

/** How many tasks may park at once — the loop uses one, with room for a load. */
const TASK_SLOTS: i32 = 8;

/** Read by `_game_running`. Set by `run`, cleared before `run` returns. */
let loopRunning: bool = false;
/** Frames the last `run` presented, and why it stopped. */
let loopFrames: i32 = 0;
let loopStopReason: string = "the loop never started";

/**
 * Frames the current (or last) `run` presented.
 *
 * Read after the loop ends, or from inside it — this is the guest's own count,
 * and `Time.frameCount()` is the same number when nothing else ticks the clock.
 */
export function loopFrameCount(): i32 {
  return loopFrames;
}

/** Why the last `run` stopped: a budget, the window, or a refused verb. */
export function loopReason(): string {
  return loopStopReason;
}

/**
 * The guest's per-frame update, as the loop calls it.
 *
 * An interface rather than a function parameter because a closure over a stack
 * local cannot be called on this toolchain — `Scene.run`'s doc comment carries
 * the four-shape measurement. A class method dispatches through a table entry
 * the class installs at definition, which is the one shape that works.
 */
export interface FrameStep {
  /** Called once per frame, before the scene commits. */
  step(): void;
}

/** Position or size changed: the record's rect is stale. */
export const DIRTY_TRANSFORM: u8 = 1;
/** The frame slot changed: the source rect is stale. */
export const DIRTY_FRAME: u8 = 2;
/** `sortKey`, `groupId` or `z` changed: the node order has to be rebuilt. */
export const DIRTY_ORDER: u8 = 4;

/** Every bit, for "this node's bytes are entirely stale". */
const DIRTY_ALL: u8 = DIRTY_TRANSFORM | DIRTY_FRAME | DIRTY_ORDER;

/**
 * The adapter's record budget, summed across every bucket
 * (`render2d/device.rs:52`, `MAX_RECORDS`). A submit that would exceed it is
 * refused **whole**, not truncated, which is why the scene caps itself here
 * rather than finding out at `present`.
 */
const RECORD_BUDGET: i32 = 4096;

/**
 * One node's handle.
 *
 * Created by `Scene.spawn` and never by a constructor — a `Sprite` whose index
 * the scene did not hand out is a handle to a slot that may be a different node
 * by now, and `isValid()` is the check that catches a stale one.
 */
export class Sprite {
  /** The scene this indexes into. Not nullable: a handle is born owned. */
  scene: Scene;
  /** The slot. Stable until `destroy`; -1 for a destroyed handle. */
  index: i32;

  constructor(scene: Scene, index: i32) {
    this.scene = scene;
    this.index = index;
  }

  /** Whether this handle still names a live node. */
  isValid(): bool {
    return this.index >= 0 && this.scene.isAlive(this.index);
  }

  // --- position ------------------------------------------------------------
  //
  // Floats, rounded once at pack time rather than at every assignment: a sprite
  // that integrates `x += 0.3` under a `float`-typed field would stall at its
  // first sub-pixel step, and the record's i32 is where the pixel boundary
  // belongs — not in the game's own arithmetic.

  get x(): f32 { return this.scene.xOf(this.index); }
  set x(value: f32) { this.scene.setX(this.index, value); }

  get y(): f32 { return this.scene.yOf(this.index); }
  set y(value: f32) { this.scene.setY(this.index, value); }

  /** Move, in one call — one dirty test instead of two. */
  moveTo(x: f32, y: f32): void {
    this.scene.setX(this.index, x);
    this.scene.setY(this.index, y);
  }

  /** Move by a delta, for a game loop that integrates a velocity. */
  moveBy(dx: f32, dy: f32): void {
    this.scene.setX(this.index, this.scene.xOf(this.index) + dx);
    this.scene.setY(this.index, this.scene.yOf(this.index) + dy);
  }

  // --- size ----------------------------------------------------------------
  //
  // 0 means "whatever the frame says", so a sprite that only scales up does not
  // have to know its art's size. A clipped glyph, or a stretched panel, sets one.

  get w(): i32 { return this.scene.wOf(this.index); }
  set w(value: i32) { this.scene.setW(this.index, value); }

  get h(): i32 { return this.scene.hOf(this.index); }
  set h(value: i32) { this.scene.setH(this.index, value); }

  /** Set both in one call. */
  resize(w: i32, h: i32): void {
    this.scene.setW(this.index, w);
    this.scene.setH(this.index, h);
  }

  // --- the frame -----------------------------------------------------------

  /** The frame *slot*, from `Scene.registerFrame`. */
  get frame(): i32 { return this.scene.frameOfNode(this.index); }
  set frame(slot: i32) { this.scene.setFrame(this.index, slot); }

  // --- depth and grouping --------------------------------------------------

  /** Draw order, ascending. Ties keep spawn order. */
  get sortKey(): u32 { return this.scene.sortKeyOf(this.index); }
  set sortKey(value: u32) { this.scene.setSortKey(this.index, value); }

  /** The adapter's grouping key; ties within a `sortKey` break on it. */
  get groupId(): u16 { return this.scene.groupIdOf(this.index); }
  set groupId(value: u16) { this.scene.setGroupId(this.index, value); }

  /** The last tie-break, after `sortKey` and `groupId`. */
  get z(): u8 { return this.scene.zOf(this.index); }
  set z(value: u8) { this.scene.setZ(this.index, value); }

  // --- visibility ----------------------------------------------------------

  /**
   * Whether the node draws at all.
   *
   * Off-screen is culled automatically; this is for a node that is *deliberately*
   * not drawn, and it costs no record either way.
   */
  get visible(): bool { return this.scene.visibleOf(this.index); }
  set visible(value: bool) { this.scene.setVisible(this.index, value); }

  /** Remove the node. The handle keeps its index and stops being valid. */
  destroy(): void { this.scene.destroy(this.index); }
}

/**
 * A declarative 2D scene: nodes in fixed-size arrays, records in one buffer.
 *
 * Constructed with `Scene.create` — the null object's public constructor would
 * let a caller skip the array allocation that every method assumes.
 */
export class Scene {
  // --- geometry ------------------------------------------------------------
  /** The canvas the scene is culled against. `resize` for a window that moved. */
  width: i32;
  height: i32;

  // --- the viewport and the camera -----------------------------------------
  //
  // A scene drawn inside a sub-rectangle of the canvas — an editor's game panel,
  // a split-screen half, a minimap. Two numbers do all of it:
  //
  //   * the **viewport** is where the scene appears and what it is clipped to;
  //   * the **camera** is the world point at the viewport's top-left corner.
  //
  // So a node at world `(wx, wy)` lands on the canvas at
  // `wx - cameraX + viewportX`. With no viewport set the rectangle is the whole
  // canvas and the camera is the origin, which is why every existing caller is
  // unaffected: the arithmetic reduces to the identity.
  private viewportX: i32 = 0;
  private viewportY: i32 = 0;
  private viewportW: i32 = 0;
  private viewportH: i32 = 0;
  /** False when the scene is clipped to the canvas rather than to a sub-rect. */
  private hasViewport: bool = false;
  private cameraX: f32 = 0.0;
  private cameraY: f32 = 0.0;

  // --- node capacity -------------------------------------------------------
  capacity: i32;

  // --- storage, one array per property -------------------------------------
  //
  // Parallel arrays rather than an array of records: a setter touches one slot,
  // a pass over one property is sequential, and there is no per-node object to
  // allocate or collect. This is the `physics.Body` layout, for the same reason.
  private xs: Float32Array;
  private ys: Float32Array;
  private ws: Uint16Array;
  private hs: Uint16Array;
  /** Frame slots, from `registerFrame`. */
  private frames: Int32Array;
  private sortKeys: Uint32Array;
  private groupIds: Uint16Array;
  private zs: Uint8Array;
  private flags: Uint8Array;
  private visibles: Uint8Array;
  /** The record slot each node was last packed into, or -1 for "no record". */
  private slots: Int32Array;
  /** Spawn sequence, the stable tie-break the adapter cannot provide. */
  private seqs: Uint32Array;
  /** Node indices in draw order. Valid while `needsOrder` is false. */
  private order: Int32Array;
  private orderCount: i32 = 0;
  private needsOrder: bool = true;

  // --- lifetimes -----------------------------------------------------------
  private alives: Uint8Array;
  private freeSlots: Int32Array;
  private freeCount: i32 = 0;
  private nextSeq: u32 = 0;
  /** One past the highest index ever handed out. */
  private highWater: i32 = 0;
  /**
   * Live nodes, tracked rather than derived.
   *
   * `orderCount` is the same number *after a pack*, and it was what this
   * answered at first — which read 0 for a scene that had spawned thirty nodes
   * and not yet drawn, the state every caller is in when it wants to report what
   * it built. O(1) to keep, so keep it.
   */
  private liveCount: i32 = 0;

  // --- frames --------------------------------------------------------------
  /** The frame table: `Sprite.frame` indexes this. */
  private frameTable: Frame[] = [];

  // --- the record buffer ---------------------------------------------------
  private records: RecordBuffer;
  /** Records written into `records` by the last pack. */
  private packed: i32 = 0;
  /** How many of those the pack had to *write*, versus keep from last frame. */
  private written: i32 = 0;
  /** Visible nodes that got no slot because the budget was full. */
  dropped: i32 = 0;

  private constructor(width: i32, height: i32, capacity: i32) {
    const cap = capacity > 0 ? capacity : 0;
    this.width = width > 0 ? width : 0;
    this.height = height > 0 ? height : 0;
    this.capacity = cap;

    this.xs = new Float32Array(cap);
    this.ys = new Float32Array(cap);
    this.ws = new Uint16Array(cap);
    this.hs = new Uint16Array(cap);
    this.frames = new Int32Array(cap);
    this.sortKeys = new Uint32Array(cap);
    this.groupIds = new Uint16Array(cap);
    this.zs = new Uint8Array(cap);
    this.flags = new Uint8Array(cap);
    this.visibles = new Uint8Array(cap);
    this.slots = new Int32Array(cap);
    this.seqs = new Uint32Array(cap);
    this.order = new Int32Array(cap);
    this.alives = new Uint8Array(cap);
    this.freeSlots = new Int32Array(cap);

    // The buffer is sized to the smaller of the scene and the adapter's budget:
    // a scene allowed more nodes than the adapter can stage would pack records
    // the submit would then refuse as a whole.
    const stage = cap < RECORD_BUDGET ? cap : RECORD_BUDGET;
    this.records = RecordBuffer.create(stage);
  }

  /**
   * A scene culled against `width` x `height`, holding `capacity` nodes.
   *
   * The size is the caller's number rather than a `Canvas` because the scene is
   * a data structure: it can be built before the canvas exists, it survives a
   * canvas being reopened at a new size (`resize`), and packing is testable with
   * no GPU in the process.
   */
  static create(width: i32, height: i32, capacity: i32): Scene {
    return new Scene(width, height, capacity);
  }

  /** Re-cull against a new canvas size — a window resize, or an offscreen change. */
  resize(width: i32, height: i32): void {
    this.width = width > 0 ? width : 0;
    this.height = height > 0 ? height : 0;
  }

  /**
   * Clip the scene to a rectangle of the canvas, and place it there.
   *
   * Every record this scene emits lands inside `(x, y, w, h)`: a node outside is
   * culled, and one straddling the edge is **trimmed**, by shortening its source
   * rect — which works because a record's `w`/`h` are the destination quad *and*
   * the source texel rect, so at 1:1 the two are the same pixels (`ui/painter.ts`
   * states the same rule for glyphs).
   *
   * This is what stops a game panel bleeding into the panel beside it. Without it
   * a scene culls against the whole canvas, so a sprite at the canvas edge is
   * drawn under whatever UI sits there.
   *
   * Marking every node dirty is not laziness: a *static* node's packed bytes
   * change when the clip does, and retention would otherwise keep serving the old
   * record. It costs one pass over the nodes, once per viewport change — the
   * editor sets it on resize, not per frame.
   */
  setViewport(x: i32, y: i32, width: i32, height: i32): void {
    const nx: i32 = x;
    const ny: i32 = y;
    const nw: i32 = width > 0 ? width : 0;
    const nh: i32 = height > 0 ? height : 0;
    if (this.hasViewport && nx == this.viewportX && ny == this.viewportY &&
        nw == this.viewportW && nh == this.viewportH) {
      return;
    }
    this.viewportX = nx;
    this.viewportY = ny;
    this.viewportW = nw;
    this.viewportH = nh;
    this.hasViewport = true;
    this.markAllDirty();
  }

  /** Clip to the whole canvas again, and put the camera back at the origin. */
  clearViewport(): void {
    if (!this.hasViewport && this.cameraX == 0.0 && this.cameraY == 0.0) return;
    this.hasViewport = false;
    this.viewportX = 0;
    this.viewportY = 0;
    this.viewportW = 0;
    this.viewportH = 0;
    this.cameraX = 0.0;
    this.cameraY = 0.0;
    this.markAllDirty();
  }

  /**
   * Pan: the world point drawn at the viewport's top-left corner.
   *
   * Positive `x` moves the camera right, so the scene appears to move **left** —
   * the direction a drag on the world moves it. Scroll a level by setting this to
   * its origin; leave it at zero and the scene's own coordinates are canvas
   * coordinates plus the viewport's offset.
   */
  setCamera(x: f32, y: f32): void {
    if (this.cameraX == x && this.cameraY == y) return;
    this.cameraX = x;
    this.cameraY = y;
    this.markAllDirty();
  }

  get camX(): f32 {
    return this.cameraX;
  }

  get camY(): f32 {
    return this.cameraY;
  }

  /** The clip rectangle in canvas pixels; the canvas itself when none is set. */
  clipX(): i32 { return this.hasViewport ? this.viewportX : 0; }
  clipY(): i32 { return this.hasViewport ? this.viewportY : 0; }
  clipW(): i32 { return this.hasViewport ? this.viewportW : this.width; }
  clipH(): i32 { return this.hasViewport ? this.viewportH : this.height; }

  /** Every live node's record is stale — a clip or camera change. */
  private markAllDirty(): void {
    for (let i: i32 = 0; i < this.highWater; i++) {
      if (this.alives[i] != 0) this.flags[i] |= DIRTY_ALL;
    }
  }

  // --- frames --------------------------------------------------------------

  /**
   * Register a frame and return its slot; a frame already in the table returns
   * the slot it has.
   *
   * Deduplicated by value, because the alternative is a `Map<Frame, i32>` whose
   * key is an object — every lookup hashes a reference, and two `Frame`s with the
   * same rect are two keys. A scan over the table is exact and, at the size a
   * tileset produces (tens of entries), free: `hello-sprites` registers 4 and
   * `box-physics` 112, once, before the first frame.
   */
  registerFrame(frame: Frame): i32 {
    for (let i: i32 = 0; i < this.frameTable.length; i++) {
      const known = this.frameTable[i];
      if (known.tex == frame.tex && known.srcX == frame.srcX && known.srcY == frame.srcY &&
          known.w == frame.w && known.h == frame.h) {
        return i;
      }
    }
    this.frameTable.push(frame);
    return this.frameTable.length - 1;
  }

  /** How many distinct frames the scene knows. */
  frameCount(): i32 {
    return this.frameTable.length;
  }

  // --- spawning ------------------------------------------------------------

  /** A node drawing `frame`, on top of everything spawned before it. */
  spawn(frame: Frame): Sprite {
    return this.spawnSlot(this.registerFrame(frame));
  }

  /** A node drawing a frame slot already registered. */
  spawnSlot(slot: i32): Sprite {
    let index: i32 = -1;
    if (this.freeCount > 0) {
      this.freeCount--;
      index = this.freeSlots[this.freeCount];
    } else if (this.highWater < this.capacity) {
      index = this.highWater++;
    }
    // Full: an inert handle rather than an exception. `isValid()` is false, every
    // setter is a no-op on a dead index, and the scene does not silently grow.
    if (index < 0) return new Sprite(this, -1);

    this.alives[index] = 1;
    this.liveCount++;
    this.visibles[index] = 1;
    this.xs[index] = 0.0;
    this.ys[index] = 0.0;
    this.ws[index] = 0;
    this.hs[index] = 0;
    this.frames[index] = slot >= 0 ? slot : 0;
    this.zs[index] = 0;
    this.groupIds[index] = 0;
    this.flags[index] = DIRTY_ALL;
    this.slots[index] = -1;
    this.seqs[index] = this.nextSeq++;
    // Default depth: spawn order. A DOM draws in document order, and the
    // adapter's stable sort turns equal keys into submission order — which is
    // the order this queue is walked in.
    this.sortKeys[index] = this.seqs[index];
    this.needsOrder = true;
    return new Sprite(this, index);
  }

  /** How many nodes are alive — accurate before the first pack, too. */
  aliveCount(): i32 {
    return this.liveCount;
  }

  /** Whether `index` names a live node. */
  isAlive(index: i32): bool {
    return index >= 0 && index < this.capacity && this.alives[index] != 0;
  }

  /** Remove a node and return its slot to the pool. */
  destroy(index: i32): void {
    if (!this.isAlive(index)) return;
    this.alives[index] = 0;
    this.liveCount--;
    this.flags[index] = 0;
    this.slots[index] = -1;
    this.freeSlots[this.freeCount++] = index;
    this.needsOrder = true;
  }

  // --- mutators ------------------------------------------------------------
  //
  // One per property, called by `Sprite`'s setters. Each sets exactly the bit
  // that property invalidates; a whole-node write is `DIRTY_ALL` and is what a
  // spawn and a slot move use.

  xOf(i: i32): f32 { return this.xs[i]; }
  yOf(i: i32): f32 { return this.ys[i]; }
  wOf(i: i32): i32 { return this.ws[i]; }
  hOf(i: i32): i32 { return this.hs[i]; }
  frameOfNode(i: i32): i32 { return this.frames[i]; }
  sortKeyOf(i: i32): u32 { return this.sortKeys[i]; }
  groupIdOf(i: i32): u16 { return this.groupIds[i]; }
  zOf(i: i32): u8 { return this.zs[i]; }
  visibleOf(i: i32): bool { return this.visibles[i] != 0; }

  setX(i: i32, value: f32): void { this.xs[i] = value; this.flags[i] |= DIRTY_TRANSFORM; }
  setY(i: i32, value: f32): void { this.ys[i] = value; this.flags[i] |= DIRTY_TRANSFORM; }

  setW(i: i32, value: i32): void {
    this.ws[i] = <u16>(value > 0 ? (value > 0xFFFF ? 0xFFFF : value) : 0);
    this.flags[i] |= DIRTY_TRANSFORM;
  }

  setH(i: i32, value: i32): void {
    this.hs[i] = <u16>(value > 0 ? (value > 0xFFFF ? 0xFFFF : value) : 0);
    this.flags[i] |= DIRTY_TRANSFORM;
  }

  setFrame(i: i32, slot: i32): void {
    if (slot < 0 || slot >= this.frameTable.length) return;
    this.frames[i] = slot;
    this.flags[i] |= DIRTY_FRAME;
  }

  setSortKey(i: i32, value: u32): void {
    if (this.sortKeys[i] == value) return;
    this.sortKeys[i] = value;
    this.flags[i] |= DIRTY_ORDER;
    this.needsOrder = true;
  }

  setGroupId(i: i32, value: u16): void {
    if (this.groupIds[i] == value) return;
    this.groupIds[i] = value;
    this.flags[i] |= DIRTY_ORDER;
    this.needsOrder = true;
  }

  setZ(i: i32, value: u8): void {
    if (this.zs[i] == value) return;
    this.zs[i] = value;
    this.flags[i] |= DIRTY_ORDER;
    this.needsOrder = true;
  }

  setVisible(i: i32, value: bool): void {
    this.visibles[i] = value ? 1 : 0;
    // Visibility changes the slot assignment, so the node's bytes may have to
    // move even though nothing about it changed.
    this.flags[i] |= DIRTY_TRANSFORM;
    this.needsOrder = true;
  }

  // --- the frame's work ----------------------------------------------------

  /**
   * Pack the scene into its record buffer and return how many records it now
   * describes. `commit` is this plus a submit.
   *
   * Three things happen, in this order, and the order is what makes retention
   * correct:
   *
   * 1. **Rebuild the order** if any node's `sortKey`/`groupId`/`z` changed, or a
   *    node was spawned or destroyed. Nearly free on a frame that only moves
   *    things: `needsOrder` is false and this is skipped.
   * 2. **Assign slots.** Walk the order, skip invisible and off-screen nodes, and
   *    give each survivor the next slot. A node whose slot *moved* is marked
   *    dirty, because its bytes have to be written somewhere else — this is the
   *    one interaction between culling and retention, and it lives here.
   * 3. **Write the dirty ones.** Everything else keeps last frame's bytes in
   *    place. A frame where nothing moved writes nothing at all.
   */
  pack(): i32 {
    if (this.needsOrder) this.rebuildOrder();

    let slot: i32 = 0;
    this.dropped = 0;
    this.written = 0;
    const cap = this.records.capacity();

    for (let k: i32 = 0; k < this.orderCount; k++) {
      const i = this.order[k];
      if (this.visibles[i] == 0 || this.isCulled(i)) {
        // No record this frame. Its old slot is simply not part of `count`, so
        // nothing has to be cleared — but the node must be repacked when it
        // comes back, because its bytes were where a different node may now be.
        if (this.slots[i] >= 0) {
          this.slots[i] = -1;
          this.flags[i] |= DIRTY_ALL;
        }
        continue;
      }
      if (slot >= cap) {
        this.dropped++;
        continue;
      }
      if (this.slots[i] != slot) {
        // Moved slot: its bytes are stale wherever they are, and the node that
        // used to be here may be the one that moved away.
        this.slots[i] = slot;
        this.flags[i] |= DIRTY_ALL;
      }
      if (this.flags[i] != 0) this.writeRecord(i, slot);
      slot++;
    }

    this.packed = slot;
    this.records.setCount(slot);
    // `dropped` on the buffer counts `push` refusals, which this path does not
    // use; the scene's own counter is the one a caller reads.
    this.records.dropped = 0;
    return slot;
  }

  /**
   * Pack and hand the result to `canvas`, in `bucket` (0 by default).
   *
   * **Buckets are draw order, ascending.** Each is one draw call and one
   * pipeline, so a composite is: the game in bucket 0 with its pipeline, the UI in
   * bucket 1 with another, one `present`. That is what lets an editor draw a scene
   * under its own chrome without a second canvas, and it is why a bucket refuses a
   * second pipe (`render2d/device.rs` — a bucket that mixed two pipelines could
   * not be one draw).
   *
   * Returns the records submitted, or the verb's errno. A refusal from `submit`
   * is the adapter's — `-ENOENT` for an unknown pipe, `-ENOSPC` for a staging
   * buffer full of somebody else's records — and is passed through unchanged, for
   * the reason every other verb passes its errno through: the number is the
   * diagnosis.
   */
  commit(canvas: Canvas, pipe: i32, bucket: i32 = 0): i32 {
    const count = this.pack();
    if (count <= 0) return 0;
    return canvas.submit(pipe, this.records, bucket);
  }

  /**
   * Hand the scene to the host and drive it until the window closes.
   *
   * ```ts
   * // main.ts — the one line that is the adoption (see below).
   * export { __taskWake, __taskResume, __taskFail, _game_running } from "tension-framework";
   *
   * class Game implements FrameStep {
   *   private world: physics.World;
   *   private boxes: Sprite[];
   *
   *   step(): void {
   *     this.world.step(Time.deltaTime());
   *     for (let i = 0; i < this.boxes.length; i++) this.boxes[i].moveTo(...);
   *   }
   * }
   *
   * export function _start_game(): void {
   *   // …session, canvas, pipeline, texture, spawn…
   *   scene.run(canvas, pipe, new Game(world, boxes));
   * }
   * ```
   *
   * ## `step` is an interface, not a function parameter — measured
   *
   * The obvious signature is `run(canvas, pipe, () => void)`, and it **cannot
   * work** on this toolchain: a closure that captures a *stack local* traps at
   * `call_indirect` with `wasm trap: uninitialized element`. Not only under
   * `await` — the synchronous case traps too, so this is the closure-lowering
   * path in TensionScript 0.13.2, not the async transform. Measured, four shapes
   * in one probe:
   *
   *     () => { n++ }   over a method local        TRAP (uninitialized element)
   *     () => { o.hit() } over a local object       TRAP
   *     () => { g++ }   over a module-level global  ok
   *     () => { this.x++ } created in a method      ok
   *     base-class method / interface method        ok   <- what this takes
   *
   * So the step crosses as an **interface**: virtual dispatch is a table entry
   * the class installs at definition, not a closure built at the call site. That
   * is also the shape a game already wants — a class holding its world and its
   * sprites, with one method — and it is the shape `examples/ogre` uses for its
   * loop.
   *
   * A closure over a module global still works if a caller prefers one, because
   * the compiler needs no closure object for it; `FrameGlobal`-style globals are
   * the documented escape hatch, and the trap above is why it is not the default.
   *
   * ## What one frame is
   *
   * 1. `step()` — the guest's own update, called once per frame;
   * 2. `commit(canvas, pipe)` — pack what changed and submit it;
   * 3. `present()` — draw it;
   * 4. `await rt.frame()` — yield; the host wakes this task next frame.
   *
   * **`present` is inside the loop and belongs there.** A loop without it draws
   * nothing: `submit` only stages records, and the blit is what puts them on
   * screen. It is the loop's job because it is the one step the scene can do and
   * a caller cannot get wrong.
   *
   * ## How it ends, and who tears down
   *
   * Three exits the **guest** sees: `maxFrames` reached (pass 0 for "until the
   * window closes", which is what a windowed game wants), `closeRequested` on the
   * host window, or a refused `commit`/`present` whose errno goes into the stop
   * reason. On those, `run` closes the canvas and the session and prints
   * `scene: N frame(s) (reason)`.
   *
   * The fourth exit it **cannot** see, and that is a property of the adopted
   * loop rather than a gap here: when the user clicks X, the *host* pumps the
   * event, sees `window_closed`, and leaves its loop before the guest's task is
   * woken again (`main.rs:2930-2940`). The host then closes the session itself
   * (`main.rs:2115`, "a guest that returns without closing it leaves the arena
   * reporting READY"). So a window close during an adopted loop ends the process
   * cleanly with exit 0 and no guest teardown line — verified, and the reason
   * `examples/2d/hello-sprites` keeps its own loop: that example asserts on its
   * own teardown output.
   *
   * ## `run` returns immediately
   *
   * It starts a *floating* task: the body runs to its first `await`, then the
   * host takes over and `run` returns. `_start_game` therefore returns while
   * frames are still being drawn — that is the whole shape of an adopted loop.
   *
   * ## The one call a caller could object to
   *
   * `__taskBindTable(TASK_SLOTS)`: parking needs a slot table, and the table is
   * per-program rather than per-task. Binding replaces it, discarding anything
   * parked earlier — so `run` must be called before anything else in the program
   * parks. Every example satisfies that. A game that awaited an asset load during
   * startup should bind the table itself before that load.
   */
  run(canvas: Canvas, pipe: i32, stepper: FrameStep, maxFrames: i32 = 0): void {
    if (!canvas.isValid()) {
      loopStopReason = "the canvas is not open";
      print("scene: run refused — the canvas is not open");
      return;
    }
    if (loopRunning) {
      print("scene: run called while a loop is already driving this guest");
      return;
    }
    rt.start();
    __taskBindTable(TASK_SLOTS);
    loopFrames = 0;
    loopStopReason = "still running";
    loopRunning = true;
    // A floating task: no `await` here, so this returns at the first park and the
    // host's loop drives the rest.
    drive(canvas, pipe, this, stepper, maxFrames);
  }

  /** Records the last pack produced. */
  recordCount(): i32 {
    return this.packed;
  }

  /**
   * How many records the last `pack` had to write — the rest kept the bytes the
   * previous pack left in the buffer.
   *
   * This is the number that makes retention visible rather than claimed: a scene
   * where one sprite of a thousand moved reports `1`. It is also the number a
   * caller wants when deciding whether a frame is cheap.
   */
  writes(): i32 {
    return this.written;
  }

  /** The record buffer, for a caller that wants to submit it itself. */
  buffer(): RecordBuffer {
    return this.records;
  }

  // --- internals -----------------------------------------------------------

  /** Off-screen, with one pixel of slack so a touching edge still draws. */
  private isCulled(i: i32): bool {
    const f = this.frameTable[this.frames[i]];
    const w: i32 = this.ws[i] != 0 ? this.ws[i] : f.w;
    const h: i32 = this.hs[i] != 0 ? this.hs[i] : f.h;
    if (w <= 0 || h <= 0) return true;              // nothing to draw
    // Screen space: the node's world position, panned by the camera and placed
    // at the viewport's origin. With neither set this is the node's own
    // coordinates against the canvas, which is what it always was.
    const x: i32 = this.screenX(i);
    const y: i32 = this.screenY(i);
    const left: i32 = this.clipX();
    const top: i32 = this.clipY();
    return x >= left + this.clipW() || y >= top + this.clipH() ||
           x + w <= left || y + h <= top;
  }

  /** Node `i`'s canvas x: world position, panned, then placed in the viewport. */
  private screenX(i: i32): i32 {
    return <i32>Math.round(<f32>this.xs[i] - this.cameraX) + this.clipX();
  }

  /** The vertical counterpart of `screenX`. */
  private screenY(i: i32): i32 {
    return <i32>Math.round(<f32>this.ys[i] - this.cameraY) + this.clipY();
  }

  /**
   * Write node `i`'s bytes into record `slot`, panning and clipping it.
   *
   * The trim is the viewport's other half. `isCulled` drops a node entirely
   * outside; this one handles the straddle, by shortening the **source** rect as
   * well as the destination — legal because the record's `w`/`h` are one pair
   * used for both, so at 1:1 a source offset is a destination offset. A record
   * written untrimmed would paint outside the viewport and over whatever the next
   * bucket draws there.
   */
  private writeRecord(i: i32, slot: i32): void {
    const f = this.frameTable[this.frames[i]];
    let w: i32 = this.ws[i] != 0 ? this.ws[i] : f.w;
    let h: i32 = this.hs[i] != 0 ? this.hs[i] : f.h;
    let x: i32 = this.screenX(i);
    let y: i32 = this.screenY(i);
    let srcX: i32 = f.srcX;
    let srcY: i32 = f.srcY;

    const left: i32 = this.clipX();
    const top: i32 = this.clipY();
    const right: i32 = left + this.clipW();
    const bottom: i32 = top + this.clipH();

    if (x < left) {
      const cut: i32 = left - x;
      srcX += cut;
      x = left;
      w -= cut;
    }
    if (y < top) {
      const cut: i32 = top - y;
      srcY += cut;
      y = top;
      h -= cut;
    }
    if (x + w > right) w = right - x;
    if (y + h > bottom) h = bottom - y;
    // `isCulled` should have dropped this node; the check stays because a
    // rounded position can put a one-pixel sliver on the wrong side of the edge
    // and a zero- or negative-width record is not a draw.
    if (w <= 0 || h <= 0) {
      this.flags[i] = 0;
      return;
    }

    this.written++;
    this.records.writeAt(slot, x, y, <u16>srcX, <u16>srcY, <u16>w, <u16>h, f.tex,
                         this.sortKeys[i], this.groupIds[i], this.zs[i]);
    this.flags[i] = 0;
  }

  /**
   * Rebuild `order` from the live nodes, sorted by `(sortKey, seq)`.
   *
   * An insertion sort, deliberately: it is stable by construction — which is the
   * property this whole ordering rests on — and it is near-linear on the list a
   * scene actually has, because a node's key rarely moves far. A comparison sort
   * would need an auxiliary array and a tie-break rule to stay stable, and would
   * be slower at these sizes.
   *
   * Every node is marked dirty by the caller's slot pass, not here: a rebuilt
   * order means slots may have shifted for nodes that did not change.
   */
  private rebuildOrder(): void {
    let n: i32 = 0;
    for (let i: i32 = 0; i < this.highWater; i++) {
      if (this.alives[i] != 0) this.order[n++] = i;
    }
    this.orderCount = n;

    for (let k: i32 = 1; k < n; k++) {
      const node = this.order[k];
      const key = this.sortKeys[node];
      const seq = this.seqs[node];
      let j: i32 = k - 1;
      while (j >= 0) {
        const other = this.order[j];
        const otherKey = this.sortKeys[other];
        // Ascending key; equal keys keep spawn order, so a later spawn draws on
        // top of an earlier one.
        if (otherKey < key || (otherKey == key && this.seqs[other] <= seq)) break;
        this.order[j + 1] = other;
        j--;
      }
      this.order[j + 1] = node;
    }
    this.needsOrder = false;
  }

  /** Bytes one node's record occupies, for a caller sizing something. */
  static recordBytes(): i32 {
    return <i32>RECORD_SIZE;
  }
}

// ── the loop ────────────────────────────────────────────────────────────────

/**
 * One frame at a time, yielding to the host between each.
 *
 * **Every local is declared before the first `await`**, and that is a compiler
 * constraint rather than a style (`ogre/async.ts` records the same three: no
 * default parameters, no `<T>expr` cast, no local declared after a park). So the
 * counters are declared here and assigned inside the loop, and the reason strings
 * are assigned rather than built inline where they would need a temporary.
 *
 * The `stepper` is an interface, for the reason `run`'s doc comment carries: a
 * closure over a stack local traps at `call_indirect`, synchronously, so the
 * step cannot cross as a function value.
 */
async function drive(canvas: Canvas, pipe: i32, scene: Scene, stepper: FrameStep,
                     maxFrames: i32): void {
  let frames: i32 = 0;
  let reason: string = "";
  let submitted: i32 = 0;
  let presented: i32 = 0;
  let budgeted: bool = maxFrames > 0;

  while (true) {
    if (budgeted && frames >= maxFrames) {
      reason = "the frame budget was reached";
      break;
    }
    // Asked at the top of the frame, before any work: the request is the guest's
    // reason to stop, and a frame it draws after the user clicked X is a frame
    // that arrives while the window is going away.
    if (platform.windowInfo().closeRequested) {
      reason = "the window was closed";
      break;
    }

    stepper.step();

    submitted = scene.commit(canvas, pipe);
    if (submitted < 0) {
      reason = "commit -> " + submitted.toString();
      break;
    }

    presented = canvas.present();
    if (presented != 0) {
      // -ECANCELED: the window is gone. Any other errno is a real failure, and
      // both end the loop — the number is in the reason either way.
      reason = presented == -125
        ? "the window was closed"
        : "present -> " + presented.toString();
      break;
    }

    frames++;
    loopFrames = frames;
    Time.tick();
    // The park. The host's loop resolves this once per slice, and that is the
    // only thing that ever resumes it.
    await rt.frame();
  }

  loopStopReason = reason;
  loopRunning = false;
  canvas.close();
  RuntimeSession.close();
  print("scene: " + frames.toString() + " frame(s) (" + reason + ")");
}
