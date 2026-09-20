// The 4 acid test: a solver steps once per renderer frame and drives bodies
// through one `submit_motion` call per frame.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-motion.wasm --renderer=gl3plus [--bodies=N]
//
// The clauses (DESIGN.md §14: the acid test is the milestone gate):
//
//   1. Barrel.mesh loads: job DONE, resource id > 0
//   2. an Unlit material, a camera and the bodies are submitted
//   3. the solver is created (rk45, dim = 2) and its state seeded
//   4. a motion batch of N entries is accepted in **one** call
//   5. the renderer's frame counter advances past the loop's target
//
// and, under a renderer with a framebuffer (GL3+), the pixel clauses:
//
//   6. the baseline centroid is where the probe measured the barrel at x = 0
//   7. after 30 renderer frames the hero still renders (±30% of the pixels)
//   8. its centroid moved +X
//   9. the centroid delta equals the solver's own Δx over the measured
//      pixels-per-unit, within ±4 px — the clause that says "matches what the
//      solver specified" rather than "something moved"
//  10. the frame rate held a floor while carrying N motion entries per frame
//
// Two choices make this deterministic rather than flaky. The path is
// **constant velocity**: the screenshot's request→download latency is a
// constant offset, so it cancels in a delta, where an oscillator — the natural
// demo — would bias it. And the solver steps **per renderer frame, not per wall
// second**: the comparison is pixels against the solver's own state, so
// wall-clock jitter cannot fail the assertion.
//
// The baseline is taken *before* the solver starts, so "the hero is at x = 0"
// is a tight claim rather than a claim about how many frames the setup took.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  ConfigBuilder,
  RuntimeSession,
  makeCallbacks,
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { MotionBatch } from "../../tension-framework/assembly/ogre/motion";
import {
  JOB_DONE,
  JOB_FAILED,
  MAT_HLMS_UNLIT,
  CameraRecord,
  Material,
  Renderable,
  assertOgreMotionOffsets,
  assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";
import { Solver, SolverConfig } from "../../tension-framework/assembly/solver";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
const FRAME_BYTES: i32 = WINDOW_WIDTH * WINDOW_HEIGHT * 4;
/** The barrel's scale: the probe's, so the calibration transfers. */
const BARREL_SCALE: f32 = 0.02;
/** Where the probe measured the barrel's centroid with the body at x = 0. */
const BASELINE_CENTROID: f64 = 159.5;
/** The probe's measured scale: 72.09 px per world unit (analytic 72.4). */
const PX_PER_UNIT: f64 = 72.09;
/** The solver's velocity, units per second, and how long the loop runs. */
const VELOCITY: f64 = 0.5;
const STEPS: i32 = 30;
const STEP_SECONDS: f64 = 1.0 / 60.0;
/** What 30 steps of 0.5 units/s look like in pixels: the prediction. */
const PREDICTED_PX: f64 = VELOCITY * STEPS * STEP_SECONDS * PX_PER_UNIT;
/** The band the prediction is asserted within, and a floor inside it: the floor
 * is the prediction minus the band, so clauses 8 and 9 cannot disagree. */
const BAND_PX: f64 = 4.0;
const FLOOR_PX: f64 = PREDICTED_PX - BAND_PX;

// The solver's two callback buffers: 64 KiB each, in the guest's own memory,
// the addresses the host writes through (GUEST_ABI.md §3.6).
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);

export function deriv_buf_in(): i32 {
  return i32(BUF_IN);
}

export function deriv_buf_out(): i32 {
  return i32(BUF_OUT);
}

/// f(t, y) = [v, 0]: constant velocity, which is the point of the fixture.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (dyCap < len) return -22;
  store<f64>(dyPtr, load<f64>(yPtr + 8)); // dx/dt = v
  store<f64>(dyPtr + 8, 0.0);             // dv/dt = 0
  return 0;
}

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

/// Ask for a frame and wait until a **new** one has been downloaded.
///
/// The verb is probe/consume over the *last* frame, and "last" is the previous
/// capture until the renderer has had time to replace it — reading twice in a
/// row without waiting returns the first frame's pixels, which is what this
/// fixture did before the frame counter was used to sequence the read. So: arm
/// the readback, wait for the renderer to advance, then read.
function grab(): ArrayBuffer | null {
  const armed_at = ogre.frameCount();
  if (ogre.screenshot(0, 0) < 0) {
    // Nothing has ever been downloaded: the first request needs a frame too.
  }
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

/// The probe's background rule, reused so the two measurements are comparable.
function count_and_centroid(frame: ArrayBuffer, out: Float64Array): void {
  const pixels = Uint8Array.wrap(frame);
  let count = 0;
  let sum_x: f64 = 0.0;
  for (let y = 0; y < WINDOW_HEIGHT; y++) {
    for (let x = 0; x < WINDOW_WIDTH; x++) {
      const at = <usize>((y * WINDOW_WIDTH + x) * 4);
      if (pixels[at] < 40 && pixels[at + 1] < 40 && pixels[at + 2] < 40) continue;
      count++;
      sum_x += <f64>x;
    }
  }
  out[0] = <f64>count;
  out[1] = count == 0 ? -1.0 : sum_x / <f64>count;
}

export function _start_game(): void {
  let renderer = "null";
  let bodies: i32 = 1;
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
    if (value.startsWith("--bodies=")) bodies = I32.parseInt(value.slice(9));
  }
  const gl3plus = renderer == "gl3plus";
  if (bodies < 1) bodies = 1;
  const which = gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;
  total = gl3plus ? 10 : 5;

  // What this fixture depends on, said out loud: the wire's offsets and the
  // motion record's own, before anything else can be blamed.
  assertOgreWireOffsets();
  assertOgreMotionOffsets();

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

  // ── clause 1: the mesh ───────────────────────────────────────────────
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

  // ── clause 2: the scene ──────────────────────────────────────────────
  clause = 2;
  const material = new Material();
  material.materialId = 1;
  material.kind = MAT_HLMS_UNLIT;
  material.diffuseR = 0.9;
  material.diffuseG = 0.2;
  material.diffuseB = 0.2;
  material.diffuseA = 1.0;
  submitted(ogre.submitMaterial(material), "material");

  const camera = new CameraRecord();
  camera.cameraId = 1;
  camera.fovY = 45.0 * (3.14159265358979 / 180.0); // the probe's calibration
  camera.aspect = <f32>WINDOW_WIDTH / <f32>WINDOW_HEIGHT;
  camera.nearClip = 0.1;
  camera.farClip = 100.0;
  camera.positionX = 0.0;
  camera.positionY = 0.0;
  camera.positionZ = 4.0;
  camera.rotationW = 1.0;
  submitted(ogre.submitCamera(camera), "camera");

  // The hero at the origin; the companions far off screen at x = -100 - i, so
  // they cost the renderer the work the throughput clause measures without
  // ever entering the pixels the visual clauses read.
  for (let i: i32 = 0; i < bodies; i++) {
    const renderable = new Renderable();
    renderable.renderableId = <u32>(i + 1);
    renderable.materialId = 1;
    renderable.meshResourceId = mesh_resource;
    renderable.positionX = i == 0 ? 0.0 : <f32>(-100.0 - <f64>i);
    renderable.rotationW = 1.0;
    renderable.scaleX = BARREL_SCALE;
    renderable.scaleY = BARREL_SCALE;
    renderable.scaleZ = BARREL_SCALE;
    submitted(ogre.submitRenderable(renderable), "renderable " + (i + 1).toString());
  }
  print("2 ok");

  const batch = new MotionBatch();

  // ── the pixels: baseline, before the solver moves anything ───────────
  let baseline_centroid: f64 = -1.0;
  let baseline_count: f64 = 0.0;
  let final_centroid: f64 = -1.0;
  let final_count: f64 = 0.0;

  if (gl3plus) {
    // Let the renderer apply the submissions before reading anything.
    const settle_from = ogre.frameCount();
    while (ogre.frameCount() < settle_from + 5) RuntimeSession.wait(16);
    const frame = grab();
    check(frame != null, "no baseline frame could be downloaded");
    const stats = new Float64Array(2);
    count_and_centroid(frame!, stats);
    baseline_count = stats[0];
    baseline_centroid = stats[1];
    print("baseline: " + baseline_count.toString() + " non-background px, centroid x " +
          baseline_centroid.toString());
  }

  // ── clause 3: the solver ─────────────────────────────────────────────
  clause = 3;
  const config = new SolverConfig();
  config.method = "rk45";
  config.source = "wasm";
  config.dim = 2;
  config.relTol = 1e-8;
  config.absTol = 1e-10;
  const solver = Solver.create(config, {
    derivative: _derivative,
    bufIn: deriv_buf_in,
    bufOut: deriv_buf_out,
  });
  check(solver != null, "the solver was refused");
  const state = new Float64Array(3); // [t, x, v]
  state[1] = 0.0; // x
  state[2] = VELOCITY; // v
  check(solver!.setState(0.0, state.subarray(1)) == 0, "setState refused the initial state");
  print("3 ok");

  // ── clause 4 and the loop ────────────────────────────────────────────
  // One solver step per renderer frame, one motion batch per frame carrying N
  // entries, and the frame counter is the only clock involved.
  let last_frame = ogre.frameCount();
  const first_frame = last_frame;
  let iterations: u32 = 0;
  let batches: u32 = 0;
  let entries_sent: u32 = 0;
  let committed: i32 = -1;

  clause = 4;
  while (ogre.frameCount() < first_frame + STEPS) {
    if (RuntimeSession.wait(16) < 0) fail("session_wait refused");
    iterations++;
    const now = ogre.frameCount();
    const advance = now - last_frame;
    if (advance == 0) continue;
    last_frame = now;

    if (solver!.step(<f64>advance * STEP_SECONDS) != 0) fail("solver step failed");
    if (solver!.state(state) < 0) fail("solver state failed");

    batch.set(0, 1, <f32>state[1], 0.0, 0.0, BARREL_SCALE);
    for (let i: i32 = 1; i < bodies; i++) {
      batch.set(<u32>i, <u32>(i + 1), <f32>(-100.0 - <f64>(i + 1) + state[1]), 0.0, 0.0,
                BARREL_SCALE);
    }
    committed = batch.commit();
    batches++;
    entries_sent += batch.count();
    check(committed == bodies,
          "the batch was refused (" + committed.toString() + " of " + bodies.toString() + ")");
  }
  check(committed > 0, "no motion batch was ever accepted");
  print("4 ok");

  // ── clause 5: the loop ran ───────────────────────────────────────────
  clause = 5;
  check(ogre.frameCount() >= first_frame + STEPS,
        "the frame counter did not advance past the loop's target");
  print("5 ok");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    solver!.destroy();
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── the final frame ──────────────────────────────────────────────────
  const final = grab();
  check(final != null, "no final frame could be downloaded");
  const final_stats = new Float64Array(2);
  count_and_centroid(final!, final_stats);
  final_count = final_stats[0];
  final_centroid = final_stats[1];

  const solver_x = state[1];
  const delta_px = final_centroid - baseline_centroid;
  const predicted_px = solver_x * PX_PER_UNIT;
  // The report Step 0 asks for: what the batch carried and what it cost.
  print("final: " + final_count.toString() + " non-background px, centroid x " +
        final_centroid.toString() + ", solver x " + solver_x.toString());
  print("report: entries/frame " + bodies.toString() + ", batches " + batches.toString() +
        ", wait iterations " + iterations.toString() + ", frames " +
        (last_frame - first_frame).toString());
  print("report: delta " + delta_px.toString() + " px, predicted " + predicted_px.toString() +
        " px, band +/-" + BAND_PX.toString() + " px");

  // ── clause 6: the baseline is where the probe put it ─────────────────
  clause = 6;
  const baseline_error = baseline_centroid - BASELINE_CENTROID;
  check(baseline_error > -3.0 && baseline_error < 3.0,
        "the baseline centroid is " + baseline_centroid.toString() + ", not " +
        BASELINE_CENTROID.toString());
  print("6 ok");

  // ── clause 7: the hero still renders ─────────────────────────────────
  clause = 7;
  check(baseline_count > 20.0, "the baseline has too few pixels to assert on");
  check(final_count > baseline_count * 0.7 && final_count < baseline_count * 1.3,
        "the pixel count moved outside +/-30%: " + baseline_count.toString() + " -> " +
        final_count.toString());
  print("7 ok");

  // ── clause 8: it moved, in +X, far enough ────────────────────────────
  clause = 8;
  check(delta_px > FLOOR_PX,
        "the centroid moved " + delta_px.toString() + " px, not more than " +
        FLOOR_PX.toString());
  print("8 ok");

  // ── clause 9: it moved by what the solver said ───────────────────────
  clause = 9;
  const error_px = delta_px - predicted_px;
  check(error_px > -BAND_PX && error_px < BAND_PX,
        "the centroid delta " + delta_px.toString() + " px is " + error_px.toString() +
        " px from the solver's " + predicted_px.toString() + " px");
  print("9 ok");

  // ── clause 10: the rate held ─────────────────────────────────────────
  // Estimated, not measured: the guest has no clock, so this is frames over
  // the wait calls that carried them, at the loop's nominal 16 ms.
  clause = 10;
  const frames_advanced = <f64>(last_frame - first_frame);
  const estimated_fps = frames_advanced * 1000.0 / (<f64>iterations * 16.0);
  print("report: ~" + estimated_fps.toString() + " fps (estimated from " +
        iterations.toString() + " wait(16) calls; the guest has no clock)");
  check(estimated_fps >= 30.0,
        "the frame rate estimate is below the floor: " + estimated_fps.toString());
  print("10 ok");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  solver!.destroy();
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
