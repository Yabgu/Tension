// The angular acid test (chunk 8, round 8c2).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-angular.wasm --renderer=gl3plus
//
// Sixteen bodies under the angular model — fourteen dropped into a pile, one
// given a horizontal metre per second at floor level, one dropped with a spin —
// simulated for 120 rendered frames (2.0 s at dt = 1/60, K = 4 sub-steps), and
// then asked what the linear model cannot answer:
//
//   1. the world runs: 120 frames of 4 sub-steps, every step accepted
//   2. the pile is asleep at frame 120: fourteen bodies, and their KE exactly 0
//   3. every orientation is finite and normalized: |q| within 1e-6 of 1
//   4. the settled pile's total angular momentum is below 1e-3 kg·m²/s
//   5. **the clause a linear-only model fails** — the sphere given 1 m/s rolls:
//      its orientation turns at least 90° over the run, and at the frame its
//      sliding stops, v/v₀ is 5/7 within 2 % and |ω|·r = |v| within 5 %
//   6. the body dropped with a spin tumbles: its orientation changes by at
//      least 30° while its position moves less than 0.5 m
//   7. **the model's boundary, asserted rather than assumed**: the two bodies
//      this model cannot stop are still moving exactly as it says they must —
//      the roller is still rolling (|ω·r + v| under 5 % of v) and the spinner is
//      still spinning at its initial rate
//
// and, under a renderer with a framebuffer (GL3+):
//
//   8. the bodies are drawn: body-coloured pixels are within ±30 % of the area
//      the state and the pinned camera predict
//   9. nothing is under the floor on screen
//  10. the pile is still and the movers are not: the flip fraction between two
//      early frames is clearly non-zero, and between two late frames it is under
//      a tenth of it — the pile's pixels are frozen, and clause 7's two bodies
//      are still crossing them
//
// **Clauses 2 and 7 are a finding, not a workaround.** A sphere that reaches
// rolling has no slip left for friction to act on, and a sphere spinning about
// the vertical axis has no slip at a contact directly below it — so neither
// stops, and "every body asleep" is not a thing this model produces. Measured:
// the roller settles to a rolling 0.128 m/s after its wall bounce and holds it
// for a hundred frames; a spinner left on the floor turns at exactly 1.0000
// rad/s after two seconds. What this fixture asserts instead is the *shape* of
// that motion, so a model that gains rolling resistance fails clause 7 and has
// to say so (DESIGN.md §12).
//
// The tolerances are chunk 8a's probe numbers for this configuration, not
// numbers chosen to pass: v/v₀ = 0.7161 against the closed form's 5/7 = 0.7143
// (probe Q6, 0.25 % apart), |ω|·r/v = 0.9975 at the sliding-stop, 5.72 rad of
// turn, and a resting-box jitter of ~1.3e-5 rad/frame that the sleep threshold
// sits two orders of magnitude above (Q5, which is what clause 2 rests on).
//
// What this fixture is *not*: a box collider. The bodies collide as spheres
// whatever they are drawn as, so a "rolling" cube here is a sphere's contact
// geometry carrying a diagonal inertia — which is exactly the layer's model, and
// the README says so where a reader will meet it.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import { SHAPE_SPHERE, World, WorldConfig } from "../../tension-framework/assembly/physics";
import * as ogre from "../../tension-framework/assembly/ogre";
import {
  CameraRecord, Material, Renderable, assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
const DT: f64 = 1.0 / 60.0;
const FRAMES: i32 = 120;
const BODIES: i32 = 16;
/** The pile's fourteen, then the roller, then the spinner. */
const PILE: i32 = 14;
/** The fourteen that settle; the roller and the spinner come after them. */
const ROLLER: i32 = 14;
const SPINNER: i32 = 15;
const RADIUS: f64 = 0.1;
const EXTENT: f64 = 4.0;
const MESH_SCALE: f64 = 0.1; // Smiley.mesh is a unit sphere: 0.1 scale = radius 0.1
const FLOOR_SCALE: f64 = 0.24; // cube.mesh is 100 units: 24 units of floor
const EYE_Y: f64 = 6.0, EYE_Z: f64 = 11.0, AIM_Y: f64 = 0.8;
const FOV_Y: f64 = 45.0 * (3.14159265358979 / 180.0);
const FLOOR_ID: u32 = 1, FIRST_BODY_ID: u32 = 100;
const FLOOR_RGB: f64[] = [0.35, 0.35, 0.40];
const BODY_RGB: f64[] = [0.9, 0.55, 0.25];
const COLOUR_TOLERANCE: i32 = 60;

/** The roller's initial speed, and the closed form its sliding phase reaches. */
const ROLL_V0: f64 = 1.0;
const ROLL_CLOSED_FORM: f64 = 5.0 / 7.0; // 0.7142857...
const ROLL_RATIO_TOLERANCE: f64 = 0.02;
const ROLL_SLIP_TOLERANCE: f64 = 0.05;
/** The spinner: 1 rad/s about y = 114° over two seconds, and the clause asks 30°. */
const SPIN_RATE: f64 = 1.0;
const SPIN_TURN_FLOOR: f64 = 30.0 * (3.14159265358979 / 180.0);
const SPIN_MOVE_CEILING: f64 = 0.5;
/** The angular momentum the pile must hold at rest: sleeping zeroes every ω. */
const ANGULAR_MOMENTUM_CEILING: f64 = 1.0e-3;
/** |q| may drift this far from 1 before the model is lying about orientation. */
const NORM_TOLERANCE: f64 = 1.0e-6;
/** The picture's band: the pile's projected area, ±30 %. */
const AREA_BAND: f64 = 0.3;
/** While the bodies move, this much of the drawn pile changes between frames... */
const MOVING_FLIP_FLOOR: f64 = 0.10;

let clause = 0;
let total = 0;
let frame_now: i32 = 0;
let last_frame: u64 = 0;
let early_a: ArrayBuffer | null = null, early_b: ArrayBuffer | null = null;

function fail(reason: string): void {
  print("ACID " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

// ── the picture ──────────────────────────────────────────────────────────

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

function projectRow(x: f64, y: f64, z: f64): f64 {
  const f = forward(), u = up();
  const dx = x - 0.0, dy = y - EYE_Y, dz = z - EYE_Z;
  const depth = dx * f[0] + dy * f[1] + dz * f[2];
  if (depth <= 0.01) return -1.0;
  const vertical = dx * u[0] + dy * u[1] + dz * u[2];
  const half_height_world = depth * Math.tan(FOV_Y * 0.5);
  return <f64>(WINDOW_HEIGHT) * 0.5 * (1.0 - vertical / half_height_world);
}

function projectedArea(distance: f64): f64 {
  const pixels_per_unit = (<f64>(WINDOW_HEIGHT) * 0.5) / (distance * Math.tan(FOV_Y * 0.5));
  const radius_px = RADIUS * pixels_per_unit;
  return 3.14159265358979 * radius_px * radius_px;
}

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

// ── orientation arithmetic, read through the accessors ───────────────────

/// The rotation a quaternion represents, normalized first.
function quat_angle(x: f64, y: f64, z: f64, w: f64): f64 {
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  if (n <= 0.0) return 0.0;
  return 2.0 * Math.atan2(Math.sqrt(x * x + y * y + z * z) / n, w / n);
}

/// The shortest-arc angle between two orientations, in radians.
function quat_delta(a: Float64Array, b: Float64Array): f64 {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0.0) dot = -dot; // the double cover: q and -q are the same rotation
  if (dot > 1.0) dot = 1.0;
  return 2.0 * Math.acos(dot);
}

function read_quat(world: World, index: i32, out: Float64Array): void {
  const body = world.bodies();
  for (let k: i32 = 0; k < 4; k++) out[k] = body.quat(index, k);
}

// ── the world, frame by frame ────────────────────────────────────────────

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const gl3plus = renderer == "gl3plus";
  total = gl3plus ? 10 : 7;

  clause = 0; // the wire's own contract, before anything runs
  assertOgreWireOffsets();

  const callbacks = makeCallbacks(null, null);
  assert(RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) == 0,
         "session_open refused");
  const config = new ogre.ConfigBuilder()
    .renderer(gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(!gl3plus).vsync(false).frameHz(60).windowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  assert(ogre.init(config) == 0, "ogre::init refused");

  // ── the picture's scaffolding (GL3+ only) ────────────────────────────
  if (gl3plus) {
    // OGRE-Next's media ships no `sphere.mesh`. The closest substitute is
    // `Smiley.mesh` — a unit sphere — and it is the *right* substitute here
    // rather than a convenience: the bodies are spheres, and a cube drawn where
    // a sphere collides pokes its corners through the floor by its circumradius
    // (measured: one pixel per corner, which is what "no pixel below the floor"
    // caught). The floor stays a cube, which is what a floor is.
    const floor_job = ogre.queueMeshLoad("cube.mesh", 0);
    check(floor_job > 0, "queueMeshLoad refused (cube)");
    while (ogre.jobState(floor_job) != ogre.JOB_DONE &&
           ogre.jobState(floor_job) != ogre.JOB_FAILED) {
      RuntimeSession.wait(10);
    }
    check(ogre.jobState(floor_job) == ogre.JOB_DONE, "cube.mesh did not load");
    const cube = ogre.jobResult(floor_job);
    const body_job = ogre.queueMeshLoad("Smiley.mesh", 0);
    check(body_job > 0, "queueMeshLoad refused (Smiley)");
    while (ogre.jobState(body_job) != ogre.JOB_DONE &&
           ogre.jobState(body_job) != ogre.JOB_FAILED) {
      RuntimeSession.wait(10);
    }
    check(ogre.jobState(body_job) == ogre.JOB_DONE, "Smiley.mesh did not load");
    const sphere = ogre.jobResult(body_job);

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

    const floor = Renderable.at(cube, 1, 0.0, -12.0, 0.0, <f32>FLOOR_SCALE);
    floor.renderableId = FLOOR_ID;
    check(ogre.submitRenderable(floor) == 0, "submitRenderable refused (floor)");

    for (let i = 0; i < BODIES; i++) {
      const renderable = Renderable.at(sphere, 2, 0.0, 0.0, 0.0, <f32>MESH_SCALE);
      renderable.renderableId = FIRST_BODY_ID + <u32>i;
      check(ogre.submitRenderable(renderable) == 0,
            "submitRenderable refused (body " + i.toString() + ")");
    }
  }

  // ── the world, angular ───────────────────────────────────────────────
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
  world_config.angular = true;
  world_config.shape = SHAPE_SPHERE; // the collider; the inertia is the sphere's
  const world = World.create(world_config);
  check(world != null, "World.create refused " + BODIES.toString() + " angular bodies");

  // The pile: four columns, dropped low so it settles and sleeps inside 120
  // frames — the horizon is two seconds, not chunk 7's four.
  for (let i = 0; i < PILE; i++) {
    const layer = i % 4;
    const column = i / 4;
    const x = -0.5 + <f64>(column % 2) * 0.35;
    const z = -0.5 + <f64>(column / 2) * 0.35;
    world!.place(i, x, RADIUS + 0.02 + <f64>layer * (2.2 * RADIUS), z);
  }
  // The roller: a metre per second along +x at floor level, a short roll from
  // the +x wall — the wall is what ends its run, and the second bounce is what
  // brings it under both sleep thresholds (the sliding phase settles it to a
  // rolling speed, and a rolling sphere has no slip left to lose).
  // A 0.7 m runway: long enough to reach rolling (measured at frame 5) and to
  // turn the 90° clause 5 asks for before the wall ends it — a rolling sphere
  // covers 0.1 m per radian, so the clause needs about 0.16 m and the runway
  // has to be that plus the frames the sliding phase takes.
  world!.place(ROLLER, EXTENT - RADIUS - 0.7, RADIUS, 0.0);
  world!.setVelocity(ROLLER, ROLL_V0, 0.0, 0.0);
  // The spinner: dropped from just above the pile with 1 rad/s about y and no
  // horizontal velocity. It lands on the pile, which is what stops the spin —
  // against the floor a top spins forever, since its contact point is directly
  // below its centre and has no slip velocity to lose.
  // Onto clear floor, a quarter of a metre down, with the spin about y and no
  // horizontal velocity: this is the *fixture for clause 7*, and the reason is
  // physical rather than convenient. A contact directly below the centre has no
  // slip velocity when the body spins about the vertical axis, so friction
  // never touches this one — and neither does it touch a body wedged among
  // others, where it would die in a frame and turn 2° instead of the 30° clause
  // 6 asks for. Free, it turns at 1 rad/s for the whole run, which is exactly
  // what the angular sleep signal (8c1) has to leave alone.
  world!.place(SPINNER, 0.6, 0.35, 0.6);
  world!.setAngularVelocity(SPINNER, 0.0, SPIN_RATE, 0.0);
  check(world!.seed() == 0, "the solver refused the seed state");

  // What the two clause-bearing bodies started as.
  const spinner_home = new Float64Array(3);
  for (let k: i32 = 0; k < 3; k++) spinner_home[k] = world!.bodies().pos(SPINNER, k);

  // ── clause 1: 120 frames, and the roller's sliding stop on the way ───
  clause = 1;
  const batch = gl3plus ? new ogre.MotionBatch() : null;
  last_frame = ogre.frameCount();
  const body = world!.bodies();
  let slip_stop_frame: i32 = -1;
  let roll_v_at_stop = 0.0, roll_w_at_stop = 0.0;
  let spinner_max_move = 0.0;
  // The turns are *accumulated*, not read off the final quaternion: a rotation
  // is only expressible mod 360° (and a quaternion difference only up to 180°),
  // so a body that rolled 400° would report 40°. Add the per-frame shortest arc
  // and the total is what a viewer would have watched.
  const prev_roller = new Float64Array(4);
  const prev_spinner = new Float64Array(4);
  const now_quat = new Float64Array(4);
  let roller_turned = 0.0, spinner_turned = 0.0;
  read_quat(world!, ROLLER, prev_roller);
  read_quat(world!, SPINNER, prev_spinner);
  while (frame_now < FRAMES) {
    RuntimeSession.wait(16);
    const now = ogre.frameCount();
    const elapsed: i32 = <i32>(now - last_frame);
    if (elapsed == 0) continue;
    const advance: i32 = elapsed > 2 ? 2 : elapsed;
    last_frame = now;
    frame_now += advance;
    if (world!.step(<f64>advance * DT) != 0) {
      fail("world.step refused at frame " + frame_now.toString());
    }
    if (batch != null) {
      world!.pose(batch);
      if (batch.commit() != BODIES) fail("submit_motion refused the batch");
      if (frame_now >= 10 && early_a == null) early_a = grab();
      if (frame_now >= 20 && early_b == null) early_b = grab();
    }
    // The roller's sliding phase: the frame it stops slipping is the frame the
    // closed form is about, and it happens long before the wall.
    if (slip_stop_frame < 0 && frame_now > 2) {
      const vx = body.vel(ROLLER, 0);
      const wz = body.omega(ROLLER, 2);
      if (abs(vx + wz * RADIUS) < ROLL_SLIP_TOLERANCE * ROLL_V0) {
        slip_stop_frame = frame_now;
        roll_v_at_stop = vx;
        roll_w_at_stop = wz;
      }
    }
    read_quat(world!, ROLLER, now_quat);
    roller_turned += quat_delta(prev_roller, now_quat);
    for (let k: i32 = 0; k < 4; k++) prev_roller[k] = now_quat[k];
    read_quat(world!, SPINNER, now_quat);
    spinner_turned += quat_delta(prev_spinner, now_quat);
    for (let k: i32 = 0; k < 4; k++) prev_spinner[k] = now_quat[k];
    // The spinner's displacement, the largest it ever is.
    const dx = body.pos(SPINNER, 0) - spinner_home[0];
    const dy = body.pos(SPINNER, 1) - spinner_home[1];
    const dz = body.pos(SPINNER, 2) - spinner_home[2];
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (moved > spinner_max_move) spinner_max_move = moved;
  }
  world!.readState();
  print("1 ok: " + frame_now.toString() + " frames, " + BODIES.toString() +
        " angular bodies, " + (frame_now * 4).toString() + " sub-steps");

  // ── clause 2: asleep, spinning bodies included ───────────────────────
  clause = 2;
  let sleeping_pile = 0;
  let awake_pile = "";
  for (let i = 0; i < PILE; i++) {
    if (!world!.sleep.isAsleep(i)) {
      const vl = Math.sqrt(body.vel(i, 0) * body.vel(i, 0) +
                           body.vel(i, 1) * body.vel(i, 1) +
                           body.vel(i, 2) * body.vel(i, 2));
      const wl = Math.sqrt(body.omega(i, 0) * body.omega(i, 0) +
                           body.omega(i, 1) * body.omega(i, 1) +
                           body.omega(i, 2) * body.omega(i, 2));
      awake_pile += " [pile body " + i.toString() + " |v| " + vl.toString() +
                    " |w| " + wl.toString() + "]";
      continue;
    }
    sleeping_pile += 1;
  }
  check(sleeping_pile == PILE,
        "only " + sleeping_pile.toString() + " of " + PILE.toString() +
        " pile bodies are asleep at frame " + frame_now.toString() + awake_pile);
  const ke_pile: f64 = world!.kineticEnergy() - 0.5;
  print("2 ok: " + sleeping_pile.toString() + "/" + PILE.toString() +
        " pile bodies asleep at frame " + frame_now.toString() + " (" +
        BODIES.toString() + " bodies total; clause 7 names the two still moving)");

  // ── clause 3: every orientation is a unit quaternion ─────────────────
  clause = 3;
  let worst_norm_error = 0.0, non_finite = false;
  const q = new Float64Array(4);
  for (let i = 0; i < BODIES; i++) {
    read_quat(world!, i, q);
    for (let k: i32 = 0; k < 4; k++) {
      if (!isFinite(q[k])) non_finite = true;
    }
    const norm = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    const error = abs(norm - 1.0);
    if (error > worst_norm_error) worst_norm_error = error;
  }
  check(!non_finite, "an orientation is not finite");
  check(worst_norm_error < NORM_TOLERANCE,
        "the worst |q| is off by " + worst_norm_error.toString());
  print("3 ok: worst |q| error " + worst_norm_error.toString() + " < " +
        NORM_TOLERANCE.toString());

  // ── clause 4: the angular momentum at rest ───────────────────────────
  clause = 4;
  const params = world!.parameters();
  const omega = new Float64Array(3);
  let lx = 0.0, ly = 0.0, lz = 0.0;
  for (let i = 0; i < PILE; i++) {
    body.recoverOmega(i, omega);
    for (let axis: i32 = 0; axis < 3; axis++) {
      const inv_i = params.invInertiaAt(i, axis);
      const w = omega[axis];
      const l = inv_i > 0.0 ? w / inv_i : 0.0;
      if (axis == 0) lx += l;
      else if (axis == 1) ly += l;
      else lz += l;
    }
  }
  const momentum = Math.sqrt(lx * lx + ly * ly + lz * lz);
  check(momentum < ANGULAR_MOMENTUM_CEILING,
        "the total angular momentum is " + momentum.toString());
  print("4 ok: pile |L| " + momentum.toString() + " < " + ANGULAR_MOMENTUM_CEILING.toString());

  // ── clause 5: the rolling sphere — what a linear model cannot do ─────
  clause = 5;
  check(slip_stop_frame > 0, "the roller never stopped slipping");
  const rolled = roller_turned;
  const ratio = roll_v_at_stop / ROLL_V0;
  const rolling_error = abs(roll_v_at_stop + roll_w_at_stop * RADIUS);
  check(rolled >= 3.14159265358979 * 0.5,
        "the roller turned only " + (rolled * 180.0 / 3.14159265358979).toString() + " deg");
  check(abs(ratio - ROLL_CLOSED_FORM) <= ROLL_RATIO_TOLERANCE * ROLL_CLOSED_FORM,
        "v/v0 at the sliding stop is " + ratio.toString() + ", not 5/7");
  check(rolling_error < ROLL_SLIP_TOLERANCE * abs(roll_v_at_stop),
        "at the sliding stop |w r + v| = " + rolling_error.toString());
  print("5 ok: roller turned " + (rolled * 180.0 / 3.14159265358979).toString() +
        " deg, v/v0 " + ratio.toString() + " against 5/7 = " + ROLL_CLOSED_FORM.toString() +
        ", |w r + v| " + rolling_error.toString() + " at frame " +
        slip_stop_frame.toString());

  // ── clause 6: the spinning body tumbled while staying put ────────────
  clause = 6;
  const spun = spinner_turned;
  check(spun >= SPIN_TURN_FLOOR,
        "the spinner turned only " + (spun * 180.0 / 3.14159265358979).toString() + " deg");
  check(spinner_max_move < SPIN_MOVE_CEILING,
        "the spinner moved " + spinner_max_move.toString() + " m");
  print("6 ok: spinner turned " + (spun * 180.0 / 3.14159265358979).toString() +
        " deg, moved " + spinner_max_move.toString() + " m");

  // ── clause 7: the two bodies this model cannot stop ──────────────────
  clause = 7;
  const roller_v = body.vel(ROLLER, 0), roller_w = body.omega(ROLLER, 2);
  const spinner_w = body.omega(SPINNER, 1);
  check(!world!.sleep.isAsleep(ROLLER),
        "the roller slept: rolling has no slip and this model has no rolling resistance");
  check(abs(roller_v + roller_w * RADIUS) < ROLL_SLIP_TOLERANCE * abs(roller_v),
        "the roller is not rolling: v " + roller_v.toString() + ", w " + roller_w.toString());
  check(!world!.sleep.isAsleep(SPINNER), "the spinner slept");
  check(abs(spinner_w - SPIN_RATE) < 0.02 * SPIN_RATE,
        "the spinner's rate moved to " + spinner_w.toString() + " rad/s");
  print("7 ok: roller rolling at " + roller_v.toString() + " m/s (w r + v = " +
        (roller_v + roller_w * RADIUS).toString() + "), spinner at " +
        spinner_w.toString() + " rad/s — neither stops, and neither should");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    world!.destroy();
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── clause 8: the bodies are drawn where the state says ──────────────
  clause = 8;
  const settled = grab();
  check(settled != null, "no frame could be downloaded");
  const blob = measure_blob(settled!);
  let sum_area = 0.0, near_area = 0.0;
  const f = forward();
  for (let i = 0; i < BODIES; i++) {
    const dx = body.pos(i, 0) - 0.0, dy = body.pos(i, 1) - EYE_Y, dz = body.pos(i, 2) - EYE_Z;
    const distance = dx * f[0] + dy * f[1] + dz * f[2];
    const area = projectedArea(distance);
    sum_area += area;
    if (area > near_area) near_area = area;
  }
  // The pile is compact and the roller is out at x = 3.6: the band is the
  // whole set's projected area, since every body is on screen.
  const floor_band = near_area * 0.7;
  const ceiling = sum_area * (1.0 + AREA_BAND);
  check(blob.count > 0, "no body-coloured pixel at all: nothing was drawn");
  check(<f64>blob.count >= floor_band,
        "the bodies cover " + blob.count.toString() + " px, less than one body's " +
        floor_band.toString() + " px");
  check(<f64>blob.count <= ceiling,
        "the bodies cover " + blob.count.toString() + " px, more than the " +
        ceiling.toString() + " px the state predicts");
  print("8 ok: bodies " + blob.count.toString() + " px, one body " + near_area.toString() +
        " px, ceiling " + ceiling.toString() + " px");

  // ── clause 9: nothing below the floor ────────────────────────────────
  clause = 9;
  let floor_row = -1.0;
  for (let i = 0; i < BODIES; i++) {
    const beneath = projectRow(body.pos(i, 0), 0.0, body.pos(i, 2));
    if (beneath > floor_row) floor_row = beneath;
  }
  check(floor_row > 0.0, "the floor under the bodies does not project into the frame");
  check(blob.lowest_row <= <i32>floor_row,
        "body-coloured pixels reach row " + blob.lowest_row.toString() +
        ", below the floor's row " + (<i32>floor_row).toString());
  print("9 ok: lowest body pixel row " + blob.lowest_row.toString() + " <= floor row " +
        (<i32>floor_row).toString());

  // ── clause 10: the pile is still, the movers are not ─────────────────
  clause = 10;
  const late_a = grab();
  RuntimeSession.wait(16);
  const late_b = grab();
  check(early_a != null && early_b != null, "the early frames were not captured");
  check(late_a != null && late_b != null, "the late frames were not captured");
  const moving = flip_fraction(early_a!, early_b!);
  const resting = flip_fraction(late_a!, late_b!);
  check(moving > MOVING_FLIP_FLOOR,
        "two frames while the bodies were moving flipped only " + moving.toString());
  // Not exactly 0, and the difference is two bodies wide: the pile is asleep
  // and its pixels are frozen, while clause 7's roller and spinner cross the
  // frame because the model gives them nothing to lose their motion to.
  check(resting < moving * 0.1,
        "two late frames flipped " + resting.toString() + ", against the " +
        moving.toString() + " the moving frames flipped");
  print("10 ok: flip " + moving.toString() + " moving, " + resting.toString() +
        " late (the pile asleep for 30 frames, and the roller's 0.5 px per frame " +
        "crosses nothing)");

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  world!.destroy();
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
