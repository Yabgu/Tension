// The 5b acid test: a skinned mesh deforms because its rig was posed.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-skinning.wasm --renderer=gl3plus
//
// The clauses (DESIGN.md §14 — the last one the original scope named):
//
//   1. Stickman.mesh loads: job DONE, resource id > 0
//   2. the loader says it is **rigged**, with the probe's bone count (19)
//   3. a PBS material, a camera and the renderable are submitted
//   4. a bone batch is accepted in one call, and a bad one is refused whole
//   5. sixty frames of posing ran, each batch accepted
//   6. the renderer's frame counter advanced past the loop's target
//
// and, under a renderer with a framebuffer (GL3+), the pixel clauses:
//
//   7. the baseline is a solid blob (~1574 px at this scale, the probe's)
//   8. after 60 frames the mesh still renders (±30% of the baseline)
//   9. the silhouette changed shape: at least 0.005 of the frame flipped
//      between foreground and background (the clean-pose measurement is
//      0.0197, so the floor is a quarter of it)
//  10. the change is a **deformation, not a disappearance**: pixels went both
//      ways — some became foreground where none was, some became background
//
// Why the material is PBS and not Unlit, why the scale is 0.6, and why the bone
// is 6 (`Spine`): the probe measured all three (DESIGN.md §5.1). HlmsUnlit has
// no skeletal animation in its shaders at all — a correct rig under an Unlit
// datablock renders a perfectly still mesh — and `Spine` was the clearest of
// the ten bones the probe swept (flip 0.0356, against 0.00000 for the four IK
// leaves).
//
// **No motion is submitted anywhere in this file.** That is the point of the
// round: the change in the pixels is the rig, and nothing moved the object.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { BoneBatch } from "../../tension-framework/assembly/ogre/bones";
import {
  JOB_DONE,
  JOB_FAILED,
  CameraRecord,
  Material,
  Renderable,
  assertOgreBoneOffsets,
  assertOgreMotionOffsets,
  assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
/** The probe's scale for this mesh: 1574 non-background pixels at 320x240. */
const STICKMAN_SCALE: f32 = 0.6;
/** `Stickman.mesh`'s bone count, and the bone the probe found clearest. */
const STICKMAN_BONES: u32 = 19;
const SPINE: u32 = 6;
/** Sixty frames, 90 degrees: the probe's posing arm, at the fixture's size. */
const POSE_FRAMES: i32 = 60;
const POSE_RADIANS: f32 = 1.5707963; // 90 degrees
/** The silhouette floor: a quarter of the probe's clean-pose flip (0.0197). */
const FLIP_FLOOR: f64 = 0.005;
/** A deformation moves pixels both ways; a disappearance only one. */
const BOTH_WAYS_FLOOR: f64 = 30.0;

let clause = 0;
let total = 0;

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

function submitted(rc: i32, what: string): void {
  check(rc == 0, "submitting the " + what + " was refused (" + rc.toString() + ")");
}

/// Ask for a frame and wait until a **new** one has been downloaded
/// (guest-motion.ts's sequence: the verb is probe/consume over the *last*
/// frame, so reading twice in a row returns the first one's pixels).
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

/// Is this pixel foreground? The probe's rule, and the reason it is *this*
/// rule: a mesh drawn black and a mesh not drawn at all are the same number
/// under a brightness test, which is exactly the ambiguity that hid a missing
/// vertex shader for a round. The background is the frame's own corner.
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

/// The three numbers the flip clauses need: how much of the frame changed
/// state, and in which directions. A translation and a deformation both flip
/// pixels; only a deformation flips them **both** ways in quantity.
function flip_stats(before: ArrayBuffer, after: ArrayBuffer, out: Float64Array): void {
  const a = Uint8Array.wrap(before);
  const b = Uint8Array.wrap(after);
  let flipped = 0, grew = 0, shrank = 0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      const was = is_foreground(a, x, y);
      const now = is_foreground(b, x, y);
      if (was == now) continue;
      flipped++;
      if (now) grew++;
      else shrank++;
    }
  }
  const total_pixels = <f64>(WINDOW_WIDTH * WINDOW_HEIGHT);
  out[0] = <f64>flipped / total_pixels;
  out[1] = <f64>grew;
  out[2] = <f64>shrank;
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
  const which = gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;
  total = gl3plus ? 10 : 6;

  // What this fixture depends on, said out loud before anything else can be
  // blamed: the wire, the motion record, and the bone record's own offsets.
  assertOgreWireOffsets();
  assertOgreMotionOffsets();
  assertOgreBoneOffsets();

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
  // Everything this fixture loads comes out of one packed volume (chunk 11):
  // tests/resources is packed into build/fixtures.tns and the runner hands the
  // path in as `--tns=`. No mount, no bytes — the fixtures are migrated, not
  // grandfathered.
  assert(tns.length > 0, "no --tns=<volume> argument (run through tests/run.sh)");
  assert(ogre.mountTns("resources", tns) == 0, "mountTns refused");
  ogre.assertSubmissionRegions();

  // ── clause 1: the rigged mesh ────────────────────────────────────────
  clause = 1;
  const mesh_job = ogre.queueMeshLoad("resources/meshes/Stickman.mesh", 0);
  check(mesh_job > 0, "queueMeshLoad did not return a job id");
  settle(mesh_job);
  check(ogre.jobState(mesh_job) == JOB_DONE,
        "Stickman.mesh did not reach DONE (state " + ogre.jobState(mesh_job).toString() +
        ", error " + ogre.jobError(mesh_job).toString() + ")");
  const mesh_resource = ogre.jobResult(mesh_job);
  check(mesh_resource > 0, "no resource id for Stickman.mesh");
  print("1 ok");

  // ── clause 2: the loader says it is rigged, and how big the rig is ───
  clause = 2;
  check(ogre.isRigged(mesh_resource), "the loader does not report Stickman.mesh as rigged");
  check(ogre.boneCount(mesh_resource) == STICKMAN_BONES,
        "the rig is " + ogre.boneCount(mesh_resource).toString() + " bones, not " +
        STICKMAN_BONES.toString());
  print("2 ok");

  // ── clause 3: the scene ──────────────────────────────────────────────
  // PBS with the colour in emissive: a skinned mesh under HlmsUnlit would be a
  // still picture, and a PBS material with no light rig shows only what it
  // emits (DESIGN.md §5.1, §14).
  clause = 3;
  const material = Material.pbs(0.0, 0.0, 0.0, 1.0, 0.0);
  material.materialId = 1;
  material.specularR = 0.0;
  material.specularG = 0.0;
  material.specularB = 0.0;
  material.emissiveR = 0.9;
  material.emissiveG = 0.2;
  material.emissiveB = 0.2;
  submitted(ogre.submitMaterial(material), "material");

  const camera = CameraRecord.perspective(0.7853982, 4.0 / 3.0, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  submitted(ogre.submitCamera(camera), "camera");

  const hero = Renderable.at(mesh_resource, 1, 0.0, 0.0, 0.0, STICKMAN_SCALE);
  hero.renderableId = 1;
  submitted(ogre.submitRenderable(hero), "renderable");
  print("3 ok");

  // ── clause 4: a batch is accepted, a bad one is refused whole ────────
  clause = 4;
  const bones = new BoneBatch();
  bones.set(0, 1, SPINE);
  const accepted = bones.commit();
  check(accepted == 1, "a one-entry bone batch returned " + accepted.toString());

  // The batch is all-or-nothing, and a bad entry takes the whole thing down:
  // here a renderable id nothing was submitted at. Nothing about the good
  // entry that shares the call is applied.
  //
  // What the guest can see of that refusal is "not the count". A synchronous
  // verb that returns a negative errno writes nothing into the guest's return
  // slot (tension_adapter.h: `ret` carries the *value*; the errno is the
  // function's return, which the session logs — this fixture's run shows
  // `ogre::submit_bones -> adapter status -2` on stderr). The count-returning
  // shape is what makes that legible: a success returns the number of entries,
  // so 0 is a refusal and nothing else.
  const bad = new BoneBatch();
  bad.set(0, 999, SPINE);
  const refused = bad.commit();
  check(refused != 1, "a batch naming a dead renderable came back as accepted");

  // And a bone past the end of the rig, which is the refusal that needs the
  // loader's bone count on the guest thread.
  const past = new BoneBatch();
  past.set(0, 1, STICKMAN_BONES);
  const past_refused = past.commit();
  check(past_refused != 1, "a bone index past the rig came back as accepted");

  // The good case still works after two refusals: nothing was left half-set.
  const again = new BoneBatch();
  again.set(0, 1, SPINE);
  check(again.commit() == 1, "a good batch after two refusals was not accepted");
  print("4 ok");

  // Let the render thread catch up before the baseline. The datablock, the item
  // and the shader are made there one frame at a time, and a frame grabbed
  // before they exist is an empty one — measured, this fixture's first run read
  // 0 non-background pixels at frame 1 and 1376 by frame 62.
  for (let settle: u32 = 0; settle < 12; settle++) RuntimeSession.wait(16);
  const baseline_frame = ogre.frameCount();
  let baseline: ArrayBuffer | null = null;
  if (gl3plus) {
    baseline = grab();
    check(baseline != null, "no baseline frame could be downloaded");
  }

  // ── clause 5: sixty frames of posing, one batch each ─────────────────
  clause = 5;
  let batches = 0;
  for (let step: i32 = 0; step < POSE_FRAMES; step++) {
    for (let guard: u32 = 0; guard < 50 && ogre.frameCount() <
         baseline_frame + <u64>step + 2; guard++) {
      RuntimeSession.wait(2);
    }
    // The angle ramps across the whole run, so the last frame is the full 90
    // degrees and every frame in between is a slightly different pose.
    const angle = POSE_RADIANS * <f32>step / <f32>(POSE_FRAMES - 1);
    const pose = new BoneBatch();
    pose.setRotation(0, 1, SPINE, 1.0, 0.0, 0.0, angle);
    const committed = pose.commit();
    check(committed == 1, "frame " + step.toString() + "'s pose returned " +
          committed.toString());
    batches++;
    RuntimeSession.wait(4);
  }
  check(batches == POSE_FRAMES, "the loop ran " + batches.toString() + " frames of poses");
  print("5 ok");

  // ── clause 6: the loop ran in the renderer's own time ────────────────
  clause = 6;
  const last_frame = ogre.frameCount();
  check(last_frame >= baseline_frame + <u64>POSE_FRAMES,
        "the frame counter advanced " + (last_frame - baseline_frame).toString() +
        " frames, not " + POSE_FRAMES.toString());
  print("6 ok");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── the final frame ──────────────────────────────────────────────────
  const final = grab();
  check(final != null, "no final frame could be downloaded");
  const baseline_count = foreground_count(baseline!);
  const final_count = foreground_count(final!);
  const stats = new Float64Array(3);
  flip_stats(baseline!, final!, stats);
  const flip = stats[0];
  const grew = stats[1];
  const shrank = stats[2];
  print("baseline: " + baseline_count.toString() + " non-background px, frame " +
        baseline_frame.toString());
  print("final: " + final_count.toString() + " non-background px, frame " +
        last_frame.toString());
  print("report: flip " + flip.toString() + " (" + stats[1].toString() + " became foreground, " +
        stats[2].toString() + " became background), " + batches.toString() +
        " pose batches, no motion submitted");

  // ── clause 7: the baseline is a solid blob ───────────────────────────
  clause = 7;
  check(baseline_count > 800.0,
        "the baseline is " + baseline_count.toString() +
        " px — the mesh is not filling the frame as the probe measured");
  print("7 ok");

  // ── clause 8: it still renders ───────────────────────────────────────
  clause = 8;
  check(final_count > baseline_count * 0.7 && final_count < baseline_count * 1.3,
        "the pixel count moved outside +/-30%: " + baseline_count.toString() + " -> " +
        final_count.toString());
  print("8 ok");

  // ── clause 9: the silhouette changed shape ───────────────────────────
  clause = 9;
  check(flip >= FLIP_FLOOR,
        "only " + flip.toString() + " of the frame flipped, below " + FLIP_FLOOR.toString());
  print("9 ok");

  // ── clause 10: it is a deformation, not a disappearance ──────────────
  clause = 10;
  check(grew >= BOTH_WAYS_FLOOR && shrank >= BOTH_WAYS_FLOOR,
        "the change was one-way (" + grew.toString() + " gained, " + shrank.toString() +
        " lost): the mesh moved or vanished rather than deforming");
  print("10 ok");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
