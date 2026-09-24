// A mesh that never was a file: `ogre::create_mesh` (chunk 5.5).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-procedural.wasm --renderer=gl3plus
//
// Every other fixture loads a mesh the loader made out of bytes on disk. This
// one builds a triangle out of the guest's own memory — nine numbers and three
// indices — and then asks the same questions a loaded mesh would be asked: did
// the resource come out, does it render, and does it report itself honestly?
//
// The clauses:
//
//   1. `MeshBuilder.triangle` returns a resource id
//   2. the resource record reaches READY — the render thread built the mesh out
//      of the bytes on its next pass, and the record's rig fields say what a
//      built mesh is: no skeleton, no bones
//   3. a camera and an Unlit material are submitted
//   4. a renderable using the built mesh is submitted
//
// and, under a renderer with a framebuffer (GL3+):
//
//   5. the frame has a triangle in it: more than 20 non-background pixels, in
//      the material's colour, and not so many that the mesh filled the screen

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import {
  CameraRecord,
  Material,
  Renderable,
  RES_STATE_FAILED,
  RES_STATE_READY,
  VF_POSITION,
  assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
/** The material's colour, and what the readback must agree with. */
const UNLIT_RGB: f64[] = [0.9, 0.2, 0.2];
const COLOUR_TOLERANCE: f64 = 70.0;
/** Fewer pixels than this and nothing was drawn; more than half the frame and
 * what was drawn is not a triangle. The probe measured a triangle this size at
 * 10,368 px of 76,800 (13.5%), so both bounds are far from the real number. */
const PIXEL_FLOOR: f64 = 20.0;
const PIXEL_CEILING: f64 = 0.5 * <f64>(WINDOW_WIDTH * WINDOW_HEIGHT);

let clause = 0;
let total = 0;

function fail(reason: string): void {
  print("ACID " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

function submitted(rc: i32, what: string): void {
  check(rc == 0, "submitting the " + what + " was refused (" + rc.toString() + ")");
}

/// Arm a readback, let the renderer advance past it, then read (the sequence
/// every visual fixture needs: `screenshot` is probe/consume over the *last*
/// frame, so reading twice in a row returns the first one).
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

/// The frame's non-background pixels and their mean colour. The background is
/// read from the frame's own corner pixel, as the other fixtures do: under a
/// brightness rule, a mesh drawn black and a mesh not drawn are the same
/// number.
function frame_stats(frame: ArrayBuffer, out: Float64Array): void {
  const pixels = Uint8Array.wrap(frame);
  const bg0 = pixels[0], bg1 = pixels[1], bg2 = pixels[2];
  let count: f64 = 0, sum0: f64 = 0, sum1: f64 = 0, sum2: f64 = 0;
  for (let y: i32 = 0; y < WINDOW_HEIGHT; y++) {
    for (let x: i32 = 0; x < WINDOW_WIDTH; x++) {
      // An i32 index: the frame is 307,200 bytes at its largest, and an index
      // the compiler does not have to narrow is one less conversion to explain.
      const at: i32 = (y * WINDOW_WIDTH + x) * 4;
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
  out[1] = count == 0 ? -1.0 : sum0 / count;
  out[2] = count == 0 ? -1.0 : sum1 / count;
  out[3] = count == 0 ? -1.0 : sum2 / count;
}

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const gl3plus = renderer == "gl3plus";
  const which = gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;
  total = gl3plus ? 6 : 5;

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

  // ── clause 1: a triangle out of nine numbers ─────────────────────────
  clause = 1;
  const triangle = ogre.MeshBuilder.triangle(-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0);
  check(triangle > 0, "MeshBuilder.triangle returned " + triangle.toString() +
                      ", not a resource id");
  print("1 ok: create_mesh returned resource " + triangle.toString());

  // ── clause 2: the mesh exists a pass later, and says what it is ──────
  // The id comes back before the mesh does: only the render thread may make an
  // OGRE object, so it is built on that thread's next pass and the record is
  // how a guest learns it happened — the same wait a loaded mesh's job gets.
  clause = 2;
  for (let attempt: u32 = 0; attempt < 200; attempt++) {
    const state = ogre.resourceState(triangle);
    if (state == RES_STATE_READY || state == RES_STATE_FAILED) break;
    RuntimeSession.wait(5);
  }
  check(ogre.resourceState(triangle) == RES_STATE_READY,
        "the built mesh did not reach READY (state " +
        ogre.resourceState(triangle).toString() + ")");
  check(!ogre.isRigged(triangle), "a mesh built from arrays reported a skeleton");
  check(ogre.boneCount(triangle) == 0, "a mesh built from arrays reported bones");
  print("2 ok: the record is READY, with no rig");

  // ── and the blocking form, which does that wait for the caller ───────
  // `MeshBuilder.build` takes byte arrays and returns only once the mesh is
  // ready; `triangleBlocking` is the same wait around `triangle`. Both are what
  // an example or a first game reaches for, so the suite has to exercise the
  // ArrayBuffer path and the settle loop, not just the call.
  clause = 3;
  const vertices = new ArrayBuffer(36); // three F32x3 positions
  const vertex_floats = Float32Array.wrap(vertices);
  vertex_floats[0] = -1.0;
  vertex_floats[1] = -1.0;
  vertex_floats[2] = 0.0;
  vertex_floats[3] = 1.0;
  vertex_floats[4] = -1.0;
  vertex_floats[5] = 0.0;
  vertex_floats[6] = 0.0;
  vertex_floats[7] = 1.0;
  vertex_floats[8] = 0.0;
  const indices = new ArrayBuffer(6); // three 16-bit indices
  const index_shorts = Uint16Array.wrap(indices);
  index_shorts[0] = 0;
  index_shorts[1] = 1;
  index_shorts[2] = 2;
  const blocking = ogre.MeshBuilder.build(vertices, indices, ogre.VF_POSITION);
  check(blocking > 0, "MeshBuilder.build returned " + blocking.toString());
  check(ogre.resourceState(blocking) == RES_STATE_READY,
        "MeshBuilder.build returned an id whose record is state " +
        ogre.resourceState(blocking).toString() + ", not READY");
  print("3 ok: the blocking form returned a ready mesh (" + blocking.toString() + ")");

  // ── clause 4: the camera and the material ────────────────────────────
  clause = 4;
  const camera = CameraRecord.perspective(0.7853982, 4.0 / 3.0, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  submitted(ogre.submitCamera(camera), "camera");
  const material = Material.unlit(<f32>UNLIT_RGB[0], <f32>UNLIT_RGB[1], <f32>UNLIT_RGB[2]);
  material.materialId = 1;
  submitted(ogre.submitMaterial(material), "material");
  print("4 ok");

  // ── clause 5: a renderable that names it ─────────────────────────────
  clause = 5;
  // Scale 1.0: the triangle was written at ±1 world units, which is the size
  // this camera's 45° frustum shows at z=0.
  const renderable = Renderable.at(triangle, 1, 0.0, 0.0, 0.0, 1.0);
  renderable.renderableId = 1;
  submitted(ogre.submitRenderable(renderable), "renderable");
  print("5 ok");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // Let the render thread build the item and the datablock, and generate the
  // shaders: a frame grabbed before they exist is an empty one.
  for (let settle_frames: u32 = 0; settle_frames < 12; settle_frames++) {
    RuntimeSession.wait(16);
  }
  const frame = grab();
  check(frame != null, "no frame could be downloaded");

  // ── clause 6: the triangle is on the screen, in its colour ───────────
  clause = 6;
  const stats = new Float64Array(4);
  frame_stats(frame!, stats);
  print("triangle: " + stats[0].toString() + " px, mean rgb " + stats[1].toString() + "/" +
        stats[2].toString() + "/" + stats[3].toString());
  check(stats[0] > PIXEL_FLOOR,
        "the frame has " + stats[0].toString() + " non-background pixels: nothing was drawn");
  check(stats[0] < PIXEL_CEILING,
        "the frame has " + stats[0].toString() + " non-background pixels: that is not a " +
        "triangle, that is the whole window");
  const d0 = abs(stats[1] - UNLIT_RGB[0] * 255.0);
  const d1 = abs(stats[2] - UNLIT_RGB[1] * 255.0);
  const d2 = abs(stats[3] - UNLIT_RGB[2] * 255.0);
  check(d0 <= COLOUR_TOLERANCE && d1 <= COLOUR_TOLERANCE && d2 <= COLOUR_TOLERANCE,
        "the triangle's mean colour is " + stats[1].toString() + "/" + stats[2].toString() + "/" +
        stats[3].toString() + ", not the material's " + (UNLIT_RGB[0] * 255.0).toString() + "/" +
        (UNLIT_RGB[1] * 255.0).toString() + "/" + (UNLIT_RGB[2] * 255.0).toString());
  print("6 ok");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
