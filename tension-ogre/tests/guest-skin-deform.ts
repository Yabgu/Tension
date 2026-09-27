// Does skinning deform, or does it only move things? (chunk 19, round 19g.)
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-skin-deform.wasm --renderer=gl3plus
//
// The fixtures before this one prove the path: guests submit matrices, the
// matrices reach the buffer, and each vertex reads the matrix for its own
// influence (the IndexMap fix). None of them proves the last thing — that a
// **shape** change shows up as a shape change. A rigid translation of every
// bone is indistinguishable from moving the object, so it cannot tell a working
// skinned read from a read that ignores the weights.
//
// Three runs in one process, same window, same camera:
//
//   A BASELINE  every joint identity
//   B RIGID     every joint translated by (2, 0, 0)
//   C DEFORM    every joint identity except joint 19 scaled by 2
//
// and three statistics on the non-background pixels: count, centroid, and the
// mean squared distance from the centroid. A rigid move preserves the variance
// — the silhouette is the same shape, somewhere else — and moves the centroid.
// A deformation changes the variance. That pair is the discriminator.
//
// Joint **19** is not arbitrary: characterMedium's IndexMap has 32 entries over
// 58 joints and starts {19, 20, 21, ...}, so joint 19 is the first joint any
// vertex is weighted to (measured in round 19f, which is also what exposed the
// index-order bug).

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { SkinMatrixBatch } from "../../tension-framework/assembly/ogre/skin";
import {
  JOB_DONE,
  JOB_FAILED,
  CameraRecord,
  Material,
  Renderable,
} from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
const MESH_SCALE: f32 = 0.29;
const RIG_BONES: u32 = 58;
/// The first joint the mesh's IndexMap reports as influencing a vertex.
const FIRST_INFLUENCING_JOINT: u32 = 19;
/// The translation every joint carries in the RIGID run, in world units.
/// 0.4, not 2.0: the camera sees +/-7.73 units across the frame, and a 2-unit
/// move pushed the mesh past the right edge, where clipping changed the
/// silhouette and the variance for a reason that had nothing to do with
/// skinning (measured: count 5402 -> 4049, variance ratio 0.887).
const RIGID_SHIFT: f32 = 0.4;
/// The scale joint 19 carries in the DEFORM run.
const DEFORM_SCALE: f32 = 2.0;

/** A rigid move must move the centroid by at least this much (pixels). */
const CENTROID_MIN_DX: f64 = 20.0;
/** A rigid move must leave the aligned shape this close to the baseline. */
const IOU_RIGID_MIN: f64 = 0.95;
/** A deformation must drop the aligned overlap below this. */
const IOU_DEFORM_MAX: f64 = 0.90;

const RUN_BASELINE: u32 = 0;
const RUN_RIGID: u32 = 1;
const RUN_DEFORM: u32 = 2;

/// The three statistics one frame yields.
class Stats {
  count: f64 = 0.0;
  cx: f64 = 0.0;
  cy: f64 = 0.0;
  variance: f64 = 0.0;
  /// The foreground mask, for the shape comparison.
  mask: Uint8Array = new Uint8Array(WINDOW_WIDTH * WINDOW_HEIGHT);
}

let clause = 0;
let total = 3;

function fail(reason: string): void {
  print("DEFORM " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

function settle(job: i32): void {
  for (let guard: u32 = 0;
       guard < 400 && ogre.jobState(job) != JOB_DONE && ogre.jobState(job) != JOB_FAILED;
       guard++) {
    RuntimeSession.wait(5);
  }
}

/// A frame, waited for the way guest-skin-matrices.ts waits: the screenshot verb
/// is probe/consume over the last frame, so reading twice in a row returns the
/// first one's pixels.
function grab(): ArrayBuffer | null {
  const armed_at = ogre.frameCount();
  ogre.screenshot(0, 0);
  for (let guard: u32 = 0; guard < 300 && ogre.frameCount() < armed_at + 3; guard++) {
    RuntimeSession.wait(5);
  }
  const length = ogre.screenshot(0, 0);
  if (length <= 0) return null;
  const frame = new ArrayBuffer(length);
  if (ogre.screenshot(changetype<usize>(frame), length) != length) return null;
  return frame;
}

/// Foreground is "differs from the frame's own corner", the rule the fixtures
/// share (a mesh drawn black and a mesh not drawn at all are the same number
/// under a brightness test).
function is_foreground(pixels: Uint8Array, x: i32, y: i32): bool {
  const at = <usize>((y * WINDOW_WIDTH + x) * 4);
  const bg0 = pixels[0];
  const bg1 = pixels[1];
  const bg2 = pixels[2];
  const d0 = <i32>pixels[at] - <i32>bg0;
  const d1 = <i32>pixels[at + 1] - <i32>bg1;
  const d2 = <i32>pixels[at + 2] - <i32>bg2;
  return abs(d0) > 8 || abs(d1) > 8 || abs(d2) > 8;
}

/// Count, centroid and the mean squared distance from it, over the
/// non-background pixels. The variance is the one that tells a shape change from
/// a move: it is measured around the run's own centroid, so translating every
/// pixel leaves it alone.
function measure(frame: ArrayBuffer): Stats {
  const pixels = Uint8Array.wrap(frame);
  const out = new Stats();
  let sumX: f64 = 0.0;
  let sumY: f64 = 0.0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      if (!is_foreground(pixels, x, y)) continue;
      out.mask[<usize>(y * WINDOW_WIDTH + x)] = 1;
      out.count += 1.0;
      sumX += <f64>x;
      sumY += <f64>y;
    }
  }
  if (out.count <= 0.0) return out;
  out.cx = sumX / out.count;
  out.cy = sumY / out.count;
  let spread: f64 = 0.0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      if (!is_foreground(pixels, x, y)) continue;
      const dx: f64 = <f64>x - out.cx;
      const dy: f64 = <f64>y - out.cy;
      spread += dx * dx + dy * dy;
    }
  }
  out.variance = spread / out.count;
  return out;
}

/// Intersection over union of two masks once `b` has been shifted so its
/// centroid lands on `a`'s. This is the statistic that can see a deformation:
/// it compares shapes rather than extents, so it does not care how much of the
/// mesh a joint owns — which is what the second-moment variance could not do
/// (measured: 1.071 for one joint scaled by 3, 1.067 for three scaled by 2,
/// both flat against a 0.15 floor).
function iou_aligned(a: Stats, b: Stats): f64 {
  const shiftX: i32 = <i32>Math.round(a.cx - b.cx);
  const shiftY: i32 = <i32>Math.round(a.cy - b.cy);
  let intersection: f64 = 0.0;
  let union: f64 = 0.0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      const inA: bool = a.mask[<usize>(y * WINDOW_WIDTH + x)] != 0;
      const bx: i32 = x - shiftX;
      const by: i32 = y - shiftY;
      const inB: bool = bx >= 0 && bx < WINDOW_WIDTH && by >= 0 && by < WINDOW_HEIGHT &&
                        b.mask[<usize>(by * WINDOW_WIDTH + bx)] != 0;
      if (inA && inB) intersection += 1.0;
      if (inA || inB) union += 1.0;
    }
  }
  return union > 0.0 ? intersection / union : 0.0;
}

/// One 4x4 matrix per joint, identity, column-major.
function identity_rig(): Float32Array {
  const matrices = new Float32Array(RIG_BONES * 16);
  for (let joint: u32 = 0; joint < RIG_BONES; joint++) {
    const at = joint * 16;
    matrices[at + 0] = 1.0;
    matrices[at + 5] = 1.0;
    matrices[at + 10] = 1.0;
    matrices[at + 15] = 1.0;
  }
  return matrices;
}

/// Every joint the same rigid translation: the silhouette moves, its shape does
/// not. This is the control that a working skinned read must not confuse with a
/// deformation.
function rigid_rig(x: f32, y: f32, z: f32): Float32Array {
  const matrices = identity_rig();
  for (let joint: u32 = 0; joint < RIG_BONES; joint++) {
    const at = joint * 16;
    matrices[at + 12] = x;
    matrices[at + 13] = y;
    matrices[at + 14] = z;
  }
  return matrices;
}

/// The joints the DEFORM run scales: the first three the IndexMap reports as
/// influencing the mesh (measured: the map starts {19, 20, 21, 22, ...}). Three
/// rather than one because coverage is what a global second moment measures —
/// one joint moves too little of the silhouette to register (measured: a single
/// joint scaled by 3 gave a variance ratio of 1.071 against a 1.15 floor).
const DEFORM_JOINTS: u32[] = [19, 20, 21];

/// Those joints scaled about their own origins: the vertices weighted to them
/// move away from them, so the silhouette changes shape rather than position.
function deform_rig(joints: u32[], scale: f32): Float32Array {
  const matrices = identity_rig();
  const count: u32 = <u32>joints.length;
  for (let k: u32 = 0; k < count; k++) {
    const at = joints[k] * 16;
    matrices[at + 0] = scale;
    matrices[at + 5] = scale;
    matrices[at + 10] = scale;
  }
  return matrices;
}

/// Send one renderable's matrices and return what the verb returned.
function submit_matrices(renderable_id: u32, matrices: Float32Array): i32 {
  const batch = new SkinMatrixBatch();
  if (!batch.set(0, renderable_id, matrices)) fail("the batch refused the entry");
  return batch.commit();
}

/// Submit a rig, let the frame settle, grab it, and measure it.
function run_case(renderable_id: u32, matrices: Float32Array, label: string): Stats {
  check(submit_matrices(renderable_id, matrices) == 1,
        "submit_skin_matrices refused the " + label + " rig");
  // One batch per frame: the fill copies the record every frame, so the new
  // matrices need a frame to land before the grab.
  for (let settleFrames: u32 = 0; settleFrames < 3; settleFrames++) RuntimeSession.wait(16);
  const frame = grab();
  check(frame !== null, "no frame was delivered for the " + label + " run");
  return measure(<ArrayBuffer>frame);
}

export function _start(): void {
  let tns = "";
  let gl3plus = false;
  for (let i: i32 = 0; i < argCount(); i++) {
    const a = arg(i);
    if (a.startsWith("--tns=")) tns = a.substring(6);
    else if (a == "--renderer=gl3plus") gl3plus = true;
  }

  // The session comes first — every verb goes through it. Without it the
  // adapter is driven in a state it was never built for: the renderer starts
  // with the default render-system name, fails, and the mesh load never
  // progresses (the same failure guest-skin-matrices hit in round 19c).
  const callbacks = makeCallbacks(null, null);
  const session = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session, callbacks) == 0, "session_open refused");

  const config = new ogre.ConfigBuilder()
      .renderer(gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
      .headless(!gl3plus)
      .vsync(false)
      .frameHz(60)
      .windowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  assert(ogre.init(config) == 0, "ogre::init refused the config");
  assert(tns.length > 0, "no --tns=<volume> argument (run through tests/run.sh)");
  assert(ogre.mountTns("resources", tns) == 0, "mountTns refused");
  ogre.assertSubmissionRegions();

  const job = ogre.queueMeshLoad("resources/meshes/characterMedium.mesh", 0);
  check(job > 0, "queueMeshLoad did not return a job id");
  settle(job);
  check(ogre.jobState(job) == JOB_DONE, "characterMedium.mesh did not reach DONE");
  const mesh = ogre.jobResult(job);
  check(mesh > 0 && ogre.isRigged(mesh) && ogre.boneCount(mesh) == RIG_BONES,
        "the rig is not the expected rigged mesh");

  const material = Material.pbs(0.0, 0.0, 0.0, 1.0, 0.0);
  material.materialId = 1;
  material.specularR = 0.0;
  material.specularG = 0.0;
  material.specularB = 0.0;
  material.emissiveR = 0.9;
  material.emissiveG = 0.2;
  material.emissiveB = 0.2;
  check(ogre.submitMaterial(material) == 0, "submitting the material was refused");

  const camera = CameraRecord.perspective(0.7853982, 4.0 / 3.0, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  check(ogre.submitCamera(camera) == 0, "submitting the camera was refused");

  const hero = Renderable.at(mesh, 1, 0.0, 0.0, 0.0, MESH_SCALE);
  hero.renderableId = 1;
  check(ogre.submitRenderable(hero) == 0, "submitting the renderable was refused");
  for (let warmup: u32 = 0; warmup < 12; warmup++) RuntimeSession.wait(16);

  // ── the three runs ───────────────────────────────────────────────────
  const a = run_case(1, identity_rig(), "A");
  print("MATRICES-A count=" + a.count.toString() + " cx=" + a.cx.toString() +
        " cy=" + a.cy.toString() + " var=" + a.variance.toString());

  const b = run_case(1, rigid_rig(RIGID_SHIFT, 0.0, 0.0), "B");
  print("MATRICES-B count=" + b.count.toString() + " cx=" + b.cx.toString() +
        " cy=" + b.cy.toString() + " var=" + b.variance.toString());

  const c = run_case(1, deform_rig(DEFORM_JOINTS, DEFORM_SCALE), "C");
  print("MATRICES-C count=" + c.count.toString() + " cx=" + c.cx.toString() +
        " cy=" + c.cy.toString() + " var=" + c.variance.toString());

  const rigidDx: f64 = b.cx - a.cx;
  const iouRigid: f64 = iou_aligned(a, b);
  const iouDeform: f64 = iou_aligned(a, c);
  print("DEFORM iou-rigid=" + iouRigid.toString() + " iou-deform=" +
        iouDeform.toString() + " rigid-centroid-dx=" + rigidDx.toString());

  // ── the discriminating assertions ────────────────────────────────────
  clause = 1;
  check(abs(rigidDx) > CENTROID_MIN_DX,
        "the rigid run moved the centroid by " + rigidDx.toString() +
        " px, under the floor of " + CENTROID_MIN_DX.toString());
  check(rigidDx > 0.0, "the rigid run moved the centroid left, not right");
  check(iouRigid > IOU_RIGID_MIN,
        "the rigid run changed the shape: IoU " + iouRigid.toString() + " is under " +
        IOU_RIGID_MIN.toString());

  clause = 2;
  check(iouDeform < IOU_DEFORM_MAX,
        "the deform run kept the shape: IoU " + iouDeform.toString() + " is over " +
        IOU_DEFORM_MAX.toString() + " — the scaled joints did not change the silhouette");

  clause = 3;
  check(a.count > 0.0 && b.count > 0.0 && c.count > 0.0,
        "a run rendered no pixels at all");

  print("OK");
}
