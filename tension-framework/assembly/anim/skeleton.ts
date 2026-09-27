// The skeleton archive: a joint hierarchy and one rest pose per joint.
//
// Layout, in the order `Skeleton::Save` writes it (skeleton version 2, the only
// version the reference loader accepts — `if (_version != 2)`, in
// `skeleton.cc`):
//
//     endianness byte        1 = little
//     tag                    "ozz-skeleton\0"
//     u32 version            2
//     i32 num_joints
//     i32 chars_count        joint names, concatenated and NUL-separated
//     char[chars_count]      the names, in joint order
//     i16[num_joints]        parent indices, depth-first, -1 = a root
//     SoaTransform[...]      Align(num_joints, 4) / 4 blocks, 160 bytes each
//
// The last one is the part that surprises: rest poses are **SoA**, four joints
// to a block, laid out as ten `SimdFloat4`s — translation x, y, z; rotation x,
// y, z, w; scale x, y, z — so joint `j` lives at component `c`, lane `j % 4`,
// of block `j / 4`. Reading them as an array of per-joint structs gives a
// plausible-looking skeleton with every pose in the wrong place, which is why
// `restTransform` is the only way this module hands them out.
//
// Everything here is a copy out of the archive's bytes: the guest keeps no
// reference into the file, and the arrays are sized by the counts the file
// itself declares (bounded by the file's length, so a corrupt header cannot ask
// for an allocation it has no bytes for).

import { BoneTransform } from "./key";
import { Reader } from "./reader";

/** `Skeleton::kMaxJoints` in the format. A count above this is a misread header. */
export const MAX_JOINTS: i32 = 1024;
/** Floats per SoA block: translation (3), rotation (4), scale (3), four lanes each. */
export const SOA_BLOCK_FLOATS: i32 = 40;
/** Floats per component, i.e. the stride between components within a block. */
const LANES: i32 = 4;
/** Component offsets inside a block, in the archive's order. */
const T_X: i32 = 0, T_Y: i32 = 4, T_Z: i32 = 8;
const R_X: i32 = 12, R_Y: i32 = 16, R_Z: i32 = 20, R_W: i32 = 24;
const S_X: i32 = 28, S_Y: i32 = 32, S_Z: i32 = 36;

/** A parsed skeleton archive. `error` is `""` when the parse succeeded. */
export class Skeleton {
  /** The number of joints, i.e. the length of every per-joint array. */
  jointCount: i32 = 0;
  /** Where the parse stopped: the archive's length when it consumed all of it. */
  bytesConsumed: i32 = 0;
  /** `""`, or why the archive was refused. */
  error: string = "";

  private parentIndices: Int32Array = new Int32Array(0);
  private jointNameList: string[] = [];
  /** The rest poses, in the archive's SoA layout (`SOA_BLOCK_FLOATS` per block). */
  private restPoses: Float32Array = new Float32Array(0);

  /**
   * Parse a skeleton archive. Returns a `Skeleton` either way: check `error`.
   *
   * The version is checked before any field is interpreted, because version 1
   * is a different layout (and refused by the format's own runtime for the same
   * reason) — misreading it would produce a skeleton with a plausible joint
   * count and nonsense bones.
   */
  static parse(bytes: StaticArray<u8>): Skeleton {
    const skeleton = new Skeleton();
    const reader = new Reader(bytes);

    if (!reader.readEndianness() || !reader.readTag("ozz-skeleton") || !reader.readVersion(2)) {
      skeleton.error = reader.error;
      return skeleton;
    }

    const joints = reader.i32();
    if (!reader.ok) {
      skeleton.error = reader.error;
      return skeleton;
    }
    if (joints < 0 || joints > MAX_JOINTS) {
      skeleton.error =
        "the archive declares " + joints.toString() + " joints, which is not in 0.." +
        MAX_JOINTS.toString();
      return skeleton;
    }
    skeleton.jointCount = joints;
    if (joints == 0) {
      // `Skeleton::Save` writes only the count for an empty skeleton.
      skeleton.bytesConsumed = reader.offset;
      return skeleton;
    }

    const charsCount = reader.i32();
    if (!reader.ok) {
      skeleton.error = reader.error;
      return skeleton;
    }
    if (charsCount < joints) {
      // Every name costs at least its NUL, so a count below the joint count
      // cannot describe a name block at all.
      skeleton.error =
        "the archive declares " + charsCount.toString() + " name bytes for " +
        joints.toString() + " joints, which cannot hold them";
      return skeleton;
    }

    // ── the names: concatenated NUL-separated strings ──────────────────────
    const names = new Array<string>(joints);
    let nameBytes = 0;
    for (let i = 0; i < joints; i++) {
      const start = reader.offset;
      while (reader.offset < reader.length &&
             load<u8>(changetype<usize>(bytes) + reader.offset) != 0) {
        reader.offset += 1;
      }
      if (reader.offset >= reader.length) {
        skeleton.error = "joint name " + i.toString() + " is not NUL-terminated";
        return skeleton;
      }
      names[i] = String.UTF8.decodeUnsafe(
        changetype<usize>(bytes) + start,
        <usize>(reader.offset - start),
        false,
      );
      reader.offset += 1; // the NUL
      nameBytes += reader.offset - start;
    }
    if (nameBytes != charsCount) {
      skeleton.error =
        "the name block is " + nameBytes.toString() + " bytes but the header says " +
        charsCount.toString();
      return skeleton;
    }
    skeleton.jointNameList = names;

    // ── the hierarchy ──────────────────────────────────────────────────────
    const parents = new Int32Array(joints);
    for (let i = 0; i < joints; i++) {
      parents[i] = reader.i16();
    }
    if (!reader.ok) {
      skeleton.error = reader.error;
      return skeleton;
    }
    skeleton.parentIndices = parents;

    // ── the rest poses ─────────────────────────────────────────────────────
    const blocks = (joints + 3) / 4;
    const rest = new Float32Array(blocks * SOA_BLOCK_FLOATS);
    for (let i = 0; i < rest.length; i++) {
      rest[i] = reader.f32();
    }
    if (!reader.ok) {
      skeleton.error = reader.error;
      return skeleton;
    }
    skeleton.restPoses = rest;

    skeleton.bytesConsumed = reader.offset;
    return skeleton;
  }

  /** The parent of joint `index`, or -1 for a root. */
  parent(index: i32): i32 {
    if (index < 0 || index >= this.jointCount) return -1;
    return this.parentIndices[index];
  }

  /** The name of joint `index`, or `""` when it is out of range. */
  name(index: i32): string {
    if (index < 0 || index >= this.jointCount) return "";
    return this.jointNameList[index];
  }

  /** How many SoA blocks the rest poses occupy, i.e. `Align(jointCount, 4) / 4`. */
  soaBlockCount(): i32 {
    if (this.jointCount == 0) return 0;
    return (this.jointCount + 3) / 4;
  }

  /**
   * The raw SoA rest-pose block, for a test that wants to check the layout
   * itself. Production code wants `restTransform`.
   */
  restBlock(block: i32): Float32Array {
    const out = new Float32Array(SOA_BLOCK_FLOATS);
    const blocks = this.soaBlockCount();
    if (block < 0 || block >= blocks) return out;
    const at = block * SOA_BLOCK_FLOATS;
    for (let i = 0; i < SOA_BLOCK_FLOATS; i++) out[i] = this.restPoses[at + i];
    return out;
  }

  /** Joint `index`'s rest pose, gathered out of the SoA block it shares with
   * three other joints. Out-of-range indices give the identity transform. */
  restTransformInto(index: i32, out: BoneTransform): void {
    out.identity();
    if (index < 0 || index >= this.jointCount) return;
    const base = (index / 4) * SOA_BLOCK_FLOATS + (index % 4);
    out.tx = this.restPoses[base + T_X];
    out.ty = this.restPoses[base + T_Y];
    out.tz = this.restPoses[base + T_Z];
    out.rx = this.restPoses[base + R_X];
    out.ry = this.restPoses[base + R_Y];
    out.rz = this.restPoses[base + R_Z];
    out.rw = this.restPoses[base + R_W];
    out.sx = this.restPoses[base + S_X];
    out.sy = this.restPoses[base + S_Y];
    out.sz = this.restPoses[base + S_Z];
  }

  /** `restTransformInto`, allocating. */
  restTransform(index: i32): BoneTransform {
    const out = new BoneTransform();
    this.restTransformInto(index, out);
    return out;
  }
}
