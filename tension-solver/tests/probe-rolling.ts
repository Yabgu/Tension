// probe-rolling.ts — 9a-i: does a contact-only spin decay flip the chunk-8
// tripwires, and at what coefficient?
//
// Chunk 8c2 ended with two clauses asserting the *shape* of motion the model
// cannot end: a sphere that reaches rolling has no slip left for friction, and a
// sphere spinning about the vertical axis has no slip under its centre — so both
// keep going, and the fixture says so rather than pretending. Chunk 9a adds the
// term that ends them:
//
//     ω ← ω · max(0, 1 − k·h)        once per sub-step, for a body in contact
//
// This probe measures what that does — as 8a's did for the impulse formula, it
// carries its own copy of the candidate model, because the point of probing
// before implementing is to measure the model the SDK does not have yet. The
// probe's sleep policy is likewise a copy of chunks 7 and 8c1's; 9a-ii confirms
// these numbers against the SDK's own.
//
// The six questions:
//
//   Q1  the roller (v₀ = 1 m/s, μ = 0.4, e = 0.3, the fixture's geometry: a wall
//       at the end of a 0.7 m runway, because the damping acts from frame 0 and
//       the whole run matters): v(t)/v₀ every 10 frames, the frame it crosses
//       both sleep thresholds, and its total turn, for k = 0.1 … 6
//   Q2  the spinner (1 rad/s about the vertical axis, dropped 0.55 m): its turn,
//       its stop frame — and **the contact fraction**, which is the number that
//       says whether the arithmetic above is even the right arithmetic
//   Q3  the pile: settling frame, sleep frame, and whether its state is
//       bit-for-bit still over thirty frames once every body has slept
//   Q4  the impulse interaction: the resistance is a torque, so it cannot move a
//       body — the spinner's linear velocity stays exactly 0, and the roller
//       never penetrates the wall
//   Q5  the free-space control: no contact, no damping, ω = 1.0 to 1e-9
//   Q6  the three-way pinch: is there a k that satisfies ≥ 90° of roller turn
//       AND ≥ 30° of spinner turn AND asleep by frame 120?
//
// Build and run (from the repo root):
//   tension-framework/node_modules/.bin/asc tension-solver/tests/probe-rolling.ts \
//       --config tension-framework/build/session.asconfig.json \
//       -o tension-solver/build/probe-rolling/probe-rolling.wasm
//   tension-core/target/debug/tension-core \
//       tension-solver/build/probe-rolling/probe-rolling.wasm

import { print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import { Solver, SolverConfig } from "../../tension-framework/assembly/solver";

const DT: f64 = 1.0 / 60.0;
const SUBSTEPS: i32 = 4;
const H: f64 = DT / <f64>SUBSTEPS;
const FRAMES: i32 = 300; // five seconds: long enough to watch every decay
const RADIUS: f64 = 0.1;
const MASS: f64 = 1.0;
const INV_MASS: f64 = 1.0 / MASS;
/** A sphere's: (2/5) m r². */
const INERTIA: f64 = 0.4 * MASS * RADIUS * RADIUS;
const INV_INERTIA: f64 = 1.0 / INERTIA;
const EXTENT: f64 = 4.0;
const SLOP: f64 = 1.0e-3;
const BETA: f64 = 0.2;
const BIAS_CAP: f64 = 1.0;
const RESTITUTION: f64 = 0.3;
const FRICTION: f64 = 0.4;
let gravity_y: f64 = -9.81;

/** The roller: a metre per second, 0.7 m of runway, then the wall. */
const ROLL_V0: f64 = 1.0;
const ROLL_START_X: f64 = EXTENT - RADIUS - 0.7;
/** The spinner: 1 rad/s about y, dropped 0.55 m (the fixture's ceiling is 0.5 m
 * of displacement, so this is as high as its drop can go). */
const SPIN_W0: f64 = 1.0;
const SPIN_DROP_Y: f64 = 0.55;
const SPIN_AT_X: f64 = 0.6;
const SPIN_AT_Z: f64 = 0.6;
/** The pile: the fixture's fourteen, four columns, spawned at rest. */
const PILE: i32 = 14;
/** The sleep policy's numbers, from chunks 7 and 8c1. */
const SLEEP_SPEED: f64 = 0.1;
const SLEEP_ANGULAR: f64 = 0.06;
const SLEEP_FRAMES: u32 = 30;
/** The sweep. The round's five, plus 3, 4 and 6 for the window's edges. */
const KS: i32 = 7;
const K_VALUES: f64[] = [0.1, 0.5, 1.0, 2.0, 3.0, 4.0, 6.0];
/** The pinch table's four. */
const PINCH_KS: i32 = 4;
const PINCH_VALUES: f64[] = [3.0, 3.6, 4.0, 4.5];

// ── the solver's callbacks ───────────────────────────────────────────────
//
// One state layout for everything below: fourteen slots per body, `[x, y, z,
// qx, qy, qz, qw | vx, vy, vz, q'x, q'y, q'z, q'w]`, with `q' = ½ω⊗q` — chunk
// 8a's model, and the same derivative the SDK runs.

const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);
export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

/** The sleep mask, copied from the layer: module state, set before a step. */
let sleep_mask: Uint8Array | null = null;
let max_bodies: i32 = 16;

export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (dyCap < len) return -22;
  const half = len / 2;
  const mask = sleep_mask;
  for (let base: i32 = 0; base < half; base += 7) {
    const b = base / 7;
    const sleeping = mask != null && mask![b] != 0;
    const vbase = half + base;
    const vx = load<f64>(yPtr + <usize>(vbase + 0) * 8);
    const vy = load<f64>(yPtr + <usize>(vbase + 1) * 8);
    const vz = load<f64>(yPtr + <usize>(vbase + 2) * 8);
    const dqx = load<f64>(yPtr + <usize>(vbase + 3) * 8);
    const dqy = load<f64>(yPtr + <usize>(vbase + 4) * 8);
    const dqz = load<f64>(yPtr + <usize>(vbase + 5) * 8);
    const dqw = load<f64>(yPtr + <usize>(vbase + 6) * 8);
    const qx = load<f64>(yPtr + <usize>(base + 3) * 8);
    const qy = load<f64>(yPtr + <usize>(base + 4) * 8);
    const qz = load<f64>(yPtr + <usize>(base + 5) * 8);
    const qw = load<f64>(yPtr + <usize>(base + 6) * 8);
    store<f64>(dyPtr + <usize>(base + 0) * 8, sleeping ? 0.0 : vx);
    store<f64>(dyPtr + <usize>(base + 1) * 8, sleeping ? 0.0 : vy);
    store<f64>(dyPtr + <usize>(base + 2) * 8, sleeping ? 0.0 : vz);
    store<f64>(dyPtr + <usize>(base + 3) * 8, sleeping ? 0.0 : dqx);
    store<f64>(dyPtr + <usize>(base + 4) * 8, sleeping ? 0.0 : dqy);
    store<f64>(dyPtr + <usize>(base + 5) * 8, sleeping ? 0.0 : dqz);
    store<f64>(dyPtr + <usize>(base + 6) * 8, sleeping ? 0.0 : dqw);
    store<f64>(dyPtr + <usize>(vbase + 0) * 8, 0.0);
    store<f64>(dyPtr + <usize>(vbase + 1) * 8, sleeping ? 0.0 : gravity_y);
    store<f64>(dyPtr + <usize>(vbase + 2) * 8, 0.0);
    const n2 = qx * qx + qy * qy + qz * qz + qw * qw;
    const d2 = dqx * dqx + dqy * dqy + dqz * dqz + dqw * dqw;
    const c = (n2 > 0.0 && !sleeping) ? d2 / n2 : 0.0;
    store<f64>(dyPtr + <usize>(vbase + 3) * 8, -c * qx);
    store<f64>(dyPtr + <usize>(vbase + 4) * 8, -c * qy);
    store<f64>(dyPtr + <usize>(vbase + 5) * 8, -c * qz);
    store<f64>(dyPtr + <usize>(vbase + 6) * 8, -c * qw);
  }
  return 0;
}

function make_solver(bodies: i32): Solver | null {
  const config = new SolverConfig();
  config.method = "verlet";
  config.source = "wasm";
  config.dim = bodies * 14;
  config.fixedStep = H;
  return Solver.create(config, {
    derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out,
  });
}

// ── the state, contacts, and the response ────────────────────────────────
//
// A compact copy of the layer's angular path: the same impulse formula (§5.1),
// the same linear-only bias, the same canonicalization. It exists here because
// the model being measured does not exist in the SDK yet.

const MAX_BODIES: i32 = 16;
const MAX_CONTACTS: i32 = 4096;
const STRIDE: i32 = 12; // bodyA, bodyB, point, normal, penetration, pad

const contacts = new Float64Array(MAX_CONTACTS * STRIDE);
let contact_count: i32 = 0;

function add_contact(a: i32, b: i32, px: f64, py: f64, pz: f64,
                     nx: f64, ny: f64, nz: f64, pen: f64): void {
  if (contact_count >= MAX_CONTACTS) return;
  const at = contact_count * STRIDE;
  contacts[at + 0] = <f64>a;
  contacts[at + 1] = <f64>b; // -1: a plane
  contacts[at + 2] = px; contacts[at + 3] = py; contacts[at + 4] = pz;
  contacts[at + 5] = nx; contacts[at + 6] = ny; contacts[at + 7] = nz;
  contacts[at + 8] = pen;
  contact_count += 1;
}

function quat_angle(x: f64, y: f64, z: f64, w: f64): f64 {
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  if (n <= 0.0) return 0.0;
  return 2.0 * Math.atan2(Math.sqrt(x * x + y * y + z * z) / n, w / n);
}

function quat_delta(a: Float64Array, ai: i32, b: Float64Array, bi: i32): f64 {
  let dot = a[ai + 0] * b[bi + 0] + a[ai + 1] * b[bi + 1] +
            a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3];
  if (dot < 0.0) dot = -dot;
  if (dot > 1.0) dot = 1.0;
  return 2.0 * Math.acos(dot);
}

function normalize_quat(state: Float64Array, b: i32): void {
  const at = b * 7;
  const n = Math.sqrt(state[at + 3] * state[at + 3] + state[at + 4] * state[at + 4] +
                      state[at + 5] * state[at + 5] + state[at + 6] * state[at + 6]);
  if (n <= 0.0) return;
  state[at + 3] /= n; state[at + 4] /= n; state[at + 5] /= n; state[at + 6] /= n;
}

function recover_omega(state: Float64Array, om: Float64Array, b: i32, outBase: i32): void {
  const at = b * 7, half = state.length / 2;
  const qx = state[at + 3], qy = state[at + 4], qz = state[at + 5], qw = state[at + 6];
  const dx = state[half + at + 3], dy = state[half + at + 4];
  const dz = state[half + at + 5], dw = state[half + at + 6];
  const n2 = qx * qx + qy * qy + qz * qz + qw * qw;
  if (n2 <= 0.0) {
    om[outBase + 0] = 0.0; om[outBase + 1] = 0.0; om[outBase + 2] = 0.0;
    return;
  }
  const s = 2.0 / n2;
  om[outBase + 0] = s * (-dw * qx + dx * qw - dy * qz + dz * qy);
  om[outBase + 1] = s * (-dw * qy + dx * qz + dy * qw - dz * qx);
  om[outBase + 2] = s * (-dw * qz - dx * qy + dy * qx + dz * qw);
}

/** Unit quaternion, and `q' = ½ω⊗q` — the layer's write-back, component order
 * (x, y, z, w) into the derivative slots. */
function canonicalize(state: Float64Array, om: Float64Array, b: i32): void {
  const at = b * 7, half = state.length / 2;
  normalize_quat(state, b);
  const qx = state[at + 3], qy = state[at + 4], qz = state[at + 5], qw = state[at + 6];
  const wx = om[b * 3 + 0], wy = om[b * 3 + 1], wz = om[b * 3 + 2];
  state[half + at + 3] = 0.5 * (wx * qw + wy * qz - wz * qy);
  state[half + at + 4] = 0.5 * (-wx * qz + wy * qw + wz * qx);
  state[half + at + 5] = 0.5 * (wx * qy - wy * qx + wz * qw);
  state[half + at + 6] = 0.5 * (-wx * qx - wy * qy - wz * qz);
}

function rotational_term(rx: f64, ry: f64, rz: f64, nx: f64, ny: f64, nz: f64): f64 {
  const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
  const ix = INV_INERTIA * cx, iy = INV_INERTIA * cy, iz = INV_INERTIA * cz;
  const tx = iy * rz - iz * ry, ty = iz * rx - ix * rz, tz = ix * ry - iy * rx;
  return nx * tx + ny * ty + nz * tz;
}

function apply_torque(om: Float64Array, index: i32, rx: f64, ry: f64, rz: f64,
                      j: f64, nx: f64, ny: f64, nz: f64, sign: f64): void {
  om[index * 3 + 0] += sign * INV_INERTIA * (ry * (j * nz) - rz * (j * ny));
  om[index * 3 + 1] += sign * INV_INERTIA * (rz * (j * nx) - rx * (j * nz));
  om[index * 3 + 2] += sign * INV_INERTIA * (rx * (j * ny) - ry * (j * nx));
}

/// One impulse pass, `bodies` wide, with the contact point derived from the
/// geometry. Marks every body that had a contact, which is what the damping
/// below is gated on.
function resolve_all(state: Float64Array, om: Float64Array, bodies: i32, dt: f64,
                     touched: Uint8Array, policy: SleepPolicy | null = null): void {
  for (let b: i32 = 0; b < bodies; b++) recover_omega(state, om, b, b * 3);
  const half = state.length / 2;
  for (let c: i32 = 0; c < contact_count; c++) {
    const at = c * STRIDE;
    const a = <i32>contacts[at + 0];
    const b = <i32>contacts[at + 1];
    // The layer's sleep rules, which the probe has to copy or it measures a
    // different model: a sleeper against a plane is skipped, two sleepers are
    // skipped, and a sleeper an awake body touches wakes.
    if (policy != null) {
      if (b < 0) {
        if (policy.asleep[a] != 0) continue;
      } else {
        const a_asleep = policy.asleep[a] != 0;
        const b_asleep = policy.asleep[b] != 0;
        if (a_asleep && b_asleep) continue;
        if (a_asleep) { policy.asleep[a] = 0; policy.counter[a] = 0; }
        if (b_asleep) { policy.asleep[b] = 0; policy.counter[b] = 0; }
      }
    }
    const px = contacts[at + 2], py = contacts[at + 3], pz = contacts[at + 4];
    const nx = contacts[at + 5], ny = contacts[at + 6], nz = contacts[at + 7];
    const pen = contacts[at + 8];
    const cb = a * 7, vb = half + a * 7;
    let rax = 0.0, ray = 0.0, raz = 0.0;
    let rbx = 0.0, rby = 0.0, rbz = 0.0;
    if (b < 0) {
      const reach = RADIUS - pen;
      rax = -reach * nx; ray = -reach * ny; raz = -reach * nz;
    } else {
      const gap = 2.0 * RADIUS - pen;
      const along = RADIUS - pen * 0.5;
      rax = along * nx; ray = along * ny; raz = along * nz;
      rbx = rax - gap * nx; rby = ray - gap * ny; rbz = raz - gap * nz;
    }
    const wax = om[a * 3 + 0], way = om[a * 3 + 1], waz = om[a * 3 + 2];
    const avx = state[vb + 0] + (way * raz - waz * ray);
    const avy = state[vb + 1] + (waz * rax - wax * raz);
    const avz = state[vb + 2] + (wax * ray - way * rax);
    let bvx = 0.0, bvy = 0.0, bvz = 0.0;
    if (b >= 0) {
      const wbx = om[b * 3 + 0], wby = om[b * 3 + 1], wbz = om[b * 3 + 2];
      const vbb = half + b * 7;
      bvx = state[vbb + 0] + (wby * rbz - wbz * rby);
      bvy = state[vbb + 1] + (wbz * rbx - wbx * rbz);
      bvz = state[vbb + 2] + (wbx * rby - wby * rbx);
    }
    const vn = b < 0
      ? (avx * nx + avy * ny + avz * nz)
      : ((bvx - avx) * nx + (bvy - avy) * ny + (bvz - avz) * nz);
    const inv_b = b >= 0 ? INV_MASS : 0.0;
    const rot_n = rotational_term(rax, ray, raz, nx, ny, nz) +
                  (b >= 0 ? rotational_term(rbx, rby, rbz, nx, ny, nz) : 0.0);
    const kn = INV_MASS + inv_b + rot_n;
    let jn = 0.0;
    if (kn > 0.0) {
      const desired = Math.max(0.0, -RESTITUTION * vn);
      if (vn < desired) {
        jn = (desired - vn) / kn;
        if (b < 0) {
          state[vb + 0] += jn * INV_MASS * nx;
          state[vb + 1] += jn * INV_MASS * ny;
          state[vb + 2] += jn * INV_MASS * nz;
          apply_torque(om, a, rax, ray, raz, jn, nx, ny, nz, 1.0);
        } else {
          state[vb + 0] -= jn * INV_MASS * nx;
          state[vb + 1] -= jn * INV_MASS * ny;
          state[vb + 2] -= jn * INV_MASS * nz;
          apply_torque(om, a, rax, ray, raz, jn, nx, ny, nz, -1.0);
          const vbb = half + b * 7;
          state[vbb + 0] += jn * inv_b * nx;
          state[vbb + 1] += jn * inv_b * ny;
          state[vbb + 2] += jn * inv_b * nz;
          apply_torque(om, b, rbx, rby, rbz, jn, nx, ny, nz, 1.0);
        }
      }
    }
    if (FRICTION > 0.0) {
      const w1x = om[a * 3 + 0], w1y = om[a * 3 + 1], w1z = om[a * 3 + 2];
      let tvx = state[vb + 0] + (w1y * raz - w1z * ray);
      let tvy = state[vb + 1] + (w1z * rax - w1x * raz);
      let tvz = state[vb + 2] + (w1x * ray - w1y * rax);
      if (b >= 0) {
        const u1x = om[b * 3 + 0], u1y = om[b * 3 + 1], u1z = om[b * 3 + 2];
        const vbb = half + b * 7;
        tvx = (state[vbb + 0] + (u1y * rbz - u1z * rby)) - tvx;
        tvy = (state[vbb + 1] + (u1z * rbx - u1x * rbz)) - tvy;
        tvz = (state[vbb + 2] + (u1x * rby - u1y * rbx)) - tvz;
      } else {
        tvx = -tvx; tvy = -tvy; tvz = -tvz;
      }
      const vnn = tvx * nx + tvy * ny + tvz * nz;
      tvx -= vnn * nx; tvy -= vnn * ny; tvz -= vnn * nz;
      const tlen = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
      if (tlen > 1.0e-12) {
        const tx = tvx / tlen, ty = tvy / tlen, tz = tvz / tlen;
        const kt = INV_MASS + inv_b + rotational_term(rax, ray, raz, tx, ty, tz) +
                   (b >= 0 ? rotational_term(rbx, rby, rbz, tx, ty, tz) : 0.0);
        if (kt > 0.0) {
          const cone = FRICTION * jn;
          let jt = -tlen / kt;
          if (jt < -cone) jt = -cone;
          if (jt > cone) jt = cone;
          state[vb + 0] -= jt * INV_MASS * tx;
          state[vb + 1] -= jt * INV_MASS * ty;
          state[vb + 2] -= jt * INV_MASS * tz;
          apply_torque(om, a, rax, ray, raz, jt, tx, ty, tz, -1.0);
          if (b >= 0) {
            const vbb = half + b * 7;
            state[vbb + 0] += jt * INV_MASS * tx;
            state[vbb + 1] += jt * INV_MASS * ty;
            state[vbb + 2] += jt * INV_MASS * tz;
            apply_torque(om, b, rbx, rby, rbz, jt, tx, ty, tz, 1.0);
          }
        }
      }
    }
    // The bias, linear only, never through the impulse.
    if (pen > SLOP) {
      let bias = BETA * pen / dt;
      if (bias > BIAS_CAP) bias = BIAS_CAP;
      if (b < 0) {
        state[vb + 0] += bias * nx;
        state[vb + 1] += bias * ny;
        state[vb + 2] += bias * nz;
      } else {
        state[vb + 0] -= bias * 0.5 * nx;
        state[vb + 1] -= bias * 0.5 * ny;
        state[vb + 2] -= bias * 0.5 * nz;
        const vbb = half + b * 7;
        state[vbb + 0] += bias * 0.5 * nx;
        state[vbb + 1] += bias * 0.5 * ny;
        state[vbb + 2] += bias * 0.5 * nz;
      }
    }
    touched[a] = 1;
    if (b >= 0) touched[b] = 1;
  }
}

// ── the candidate: contact-only spin decay ───────────────────────────────

/// Which stop rule the damping uses. **A** is the plan's: skip a body already
/// below `sleepAngularSpeed`. **B** is the alternative this probe had to
/// measure — skip only the sleeping — because A parks a body *on* the sleep
/// threshold (the rule stops the damping at the same number the sleep signal
/// tests), so it never quite sleeps. Nothing else differs.
let damping_rule_b: bool = false;

/// `ω ← ω · max(0, 1 − k·h)` for every body that had a contact, except the
/// sleeping. Pure angular: it writes `om` and nothing else, so it cannot move a
/// body's centre of mass.
function damp(om: Float64Array, touched: Uint8Array, asleep: Uint8Array, bodies: i32,
              k: f64, out_effects: Int32Array | null = null): void {
  if (k <= 0.0) return;
  let factor = 1.0 - k * H;
  if (factor < 0.0) factor = 0.0;
  for (let b: i32 = 0; b < bodies; b++) {
    if (touched[b] == 0) continue;
    if (asleep[b] != 0) continue;
    const wx = om[b * 3 + 0], wy = om[b * 3 + 1], wz = om[b * 3 + 2];
    const spin = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!damping_rule_b && spin < SLEEP_ANGULAR) continue; // rule A's parking guard
    om[b * 3 + 0] = wx * factor;
    om[b * 3 + 1] = wy * factor;
    om[b * 3 + 2] = wz * factor;
    if (out_effects != null) out_effects[0] += 1;
  }
}

// ── the sleep policy, copied from chunks 7 and 8c1 ───────────────────────
//
// A copy, and labelled as one: 9a-ii runs the same scenarios through the SDK's
// own policy. What it has to reproduce is the *interaction* — a damped body must
// still reach the thresholds and sleep, and a slept body must be skipped by the
// damping and left bit-for-bit still.

class SleepPolicy {
  counter: Uint32Array;
  asleep: Uint8Array;
  travel: Float64Array;
  angular_travel: Float64Array;
  previous: Float64Array;
  previous_quat: Float64Array;

  constructor(bodies: i32) {
    this.counter = new Uint32Array(bodies);
    this.asleep = new Uint8Array(bodies);
    this.travel = new Float64Array(bodies);
    this.angular_travel = new Float64Array(bodies);
    this.previous = new Float64Array(bodies * 3);
    this.previous_quat = new Float64Array(bodies * 4);
  }

  record(state: Float64Array, bodies: i32): void {
    for (let i: i32 = 0; i < bodies; i++) {
      const at = i * 7;
      this.previous[i * 3 + 0] = state[at + 0];
      this.previous[i * 3 + 1] = state[at + 1];
      this.previous[i * 3 + 2] = state[at + 2];
      for (let k: i32 = 0; k < 4; k++) this.previous_quat[i * 4 + k] = state[at + 3 + k];
    }
  }

  update(state: Float64Array, bodies: i32, dt: f64): void {
    const span = dt > 0.0 ? dt : 1.0e-9;
    for (let i: i32 = 0; i < bodies; i++) {
      if (this.asleep[i] != 0) continue;
      const at = i * 7;
      const dx = state[at + 0] - this.previous[i * 3 + 0];
      const dy = state[at + 1] - this.previous[i * 3 + 1];
      const dz = state[at + 2] - this.previous[i * 3 + 2];
      this.travel[i] += Math.sqrt(dx * dx + dy * dy + dz * dz);
      let qprev = new Float64Array(4);
      for (let k: i32 = 0; k < 4; k++) qprev[k] = this.previous_quat[i * 4 + k];
      this.angular_travel[i] += quat_delta(qprev, 0, state, at + 3);
      this.counter[i] += 1;
      if (this.counter[i] < SLEEP_FRAMES) continue;
      const average = this.travel[i] / (<f64>this.counter[i] * span);
      const angular = this.angular_travel[i] / (<f64>this.counter[i] * span);
      if (average < SLEEP_SPEED && angular < SLEEP_ANGULAR) {
        this.asleep[i] = 1;
        // Zero the pair: the derivative keeps it zero from here.
        const half = state.length / 2;
        state[half + at + 0] = 0.0; state[half + at + 1] = 0.0; state[half + at + 2] = 0.0;
        state[half + at + 3] = 0.0; state[half + at + 4] = 0.0;
        state[half + at + 5] = 0.0; state[half + at + 6] = 0.0;
      }
      this.travel[i] = 0.0;
      this.angular_travel[i] = 0.0;
      this.counter[i] = 0;
    }
  }

  asleepCount(bodies: i32): i32 {
    let n = 0;
    for (let i: i32 = 0; i < bodies; i++) if (this.asleep[i] != 0) n += 1;
    return n;
  }
}

// ── the scenario harness ─────────────────────────────────────────────────

/** What one run produced. */
class RunOutcome {
  stop_frame: i32 = -1;      // both state thresholds crossed
  turn_rad: f64 = 0.0;       // accumulated |Δq| per frame
  wall_touch_frame: i32 = -1;
  max_x: f64 = -1.0e9;
  linear_speed_max: f64 = 0.0;
  wake_note: string = "";
}

/// A world of `bodies` at the given spawn, stepped `frames` times at K = 4 with
/// the candidate damping on, tracking what the questions ask for. The bodies are
/// the probe's own: a sphere each, with `invInertia` uniform.
function run_scenario(state: Float64Array, bodies: i32, k: f64, frames: i32,
                      track_turn: bool, watch: i32, out: RunOutcome,
                      gate: i32 = 0): ArrayBuffer | null {
  const solver = make_solver(bodies);
  if (solver == null) { print("  FAIL create refused"); return null; }
  const dim = bodies * 14;
  const om = new Float64Array(MAX_BODIES * 3);
  const touched = new Uint8Array(MAX_BODIES);
  const near = new Uint8Array(MAX_BODIES);
  const policy = new SleepPolicy(bodies);
  const buf = new Float64Array(dim + 1);
  const prev_q = new Float64Array(4);
  const hold = new Float64Array(4);
  let stopped = false;

  solver.setState(0.0, state);
  policy.record(state, bodies);
  for (let frame: i32 = 0; frame < frames; frame++) {
    for (let sub: i32 = 0; sub < SUBSTEPS; sub++) {
      sleep_mask = policy.asleep;
      if (solver.step(H) != 0) { print("  FAIL step refused"); sleep_mask = null; return null; }
      sleep_mask = null;
      if (solver.state(buf) < 0) return null;
      for (let i: i32 = 0; i < dim; i++) state[i] = buf[i + 1];

      contact_count = 0;
      for (let i: i32 = 0; i < bodies; i++) { touched[i] = 0; near[i] = 0; }
      for (let i: i32 = 0; i < bodies; i++) add_floor_and_walls(state, i, near);
      if (bodies > 1) {
        for (let a: i32 = 0; a < bodies; a++) {
          for (let b: i32 = a + 1; b < bodies; b++) add_pair(state, a, b, near);
        }
      }
      resolve_all(state, om, bodies, H, touched, policy);
      if (gate == 1) {
        for (let i: i32 = 0; i < bodies; i++) if (near[i] != 0) touched[i] = 1;
      }
      damp(om, touched, policy.asleep, bodies, k);
      // Sleepers are left alone entirely: renormalizing a frozen body would
      // change its bits, and the stillness clause is an equality.
      for (let i: i32 = 0; i < bodies; i++) {
        if (policy.asleep[i] != 0) continue;
        canonicalize(state, om, i);
      }
      if (solver.setState(buf[0], state) != 0) return null;
    }
    policy.update(state, bodies, DT);
    policy.record(state, bodies);

    // Per-frame measurements.
    for (let c: i32 = 0; c < 4; c++) hold[c] = state[watch * 7 + 3 + c];
    if (frame == 0) for (let c: i32 = 0; c < 4; c++) prev_q[c] = hold[c];
    if (track_turn) out.turn_rad += quat_delta(prev_q, 0, state, watch * 7 + 3);
    for (let c: i32 = 0; c < 4; c++) prev_q[c] = hold[c];

    const x = state[watch * 7 + 0];
    if (x > out.max_x) out.max_x = x;
    const vx = state[<i32>(state.length / 2) + watch * 7 + 0];
    const vy = state[<i32>(state.length / 2) + watch * 7 + 1];
    const vz = state[<i32>(state.length / 2) + watch * 7 + 2];
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > out.linear_speed_max) out.linear_speed_max = speed;
    if (out.wall_touch_frame < 0 && out.max_x > EXTENT - RADIUS - 1.0e-6) {
      out.wall_touch_frame = frame;
    }
    if (!stopped) {
      recover_omega(state, om, watch, 0);
      const w = Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]);
      if (speed < SLEEP_SPEED && w < SLEEP_ANGULAR) {
        out.stop_frame = frame;
        stopped = true;
      }
    }
  }
  solver.destroy();
  return null;
}

function add_floor_and_walls(state: Float64Array, i: i32, near: Uint8Array | null = null): void {
  const at = i * 7;
  const px = state[at + 0], py = state[at + 1], pz = state[at + 2];
  // The `near` flag is the second gate's input: a contact *candidate*, before
  // the slop decides whether to resolve it. A resting body's equilibrium
  // penetration sits under the slop, so the resolved-contact gate is
  // intermittent — which is the measurement this probe exists to make.
  if (near != null) {
    if (RADIUS - py > 0.0 || RADIUS - (px + EXTENT) > 0.0 ||
        RADIUS - (EXTENT - px) > 0.0 || RADIUS - (pz + EXTENT) > 0.0 ||
        RADIUS - (EXTENT - pz) > 0.0) near[i] = 1;
  }
  if (RADIUS - py > SLOP) add_contact(i, -1, px, py - RADIUS, pz, 0.0, 1.0, 0.0, RADIUS - py);
  if (RADIUS - (px + EXTENT) > SLOP) {
    add_contact(i, -1, px + RADIUS, py, pz, 1.0, 0.0, 0.0, RADIUS - (px + EXTENT));
  }
  if (RADIUS - (EXTENT - px) > SLOP) {
    add_contact(i, -1, px - RADIUS, py, pz, -1.0, 0.0, 0.0, RADIUS - (EXTENT - px));
  }
  if (RADIUS - (pz + EXTENT) > SLOP) {
    add_contact(i, -1, px, py, pz + RADIUS, 0.0, 0.0, 1.0, RADIUS - (pz + EXTENT));
  }
  if (RADIUS - (EXTENT - pz) > SLOP) {
    add_contact(i, -1, px, py, pz - RADIUS, 0.0, 0.0, -1.0, RADIUS - (EXTENT - pz));
  }
}

function add_pair(state: Float64Array, a: i32, b: i32, near: Uint8Array | null = null): void {
  const ax = state[a * 7 + 0], ay = state[a * 7 + 1], az = state[a * 7 + 2];
  const bx = state[b * 7 + 0], by = state[b * 7 + 1], bz = state[b * 7 + 2];
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d2 = dx * dx + dy * dy + dz * dz;
  const reach = 2.0 * RADIUS;
  if (d2 >= reach * reach || d2 <= 1.0e-18) return;
  const d = Math.sqrt(d2);
  const pen = reach - d;
  if (near != null) { near[a] = 1; near[b] = 1; }
  if (pen <= SLOP) return;
  add_contact(a, b, ax + (RADIUS - pen * 0.5) * dx / d, ay + (RADIUS - pen * 0.5) * dy / d,
              az + (RADIUS - pen * 0.5) * dz / d, dx / d, dy / d, dz / d, pen);
}

function seed_one(state: Float64Array, i: i32, x: f64, y: f64, z: f64, vx: f64 = 0.0): void {
  const at = i * 7;
  state[at + 0] = x; state[at + 1] = y; state[at + 2] = z;
  state[at + 3] = 0.0; state[at + 4] = 0.0; state[at + 5] = 0.0; state[at + 6] = 1.0;
  const v = <i32>(state.length / 2) + i * 7;
  state[v + 0] = vx; state[v + 1] = 0.0; state[v + 2] = 0.0;
  state[v + 3] = 0.0; state[v + 4] = 0.0; state[v + 5] = 0.0; state[v + 6] = 0.0;
}

/// `q` and `q'` for a spin about the vertical axis: `q' = ½ω⊗q`, ω = (0, wy, 0).
function set_spin_y(state: Float64Array, i: i32, wy: f64): void {
  const at = i * 7, v = <i32>(state.length / 2) + i * 7;
  state[at + 3] = 0.0; state[at + 4] = 0.0; state[at + 5] = 0.0; state[at + 6] = 1.0;
  state[v + 3] = 0.5 * (wy * 1.0);
  state[v + 4] = 0.0;
  state[v + 5] = 0.0;
  state[v + 6] = 0.0;
}

// ── Q1: the roller ───────────────────────────────────────────────────────

function q1_roller(): void {
  print("Q1 the roller: v0 = " + ROLL_V0.toString() + " m/s, runway " +
        (EXTENT - RADIUS - ROLL_START_X).toString() + " m to the wall, K=4");
  print("Q1 k     v(t)/v0 at 10-frame intervals (0..290), then turn and stop");
  for (let ki: i32 = 0; ki < KS; ki++) {
   for (let gate: i32 = 0; gate < 2; gate++) {
    const k = K_VALUES[ki];
    const state = new Float64Array(14);
    seed_one(state, 0, ROLL_START_X, RADIUS, 0.0, ROLL_V0);
    const out = new RunOutcome();
    // v(t) needs its own walk, so the scenario runs frame by frame here.
    const solver = make_solver(1);
    if (solver == null) return;
    const om = new Float64Array(MAX_BODIES * 3);
    const touched = new Uint8Array(MAX_BODIES);
    const near = new Uint8Array(MAX_BODIES);
    const policy = new SleepPolicy(1);
    const buf = new Float64Array(15);
    const prev_q = new Float64Array(4);
    const hold = new Float64Array(4);
    let line = "Q1 " + k.toString() + " :";
    let stopped = false;
    let contact_subs = 0, subs_total = 0;
    solver.setState(0.0, state);
    policy.record(state, 1);
    for (let frame: i32 = 0; frame < FRAMES; frame++) {
      for (let sub: i32 = 0; sub < SUBSTEPS; sub++) {
        sleep_mask = policy.asleep;
        if (solver.step(H) != 0) { print("  FAIL"); sleep_mask = null; solver.destroy(); return; }
        sleep_mask = null;
        if (solver.state(buf) < 0) return;
        for (let i: i32 = 0; i < 14; i++) state[i] = buf[i + 1];
        contact_count = 0;
        touched[0] = 0; near[0] = 0;
        add_floor_and_walls(state, 0, near);
        resolve_all(state, om, 1, H, touched, policy);
        if (gate == 1 && near[0] != 0) touched[0] = 1;
        subs_total += 1;
        if (touched[0] != 0) contact_subs += 1;
        damp(om, touched, policy.asleep, 1, k);
        if (policy.asleep[0] == 0) canonicalize(state, om, 0);
        if (solver.setState(buf[0], state) != 0) return;
      }
      policy.update(state, 1, DT);
      policy.record(state, 1);
      for (let c: i32 = 0; c < 4; c++) hold[c] = state[3 + c];
      if (frame == 0) for (let c: i32 = 0; c < 4; c++) prev_q[c] = hold[c];
      out.turn_rad += quat_delta(prev_q, 0, state, 3);
      for (let c: i32 = 0; c < 4; c++) prev_q[c] = hold[c];
      const vx = state[7 + 0];
      if (frame % 10 == 0) line += " " + (vx / ROLL_V0).toString().slice(0, 5);
      if (state[0] > out.max_x) out.max_x = state[0];
      if (!stopped) {
        recover_omega(state, om, 0, 0);
        const w = Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]);
        const speed = Math.sqrt(state[7] * state[7] + state[8] * state[8] + state[9] * state[9]);
        if (speed < SLEEP_SPEED && w < SLEEP_ANGULAR) { out.stop_frame = frame; stopped = true; }
      }
    }
    solver.destroy();
    print(line);
    print("Q1 k=" + k.toString() + " gate " + gate.toString() + ": turn " +
          (out.turn_rad * 180.0 / 3.14159265358979).toString() + " deg, stop frame " +
          out.stop_frame.toString() + ", sleep frame " +
          (out.stop_frame >= 0 ? out.stop_frame + <i32>SLEEP_FRAMES : -1).toString() +
          ", max x " + out.max_x.toString() + ", contact fraction " +
          (<f64>contact_subs / <f64>subs_total).toString());
   }
  }
}

// ── Q2: the spinner ──────────────────────────────────────────────────────

function q2_spinner(): void {
  print("Q2 the spinner: w0 = " + SPIN_W0.toString() + " rad/s about y, dropped from y = " +
        SPIN_DROP_Y.toString());
  for (let ki: i32 = 0; ki < KS; ki++) {
   for (let gate: i32 = 0; gate < 2; gate++) {
    const k = K_VALUES[ki];
    const state = new Float64Array(14);
    seed_one(state, 0, SPIN_AT_X, SPIN_DROP_Y, SPIN_AT_Z);
    set_spin_y(state, 0, SPIN_W0);
    const solver = make_solver(1);
    if (solver == null) return;
    const om = new Float64Array(MAX_BODIES * 3);
    const touched = new Uint8Array(MAX_BODIES);
    const near = new Uint8Array(MAX_BODIES);
    const policy = new SleepPolicy(1);
    const buf = new Float64Array(15);
    const prev_q = new Float64Array(4);
    const hold = new Float64Array(4);
    let turn = 0.0, stop_frame: i32 = -1, first_contact: i32 = -1;
    let contact_subs: i32 = 0, subs_since: i32 = 0, lateral_max = 0.0;
    let stopped = false;
    solver.setState(0.0, state);
    policy.record(state, 1);
    for (let frame: i32 = 0; frame < FRAMES; frame++) {
      for (let sub: i32 = 0; sub < SUBSTEPS; sub++) {
        sleep_mask = policy.asleep;
        if (solver.step(H) != 0) { sleep_mask = null; solver.destroy(); return; }
        sleep_mask = null;
        if (solver.state(buf) < 0) return;
        for (let i: i32 = 0; i < 14; i++) state[i] = buf[i + 1];
        contact_count = 0;
        touched[0] = 0; near[0] = 0;
        add_floor_and_walls(state, 0, near);
        resolve_all(state, om, 1, H, touched, policy);
        if (gate == 1 && near[0] != 0) touched[0] = 1;
        if (gate == 0 && contact_count > 0 && first_contact < 0) first_contact = frame;
        if (gate == 1 && near[0] != 0 && first_contact < 0) first_contact = frame;
        if (first_contact >= 0) {
          subs_since += 1;
          if (touched[0] != 0) contact_subs += 1; // exactly the sub-steps the damping saw
        }
        damp(om, touched, policy.asleep, 1, k);
        if (policy.asleep[0] == 0) canonicalize(state, om, 0);
        if (solver.setState(buf[0], state) != 0) return;
      }
      policy.update(state, 1, DT);
      policy.record(state, 1);
      for (let c: i32 = 0; c < 4; c++) hold[c] = state[3 + c];
      if (frame == 0) for (let c: i32 = 0; c < 4; c++) prev_q[c] = hold[c];
      turn += quat_delta(prev_q, 0, state, 3);
      for (let c: i32 = 0; c < 4; c++) prev_q[c] = hold[c];
      // The lateral velocity, not the speed: the spinner falls, so |v| is 2.9
      // m/s at impact and says nothing. A resistance with any linear component
      // would show up here, and this body has no horizontal motion to have.
      const lateral = Math.sqrt(state[7] * state[7] + state[9] * state[9]);
      if (lateral > lateral_max) lateral_max = lateral;
      if (!stopped) {
        recover_omega(state, om, 0, 0);
        const w = Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]);
        if (w < SLEEP_ANGULAR) { stop_frame = frame; stopped = true; }
      }
    }
    solver.destroy();
    const fraction = subs_since > 0 ? <f64>contact_subs / <f64>subs_since : 0.0;
    print("Q2 k=" + k.toString() + " gate " + gate.toString() + ": turn " +
          (turn * 180.0 / 3.14159265358979).toString() + " deg, stop frame " +
          stop_frame.toString() + ", first contact frame " + first_contact.toString() +
          ", contact fraction " + fraction.toString() + " (" + contact_subs.toString() +
          " of " + subs_since.toString() + " sub-steps), max lateral |v| " +
          lateral_max.toString());
   }
  }
}

// ── Q3: the pile ─────────────────────────────────────────────────────────

function q3_pile(): void {
  print("Q3 the pile: " + PILE.toString() + " bodies, the fixture's four columns, K=4");
  for (let ki: i32 = 0; ki < KS; ki++) {
   for (let gate: i32 = 0; gate < 2; gate++) {
    const k = K_VALUES[ki];
    const state = new Float64Array(PILE * 14);
    for (let i: i32 = 0; i < PILE; i++) {
      const layer = i % 4;
      const column = i / 4;
      const x = -0.5 + <f64>(column % 2) * 0.35;
      const z = -0.5 + <f64>(column / 2) * 0.35;
      seed_one(state, i, x, RADIUS + 0.005 + <f64>layer * (2.05 * RADIUS), z);
    }
    const solver = make_solver(PILE);
    if (solver == null) return;
    const dim = PILE * 14;
    const om = new Float64Array(MAX_BODIES * 3);
    const touched = new Uint8Array(MAX_BODIES);
    const near = new Uint8Array(MAX_BODIES);
    const policy = new SleepPolicy(PILE);
    const buf = new Float64Array(dim + 1);
    let settle_frame: i32 = -1, sleep_frame: i32 = -1;
    let still_frame: i32 = -1, still_ok: bool = true;
    const frozen = new Float64Array(dim);
    solver.setState(0.0, state);
    policy.record(state, PILE);
    for (let frame: i32 = 0; frame < 240; frame++) {
      for (let sub: i32 = 0; sub < SUBSTEPS; sub++) {
        sleep_mask = policy.asleep;
        if (solver.step(H) != 0) { sleep_mask = null; solver.destroy(); return; }
        sleep_mask = null;
        if (solver.state(buf) < 0) return;
        for (let i: i32 = 0; i < dim; i++) state[i] = buf[i + 1];
        contact_count = 0;
        for (let i: i32 = 0; i < PILE; i++) { touched[i] = 0; near[i] = 0; }
        for (let i: i32 = 0; i < PILE; i++) add_floor_and_walls(state, i, near);
        for (let a: i32 = 0; a < PILE; a++) {
          for (let b: i32 = a + 1; b < PILE; b++) add_pair(state, a, b, near);
        }
        resolve_all(state, om, PILE, H, touched, policy);
        if (gate == 1) {
          for (let i: i32 = 0; i < PILE; i++) if (near[i] != 0) touched[i] = 1;
        }
        damp(om, touched, policy.asleep, PILE, k);
        for (let i: i32 = 0; i < PILE; i++) {
          if (policy.asleep[i] != 0) continue;
          canonicalize(state, om, i);
        }
        if (solver.setState(buf[0], state) != 0) return;
      }
      policy.update(state, PILE, DT);
      policy.record(state, PILE);

      // Settling: every body below both state thresholds.
      if (settle_frame < 0) {
        let all_still = true;
        for (let i: i32 = 0; i < PILE; i++) {
          recover_omega(state, om, i, 0);
          const w = Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]);
          const v = Math.sqrt(state[dim / 2 + i * 7] * state[dim / 2 + i * 7] +
                              state[dim / 2 + i * 7 + 1] * state[dim / 2 + i * 7 + 1] +
                              state[dim / 2 + i * 7 + 2] * state[dim / 2 + i * 7 + 2]);
          if (v >= SLEEP_SPEED || w >= SLEEP_ANGULAR) { all_still = false; break; }
        }
        if (all_still) settle_frame = frame;
      }
      if (sleep_frame < 0 && policy.asleepCount(PILE) == PILE) {
        sleep_frame = frame;
        for (let i: i32 = 0; i < dim; i++) frozen[i] = state[i];
      } else if (sleep_frame >= 0 && still_ok) {
        still_frame += 1;
        if (still_frame >= 30) still_frame = 29; // one comparison is enough
        if (still_frame == 29) {
          for (let i: i32 = 0; i < dim; i++) {
            if (frozen[i] != state[i]) { still_ok = false; break; }
          }
        }
      }
    }
    solver.destroy();
    print("Q3 k=" + k.toString() + " gate " + gate.toString() + ": settle frame " +
          settle_frame.toString() + ", sleep frame " + sleep_frame.toString() +
          ", bit-for-bit still over 30 frames: " + (still_ok ? "yes" : "NO"));
   }
  }
}

// ── Q4: the impulse interaction ──────────────────────────────────────────

function q4_interaction(): void {
  print("Q4 the resistance is a torque: it cannot move a body");
  // (a) The spinner's linear velocity must stay exactly 0: no slip, no
  // tangential impulse, and the damping writes only ω.
  {
    const state = new Float64Array(14);
    seed_one(state, 0, SPIN_AT_X, SPIN_DROP_Y, SPIN_AT_Z);
    set_spin_y(state, 0, SPIN_W0);
    const out = new RunOutcome();
    run_scenario(state, 1, 3.6, 120, false, 0, out);
    print("Q4a spinner max speed over 120 frames at k=3.6: " +
          out.linear_speed_max.toString() + " (its fall speed; the lateral component is 0)");
  }
  // (b) The roller into the wall: the damping must not push it through.
  for (let ki: i32 = 0; ki < 2; ki++) {
    const k = ki == 0 ? 0.0 : 3.6;
    const state = new Float64Array(14);
    seed_one(state, 0, ROLL_START_X, RADIUS, 0.0, ROLL_V0);
    const out = new RunOutcome();
    run_scenario(state, 1, k, 150, false, 0, out);
    print("Q4b roller at k=" + k.toString() + ": max x " + out.max_x.toString() +
          " (wall at " + (EXTENT - RADIUS).toString() + ", penetration " +
          (out.max_x - (EXTENT - RADIUS)).toString() + "), wall contact frame " +
          out.wall_touch_frame.toString());
  }
}

// ── Q5: the free-space control ───────────────────────────────────────────

/// A one-off: the spinner's raw ω decay per frame at k = 4, gate 1, to see
/// whether the applied factor is the intended one.
function q0_raw_decay(): void {
  print("Q0 raw spinner decay at k=4, gate 1 (per-frame |w|):");
  const k = 4.0;
  const state = new Float64Array(14);
  seed_one(state, 0, SPIN_AT_X, RADIUS + 0.001, SPIN_AT_Z);
  set_spin_y(state, 0, SPIN_W0);
  const solver = make_solver(1);
  if (solver == null) return;
  const om = new Float64Array(MAX_BODIES * 3);
  const touched = new Uint8Array(MAX_BODIES);
  const near = new Uint8Array(MAX_BODIES);
  const policy = new SleepPolicy(1);
  const buf = new Float64Array(15);
  solver.setState(0.0, state);
  policy.record(state, 1);
  let line = "";
  for (let frame: i32 = 0; frame < 12; frame++) {
    for (let sub: i32 = 0; sub < SUBSTEPS; sub++) {
      sleep_mask = policy.asleep;
      if (solver.step(H) != 0) { sleep_mask = null; solver.destroy(); return; }
      sleep_mask = null;
      if (solver.state(buf) < 0) return;
      for (let i: i32 = 0; i < 14; i++) state[i] = buf[i + 1];
      contact_count = 0;
      touched[0] = 0; near[0] = 0;
      add_floor_and_walls(state, 0, near);
      resolve_all(state, om, 1, H, touched, policy);
      if (near[0] != 0) touched[0] = 1;
      recover_omega(state, om, 0, 0);
      line += " s(w=" + Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]).toString().slice(0, 7);
      damp(om, touched, policy.asleep, 1, k);
      line += ">d" + Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]).toString().slice(0, 7);
      if (policy.asleep[0] == 0) canonicalize(state, om, 0);
      if (solver.setState(buf[0], state) != 0) return;
    }
    policy.update(state, 1, DT);
    policy.record(state, 1);
  }
  print(line);
  solver.destroy();
}

function q5_free_space(): void {
  print("Q5 free space: no contact, no damping (gravity off, or the body lands and " +
        "the test measures the floor)");
  const saved_gravity = gravity_y;
  gravity_y = 0.0;
  for (let ki: i32 = 0; ki < KS; ki++) {
    const k = K_VALUES[ki];
    const state = new Float64Array(14);
    seed_one(state, 0, -1.5, 5.0, -1.5);
    set_spin_y(state, 0, SPIN_W0);
    const out = new RunOutcome();
    run_scenario(state, 1, k, 60, false, 0, out);
    const om = new Float64Array(3);
    recover_omega(state, om, 0, 0);
    const w = Math.sqrt(om[0] * om[0] + om[1] * om[1] + om[2] * om[2]);
    print("Q5 k=" + k.toString() + ": |w| after 60 frames in free space " + w.toString() +
          " (error " + abs(w - SPIN_W0).toString() + ")");
  }
  gravity_y = saved_gravity;
}

// ── Q6: the three-way pinch ──────────────────────────────────────────────

class Pinch {
  roller_turn: f64 = 0.0;
  spinner_turn: f64 = 0.0;
  roller_sleep: i32 = -1;
}

function measure_pinch(k: f64, gate: i32 = 1): Pinch {
  const p = new Pinch();
  {
    const state = new Float64Array(14);
    seed_one(state, 0, ROLL_START_X, RADIUS, 0.0, ROLL_V0);
    const out = new RunOutcome();
    run_scenario(state, 1, k, 200, true, 0, out, gate);
    p.roller_turn = out.turn_rad * 180.0 / 3.14159265358979;
    p.roller_sleep = out.stop_frame >= 0 ? out.stop_frame + <i32>SLEEP_FRAMES : -1;
  }
  {
    const state = new Float64Array(14);
    seed_one(state, 0, SPIN_AT_X, SPIN_DROP_Y, SPIN_AT_Z);
    set_spin_y(state, 0, SPIN_W0);
    const out = new RunOutcome();
    run_scenario(state, 1, k, 200, true, 0, out, gate);
    p.spinner_turn = out.turn_rad * 180.0 / 3.14159265358979;
  }
  return p;
}

function q6_pinch(): void {
  print("Q6 the three-way pinch: roller turn >= 90 deg, spinner turn >= 30 deg, " +
        "roller asleep by frame 120");
  print("Q6 k      roller turn  margin   spinner turn  margin   roller sleep  margin");
  print("Q6 (gate 0 = damping keys on a *resolved* contact, which a resting body's "
        + "sub-slop penetration makes intermittent; gate 1 = on a contact candidate)");
  for (let ki: i32 = 0; ki < PINCH_KS; ki++) {
   for (let gate: i32 = 0; gate < 2; gate++) {
    const k = PINCH_VALUES[ki];
    const p = measure_pinch(k, gate);
    const roller_margin = p.roller_turn - 90.0;
    const spinner_margin = p.spinner_turn - 30.0;
    // A body that never stopped has no sleep frame, and that is the largest
    // margin there is — so it must read as the *smallest*.
    const sleep_margin = p.roller_sleep < 0 ? -1.0 : <f64>(120 - p.roller_sleep);
    const pass = roller_margin >= 0.0 && spinner_margin >= 0.0 && sleep_margin >= 0.0;
    print("Q6 " + k.toString() + "  " + p.roller_turn.toString() + "  " +
          roller_margin.toString() + "  " + p.spinner_turn.toString() + "  " +
          spinner_margin.toString() + "  " + p.roller_sleep.toString() + "  " +
          sleep_margin.toString() + "  -> " + (pass ? "PASS" : "FAIL") +
          "  (gate " + gate.toString() + ")");
   }
  }
}

/// The decisive table: gate 1 (a contact candidate, so the fraction is ~1) with
/// rule B (no threshold parking), for the sweep and the pinch.
function q7_gate1_rule_b(): void {
  print("Q7 gate 1 (contact candidate) with rule B (damping runs until sleep):");
  damping_rule_b = true;
  for (let ki: i32 = 0; ki < KS; ki++) {
    const k = K_VALUES[ki];
    {
      const state = new Float64Array(14);
      seed_one(state, 0, ROLL_START_X, RADIUS, 0.0, ROLL_V0);
      const out = new RunOutcome();
      run_scenario(state, 1, k, 300, true, 0, out, 1);
      const turn = out.turn_rad * 180.0 / 3.14159265358979;
      print("Q7 roller k=" + k.toString() + ": turn " + turn.toString() + " deg, stop frame " +
            out.stop_frame.toString() + ", sleep frame " +
            (out.stop_frame >= 0 ? out.stop_frame + <i32>SLEEP_FRAMES : -1).toString() +
            ", max x " + out.max_x.toString());
    }
    {
      const state = new Float64Array(14);
      seed_one(state, 0, SPIN_AT_X, SPIN_DROP_Y, SPIN_AT_Z);
      set_spin_y(state, 0, SPIN_W0);
      const out = new RunOutcome();
      run_scenario(state, 1, k, 300, true, 0, out, 1);
      const turn = out.turn_rad * 180.0 / 3.14159265358979;
      print("Q7 spinner k=" + k.toString() + ": turn " + turn.toString() +
            " deg, stop frame " + out.stop_frame.toString());
    }
  }
  print("Q7b a wider sweep, to find where a roller actually sleeps inside 120 frames:");
  const WIDE: f64[] = [8.0, 10.0, 12.0, 15.0, 20.0];
  for (let wi: i32 = 0; wi < WIDE.length; wi++) {
    const k = WIDE[wi];
    const rstate = new Float64Array(14);
    seed_one(rstate, 0, ROLL_START_X, RADIUS, 0.0, ROLL_V0);
    const rout = new RunOutcome();
    run_scenario(rstate, 1, k, 400, true, 0, rout, 1);
    const sstate = new Float64Array(14);
    seed_one(sstate, 0, SPIN_AT_X, SPIN_DROP_Y, SPIN_AT_Z);
    set_spin_y(sstate, 0, SPIN_W0);
    const sout = new RunOutcome();
    run_scenario(sstate, 1, k, 400, true, 0, sout, 1);
    print("Q7b k=" + k.toString() + ": roller turn " +
          (rout.turn_rad * 180.0 / 3.14159265358979).toString() + " deg, sleep frame " +
          (rout.stop_frame >= 0 ? rout.stop_frame + <i32>SLEEP_FRAMES : -1).toString() +
          " | spinner turn " + (sout.turn_rad * 180.0 / 3.14159265358979).toString() +
          " deg, stop frame " + sout.stop_frame.toString());
  }

  print("Q7 the measured coupling: a *rolling* pair decays at k·I/(I + m r²) = 0.286k, " +
        "because friction re-couples the spin to the linear momentum the angular term " +
        "cannot touch. A free spinner decays at k.");
  print("Q7 pinch (gate 1, rule B): roller turn >= 90, spinner turn >= 30, roller asleep <= 120");
  for (let ki: i32 = 0; ki < PINCH_KS; ki++) {
    const k = PINCH_VALUES[ki];
    const p = measure_pinch(k, 1);
    const rm = p.roller_turn - 90.0, sm = p.spinner_turn - 30.0;
    const km = p.roller_sleep < 0 ? -1.0 : <f64>(120 - p.roller_sleep);
    print("Q7 k=" + k.toString() + ": roller " + p.roller_turn.toString() + " (" +
          rm.toString() + "), spinner " + p.spinner_turn.toString() + " (" + sm.toString() +
          "), roller sleep " + p.roller_sleep.toString() + " (" + km.toString() + ") -> " +
          ((rm >= 0.0 && sm >= 0.0 && km >= 0.0) ? "PASS" : "FAIL"));
  }
  damping_rule_b = false;
}

export function _start_game(): void {
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("FAIL session_open refused");
    assert(false, "session_open");
  }
  max_bodies = 16;
  print("ROLLING probe (9a-i): the candidate ω ← ω·max(0, 1 − k·h), K=4, " +
        "dt = 1/60, contact-only");
  q0_raw_decay();
  q1_roller();
  q2_spinner();
  q3_pile();
  q4_interaction();
  q5_free_space();
  q6_pinch();
  q7_gate1_rule_b();
  RuntimeSession.close();
  print("OK 9a-i probe complete");
}
