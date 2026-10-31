// Bouncing bodies: sixty-four spheres dropped into a box, colliding with each
// other and with the walls — real rigid-body physics, driven by the solver and
// drawn through the motion table.
//
// What the physics actually is, because a demo that does not say is a demo that
// lies:
//
//   * **spheres and axis-aligned planes only.** Every body is a sphere; the box
//     is a floor and four walls. There is no other collider pair, and no
//     rotation in the narrow phase, because a sphere's shape does not depend on
//     which way it is facing.
//   * **one impulse pass per contact.** No iteration, no stacking solver: each
//     contact is resolved once, in the order it was generated. A tall pile would
//     sink and jitter — which is why sleeping is future work and why this demo
//     drops bodies into a box rather than building a pyramid.
//   * **a positional bias, not position projection.** The penetration is
//     corrected by a velocity term, so it travels through the same channel as
//     everything else and leaves a few millimetres of overlap at rest.
//   * **no angular dynamics by default.** The bodies translate and do not turn:
//     a rolling orientation would be a kinematic face on a linear model —
//     pleasant to look at, and not what the simulation computed. `--angular`
//     switches to the model that does simulate it (orientation in the state, a
//     diagonal inertia, friction with a torque), and then the bodies tumble and
//     roll for real. **The collider does not change**: the bodies still collide
//     as spheres and are drawn as cubes, so a cube's corner can pass through
//     another body by up to its circumradius. That is the layer's model, stated
//     rather than hidden.
//   * **the state's layout is the solver's**, all positions then all velocities,
//     and `World`'s accessors are the only place that is written down. A guest
//     reading the raw vector has to know it; a guest using the layer does not.
//
// Usage: `./run.sh [--bodies=N] [--angular]`. With `--angular` the bodies
// tumble, friction rolls the ground contact, and the pile freezes with each body
// at the orientation it stopped in — rolling resistance (chunk 9a) is what lets
// a pile that has been set rolling come to rest at all. Measured: 64 of 64 roll,
// 59 of 64 turn past 30°, and all 64 are asleep by frame 136 with a kinetic
// energy of exactly 0.
//
// The cadence is the design: four sub-steps per frame, each one advance → read →
// detect → resolve → write. Writing the state back between sub-steps is what
// `set_state` is for, and chunk 6a measured that it does not perturb the
// integral (a thrown body reached the same apex to 0.0 %).
//
//   ./run.sh                             a window, and a box of falling bodies
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed
//   ./run.sh --bodies=256                a bigger box of them

// The session: the loop, the arena, the event ring, the frame handshake.
import {
  ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession, rt,
} from "tension-framework";
// The physics layer: bodies, contacts, impulses, and the cadence.
import { World, WorldConfig } from "tension-framework/assembly/physics";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";
// The std's task machine: the table the push path parks in (0.7.0a).
import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";

// The host's wake entry. Re-exported because the linker drops an export the
// guest never names (measured: 0 occurrences without this line), and the host
// resolves `__taskWake` by name at load.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

const DT: f64 = 1.0 / 60.0;
/** How long the simulation runs before the summary, if nothing rests sooner. */
const FRAMES: i32 = 300;
const DEFAULT_BODIES: i32 = 64;
const RADIUS: f64 = 0.4;
const EXTENT: f64 = 4.0; // the box is 8x8 units, the floor at y = 0
/** `cube.mesh` is 100 units across, so this draws one diameter (2r = 0.8). */
const MESH_SCALE: f64 = 0.008;
const FLOOR_ID: u32 = 1;
/** The floor's own material, and the first body material: ids 1..palette+1. */
const FLOOR_MATERIAL: u32 = 1;
const BODY_MATERIAL_BASE: u32 = 2;
/**
 * The body palette, cycled by body index. Flat triples in one array because a
 * body's colour is a *material*, and one material per colour is what makes the
 * pile read as distinct bodies rather than one mass: the renderable names the
 * material id when it is submitted, and the motion table that poses it never
 * touches it. The floor gets its own dark neutral, so the ground reads as
 * ground.
 */
const PALETTE_RGB: f64[] = [
  0.90, 0.20, 0.20, // red
  0.20, 0.55, 0.90, // blue
  0.95, 0.75, 0.15, // amber
  0.30, 0.80, 0.35, // green
  0.80, 0.35, 0.85, // violet
  0.95, 0.55, 0.20, // orange
];
const PALETTE_ENTRIES: u32 = 6;
const FLOOR_RGB: f64[] = [0.20, 0.20, 0.22];
const FIRST_BODY_ID: u32 = 100;

const WINDOWED_RENDERER = "gl3plus";

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("bouncing-bodies: " + what);
  assert(false, what);
}

/// Build and submit one PBS material: `lit` shades it with the diffuse and
/// specular, `!lit` puts the colour in emissive.
function submit_material(id: u32, r: f64, g: f64, b: f64, lit: bool,
                         what: string): void {
  const material = new ogre.Material();
  material.materialId = id;
  material.kind = ogre.MAT_HLMS_PBS;
  const litF = <f32>lit, unlitF = <f32>!lit;
  material.diffuseR = <f32>r * litF; material.diffuseG = <f32>g * litF; material.diffuseB = <f32>b * litF;
  material.specularR = 0.5 * litF;   material.specularG = 0.5 * litF;   material.specularB = 0.5 * litF;
  material.emissiveR = <f32>r * unlitF; material.emissiveG = <f32>g * unlitF; material.emissiveB = <f32>b * unlitF;
  material.roughness = 0.5 * litF + 1.0 * unlitF; material.metalness = 0.0;
  if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused (" + what + ")");
}

/// One frame from the renderer's readback, or an empty buffer when there is
/// none. The *waiting* for a frame moved into `run` (0.7.0b): under the host
/// loop a readback cannot pump the session any more, so the caller awaits
/// `rt.frame()` before calling this.
function readback(): ArrayBuffer | null {
  const length = ogre.screenshot(0, 0);
  if (length <= 0) return null;
  const frame = new ArrayBuffer(length);
  if (ogre.screenshot(changetype<usize>(frame), length) != length) return null;
  return frame;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// Whatever `_start_game` needs to know before it touches the runtime.
class Options {
  tns: string = "";
  renderer: string = "null";
  bodies: i32 = DEFAULT_BODIES;
  angular: bool = false;

  get windowed(): bool { return this.renderer == WINDOWED_RENDERER; }
}

/// The launcher names the renderer, the volume and the pile; null needs no
/// display, so it is the default.
function parseArgs(): Options {
  const options = new Options();
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) options.tns = value.slice(6);
    else if (value.startsWith("--renderer=")) options.renderer = value.slice(11);
    else if (value.startsWith("--bodies=")) options.bodies = I32.parseInt(value.slice(9));
    else if (value == "--angular") options.angular = true;
  }
  // The angular model is fourteen slots per body, so its ceiling is lower: the
  // ABI's 64 KiB state buffer, 8192 f64.
  const slot_cap = options.angular ? 585 : 1365;
  if (options.bodies <= 0 || options.bodies * (options.angular ? 14 : 6) > 8192) {
    fail("--bodies is outside 1.." + slot_cap.toString() +
         (options.angular ? " with --angular" : ""));
  }
  return options;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

class Game {
  private options: Options;
  private world: World | null = null;
  // The config the world was built from: the summary prints its sub-step count.
  private worldConfig: WorldConfig = new WorldConfig();

  // ── the simulation's loop-carried state (0.7.0b) ────────────────────────
  // These were locals of `simulate()`, which was one synchronous loop. The
  // frame loop is now the guest's *task*: it parks on `rt.frame()` every frame,
  // and a local that crosses a park must live somewhere the transform can see.
  // A field is that place, and it has the side benefit of being readable in a
  // debugger between frames.
  private frame: i32 = 0;
  private lastFrame: u64 = 0;
  private nextReport: i32 = 0;
  private contactsTotal: i32 = 0;
  private contactsMeasured: i32 = 0;
  private prevQ: Float64Array = new Float64Array(0);
  private fastestSpin: Float64Array = new Float64Array(0);
  private turned: Float64Array = new Float64Array(0);
  private batch: ogre.MotionBatch = new ogre.MotionBatch();

  constructor(options: Options) {
    this.options = options;
  }

  /// The whole guest life, as one task (0.7.0b).
  ///
  /// **One async function, deliberately.** Every `await` in here parks *this*
  /// task on a record the host completes — first the mesh handle, then
  /// `rt.frame()`. An `async` helper would park its own task instead, and its
  /// completion would put this one on the ready queue, which a host-owned loop
  /// never drains (pipeline-notes: an awaitable accessor returns a stamped
  /// handle, never an async wrapper). So the loads, the frame loop and the
  /// readback are inlined rather than composed from async methods.
  async run(): void {
    this.openSession();
    this.openRenderer();
    this.mountAssets();
    // Every local is declared before the first await: the transform scopes a
    // local declared after one to its own resume guard.
    const load: Task<u32> = ogre.loadMesh("resources/models/cube.mesh", 0);
    let mesh: i32 = 0;
    let armed: u64 = 0;
    let guard: i32 = 0;

    await load;                        // parks on (JOBS, jobId)
    mesh = ogre.loadResult(load);
    if (mesh < 0) fail("resources/models/cube.mesh did not load (errno " + mesh.toString() + ")");
    this.submitScene(mesh);
    this.createBodies(mesh);
    if (!this.options.windowed) {
      print("renderer=null: no window; the physics and the summary are the same");
    }

    this.beginSimulation();
    // The frame loop. `await rt.frame()` parks on (FRAME, 0) and the host-owned
    // loop wakes it once per presented frame — no `RuntimeSession.wait`, no
    // `rt.runReady()`, no tick of any kind in this guest.
    //
    // `break` is the exit (0.7.1). This loop carried a `running` flag because
    // the transform refused `break` in an async body; the refusal is gone, so the
    // loop says what it means: run until the pile settles.
    while (true) {
      await rt.frame();
      if (!this.stepSimulation()) break;
    }
    this.endSimulation();

    if (this.options.windowed) {
      // Three frames for the readback to be the picture the pile came to rest
      // at; the old `grab()` pumped the session while it waited, which a host
      // loop cannot do, so it waits on the frame clock instead.
      armed = ogre.frameCount();
      ogre.screenshot(0, 0);
      guard = 0;
      while (guard < 300 && ogre.frameCount() < armed + 3) {
        await rt.frame();
        guard += 1;
      }
      this.captureFrame();
    }

    this.shutdown();
    finished = true;
  }

  /// The session itself: the loop, the arena, the event ring, the frame
  /// handshake. Nothing in this file runs before it opens.
  private openSession(): void {
    // `rt.callbacks()` wires `onBatch`/`onEvent` to the task dispatcher
    // (`rt.deliver`). Threading null handlers here was fine while loading
    // polled `jobState`, but a parked task learns of its completion only
    // through that dispatch: with no handler the records arrive at the guest
    // and are dropped, and the await never resumes.
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

  /// The floor's and the bodies' materials, the light, the camera and the floor
  /// renderable, all taken from the one mesh.
  submitScene(mesh: i32): void {
    // Two material shapes, and the difference is what chunk 10 changed: the
    // **floor** keeps chunk 5b's emissive-only PBS (diffuse and specular zeroed,
    // the colour in emissive), which is what a floor wants — it is scenery, and an
    // unlit-hemisphere floor would go black as soon as a light exists. The
    // **bodies** carry a real diffuse and specular and a zero emissive, so the
    // directional light below shades them: the palette is now a *diffuse* colour,
    // and a tumbling cube shows a lit face and a dark one as it turns. Still PBS
    // for both — no new material kind, no new flag.
    submit_material(FLOOR_MATERIAL, FLOOR_RGB[0], FLOOR_RGB[1], FLOOR_RGB[2], false, "floor");
    for (let i: u32 = 0; i < PALETTE_ENTRIES; i++) {
      submit_material(BODY_MATERIAL_BASE + i, PALETTE_RGB[i * 3 + 0], PALETTE_RGB[i * 3 + 1],
                      PALETTE_RGB[i * 3 + 2], true, "palette " + i.toString());
    }
    // The light: white, from above and in front — the direction the light travels
    // is down and away from the camera, so it comes from the camera's own side and
    // lights the faces a viewer can see. Intensity 20 and not 1: `intensity` is a
    // power scale, and a lit surface at 1.0 measures 26/255, which is a surface
    // that is lit and looks black (DESIGN.md §5.1).
    const light = new ogre.LightRecord();
    light.lightId = 1;
    light.kind = ogre.LIGHT_DIRECTIONAL;
    light.colourR = 1.0; light.colourG = 1.0; light.colourB = 1.0;
    light.intensity = 20.0;
    light.directionX = 0.0;
    light.directionY = <f32>-0.8944271909999159; // (0, -1, -0.5) normalised
    light.directionZ = <f32>-0.4472135954999579;
    if (ogre.submitLight(light) != 0) fail("submitLight refused");
    print("materials: floor rgb(" + FLOOR_RGB[0].toString() + ", " + FLOOR_RGB[1].toString() +
          ", " + FLOOR_RGB[2].toString() + ") emissive, " + PALETTE_ENTRIES.toString() +
          " body colours cycled by index, lit by one directional light at intensity 20");

    // A three-quarter view of the box: high enough to see the pile, close enough
    // that the bodies are more than a few pixels across. The rotation is a pitch
    // about X aimed at the middle of the box — an identity rotation would look
    // down -Z at empty sky, which is what the earlier examples' straight-on
    // cameras never had to say out loud.
    const eye_y = 6.0, eye_z = 11.0, aim_y = 0.8;
    const pitch = Math.atan2(aim_y - eye_y, eye_z);
    const camera = ogre.CameraRecord.perspective(45.0 * (3.14159265358979 / 180.0),
                                                 <f32>640 / <f32>480, 0.1, 200.0, 0.0, <f32>eye_y, <f32>eye_z);
    camera.rotation.x = <f32>Math.sin(pitch * 0.5);
    camera.rotation.y = 0.0;
    camera.rotation.z = 0.0;
    camera.rotation.w = <f32>Math.cos(pitch * 0.5);
    camera.cameraId = 1;
    if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

    const floor = ogre.Renderable.at(mesh, FLOOR_MATERIAL, 0.0, -12.0, 0.0, 0.24);
    floor.renderableId = FLOOR_ID;
    if (ogre.submitRenderable(floor) != 0) fail("submitRenderable refused (floor)");
  }

  /// The world, the drop that fills it, and one renderable per body.
  private createBodies(mesh: i32): void {
    // The world: bodies, a container, and the model's constants. K = 4 is the
    // sub-step count the probe's penetration numbers argued for (50 / 13 / 4 mm
    // at K = 1 / 2 / 4).
    this.worldConfig.bodies = this.options.bodies;
    this.worldConfig.radius = RADIUS;
    this.worldConfig.gravity = -9.81;
    this.worldConfig.substeps = 4;
    this.worldConfig.restitution = 0.3;
    this.worldConfig.friction = 0.4;
    this.worldConfig.bias = 0.2;
    this.worldConfig.extent = EXTENT;
    this.worldConfig.firstRenderableId = FIRST_BODY_ID;
    this.worldConfig.meshScale = MESH_SCALE;
    // `--angular`: orientation in the state, a diagonal inertia per body, and
    // friction that carries a torque. The *collider* does not change — spheres
    // and planes — so a cube drawn here is a sphere's contact geometry, which the
    // README says where a reader will meet it.
    this.worldConfig.angular = this.options.angular;
    this.world = World.create(this.worldConfig);
    if (this.world == null) fail("World.create refused " + this.options.bodies.toString() + " bodies");

    // Staggered drop: four layers per column so the bodies actually meet each
    // other in the air and in the pile, from heights low enough to settle inside
    // the run. A carpet of bodies that never touch is not a collision demo.
    // One layer at floor level for the angular model, four stacked layers for the
    // linear one. The difference is what each model does with a fast arrival: the
    // linear model damps sliding, so bodies dropped from three metres arrive,
    // slide and stop; the angular model's bodies roll instead of sliding, and
    // since chunk 9a it has rolling resistance to stop them — but a tall drop
    // still spends its energy in the air, and the drop that shows the tumble best
    // is the flat one. Measured with `--angular`: 64/64 asleep by frame 136.
    const layers = this.options.angular ? 1 : 4;
    const side = this.options.angular ? <i32>Math.ceil(<f64>Math.sqrt(<f64>(this.options.bodies)))
                                      : <i32>Math.ceil(<f64>Math.sqrt(<f64>(this.options.bodies / 4)));
    // The drop suits the model being demonstrated, and the difference is the
    // honest one: the linear model damps sliding, so bodies dropped from three
    // metres arrive, slide and stop. Angular used to drop them low for a different
    // reason — before chunk 9a-ii it had no rolling resistance, and a tall drop
    // left bodies that rolled away and never stopped (measured then: 0 of 64
    // asleep at frame 300, KE 3.19). The resistance is in now, but the drop stays
    // low and close because that is the drop that *demonstrates* the model: a pile
    // that lands on itself, tumbles, and settles.
    // Angular spawns them a hair *inside* one diameter: they are born touching,
    // the bias separates them, and the jostle is what makes a body turn — a carpet
    // that never meets would settle without a single tumble, which demonstrates
    // nothing (measured: 64 of 64 roll, 59 of 64 turn past 30°).
    const spacing = this.options.angular ? 2.0 * RADIUS - 0.02 : 3.0 / <f64>side;
    const base = this.options.angular ? RADIUS + 0.12 : RADIUS + 0.6;
    const step = 0.9;
    for (let i = 0; i < this.options.bodies; i++) {
      const layer = i % layers;
      const column = i / layers;
      const x = -0.5 * <f64>(side) * spacing + <f64>(column % side) * spacing;
      const z = -0.5 * <f64>(side) * spacing + <f64>(column / side) * spacing;
      this.world!.place(i, x, base + <f64>layer * step, z);
    }
    if (this.world!.seed() != 0) fail("the solver refused the seed state");

    // Every body is a renderable from the start, so the first frame already shows
    // the whole box: the motion table carries the poses from here on.
    for (let i = 0; i < this.options.bodies; i++) {
      const body = ogre.Renderable.at(mesh, BODY_MATERIAL_BASE + (<u32>i % PALETTE_ENTRIES),
                                      0.0, 0.0, 0.0, <f32>MESH_SCALE);
      body.renderableId = FIRST_BODY_ID + <u32>i;
      if (ogre.submitRenderable(body) != 0) fail("submitRenderable refused (body " + i.toString() + ")");
    }
  }

  /// The per-run allocations and the angular bookkeeping's starting point.
  private beginSimulation(): void {
    const bodies = this.options.bodies;

    this.frame = 0;
    this.lastFrame = ogre.frameCount();
    this.nextReport = 60;
    this.contactsTotal = 0;
    this.contactsMeasured = 0;
    this.prevQ = new Float64Array(bodies * 4);
    this.fastestSpin = new Float64Array(bodies);
    this.turned = new Float64Array(bodies);
    if (this.options.angular) {
      const b = this.world!.bodies();
      for (let i = 0; i < bodies; i++) {
        for (let k: i32 = 0; k < 4; k++) this.prevQ[i * 4 + k] = b.quat(i, k);
      }
    }
  }

  /// One frame: advance by however many frames the renderer drew, step, book.
  ///
  /// Synchronous, and called from `run` right after `await rt.frame()`. The
  /// advance is still measured from `ogre.frameCount()` rather than assumed to
  /// be one, because a stalled or doubled frame must not turn into a physics
  /// avalanche — the same reason the loop is paced by the renderer, not a clock.
  ///
  /// Answers `false` when the run is over, which is the loop's `break`.
  private stepSimulation(): bool {
    const now = ogre.frameCount();
    const advance = now - this.lastFrame;
    if (advance == 0) return true; // the renderer has not drawn a new frame yet
    const steps: i32 = advance > 2 ? 2 : <i32>advance;
    this.lastFrame = now;
    this.frame += steps;

    if (this.world!.step(<f64>steps * DT) != 0) {
      fail("world.step refused at frame " + this.frame.toString());
    }
    const contacts_this_frame = this.world!.contactCount();
    this.contactsTotal += contacts_this_frame;
    this.contactsMeasured += 1;

    if (this.options.angular) {
      const b = this.world!.bodies();
      const now_q = new Float64Array(4);
      for (let i = 0; i < this.options.bodies; i++) {
        const wx = b.omega(i, 0), wy = b.omega(i, 1), wz = b.omega(i, 2);
        const spin = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (spin > this.fastestSpin[i]) this.fastestSpin[i] = spin;
        let dot = 0.0;
        for (let k: i32 = 0; k < 4; k++) {
          now_q[k] = b.quat(i, k);
          dot += now_q[k] * this.prevQ[i * 4 + k];
        }
        if (dot < 0.0) dot = -dot; // the double cover
        if (dot > 1.0) dot = 1.0;
        this.turned[i] += 2.0 * Math.acos(dot);
        for (let k: i32 = 0; k < 4; k++) this.prevQ[i * 4 + k] = now_q[k];
      }
    }
    this.world!.pose(this.batch);
    if (this.batch.commit() != this.options.bodies) fail("submit_motion refused the batch");

    // A threshold rather than `frame % 60`: the frame counter advances by one or
    // two per iteration, so an equality test silently skips the report it was
    // written to print (the 6a probe learned this the same way).
    if (this.frame >= this.nextReport) {
      this.nextReport += 60;
      print("frame " + this.frame.toString() + "  bodies " + this.options.bodies.toString() +
            "  asleep " + this.world!.asleepCount().toString() + "/" +
            this.options.bodies.toString() + "  max|v| " + this.world!.maxSpeed().toString() +
            "  contacts " + contacts_this_frame.toString());
    }

    // The loop ends when the pile has stopped — every body asleep — rather than
    // at a frame count: "runs until it settles" is the honest condition, and the
    // FRAMES cap is the backstop that keeps "never settles" from being "runs
    // forever".
    if (this.world!.asleepCount() == this.options.bodies || this.frame >= FRAMES) {
      return false;
    }
    return true;
  }

  /// What the run measured: the counts, then the summaries.
  private endSimulation(): void {
    const contacts_per_frame = this.contactsMeasured > 0
      ? <f64>this.contactsTotal / <f64>this.contactsMeasured : 0.0;
    print("simulated " + this.options.bodies.toString() + " bodies for " + this.frame.toString() +
          " frames, " + contacts_per_frame.toString() + " contacts/frame, K=" +
          this.worldConfig.substeps.toString() + " sub-steps");
    print("asleep " + this.world!.asleepCount().toString() + "/" + this.options.bodies.toString() +
          ", max|v| " + this.world!.maxSpeed().toString() + ", kinetic energy " +
          this.world!.kineticEnergy().toString());
    if (this.options.angular) {
      // "R rolling, T tumbling": a body that spun faster than 0.1 rad/s at any
      // point rolled or tumbled, and one that turned more than 30° over the run
      // visibly did. Both counts are of bodies, not degrees, so the line reads as
      // a census of the pile.
      const threshold = 30.0 * (3.14159265358979 / 180.0);
      let rolling = 0, tumbling = 0;
      for (let i = 0; i < this.options.bodies; i++) {
        if (this.fastestSpin[i] > 0.1) rolling += 1;
        if (this.turned[i] > threshold) tumbling += 1;
      }
      print("angular on, " + rolling.toString() + " rolling, " + tumbling.toString() +
            " tumbling (> 0.1 rad/s at some point; > 30 deg over the run)");
    }
  }

  /// One line about the picture, the way the other examples end: a box of bodies
  /// that simulates correctly and draws nothing is a bug this line would catch.
  private captureFrame(): void {
    const frame = readback();
    if (frame == null) return;
    const pixels = Uint8Array.wrap(frame!);
    let drawn = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40) continue;
      drawn++;
    }
    print("rendered " + ogre.frameCount().toString() + " frames, " + drawn.toString() +
          " non-background pixels");
  }

  /// Bring the world, the renderer and the session down.
  shutdown(): void {
    this.world!.destroy();
    ogre.shutdown();
    RuntimeSession.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function _start_game(): void {
  rt.start();
  // The table the push path parks slots in (0.7.0a). Eight slots: this guest
  // parks one task at a time — the run task, on the mesh and then on the frame —
  // and every wake frees the slot before the continuation runs.
  __taskBindTable(8);
  const game = new Game(parseArgs());
  // A floating task: it runs the synchronous prologue (session, renderer,
  // volume) and parks at the mesh load. `_start_game` returns here, and from
  // now on the host owns the loop.
  game.run();
}

/// 1 while the guest wants the host to drive it (0.7.0a).
///
/// Cleared only after `run` has finished teardown — never when the frame loop
/// stops — so the host's exit condition (`_game_running() == 0` and nothing
/// parked) cannot cut the last frame or the readback off.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}
