// The Phase 4 record-bytes gate.
//
// Writes values through the public API and dumps the raw bytes of the motion and
// bone records, so the pre-nesting and post-nesting trees can be compared byte
// for byte at the wire level rather than by proxy.
//
// One source compiles on both trees on purpose: `MotionBatch.set/setPose`,
// `BoneBatch.set`, and `getMotionBase/getBoneBase` keep their signatures across
// the nesting, so a difference in the dump is a difference in the record, not in
// the probe.
//
// Run: tension-core <this>.wasm, then diff the two trees' outputs.

import { print } from "../../assembly/io";
import { MOTION_SIZE, BONE_SIZE, MotionUpdate, BoneUpdate } from "../../assembly/ogre/wire";
import { MotionBatch, getMotionBase } from "../../assembly/ogre/motion";
import { BoneBatch, getBoneBase } from "../../assembly/ogre/bones";

/** Distinctive values, one per field, so a moved field changes the dump. */
const A: f32 = 1.25;
const B: f32 = 2.5;
const C: f32 = -3.75;
const D: f32 = 0.5;

/** Dump `n` bytes at `at` as hex, in memory order, so offsets are readable. */
function dumpBytes(at: usize, n: i32): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    const b = load<u8>(at + <usize>i);
    if (b < 16) out += "0";
    out += b.toString(16);
  }
  return out;
}

export function _start_game(): void {
  // ── the motion record: a whole pose, every field distinct ─────────────
  const motion = new MotionBatch();
  motion.setPose(0, 7, A, B, C, D, -D, A * 2, 1.0, B);
  print("motion.stride=" + MOTION_SIZE.toString());
  print("motion.bytes=" + dumpBytes(getMotionBase(), <i32>sizeof<MotionUpdate>()));

  // And the position-only writer, whose identity rotation is the other half of
  // the pair — written to slot 1 so it cannot be confused with slot 0.
  motion.set(1, 9, C, A, B, B);
  print("motion.bytes1=" + dumpBytes(getMotionBase() + <usize>MOTION_SIZE, <i32>sizeof<MotionUpdate>()));

  // ── the bone record ──────────────────────────────────────────────────
  const bones = new BoneBatch();
  bones.set(0, 3, 5, C, A, B, B);
  print("bone.stride=" + BONE_SIZE.toString());
  print("bone.bytes=" + dumpBytes(getBoneBase(), <i32>sizeof<BoneUpdate>()));

  print("OK");
}
