// The rigid-body acid test (chunk 6).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-physics.wasm --renderer=gl3plus
//
// Sixteen spheres dropped into a box, simulated for 60 rendered frames — 1.0 s
// of simulated time at dt = 1/60 with K = 4 sub-steps — and then asked whether
// the physics held: is anything still moving, is anything under the floor, is
// anything inside anything else, and is the picture where the state says it
// should be.
//
// The configuration is chunk 6a's probe configuration, not a fresh one: r = 0.1,
// e = 0.3, mu = 0.4, beta = 0.2, K = 4, the probe's four-layer pile. That is
// what makes the tolerances below meaningful — they are the numbers that
// configuration measured (0.057 m/s of creep, 4.0 mm of penetration at K = 4),
// not numbers chosen to make a test pass.
//
// The clauses:
//
//   1. the world runs: 60 frames of 4 sub-steps, every step accepted
//   2. at frame 60, every body is at rest       (|v| < 0.1 m/s)
//   3. at frame 60, every body is above the floor (y >= r - 0.005 m)
//   4. at frame 60, no two bodies interpenetrate (centre distance >= r_i + r_j - 0.010 m)
//   5. at frame 60, the kinetic energy is small (KE < 0.02)
//   6. state writes do not perturb the integrator: an e = 1.0 bounce with a
//      state() + set_state() between every step reaches the same apex as the
//      run without them, within 0.1 %
//
// and, under a renderer with a framebuffer (GL3+):
//
//   7. the pile is drawn: body-coloured pixels are within the band the state and
//      the pinned camera predict
//   8. nothing is under the floor on screen: every body's lowest pixel is above
//      the floor's image at that body's own position
//   9. settled, not merely still: the flip fraction between two early frames is
//      clearly non-zero and between two late frames is exactly 0
//
// and, with sleeping (chunk 7):
//
//  10. after 240 frames every body is asleep
//  11. the kinetic energy is exactly 0.0 — the strong form, because every
//      velocity was zeroed rather than merely damped
//  12. the state vector at frame 240 is bit-for-bit the one at frame 210: the
//      clause that tells "asleep" from "creeping slowly", which chunk 6 (with
//      its measured 0.057 m/s creep) could not make
//
// The clause numbers are identities, not a running order: the structural tail
// (10-12) is measured before the visual tier's (7-9) because the pile has to
// finish settling before there is a picture to assert anything about.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import { Solver, SolverConfig } from "../../tension-framework/assembly/solver";
import { World, WorldConfig, physics_buf_in, physics_buf_out } from "../../tension-framework/assembly/physics";
import * as ogre from "../../tension-framework/assembly/ogre";
import { CameraRecord, Material, Renderable } from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
const DT: f64 = 1.0 / 60.0;
const FRAMES: i32 = 60;
const BODIES: i32 = 16;
const RADIUS: f64 = 0.1;
const EXTENT: f64 = 4.0;
const MESH_SCALE: f64 = 0.002; // cube.mesh is 100 units: 0.2 units across = one diameter
/** The camera, pinned: the projection below is this geometry, not a guess. */
const EYE_Y: f64 = 6.0, EYE_Z: f64 = 11.0, AIM_Y: f64 = 0.8;
const FOV_Y: f64 = 45.0 * (3.14159265358979 / 180.0);
const FLOOR_ID: u32 = 1, FIRST_BODY_ID: u32 = 100;
/** The floor's colour differs from the bodies', so pixels can be attributed. */
const FLOOR_RGB: f64[] = [0.35, 0.35, 0.40];
const BODY_RGB: f64[] = [0.9, 0.55, 0.25];
/** How far a body-coloured pixel may sit from the body's colour. */
const COLOUR_TOLERANCE: i32 = 60;

// The tolerances, from 6a's probe at exactly this configuration.
const REST_SPEED: f64 = 0.1;
const PENETRATION_ALLOWED: f64 = 0.005;
const PAIR_OVERLAP_ALLOWED: f64 = 0.010;
const KE_ALLOWED: f64 = 0.02;
/** The bounce-fidelity clause: apexes agree to a tenth of a percent. */
const APEX_TOLERANCE: f64 = 0.001;
/** While the bodies are falling, this fraction of the *pile's* pixels must
 * change between two frames... */
const MOVING_FLIP_FLOOR: f64 = 0.15;
/** ...and once settled, no more than this. The denominator is the pile, not the
 * frame: sixteen bodies of 17 px are 220 px of 76,800, so a whole-frame fraction
 * measures the frame's emptiness rather than the physics (the first version of
 * this clause asked for 0.1 % of the frame and got 0.078 % — the pile moving
 * perfectly well). */
const RESTING_FLIP_CEILING: f64 = 0.03;

let clause = 0;
let total = 0;

function fail(reason: string): void {
  print("ACID " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

// ── the picture ──────────────────────────────────────────────────────────

/// The camera's basis, for the projection below: it sits at (0, EYE_Y, EYE_Z)
/// with a pitch about X, so its forward axis is (0, sin, -cos) and its up is
/// (0, cos, sin).
function forward(): Float64Array {
  const pitch = Math.atan2(AIM_Y - EYE_Y, EYE_Z);
  const out = new Float64Array(3);
  out[0] = 0.0;
  out[1] = Math.sin(pitch);
  out[2] = -Math.cos(pitch);
  return out;
}

function up(): Float64Array {
  const pitch = Math.atan2(AIM_Y - EYE_Y, EYE_Z);
  const out = new Float64Array(3);
  out[0] = 0.0;
  out[1] = Math.cos(pitch);
  out[2] = Math.sin(pitch);
  return out;
}

/// Where a world point lands on the screen: the image row, or -1 when it is
/// behind the camera. Perspective projection by hand, because the guest has no
/// matrix helpers and the geometry is one camera and one plane.
function projectRow(x: f64, y: f64, z: f64): f64 {
  const f = forward(), u = up();
  const dx = x - 0.0, dy = y - EYE_Y, dz = z - EYE_Z;
  const depth = dx * f[0] + dy * f[1] + dz * f[2];
  if (depth <= 0.01) return -1.0;
  const vertical = dx * u[0] + dy * u[1] + dz * u[2];
  const half_height_world = depth * Math.tan(FOV_Y * 0.5);
  return <f64>(WINDOW_HEIGHT) * 0.5 *
         (1.0 - vertical / half_height_world); // row 0 is the top of the frame
}

/// How many pixels one body covers at `distance` along the view axis: the
/// projected radius times the pixels-per-world-unit at that depth, squared.
function projectedArea(distance: f64): f64 {
  const pixels_per_unit = (<f64>(WINDOW_HEIGHT) * 0.5) / (distance * Math.tan(FOV_Y * 0.5));
  const radius_px = RADIUS * pixels_per_unit;
  return 3.14159265358979 * radius_px * radius_px;
}

/// A screenshot, armed and waited for (the verb is probe/consume over the last
/// downloaded frame, so a second read without a wait returns the first one).
function grab(): ArrayBuffer | null {
  const armed = ogre.frameCount();
  ogre.screenshot(0, 0);
  for (let guard: u32 = 0; guard < 300 && ogre.frameCount() < armed + 3; guard++) {
    RuntimeSession.wait(5);
  }
  const length = ogre.screenshot(0, 0);
  if (length <= 0) return null;
  const frame = new ArrayBuffer(length);
  if (ogre.screenshot(changetype<usize>(frame), length) != length) return null;
  return frame;
}

/// Whether a pixel is closer to the body colour than to the floor's.
function is_body_pixel(pixels: Uint8Array, at: i32): bool {
  const r = <i32>pixels[at], g = <i32>pixels[at + 1], b = <i32>pixels[at + 2];
  const to_body = abs(r - <i32>(BODY_RGB[0] * 255.0)) + abs(g - <i32>(BODY_RGB[1] * 255.0)) +
                  abs(b - <i32>(BODY_RGB[2] * 255.0));
  const to_floor = abs(r - <i32>(FLOOR_RGB[0] * 255.0)) + abs(g - <i32>(FLOOR_RGB[1] * 255.0)) +
                   abs(b - <i32>(FLOOR_RGB[2] * 255.0));
  return to_body + COLOUR_TOLERANCE < to_floor;
}

class Blob {
  count: i32 = 0;
  lowest_row: i32 = -1;
}

/// The body-coloured pixels: how many, and the lowest (largest) row they reach.
function measure_blob(frame: ArrayBuffer): Blob {
  const pixels = Uint8Array.wrap(frame);
  const blob = new Blob();
  for (let y: i32 = 0; y < WINDOW_HEIGHT; y++) {
    for (let x: i32 = 0; x < WINDOW_WIDTH; x++) {
      const at = (y * WINDOW_WIDTH + x) * 4;
      if (!is_body_pixel(pixels, at)) continue;
      blob.count += 1;
      if (y > blob.lowest_row) blob.lowest_row = y;
    }
  }
  return blob;
}

/// The fraction of the *pile's* pixels that changed between two frames: a pixel
/// is counted when it is body-coloured in either frame and its colour moved.
/// The denominator is that union, so the number says how much of what is on
/// screen actually changed rather than how empty the frame is.
function flip_fraction(before: ArrayBuffer, after: ArrayBuffer): f64 {
  const a = Uint8Array.wrap(before);
  const b = Uint8Array.wrap(after);
  let flipped = 0, considered = 0;
  const total_pixels = WINDOW_WIDTH * WINDOW_HEIGHT;
  for (let i: i32 = 0; i < total_pixels; i++) {
    const at = i * 4;
    const was = is_body_pixel(a, at);
    const now = is_body_pixel(b, at);
    if (!was && !now) continue;
    considered += 1;
    const delta = abs(<i32>a[at] - <i32>b[at]) + abs(<i32>a[at + 1] - <i32>b[at + 1]) +
                  abs(<i32>a[at + 2] - <i32>b[at + 2]);
    if (delta > 12) flipped += 1;
  }
  if (considered == 0) return 0.0;
  return <f64>flipped / <f64>considered;
}

// ── the bounce-fidelity experiment (clause 6) ────────────────────────────

// The callback buffers are the physics layer's, not the fixture's: the ABI's
// convention is two 64 KiB regions per solver, and a second pair here would put
// the module's static data past the pages the arena leaves below `memoryBase`
// (measured: 133 pages required against a 132-page config).
/// `[q', v'] = [v, g]` for a single body: the same shape the physics layer uses,
/// written here so the experiment owes nothing to the layer it is checking.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (dyCap < len) return -22;
  const half = len / 2;
  for (let i = 0; i < half; i++) {
    store<f64>(dyPtr + <usize>i * 8, load<f64>(yPtr + <usize>(half + i) * 8));
  }
  for (let i = half; i < len; i++) {
    store<f64>(dyPtr + <usize>i * 8, (i - half) % 3 == 1 ? -9.81 : 0.0);
  }
  return 0;
}

/// One body thrown straight up, sixty steps of 1/60 s, and the apex it reached.
/// `writes` puts a state() + set_state() between every step — the impulse
/// channel's shape — and the clause is that the two agree.
function apex_reached(writes: bool): f64 {
  const config = new SolverConfig();
  config.method = "verlet";
  config.source = "wasm";
  config.dim = 6;
  const solver = Solver.create(config, {
    derivative: _derivative, bufIn: physics_buf_in, bufOut: physics_buf_out,
  });
  if (solver == null) return -1.0;

  const state = new Float64Array(7); // [t, x, y, z, vx, vy, vz]
  state[2] = 0.0;
  state[5] = 10.0; // thrown upward at 10 m/s
  if (solver!.setState(0.0, state.subarray(1)) != 0) return -1.0;
  let apex = 0.0;
  for (let frame: i32 = 0; frame < FRAMES; frame++) {
    if (solver!.step(DT) != 0) return -1.0;
    if (solver!.state(state) < 0) return -1.0;
    if (state[2] > apex) apex = state[2];
    if (writes && solver!.setState(state[0], state.subarray(1)) != 0) return -1.0;
  }
  solver!.destroy();
  return apex;
}

// ── the run ──────────────────────────────────────────────────────────────

let frame_now: i32 = 0;
let last_frame: u64 = 0;
let early_a: ArrayBuffer | null = null, early_b: ArrayBuffer | null = null;
let late_a: ArrayBuffer | null = null, late_b: ArrayBuffer | null = null;

/// Advance to `target`, one rendered frame at a time — the guest's loop is paced
/// by the renderer, so "advance to frame N" is a wait-and-step loop — capturing
/// the frames the flip clauses need on the way past.
function advance_to(world: World, batch: ogre.MotionBatch | null, target: i32): void {
  while (frame_now < target) {
    RuntimeSession.wait(16);
    const now = ogre.frameCount();
    const elapsed: i32 = <i32>(now - last_frame);
    if (elapsed == 0) continue;
    const advance: i32 = elapsed > 2 ? 2 : elapsed; // clamped: no avalanche
    last_frame = now;
    frame_now += advance;
    if (world.step(<f64>advance * DT) != 0) {
      fail("world.step refused at frame " + frame_now.toString());
    }
    if (batch != null) {
      world.pose(batch);
      if (batch.commit() != BODIES) fail("submit_motion refused the batch");
      if (frame_now >= 10 && early_a == null) early_a = grab();
      if (frame_now >= 20 && early_b == null) early_b = grab();
    }
  }
}

/// The six state components of every body, for the bit-for-bit clause. Read
/// through the accessors like everything else: the layout is not this file's
/// business.
function snapshot(world: World, out: Float64Array): void {
  const body = world.bodies();
  for (let i = 0; i < BODIES; i++) {
    out[i * 6 + 0] = body.pos(i, 0);
    out[i * 6 + 1] = body.pos(i, 1);
    out[i * 6 + 2] = body.pos(i, 2);
    out[i * 6 + 3] = body.vel(i, 0);
    out[i * 6 + 4] = body.vel(i, 1);
    out[i * 6 + 5] = body.vel(i, 2);
  }
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
  total = gl3plus ? 12 : 9;

  const callbacks = makeCallbacks(null, null);
  assert(RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) == 0,
         "session_open refused");
  const config = new ogre.ConfigBuilder()
    .renderer(gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(!gl3plus).vsync(false).frameHz(60).windowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  assert(ogre.init(config) == 0, "ogre::init refused");
  // Everything this fixture loads comes out of one packed volume (chunk 11):
  // tests/resources is packed into build/fixtures.tns and the runner hands the
  // path in as `--tns=`. No mount, no bytes — the fixtures are migrated, not
  // grandfathered.
  assert(tns.length > 0, "no --tns=<volume> argument (run through tests/run.sh)");
  assert(ogre.mountTns("resources", tns) == 0, "mountTns refused");

  // ── the picture's scaffolding ────────────────────────────────────────
  // GL3+ only: the structural tier has no framebuffer to put anything in, and
  // nothing in clauses 1-6 needs a mesh.
  if (gl3plus) {
    const job = ogre.queueMeshLoad("resources/meshes/cube.mesh", 0);
    check(job > 0, "queueMeshLoad refused");
    while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
      RuntimeSession.wait(10);
    }
    check(ogre.jobState(job) == ogre.JOB_DONE, "cube.mesh did not load");
    const cube = ogre.jobResult(job);

    // Two colours, because the clauses attribute pixels: the bodies' colour is
    // what "the pile is drawn" counts, and the floor's is what it must not.
    const floor_material = new Material();
    floor_material.materialId = 1;
    floor_material.kind = ogre.MAT_HLMS_PBS;
    floor_material.diffuseR = 0.0; floor_material.diffuseG = 0.0;
    floor_material.diffuseB = 0.0;
    floor_material.specularR = 0.0; floor_material.specularG = 0.0;
    floor_material.specularB = 0.0;
    floor_material.emissiveR = <f32>FLOOR_RGB[0];
    floor_material.emissiveG = <f32>FLOOR_RGB[1];
    floor_material.emissiveB = <f32>FLOOR_RGB[2];
    floor_material.roughness = 1.0; floor_material.metalness = 0.0;
    check(ogre.submitMaterial(floor_material) == 0, "submitMaterial refused (floor)");

    const body_material = new Material();
    body_material.materialId = 2;
    body_material.kind = ogre.MAT_HLMS_PBS;
    body_material.diffuseR = 0.0; body_material.diffuseG = 0.0;
    body_material.diffuseB = 0.0;
    body_material.specularR = 0.0; body_material.specularG = 0.0;
    body_material.specularB = 0.0;
    body_material.emissiveR = <f32>BODY_RGB[0];
    body_material.emissiveG = <f32>BODY_RGB[1];
    body_material.emissiveB = <f32>BODY_RGB[2];
    body_material.roughness = 1.0; body_material.metalness = 0.0;
    check(ogre.submitMaterial(body_material) == 0, "submitMaterial refused (bodies)");

    const pitch = Math.atan2(AIM_Y - EYE_Y, EYE_Z);
    const camera = CameraRecord.perspective(<f32>FOV_Y,
                                            <f32>WINDOW_WIDTH / <f32>WINDOW_HEIGHT, 0.1, 100.0,
                                            0.0, <f32>EYE_Y, <f32>EYE_Z);
    camera.rotationX = <f32>Math.sin(pitch * 0.5);
    camera.rotationY = 0.0;
    camera.rotationZ = 0.0;
    camera.rotationW = <f32>Math.cos(pitch * 0.5);
    camera.cameraId = 1;
    check(ogre.submitCamera(camera) == 0, "submitCamera refused");

    // The floor: the same cube, twenty-four units across, its top at y = 0.
    const floor = Renderable.at(cube, 1, 0.0, -12.0, 0.0, 0.24);
    floor.renderableId = FLOOR_ID;
    check(ogre.submitRenderable(floor) == 0, "submitRenderable refused (floor)");

    // One renderable per body: the motion table poses them from here on.
    for (let i = 0; i < BODIES; i++) {
      const renderable = Renderable.at(cube, 2, 0.0, 0.0, 0.0, <f32>MESH_SCALE);
      renderable.renderableId = FIRST_BODY_ID + <u32>i;
      check(ogre.submitRenderable(renderable) == 0,
            "submitRenderable refused (body " + i.toString() + ")");
    }
  }

  // ── the world ────────────────────────────────────────────────────────
  const world_config = new WorldConfig();
  world_config.bodies = BODIES;
  world_config.radius = RADIUS;
  world_config.substeps = 4;
  world_config.restitution = 0.3;
  world_config.friction = 0.4;
  world_config.bias = 0.2;
  world_config.extent = EXTENT;
  world_config.firstRenderableId = FIRST_BODY_ID;
  world_config.meshScale = MESH_SCALE;
  const world = World.create(world_config);
  check(world != null, "World.create refused " + BODIES.toString() + " bodies");
  // The probe's pile: four layers per column, so the bodies meet each other.
  const side = 2; // 16 bodies = 4 columns of 4
  for (let i = 0; i < BODIES; i++) {
    const layer = i % 4;
    const column = i / 4;
    const x = -0.5 + <f64>(column % side) * 0.35;
    const z = -0.5 + <f64>(column / side) * 0.35;
    world!.place(i, x, RADIUS + 0.25 + <f64>layer * (2.2 * RADIUS), z);
  }
  check(world!.seed() == 0, "the solver refused the seed state");

  // ── clause 1: sixty frames, four sub-steps each ──────────────────────
  clause = 1;
  const batch = gl3plus ? new ogre.MotionBatch() : null;
  last_frame = ogre.frameCount();
  advance_to(world!, batch, FRAMES);
  world!.readState();
  print("1 ok: " + frame_now.toString() + " frames, " + BODIES.toString() + " bodies, " +
        (frame_now * 4).toString() + " sub-steps");

  // ── clauses 2-5: the state at frame 60 ───────────────────────────────
  clause = 2;
  const body = world!.bodies();
  let worst_speed = 0.0, lowest = 0.0, worst_overlap = 0.0, nan = false;
  for (let i = 0; i < BODIES; i++) {
    const px = body.pos(i, 0), py = body.pos(i, 1), pz = body.pos(i, 2);
    const vx = body.vel(i, 0), vy = body.vel(i, 1), vz = body.vel(i, 2);
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz) || !isFinite(vx) || !isFinite(vy) ||
        !isFinite(vz)) {
      nan = true;
    }
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > worst_speed) worst_speed = speed;
    if (py < lowest || i == 0) lowest = py;
    for (let other = i + 1; other < BODIES; other++) {
      const dx = body.pos(other, 0) - px, dy = body.pos(other, 1) - py,
            dz = body.pos(other, 2) - pz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const overlap = 2.0 * RADIUS - dist;
      if (overlap > worst_overlap) worst_overlap = overlap;
    }
  }
  check(!nan, "the state is not finite: a body has a NaN component");
  check(worst_speed < REST_SPEED, "a body is still moving at " + worst_speed.toString() + " m/s");
  print("2 ok: max|v| " + worst_speed.toString() + " < " + REST_SPEED.toString());

  clause = 3;
  check(lowest >= RADIUS - PENETRATION_ALLOWED,
        "a body's centre is at y = " + lowest.toString() + ", below r - " +
        PENETRATION_ALLOWED.toString());
  print("3 ok: lowest centre " + lowest.toString() + " >= r - " +
        PENETRATION_ALLOWED.toString());

  clause = 4;
  check(worst_overlap < PAIR_OVERLAP_ALLOWED,
        "two bodies overlap by " + worst_overlap.toString() + " m");
  print("4 ok: worst pair overlap " + worst_overlap.toString() + " < " +
        PAIR_OVERLAP_ALLOWED.toString());

  clause = 5;
  const ke = world!.kineticEnergy();
  check(ke < KE_ALLOWED, "total kinetic energy is " + ke.toString());
  print("5 ok: KE " + ke.toString() + " < " + KE_ALLOWED.toString());

  // ── clause 6: the impulse channel does not perturb the integrator ────
  clause = 6;
  const apex_open = apex_reached(false);
  const apex_written = apex_reached(true);
  const apex_delta = abs(apex_written - apex_open) / abs(apex_open);
  check(apex_open > 0.0 && apex_written > 0.0, "the bounce experiment did not run");
  check(apex_delta <= APEX_TOLERANCE,
        "a state write between steps moved the apex by " + (apex_delta * 100.0).toString() + " %");
  print("6 ok: apex " + apex_open.toString() + " open / " + apex_written.toString() +
        " written, delta " + (apex_delta * 100.0).toString() + " %");

  // ── clause 10: the pile sleeps ───────────────────────────────────────
  clause = 10;
  advance_to(world!, batch, 210);
  const before = new Float64Array(BODIES * 6);
  snapshot(world!, before);
  advance_to(world!, batch, 240);
  world!.readState();
  const asleep = world!.asleepCount();
  check(asleep == BODIES,
        "only " + asleep.toString() + " of " + BODIES.toString() +
        " bodies are asleep at frame 240");
  print("10 ok: " + asleep.toString() + "/" + BODIES.toString() + " asleep at frame 240");

  clause = 11;
  const ke_rest = world!.kineticEnergy();
  check(ke_rest == 0.0, "kinetic energy at rest is " + ke_rest.toString() + ", not exactly 0");
  print("11 ok: kinetic energy exactly " + ke_rest.toString());

  clause = 12;
  const after = new Float64Array(BODIES * 6);
  snapshot(world!, after);
  let moved = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] != after[i]) {
      moved = i;
      break;
    }
  }
  if (moved >= 0) {
    fail("state component " + moved.toString() + " changed between frames 210 and 240: " +
         before[moved].toString() + " -> " + after[moved].toString());
  }
  print("12 ok: all " + before.length.toString() +
        " state components bit-for-bit identical at frames 210 and 240");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    world!.destroy();
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── clauses 7-9: the picture ─────────────────────────────────────────
  clause = 7;
  const settled = grab();
  check(settled != null, "no frame could be downloaded");
  late_b = settled;
  const blob = measure_blob(settled!);
  // The band: the sum of the discs (overlap only removes pixels, so the sum is
  // the ceiling) and one disc (the pile's front body is never hidden).
  let sum_area = 0.0, near_area = 0.0;
  for (let i = 0; i < BODIES; i++) {
    const dx = body.pos(i, 0) - 0.0, dy = body.pos(i, 1) - EYE_Y, dz = body.pos(i, 2) - EYE_Z;
    const f = forward();
    const distance = dx * f[0] + dy * f[1] + dz * f[2];
    const area = projectedArea(distance);
    sum_area += area;
    if (area > near_area) near_area = area;
  }
  const ceiling = sum_area * 1.3;
  check(blob.count > 0, "no body-coloured pixel at all: the pile was not drawn");
  check(<f64>blob.count >= near_area * 0.7,
        "the pile covers " + blob.count.toString() + " px, less than one body's " +
        near_area.toString() + " px");
  check(<f64>blob.count <= ceiling,
        "the pile covers " + blob.count.toString() + " px, more than the " +
        ceiling.toString() + " px the state predicts");
  print("7 ok: pile " + blob.count.toString() + " px, one body " + near_area.toString() +
        " px, ceiling " + ceiling.toString() + " px");

  clause = 8;
  // The floor beneath each body projects to a row; a body under the floor would
  // sit below it. The deepest body in the image is the one to check.
  let floor_row = -1.0, deepest_row = -1.0;
  for (let i = 0; i < BODIES; i++) {
    const row = projectRow(body.pos(i, 0), body.pos(i, 1), body.pos(i, 2));
    const beneath = projectRow(body.pos(i, 0), 0.0, body.pos(i, 2));
    if (beneath > floor_row) floor_row = beneath;
    if (row > deepest_row) deepest_row = row;
  }
  check(floor_row > 0.0, "the floor under the pile does not project into the frame");
  check(blob.lowest_row <= <i32>floor_row,
        "body-coloured pixels reach row " + blob.lowest_row.toString() +
        ", below the floor's row " + (<i32>floor_row).toString());
  print("8 ok: lowest body pixel row " + blob.lowest_row.toString() + " <= floor row " +
        (<i32>floor_row).toString());

  clause = 9;
  late_a = grab(); // after the pile slept: two frames of a still picture
  RuntimeSession.wait(16);
  late_b = grab();
  check(early_a != null && early_b != null, "the early frames were not captured");
  check(late_a != null && late_b != null, "the late frames were not captured");
  const moving = flip_fraction(early_a!, early_b!);
  const resting = flip_fraction(late_a!, late_b!);
  check(moving > MOVING_FLIP_FLOOR,
        "two frames while the bodies were falling flipped only " + moving.toString());
  check(resting == 0.0,
        "two frames after the pile slept flipped " + resting.toString() + ", not exactly 0");
  print("9 ok: flip " + moving.toString() + " moving, " + resting.toString() + " at rest");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  world!.destroy();
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
