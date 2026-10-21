// A ball falling, bouncing, and settling: the solver drives the pixels.
//
// The chain: the guest owns a derivative, the solver integrates it, the guest
// turns the state into a transform, and the renderer draws it — with one call
// per frame rather than one per body, because the transforms travel through
// shared memory instead of through a verb each.
//
//   ./run.sh                             a window, and a bouncing ball
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed

// The session: the loop, the arena, the event ring, the frame handshake.
import {
  ConfigBuilder, Solver, SolverConfig, arg, argCount, print, RuntimeSession, rt,
} from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";
// The std's task machine: the table the push path parks in (0.7.0a).
import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";

// The host's wake entry. Re-exported because the linker drops an export the
// guest never names, and the host resolves `__taskWake` by name at load.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

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

const WINDOWED_RENDERER = "gl3plus";

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("bouncing-ball: " + what);
  assert(false, what);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// Whatever `_start_game` needs to know before it touches the runtime.
class Options {
  tns: string = "";
  renderer: string = "null";

  get windowed(): bool { return this.renderer == WINDOWED_RENDERER; }
}

/// The launcher names the renderer and hands in the packed volume; null needs
/// no display, so it is the default.
function parseArgs(): Options {
  const options = new Options();
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) options.tns = value.slice(6);
    else if (value.startsWith("--renderer=")) options.renderer = value.slice(11);
  }
  return options;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

class Game {
  private options: Options;
  private solver: Solver | null = null;
  private state: Float64Array = new Float64Array(3); // [t, height, velocity]
  // The loop's state (0.7.0b): fields, because the frame loop is a task and a
  // local that crosses a park must live where the transform can see it.
  private running: bool = false;
  private last: u64 = 0;
  private first: u64 = 0;
  private tallest: f64 = 0.0;
  private bounces: i32 = 0;
  private apexes: f64[] = [];
  private batch: ogre.MotionBatch = new ogre.MotionBatch();

  constructor(options: Options) {
    this.options = options;
  }

  /// Open the session and the renderer, mount the volume and submit the scene,
  /// then run the simulation: headless is the same physics, printed instead of
  /// drawn.
  async run(): void {
    // Declared before the first await: the transform scopes a local declared
    // after one to its own resume guard.
    let mesh: i32 = 0;

    this.openSession();
    this.openRenderer();
    this.mountAssets();
    const load: Task<u32> = ogre.loadMesh("resources/models/Barrel.mesh", 0);
    await load;                        // parks on (JOBS, jobId)
    mesh = ogre.loadResult(load);
    if (mesh < 0) fail("resources/models/Barrel.mesh did not load (errno " + mesh.toString() + ")");
    this.submitScene(mesh);

    if (!this.options.windowed) {
      print("renderer=null: no window; the physics and the summary are the same");
    }

    this.beginSimulation();
    // The frame loop: one tick per frame the renderer presents, woken by the
    // host. No `RuntimeSession.wait`, no `rt.runReady()`.
    while (this.running) {
      await rt.frame();
      this.stepSimulation();
    }
    this.endSimulation();

    this.shutdown();
    finished = true;
  }

  /// The session itself: the loop, the arena, the event ring, the frame
  /// handshake. Nothing in this file runs before it opens.
  private openSession(): void {
    // Same setup as hello-triangle: session, mesh, material, camera, renderable.
    // `rt.callbacks()` wires `onBatch`/`onEvent` to the task dispatcher: a
    // parked load learns of its completion only through that dispatch, so with
    // no handler the records arrive and are dropped.
    const callbacks = rt.callbacks();
    if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
      fail("session_open refused");
    }
  }

  /// Bring up the renderer the launcher asked for.
  private openRenderer(): void {
    const windowed = this.options.windowed;
    const config = new ogre.ConfigBuilder()
      .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
      .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
    const started = ogre.init(config);
    if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");
  }

  /// Mount the packed volume the assets were shipped in.
  private mountAssets(): void {
    // Everything this example loads comes out of one packed volume (chunk 11):
    // the assets live in `resources/`, `pack.sh` packs them, and the run script
    // hands the absolute path in as `--tns=`. No mount, no bytes — there is no
    // fallback to the disk.
    if (this.options.tns.length == 0) {
      fail("no --tns=<volume> argument (the assets are packed; run via ./run.sh)");
    }
    const mounted = ogre.mountTns("resources", this.options.tns);
    if (mounted != 0) fail("mountTns refused (" + mounted.toString() + ")");
  }

  /// Load the barrel out of the volume, hand the renderer a material, a camera
  /// and the mesh placed in the world, and build the solver that will move it.
  submitScene(mesh: i32): void {
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
    this.solver = Solver.create(solver_config, {
      derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out,
    });
    if (this.solver == null) fail("Solver.create refused the config");

    this.state[1] = 3.0; // dropped from three metres
    this.state[2] = 0.0; // at rest
    if (this.solver!.setState(0.0, this.state.subarray(1)) != 0) fail("setState refused the seed");
  }

  /// The loop's starting point.
  private beginSimulation(): void {
    this.running = true;
    this.last = ogre.frameCount();
    this.first = this.last;
    this.tallest = this.state[1];
    this.bounces = 0;
    this.apexes = new Array<f64>();
  }

  /// One frame: one solver step and one motion batch per rendered frame.
  private stepSimulation(): void {
    const now = ogre.frameCount();
    const advance = now - this.last;
    if (advance == 0) return; // the renderer has not drawn a new frame yet
    this.last = now;

    // Stepping per rendered frame keeps the physics and the pictures in step.
    if (this.solver!.step(<f64>advance * STEP) != 0) fail("solver step failed");
    if (this.solver!.state(this.state) < 0) fail("solver state failed");
    if (this.state[1] > this.tallest) this.tallest = this.state[1];

    // The bounce. A solver integrates smooth derivatives and has no notion of a
    // floor, so the discontinuity lives here, in game logic between steps:
    // reflect the velocity, keep most of its energy, and hand the state back so
    // the next step starts from the floor rather than from below it.
    if (this.state[1] < FLOOR && this.state[2] < 0.0) {
      this.apexes.push(this.tallest); // how high this arc got, measured before it ended
      this.bounces++;
      this.state[1] = FLOOR;
      this.state[2] = -this.state[2] * RESTITUTION;
      if (this.solver!.setState(this.state[0], this.state.subarray(1)) != 0) {
        fail("setState refused the bounce");
      }
      this.tallest = this.state[1];
    }

    // One call for the frame's motion. An entry is a whole transform, so the
    // ball's size travels with its position.
    this.batch.set(0, BALL, 0.0, <f32>this.state[1], 0.0, SCALE);
    if (this.batch.commit() != 1) fail("submit_motion refused the batch");

    if (now % 30 == 0) {
      print("frame " + now.toString() + "  height " + this.state[1].toString() + "  speed " +
            this.state[2].toString());
    }

    // No `break`: the run's two ends are the frame cap and the bounce count.
    if (now >= this.first + FRAMES || this.bounces >= BOUNCES) this.running = false;
  }

  /// The bounces and how high each arc got.
  private endSimulation(): void {
    let summary = "ball bounced " + this.bounces.toString() + " times, apex heights";
    for (let i = 0; i < this.apexes.length; i++) summary += " " + this.apexes[i].toString();
    print(summary);
  }

  /// Bring the solver, the renderer and the session down.
  shutdown(): void {
    this.solver!.destroy();
    ogre.shutdown();
    RuntimeSession.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function _start_game(): void {
  rt.start();
  // The table the push path parks slots in (0.7.0a); one task parks at a time.
  __taskBindTable(8);
  const game = new Game(parseArgs());
  // A floating task: it runs the synchronous prologue and parks at the load.
  game.run();
}

/// 1 while the guest wants the host to drive it (0.7.0a). Cleared after
/// teardown, so the host's exit cannot cut the summary off.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}
