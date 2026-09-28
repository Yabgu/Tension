// The the reference evaluator, against the reference's own runtime.
// Compatible with ozz-animation's runtime archive format (MIT,
// github.com/guillaumeblanc/ozz-animation). That names the format, not this code.
//
// Four verifications, each comparing this implementation's output to numbers a
// C++ tool produced by calling the reference's own jobs on the same fixture pair (see
// `the reference-eval-expectations.ts` for how those literals were made):
//
//   A. **Sampling** — `SamplingJob` at ratios 0, 0.05, 0.25, 0.5, 0.999, 1, every
//      slot's translation, rotation and scale.
//   B. **Blending** — `BlendingJob` of the 0.0 and 0.5 samples at weights
//      (0.5, 0.5) and (0.25, 0.75), every slot.
//   C. **Local to model** — `LocalToModelJob` on the 0.25 sample, every joint's
//      sixteen floats, plus the layout check that says out loud where the
//      translation lives in a matrix.
//   D. **The rest pose** — `LocalToModelJob` on the skeleton's rest poses, every
//      joint. This is the only path the parser's rest-pose data travels, since
//      the reference's local-to-model does not read it.
//
// Plus a small E: the time-based wrapper over the ratio-based sampler, including
// both clamps. the reference's own entry point takes a ratio, so that is what the ground
// truth pins; `sample(time)` is this SDK's shape and is checked against it.
//
// On tolerances. The implementations are not bit-identical and cannot be: the reference
// finishes its quaternion decode and its normalization with *estimated*
// reciprocals (`_mm_rsqrt_ps` on SSE, a bit-trick seed plus Newton steps in the
// reference build) where this uses exact division and `Mathf.sqrt`. The
// difference is the reference's own approximation error, in this direction — an exact
// evaluator is closer to the keyframes than animation is. The measured headroom is
// printed by every run, so a tolerance that is too loose is visible rather than
// assumed; a wrong bracket choice or a transposed matrix misses by 1e-2 or more,
// which is four orders of magnitude outside these bounds.
//
// Like the parser fixture this is a plain module: no session, no capability,
// `print` and nothing else.

import { print } from "../assembly/io";
import {
  Animation,
  AnimationIndex,
  BoneTransform,
  Skeleton,
  blend,
  indexAnimation,
  localToModel,
  restPose,
  sample,
  sampleRatio,
  verifyAnimationIndex,
} from "../assembly/the reference";
import { fixtureBytes, fnv1a, fixtureFnv } from "./the reference-fixtures";
import { EvalExpect, MATRIX_FLOATS, POSE_FLOATS, evalExpect } from "./the reference-eval-expectations";

/** Acceptable error against the reference, per component class.
 *
 * The brief's numbers, and they hold: translations and scales are half-float
 * keys interpolated linearly, where this implementation is exact and the reference's only
 * inexactness is its estimated reciprocal for the blend factor (measured worst:
 * 7.2e-7 for a translation, 0 for a scale, over 6 ratios x 68 slots); rotations
 * carry the reference's estimated rsqrt for the quaternion's fourth component (measured
 * worst: 6.6e-5, so this is the tightest of the three). */
const TOLERANCE_TRANSLATION: f32 = 1e-5;
const TOLERANCE_ROTATION: f32 = 1e-4;
const TOLERANCE_SCALE: f32 = 1e-5;
/** Whole-pipeline local-to-model: this inherits the reference's *sampling* error and the
 * hierarchy amplifies it (measured: the 6.6e-5 rotation delta becomes 2.36e-4
 * in a joint-23 matrix element over a 67-joint chain). The walk's own error is
 * `TOLERANCE_WALK`, three orders below this. */
const TOLERANCE_MATRIX: f32 = 5e-4;
/** The walk alone, fed the reference's own pose: pure float arithmetic, no estimates
 * (measured worst: 3.6e-7). */
const TOLERANCE_WALK: f32 = 1e-5;
/** The time wrapper divides by the duration and multiplies back, so it is
 * allowed one rounding more than the ratio path (measured: 0). */
const TOLERANCE_TIME_WRAPPER: f32 = 1e-5;

/** Where a comparison's worst disagreement came from, and how big it was. */
class Worst {
  translation: f32 = 0;
  rotation: f32 = 0;
  scale: f32 = 0;
  matrix: f32 = 0;
  where: string = "";
}

/** One line of a comparison: which classes, and where the worst was. */
function report(label: string, passed: bool, detail: string): void {
  print("the reference-eval: " + label + (passed ? " PASS " : " FAIL ") + detail);
}

/** The larger of two values, for accumulating maxima. */
@inline function maxf(a: f32, b: f32): f32 {
  return a > b ? a : b;
}

/**
 * Compare a pose against the tool's flat pose, accumulating the worst
 * disagreement per component class.
 */
function comparePose(expected: f32[], pose: BoneTransform[], slots: i32, worst: Worst): i32 {
  let failures = 0;
  for (let slot = 0; slot < slots; slot++) {
    const at = slot * POSE_FLOATS;
    const got = pose[slot];

    const dt = maxf(
      maxf(Mathf.abs(got.tx - expected[at + 0]), Mathf.abs(got.ty - expected[at + 1])),
      Mathf.abs(got.tz - expected[at + 2]),
    );
    if (dt > TOLERANCE_TRANSLATION) {
      failures++;
      worst.where = "slot " + slot.toString() + " translation";
    }
    worst.translation = maxf(worst.translation, dt);

    const dr = maxf(
      maxf(Mathf.abs(got.rx - expected[at + 3]), Mathf.abs(got.ry - expected[at + 4])),
      maxf(Mathf.abs(got.rz - expected[at + 5]), Mathf.abs(got.rw - expected[at + 6])),
    );
    if (dr > TOLERANCE_ROTATION) {
      failures++;
      worst.where = "slot " + slot.toString() + " rotation";
    }
    worst.rotation = maxf(worst.rotation, dr);

    const ds = maxf(
      maxf(Mathf.abs(got.sx - expected[at + 7]), Mathf.abs(got.sy - expected[at + 8])),
      Mathf.abs(got.sz - expected[at + 9]),
    );
    if (ds > TOLERANCE_SCALE) {
      failures++;
      worst.where = "slot " + slot.toString() + " scale";
    }
    worst.scale = maxf(worst.scale, ds);
  }
  return failures;
}

/** A pose built from a flat expectation pose (the tool's own numbers). */
function poseFromFlat(flat: f32[], slots: i32): BoneTransform[] {
  const pose = new Array<BoneTransform>(slots);
  for (let slot = 0; slot < slots; slot++) {
    const at = slot * POSE_FLOATS;
    const transform = new BoneTransform();
    transform.tx = flat[at + 0];
    transform.ty = flat[at + 1];
    transform.tz = flat[at + 2];
    transform.rx = flat[at + 3];
    transform.ry = flat[at + 4];
    transform.rz = flat[at + 5];
    transform.rw = flat[at + 6];
    transform.sx = flat[at + 7];
    transform.sy = flat[at + 8];
    transform.sz = flat[at + 9];
    pose[slot] = transform;
  }
  return pose;
}

/** Compare `joints * 16` matrix floats, accumulating the worst element. */
function compareMatrices(expected: f32[], got: Float32Array, joints: i32, worst: Worst): i32 {
  let failures = 0;
  for (let joint = 0; joint < joints; joint++) {
    for (let i = 0; i < MATRIX_FLOATS; i++) {
      const at = joint * MATRIX_FLOATS + i;
      const d = Mathf.abs(got[at] - expected[at]);
      if (d > TOLERANCE_MATRIX) {
        failures++;
        if (d > worst.matrix) {
          worst.matrix = d;
          worst.where = "joint " + joint.toString() + " element " + i.toString();
        }
      } else {
        worst.matrix = maxf(worst.matrix, d);
      }
    }
  }
  return failures;
}

export function _start_game(): void {
  const skeletonBytes = fixtureBytes("skeleton_v2_le");
  const animationBytes = fixtureBytes("animation_v7_le");
  assert(
    fnv1a(skeletonBytes) == fixtureFnv("skeleton_v2_le"),
    "the skeleton fixture's hash does not match the generator's",
  );
  assert(
    fnv1a(animationBytes) == fixtureFnv("animation_v7_le"),
    "the animation fixture's hash does not match the generator's",
  );

  const skeleton = Skeleton.parse(skeletonBytes);
  assert(skeleton.error == "", "the skeleton was refused: " + skeleton.error);
  const animation = Animation.parse(animationBytes);
  assert(animation.error == "", "the animation was refused: " + animation.error);
  const index = indexAnimation(animation);
  const problem = verifyAnimationIndex(animation, index);
  assert(problem == "", "the track index is not sound: " + problem);

  const expect = evalExpect();
  assert(
    skeleton.jointCount == expect.joints,
    "the fixture pair changed: " + skeleton.jointCount.toString() + " joints, expectations say " +
      expect.joints.toString(),
  );
  assert(
    animation.slots == expect.slots,
    "the fixture pair changed: " + animation.slots.toString() + " slots, expectations say " +
      expect.slots.toString(),
  );
  assert(
    animation.duration == expect.duration,
    "the fixture pair changed: duration " + animation.duration.toString(),
  );

  let failures = 0;
  failures += verifySampling(animation, index, expect);
  failures += verifyBlending(animation, index, expect);
  failures += verifyLocalToModel(skeleton, animation, index, expect);
  failures += verifyRestPose(skeleton, expect);
  failures += verifyTimeWrapper(animation, index, expect);

  assert(
    failures == 0,
    "the evaluator disagrees with the reference in " + failures.toString() + " comparison(s)",
  );
  print("OK");
}

// ── A. sampling ─────────────────────────────────────────────────────────────

function verifySampling(animation: Animation, index: AnimationIndex, expect: EvalExpect): i32 {
  const worst = new Worst();
  let failures = 0;
  const slots = animation.slots;
  for (let i = 0; i < expect.ratios.length; i++) {
    const pose = sampleRatio(animation, index, expect.ratios[i]);
    failures += comparePose(expect.sampling[i], pose, slots, worst);
  }
  report(
    "A sampling",
    failures == 0,
    expect.ratios.length.toString() + " ratios x " + slots.toString() +
      " slots; worst |delta| t=" + worst.translation.toString() + " r=" +
      worst.rotation.toString() + " s=" + worst.scale.toString() + " (tol " +
      TOLERANCE_TRANSLATION.toString() + ")" +
      (failures > 0 ? "; first miss " + worst.where : ""),
  );
  return failures;
}

// ── B. blending ─────────────────────────────────────────────────────────────

function verifyBlending(animation: Animation, index: AnimationIndex, expect: EvalExpect): i32 {
  const slots = animation.slots;
  // The two samples the reference's tool blended: the clip's start and its middle.
  const poseStart = sampleRatio(animation, index, 0);
  const poseMiddle = sampleRatio(animation, index, 0.5);
  const layers = new Array<BoneTransform[]>(2);
  layers[0] = poseStart;
  layers[1] = poseMiddle;

  const worst = new Worst();
  let failures = 0;
  for (let i = 0; i < expect.blendWeights.length; i++) {
    const weights = expect.blendWeights[i];
    const blended = blend(layers, weights);
    failures += comparePose(expect.blending[i], blended, slots, worst);
  }
  report(
    "B blending",
    failures == 0,
    expect.blendWeights.length.toString() + " weight sets x " + slots.toString() +
      " slots; worst |delta| t=" + worst.translation.toString() + " r=" +
      worst.rotation.toString() + " s=" + worst.scale.toString() + " (tol " +
      TOLERANCE_TRANSLATION.toString() + ")" +
      (failures > 0 ? "; first miss " + worst.where : ""),
  );
  return failures;
}

// ── C. local to model ───────────────────────────────────────────────────────

function verifyLocalToModel(
  skeleton: Skeleton,
  animation: Animation,
  index: AnimationIndex,
  expect: EvalExpect,
): i32 {
  // The ratio the tool walked: 0.25, the third of its six.
  const ratio = expect.ratios[2];
  const pose = sampleRatio(animation, index, ratio);
  const matrices = localToModel(skeleton, pose);

  const worst = new Worst();
  let failures = compareMatrices(expect.matrices, matrices, skeleton.jointCount, worst);

  // C2: the walk on its own. Feeding this implementation the *tool's* own
  // sampled pose isolates the hierarchy from the sampling that produced its
  // input: whatever the input pose is, the walk of it must match the reference's walk of
  // it. This is the sharp test of the walk (and of the matrix layout); C1 above
  // is the whole pipeline, and inherits the reference's sampling error amplified down the
  // chain — which is why its tolerance is the looser one.
  const toolPose = poseFromFlat(expect.sampling[2], skeleton.jointCount);
  const toolMatrices = localToModel(skeleton, toolPose);
  const walkWorst = new Worst();
  let walkFailures = 0;
  for (let joint = 0; joint < skeleton.jointCount; joint++) {
    for (let i = 0; i < MATRIX_FLOATS; i++) {
      const at = joint * MATRIX_FLOATS + i;
      const d = Mathf.abs(toolMatrices[at] - expect.matrices[at]);
      if (d > TOLERANCE_WALK) {
        walkFailures++;
        walkWorst.where = "joint " + joint.toString() + " element " + i.toString();
      }
      walkWorst.matrix = maxf(walkWorst.matrix, d);
    }
  }
  failures += walkFailures;
  report(
    "C2 walk only",
    walkFailures == 0,
    "the reference's own 0.25 pose through this walk vs the reference's walk: worst |delta| " +
      walkWorst.matrix.toString() + " (tol " + TOLERANCE_WALK.toString() + ")" +
      (walkFailures > 0 ? "; first miss " + walkWorst.where : ""),
  );

  // The layout, asserted rather than assumed: for a root joint whose transform
  // is a pure translation plus rotation, the matrix's fourth row of the 4x4
  // block (indices 3, 7, 11) is zero and the translation is at 12, 13, 14.
  // A row-major matrix would put it at 3, 7, 11.
  const joint0 = skeleton.parent(0) < 0;
  if (joint0) {
    const zeroish =
      Mathf.abs(matrices[3]) < 1e-9 && Mathf.abs(matrices[7]) < 1e-9 &&
      Mathf.abs(matrices[11]) < 1e-9;
    const translationMatches =
      Mathf.abs(matrices[12] - pose[0].tx) < 1e-6 && Mathf.abs(matrices[13] - pose[0].ty) < 1e-6 &&
      Mathf.abs(matrices[14] - pose[0].tz) < 1e-6;
    assert(
      zeroish && translationMatches,
      "the matrix layout is not column-major: joint 0's translation is not at 12..14",
    );
  }

  report(
    "C local-to-model",
    failures == 0,
    skeleton.jointCount.toString() + " joints x 16; worst |delta| " + worst.matrix.toString() +
      " (tol " + TOLERANCE_MATRIX.toString() + "), translation at 12..14 confirmed" +
      (failures > 0 ? "; first miss " + worst.where : ""),
  );
  return failures;
}
// ── D. the rest pose ────────────────────────────────────────────────────────

function verifyRestPose(skeleton: Skeleton, expect: EvalExpect): i32 {
  const pose = restPose(skeleton);
  const matrices = localToModel(skeleton, pose);
  const worst = new Worst();
  const failures = compareMatrices(expect.restMatrices, matrices, skeleton.jointCount, worst);
  report(
    "D rest pose",
    failures == 0,
    skeleton.jointCount.toString() + " joints x 16; worst |delta| " + worst.matrix.toString() +
      " (tol " + TOLERANCE_MATRIX.toString() + ")" + (failures > 0 ? "; first miss " + worst.where : ""),
  );
  return failures;
}

// ── E. the time wrapper ─────────────────────────────────────────────────────

function verifyTimeWrapper(animation: Animation, index: AnimationIndex, expect: EvalExpect): i32 {
  const duration = animation.duration;
  const slots = animation.slots;
  const worst = new Worst();
  let failures = 0;

  // The clamps: past the end and before the start.
  const late = sample(animation, index, duration * 2);
  failures += comparePose(expect.sampling[5], late, slots, worst); // ratio 1
  const early = sample(animation, index, -5);
  failures += comparePose(expect.sampling[0], early, slots, worst); // ratio 0

  // And the same instant reached by time rather than ratio: the two paths agree
  // to one rounding, since the wrapper divides by the duration and the ratio
  // path is handed the result.
  const byTime = sample(animation, index, duration * 0.25);
  const byRatio = sampleRatio(animation, index, 0.25);
  let wrapperDelta: f32 = 0;
  for (let slot = 0; slot < slots; slot++) {
    wrapperDelta = maxf(wrapperDelta, Mathf.abs(byTime[slot].tx - byRatio[slot].tx));
    wrapperDelta = maxf(wrapperDelta, Mathf.abs(byTime[slot].rx - byRatio[slot].rx));
    wrapperDelta = maxf(wrapperDelta, Mathf.abs(byTime[slot].sx - byRatio[slot].sx));
  }
  if (wrapperDelta > TOLERANCE_TIME_WRAPPER) {
    failures++;
    worst.where = "sample(time) vs sampleRatio";
  }
  report(
    "E time wrapper",
    failures == 0,
    "clamped at both ends; sample(time) vs sampleRatio worst |delta| " +
      wrapperDelta.toString() + " (tol " + TOLERANCE_TIME_WRAPPER.toString() + ")",
  );
  return failures;
}
