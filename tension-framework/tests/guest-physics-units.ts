// Unit tests for the physics layer (chunk 8b): the angular model's parts, and
// the linear model's invariants.
//
// The acid tests next door (`tension-ogre/tests/guest-physics.ts`) assert what a
// *pile* does over 240 frames; this file asserts the pieces those numbers are
// built from, where a failure names itself instead of showing up as a drift
// three hundred frames later:
//
//   1. quaternion recovery — ω = 2q'⊗q⁻¹ from the state's own pair;
//   2. the impulse formula — two bodies, hand-computed velocities in and out,
//      including the case that separates the bias rule from the old wiring:
//      zero relative velocity must produce **no** impulse at all;
//   3. the bias does not spin a resting body — and, as the control that keeps
//      that from being vacuous, friction spins a sliding one;
//   4. a spinning body does not sleep, and a slowly spinning one does — the two
//      halves of the angular sleep signal (8c1);
//   5. a body with no contacts holds its ω across sixty steps;
//   6. the linear model is unchanged: deterministic, correct on a drop, and
//      still exactly still after it sleeps;
//   7. `MotionBatch.setPose` writes the offsets the wire catalogue names.
//
// The shape follows the framework's other fixtures: print OK, exit 0
// (`tension-framework/tests/run.sh`). It needs a session — for the buffer pool
// the motion batch writes into — and no renderer at all.

import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../assembly/runtime";
import { Body, SHAPE_BOX, SHAPE_SPHERE, World, WorldConfig } from "../assembly/physics";
import { MotionBatch, getMotionBase } from "../assembly/ogre/motion";
import { MOTION_SIZE } from "../assembly/ogre/wire";

const DT: f64 = 1.0 / 60.0;
const HALF_STEP: f64 = DT / 4.0; // one sub-step at the default cadence

let passed: i32 = 0;
let total: i32 = 0;

function check(name: string, ok: bool, detail: string = ""): void {
  total += 1;
  if (ok) {
    passed += 1;
    print("  ok   " + name);
  } else {
    print("  FAIL " + name + (detail.length > 0 ? " — " + detail : ""));
  }
}

function nearly(a: f64, b: f64, tolerance: f64): bool {
  return abs(a - b) <= tolerance;
}

/** A world with the shape these tests want: two knobs, everything else fixed. */
function make_world(bodies: i32, angular: bool, gravity: f64, bias: f64,
                    shape: u32 = SHAPE_SPHERE, sleep_speed: f64 = 0.1): World | null {
  const config = new WorldConfig();
  config.bodies = bodies;
  config.sleepSpeed = sleep_speed;
  config.radius = 0.1;
  config.mass = 1.0;
  config.gravity = gravity;
  config.bias = bias;
  config.slop = 0.001;
  config.angular = angular;
  config.shape = shape;
  return World.create(config);
}

/** The rotation angle a quaternion represents, normalized first. */
function quat_angle(x: f64, y: f64, z: f64, w: f64): f64 {
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  if (n <= 0.0) return 0.0;
  return 2.0 * Math.atan2(Math.sqrt(x * x + y * y + z * z) / n, w / n);
}

// ── 1. quaternion recovery ───────────────────────────────────────────────

/// `ω = 2q'⊗q⁻¹` must come back out of the pair that `q' = ½ω⊗q` puts in — for
/// a unit quaternion and for a scaled one, since the recovery divides by |q|².
/// The pair is written here by hand rather than through `writePose`, so the test
/// is not the code checking itself.
function test_quaternion_recovery(): void {
  print("1. quaternion recovery");
  const wx = 0.3, wy = -1.2, wz = 0.7;
  // q: 0.9 rad about (0.3, -0.4, 0.5)/|.|, with an optional scale.
  const axis_len = Math.sqrt(0.3 * 0.3 + 0.4 * 0.4 + 0.5 * 0.5);
  const ax = 0.3 / axis_len, ay = -0.4 / axis_len, az = 0.5 / axis_len;
  const half_angle = 0.45;
  const sh = Math.sin(half_angle);
  const qx0 = ax * sh, qy0 = ay * sh, qz0 = az * sh, qw0 = Math.cos(half_angle);

  for (let scale_index: i32 = 0; scale_index < 2; scale_index++) {
    const scale = scale_index == 0 ? 1.0 : 2.5;
    const qx = qx0 * scale, qy = qy0 * scale, qz = qz0 * scale, qw = qw0 * scale;
    // q' = ½ ω⊗q, the (x, y, z, w) components, written out longhand.
    const dx = 0.5 * (wx * qw + wy * qz - wz * qy);
    const dy = 0.5 * (-wx * qz + wy * qw + wz * qx);
    const dz = 0.5 * (wx * qy - wy * qx + wz * qw);
    const dw = 0.5 * (-wx * qx - wy * qy - wz * qz);

    const state = new Float64Array(14);
    const body = new Body(state, 1, 0, 7);
    body.setQuat(0, qx, qy, qz, qw);
    body.setDquat(0, dx, dy, dz, dw);

    const out = new Float64Array(3);
    body.recoverOmega(0, out);
    const detail = "got (" + out[0].toString() + ", " + out[1].toString() + ", " +
                   out[2].toString() + ") for scale " + scale.toString();
    check("recovery returns ω for |q| = " + scale.toString(),
          nearly(out[0], wx, 1.0e-9) && nearly(out[1], wy, 1.0e-9) &&
          nearly(out[2], wz, 1.0e-9), detail);
    check("the component accessor agrees with the table (scale " + scale.toString() + ")",
          nearly(body.omega(0, 1), wy, 1.0e-9));
  }
  // The linear layout has no angular velocity at all, and says so rather than
  // reading three slots that mean something else.
  const linear_state = new Float64Array(6);
  const linear_body = new Body(linear_state, 1, 0, 3);
  linear_body.setVel(0, 1.0, 2.0, 3.0);
  check("the linear model reports no ω", linear_body.omega(0, 0) == 0.0 &&
        linear_body.omega(0, 2) == 0.0);
}

// ── 2. the impulse formula ───────────────────────────────────────────────

/// Two spheres, hand-computed in and out.
///
/// (a) **Zero relative velocity.** The bias is 0.48 m/s at a 10 mm overlap
///     (β = 0.2, h = 1/240), and it is *linear only*: the impulse is exactly
///     zero, so the velocities that come out are the bias split by inverse mass
///     — ±0.24 m/s — and ω is exactly zero. A layer that folded the bias into
///     `desired` would show a different velocity here and a nonzero ω with a
///     contact point off the line of centres; this collider set cannot produce
///     that geometry, which is why the probe measured the folded wiring instead
///     (0.0356 rad) and why this test pins the rule's *observable* consequence.
/// (b) **Head-on at e = 1**, no bias: the impulse is `(desired − vn)/K` with
///     `vn = −1`, `desired = +1`, `K = 2` (no rotational term: `r` is parallel
///     to `n`), so the bodies exchange velocities and stop approaching.
function test_impulse_no_gravity(): void {
  print("2. the impulse formula");

  // (a) zero relative velocity, bias on, e = 0.
  {
    const world = make_world(2, true, 0.0, 0.2);
    check("world created for the resting pair", world != null);
    if (world != null) {
      const body = world!.bodies();
      world!.place(0, -0.095, 5.0, 0.0);
      world!.place(1, 0.095, 5.0, 0.0); // 10 mm of overlap on the line of centres
      check("seed accepted", world!.seed() == 0);
      check("one sub-step ran", world!.step(HALF_STEP) == 0);
      const va = body.vel(0, 0), vb = body.vel(1, 0);
      check("no impulse: the bias alone moves each body (±0.24)",
            nearly(va, -0.24, 1.0e-12) && nearly(vb, 0.24, 1.0e-12),
            "va=" + va.toString() + " vb=" + vb.toString());
      check("no angular velocity from a bias that never became an impulse",
            body.omega(0, 0) == 0.0 && body.omega(0, 1) == 0.0 && body.omega(0, 2) == 0.0 &&
            body.omega(1, 0) == 0.0 && body.omega(1, 1) == 0.0 && body.omega(1, 2) == 0.0);
      check("the bias is capped at 1.0 m/s, so a 10 mm overlap gives 0.48",
            abs(body.vel(0, 0)) < 1.0);
      world!.destroy();
    }
  }

  // (b) head-on, e = 1, no bias.
  {
    const world = make_world(2, true, 0.0, 0.0);
    check("world created for the head-on pair", world != null);
    if (world != null) {
      const body = world!.bodies();
      world!.place(0, -0.095, 5.0, 0.0);
      world!.place(1, 0.095, 5.0, 0.0);
      world!.setVelocity(0, 0.5, 0.0, 0.0);
      world!.setVelocity(1, -0.5, 0.0, 0.0);
      world!.params.restitution[0] = 1.0;
      world!.params.restitution[1] = 1.0;
      check("seed accepted", world!.seed() == 0);
      check("one sub-step ran", world!.step(HALF_STEP) == 0);
      const va = body.vel(0, 0), vb = body.vel(1, 0);
      check("an elastic head-on contact exchanges the velocities (−0.5 / +0.5)",
            nearly(va, -0.5, 1.0e-12) && nearly(vb, 0.5, 1.0e-12),
            "va=" + va.toString() + " vb=" + vb.toString());
      check("a central contact applies no torque", body.omega(0, 2) == 0.0 &&
            body.omega(1, 2) == 0.0);
      world!.destroy();
    }
  }
}

// ── 3. the bias does not spin a resting body ─────────────────────────────

/// One body, resting on the floor with 5 mm of penetration, 300 frames of
/// gravity and bias. Its orientation must stay **exactly** the identity, and its
/// ω exactly zero: the bias is linear-only, and a plane contact's `r` runs along
/// its own normal, so neither path can produce a torque. The second half is the
/// control that keeps this from being vacuous — the *same* world spins a body up
/// through friction when the body is sliding, so the angular channel is live and
/// the zero above is a measurement rather than a dead wire.
function test_bias_does_not_spin_resting_box(): void {
  print("3. the bias does not spin a resting box");
  {
    const world = make_world(1, true, -9.81, 0.2, SHAPE_BOX);
    check("box-inertia world created", world != null);
    if (world != null) {
      const body = world!.bodies();
      world!.place(0, 0.0, 0.1 - 0.005, 0.0); // resting, 5 mm into the floor
      world!.seed();
      for (let frame: i32 = 0; frame < 300; frame++) {
        if (world!.step(DT) != 0) break;
      }
      const angle = quat_angle(body.quat(0, 0), body.quat(0, 1), body.quat(0, 2), body.quat(0, 3));
      check("300 frames of resting contact accumulate exactly 0.0 rad of rotation",
            angle == 0.0, "angle=" + angle.toString());
      check("the orientation is still exactly the identity",
            body.quat(0, 0) == 0.0 && body.quat(0, 1) == 0.0 &&
            body.quat(0, 2) == 0.0 && body.quat(0, 3) == 1.0);
      check("and ω is exactly zero",
            body.omega(0, 0) == 0.0 && body.omega(0, 1) == 0.0 && body.omega(0, 2) == 0.0);
      world!.destroy();
    }
  }
  {
    // The control: a sphere sliding on the floor must spin up, and reach
    // rolling — ω·r = −v — which a linear-only model cannot do at all.
    const world = make_world(1, true, -9.81, 0.2);
    check("sliding-sphere world created", world != null);
    if (world != null) {
      const body = world!.bodies();
      world!.place(0, 0.0, 0.1, 0.0);
      world!.setVelocity(0, 1.0, 0.0, 0.0);
      world!.params.friction[0] = 0.4;
      world!.seed();
      for (let frame: i32 = 0; frame < 30; frame++) {
        if (world!.step(DT) != 0) break;
      }
      // Rolling along +x about −z: `ω_z · r = −v_x` at the contact.
      const vx = body.vel(0, 0), wz = body.omega(0, 2);
      check("friction spins the sliding sphere up", abs(wz) > 0.5, "wz=" + wz.toString());
      check("it reaches rolling: ω·r = −v within 5 %",
            abs(-wz * 0.1 - vx) < 0.05 * 1.0, "wz·r=" + (-wz * 0.1).toString() +
            " v=" + vx.toString());
      check("and it is still travelling: rolling, not stopped",
            vx > 0.6, "vx=" + vx.toString());
      world!.destroy();
    }
  }
}

// ── 4. a free body holds its ω ───────────────────────────────────────────

/// No contacts at all: the only thing that happens is the integrator, which must
/// carry the spin at exactly the rate it was given. The probe measured 1.0000101
/// rad for a body spun at 1 rad/s for one second, and |q| drifting by 0.0002 %
/// without renormalization; with the write-back's renormalization the second
/// number is exactly 1.
function test_spinning_body_does_not_sleep(): void {
  print("4. a spinning body does not sleep (the angular signal)");
  // Default thresholds throughout — 0.1 m/s and 0.06 rad/s — and no sleeping
  // switched off for the measurement, because the measurement *is* the policy.
  // A free body spun at 1 rad/s displaces nothing at all: the linear signal
  // reads 0.0 m/s and, before the angular signal existed, slept it at frame 30
  // and zeroed the spin with it — 0.5 rad of a second's rotation, measured.
  const world = make_world(1, true, 0.0, 0.0);
  check("free-body world created", world != null);
  if (world == null) return;
  const body = world!.bodies();
  check("a fresh angular world starts every body at the identity orientation",
        body.quat(0, 0) == 0.0 && body.quat(0, 1) == 0.0 &&
        body.quat(0, 2) == 0.0 && body.quat(0, 3) == 1.0);
  world!.place(0, 0.0, 5.0, 0.0); // high above the floor: no contacts
  world!.setAngularVelocity(0, 0.0, 1.0, 0.0);
  world!.seed();
  for (let frame: i32 = 0; frame < 60; frame++) {
    if (world!.step(DT) != 0) break;
  }
  const wy = body.omega(0, 1);
  const angle = quat_angle(body.quat(0, 0), body.quat(0, 1), body.quat(0, 2), body.quat(0, 3));
  const norm = Math.sqrt(body.quat(0, 0) * body.quat(0, 0) + body.quat(0, 1) * body.quat(0, 1) +
                         body.quat(0, 2) * body.quat(0, 2) + body.quat(0, 3) * body.quat(0, 3));
  check("it does not sleep, though it displaces nothing", world!.asleepCount() == 0,
        "asleep=" + world!.asleepCount().toString());
  check("ω is unchanged after 60 steps (1.0 rad/s)", nearly(wy, 1.0, 1.0e-6),
        "wy=" + wy.toString());
  // 1e-4 rather than the 1e-6 a clean 1.0 rad would suggest: the gap is
  // Verlet's own phase error over 240 sub-steps (chunk 8a's probe measured
  // 1.0000101 rad), not the sleep signal's — the signal either keeps the body
  // turning or stops it, and 0.5 rad is what stopping looked like.
  check("the body turned a full radian in one second", nearly(angle, 1.0, 1.0e-4),
        "angle=" + angle.toString());
  check("|q| is 1 within 1e-6 (the write-back renormalizes)", nearly(norm, 1.0, 1.0e-6),
        "|q|=" + norm.toString());
  check("no drift into the other axes",
        nearly(body.omega(0, 0), 0.0, 1.0e-9) && nearly(body.omega(0, 2), 0.0, 1.0e-9));
  world!.destroy();
}

/// The other half of the signal: a body turning below the threshold still
/// sleeps, and sleeping freezes it — the orientation at frame 30 is the
/// orientation at frame 60, bit for bit. 0.03 rad/s is 0.0005 rad per frame at
/// 60 Hz, half the 0.001 rad/frame the threshold is stated in.
function test_slowly_spinning_body_sleeps(): void {
  print("5. a slowly spinning body sleeps");
  const world = make_world(1, true, 0.0, 0.0);
  check("slow-spin world created", world != null);
  if (world == null) return;
  const body = world!.bodies();
  world!.place(0, 0.0, 5.0, 0.0);
  world!.setAngularVelocity(0, 0.0, 0.03, 0.0);
  world!.seed();
  for (let frame: i32 = 0; frame < 30; frame++) {
    if (world!.step(DT) != 0) break;
  }
  check("it sleeps at frame 30 (the window's end)", world!.asleepCount() == 1);
  const settled = new Float64Array(4);
  for (let k: i32 = 0; k < 4; k++) settled[k] = body.quat(0, k);
  for (let frame: i32 = 0; frame < 30; frame++) {
    if (world!.step(DT) != 0) break;
  }
  let frozen = true;
  for (let k: i32 = 0; k < 4; k++) {
    if (settled[k] != body.quat(0, k)) frozen = false;
  }
  check("and the orientation never changes again (bit for bit)", frozen);
  const angle = quat_angle(settled[0], settled[1], settled[2], settled[3]);
  check("it turned for half a second before it stopped (~0.015 rad)",
        nearly(angle, 0.015, 1.0e-4), "angle=" + angle.toString());
  check("and its spin was zeroed with it", body.omega(0, 1) == 0.0);
  world!.destroy();
}

/// The chunk-7 case in the angular model: a box resting on the floor, jittering
/// at ~1.3e-5 rad/frame (chunk 8a's Q5), still sleeps. This is the check that the
/// new threshold is *above* the jitter rather than inside it.
function test_resting_box_still_sleeps(): void {
  print("6. a resting box still sleeps");
  const world = make_world(1, true, -9.81, 0.2, SHAPE_BOX);
  check("box world created", world != null);
  if (world == null) return;
  world!.place(0, 0.0, 0.1 - 0.005, 0.0); // resting, 5 mm into the floor
  world!.seed();
  for (let frame: i32 = 0; frame < 60; frame++) {
    if (world!.step(DT) != 0) break;
  }
  check("the resting box sleeps within 60 frames", world!.asleepCount() == 1);
  const body = world!.bodies();
  check("and its angular signal never crossed the threshold",
        body.omega(0, 0) == 0.0 && body.omega(0, 1) == 0.0 && body.omega(0, 2) == 0.0);
  world!.destroy();
}

// ── 7. the linear model is unchanged ─────────────────────────────────────

/// Chunk 6 and chunk 7's invariants, on a world built the way those chunks build
/// them: the same code must produce the same numbers twice (determinism), the
/// drop must match the closed form, and a slept pile must be *exactly* still
/// (kinetic energy 0.0, and the state bit-for-bit identical thirty frames apart).
function test_linear_model_unchanged(): void {
  print("7. the linear model is unchanged");

  // A single body dropped from y = 10 for 60 frames: 10 − ½·9.81 = 5.095.
  {
    const world = make_world(1, false, -9.81, 0.0);
    check("linear world created", world != null);
    if (world != null) {
      const body = world!.bodies();
      world!.place(0, 0.0, 10.0, 0.0);
      world!.seed();
      for (let frame: i32 = 0; frame < 60; frame++) world!.step(DT);
      const y = body.pos(0, 1);
      check("a drop still lands on the closed form (5.095)", nearly(y, 5.095, 1.0e-9),
            "y=" + y.toString());
      world!.destroy();
    }
  }

  // Determinism, and the slept pile.
  const snapshot_a = new Float64Array(4 * 6);
  const snapshot_b = new Float64Array(4 * 6);
  let ke_a = -1.0;
  let ke_b = -1.0;
  for (let run: i32 = 0; run < 2; run++) {
    const world = make_world(4, false, -9.81, 0.2);
    if (world == null) { check("linear pile world created", false); return; }
    for (let i: i32 = 0; i < 4; i++) {
      world!.place(i, -0.15 + <f64>i * 0.1, 0.1 + 0.05 + <f64>i * 0.21, 0.0);
    }
    world!.seed();
    for (let frame: i32 = 0; frame < 60; frame++) world!.step(DT);
    const body = world!.bodies();
    const into = run == 0 ? snapshot_a : snapshot_b;
    for (let i: i32 = 0; i < 4; i++) {
      for (let axis: i32 = 0; axis < 3; axis++) {
        into[i * 6 + axis] = body.pos(i, axis);
        into[i * 6 + 3 + axis] = body.vel(i, axis);
      }
    }
    if (run == 0) ke_a = world!.kineticEnergy(); else ke_b = world!.kineticEnergy();
    world!.destroy();
  }
  let identical = true;
  for (let i: i32 = 0; i < snapshot_a.length; i++) {
    if (snapshot_a[i] != snapshot_b[i]) identical = false;
  }
  check("two identical runs are bit-for-bit identical", identical);
  check("kinetic energy is the same number twice", ke_a == ke_b,
        "a=" + ke_a.toString() + " b=" + ke_b.toString());

  // Sleeping, and the equality that tells "asleep" from "creeping".
  {
    const world = make_world(2, false, -9.81, 0.2);
    if (world == null) { check("sleep world created", false); return; }
    const body = world!.bodies();
    world!.place(0, -0.05, 0.1, 0.0);
    world!.place(1, 0.05, 0.1, 0.0);
    world!.seed();
    for (let frame: i32 = 0; frame < 240; frame++) world!.step(DT);
    const before = new Float64Array(12);
    for (let i: i32 = 0; i < 2; i++) {
      for (let axis: i32 = 0; axis < 3; axis++) {
        before[i * 6 + axis] = body.pos(i, axis);
        before[i * 6 + 3 + axis] = body.vel(i, axis);
      }
    }
    for (let frame: i32 = 0; frame < 30; frame++) world!.step(DT);
    let same = true;
    for (let i: i32 = 0; i < 2; i++) {
      for (let axis: i32 = 0; axis < 3; axis++) {
        if (before[i * 6 + axis] != body.pos(i, axis)) same = false;
        if (before[i * 6 + 3 + axis] != body.vel(i, axis)) same = false;
      }
    }
    check("a slept pile is bit-for-bit unchanged over 30 frames", same);
    check("and its kinetic energy is exactly 0.0", world!.kineticEnergy() == 0.0,
          "ke=" + world!.kineticEnergy().toString());
    check("every body is asleep", world!.asleepCount() == 2);
    world!.destroy();
  }
}

// ── 8. MotionBatch.setPose ───────────────────────────────────────────────

/// The offsets are the wire catalogue's (`wire.ts`: position at @16, rotation at
/// @32, scale at @48), and the two writers differ exactly where their contracts
/// say they do: `set` writes the identity rotation, `setPose` writes the one it
/// is handed.
function test_motionbatch_setPose_writes_correct_offsets(): void {
  print("8. MotionBatch.setPose offsets");
  const batch = new MotionBatch();
  const base = getMotionBase();
  batch.setPose(0, 7, 1.5, -2.5, 3.5, 0.25, -0.5, 0.75, 0.8660254037844386, 2.0);
  const at = base + <usize>MOTION_SIZE; // entry 1, since entry 0 is the frame's first body
  const at0 = base;
  check("position x/y/z at @16/@20/@24",
        load<f32>(at0 + 16) == 1.5 && load<f32>(at0 + 20) == -2.5 && load<f32>(at0 + 24) == 3.5);
  check("rotation x/y/z/w at @32/@36/@40/@44",
        load<f32>(at0 + 32) == 0.25 && load<f32>(at0 + 36) == -0.5 &&
        load<f32>(at0 + 40) == 0.75 && nearly(load<f32>(at0 + 44), 0.8660254, 1.0e-6));
  check("scale at @48, repeated across the three axes",
        load<f32>(at0 + 48) == 2.0 && load<f32>(at0 + 52) == 2.0 && load<f32>(at0 + 56) == 2.0);
  check("the renderable id at @0 and the reserved fields zeroed",
        load<u32>(at0 + 0) == 7 && load<u32>(at0 + 4) == 0 && load<u64>(at0 + 8) == 0);

  batch.set(1, 8, 4.0, 5.0, 6.0, 1.0);
  check("set writes the identity rotation at @32..@44",
        load<f32>(at + 32) == 0.0 && load<f32>(at + 36) == 0.0 &&
        load<f32>(at + 40) == 0.0 && load<f32>(at + 44) == 1.0);
  check("and its own position and scale",
        load<f32>(at + 16) == 4.0 && load<f32>(at + 48) == 1.0);
  check("the batch counts both writers", batch.count() == 2);
  // The batch is not committed here: the adapter half is the acid tier's business.
}

export function _start_game(): void {
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("FAIL session_open");
    assert(false, "session_open refused");
  }
  print("PHYSICS UNITS (8b): the angular model's pieces, and the linear model's invariants");

  test_quaternion_recovery();
  test_impulse_no_gravity();
  test_bias_does_not_spin_resting_box();
  test_spinning_body_does_not_sleep();
  test_slowly_spinning_body_sleeps();
  test_resting_box_still_sleeps();
  test_linear_model_unchanged();
  test_motionbatch_setPose_writes_correct_offsets();

  print("PHYSICS UNITS " + passed.toString() + "/" + total.toString() + " passed");
  if (passed != total) {
    assert(false, "physics units failed");
  }
  if (RuntimeSession.close() != 0) {
    print("FAIL session_close");
    assert(false, "session_close refused");
  }
  print("OK physics units: " + passed.toString() + "/" + total.toString() + " passed");
}
