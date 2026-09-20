// A ball falling, bouncing, and settling: the solver drives the pixels.
//
// The chain: the guest owns a derivative, the solver integrates it, the guest
// turns the state into a transform, and the renderer draws it — with one call
// per frame rather than one per body, because the transforms travel through
// shared memory instead of through a verb each.
//
//   ./run.sh                             headless: no window, same physics
//   TENSION_OGRE_WINDOW_TEST=1 ./run.sh  a real window, and a bouncing ball

// The session: the loop, the arena, the event ring, the frame handshake.
import {
  ConfigBuilder, Solver, SolverConfig, arg, argCount, makeCallbacks, print, RuntimeSession,
} from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

const GRAVITY = -9.81; // m/s², downward
const FLOOR = 0.25; // where the ball turns around
const RESTITUTION = 0.8; // the fraction of speed a bounce keeps
const STEP: f64 = 1.0 / 60.0; // one solver step per rendered frame
const SCALE: f32 = 0.02; // the barrel is about five units across
const BALL = 1; // the renderable id the motion table names
const FRAMES = 300; // give up after this many frames
const BOUNCES = 3; // ... or after this many bounces

// The solver's two callback buffers: 64 KiB each in the guest's own memory, the
// addresses the host writes and reads through (tension-solver/GUEST_ABI.md §3.6).
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);
export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

/// f(t, y) = [v, g], for the state [height, velocity] — a pure function of the
/// state, which is what makes the integration reproducible.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (dyCap < len) return -22; // -EINVAL; the host always calls with dim == dyCap
  store<f64>(dyPtr, load<f64>(yPtr + 8)); // dh/dt = v
  store<f64>(dyPtr + 8, GRAVITY); // dv/dt = g
  return 0;
}

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("bouncing-ball: " + what);
  assert(false, what);
}

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const windowed = renderer == "gl3plus";

  // Same setup as hello-triangle: session, mesh, material, camera, renderable.
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    fail("session_open refused");
  }
  const config = new ogre.ConfigBuilder()
    .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
  const started = ogre.init(config);
  if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");

  const job = ogre.queueMeshLoad("Barrel.mesh", 0);
  if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");
  while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) fail("Barrel.mesh did not load");
  const mesh = ogre.jobResult(job);
  // The factories fill the records; the ids are the guest's own handles.
  const material = ogre.Material.unlit(0.9, 0.6, 0.2);
  material.materialId = 1;
  if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

  // Eight units back, so every bounce stays in frame.
  const camera = ogre.CameraRecord.perspective(
    45.0 * (3.14159265358979 / 180.0), <f32>640 / <f32>480, 0.1, 100.0, 0.0, 0.0, 8.0);
  camera.cameraId = 1;
  if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

  // The ball starts where the solver starts it: three metres up, at rest.
  const renderable = ogre.Renderable.at(mesh, 1, 0.0, 3.0, 0.0, SCALE);
  renderable.renderableId = BALL;
  if (ogre.submitRenderable(renderable) != 0) fail("submitRenderable refused");
  // The solver: the guest owns the derivative, the solver owns the integration.
  const solver_config = new SolverConfig();
  solver_config.method = "rk45";
  solver_config.source = "wasm";
  solver_config.dim = 2;
  solver_config.relTol = 1e-8; solver_config.absTol = 1e-10;
  const solver = Solver.create(solver_config, {
    derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out,
  });
  if (solver == null) fail("Solver.create refused the config");

  const state = new Float64Array(3); // [t, height, velocity]
  state[1] = 3.0; // dropped from three metres
  state[2] = 0.0; // at rest
  if (solver!.setState(0.0, state.subarray(1)) != 0) fail("setState refused the seed");
  if (!windowed) print("renderer=null: no window; the physics and the summary are the same");

  // One solver step and one motion batch per rendered frame.
  const batch = new ogre.MotionBatch();
  let last = ogre.frameCount(), first = last, tallest = state[1], bounces = 0;
  const apexes = new Array<f64>();

  while (ogre.frameCount() < first + FRAMES && bounces < BOUNCES) {
    RuntimeSession.wait(16);
    const now = ogre.frameCount();
    const advance = now - last;
    if (advance == 0) continue; // the renderer has not drawn a new frame yet
    last = now;

    // Stepping per rendered frame keeps the physics and the pictures in step.
    if (solver!.step(<f64>advance * STEP) != 0) fail("solver step failed");
    if (solver!.state(state) < 0) fail("solver state failed");
    if (state[1] > tallest) tallest = state[1];

    // The bounce. A solver integrates smooth derivatives and has no notion of a
    // floor, so the discontinuity lives here, in game logic between steps:
    // reflect the velocity, keep most of its energy, and hand the state back so
    // the next step starts from the floor rather than from below it.
    if (state[1] < FLOOR && state[2] < 0.0) {
      apexes.push(tallest); // how high this arc got, measured before it ended
      bounces++;
      state[1] = FLOOR;
      state[2] = -state[2] * RESTITUTION;
      if (solver!.setState(state[0], state.subarray(1)) != 0) fail("setState refused the bounce");
      tallest = state[1];
    }

    // One call for the frame's motion. An entry is a whole transform, so the
    // ball's size travels with its position.
    batch.set(0, BALL, 0.0, <f32>state[1], 0.0, SCALE);
    if (batch.commit() != 1) fail("submit_motion refused the batch");

    if (now % 30 == 0) {
      print("frame " + now.toString() + "  height " + state[1].toString() + "  speed " +
            state[2].toString());
    }
  }

  let summary = "ball bounced " + bounces.toString() + " times, apex heights";
  for (let i = 0; i < apexes.length; i++) summary += " " + apexes[i].toString();
  print(summary);

  solver!.destroy();
  ogre.shutdown(); RuntimeSession.close();
}
