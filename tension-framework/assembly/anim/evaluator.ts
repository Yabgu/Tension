// The three operations the reference's runtime performs on the archives the parser reads:
// Compatible with ozz-animation's runtime archive format (MIT,
// github.com/guillaumeblanc/ozz-animation). That names the format, not this code.
// sample a clip at a time, blend samples, and walk the skeleton to model space.
//
// Each mirrors the the reference job it is named after, and the mirrors were checked
// against the reference's own output rather than against the documentation:
//
//   * **Sampling** — `SamplingJob`. Clamp the ratio to [0, 1],
//     find the key pair bracketing it inside each track's own key series
//     (translations, rotations and scales have *different* key counts for the
//     same joint, so each is bracketed separately), then interpolate: linear for
//     translation and scale, normalized lerp for rotation. the reference interpolates with
//     an estimated reciprocal (`RcpEst`) and normalizes with an estimated rsqrt;
//     this uses exact division and `Mathf.sqrt`. The difference is the reference's own
//     approximation error — measured at ~1e-5 on the fixtures, and in this
//     direction: an exact evaluator is closer to the keyframes than animation is.
//   * **Blending** — `BlendingJob`. Weights are normalized by
//     their sum, translation and scale are weighted sums, and the rotation is a
//     weighted sum of quaternions with opposed signs flipped to the shortest
//     path, normalized once at the end (nlerp across N samples).
//   * **Local to model** — `LocalToModelJob`. Each joint's local
//     matrix from its TRS, then multiplied by its parent's model matrix, walking
//     in index order (the format stores joints depth-first, so a parent is
//     always before its children).
//
// **What is deliberately not here**, because the reference's jobs do not do it either: the
// skeleton's **rest pose plays no part in local-to-model**. It is tempting to
// read the rest pose as a base the animation is a delta on top of, but the reference's
// `LocalToModelJob` takes only the animated locals — no rest pose, no blend
// against bind — and the probe's ground truth is that job's output, which this
// file matches. The rest pose *is* a pose, though, so `restPose` hands it out in
// the same shape a sample comes in, which is what a caller needs to blend toward
// it (`SkeletonInstance::resetToPose` and the reference's own samples do exactly that).
//
// **Naming.** the reference calls the sampling output an array of `SoaTransform`: four
// joints packed per record, because its kernels work four lanes at a time. This
// module works one joint at a time — the consumer indexes a bone by joint — so
// its pose is a `BoneTransform[]` of length `slots`, one TRS per slot. Same
// data, per-slot instead of per-lane; `slots` (not `trackCount`) because the
// archive's key arrays cover `Align(trackCount, 4)` slots and the padding slots
// carry the builder's identity keys.
//
// **Blending's threshold.** the reference's `BlendingJob` fills the gap up to a
// `threshold` (default 0.1) with the rest pose, and refuses a job whose
// threshold is not positive. There is no such parameter here: with weights that
// sum to at least the threshold — every case the tests exercise, and the case
// the brief describes ("normalized by their sum") — the reference never reads the rest
// pose at all, and the two agree. A weight set summing to less than 0.1 would
// diverge: the reference would blend the rest pose in, and this would normalize what it
// was given.

import { Animation, AnimationIndex, AnimationSeries, TrackIndex } from "./index";
import { BoneTransform, Float3, Quat } from "./key";
import { Skeleton } from "./skeleton";
import { MAT4_FLOATS, mat4FromTransform, mat4Multiply } from "./matrix";

/** A fresh pose of `slots` identities. */
export function identityPose(slots: i32): BoneTransform[] {
  const pose = new Array<BoneTransform>(slots);
  for (let i = 0; i < slots; i++) pose[i] = new BoneTransform();
  return pose;
}

/** The pose array a call should write into: the caller's when it fits, else a
 * fresh one. Keeps a per-frame caller allocation-free without trusting a
 * wrong-sized buffer. */
function poseBuffer(out: BoneTransform[] | null, slots: i32): BoneTransform[] {
  if (out !== null && out.length >= slots) {
    for (let i = 0; i < slots; i++) {
      if (out[i] === null) out[i] = new BoneTransform();
      else out[i].identity();
    }
    return out;
  }
  return identityPose(slots);
}

/** One component's linear interpolation, in the reference's own association
 * (`a + (b - a) * f`, not `a * (1 - f) + b * f`). */
@inline function lerp(a: f32, b: f32, f: f32): f32 {
  return a + (b - a) * f;
}

/** A bracket: the two keys around a ratio, and the blend factor between them. */
class Bracket {
  left: i32 = -1;
  right: i32 = -1;
  f: f32 = 0;
}

/**
 * The keys bracketing `ratio` in one series' track, and the factor between them.
 *
 * This is the reference's cache position, computed directly. the reference advances a per-track
 * cursor while the *preceding* key's ratio is at or before the ratio being
 * sampled, which leaves the cursor on the first key after it; the pair it
 * interpolates is that key and the one `previouses` points back to. Both are
 * the same statement: **left is the last key at or before the ratio, right is
 * the next one** — and when the ratio is at or past the last key, the pair is
 * the final two keys with a factor of 1, which is how the reference lands exactly on the
 * last keyframe at the end of a clip.
 */
function bracketOf(
  series: AnimationSeries,
  index: TrackIndex,
  track: i32,
  timepoints: Float32Array,
  ratio: f32,
  out: Bracket,
): void {
  const count = index.keyCount(track);
  out.left = -1;
  out.right = -1;
  out.f = 0;
  if (count <= 0) return;
  if (count == 1) {
    out.left = index.key(track, 0);
    out.right = out.left;
    return;
  }

  let before = -1; // the last key index at or before the ratio
  for (let i = 0; i < count; i++) {
    const key = index.key(track, i);
    if (series.ratio(timepoints, key) <= ratio) before = i;
    else break;
  }

  let leftIndex: i32;
  let rightIndex: i32;
  if (before < 0) {
    leftIndex = 0;
    rightIndex = 1;
  } else if (before >= count - 1) {
    leftIndex = count - 2;
    rightIndex = count - 1;
  } else {
    leftIndex = before;
    rightIndex = before + 1;
  }
  out.left = index.key(track, leftIndex);
  out.right = index.key(track, rightIndex);
  const leftRatio = series.ratio(timepoints, out.left);
  const rightRatio = series.ratio(timepoints, out.right);
  out.f = rightRatio > leftRatio ? (ratio - leftRatio) / (rightRatio - leftRatio) : 0;
}

/**
 * Sample a clip at `ratio` (0..1), matching `SamplingJob`.
 *
 * `out`, when given and large enough, receives the pose; otherwise a new one is
 * allocated. The result has one transform per slot, padding slots included —
 * their keys are the identity keys the builder wrote, so they come out as the
 * identity without a special case.
 *
 * Every track is sampled independently: three brackets per slot, one per series,
 * because the series hold different numbers of keys.
 */
export function sampleRatio(
  animation: Animation,
  index: AnimationIndex,
  ratio: f32,
  out: BoneTransform[] | null = null,
): BoneTransform[] {
  const slots = animation.slots;
  const pose = poseBuffer(out, slots);
  if (slots <= 0 || animation.trackCount <= 0) return pose;

  // The clamp is written with explicit f32 literals: an untagged `0`/`1` in a
  // conditional types the whole expression as i32, and every use of it below
  // would then need a cast.
  const clamped: f32 = ratio < 0 ? <f32>0 : (ratio > 1 ? <f32>1 : ratio);
  const timepoints = animation.timepoints;

  const bracket = new Bracket();
  const left3 = new Float3();
  const right3 = new Float3();
  const leftQ = new Quat();
  const rightQ = new Quat();

  for (let slot = 0; slot < slots; slot++) {
    const target = pose[slot];

    // Translation: two half-float keys, lerped.
    bracketOf(animation.translations, index.translations, slot, timepoints, clamped, bracket);
    if (bracket.left >= 0) {
      animation.translationAt(bracket.left, left3);
      animation.translationAt(bracket.right, right3);
      target.tx = lerp(left3.x, right3.x, bracket.f);
      target.ty = lerp(left3.y, right3.y, bracket.f);
      target.tz = lerp(left3.z, right3.z, bracket.f);
    }

    // Rotation: two unpacked quaternions, lerped and normalized.
    bracketOf(animation.rotations, index.rotations, slot, timepoints, clamped, bracket);
    if (bracket.left >= 0) {
      animation.rotationAt(bracket.left, leftQ);
      animation.rotationAt(bracket.right, rightQ);
      const x = lerp(leftQ.rx, rightQ.rx, bracket.f);
      const y = lerp(leftQ.ry, rightQ.ry, bracket.f);
      const z = lerp(leftQ.rz, rightQ.rz, bracket.f);
      const w = lerp(leftQ.rw, rightQ.rw, bracket.f);
      const length2 = x * x + y * y + z * z + w * w;
      let inverse: f32 = 0;
      if (length2 > 0) inverse = 1 / Mathf.sqrt(length2);
      target.rx = x * inverse;
      target.ry = y * inverse;
      target.rz = z * inverse;
      target.rw = w * inverse;
    }

    // Scale: as the translation.
    bracketOf(animation.scales, index.scales, slot, timepoints, clamped, bracket);
    if (bracket.left >= 0) {
      animation.scaleAt(bracket.left, left3);
      animation.scaleAt(bracket.right, right3);
      target.sx = lerp(left3.x, right3.x, bracket.f);
      target.sy = lerp(left3.y, right3.y, bracket.f);
      target.sz = lerp(left3.z, right3.z, bracket.f);
    }
  }
  return pose;
}

/**
 * Sample a clip at `time` seconds: the same operation with the time turned into
 * a ratio first.
 *
 * The time is clamped to `[0, duration]`, so a caller may pass an accumulator
 * that ran past the end. A zero-length clip samples at ratio 0 rather than
 * dividing by zero.
 */
export function sample(
  animation: Animation,
  index: AnimationIndex,
  time: f32,
  out: BoneTransform[] | null = null,
): BoneTransform[] {
  const duration = animation.duration;
  const ratio: f32 = duration > 0 ? time / duration : 0;
  return sampleRatio(animation, index, ratio, out);
}

/**
 * Blend `poses` with `weights`, matching `BlendingJob` for weights that sum to
 * at least the reference's threshold (see the header for what that excludes).
 *
 * The first contributing layer is copied scaled by its weight; each later one is
 * accumulated the same way, with the incoming rotation negated when it points
 * away from the accumulator (`Sign(Dot(out, in))` — the shortest path). Then
 * the whole thing is divided by the total weight, with the rotation normalized
 * rather than divided (a quaternion's length is not its weight).
 *
 * Layers with a weight of zero or less are skipped, as the reference skips them — and a
 * caller that passes only such layers gets the first pose unchanged, which is
 * the one case the reference cannot express without a rest pose.
 */
export function blend(
  poses: BoneTransform[][],
  weights: f32[],
  out: BoneTransform[] | null = null,
): BoneTransform[] {
  const layers = poses.length < weights.length ? poses.length : weights.length;
  if (layers == 0) return new Array<BoneTransform>(0);

  const slots = poses[0].length;
  const result = poseBuffer(out, slots);

  let accumulated: f32 = 0;
  let passes: i32 = 0;
  for (let layer = 0; layer < layers; layer++) {
    const weight = weights[layer];
    if (!(weight > 0)) continue; // NaN-safe, and the reference skips these too
    const pose = poses[layer];
    accumulated += weight;

    for (let slot = 0; slot < slots; slot++) {
      const source = pose[slot];
      const target = result[slot];
      if (passes == 0) {
        target.tx = source.tx * weight;
        target.ty = source.ty * weight;
        target.tz = source.tz * weight;
        target.rx = source.rx * weight;
        target.ry = source.ry * weight;
        target.rz = source.rz * weight;
        target.rw = source.rw * weight;
        target.sx = source.sx * weight;
        target.sy = source.sy * weight;
        target.sz = source.sz * weight;
      } else {
        target.tx += source.tx * weight;
        target.ty += source.ty * weight;
        target.tz += source.tz * weight;
        target.sx += source.sx * weight;
        target.sy += source.sy * weight;
        target.sz += source.sz * weight;
        const dot =
          target.rx * source.rx + target.ry * source.ry + target.rz * source.rz +
          target.rw * source.rw;
        const sign: f32 = dot < 0 ? -weight : weight;
        target.rx += source.rx * sign;
        target.ry += source.ry * sign;
        target.rz += source.rz * sign;
        target.rw += source.rw * sign;
      }
    }
    passes++;
  }

  if (passes == 0) {
    // Nothing contributed. the reference reaches for its rest pose here; this hands back
    // the first pose, which is the only other thing a caller could have meant.
    for (let slot = 0; slot < slots; slot++) {
      const source = poses[0][slot];
      const target = result[slot];
      target.tx = source.tx;
      target.ty = source.ty;
      target.tz = source.tz;
      target.rx = source.rx;
      target.ry = source.ry;
      target.rz = source.rz;
      target.rw = source.rw;
      target.sx = source.sx;
      target.sy = source.sy;
      target.sz = source.sz;
    }
    return result;
  }

  const inverse: f32 = <f32>1 / accumulated;
  for (let slot = 0; slot < slots; slot++) {
    const target = result[slot];
    target.tx *= inverse;
    target.ty *= inverse;
    target.tz *= inverse;
    target.sx *= inverse;
    target.sy *= inverse;
    target.sz *= inverse;
    const length2 =
      target.rx * target.rx + target.ry * target.ry + target.rz * target.rz + target.rw * target.rw;
    let normalize: f32 = 0;
    if (length2 > 0) normalize = 1 / Mathf.sqrt(length2);
    target.rx *= normalize;
    target.ry *= normalize;
    target.rz *= normalize;
    target.rw *= normalize;
  }
  return result;
}

/**
 * The skeleton's rest pose, in the shape `sample` returns.
 *
 * This is the only way the parser's rest-pose data reaches a caller: the reference's
 * local-to-model does not read it (see the header), but a game that blends a
 * clip in at partial weight wants exactly this as the other layer, and a
 * renderer's bind pose is this pose through `localToModel`.
 */
export function restPose(skeleton: Skeleton, out: BoneTransform[] | null = null): BoneTransform[] {
  const slots = skeleton.jointCount;
  const pose = poseBuffer(out, slots);
  for (let joint = 0; joint < slots; joint++) {
    skeleton.restTransformInto(joint, pose[joint]);
  }
  return pose;
}

/**
 * The model-space matrix of every joint: `LocalToModelJob`.
 *
 * One matrix per **joint** (`jointCount`, not `slots`), which is the reference's own
 * output size — its `Validate` asks for `output.size() >= num_joints` and its
 * walk stops there. The result is a flat array of `jointCount * 16` floats,
 * column-major (see `matrix.ts`): joint `j` occupies `j * 16 .. j * 16 + 15`.
 *
 * The walk is in index order. The format stores joints depth-first, so a
 * parent's matrix is always already computed when its children are reached; a
 * parent index that is not smaller than the joint's own (a malformed hierarchy)
 * leaves the joint's local matrix in place rather than reading uninitialized
 * memory.
 */
export function localToModel(
  skeleton: Skeleton,
  pose: BoneTransform[],
  out: Float32Array | null = null,
): Float32Array {
  const joints = skeleton.jointCount;
  const needed = joints * MAT4_FLOATS;
  const result = out !== null && out.length >= needed ? out : new Float32Array(needed);
  const scratch = new Float32Array(MAT4_FLOATS);

  for (let joint = 0; joint < joints; joint++) {
    const at = joint * MAT4_FLOATS;
    mat4FromTransform(pose[joint], result, at);

    const parent = skeleton.parent(joint);
    if (parent < 0 || parent >= joint) continue; // root, or a malformed parent
    mat4Multiply(result, result, scratch, parent * MAT4_FLOATS, at, 0);
    for (let i = 0; i < MAT4_FLOATS; i++) result[at + i] = scratch[i];
  }
  return result;
}
