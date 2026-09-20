// The 3b acid test: a mesh, a material, a camera and a renderable — and, where
// there is a framebuffer to read, the pixels they produce.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-triangle.wasm --renderer=gl3plus
//
// The clauses (DESIGN.md §14: the acid test is the milestone gate):
//
//   1. Barrel.mesh loads: job DONE, resource id > 0
//   2. an Unlit material (0.9, 0.2, 0.2) is submitted
//   3. a camera at (0, 0, 4) looking down -Z is submitted
//   4. a renderable binding the two, at the origin, is submitted
//   5. a shipped texture loads — the 3a realisation path, still exercised
//
// and, under a renderer that has a framebuffer (GL3+), three pixel clauses:
//
//   6. the corner pixel is background: the workspace's clear colour
//   7. more than 50 pixels are not background (the probe measured 72)
//   8. the non-background pixels are the material's red
//
// Under renderer=null the first five run and the pixel clauses are skipped —
// the NULL render system has no framebuffer to download, which is why this
// milestone has a structural tier and a visual one. Prints "ACID n/m passed";
// a failure prints "ACID n/m failed: <reason>" and traps, so the interpreter
// exits non-zero and the runner sees both.
//
// The numbers the pixel clauses assert are the probe's measurements
// (tests/probe_scene.cpp, step 8): the same mesh, the same scale, the same
// window, the same camera — including the camera's field of view, which the
// probe never set and so took OGRE's default of 45°. At 60° the same barrel
// covers 36 pixels rather than 72, which is arithmetic rather than a bug, and
// the floor below is stated against the 45° measurement. The scale is 0.02
// because the barrel is ~5 units wide: at 1.0 it would fill the window and
// there would be no background left to tell apart from the mesh.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  CLASS_JOB_DONE,
  CLASS_JOB_FAILED,
  ConfigBuilder,
  EventRecord,
  MODE_DIRECT,
  RuntimeSession,
  SUBSCRIPTION_SIZE,
  Subscription,
  makeCallbacks,
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import {
  JOB_DONE,
  JOB_FAILED,
  MAT_HLMS_UNLIT,
  CameraRecord,
  Material,
  Renderable,
} from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
const FRAME_BYTES: i32 = WINDOW_WIDTH * WINDOW_HEIGHT * 4;
/** The barrel's scale: the probe's, chosen so the mesh occupies a small part
 * of the window and the background around it is measurable. */
const BARREL_SCALE: f32 = 0.02;

let clause = 0;
let total = 0;

/// One clause failed: say which, and stop with a non-zero exit.
function fail(reason: string): void {
  print("ACID " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

/// Wait for `job` to reach a terminal state (or give up and say so).
function settle(job: i32): void {
  for (let attempt: u32 = 0; attempt < 200; attempt++) {
    const state = ogre.jobState(job);
    if (state == JOB_DONE || state == JOB_FAILED) return;
    RuntimeSession.wait(10);
  }
  fail("job " + job.toString() + " never settled");
}

/// Submit a record and insist the adapter took it.
function submitted(rc: i32, what: string): void {
  check(rc == 0, "submitting the " + what + " was refused (" + rc.toString() + ")");
}

/// The red-dominance test the pixel clauses share.
function meanOf(sum: f64, count: i32): f64 {
  return count == 0 ? 0 : sum / <f64>count;
}

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const gl3plus = renderer == "gl3plus";
  const which = gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;
  total = gl3plus ? 8 : 5;

  const callbacks = makeCallbacks(null, null);
  const session = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session, callbacks) == 0, "session_open refused");

  const ogre_config = new ogre.ConfigBuilder()
    .renderer(which)
    .headless(!gl3plus)
    .vsync(false)
    .frameHz(60)
    .windowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  assert(ogre.init(ogre_config) == 0, "ogre::init refused the config");
  ogre.assertSubmissionRegions();

  // ── clause 1: the mesh, by the 3a path ───────────────────────────────
  clause = 1;
  const mesh_job = ogre.queueMeshLoad("Barrel.mesh", 0);
  check(mesh_job > 0, "queueMeshLoad did not return a job id");
  settle(mesh_job);
  check(ogre.jobState(mesh_job) == JOB_DONE,
        "Barrel.mesh did not reach DONE (state " + ogre.jobState(mesh_job).toString() +
        ", error " + ogre.jobError(mesh_job).toString() + ")");
  const mesh_resource = ogre.jobResult(mesh_job);
  check(mesh_resource > 0, "no resource id for Barrel.mesh");
  print("1 ok");

  // ── clause 2: the material ───────────────────────────────────────────
  // Unlit and a colour, no texture: the assertion in clause 8 is then about
  // the renderer, not about a codec. A texture is loaded in clause 5 to keep
  // the 3a path exercised, but it is deliberately not bound here.
  clause = 2;
  const material = new Material();
  material.materialId = 1;
  material.kind = MAT_HLMS_UNLIT;
  material.diffuseR = 0.9;
  material.diffuseG = 0.2;
  material.diffuseB = 0.2;
  material.diffuseA = 1.0;
  submitted(ogre.submitMaterial(material), "material");
  print("2 ok");

  // ── clause 3: the camera ─────────────────────────────────────────────
  // At (0, 0, 4) with an identity rotation: an OGRE camera looks down its own
  // -Z, so this looks at the origin, which is where the renderable is.
  clause = 3;
  const camera = new CameraRecord();
  camera.cameraId = 1;
  camera.fovY = 45.0 * (3.14159265358979 / 180.0); // the probe's fov: OGRE's default
  camera.aspect = <f32>WINDOW_WIDTH / <f32>WINDOW_HEIGHT;
  camera.nearClip = 0.1;
  camera.farClip = 100.0;
  camera.positionX = 0.0;
  camera.positionY = 0.0;
  camera.positionZ = 4.0;
  camera.rotationW = 1.0;
  submitted(ogre.submitCamera(camera), "camera");
  print("3 ok");

  // ── clause 4: the renderable ─────────────────────────────────────────
  clause = 4;
  const renderable = new Renderable();
  renderable.renderableId = 1;
  renderable.materialId = 1;
  renderable.meshResourceId = mesh_resource;
  renderable.positionX = 0.0;
  renderable.positionY = 0.0;
  renderable.positionZ = 0.0;
  renderable.rotationW = 1.0;
  renderable.scaleX = BARREL_SCALE;
  renderable.scaleY = BARREL_SCALE;
  renderable.scaleZ = BARREL_SCALE;
  submitted(ogre.submitRenderable(renderable), "renderable");
  print("4 ok");

  // ── clause 5: a texture still realises ───────────────────────────────
  // DDS because that is what this install's OGRE decodes (its codecs are DDS
  // and OITD). Under renderer=null this is the null-RS texture path; under
  // GL3+ it is the real TextureGpuManager one.
  clause = 5;
  const texture_job = ogre.queueTextureLoad("ASCII.dds", 0);
  check(texture_job > 0, "queueTextureLoad did not return a job id");
  settle(texture_job);
  check(ogre.jobState(texture_job) == JOB_DONE,
        "ASCII.dds did not reach DONE (state " + ogre.jobState(texture_job).toString() +
        ", error " + ogre.jobError(texture_job).toString() + ")");
  check(ogre.jobResult(texture_job) > 0, "no resource id for ASCII.dds");
  print("5 ok");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── the pixels ───────────────────────────────────────────────────────
  // Ask for a frame, then wait for one to arrive. Each call asks for the next
  // frame's download and reports the last one's length, so the first calls
  // legitimately see -1.
  let length = -1;
  for (let attempt: u32 = 0; attempt < 300 && length <= 0; attempt++) {
    length = ogre.screenshot(0, 0);
    if (length <= 0) RuntimeSession.wait(10);
  }
  check(length > 0, "no frame was downloaded (the screenshot verb kept answering -1)");
  check(length == FRAME_BYTES,
        "the frame is " + length.toString() + " bytes, not the expected " +
        FRAME_BYTES.toString() + " for " + WINDOW_WIDTH.toString() + "x" +
        WINDOW_HEIGHT.toString());

  const frame = new ArrayBuffer(FRAME_BYTES);
  const got = ogre.screenshot(changetype<usize>(frame), FRAME_BYTES);
  check(got == FRAME_BYTES, "the frame came back short (" + got.toString() + " bytes)");
  const pixels = Uint8Array.wrap(frame);

  let non_background = 0;
  let sum_r: f64 = 0, sum_g: f64 = 0, sum_b: f64 = 0;
  let corner_r: u8 = 0, corner_g: u8 = 0, corner_b: u8 = 0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      const at = <usize>((y * WINDOW_WIDTH + x) * 4);
      const r = pixels[at], g = pixels[at + 1], b = pixels[at + 2];
      if (x == 0 && y == 0) {
        corner_r = r;
        corner_g = g;
        corner_b = b;
      }
      // The probe's rule, so the two measurements are comparable: the
      // workspace clears to 0.1, which lands at 25 in 8-bit.
      if (!(r < 40 && g < 40 && b < 40)) {
        non_background++;
        sum_r += <f64>r;
        sum_g += <f64>g;
        sum_b += <f64>b;
      }
    }
  }
  const mean_r = meanOf(sum_r, non_background);
  const mean_g = meanOf(sum_g, non_background);
  const mean_b = meanOf(sum_b, non_background);
  print("pixels: " + WINDOW_WIDTH.toString() + "x" + WINDOW_HEIGHT.toString() + ", corner " +
        corner_r.toString() + "/" + corner_g.toString() + "/" + corner_b.toString() + ", " +
        non_background.toString() + " non-background, mean " + mean_r.toString() + "/" +
        mean_g.toString() + "/" + mean_b.toString());

  // ── clause 6: the corner is background ───────────────────────────────
  clause = 6;
  check(abs(<i32>corner_r - 25) <= 25 && abs(<i32>corner_g - 25) <= 25 &&
        abs(<i32>corner_b - 25) <= 25,
        "the corner is " + corner_r.toString() + "/" + corner_g.toString() + "/" +
        corner_b.toString() + ", not the clear colour");
  print("6 ok");

  // ── clause 7: the mesh is on screen ──────────────────────────────────
  clause = 7;
  check(non_background > 50,
        "only " + non_background.toString() + " pixels are not background: the mesh is not there");
  print("7 ok");

  // ── clause 8: it is the material's colour ────────────────────────────
  clause = 8;
  check(mean_r > mean_g + 50.0 && mean_r > mean_b + 50.0,
        "the non-background pixels are not red: mean " + mean_r.toString() + "/" +
        mean_g.toString() + "/" + mean_b.toString());
  print("8 ok");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
