// The no-skeleton mesh state, end to end (chunk 19 round 19e-b).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-skin-noskel.wasm --renderer=gl3plus \
//       --tns=tension-ogre/build/fixtures-noskel.tns [--mode=stump]
//
// The volume carries `characterMedium.mesh` and no `.skeleton` beside it —
// the state `realise_mesh` refused until 19e-b. The mesh links a skeleton its
// volume does not carry, so it realises with `hasSkeleton=true` and a null
// def: blend data (from the mesh's own bone assignments) with **no**
// `SkeletonInstance`. The base fill takes its skeleton branch off the blend
// map and dereferences the null instance (the :3571 class, measured SIGSEGV in
// the probe), so `apply_renderables` routes the state to
// `HlmsTensionSkinDatablock` — the reproduced per-object block — and refuses
// anything else before a frame can crash.
//
// Two modes, one window each:
//
//   matrix (default)  the guest submits 58 identity matrices; the reproduced
//                     block streams them and the mesh must be visible — the
//                     acceptance test (>3000 foreground px)
//   stump             no matrices are submitted; the state must still be
//                     accepted (no SIGSEGV, a frame delivered) even though
//                     the render is a stump — the loud-failure test
//
// The mesh, the framing and the helpers are guest-skin-matrices.ts's; the one
// difference is what the volume carries.

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
/// guest-skin-matrices.ts's framing for this rig: 3.765 units at scale 1.
const MESH_SCALE: f32 = 0.29;
/// One matrix per joint is what the batch carries (the rig's size).
const RIG_BONES: u32 = 58;
/// The floor on the visible mesh. The probe measured ~10,482 px for the
/// no-skeleton state with matrices at its own framing; the rigged twin
/// measures ~5,400 px at this one. 3,000 is a floor, not an expectation.
const MIN_MATRIX_PIXELS: f64 = 3000.0;

let clause = 0;
let total = 3;

function fail(reason: string): void {
  print("NOSKEL " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

function settle(job: i32): void {
  for (let guard: u32 = 0;
       guard < 400 && ogre.jobState(job) != JOB_DONE && ogre.jobState(job) != JOB_FAILED; guard++) {
    RuntimeSession.wait(5);
  }
}

/// Ask for a frame and wait until a **new** one has been downloaded
/// (guest-skinning.ts's sequence: the verb is probe/consume over the last frame).
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

/// Foreground is "differs from the frame's own corner", the rule that tells a
/// mesh drawn black apart from a mesh not drawn at all.
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

function foreground_count(frame: ArrayBuffer): f64 {
  const pixels = Uint8Array.wrap(frame);
  let count = 0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      if (is_foreground(pixels, x, y)) count++;
    }
  }
  return <f64>count;
}

/// A rig whose joints are all identity — the matrices the state needs to be
/// drawable at all. Without them the skeleton piece reads whatever the buffer
/// holds and the mesh collapses to a stump (the `--mode=stump` run).
function identity_matrices(): Float32Array {
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

/// Send one renderable's matrices and return what the verb returned.
function submit_matrices(renderable_id: u32, matrices: Float32Array): i32 {
  const batch = new SkinMatrixBatch();
  if (!batch.set(0, renderable_id, matrices)) fail("the batch refused the entry");
  return batch.commit();
}

export function _start(): void {
  let tns = "";
  let gl3plus = false;
  let stump_mode = false;
  for (let i: i32 = 0; i < argCount(); i++) {
    const a = arg(i);
    if (a.startsWith("--tns=")) tns = a.substring(6);
    else if (a == "--renderer=gl3plus") gl3plus = true;
    else if (a == "--mode=stump") stump_mode = true;
  }

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

  // ── clause 1: the no-skeleton state loads ────────────────────────────
  // The mesh links a skeleton this volume does not carry. 19e-b accepts it:
  // the job must reach DONE, not FAILED.
  clause = 1;
  const job = ogre.queueMeshLoad("resources/meshes/characterMedium.mesh", 0);
  check(job > 0, "queueMeshLoad did not return a job id");
  settle(job);
  check(ogre.jobState(job) == JOB_DONE,
        "the no-skeleton mesh did not reach DONE (error " + ogre.jobError(job).toString() + ")");
  const mesh = ogre.jobResult(job);
  check(mesh > 0, "no resource id for the no-skeleton mesh");
  print("1 ok (mesh=" + mesh.toString() + " bones=" + ogre.boneCount(mesh).toString() + ")");

  // ── clause 2: the scene ──────────────────────────────────────────────
  // A PBS kind, guest-skin-matrices.ts's material: the adapter's routing
  // gives a rigless mesh with blend data the skin datablock, and a PBS
  // datablock would be the case apply_renderables refuses.
  clause = 2;
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
  print("2 ok");

  // ── clause 3: the draw ───────────────────────────────────────────────
  // matrix: matrices submitted before the first apply → the reproduced block
  // streams them, and the mesh must be visible.
  // stump: nothing submitted → the state must still be accepted (a frame, a
  // count, no crash), however wrong the picture is.
  clause = 3;
  if (!stump_mode) {
    check(submit_matrices(1, identity_matrices()) == 1,
          "submit_skin_matrices did not return the entry count");
  }
  for (let settleFrames: u32 = 0; settleFrames < 12; settleFrames++) RuntimeSession.wait(16);
  const frame = grab();
  check(frame !== null, "no frame was delivered");
  const count = foreground_count(<ArrayBuffer>frame);
  if (stump_mode) {
    print("NOSKEL stump=" + count.toString() + " (accepted without matrices)");
  } else {
    print("NOSKEL matrix=" + count.toString());
    check(count > MIN_MATRIX_PIXELS,
          "the no-skeleton mesh did not render: " + count.toString() +
          " px, under the floor of " + MIN_MATRIX_PIXELS.toString());
  }
  print("3 ok");

  print("OK");
}
