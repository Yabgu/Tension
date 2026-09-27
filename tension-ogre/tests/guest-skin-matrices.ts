// The guest's skin matrices, end to end (chunk 19 round 19c).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-skin-matrices.wasm --renderer=gl3plus
//
// Round 19b landed the verb, the adapter's storage, the buffer and the shader
// read, but proved only the half from storage onward (a temporary translation
// injected into the adapter moved the picture). This fixture closes the other
// half: a **guest** submits matrices and the frame changes.
//
// The clauses:
//
//   1. characterMedium.mesh loads and is rigged (the loader's own answer)
//   2. a PBS material, a camera and the renderable are submitted
//   3. `SkinMatrixBatch.commit()` is accepted — the verb returns the entry count
//   4. with the first joint's translation at (2, 0, 0) the frame differs from
//      the same scene with it at (0, 0, 0), by more than a pixel-level floor
//
// Clause 4 is the whole round: the only difference between the two frames is
// the bytes a guest wrote into `BUFFER_POOL` and the verb it called with them.
//
// What the shader does with the matrices today is deliberately small — it adds
// the **first joint's translation** to the vertex position, which is enough to
// move the mesh and nothing like skinning. Full skinning is the next round; it
// changes the piece, not this file.
//
// The matrices are built here, not by the framework's evaluator: the fixture
// must be self-contained, and a rig of one translation is simpler to read than
// a sampled clip.

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
/// The framing guest-skinning.ts uses for this rig: 3.765 units at scale 1.
const MESH_SCALE: f32 = 0.29;
/// The rig's size (chunk 12a): one matrix per joint is what the batch carries.
const RIG_BONES: u32 = 58;
/// The translation the first clause applies, in world units. Two units against
/// a figure 1.09 units tall is a move no threshold can mistake for antialiasing.
const SHIFT: f32 = 2.0;
/// The floor on the difference between the two frames. Measured deltas are in
/// the hundreds of pixels; 30 is a floor, not an expectation.
const MIN_DELTA: f64 = 30.0;

let clause = 0;
let total = 4;

function fail(reason: string): void {
  print("MATRICES " + clause.toString() + "/" + total.toString() + " failed: " + reason);
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

/// A rig whose joints are all identity, except that the **first** joint carries
/// the translation. Column-major, 16 floats per joint, which is what the batch
/// and the shader both expect; the shader reads the first matrix's column 3
/// (floats 12, 13, 14), so that is where the translation goes.
function rig_with_translation(x: f32, y: f32, z: f32): Float32Array {
  const matrices = new Float32Array(RIG_BONES * 16);
  for (let joint: u32 = 0; joint < RIG_BONES; joint++) {
    const at = joint * 16;
    matrices[at + 0] = 1.0;
    matrices[at + 5] = 1.0;
    matrices[at + 10] = 1.0;
    matrices[at + 15] = 1.0;
  }
  matrices[12] = x;
  matrices[13] = y;
  matrices[14] = z;
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
  for (let i: i32 = 0; i < argCount(); i++) {
    const a = arg(i);
    if (a.startsWith("--tns=")) tns = a.substring(6);
    else if (a == "--renderer=gl3plus") gl3plus = true;
  }

  // The session comes first, exactly as the working windowed fixtures do it:
  // every verb this file calls goes through it, and without it the adapter is
  // driven in a state it was never built for (measured: `epoch -> -9 ... the
  // session is Uninit` for every call, and the renderer start fails with the
  // default render-system name rather than the one the config asked for).
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

  // ── clause 1: the rigged mesh ────────────────────────────────────────
  clause = 1;
  const job = ogre.queueMeshLoad("resources/meshes/characterMedium.mesh", 0);
  check(job > 0, "queueMeshLoad did not return a job id");
  settle(job);
  check(ogre.jobState(job) == JOB_DONE,
        "characterMedium.mesh did not reach DONE (error " + ogre.jobError(job).toString() + ")");
  const mesh = ogre.jobResult(job);
  check(mesh > 0, "no resource id for characterMedium.mesh");
  check(ogre.isRigged(mesh), "the loader does not report the mesh as rigged");
  check(ogre.boneCount(mesh) == RIG_BONES,
        "the rig is " + ogre.boneCount(mesh).toString() + " bones, not " + RIG_BONES.toString());
  print("1 ok");

  // ── clause 2: the scene ──────────────────────────────────────────────
  // PBS with the colour in emissive, the material guest-skinning.ts measured:
  // the subclass only draws rigged meshes, and a rigged mesh under an Unlit
  // datablock would never reach the shader this fixture is about.
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
  for (let settleFrames: u32 = 0; settleFrames < 12; settleFrames++) RuntimeSession.wait(16);
  print("2 ok");

  // ── clause 3: the verb accepts the batch ─────────────────────────────
  clause = 3;
  const accepted = submit_matrices(1, rig_with_translation(SHIFT, 0.0, 0.0));
  check(accepted == 1,
        "submit_skin_matrices returned " + accepted.toString() + ", not the entry count");
  const shifted_frame = grab();
  check(shifted_frame !== null, "no frame was delivered with the matrices submitted");
  const shifted = foreground_count(<ArrayBuffer>shifted_frame);
  RuntimeSession.wait(32);
  print("3 ok");

  // ── clause 4: the matrices changed the frame ─────────────────────────
  // The same scene, the same verb, the same buffer — only the payload differs.
  clause = 4;
  check(submit_matrices(1, rig_with_translation(0.0, 0.0, 0.0)) == 1,
        "the zero-translation batch was refused");
  const still_frame = grab();
  check(still_frame !== null, "no frame was delivered for the zero-translation run");
  const still = foreground_count(<ArrayBuffer>still_frame);

  print("MATRICES shifted=" + shifted.toString() + " unshifted=" + still.toString() +
        " delta=" + abs(shifted - still).toString());
  check(abs(shifted - still) > MIN_DELTA,
        "the two frames differ by " + abs(shifted - still).toString() +
        " px, under the floor of " + MIN_DELTA.toString() +
        " — the matrices did not reach the shader");
  print("4 ok");

  print("OK");
}
