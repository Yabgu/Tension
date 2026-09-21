// probe-angular.ts — 8a: the numbers chunk 8's angular model is written against.
//
// ── the finding that shapes everything below ─────────────────────────────
//
// The design's first cut put the spin in the state as an angular velocity:
// coordinates `[x, y, z, qx, qy, qz, qw]`, velocities `[vx, vy, vz, wx, wy, wz,
// pad]`. The solver refused it — not with an error, but by integrating it
// wrongly, which is worse. `tension_solver_symplectic.f90` is a **second-order**
// Verlet: its position update is `q += dt·v_state + ½dt²·a_rhs`, reading the
// *state's* second half and the *RHS's* second half — and it never reads the
// RHS's first half at all. Measured: with `[., wx, wy, wz, .]` in the velocity
// half and a RHS returning `[v, ½w⊗q | a, 0]`, a body spun at 1 rad/s for one
// second came out at 1.5708 rad with |q| = 1.4142 (√2), because the update the
// solver actually performed was `q += dt·w` — an addition of an angular
// velocity to a quaternion, which is not a rotation and is not a derivative.
// The ERK family is first-order (`y += dt·k1`) and would have used the RHS's
// first half; the symplectic family is not, and chunk 6's model worked only
// because positions and velocities are exactly a second-order pair.
//
// So the state's second half must be **the coordinates' time derivative**:
// for the quaternion, `q' = ½ w⊗q` — not `w`. That is the model measured below
// (Q3's four runs; the naive one is kept as the evidence). The layout keeps
// fourteen slots and needs no pad slot: seven coordinates, seven derivatives.
//
// The RHS is then the same function for both families: it returns
// `[v, q' | a, q'']`, and for a torque-free body the second derivative collapses
// to a scalar multiple of q — `q'' = ½ w⊗q' = −(|q'|²/|q|²) q` — so the model
// costs the linear model's slot copies plus four multiplies per body, not two
// quaternion products (the C-level probe measures both forms). `w` is recovered from the pair `(q, q')` as `2 q'⊗q⁻¹`, so the state
// stays self-contained: no hidden angular-velocity table, `set_state` still
// means what it says, and the region is still the truth.
//
// The questions:
//   Q1  Does Verlet accept dim = 14N? (Even is required; the odd-dim control
//       asks where the check actually lives.)
//   Q2  What an angular step costs — the C-level probe's number
//       (`probe_physics.cpp`, dim = 14N beside dim = 6N).
//   Q3  The state-write experiment, quaternion edition: untouched, written back
//       verbatim, and written back with the model's canonicalization
//       (renormalize; `q' = ½w⊗q`), plus the naive layout as the control.
//   Q4  Does a positional bias spin a resting body? Both wirings, measured.
//   Q5  Terminal behaviour of a resting box over 600 frames, for a sequential
//       pass, two sequential passes, and one Jacobi pass (which is the one the
//       four symmetric corners want).
//   Q6  Rolling, measured against the closed form (v_f = 5/7 v_0, w = v/r).
//
// Build and run (from the repo root):
//   tension-framework/node_modules/.bin/asc tension-solver/tests/probe-angular.ts \
//       --config tension-framework/build/session.asconfig.json \
//       -o tension-solver/build/probe-angular/probe-angular.wasm
//   tension-core/target/debug/tension-core \
//       --capability tension-ogre/build/libtension_ogre.so \
//       tension-solver/build/probe-angular/probe-angular.wasm --renderer=null

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import { Solver, SolverConfig } from "../../tension-framework/assembly/solver";
import * as ogre from "../../tension-framework/assembly/ogre";

const DT: f64 = 1.0 / 60.0;
const G: f64 = -9.81;

/** Chunk 6's response parameters, so the angular model is comparable with it. */
const BETA: f64 = 0.2;
const SLOP: f64 = 1.0e-3;
const BIAS_CAP: f64 = 1.0;
const SUBSTEPS: i32 = 4;

/** Seven coordinates, seven derivatives. */
const SLOTS = 7;

const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);
export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

let derivative_calls: i64 = 0;
/** Gravity is module state, the way the SDK keeps it: set per experiment. */
let gravity_y: f64 = 0.0;

/// The angular model's RHS: `[v, q' | a, q'']` with `q' = ½ w⊗q` and
/// `q'' = ½ w⊗q'`. `w` is recovered from `(q, q')`, so the RHS needs no table.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  derivative_calls += 1;
  if (dyCap < len) return -22; // -EINVAL
  const half = len / 2;
  if (half % SLOTS != 0) return -22; // not an angular state
  for (let base: i32 = 0; base < half; base += SLOTS) {
    const vx = load<f64>(yPtr + <usize>(half + base + 0) * 8);
    const vy = load<f64>(yPtr + <usize>(half + base + 1) * 8);
    const vz = load<f64>(yPtr + <usize>(half + base + 2) * 8);
    const dqx = load<f64>(yPtr + <usize>(half + base + 3) * 8);
    const dqy = load<f64>(yPtr + <usize>(half + base + 4) * 8);
    const dqz = load<f64>(yPtr + <usize>(half + base + 5) * 8);
    const dqw = load<f64>(yPtr + <usize>(half + base + 6) * 8);
    const qx = load<f64>(yPtr + <usize>(base + 3) * 8);
    const qy = load<f64>(yPtr + <usize>(base + 4) * 8);
    const qz = load<f64>(yPtr + <usize>(base + 5) * 8);
    const qw = load<f64>(yPtr + <usize>(base + 6) * 8);

    // The coordinate derivatives: what the coordinates do, stated for the
    // methods that read this half (rk45 does; Verlet does not).
    store<f64>(dyPtr + <usize>(base + 0) * 8, vx);
    store<f64>(dyPtr + <usize>(base + 1) * 8, vy);
    store<f64>(dyPtr + <usize>(base + 2) * 8, vz);
    store<f64>(dyPtr + <usize>(base + 3) * 8, dqx);
    store<f64>(dyPtr + <usize>(base + 4) * 8, dqy);
    store<f64>(dyPtr + <usize>(base + 5) * 8, dqz);
    store<f64>(dyPtr + <usize>(base + 6) * 8, dqw);

    // The accelerations: gravity on y, and the quaternion's second derivative,
    // q'' = ½ w⊗q' with w = 2 q'⊗q* / |q|² (a pure-rotation q has q⁻¹ = q* / |q|²).
    store<f64>(dyPtr + <usize>(half + base + 0) * 8, 0.0);
    store<f64>(dyPtr + <usize>(half + base + 1) * 8, gravity_y);
    store<f64>(dyPtr + <usize>(half + base + 2) * 8, 0.0);

    const n2 = qx * qx + qy * qy + qz * qz + qw * qw;
    const d2 = dqx * dqx + dqy * dqy + dqz * dqz + dqw * dqw;
    if (n2 <= 0.0) {
      store<f64>(dyPtr + <usize>(half + base + 3) * 8, 0.0);
      store<f64>(dyPtr + <usize>(half + base + 4) * 8, 0.0);
      store<f64>(dyPtr + <usize>(half + base + 5) * 8, 0.0);
      store<f64>(dyPtr + <usize>(half + base + 6) * 8, 0.0);
      continue;
    }
    // q'' = -(|q'|² / |q|²) q. With q' = ½w⊗q the products collapse: for a unit
    // q, |q'| = ½|w| and q'' = ½w⊗q' = -¼|w|²q — a scalar multiple of q, no
    // quaternion product at all. (It is ½α⊗q + ½w⊗q' when a torque is present,
    // and the torque path applies α as an impulse in the write-back instead.)
    const c = d2 / n2;
    store<f64>(dyPtr + <usize>(half + base + 3) * 8, -c * qx);
    store<f64>(dyPtr + <usize>(half + base + 4) * 8, -c * qy);
    store<f64>(dyPtr + <usize>(half + base + 5) * 8, -c * qz);
    store<f64>(dyPtr + <usize>(half + base + 6) * 8, -c * qw);
  }
  return 0;
}

/// The naive layout, kept as the evidence that the model above is not a matter
/// of taste: the velocity half holds the angular velocity itself, and the RHS
/// returns `[v, ½w⊗q | a, 0]`. Verlet ignores the first half, so the update it
/// performs is `q += dt·w`.
export function _derivative_naive(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  derivative_calls += 1;
  if (dyCap < len) return -22;
  const half = len / 2;
  for (let base: i32 = 0; base < half; base += SLOTS) {
    const vx = load<f64>(yPtr + <usize>(half + base + 0) * 8);
    const vy = load<f64>(yPtr + <usize>(half + base + 1) * 8);
    const vz = load<f64>(yPtr + <usize>(half + base + 2) * 8);
    const wx = load<f64>(yPtr + <usize>(half + base + 3) * 8);
    const wy = load<f64>(yPtr + <usize>(half + base + 4) * 8);
    const wz = load<f64>(yPtr + <usize>(half + base + 5) * 8);
    const qx = load<f64>(yPtr + <usize>(base + 3) * 8);
    const qy = load<f64>(yPtr + <usize>(base + 4) * 8);
    const qz = load<f64>(yPtr + <usize>(base + 5) * 8);
    const qw = load<f64>(yPtr + <usize>(base + 6) * 8);
    store<f64>(dyPtr + <usize>(base + 0) * 8, vx);
    store<f64>(dyPtr + <usize>(base + 1) * 8, vy);
    store<f64>(dyPtr + <usize>(base + 2) * 8, vz);
    store<f64>(dyPtr + <usize>(base + 3) * 8, 0.5 * (wx * qw + wy * qz - wz * qy));
    store<f64>(dyPtr + <usize>(base + 4) * 8, 0.5 * (-wx * qz + wy * qw + wz * qx));
    store<f64>(dyPtr + <usize>(base + 5) * 8, 0.5 * (wx * qy - wy * qx + wz * qw));
    store<f64>(dyPtr + <usize>(base + 6) * 8, 0.5 * (-wx * qx - wy * qy - wz * qz));
    store<f64>(dyPtr + <usize>(half + base + 0) * 8, 0.0);
    store<f64>(dyPtr + <usize>(half + base + 1) * 8, gravity_y);
    store<f64>(dyPtr + <usize>(half + base + 2) * 8, 0.0);
    store<f64>(dyPtr + <usize>(half + base + 3) * 8, 0.0);
    store<f64>(dyPtr + <usize>(half + base + 4) * 8, 0.0);
    store<f64>(dyPtr + <usize>(half + base + 5) * 8, 0.0);
    store<f64>(dyPtr + <usize>(half + base + 6) * 8, 0.0);
  }
  return 0;
}

function make_solver(dim: i32, naive: bool = false): Solver | null {
  const config = new SolverConfig();
  config.method = "verlet";
  config.source = "wasm";
  config.dim = dim;
  config.fixedStep = DT;
  return Solver.create(config, {
    derivative: naive ? _derivative_naive : _derivative,
    bufIn: deriv_buf_in, bufOut: deriv_buf_out,
  });
}

// ── body parameters, the contact set, and the quaternion helpers ─────────

const MAX_BODIES: i32 = 256;
const MAX_CONTACTS: i32 = 8192;

const inv_mass = new Float64Array(MAX_BODIES);
const inv_i = new Float64Array(MAX_BODIES * 3); // diagonal inertia, per axis
const restitution = new Float64Array(MAX_BODIES);
const friction = new Float64Array(MAX_BODIES);

/// A sphere: I = (2/5) m r² about every axis.
function set_sphere(b: i32, mass: f64, r: f64): void {
  inv_mass[b] = 1.0 / mass;
  const i = 0.4 * mass * r * r;
  inv_i[b * 3 + 0] = 1.0 / i;
  inv_i[b * 3 + 1] = 1.0 / i;
  inv_i[b * 3 + 2] = 1.0 / i;
}

/// A box: I_x = m (hy² + hz²) / 3 and its cyclic twins — exact about its axes.
function set_box(b: i32, mass: f64, hx: f64, hy: f64, hz: f64): void {
  inv_mass[b] = 1.0 / mass;
  inv_i[b * 3 + 0] = 1.0 / (mass * (hy * hy + hz * hz) / 3.0);
  inv_i[b * 3 + 1] = 1.0 / (mass * (hx * hx + hz * hz) / 3.0);
  inv_i[b * 3 + 2] = 1.0 / (mass * (hx * hx + hy * hy) / 3.0);
}

/// Contacts, stride 8: body, point (3), normal (3), penetration.
const contacts = new Float64Array(MAX_CONTACTS * 8);
let contact_count: i32 = 0;

function add_contact(b: i32, px: f64, py: f64, pz: f64,
                     nx: f64, ny: f64, nz: f64, pen: f64): void {
  if (contact_count >= MAX_CONTACTS) return;
  const at = contact_count * 8;
  contacts[at + 0] = <f64>b;
  contacts[at + 1] = px;
  contacts[at + 2] = py;
  contacts[at + 3] = pz;
  contacts[at + 4] = nx;
  contacts[at + 5] = ny;
  contacts[at + 6] = nz;
  contacts[at + 7] = pen;
  contact_count += 1;
}

let rot_x: f64 = 0.0, rot_y: f64 = 0.0, rot_z: f64 = 0.0;

/// Rotate a local vector by a quaternion: v' = v + 2 q_w (q_v × v) + 2 q_v × (q_v × v).
function rotate_by_quat(qx: f64, qy: f64, qz: f64, qw: f64,
                        vx: f64, vy: f64, vz: f64): void {
  const tx = 2.0 * (qy * vz - qz * vy);
  const ty = 2.0 * (qz * vx - qx * vz);
  const tz = 2.0 * (qx * vy - qy * vx);
  rot_x = vx + qw * tx + (qy * tz - qz * ty);
  rot_y = vy + qw * ty + (qz * tx - qx * tz);
  rot_z = vz + qw * tz + (qx * ty - qy * tx);
}

function quat_norm(x: f64, y: f64, z: f64, w: f64): f64 {
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

/// The rotation a quaternion represents, normalized first: what a viewer sees.
function quat_angle(x: f64, y: f64, z: f64, w: f64): f64 {
  const n = quat_norm(x, y, z, w);
  if (n <= 0.0) return 0.0;
  const s = Math.sqrt(x * x + y * y + z * z) / n;
  return 2.0 * Math.atan2(s, w / n);
}

function normalize_quat(state: Float64Array, b: i32): void {
  const at = b * SLOTS;
  const n = quat_norm(state[at + 3], state[at + 4], state[at + 5], state[at + 6]);
  if (n <= 0.0) return;
  state[at + 3] /= n;
  state[at + 4] /= n;
  state[at + 5] /= n;
  state[at + 6] /= n;
}

/// Recover w = 2 q'⊗q⁻¹ from the state's own pair. The impulse code works in
/// the angular-velocity domain; the state carries q'.
function recover_omega(state: Float64Array, om: Float64Array, b: i32): void {
  const at = b * SLOTS, half = state.length / 2;
  const qx = state[at + 3], qy = state[at + 4], qz = state[at + 5], qw = state[at + 6];
  const dx = state[half + at + 3], dy = state[half + at + 4];
  const dz = state[half + at + 5], dw = state[half + at + 6];
  const n2 = qx * qx + qy * qy + qz * qz + qw * qw;
  if (n2 <= 0.0) {
    om[b * 3 + 0] = 0.0; om[b * 3 + 1] = 0.0; om[b * 3 + 2] = 0.0;
    return;
  }
  const px = -dw * qx + dx * qw - dy * qz + dz * qy;
  const py = -dw * qy + dx * qz + dy * qw - dz * qx;
  const pz = -dw * qz - dx * qy + dy * qx + dz * qw;
  const s = 2.0 / n2;
  om[b * 3 + 0] = s * px;
  om[b * 3 + 1] = s * py;
  om[b * 3 + 2] = s * pz;
}

/// Write the pair back consistently: a unit quaternion, and q' = ½ w⊗q. This is
/// the model's write path — the angular counterpart of chunk 6's plain
/// `set_state` — and Q3 measures what it costs in fidelity.
function canonicalize(state: Float64Array, om: Float64Array, b: i32): void {
  const at = b * SLOTS, half = state.length / 2;
  normalize_quat(state, b);
  const qx = state[at + 3], qy = state[at + 4], qz = state[at + 5], qw = state[at + 6];
  const wx = om[b * 3 + 0], wy = om[b * 3 + 1], wz = om[b * 3 + 2];
  // The formulas are the (w, x, y, z) components of w⊗q; the slots are x, y, z, w.
  state[half + at + 3] = 0.5 * (wx * qw + wy * qz - wz * qy);   // x
  state[half + at + 4] = 0.5 * (-wx * qz + wy * qw + wz * qx);  // y
  state[half + at + 5] = 0.5 * (wx * qy - wy * qx + wz * qw);   // z
  state[half + at + 6] = 0.5 * (-wx * qx - wy * qy - wz * qz);  // w
}

/// The four floor contacts of a box: its corners, rotated by the body's
/// orientation. A corner at or below y = 0 is a contact, so a box that has
/// tipped reports the corners that are actually down.
function box_floor_contacts(state: Float64Array, b: i32, hx: f64, hy: f64, hz: f64): void {
  const at = b * SLOTS;
  const qx = state[at + 3], qy = state[at + 4], qz = state[at + 5], qw = state[at + 6];
  const cx = state[at + 0], cy = state[at + 1], cz = state[at + 2];
  for (let c: i32 = 0; c < 4; c++) {
    const lx = (c & 1) == 0 ? -hx : hx;
    const lz = (c & 2) == 0 ? -hz : hz;
    rotate_by_quat(qx, qy, qz, qw, lx, -hy, lz);
    const py = cy + rot_y;
    if (py < 0.0) add_contact(b, cx + rot_x, py, cz + rot_z, 0.0, 1.0, 0.0, -py);
  }
}

function sphere_floor_contact(state: Float64Array, b: i32, r: f64): void {
  const at = b * SLOTS;
  const cy = state[at + 1];
  add_contact(b, state[at + 0], cy - r, state[at + 2], 0.0, 1.0, 0.0, r - cy);
}

/// One impulse pass: a normal impulse with restitution, a Coulomb-clamped
/// friction impulse, and the positional bias.
///
/// `bias_through_impulse` is Q4's experiment: `false` is the rule (the bias is a
/// linear-only velocity change), `true` is the failure the rule exists to avoid
/// (the bias folds into `desired`, so into `j_n`, and is applied at the contact
/// point — a torque with no force behind it). Linear impulses go straight into
/// the state; angular ones accumulate in `om`, which `canonicalize` writes back.
///
/// `jacobi` is Q5's: with it, every contact's normal impulse is computed against
/// the *pre-pass* velocities and they are applied together; without it, each
/// contact is solved against a state the previous one has already changed. For a
/// symmetric contact set — a box resting on four corners — the sequel is the
/// whole story, and Q5 measures both.

/** The contact under the cursor, loaded once per contact. */
let c_b: i32 = 0;
let c_nx: f64 = 0.0, c_ny: f64 = 0.0, c_nz: f64 = 0.0;
let c_rx: f64 = 0.0, c_ry: f64 = 0.0, c_rz: f64 = 0.0;
let c_pen: f64 = 0.0;
let c_vnx: f64 = 0.0, c_vny: f64 = 0.0, c_vnz: f64 = 0.0; // the normal-direction velocity

const vsnap = new Float64Array(MAX_BODIES * 3);
const jn_table = new Float64Array(MAX_CONTACTS);

/// Load contact `c`, taking the linear velocity from `state` (live) or from the
/// Jacobi snapshot — `snap` is -1 for live, otherwise the body index block to read.
function contact_load(state: Float64Array, om: Float64Array, c: i32, snap: bool): void {
  const at = c * 8;
  const half = state.length / 2;
  c_b = <i32>contacts[at + 0];
  const px = contacts[at + 1], py = contacts[at + 2], pz = contacts[at + 3];
  c_nx = contacts[at + 4]; c_ny = contacts[at + 5]; c_nz = contacts[at + 6];
  c_pen = contacts[at + 7];
  const cb = c_b * SLOTS, vb = half + c_b * SLOTS;
  c_rx = px - state[cb + 0];
  c_ry = py - state[cb + 1];
  c_rz = pz - state[cb + 2];
  let vx = state[vb + 0], vy = state[vb + 1], vz = state[vb + 2];
  if (snap) {
    vx = vsnap[c_b * 3 + 0]; vy = vsnap[c_b * 3 + 1]; vz = vsnap[c_b * 3 + 2];
  }
  const wx = om[c_b * 3 + 0], wy = om[c_b * 3 + 1], wz = om[c_b * 3 + 2];
  // The contact point's velocity: v + w × r.
  c_vnx = vx + (wy * c_rz - wz * c_ry);
  c_vny = vy + (wz * c_rx - wx * c_rz);
  c_vnz = vz + (wx * c_ry - wy * c_rx);
}

/// The normal impulse this contact wants, from the loaded velocity.
function contact_jn(om: Float64Array, dt: f64, beta: f64, folded: bool): f64 {
  const vn = c_vnx * c_nx + c_vny * c_ny + c_vnz * c_nz;
  let bias = beta * c_pen / dt;
  if (bias > BIAS_CAP) bias = BIAS_CAP;
  let desired = Math.max(0.0, -restitution[c_b] * vn);
  if (folded && c_pen > SLOP) desired = Math.max(desired, bias);
  const b = c_b;
  const rnx = c_ry * c_nz - c_rz * c_ny, rny = c_rz * c_nx - c_rx * c_nz,
        rnz = c_rx * c_ny - c_ry * c_nx;
  const t1x = inv_i[b * 3 + 1] * rny * c_rz - inv_i[b * 3 + 2] * rnz * c_ry;
  const t1y = inv_i[b * 3 + 2] * rnz * c_rx - inv_i[b * 3 + 0] * rnx * c_rz;
  const t1z = inv_i[b * 3 + 0] * rnx * c_ry - inv_i[b * 3 + 1] * rny * c_rx;
  const kn = inv_mass[b] + (c_nx * t1x + c_ny * t1y + c_nz * t1z);
  let jn = (desired - vn) / kn;
  if (jn < 0.0) jn = 0.0; // contacts push, they do not pull
  return jn;
}

/// Apply one contact: the normal impulse, then friction from the state the
/// normal impulse produced, then the bias (linear only, unless Q4 folds it in).
function contact_apply(state: Float64Array, om: Float64Array, dt: f64, beta: f64,
                       folded: bool, jn: f64): void {
  const b = c_b;
  const half = state.length / 2;
  const vb = half + b * SLOTS;
  if (jn > 0.0) {
    state[vb + 0] += inv_mass[b] * jn * c_nx;
    state[vb + 1] += inv_mass[b] * jn * c_ny;
    state[vb + 2] += inv_mass[b] * jn * c_nz;
    om[b * 3 + 0] += inv_i[b * 3 + 0] * (c_ry * (jn * c_nz) - c_rz * (jn * c_ny));
    om[b * 3 + 1] += inv_i[b * 3 + 1] * (c_rz * (jn * c_nx) - c_rx * (jn * c_nz));
    om[b * 3 + 2] += inv_i[b * 3 + 2] * (c_rx * (jn * c_ny) - c_ry * (jn * c_nx));

    const wx = om[b * 3 + 0], wy = om[b * 3 + 1], wz = om[b * 3 + 2];
    const vx = state[vb + 0], vy = state[vb + 1], vz = state[vb + 2];
    const vpx = vx + (wy * c_rz - wz * c_ry);
    const vpy = vy + (wz * c_rx - wx * c_rz);
    const vpz = vz + (wx * c_ry - wy * c_rx);
    const vnn = vpx * c_nx + vpy * c_ny + vpz * c_nz;
    const tvx = vpx - vnn * c_nx, tvy = vpy - vnn * c_ny, tvz = vpz - vnn * c_nz;
    const tl = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
    if (tl > 1.0e-12) {
      const tx = tvx / tl, ty = tvy / tl, tz = tvz / tl;
      const rtx = c_ry * tz - c_rz * ty, rty = c_rz * tx - c_rx * tz, rtz = c_rx * ty - c_ry * tx;
      const t2x = inv_i[b * 3 + 1] * rty * c_rz - inv_i[b * 3 + 2] * rtz * c_ry;
      const t2y = inv_i[b * 3 + 2] * rtz * c_rx - inv_i[b * 3 + 0] * rtx * c_rz;
      const t2z = inv_i[b * 3 + 0] * rtx * c_ry - inv_i[b * 3 + 1] * rty * c_rx;
      const kt = inv_mass[b] + (tx * t2x + ty * t2y + tz * t2z);
      let jt = -tl / kt;
      const limit = friction[b] * jn;
      if (jt < -limit) jt = -limit;
      state[vb + 0] += inv_mass[b] * jt * tx;
      state[vb + 1] += inv_mass[b] * jt * ty;
      state[vb + 2] += inv_mass[b] * jt * tz;
      om[b * 3 + 0] += inv_i[b * 3 + 0] * (c_ry * (jt * tz) - c_rz * (jt * ty));
      om[b * 3 + 1] += inv_i[b * 3 + 1] * (c_rz * (jt * tx) - c_rx * (jt * tz));
      om[b * 3 + 2] += inv_i[b * 3 + 2] * (c_rx * (jt * ty) - c_ry * (jt * tx));
    }
  }
  if (!folded && c_pen > SLOP) {
    // The rule: the correction moves the body, it does not spin it.
    let bias = beta * c_pen / dt;
    if (bias > BIAS_CAP) bias = BIAS_CAP;
    state[vb + 0] += bias * c_nx;
    state[vb + 1] += bias * c_ny;
    state[vb + 2] += bias * c_nz;
  }
}

function resolve_angular(state: Float64Array, om: Float64Array, bodies: i32, dt: f64,
                         beta: f64, bias_through_impulse: bool, jacobi: bool = false): void {
  for (let b: i32 = 0; b < bodies; b++) recover_omega(state, om, b);
  if (!jacobi) {
    for (let c: i32 = 0; c < contact_count; c++) {
      contact_load(state, om, c, false);
      contact_apply(state, om, dt, beta, bias_through_impulse, contact_jn(om, dt, beta, bias_through_impulse));
    }
    return;
  }
  // Jacobi: snapshot the linear velocities, solve every contact against that
  // snapshot, then apply. The angular velocities need no snapshot: they are only
  // written in the apply phase, which runs after every jn is known.
  const half = state.length / 2;
  for (let b: i32 = 0; b < bodies; b++) {
    vsnap[b * 3 + 0] = state[half + b * SLOTS + 0];
    vsnap[b * 3 + 1] = state[half + b * SLOTS + 1];
    vsnap[b * 3 + 2] = state[half + b * SLOTS + 2];
  }
  for (let c: i32 = 0; c < contact_count; c++) {
    contact_load(state, om, c, true);
    jn_table[c] = contact_jn(om, dt, beta, bias_through_impulse);
  }
  for (let c: i32 = 0; c < contact_count; c++) {
    contact_load(state, om, c, false); // for the geometry and the bias
    contact_apply(state, om, dt, beta, bias_through_impulse, jn_table[c]);
  }
}

function copy_in(state: Float64Array, buf: Float64Array, dim: i32): void {
  for (let i = 0; i < dim; i++) state[i] = buf[i + 1];
}

function speed_of(state: Float64Array, b: i32): f64 {
  const vb = state.length / 2 + b * SLOTS;
  return Math.sqrt(state[vb] * state[vb] + state[vb + 1] * state[vb + 1] +
                   state[vb + 2] * state[vb + 2]);
}

function omega_length(om: Float64Array, b: i32): f64 {
  return Math.sqrt(om[b * 3] * om[b * 3] + om[b * 3 + 1] * om[b * 3 + 1] +
                   om[b * 3 + 2] * om[b * 3 + 2]);
}

// ── Q1: does Verlet accept dim = 14N? ────────────────────────────────────

function q1_acceptance(): void {
  const n: i32 = 16;
  const dim = n * 14;
  const solver = make_solver(dim);
  print("Q1 create(method=verlet, source=wasm, dim=" + dim.toString() + ", N=" +
        n.toString() + ", 7+7 slots/body) -> " +
        (solver == null ? "refused (null)" : "a solver id"));
  if (solver != null) {
    const y = new Float64Array(dim);
    for (let b: i32 = 0; b < n; b++) y[b * SLOTS + 6] = 1.0; // unit quaternions
    solver.setState(0.0, y);
    const rc = solver.step(DT);
    print("Q1 step(dt=1/60) -> " + rc.toString() + " (0 is acceptance; " +
          derivative_calls.toString() + " derivative calls so far)");
    solver.destroy();
  }

  // The control: 7 + 6 is not a legal split, so an odd dim must be refused —
  // and the interesting part is *where*. The workspace-size query is happy with
  // any dim >= 2 (its comment says evenness is the step's business), so create
  // accepts it and only the step refuses.
  const odd = make_solver(7);
  print("Q1 control create(dim=7) -> " +
        (odd == null ? "refused (null)" : "accepted (the size query does not check evenness)"));
  if (odd != null) {
    const y = new Float64Array(7);
    odd.setState(0.0, y);
    print("Q1 control step(dim=7) -> " + odd.step(DT).toString() +
          " (-1 is a refusal — the evenness check lives in the step, and the " +
          "session log names -EINVAL)");
    odd.destroy();
  }
}

// ── Q3: the state-write experiment, quaternion edition ───────────────────
//
// One body spinning about y at 1 rad/s with no contacts and no gravity: after
// 60 steps of 1/60 s the rotation is 1 rad. Four runs — untouched, written back
// verbatim, written back with the canonicalization, and the naive layout —
// separate "the write path is faithful" from "the canonicalization changes the
// trajectory" from "the layout is wrong".

const Q3_FRAMES: i32 = 60;
let q3_norm: f64 = 0.0;
let q3_omega: f64 = 0.0;

function q3_run(mode: i32): f64 {
  gravity_y = 0.0;
  const dim = 14;
  const naive = mode == 3;
  const solver = make_solver(dim, naive);
  if (solver == null) return -1.0;
  const y = new Float64Array(dim);
  const buf = new Float64Array(dim + 1);
  const om = new Float64Array(MAX_BODIES * 3);
  y[6] = 1.0; // qw
  if (naive) {
    y[7 + 4] = 1.0; // the naive layout: the velocity half holds w = (0, 1, 0)
  } else {
    y[7 + 3 + 1] = 0.5; // q' = ½ w⊗q, w = (0, 1, 0), q = identity → q'y = 0.5
  }
  if (solver!.setState(0.0, y) != 0) return -1.0;

  for (let frame: i32 = 0; frame < Q3_FRAMES; frame++) {
    if (solver!.step(DT) != 0) return -1.0;
    if (mode == 0) continue; // untouched
    if (solver!.state(buf) < 0) return -1.0;
    copy_in(y, buf, dim);
    if (mode == 2) {
      recover_omega(y, om, 0);
      canonicalize(y, om, 0);
    }
    if (solver!.setState(buf[0], y) != 0) return -1.0;
  }
  if (mode == 0) {
    if (solver!.state(buf) < 0) return -1.0;
    copy_in(y, buf, dim);
  }
  q3_norm = quat_norm(y[3], y[4], y[5], y[6]);
  recover_omega(y, om, 0);
  q3_omega = omega_length(om, 0);
  const angle = quat_angle(y[3], y[4], y[5], y[6]);
  solver!.destroy();
  return angle;
}

function q3_state_write(): void {
  const untouched = q3_run(0);
  const u_norm = q3_norm, u_omega = q3_omega;
  const written = q3_run(1);
  const w_norm = q3_norm;
  const canon = q3_run(2);
  const c_norm = q3_norm;
  const naive = q3_run(3);
  const n_norm = q3_norm;
  print("Q3 spin about y at 1 rad/s, " + Q3_FRAMES.toString() +
        " steps of 1/60 s; the rotation should be 1.0 rad");
  print("Q3 untouched       angle " + untouched.toString() + " rad, |q| " +
        u_norm.toString() + ", |w| " + u_omega.toString() + " rad/s");
  print("Q3 written         angle " + written.toString() + " rad, |q| " + w_norm.toString());
  print("Q3 canonicalized   angle " + canon.toString() + " rad, |q| " + c_norm.toString());
  print("Q3 |written - untouched| / 1.0 rad = " +
        (abs(written - untouched) * 100.0).toString() + " %");
  print("Q3 |canonicalized - untouched| / 1.0 rad = " +
        (abs(canon - untouched) * 100.0).toString() + " %");
  print("Q3 the naive layout (second half = w, RHS first half = ½w⊗q): angle " +
        naive.toString() + " rad, |q| " + n_norm.toString() +
        " — Verlet never reads the RHS's first half, so this is q += dt·w");
}

// ── Q4: does the positional bias spin a resting body? ────────────────────
//
// Gravity is off and the box is held at a fixed penetration, so the impulse is
// zero in this configuration and only the bias is left. Under the rule the body
// gains no angular velocity at all; with the bias folded into the impulse it
// gains one every sub-step. The linear state is re-placed each frame (position
// and linear velocity reset, orientation and spin kept) because what is being
// measured is the spin the bias produces, not the trajectory.

const Q4_FRAMES: i32 = 300;

function q4_bias_run(bias_through_impulse: bool): f64 {
  gravity_y = 0.0;
  const dim = 14;
  const solver = make_solver(dim);
  if (solver == null) return -1.0;
  const y = new Float64Array(dim);
  const buf = new Float64Array(dim + 1);
  const om = new Float64Array(MAX_BODIES * 3);
  set_box(0, 1.0, 0.5, 0.5, 0.5);
  restitution[0] = 0.0;
  friction[0] = 0.4;
  const y0 = 0.5 - 0.002;
  y[1] = y0;
  y[6] = 1.0;
  if (solver!.setState(0.0, y) != 0) return -1.0;

  const h = DT / <f64>SUBSTEPS;
  for (let frame: i32 = 0; frame < Q4_FRAMES; frame++) {
    for (let k: i32 = 0; k < SUBSTEPS; k++) {
      if (solver!.step(h) != 0) return -1.0;
      if (solver!.state(buf) < 0) return -1.0;
      copy_in(y, buf, dim);
      // Hold the geometry: the linear half is reset, the angular half is not.
      y[0] = 0.0; y[1] = y0; y[2] = 0.0;
      y[7 + 0] = 0.0; y[7 + 1] = 0.0; y[7 + 2] = 0.0;
      contact_count = 0;
      box_floor_contacts(y, 0, 0.5, 0.5, 0.5);
      resolve_angular(y, om, 1, h, BETA, bias_through_impulse);
      canonicalize(y, om, 0);
      if (solver!.setState(buf[0], y) != 0) return -1.0;
    }
  }
  const angle = quat_angle(y[3], y[4], y[5], y[6]);
  solver!.destroy();
  return angle;
}

function q4_bias(): void {
  const rule = q4_bias_run(false);
  const folded = q4_bias_run(true);
  print("Q4 resting box corner, 2 mm penetration, no gravity, zero relative velocity, " +
        Q4_FRAMES.toString() + " frames, K=" + SUBSTEPS.toString());
  print("Q4 bias as a linear-only velocity change (the rule): rotation " +
        rule.toString() + " rad");
  print("Q4 bias folded into the normal impulse (the failure): rotation " +
        folded.toString() + " rad (" + (folded * 180.0 / Math.PI).toString() + " deg)");
}

// ── Q5: terminal behaviour of a resting box ──────────────────────────────

const Q5_FRAMES: i32 = 600;

function q5_resting_box(passes: i32, jacobi: bool, mu: f64): void {
  gravity_y = G;
  const dim = 14;
  const solver = make_solver(dim);
  if (solver == null) { print("Q5 create refused"); return; }
  const y = new Float64Array(dim);
  const buf = new Float64Array(dim + 1);
  const om = new Float64Array(MAX_BODIES * 3);
  set_box(0, 1.0, 0.5, 0.5, 0.5);
  restitution[0] = 0.0;
  friction[0] = mu;
  const y0 = 0.5 - 0.002;
  y[1] = y0;
  y[6] = 1.0;
  if (solver!.setState(0.0, y) != 0) return;

  const i_axis = 1.0 / 6.0; // m (hy² + hz²) / 3 for the 1 kg, 1 m box
  const e0 = 1.0 * 9.81 * y0; // ½m|v|² + ½w·Iw + m g y at rest, spin 0
  let max_w = 0.0, max_drift = 0.0, max_angle = 0.0;
  let e_min = e0, e_max = e0;
  const h = DT / <f64>SUBSTEPS;
  for (let frame: i32 = 0; frame < Q5_FRAMES; frame++) {
    for (let k: i32 = 0; k < SUBSTEPS; k++) {
      if (solver!.step(h) != 0) { print("Q5 step refused"); return; }
      if (solver!.state(buf) < 0) return;
      copy_in(y, buf, dim);
      contact_count = 0;
      box_floor_contacts(y, 0, 0.5, 0.5, 0.5);
      for (let p: i32 = 0; p < passes; p++) resolve_angular(y, om, 1, h, BETA, false, jacobi);
      canonicalize(y, om, 0);
      if (solver!.setState(buf[0], y) != 0) return;
    }
    const wl = omega_length(om, 0);
    if (wl > max_w) max_w = wl;
    const vl = speed_of(y, 0);
    const drift = Math.sqrt(y[0] * y[0] + (y[1] - y0) * (y[1] - y0) + y[2] * y[2]);
    if (drift > max_drift) max_drift = drift;
    const angle = quat_angle(y[3], y[4], y[5], y[6]);
    if (angle > max_angle) max_angle = angle;
    const e = 0.5 * 1.0 * vl * vl + 0.5 * i_axis * wl * wl + 1.0 * 9.81 * y[1];
    if (e < e_min) e_min = e;
    if (e > e_max) e_max = e;
  }
  const wl = omega_length(om, 0), vl = speed_of(y, 0);
  const e_final = 0.5 * 1.0 * vl * vl + 0.5 * i_axis * wl * wl + 1.0 * 9.81 * y[1];
  print("Q5 resting box, " + Q5_FRAMES.toString() + " frames, K=" + SUBSTEPS.toString() +
        " sub-steps, " + passes.toString() + " impulse pass(es), mu=" + mu.toString() + ", " +
        (jacobi ? "Jacobi (all normals solved against the pre-pass state)"
                : "sequential (each contact sees the previous one's result)"));
  print("Q5 |w|: max over the run " + max_w.toString() + " rad/s, at frame " +
        Q5_FRAMES.toString() + " " + wl.toString() + " rad/s");
  print("Q5 |v| at frame " + Q5_FRAMES.toString() + " " + vl.toString() +
        " m/s; position drift max " + max_drift.toString() + " m; rotation max " +
        max_angle.toString() + " rad");
  print("Q5 energy: E0 " + e0.toString() + ", range [" + e_min.toString() + ", " +
        e_max.toString() + "], final " + e_final.toString() + " (drift " +
        ((e_final - e0) / abs(e0) * 100.0).toString() + " %)");
  solver!.destroy();
}

// ── Q6: rolling, measured ────────────────────────────────────────────────

const Q6_FRAMES: i32 = 60;

function q6_rolling(angular: bool): void {
  gravity_y = G;
  const dim = 14;
  const solver = make_solver(dim);
  if (solver == null) return;
  const r = 0.1;
  const y = new Float64Array(dim);
  const buf = new Float64Array(dim + 1);
  const om = new Float64Array(MAX_BODIES * 3);
  set_sphere(0, 1.0, r);
  if (!angular) {
    inv_i[0] = 0.0; inv_i[1] = 0.0; inv_i[2] = 0.0; // the linear model: no torque
  }
  restitution[0] = 0.0;
  friction[0] = 0.4;
  y[1] = r;
  y[6] = 1.0;
  y[7 + 0] = 1.0; // v = 1 m/s along +x
  if (solver!.setState(0.0, y) != 0) return;

  const v0 = 1.0;
  let converge_frame: i32 = -1;
  const h = DT / <f64>SUBSTEPS;
  for (let frame: i32 = 0; frame < Q6_FRAMES; frame++) {
    for (let k: i32 = 0; k < SUBSTEPS; k++) {
      if (solver!.step(h) != 0) return;
      if (solver!.state(buf) < 0) return;
      copy_in(y, buf, dim);
      contact_count = 0;
      sphere_floor_contact(y, 0, r);
      resolve_angular(y, om, 1, h, BETA, false);
      canonicalize(y, om, 0);
      if (solver!.setState(buf[0], y) != 0) return;
    }
    const v = speed_of(y, 0);
    // Rolling without slipping: w r = -v (the contact point is below the centre)
    if (converge_frame < 0 && abs(-om[2] * r - v) < 0.05 * v0) converge_frame = frame;
  }
  const v = speed_of(y, 0);
  const angle = quat_angle(y[3], y[4], y[5], y[6]);
  print("Q6 " + (angular ? "angular model" : "linear control (I⁻¹ = 0)") + ": v0 = " +
        v0.toString() + " m/s, mu = 0.4, e = 0, r = " + r.toString() +
        " m, " + Q6_FRAMES.toString() + " frames");
  print("Q6 after " + Q6_FRAMES.toString() + " frames: v " + v.toString() +
        " (v/v0 " + (v / v0).toString() + ", the sliding-sphere closed form is 5/7 = " +
        (5.0 / 7.0).toString() + "), wz " + om[2].toString() + " rad/s (w r / v " +
        (-om[2] * r / v).toString() + ")");
  print("Q6 rolling within 5 % first at frame " + converge_frame.toString() +
        "; accumulated rotation " + angle.toString() + " rad (" +
        (angle * 180.0 / Math.PI).toString() + " deg)");
  contact_count = 0;
  solver!.destroy();
}

// ── the guest's per-frame cost at N = 256, in renderer frames ────────────

function angular_frame_cost(count: i32, repeats: i32): void {
  gravity_y = 0.0; // the cost loop wants a stable configuration, not a fall
  const dim = count * 14;
  const solver = make_solver(dim);
  if (solver == null) return;
  const y = new Float64Array(dim);
  const buf = new Float64Array(dim + 1);
  const om = new Float64Array(MAX_BODIES * 3);
  const spacing = 0.12; // closer than a diameter: a dense contact set, not an ideal gas
  const columns = 16;
  for (let b: i32 = 0; b < count; b++) {
    y[b * SLOTS + 0] = <f64>(b % columns) * spacing;
    y[b * SLOTS + 1] = 1.0 + <f64>(b / columns) * spacing;
    y[b * SLOTS + 6] = 1.0;
  }
  for (let b: i32 = 0; b < MAX_BODIES; b++) set_sphere(b, 1.0, 0.1);
  for (let b: i32 = 0; b < MAX_BODIES; b++) { friction[b] = 0.4; restitution[b] = 0.0; }
  solver!.setState(0.0, y);

  const h = DT / <f64>SUBSTEPS;
  const before = ogre.frameCount();
  for (let r: i32 = 0; r < repeats; r++) {
    for (let k: i32 = 0; k < SUBSTEPS; k++) {
      solver!.step(h);
      solver!.state(buf);
      copy_in(y, buf, dim);
      contact_count = 0;
      for (let a: i32 = 0; a < count; a++) {
        for (let b: i32 = a + 1; b < count; b++) {
          const dx = y[b * SLOTS + 0] - y[a * SLOTS + 0];
          const dy = y[b * SLOTS + 1] - y[a * SLOTS + 1];
          const dz = y[b * SLOTS + 2] - y[a * SLOTS + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 0.04 && d2 > 1.0e-12) {
            // Two contacts per pair, one per body, along the centre line — the
            // one-body-per-contact form the sphere-sphere case needs.
            const d = Math.sqrt(d2);
            const ux = dx / d, uy = dy / d, uz = dz / d;
            const pen = 0.2 - d;
            add_contact(a, y[a * SLOTS + 0] + 0.1 * ux, y[a * SLOTS + 1] + 0.1 * uy,
                        y[a * SLOTS + 2] + 0.1 * uz, -ux, -uy, -uz, pen);
            add_contact(b, y[b * SLOTS + 0] - 0.1 * ux, y[b * SLOTS + 1] - 0.1 * uy,
                        y[b * SLOTS + 2] - 0.1 * uz, ux, uy, uz, pen);
          }
        }
      }
      resolve_angular(y, om, count, h, 0.0, false);
      for (let b: i32 = 0; b < count; b++) canonicalize(y, om, b);
      solver!.setState(buf[0], y);
    }
  }
  RuntimeSession.wait(16);
  const frames = <i32>(ogre.frameCount() - before);
  print("Q7 guest cost N=" + count.toString() + " angular, K=" + SUBSTEPS.toString() +
        ", " + repeats.toString() + " frames: " +
        (<f64>frames * (1000.0 / 60.0) / <f64>repeats).toString() +
        " ms/frame (step + state + brute-force detect + full resolve + write, " +
        contact_count.toString() + " contacts in the last sub-step)");
  solver!.destroy();
}

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("FAIL session_open refused");
    assert(false, "session_open");
  }
  const config = new ogre.ConfigBuilder()
    .renderer(renderer == "gl3plus" ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  if (ogre.init(config) != 0) {
    print("FAIL ogre::init refused (the frame counter is this probe's clock)");
    assert(false, "ogre::init");
  }
  print("ANGULAR probe (8a): renderer=" + renderer + ", frameHz 60, guest-side");
  print("ANGULAR layout: [x, y, z, qx, qy, qz, qw | vx, vy, vz, q'x, q'y, q'z, q'w], " +
        "q' = ½ w⊗q, dim = 14N");

  q1_acceptance();
  print("Q2 the C-level step cost is probe_physics.cpp's (dim = 14N beside dim = 6N)");
  q3_state_write();
  q4_bias();
  q5_resting_box(1, false, 0.4);
  q5_resting_box(2, false, 0.4);
  q5_resting_box(1, true, 0.4);
  q5_resting_box(1, false, 0.0);
  q6_rolling(true);
  q6_rolling(false);
  angular_frame_cost(64, 200);
  angular_frame_cost(256, 100);

  ogre.shutdown();
  RuntimeSession.close();
  print("OK 8a probe complete");
}
