// The 4x4 matrices the evaluator produces, and the one conversion the rest of it
// Compatible with ozz-animation's runtime archive format (MIT,
// github.com/guillaumeblanc/ozz-animation). That names the format, not this code.
// needs: a joint's local TRS -> its local matrix.
//
// **Layout: column-major.** Element (row `r`, column `c`) lives at index
// `c * 4 + r`, so a matrix occupies sixteen consecutive floats with the
// translation in the last column (`12, 13, 14`) and `1` at `15`. That is the reference's
// own layout, and it is not a guess: `Float4x4` holds `ArrayReal cols[4]`, its
// `operator*(m, v)` computes `cols[0]*v.x + cols[1]*v.y + cols[2]*v.z +
// cols[3]*v.w` (`simd_math_ref-inl.h`), and the probe's LocalToModelJob output
// for a translated root joint puts that translation at 12..14 while 3, 7 and 11
// stay zero. Anyone reading this file with a row-major habit should read
// `index = c * 4 + r` once more before indexing.
//
// The convention that goes with the layout: matrices multiply column vectors
// (`v' = M * v`), `multiply(a, b)` is the plain product `a * b` (b applied
// first), and the transform order inside one local matrix is `T * R * S` — the
// rotation-scale block sits in columns 0..2 and the translation in column 3.
// Scale multiplies each **column** of the rotation block, which is what makes
// the block `R * S` rather than `S * R`; the reference's `FromAffine` writes exactly that
// (`_scale.x * (one - two * (yy + zz))` in column 0, `_scale.y * …` in column 1).
//
// No coordinate system is imposed here. the reference is right-handed, Y-up, -Z forward,
// and these matrices are in whatever space the joint hierarchy is in — the
// evaluator hands them to a renderer, it does not adapt them to one.
//
// The storage is the caller's: every function takes a flat array and an offset
// rather than owning a matrix object, because the one producer
// (`localToModel`) hands back a single array of `joints * 16` floats and the
// consumer indexes it. Allocating sixty small objects per frame to be copied
// into that array immediately would be work for nothing.

import { BoneTransform } from "./key";

/** Floats in one matrix: the stride between matrices in a flat array. */
export const MAT4_FLOATS: i32 = 16;

/** Writes the identity matrix at `at`. */
export function mat4Identity(out: Float32Array, at: i32 = 0): void {
  for (let i = 0; i < MAT4_FLOATS; i++) out[at + i] = 0;
  out[at + 0] = 1;
  out[at + 5] = 1;
  out[at + 10] = 1;
  out[at + 15] = 1;
}

/**
 * A joint's local matrix, from its TRS — the reference's `SoaFloat4x4::FromAffine`, in the
 * same order of operations so the two produce the same floats rather than merely
 * the same transform.
 *
 * The quaternion is expected normalized; the rotation block is the standard
 * two-of-three form, scaled by the per-axis scale in the column it belongs to.
 */
export function mat4FromTransform(t: BoneTransform, out: Float32Array, at: i32 = 0): void {
  const x = t.rx, y = t.ry, z = t.rz, w = t.rw;
  const xx = x * x, xy = x * y, xz = x * z, xw = x * w;
  const yy = y * y, yz = y * z, yw = y * w;
  const zz = z * z, zw = z * w;

  // Column 0
  out[at + 0] = t.sx * (1 - 2 * (yy + zz));
  out[at + 1] = t.sx * 2 * (xy + zw);
  out[at + 2] = t.sx * 2 * (xz - yw);
  out[at + 3] = 0;
  // Column 1
  out[at + 4] = t.sy * 2 * (xy - zw);
  out[at + 5] = t.sy * (1 - 2 * (xx + zz));
  out[at + 6] = t.sy * 2 * (yz + xw);
  out[at + 7] = 0;
  // Column 2
  out[at + 8] = t.sz * 2 * (xz + yw);
  out[at + 9] = t.sz * 2 * (yz - xw);
  out[at + 10] = t.sz * (1 - 2 * (xx + yy));
  out[at + 11] = 0;
  // Column 3: the translation.
  out[at + 12] = t.tx;
  out[at + 13] = t.ty;
  out[at + 14] = t.tz;
  out[at + 15] = 1;
}

/** `out = a * b`, all column-major. `a` and `b` may alias neither `out`. */
export function mat4Multiply(
  a: Float32Array,
  b: Float32Array,
  out: Float32Array,
  aAt: i32 = 0,
  bAt: i32 = 0,
  outAt: i32 = 0,
): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum: f32 = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[aAt + k * 4 + r] * b[bAt + c * 4 + k];
      }
      out[outAt + c * 4 + r] = sum;
    }
  }
}

/** A matrix's translation: column 3. */
export function mat4TranslationInto(m: Float32Array, at: i32, out: BoneTransform): void {
  out.tx = m[at + 12];
  out.ty = m[at + 13];
  out.tz = m[at + 14];
}

/**
 * The TRS a local matrix was built from — the inverse of `mat4FromTransform`,
 * for a caller that has a matrix and wants the transform back.
 *
 * Translation is column 3. Scale is each column's length; rotation is the
 * column block with that scale divided out, converted to a quaternion. The
 * conversion picks the largest of the four squared terms to divide by, which is
 * the usual way to keep the arithmetic away from zero.
 *
 * A matrix with a negative determinant (a mirrored transform) is not something
 * this recovers: the scale comes back positive and the mirroring is lost. That
 * is the same limitation the reference's own `Matrix4::decomposition` documents.
 */
export function mat4ToTransform(m: Float32Array, at: i32, out: BoneTransform): void {
  out.tx = m[at + 12];
  out.ty = m[at + 13];
  out.tz = m[at + 14];

  const sx = Mathf.sqrt(m[at + 0] * m[at + 0] + m[at + 1] * m[at + 1] + m[at + 2] * m[at + 2]);
  const sy = Mathf.sqrt(m[at + 4] * m[at + 4] + m[at + 5] * m[at + 5] + m[at + 6] * m[at + 6]);
  const sz = Mathf.sqrt(m[at + 8] * m[at + 8] + m[at + 9] * m[at + 9] + m[at + 10] * m[at + 10]);
  out.sx = sx;
  out.sy = sy;
  out.sz = sz;

  const ix: f32 = sx > 0 ? 1 / sx : 0;
  const iy: f32 = sy > 0 ? 1 / sy : 0;
  const iz: f32 = sz > 0 ? 1 / sz : 0;
  // The rotation block, column-major: r[c*3 + r].
  const r00 = m[at + 0] * ix, r10 = m[at + 1] * ix, r20 = m[at + 2] * ix;
  const r01 = m[at + 4] * iy, r11 = m[at + 5] * iy, r21 = m[at + 6] * iy;
  const r02 = m[at + 8] * iz, r12 = m[at + 9] * iz, r22 = m[at + 10] * iz;

  const trace = r00 + r11 + r22;
  if (trace > 0) {
    const s = Mathf.sqrt(trace + 1) * 2;
    out.rw = 0.25 * s;
    out.rx = (r21 - r12) / s;
    out.ry = (r02 - r20) / s;
    out.rz = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Mathf.sqrt(1 + r00 - r11 - r22) * 2;
    out.rw = (r21 - r12) / s;
    out.rx = 0.25 * s;
    out.ry = (r01 + r10) / s;
    out.rz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Mathf.sqrt(1 + r11 - r00 - r22) * 2;
    out.rw = (r02 - r20) / s;
    out.rx = (r01 + r10) / s;
    out.ry = 0.25 * s;
    out.rz = (r12 + r21) / s;
  } else {
    const s = Mathf.sqrt(1 + r22 - r00 - r11) * 2;
    out.rw = (r10 - r01) / s;
    out.rx = (r02 + r20) / s;
    out.ry = (r12 + r21) / s;
    out.rz = 0.25 * s;
  }
}
