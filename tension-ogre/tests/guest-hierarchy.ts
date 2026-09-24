// The hierarchy acid test: a child follows its parent.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-hierarchy.wasm --renderer=gl3plus
//
// The clauses (DESIGN.md §14):
//
//   1. Barrel.mesh loads: job DONE, resource id > 0
//   2. an Unlit material and a camera are submitted
//   3. a parent node and a child node at local (1, 0, 0) are accepted
//   4. a renderable hangs from the child (its transform is local to it)
//   5. the parent is rotated 180 degrees about Y, and frames advance
//
// and, under a renderer with a framebuffer (GL3+):
//
//   6. the drawable is in the *right* half: the child is at world (1, 0, 0)
//   7. after the rotation it is in the *left* half: the child is now at (-1, 0, 0)
//   8. and it is the same size, so it moved rather than vanished or grew
//
// The adapter does not compose that transform — OGRE's scene graph does, and
// this fixture is what says so: the drawable's own record never changes, only
// its parent's rotation, and the pixels move.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  ConfigBuilder,
  RuntimeSession,
  makeCallbacks,
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import {
  JOB_DONE,
  JOB_FAILED,
  assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";

const WIDTH = 320;
const HEIGHT = 240;
/// The barrel at 0.02 scales to about 9 pixels; a half is 160 wide, and the
/// child sits at x = +/-1 unit, which is 72 pixels either side of the centre.
const HALF_MIN_PIXELS = 20;
/// A half that should be empty: the blob must not straddle the middle.
const HALF_MAX_STRAY = 5;

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

/// Ask for a frame and wait until a **new** one has been downloaded: the verb
/// answers with the last frame, so a second read needs the renderer to advance.
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

/// How many non-background pixels are in the left and right halves.
function halves(frame: ArrayBuffer, out: Float64Array): void {
  const pixels = Uint8Array.wrap(frame);
  let left = 0, right = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = <usize>((y * WIDTH + x) * 4);
      if (pixels[at] < 40 && pixels[at + 1] < 40 && pixels[at + 2] < 40) continue;
      if (x < WIDTH / 2) left++;
      else right++;
    }
  }
  out[0] = <f64>left;
  out[1] = <f64>right;
}

export function _start_game(): void {
  let renderer = "null";
  let tns = "";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const gl3plus = renderer == "gl3plus";
  total = gl3plus ? 8 : 5;

  assertOgreWireOffsets();

  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    fail("session_open refused");
  }
  const config = new ogre.ConfigBuilder()
    .renderer(gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(!gl3plus)
    .vsync(false)
    .frameHz(60)
    .windowSize(WIDTH, HEIGHT);
  const started = ogre.init(config);
  if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");
  // Everything this fixture loads comes out of one packed volume (chunk 11):
  // tests/resources is packed into build/fixtures.tns and the runner hands the
  // path in as `--tns=`. No mount, no bytes — the fixtures are migrated, not
  // grandfathered.
  if (tns.length == 0) fail("no --tns=<volume> argument (run through tests/run.sh)");
  if (ogre.mountTns("resources", tns) != 0) fail("mountTns refused");
  ogre.assertSubmissionRegions();

  // ── clause 1: the mesh ───────────────────────────────────────────────
  clause = 1;
  const job = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  check(job > 0, "queueMeshLoad did not return a job id");
  settle(job);
  check(ogre.jobState(job) == JOB_DONE,
        "Barrel.mesh did not reach DONE (error " + ogre.jobError(job).toString() + ")");
  const mesh = ogre.jobResult(job);
  check(mesh > 0, "no resource id for Barrel.mesh");
  print("1 ok");

  // ── clause 2: the material and the camera ────────────────────────────
  clause = 2;
  const material = ogre.Material.unlit(0.9, 0.2, 0.2);
  material.materialId = 1;
  submitted(ogre.submitMaterial(material), "material");
  const camera = ogre.CameraRecord.perspective(
    45.0 * (3.14159265358979 / 180.0), <f32>WIDTH / <f32>HEIGHT, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  submitted(ogre.submitCamera(camera), "camera");
  print("2 ok");

  // ── clause 3: a parent and a child ───────────────────────────────────
  // The parent sits at the origin; the child is one unit to its right, and its
  // transform means "one unit from my parent", not "one unit from the world".
  clause = 3;
  const parent = ogre.SceneNode.at(0.0, 0.0, 0.0);
  parent.nodeId = 1;
  submitted(ogre.submitNode(parent), "parent node");
  const child = ogre.SceneNode.at(1.0, 0.0, 0.0);
  child.nodeId = 2;
  child.parentId = 1;
  submitted(ogre.submitNode(child), "child node");
  print("3 ok");

  // ── clause 4: a drawable on the child ────────────────────────────────
  clause = 4;
  const renderable = ogre.Renderable.at(mesh, 1, 0.0, 0.0, 0.0, 0.02);
  renderable.renderableId = 1;
  renderable.nodeId = 2;
  submitted(ogre.submitRenderable(renderable), "renderable");
  print("4 ok");

  // ── the baseline, before the parent moves ────────────────────────────
  let baseline = new Float64Array(2);
  if (gl3plus) {
    const settle_from = ogre.frameCount();
    while (ogre.frameCount() < settle_from + 5) RuntimeSession.wait(16);
    const frame = grab();
    check(frame != null, "no baseline frame could be downloaded");
    halves(frame!, baseline);
    print("baseline: " + baseline[0].toString() + " px left, " + baseline[1].toString() +
          " px right");
  }

  // ── clause 5: rotate the parent ──────────────────────────────────────
  // 180 degrees about Y. The drawable's own record is not touched again: if the
  // pixels move, the parent carried it.
  clause = 5;
  parent.rotationX = 0.0;
  parent.rotationY = 1.0;
  parent.rotationZ = 0.0;
  parent.rotationW = 0.0;
  submitted(ogre.submitNode(parent), "parent node, rotated");
  const turned_at = ogre.frameCount();
  while (ogre.frameCount() < turned_at + 3) RuntimeSession.wait(16);
  check(ogre.frameCount() >= turned_at + 3, "the frame counter did not advance");
  print("5 ok");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    ogre.shutdown();
    RuntimeSession.close();
    return;
  }

  // ── the frame after the rotation ─────────────────────────────────────
  const moved = grab();
  check(moved != null, "no frame could be downloaded after the rotation");
  const after = new Float64Array(2);
  halves(moved!, after);
  print("after: " + after[0].toString() + " px left, " + after[1].toString() + " px right");

  // ── clause 6: the child was on the right ─────────────────────────────
  clause = 6;
  check(baseline[1] > HALF_MIN_PIXELS && baseline[0] < HALF_MAX_STRAY,
        "the baseline blob is not in the right half: " + baseline[0].toString() + " left, " +
        baseline[1].toString() + " right");
  print("6 ok");

  // ── clause 7: and after the parent turned, it is on the left ─────────
  clause = 7;
  check(after[0] > HALF_MIN_PIXELS && after[1] < HALF_MAX_STRAY,
        "the blob did not move to the left half: " + after[0].toString() + " left, " +
        after[1].toString() + " right");
  print("7 ok");

  // ── clause 8: it moved rather than changed size ──────────────────────
  clause = 8;
  const before_total = baseline[0] + baseline[1];
  const after_total = after[0] + after[1];
  check(after_total > before_total * 0.7 && after_total < before_total * 1.3,
        "the blob changed size: " + before_total.toString() + " -> " + after_total.toString());
  print("8 ok");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  ogre.shutdown();
  RuntimeSession.close();
}
