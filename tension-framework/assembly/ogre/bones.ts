// The bone batch: one call per frame for a whole rig's pose (chunk 5b).
//
// A rig is not a scene node and a bone is not a renderable. The guest names a
// **bone inside a renderable** — `renderableId` plus `boneIndex` — and the
// transform it writes is the bone's *local* transform, the same thing OGRE's
// own animation system would write. The adapter applies the whole table at once
// to the `SkeletonInstance` the item was created with.
//
// The table lives in `BUFFER_POOL` past the motion table (`BONE_TABLE_OFFSET`),
// so motion and bones are two tables of the same stride in one region, and a
// frame that moves bodies *and* poses rigs costs two verb calls, not one per
// bone.
//
// Two things are worth knowing before using it, both measured by the probe that
// wrote this round (DESIGN.md §5.1):
//
//   * the mesh must be **rigged** — `isRigged(meshResourceId)` — and it must be
//     drawn with a **PBS** material. HlmsUnlit has no skeletal animation in its
//     shaders at all, so an Unlit rig is a mesh that never moves while every
//     bone transform is perfectly correct;
//   * a bone pose is applied by setting the bone, full stop. `setManualBone` is
//     not needed and this SDK does not call it: it would take the bone away from
//     OGRE's own animation system.

import { BONE_SIZE, BONE_CAPACITY, BONE_TABLE_OFFSET } from "./wire";
import { REGION_BUFFER_POOL } from "../runtime/wire";
import { regionOffset } from "../runtime/arena";

/** `ogre::submit_bones(count)`: the table's live length, or a negative errno. */
@external("ogre", "submit_bones")
declare function submitBonesRaw(count: i32): i32;

/** Where the bone table starts: `BUFFER_POOL`'s first byte, plus the motion
 * table's 128 KiB. Read from the layout at runtime rather than baked. */
export function getBoneBase(): usize {
  return regionOffset(REGION_BUFFER_POOL) + BONE_TABLE_OFFSET;
}

/**
 * A frame's worth of bone poses, written into the bone table.
 *
 * Counts itself, exactly as `MotionBatch` does and for the same reason: `set`
 * remembers the highest index written and `commit` sends that many entries, so
 * a caller cannot send fewer entries than it wrote. A gap — writing index 5
 * without 0..4 — is refused by the adapter rather than silently ignored, because
 * an untouched slot names renderable 0.
 *
 * **Every writer rewrites the whole entry.** A `BoneUpdate` is a complete
 * transform, not a delta, so `set` after `setRotation` on the same index
 * replaces the rotation with the identity rather than adding to it, and the
 * last call for an index is the one that is sent. The fixture that wrote this
 * needs exactly one writer per index per frame, and that is the shape to keep.
 */
export class BoneBatch {
  private base: usize;
  private entries: u32 = 0;

  constructor() {
    this.base = getBoneBase();
  }

  /** How many entries `commit` would send. */
  count(): u32 {
    return this.entries;
  }

  /**
   * Write entry `index`: a bone placed at `(x, y, z)` with no rotation.
   *
   * The common case for a rig whose root moves and whose joints do not — which
   * is why the rotation defaults away rather than being required.
   */
  set(index: u32, renderableId: u32, boneIndex: u32, x: f32 = 0, y: f32 = 0, z: f32 = 0,
      scale: f32 = 1.0): void {
    this.write(index, renderableId, boneIndex, x, y, z, 0, 0, 0, 1, scale);
  }

  /**
   * Write entry `index` as a rotation about an arbitrary axis, given as an
   * axis and an angle in radians.
   *
   * This is the writer an animation uses: the probe that fixed this round's
   * threshold rotated one bone 90 degrees about X and measured the silhouette
   * change (flip 0.0197 of the frame at scale 0.6), and a bone pose that could
   * not express a rotation would not have been able to run that test at all.
   * The axis is normalized here; a zero-length axis means "no rotation" rather
   * than a division by zero, because that is the state a caller reaches by
   * passing ones it computed from something that happened to be zero.
   */
  setRotation(index: u32, renderableId: u32, boneIndex: u32, axisX: f32, axisY: f32, axisZ: f32,
              radians: f32): void {
    const length: f32 = <f32>Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
    if (length <= 0.0) {
      this.set(index, renderableId, boneIndex);
      return;
    }
    const half: f32 = radians * 0.5;
    const s = <f32>Math.sin(half) / length;
    this.write(index, renderableId, boneIndex, 0, 0, 0, axisX * s, axisY * s, axisZ * s,
               <f32>Math.cos(half), 1.0);
  }

  /**
   * Write entry `index` from three slots of a solver's state vector: slot `i`
   * holds `state[i]`, so `[t, x, y, z]` is `setFromState(i, id, bone, state, 1,
   * 2, 3)`. A negative slot means zero.
   *
   * The conversion — the solver speaks `f64`, the wire speaks `f32` — is all
   * this does. Which state slot is which bone is game policy, and it stays in
   * the game (DESIGN.md §5.1).
   */
  setFromState(index: u32, renderableId: u32, boneIndex: u32, state: Float64Array, xSlot: i32,
               ySlot: i32, zSlot: i32): void {
    const x: f32 = xSlot >= 0 ? <f32>state[xSlot] : 0.0;
    const y: f32 = ySlot >= 0 ? <f32>state[ySlot] : 0.0;
    const z: f32 = zSlot >= 0 ? <f32>state[zSlot] : 0.0;
    this.set(index, renderableId, boneIndex, x, y, z, 1.0);
  }

  /**
   * Send the table. Returns the number of entries the adapter accepted (equal to
   * `count()`), or a negative errno: `-EINVAL` for a count or a region that does
   * not fit, and for an entry naming a bone the rig does not have, `-ENOENT` for
   * an entry naming a renderable that is not live. In every refusal the whole
   * batch was dropped and no bone moved.
   *
   * An empty batch is not sent: `commit` with nothing written returns 0 without
   * a call, so a frame that poses nothing costs no verb at all.
   */
  commit(): i32 {
    if (this.entries == 0) return 0;
    return submitBonesRaw(<i32>this.entries);
  }

  /// The one place an entry is written, so `BONE_SIZE` and the offset 16/32/48
  /// layout have exactly one spelling in this module.
  private write(index: u32, renderableId: u32, boneIndex: u32, x: f32, y: f32, z: f32, rx: f32,
                ry: f32, rz: f32, rw: f32, scale: f32): void {
    if (index >= BONE_CAPACITY) return; // a slot past the table is not written
    const at = this.base + <usize>index * BONE_SIZE;
    store<u32>(at + 0, renderableId);
    store<u32>(at + 4, boneIndex);
    store<u64>(at + 8, 0); // pad0, which is what puts the transform at 16
    store<f32>(at + 16, x);
    store<f32>(at + 20, y);
    store<f32>(at + 24, z);
    store<f32>(at + 28, 0);
    store<f32>(at + 32, rx);
    store<f32>(at + 36, ry);
    store<f32>(at + 40, rz);
    store<f32>(at + 44, rw);
    store<f32>(at + 48, scale);
    store<f32>(at + 52, scale);
    store<f32>(at + 56, scale);
    store<f32>(at + 60, 0);
    if (index + 1 > this.entries) this.entries = index + 1;
  }
}
