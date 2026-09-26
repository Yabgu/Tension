// The two value decoders an ozz archive needs, and both are load-bearing: the
// runtime format stores no raw floats.
//
//   * translations and scales are **3 x binary16 half floats** (6 bytes per
//     key). Half precision is not a rounding detail to be approximated —
//     `halfToFloat` here is the exact IEEE-754 binary16 -> binary32 conversion,
//     including subnormals and infinities, and the tests compare its output to
//     ozz's own decode bit for bit.
//   * rotations are **45 packed bits** (6 bytes per key): 2 bits naming the
//     largest component, 1 bit for its sign, and 3 x 15 bits for the other
//     three components, pre-multiplied by sqrt(2) to spend the extra range.
//     The fourth component is not stored at all — it is recomputed as
//     `sqrt(1 - dot)`, which is why a decoded quaternion is within ~1e-5 of the
//     original but never bit-identical to it.
//
// One deliberate divergence from ozz's own decoder, and it is in the reader's
// favour: ozz finishes the quaternion and the interpolation with
// `RSqrtEst`/`RcpEst`, which are hardware estimate instructions on SSE (about
// 1e-3 relative) or a bit-trick seed plus two Newton steps in the reference
// build (about 1e-4). This decoder uses an exact `Math.sqrt`, so it is *more*
// accurate than the library it is reading. A guest that reproduced ozz's
// estimates instead would match ozz's own error, which nothing here wants; the
// probe measured the difference at up to 1.7e-4 in a pose, and `sqrt` at zero.

/** A translation or scale. */
export class Float3 {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
}

/** A rotation quaternion, `w` last, identity by default. */
export class Quat {
  rx: f32 = 0;
  ry: f32 = 0;
  rz: f32 = 0;
  rw: f32 = 1;
}

/**
 * A joint transform: the three pieces a bone's local pose is made of, in the
 * same field order the archive stores them and the same order the bone table's
 * `BoneUpdate` record uses (`ogre/wire.ts`). Identity by default.
 *
 * Rest poses and decoded animation keys are both TRS, so this is the one shape
 * that carries either.
 */
export class BoneTransform {
  tx: f32 = 0;
  ty: f32 = 0;
  tz: f32 = 0;
  rx: f32 = 0;
  ry: f32 = 0;
  rz: f32 = 0;
  rw: f32 = 1;
  sx: f32 = 1;
  sy: f32 = 1;
  sz: f32 = 1;

  /** Back to the identity pose: no translation, no rotation, unit scale. */
  identity(): void {
    this.tx = 0;
    this.ty = 0;
    this.tz = 0;
    this.rx = 0;
    this.ry = 0;
    this.rz = 0;
    this.rw = 1;
    this.sx = 1;
    this.sy = 1;
    this.sz = 1;
  }
}

/** `sqrt(2)`, as the *encoder* scaled the three stored components. */
const K_SQRT2: f32 = 1.41421356237;
/** `sqrt(2) / 2` — the encoder's offset, the midpoint of the stored range. */
const K_SQRT2_2: f32 = 0.70710678118;
/** `(1 << 15) - 1`, the encoder's scale (`QuaternionKey::kfScale`). */
const KF_SCALE: f32 = 32767.0;

/**
 * Which stored component lands in which slot of the quaternion, per value of
 * the 2-bit largest-component index — ozz's `kCpntMapping`, flattened.
 *
 * Row `largest` says: output component `i` takes stored component
 * `COMPONENT_MAP[largest * 4 + i]`. The slot held by the largest component is a
 * don't-care (it is zeroed and then restored from `sqrt`), so rows 0 and 1 both
 * read `{0, 0, 1, 2}`: for `largest == 0` the x slot is the don't-care and y, z,
 * w take the three stored values in order.
 */
const COMPONENT_MAP: StaticArray<i32> = [
  // largest = 0, 1, 2, 3, left to right
  0, 0, 1, 2, //
  0, 0, 1, 2, //
  0, 1, 0, 2, //
  0, 1, 2, 0,
];

/**
 * IEEE-754 binary16 -> binary32, exactly.
 *
 * The three cases are the ones the standard defines: a subnormal half (which
 * needs its mantissa shifted left until the implicit bit appears, decrementing
 * the exponent each time), an infinity or NaN (exponent all ones, mantissa
 * passed through so the NaN payload survives), and a normal half (exponent
 * rebiased from 15 to 127).
 */
export function halfToFloat(h: u16): f32 {
  const sign: u32 = <u32>(h & 0x8000) << 16;
  let exponent: u32 = <u32>(h >> 10) & 0x1f;
  let mantissa: u32 = <u32>h & 0x3ff;
  let bits: u32;

  if (exponent == 0) {
    if (mantissa == 0) {
      bits = sign; // +/- zero
    } else {
      // Subnormal: normalize into a normal binary32.
      exponent = 127 - 15 + 1;
      while ((mantissa & 0x400) == 0) {
        mantissa <<= 1;
        exponent -= 1;
      }
      mantissa &= 0x3ff;
      bits = sign | (exponent << 23) | (mantissa << 13);
    }
  } else if (exponent == 31) {
    bits = sign | 0x7f800000 | (mantissa << 13); // infinity, or a NaN
  } else {
    bits = sign | ((exponent + 112) << 23) | (mantissa << 13);
  }
  return reinterpret<f32>(bits);
}

/**
 * One rotation key (three stored `u16`) into `out`.
 *
 * The stored triple is unwrapped exactly as `animation_keyframe.h`'s `unpack`
 * does — 13 bits from the first word, 15 from the second, 15 from the third,
 * with the largest index and the sign carried in the first word's low bits —
 * and then mapped, scaled and completed with a `sqrt`, which is the one place
 * this decoder is exact where ozz estimates.
 */
export function unpackQuatInto(v0: u16, v1: u16, v2: u16, out: Quat): void {
  const packed: u32 = (<u32>v0 >> 3) | (<u32>v1 << 13) | (<u32>v2 << 29);
  const largest: i32 = <i32>(v0 & 0x3);
  const sign: i32 = <i32>((v0 >> 2) & 0x1);
  const c0: i32 = <i32>(packed & 0x7fff);
  const c1: i32 = <i32>((packed >> 15) & 0x7fff);
  const c2: i32 = <i32>(v2 >> 1);

  const components: StaticArray<i32> = [c0, c1, c2];
  const mapAt: i32 = largest * 4;
  // The same association ozz's decoder uses, left to right: scale, then offset.
  const x: f32 = K_SQRT2 * <f32>components[COMPONENT_MAP[mapAt + 0]] / KF_SCALE - K_SQRT2_2;
  const y: f32 = K_SQRT2 * <f32>components[COMPONENT_MAP[mapAt + 1]] / KF_SCALE - K_SQRT2_2;
  const z: f32 = K_SQRT2 * <f32>components[COMPONENT_MAP[mapAt + 2]] / KF_SCALE - K_SQRT2_2;
  const w: f32 = K_SQRT2 * <f32>components[COMPONENT_MAP[mapAt + 3]] / KF_SCALE - K_SQRT2_2;

  const parts: StaticArray<f32> = [x, y, z, w];
  parts[largest] = 0; // the don't-care slot: excluded from the dot, restored below

  const dot: f32 =
    parts[0] * parts[0] + parts[1] * parts[1] + parts[2] * parts[2] + parts[3] * parts[3];
  const remainder: f32 = 1 - dot; // cannot go negative: the largest component is not in the dot
  const restored: f32 = Mathf.sqrt(remainder < 0 ? 0 : remainder);

  out.rx = parts[0];
  out.ry = parts[1];
  out.rz = parts[2];
  out.rw = parts[3];
  if (largest == 0) out.rx = sign != 0 ? -restored : restored;
  else if (largest == 1) out.ry = sign != 0 ? -restored : restored;
  else if (largest == 2) out.rz = sign != 0 ? -restored : restored;
  else out.rw = sign != 0 ? -restored : restored;
}

/** `unpackQuatInto`, allocating the quaternion. Convenience, not the hot path. */
export function unpackQuat(v0: u16, v1: u16, v2: u16): Quat {
  const q = new Quat();
  unpackQuatInto(v0, v1, v2, q);
  return q;
}
