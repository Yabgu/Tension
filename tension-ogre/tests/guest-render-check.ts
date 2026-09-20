// The render tripwire: every material kind this adapter supports must put
// pixels on the screen, with the colour it was given (chunk 5, post-audit).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-render-check.wasm --renderer=gl3plus
//
// Why it exists. Chunk 5b found that a PBS material drew **nothing at all** —
// no exception, no log line, no failed compile — because the Hlms archive
// folder list was one entry short. The Unlit list happened to be complete,
// which is why the omission stayed hidden for two chunks, and the skinning test
// could not have caught it: a material that draws nothing and a rig that does
// not move produce the same picture. This fixture is the cheap, direct question
// instead: **does each material kind still draw, in its own colour?**
//
// The control is `cube.mesh`, a plain 100-unit box with no skeleton and no
// material of its own, so nothing here depends on which mesh or rig is being
// loaded. Measured: at scale 0.01 it is 1 unit across (72 px at this camera),
// and scales at or above 0.2 put the camera *inside* the box, which is why it
// renders nothing at all there — a trap this fixture's numbers come from
// rather than guess at.
//
// The clauses:
//
//   1. cube.mesh loads: job DONE, resource id > 0
//   2. a camera is submitted
//   3. an Unlit material and its renderable are submitted
//   4. a PBS material and its renderable are submitted
//
// and, under a renderer with a framebuffer (GL3+):
//
//   5. the left half holds the Unlit cube: > 20 non-background pixels, and
//      their mean colour is the material's diffuse
//   6. the right half holds the PBS cube: > 20 non-background pixels, and their
//      mean colour is the material's **emissive** — the field a PBS material
//      without a light rig actually shows, which is why the two kinds are not
//      asserted the same way

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import {
  JOB_DONE,
  JOB_FAILED,
  MAT_HLMS_PBS,
  MAT_HLMS_UNLIT,
  CameraRecord,
  Material,
  Renderable,
  assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
/** `cube.mesh` is 100 units across (measured); 0.01 makes it 72 px here. */
const CUBE_SCALE: f32 = 0.01;
/** Where each cube sits: 0.9 units either side of centre, 65 px on screen. */
const CUBE_OFFSET: f32 = 0.9;
/** The colours each material must produce, and the readback's tolerance. */
const UNLIT_RGB: f64[] = [0.9, 0.2, 0.2];
const PBS_EMISSIVE_RGB: f64[] = [0.2, 0.4, 0.9];
const COLOUR_TOLERANCE: f64 = 70.0;
/** Fewer pixels than this and there is nothing to measure a colour over. */
const PIXEL_FLOOR: f64 = 20.0;

let clause = 0;
let total = 0;

function fail(reason: string): void {
  print("ACID " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

function settle(job: i32): void {
  for (let attempt: u32 = 0; attempt < 200; attempt++) {
    const state = ogre.jobState(job);
    if (state == JOB_DONE || state == JOB_FAILED) return;
    RuntimeSession.wait(10);
  }
  fail("job " + job.toString() + " never settled");
}

function submitted(rc: i32, what: string): void {
  check(rc == 0, "submitting the " + what + " was refused (" + rc.toString() + ")");
}

/// Arm a readback, let the renderer advance past it, then read (the sequence
/// guest-motion.ts and guest-skinning.ts both need: the verb is probe/consume
/// over the *last* frame, so reading twice in a row returns the first one).
function grab(): ArrayBuffer | null {
  const armed_at = ogre.frameCount();
  ogre.screenshot(0, 0);
  for (let guard: u32 = 0; guard < 300 && ogre.frameCount() < armed_at + 3; guard++) {
    RuntimeSession.wait(5);
  }
  const length = ogre.screenshot(0, 0);
  if (length <= 0) return null;
  const frame = new ArrayBuffer(length);
  const got = ogre.screenshot(changetype<usize>(frame), length);
  if (got != length) return null;
  return frame;
}

/// The non-background pixels of one half of the frame, and their mean colour.
/// The background is read from the frame's own corner pixel, as the 5b probe
/// does: under a brightness rule, a mesh drawn black and a mesh not drawn are
/// the same number.
function half_stats(frame: ArrayBuffer, right: bool, out: Float64Array): void {
  const pixels = Uint8Array.wrap(frame);
  const bg0 = pixels[0], bg1 = pixels[1], bg2 = pixels[2];
  let count: f64 = 0, sum0: f64 = 0, sum1: f64 = 0, sum2: f64 = 0;
  const from = right ? WINDOW_WIDTH / 2 : 0;
  const to = right ? WINDOW_WIDTH : WINDOW_WIDTH / 2;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = from; x < to; x++) {
      const at = <usize>((y * WINDOW_WIDTH + x) * 4);
      const d0 = abs(<i32>pixels[at] - <i32>bg0);
      const d1 = abs(<i32>pixels[at + 1] - <i32>bg1);
      const d2 = abs(<i32>pixels[at + 2] - <i32>bg2);
      if (d0 <= 8 && d1 <= 8 && d2 <= 8) continue;
      count += 1.0;
      sum0 += <f64>pixels[at];
      sum1 += <f64>pixels[at + 1];
      sum2 += <f64>pixels[at + 2];
    }
  }
  out[0] = count;
  out[1] = count == 0 ? -1.0 : sum0 / <f64>count;
  out[2] = count == 0 ? -1.0 : sum1 / <f64>count;
  out[3] = count == 0 ? -1.0 : sum2 / <f64>count;
}

/// One half's clause: pixels first, then the colour they carry. `expected` is
/// the channel triple the material was given; a channel is accepted when it is
/// within the tolerance, and a failure names all three so the message says
/// *what colour it actually was*.
function check_colour(stats: Float64Array, expected: f64[], which: string): void {
  check(stats[0] > PIXEL_FLOOR,
        "the " + which + " half has " + stats[0].toString() +
        " non-background pixels — that material is not drawing");
  const d0 = abs(stats[1] - expected[0] * 255.0);
  const d1 = abs(stats[2] - expected[1] * 255.0);
  const d2 = abs(stats[3] - expected[2] * 255.0);
  check(d0 <= COLOUR_TOLERANCE && d1 <= COLOUR_TOLERANCE && d2 <= COLOUR_TOLERANCE,
        "the " + which + " half's mean colour is " + stats[1].toString() + "/" +
        stats[2].toString() + "/" + stats[3].toString() + ", not " +
        (expected[0] * 255.0).toString() + "/" + (expected[1] * 255.0).toString() + "/" +
        (expected[2] * 255.0).toString());
}

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const gl3plus = renderer == "gl3plus";
  const which = gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;
  total = gl3plus ? 6 : 4;

  assertOgreWireOffsets();

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

  // ── clause 1: the control mesh ───────────────────────────────────────
  clause = 1;
  const mesh_job = ogre.queueMeshLoad("cube.mesh", 0);
  check(mesh_job > 0, "queueMeshLoad did not return a job id");
  settle(mesh_job);
  check(ogre.jobState(mesh_job) == JOB_DONE,
        "cube.mesh did not reach DONE (state " + ogre.jobState(mesh_job).toString() +
        ", error " + ogre.jobError(mesh_job).toString() + ")");
  const cube = ogre.jobResult(mesh_job);
  check(cube > 0, "no resource id for cube.mesh");
  print("1 ok");

  // ── clause 2: the camera ─────────────────────────────────────────────
  clause = 2;
  const camera = CameraRecord.perspective(0.7853982, 4.0 / 3.0, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  submitted(ogre.submitCamera(camera), "camera");
  print("2 ok");

  // ── clause 3: the Unlit cube, on the left ────────────────────────────
  clause = 3;
  const unlit = Material.unlit(<f32>UNLIT_RGB[0], <f32>UNLIT_RGB[1], <f32>UNLIT_RGB[2]);
  unlit.materialId = 1;
  submitted(ogre.submitMaterial(unlit), "unlit material");
  const left_cube = Renderable.at(cube, 1, -CUBE_OFFSET, 0.0, 0.0, CUBE_SCALE);
  left_cube.renderableId = 1;
  submitted(ogre.submitRenderable(left_cube), "unlit renderable");
  print("3 ok");

  // ── clause 4: the PBS cube, on the right ─────────────────────────────
  // Diffuse zero, specular zero, colour in emissive: a PBS material with no
  // light rig has nothing else that shows (DESIGN.md §5.1).
  clause = 4;
  const pbs = new Material();
  pbs.materialId = 2;
  pbs.kind = MAT_HLMS_PBS;
  pbs.diffuseR = 0.0;
  pbs.diffuseG = 0.0;
  pbs.diffuseB = 0.0;
  pbs.specularR = 0.0;
  pbs.specularG = 0.0;
  pbs.specularB = 0.0;
  pbs.emissiveR = <f32>PBS_EMISSIVE_RGB[0];
  pbs.emissiveG = <f32>PBS_EMISSIVE_RGB[1];
  pbs.emissiveB = <f32>PBS_EMISSIVE_RGB[2];
  pbs.roughness = 1.0;
  pbs.metalness = 0.0;
  submitted(ogre.submitMaterial(pbs), "pbs material");
  const right_cube = Renderable.at(cube, 2, CUBE_OFFSET, 0.0, 0.0, CUBE_SCALE);
  right_cube.renderableId = 2;
  submitted(ogre.submitRenderable(right_cube), "pbs renderable");
  print("4 ok");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // Let the render thread make the datablocks, the items and the shaders: a
  // frame grabbed before they exist is an empty one (measured in 5b's fixture,
  // which read 0 pixels at frame 1 and its full blob by frame 10).
  for (let settle_frames: u32 = 0; settle_frames < 12; settle_frames++) {
    RuntimeSession.wait(16);
  }
  const frame = grab();
  check(frame != null, "no frame could be downloaded");

  const stats = new Float64Array(4);
  half_stats(frame!, false, stats);
  print("unlit: " + stats[0].toString() + " px, mean rgb " + stats[1].toString() + "/" +
        stats[2].toString() + "/" + stats[3].toString());

  // ── clause 5: the Unlit cube drew, in its diffuse colour ─────────────
  clause = 5;
  check_colour(stats, UNLIT_RGB, "unlit");
  print("5 ok");

  // ── clause 6: the PBS cube drew, in its emissive colour ──────────────
  clause = 6;
  half_stats(frame!, true, stats);
  print("pbs: " + stats[0].toString() + " px, mean rgb " + stats[1].toString() + "/" +
        stats[2].toString() + "/" + stats[3].toString());
  check_colour(stats, PBS_EMISSIVE_RGB, "pbs");
  print("6 ok");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
