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
// at the orientation it stopped in — though a body that ends up *rolling* on the
// floor keeps rolling, because this model has no rolling resistance: its contact
// has no slip left for friction to act on. The run ends at the frame cap when
// that happens, and the summary's "R rolling" count says how many.
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
  ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession,
} from "tension-framework";
// The physics layer: bodies, contacts, impulses, and the cadence.
import { World, WorldConfig } from "tension-framework/assembly/physics";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

const DT: f64 = 1.0 / 60.0;
/** How long the simulation runs before the summary, if nothing rests sooner. */
const FRAMES: i32 = 300;
/** What "at rest" means here: the probe measured 0.057 m/s for a settled pile. */
const REST_SPEED: f64 = 0.1;
const DEFAULT_BODIES: i32 = 64;
const RADIUS: f64 = 0.4;
const EXTENT: f64 = 4.0; // the box is 8x8 units, the floor at y = 0
/** `cube.mesh` is 100 units across, so this draws one diameter (2r = 0.8). */
const MESH_SCALE: f64 = 0.008;
const FLOOR_ID: u32 = 1;
const FIRST_BODY_ID: u32 = 100;

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("bouncing-bodies: " + what);
  assert(false, what);
}

export function _start_game(): void {
  let renderer = "null";
  let bodies = DEFAULT_BODIES;
  let angular = false;
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
    if (value.startsWith("--bodies=")) bodies = I32.parseInt(value.slice(9));
    if (value == "--angular") angular = true;
  }
  const windowed = renderer == "gl3plus";
  // The angular model is fourteen slots per body, so its ceiling is lower: the
  // ABI's 64 KiB state buffer, 8192 f64.
  const slot_cap = angular ? 585 : 1365;
  if (bodies <= 0 || bodies * (angular ? 14 : 6) > 8192) {
    fail("--bodies is outside 1.." + slot_cap.toString() +
         (angular ? " with --angular" : ""));
  }

  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    fail("session_open refused");
  }
  const config = new ogre.ConfigBuilder()
    .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
  const started = ogre.init(config);
  if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");

  // One mesh, drawn N+1 times: OGRE-Next ships no sphere, so the bodies are
  // cubes — scaled to a sphere's diameter, which is what the physics thinks they
  // are. The floor is the same mesh, twenty-four units across, with its top
  // surface at y = 0.
  const job = ogre.queueMeshLoad("cube.mesh", 0);
  if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");
  while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) fail("cube.mesh did not load");
  const cube = ogre.jobResult(job);

  const material = new ogre.Material();
  material.materialId = 1;
  material.kind = ogre.MAT_HLMS_PBS;
  material.diffuseR = 0.0; material.diffuseG = 0.0; material.diffuseB = 0.0;
  material.specularR = 0.0; material.specularG = 0.0; material.specularB = 0.0;
  material.emissiveR = 0.9; material.emissiveG = 0.6; material.emissiveB = 0.3;
  material.roughness = 1.0; material.metalness = 0.0;
  if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

  // A three-quarter view of the box: high enough to see the pile, close enough
  // that the bodies are more than a few pixels across. The rotation is a pitch
  // about X aimed at the middle of the box — an identity rotation would look
  // down -Z at empty sky, which is what the earlier examples' straight-on
  // cameras never had to say out loud.
  const eye_y = 6.0, eye_z = 11.0, aim_y = 0.8;
  const pitch = Math.atan2(aim_y - eye_y, eye_z);
  const camera = ogre.CameraRecord.perspective(45.0 * (3.14159265358979 / 180.0),
                                               <f32>640 / <f32>480, 0.1, 200.0, 0.0, <f32>eye_y, <f32>eye_z);
  camera.rotationX = <f32>Math.sin(pitch * 0.5);
  camera.rotationY = 0.0;
  camera.rotationZ = 0.0;
  camera.rotationW = <f32>Math.cos(pitch * 0.5);
  camera.cameraId = 1;
  if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

  const floor = ogre.Renderable.at(cube, 1, 0.0, -12.0, 0.0, 0.24);
  floor.renderableId = FLOOR_ID;
  if (ogre.submitRenderable(floor) != 0) fail("submitRenderable refused (floor)");

  // The world: bodies, a container, and the model's constants. K = 4 is the
  // sub-step count the probe's penetration numbers argued for (50 / 13 / 4 mm
  // at K = 1 / 2 / 4).
  const world_config = new WorldConfig();
  world_config.bodies = bodies;
  world_config.radius = RADIUS;
  world_config.gravity = -9.81;
  world_config.substeps = 4;
  world_config.restitution = 0.3;
  world_config.friction = 0.4;
  world_config.bias = 0.2;
  world_config.extent = EXTENT;
  world_config.firstRenderableId = FIRST_BODY_ID;
  world_config.meshScale = MESH_SCALE;
  // `--angular`: orientation in the state, a diagonal inertia per body, and
  // friction that carries a torque. The *collider* does not change — spheres
  // and planes — so a cube drawn here is a sphere's contact geometry, which the
  // README says where a reader will meet it.
  world_config.angular = angular;
  const world = World.create(world_config);
  if (world == null) fail("World.create refused " + bodies.toString() + " bodies");

  // Staggered drop: four layers per column so the bodies actually meet each
  // other in the air and in the pile, from heights low enough to settle inside
  // the run. A carpet of bodies that never touch is not a collision demo.
  // The angular model gets a single layer at floor level, spaced just clear of
  // its neighbours (a hair over one diameter) and dropped from 12 cm: a gentle
  // arrival that jostles the pile, tumbles it, and lets it settle. The tall
  // four-layer drop the linear model wants is the wrong shape here — at these
  // speeds bodies reach rolling, and this model has nothing to stop a rolling
  // sphere with (measured: 0 of 64 asleep at frame 300, KE 3.19).
  const layers = angular ? 1 : 4;
  const side = angular ? <i32>Math.ceil(<f64>Math.sqrt(<f64>(bodies)))
                       : <i32>Math.ceil(<f64>Math.sqrt(<f64>(bodies / 4)));
  // The drop suits the model being demonstrated, and the difference is the
  // honest one: the linear model damps sliding, so bodies dropped from three
  // metres arrive, slide and stop; the angular model has no rolling resistance,
  // so bodies that arrive fast *roll away and never stop* (measured: 0 of 64
  // asleep at frame 300, KE 3.19, with the tall drop). Angular therefore drops
  // them low and close — a pile that lands on itself, tumbles, and settles.
  // Angular spawns them a hair *inside* one diameter: they are born touching,
  // the bias separates them, and the jostle is what makes a cube-shaped body
  // turn — a carpet of spheres that never meet would settle without a single
  // tumble, which demonstrates nothing.
  const spacing = angular ? 2.0 * RADIUS - 0.02 : 3.0 / <f64>side;
  const base = angular ? RADIUS + 0.12 : RADIUS + 0.6;
  const step = 0.9;
  for (let i = 0; i < bodies; i++) {
    const layer = i % layers;
    const column = i / layers;
    const x = -0.5 * <f64>(side) * spacing + <f64>(column % side) * spacing;
    const z = -0.5 * <f64>(side) * spacing + <f64>(column / side) * spacing;
    world!.place(i, x, base + <f64>layer * step, z);
  }
  if (world!.seed() != 0) fail("the solver refused the seed state");

  // Every body is a renderable from the start, so the first frame already shows
  // the whole box: the motion table carries the poses from here on.
  for (let i = 0; i < bodies; i++) {
    const body = ogre.Renderable.at(cube, 1, 0.0, 0.0, 0.0, <f32>MESH_SCALE);
    body.renderableId = FIRST_BODY_ID + <u32>i;
    if (ogre.submitRenderable(body) != 0) fail("submitRenderable refused (body " + i.toString() + ")");
  }

  if (!windowed) print("renderer=null: no window; the physics and the summary are the same");

  // With --angular, what the summary reports: how far each body has *turned*
  // (accumulated per frame, since a quaternion only expresses a rotation mod a
  // full turn) and the fastest it has ever spun. Both are per body and over the
  // whole run, because the interesting moment for a tumbling pile is not the
  // last frame — by then everything that can stop has.
  const prev_q = new Float64Array(bodies * 4);
  const turned = new Float64Array(bodies);
  const fastest_spin = new Float64Array(bodies);
  const now_q = new Float64Array(4);
  if (angular) {
    const b = world!.bodies();
    for (let i = 0; i < bodies; i++) {
      for (let k: i32 = 0; k < 4; k++) prev_q[i * 4 + k] = b.quat(i, k);
    }
  }

  // ── the loop ─────────────────────────────────────────────────────────
  const batch = new ogre.MotionBatch();
  let last = ogre.frameCount(), frame = 0, next_report = 60;
  let contacts_this_frame = 0, total_contacts = 0, contacts_measured = 0;
  while (frame < FRAMES) {
    RuntimeSession.wait(16);
    const now = ogre.frameCount();
    const advance = now - last;
    if (advance == 0) continue; // the renderer has not drawn a new frame yet
    // Clamped: a stalled frame must not turn into a physics avalanche, which is
    // the same reason the loop is paced by the renderer rather than by a clock.
    const steps: i32 = advance > 2 ? 2 : <i32>advance;
    last = now;
    frame += steps;

    if (world!.step(<f64>steps * DT) != 0) fail("world.step refused at frame " + frame.toString());
    contacts_this_frame = world!.contactCount();
    total_contacts += contacts_this_frame;
    contacts_measured += 1;
    if (angular) {
      const b = world!.bodies();
      for (let i = 0; i < bodies; i++) {
        const wx = b.omega(i, 0), wy = b.omega(i, 1), wz = b.omega(i, 2);
        const spin = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (spin > fastest_spin[i]) fastest_spin[i] = spin;
        let dot = 0.0;
        for (let k: i32 = 0; k < 4; k++) {
          now_q[k] = b.quat(i, k);
          dot += now_q[k] * prev_q[i * 4 + k];
        }
        if (dot < 0.0) dot = -dot; // the double cover
        if (dot > 1.0) dot = 1.0;
        turned[i] += 2.0 * Math.acos(dot);
        for (let k: i32 = 0; k < 4; k++) prev_q[i * 4 + k] = now_q[k];
      }
    }
    world!.pose(batch);
    if (batch.commit() != bodies) fail("submit_motion refused the batch");

    // A threshold rather than `frame % 60`: the frame counter advances by one
    // or two per iteration, so an equality test silently skips the report it
    // was written to print (the 6a probe learned this the same way).
    if (frame >= next_report) {
      next_report += 60;
      print("frame " + frame.toString() + "  bodies " + bodies.toString() + "  asleep " +
            world!.asleepCount().toString() + "/" + bodies.toString() + "  max|v| " +
            world!.maxSpeed().toString() + "  contacts " + contacts_this_frame.toString());
    }
    // The loop ends when the pile has stopped — every body asleep — rather than
    // at a frame count: "runs until it settles" is the honest condition, and the
    // frame cap above is the backstop that keeps "never settles" from being
    // "runs forever". Sleeping is per body, so the count climbs as bodies stop
    // and the last one decides when the picture is finished.
    if (world!.asleepCount() == bodies) break;
  }

  const contacts_per_frame = contacts_measured > 0
    ? <f64>total_contacts / <f64>contacts_measured : 0.0;
  print("simulated " + bodies.toString() + " bodies for " + frame.toString() + " frames, " +
        contacts_per_frame.toString() + " contacts/frame, K=" +
        world_config.substeps.toString() + " sub-steps");
  print("asleep " + world!.asleepCount().toString() + "/" + bodies.toString() + ", max|v| " +
        world!.maxSpeed().toString() + ", kinetic energy " + world!.kineticEnergy().toString());
  if (angular) {
    // "R rolling, T tumbling": a body that spun faster than 0.1 rad/s at any
    // point rolled or tumbled, and one that turned more than 30° over the run
    // visibly did. Both counts are of bodies, not degrees, so the line reads as
    // a census of the pile.
    const threshold = 30.0 * (3.14159265358979 / 180.0);
    let rolling = 0, tumbling = 0;
    for (let i = 0; i < bodies; i++) {
      if (fastest_spin[i] > 0.1) rolling += 1;
      if (turned[i] > threshold) tumbling += 1;
    }
    print("angular on, " + rolling.toString() + " rolling, " + tumbling.toString() +
          " tumbling (> 0.1 rad/s at some point; > 30 deg over the run)");
  }

  // One line about the picture, the way the other examples end: a box of bodies
  // that simulates correctly and draws nothing is a bug this line would catch.
  if (windowed) {
    const armed = ogre.frameCount();
    ogre.screenshot(0, 0);
    for (let guard: u32 = 0; guard < 300 && ogre.frameCount() < armed + 3; guard++) {
      RuntimeSession.wait(5);
    }
    const length = ogre.screenshot(0, 0);
    if (length > 0) {
      const frame = new ArrayBuffer(length);
      if (ogre.screenshot(changetype<usize>(frame), length) == length) {
        const pixels = Uint8Array.wrap(frame);
        let drawn = 0;
        for (let i = 0; i < length; i += 4) {
          if (pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40) continue;
          drawn++;
        }
        print("rendered " + ogre.frameCount().toString() + " frames, " + drawn.toString() +
              " non-background pixels");
      }
    }
  }

  world!.destroy();
  ogre.shutdown(); RuntimeSession.close();
}
