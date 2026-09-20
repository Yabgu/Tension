// The motion batch: one call per frame for N moving bodies (chunk 4).
//
// A solver steps on the guest's thread and produces transforms; the guest
// writes them into the motion table at the start of `BUFFER_POOL` and names the
// whole table to `ogre::submit_motion(count)`. The adapter reads it once,
// validates it whole, and applies it whole — so this module's job is small: put
// the numbers where the catalogue says, and say how many.
//
// It is not a solver binding. Which state slot is which body is game policy
// (DESIGN.md §5.1), and `setFromState` only converts; the mapping stays where
// the game can see it.

import { MOTION_SIZE, MOTION_CAPACITY } from "./wire";
import { REGION_BUFFER_POOL } from "../runtime/wire";
import { regionOffset } from "../runtime/arena";

/** `ogre::submit_motion(count)`: the table's live length, or a negative errno. */
@external("ogre", "submit_motion")
declare function submitMotionRaw(count: i32): i32;

/**
 * Where the motion table starts: the first byte of `BUFFER_POOL`, read from the
 * layout at runtime rather than baked — the region's offset is the arena's
 * business and this SDK only addresses it.
 */
export function getMotionBase(): usize {
  return regionOffset(REGION_BUFFER_POOL);
}

/**
 * A frame's worth of transforms, written into the motion table.
 *
 * The batch **counts itself**: `set` and `setFromState` remember the highest
 * index written, and `commit` sends that many entries. A caller therefore
 * cannot send fewer entries than it wrote (the bug that would silently freeze
 * the tail of a crowd) — but it can leave a *gap* by writing index 5 without
 * 0..4, and that is refused by the adapter with `-ENOENT` naming the entry,
 * because an untouched slot names renderable 0. A loud refusal beats a hole.
 *
 * One batch per frame is the shape this exists for; a second `set` on the same
 * index simply replaces the entry, and `commit` may be called as often as the
 * caller likes (each call sends the whole table as it stands).
 */
export class MotionBatch {
  private base: usize;
  private entries: u32 = 0;

  constructor() {
    this.base = getMotionBase();
  }

  /** How many entries `commit` would send. */
  count(): u32 {
    return this.entries;
  }

  /**
   * Write entry `index`: a renderable id, a position, and a scale.
   *
   * A motion entry is a **whole transform**, not a delta — that is what the
   * wire record is — so this replaces the renderable's rotation with the
   * identity and its scale with `scale`. A guest driving a body it submitted
   * at a size other than 1 must say so here: leaving it out silently resizes
   * the body, which is a bug the round that wrote this fixture found the hard
   * way. The default keeps the simple case simple.
   */
  set(index: u32, id: u32, x: f32, y: f32, z: f32, scale: f32 = 1.0): void {
    if (index >= MOTION_CAPACITY) return; // a slot past the table is not written
    const at = this.base + <usize>index * MOTION_SIZE;
    store<u32>(at + 0, id);
    store<u32>(at + 4, 0); // flags, reserved
    store<u64>(at + 8, 0); // pad0, which is what puts the transform at 16
    store<f32>(at + 16, x);
    store<f32>(at + 20, y);
    store<f32>(at + 24, z);
    store<f32>(at + 28, 0);
    store<f32>(at + 32, 0);
    store<f32>(at + 36, 0);
    store<f32>(at + 40, 0);
    store<f32>(at + 44, 1); // w
    store<f32>(at + 48, scale);
    store<f32>(at + 52, scale);
    store<f32>(at + 56, scale);
    store<f32>(at + 60, 0);
    if (index + 1 > this.entries) this.entries = index + 1;
  }

  /**
   * Write entry `index` from three slots of a solver's state vector: slot `i`
   * holds `state[i]`, so `[t, x, y, z]` is `setFromState(i, id, state, 1, 2, 3)`.
   *
   * The conversion is the point — the solver speaks `f64` and the wire speaks
   * `f32` — and a negative slot means zero, which is how a two-dimensional
   * problem drives a three-dimensional transform without the caller inventing a
   * slot index that does not exist.
   */
  setFromState(index: u32, id: u32, state: Float64Array, xSlot: i32, ySlot: i32, zSlot: i32,
               scale: f32 = 1.0): void {
    const x: f32 = xSlot >= 0 ? <f32>state[xSlot] : 0.0;
    const y: f32 = ySlot >= 0 ? <f32>state[ySlot] : 0.0;
    const z: f32 = zSlot >= 0 ? <f32>state[zSlot] : 0.0;
    this.set(index, id, x, y, z, scale);
  }

  /**
   * Send the table. Returns the number of entries the adapter accepted (equal
   * to `count()`), or a negative errno — `-EINVAL` for a malformed count or a
   * region too small, `-ENOENT` for the first entry naming a renderable that is
   * not live, in which case the whole batch was refused and nothing moved.
   *
   * An empty batch is not sent: `commit` with nothing written returns 0 without
   * a call, so a frame with no motion costs no verb at all.
   */
  commit(): i32 {
    if (this.entries == 0) return 0;
    return submitMotionRaw(<i32>this.entries);
  }
}
