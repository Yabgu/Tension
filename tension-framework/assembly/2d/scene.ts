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
   * Pack and hand the result to `canvas` in bucket 0.
   *
   * Returns the records submitted, or the verb's errno. A refusal from `submit`
   * is the adapter's — `-ENOENT` for an unknown pipe, `-ENOSPC` for a staging
   * buffer full of somebody else's records — and is passed through unchanged, for
   * the reason every other verb passes its errno through: the number is the
   * diagnosis.
   */
  commit(canvas: Canvas, pipe: i32): i32 {
    const count = this.pack();
    if (count <= 0) return 0;
    return canvas.submit(pipe, this.records, 0);
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
    const x: f32 = this.xs[i];
    const y: f32 = this.ys[i];
    return x >= <f32>this.width || y >= <f32>this.height ||
           x + <f32>w <= 0.0 || y + <f32>h <= 0.0;
  }

  /** Write node `i`'s bytes into record `slot`. */
  private writeRecord(i: i32, slot: i32): void {
    const f = this.frameTable[this.frames[i]];
    const w: u16 = this.ws[i] != 0 ? this.ws[i] : f.w;
    const h: u16 = this.hs[i] != 0 ? this.hs[i] : f.h;
    this.written++;
    this.records.writeAt(slot,
                         <i32>Math.round(this.xs[i]), <i32>Math.round(this.ys[i]),
                         f.srcX, f.srcY, w, h, f.tex,
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
