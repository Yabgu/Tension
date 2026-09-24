// A physics layer for guests: N rigid bodies in one solver, contacts resolved
// between steps.
//
// What this is: a small, honest model — **spheres and axis-aligned planes, one
// impulse pass per contact, a positional bias instead of iteration** — sized for
// a box of bodies that collide with each other and with the floor. What it is
// not, and will not quietly become:
//
//   * no integrator: the solver capability owns that, and this layer only asks
//     it to advance. Verlet is the method it wants (`method: "verlet"`,
//     `tension-solver/DESIGN.md` §10): fixed-step, so every impulse lands on a
//     step boundary; symplectic; two derivative evaluations per step.
//   * no iteration and no stacking: one pass per contact, resolved
//     independently. Tall stacks sink and jitter, which is why sleeping is on
//     the future-work list rather than in here.
//   * no joints, no continuous collision detection, no angular dynamics, no
//     sleeping, and no broad phase beyond the brute-force pair loop — which
//     measured 1.17 ms per pass at N = 256 and 18.3 ms at 1024, and is
//     therefore fine where the state's size cap puts the ceiling anyway.
//
// **The state layout is the solver's, and it is not interleaved.** Verlet's
// `[q, v]` at system scale is every body's position, then every body's velocity:
//
//     [x0,y0,z0, x1,y1,z1, ..., xN-1,yN-1,zN-1,  vx0,vy0,vz0, ..., vzN-1]
//     \______________ 3N f64 ______________/   \______ 3N f64 ______/
//
// Reading that as per-body records — `[x,y,z,vx,vy,vz]` one after another —
// produces bodies that move at nonsense speeds, and the mistake is silent
// because every index a reader computes is still a valid index. Chunk 6a's
// probe made exactly this mistake and measured a body at 225 m/s. `Body` below
// is the only place in this file that writes the layout down.
//
// **The angular model writes the same rule at a longer stride: seven slots per
// body per half, fourteen per body.**
//
//     [x0,y0,z0,q0x,q0y,q0z,q0w, x1,...,q1w, ...,  v0x,v0y,v0z,q'0x,...,q'0w, ...]
//     \_______ 7N f64: every body's coordinates ______/  \____ 7N: every body's derivatives ____/
//
// The first half is positions and orientations, the second half velocities and
// **quaternion derivatives**, with `q' = ½ω⊗q` — the derivative, *not* the
// angular velocity. That is not a matter of taste: the symplectic Verlet updates
// a coordinate as `coord += dt · (the state's second half)`, so the second half
// has to be the coordinate's time derivative. A layout that puts `ω` there
// integrates `q += dt·ω`, which is not a rotation at all — chunk 8a measured
// 1.5708 rad and |q| = 1.41421 for a body spinning at 1 rad/s for one second,
// and the RHS it ignored looked perfectly correct. `ω = 2q'⊗q⁻¹` recovers the
// angular velocity whenever the response needs it, which is why nothing has to
// live outside the state.
//
// The cadence is the other half of the design: `step(dt)` runs `substeps`
// sub-steps, and each sub-step is advance → read → detect → resolve → write.
// Writing back between sub-steps is what `set_state` is for, and it was measured
// to be free of perturbation (a body thrown upward reached the same apex to
// 0.0 % with and without a write between every step).
//
// **Sleeping is a numerical and visual feature, not a performance
// optimization.** A body that has been below the sleep threshold long enough
// stops being integrated and stops being moved: its velocity is zeroed and the
// derivative writes zeros for it, so the pile holds its positions bit-for-bit
// and the frame stops changing.
//
// **Rolling resistance is a contact-only spin decay, and its gate is a
// *candidate*, not a resolved contact.** `ω ← ω · max(0, 1 − k·h)` per sub-step,
// angular model only, for any body that had a contact *candidate* this sub-step.
// The distinction is the whole reason it works: the impulse path deliberately
// ignores contacts inside the slop, and a body at rest settles at a penetration
// inside it — so a decay keyed on *resolved* contacts reaches a resting body in
// only ~23 % of sub-steps, while one keyed on candidates reaches it in 92–100 %
// (measured, chunk 9a-i). The gate is one byte per body, set by the same loop
// that generates the contacts (`Contacts`' generators), and it changes no
// impulse. Two more properties are load-bearing and measured: the term is **pure
// angular** — a torque cannot move a body's centre, which is what keeps it out
// of the displacement-based sleep signal — and it has **no stop threshold**: a
// rule that stopped the decay below the sleep threshold parks a body *on* the
// threshold and it never sleeps, and a term that only removes motion cannot keep
// anything awake in the first place. A rolling pair decays at `I/(I + m r²)` of
// the coefficient, because friction re-couples the spin to the linear momentum
// the term cannot touch — 2/7 of it for a solid sphere.
//
// **The angular model gets a second signal, because a body spinning in place
// displaces nothing.** The decision is linear displacement per frame *and*
// angular displacement per frame, both averaged over the same window — and the
// angular signal is a *displacement* rather than a `|ω|` for exactly the reason
// chunk 7 chose displacement over velocity: raw angular velocity carries the
// bias the response last pushed the body out by, while the angle between two
// frames is what "has this body stopped turning?" actually means. Without it a
// free body spun at 1 rad/s scored 0.0 m/s, slept at frame 30, and had its spin
// zeroed with it — measured, 0.5 rad of a second's turn. The linear model
// evaluates neither the signal nor the threshold. The solver still visits every slot — it
// integrates one system, not N bodies — so nothing here is faster for having
// slept; what it is, is still.

import { Solver, SolverConfig } from "./solver";
import { MotionBatch } from "./ogre/motion";

// ── the solver's callbacks ───────────────────────────────────────────────
//
// The derivative has no context argument (`tension_solver.h`'s signature), so
// gravity travels through module state: the World that owns the solver sets it
// before stepping, nothing else writes it, and within a step it is constant —
// which is what keeps the derivative a pure function of `(y, t)`.

let gravity_y: f64 = -9.81;

/**
 * The sleep mask, for the same reason gravity is module state: the derivative
 * has no context argument. The World sets it before a step and clears it after,
 * and within a step it is constant.
 *
 * This is how sleeping works at all. One solver integrates the whole state
 * vector — there is no per-body stepping and this layer does not add one — so
 * "do not integrate this body" can only mean "write zeros for it": no position
 * derivative, no velocity derivative, no gravity. Verlet then leaves the
 * position bit-for-bit unchanged, which is what makes "the pile has not moved"
 * an equality rather than a tolerance in the acid test.
 *
 * The mask's stride is the layout's: three slots per body per half in the
 * linear model. A model with more slots per body needs its own divisor here.
 */
let sleep_mask: Uint8Array | null = null;

/**
 * Which layout the derivative is being asked to differentiate: 3 slots per body
 * per half, or 7. Module state for the same reason gravity is — the callback
 * has no context argument — and set by `World.create` before the solver exists,
 * constant for that solver's life.
 */
let derivative_mode: i32 = 0;
const MODEL_LINEAR: i32 = 0;
const MODEL_ANGULAR: i32 = 1;

/** The two callback buffers: 64 KiB each, the ABI's fixed convention. */
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);

export function physics_buf_in(): i32 { return i32(BUF_IN); }
export function physics_buf_out(): i32 { return i32(BUF_OUT); }

/**
 * `[q', v'] = [v, a]`, with `a` gravity on the y component and zero elsewhere —
 * and zero in both halves for a body the sleep mask says is asleep.
 *
 * `dim` is `6N`, so the first half is every body's position and the second half
 * every body's velocity — the layout `Body` documents.
 */
export function physics_derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (dyCap < len) return -22; // -EINVAL
  if (derivative_mode == MODEL_ANGULAR) return physics_derivative_angular(yPtr, len, dyPtr);
  const half = len / 2;
  // The mask as a local, because AssemblyScript's narrowing does not reach into
  // an index expression: `sleep_mask != null && sleep_mask[i]` does not compile.
  const mask = sleep_mask;
  for (let i = 0; i < half; i++) {
    const sleeping = mask != null && mask![i / 3] != 0;
    store<f64>(dyPtr + <usize>i * 8,
               sleeping ? 0.0 : load<f64>(yPtr + <usize>(half + i) * 8));
  }
  for (let i = half; i < len; i++) {
    const sleeping = mask != null && mask![(i - half) / 3] != 0;
    store<f64>(dyPtr + <usize>i * 8,
               sleeping ? 0.0 : ((i - half) % 3 == 1 ? gravity_y : 0.0));
  }
  return 0;
}

/**
 * The angular RHS: `[v, q' | a, q'']`, seven slots per body per half.
 *
 * The accelerations are gravity on y — the contacts are impulses and land in the
 * write-back phase, not here — and the quaternion's *second* derivative, which
 * the probe's identity collapses to a scalar multiple of the coordinate:
 *
 *     q'' = ½ ω ⊗ q' = −(|q'|² / |q|²) · q      (torque-free; ω = 2q'⊗q⁻¹)
 *
 * so a body's orientation costs four multiplies rather than two quaternion
 * products. Chunk 8a measured both forms at N = 256: 3.4 µs per step for this
 * one against 7.4 µs for the products, with the same trajectory.
 *
 * The first half is written too — the coordinate derivatives, `[v, q']` — for
 * the methods that read it (rk45 does; the symplectic Verlet reads only the
 * second half). A sleeping body gets zeros in both halves, which together with
 * its zeroed second half is what leaves it bit-for-bit where it is.
 */
function physics_derivative_angular(yPtr: usize, len: i32, dyPtr: usize): i32 {
  const half = len / 2; // 7N
  const mask = sleep_mask;
  for (let base: i32 = 0; base < half; base += 7) {
    const body_index = base / 7;
    const sleeping = mask != null && mask![body_index] != 0;
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

// ── the parameter tables ─────────────────────────────────────────────────

/**
 * The per-body parameters, as flat tables: what the derivative does *not*
 * integrate and the response needs. `invMass` rather than mass because every
 * impulse is a division by the mass sum.
 */
export class PhysicsParams {
  radius: Float64Array;
  invMass: Float64Array;
  restitution: Float64Array;
  friction: Float64Array;
  /**
   * The diagonal inverse inertia, one per axis per body (chunk 8). Diagonal is
   * exact for a sphere and for a box about its own axes, and it is the model the
   * probe measured; a full tensor is §12. Zero means the body cannot rotate —
   * which is what an immovable body gets, and what the linear model never reads.
   *
   * The tensor is applied in **world axes** rather than rotated into the body's
   * frame. For a sphere that is exact (isotropic), and for a box it is the
   * simplification the probe's numbers are for: a tumbling box whose principal
   * axes have swung away from the world axes is stiffer than it should be about
   * x and z. §12 carries the fix (a full tensor and a body-frame transform).
   */
  invInertiaX: Float64Array;
  invInertiaY: Float64Array;
  invInertiaZ: Float64Array;
  /**
   * The floor under the positional bias, in m/s. A bias proportional to the
   * penetration is what keeps a pile from sinking, and an uncapped one is what
   * eventually throws a body out of it: a deep overlap becomes a large outward
   * velocity, which pushes the neighbours, which deepens their overlaps. The
   * layer's own example measured it — 64 bodies reaching 2.7 m/s at frame 300
   * with no cap, against 0.04 m/s for sixteen — so the bias is capped at a
   * speed that still separates a contact in a sub-step or two.
   */
  biasCap: f64 = 1.0;

  constructor(count: i32) {
    this.radius = new Float64Array(count);
    this.invMass = new Float64Array(count);
    this.restitution = new Float64Array(count);
    this.friction = new Float64Array(count);
    this.invInertiaX = new Float64Array(count);
    this.invInertiaY = new Float64Array(count);
    this.invInertiaZ = new Float64Array(count);
  }

  /** `mass <= 0` makes a body immovable: infinite mass, and it never moves.
   * The inertia is the sphere's — `I = (2/5) m r²` — which is what a sphere's
   * collider implies; `setMoments` overrides it for a box's. */
  set(index: i32, radius: f64, mass: f64, restitution: f64, friction: f64): void {
    this.radius[index] = radius;
    this.invMass[index] = mass > 0.0 ? 1.0 / mass : 0.0;
    this.restitution[index] = restitution;
    this.friction[index] = friction;
    const i = 0.4 * mass * radius * radius;
    this.setMoments(index, i, i, i);
  }

  /**
   * Set the three principal moments of inertia (not their inverses). A
   * non-positive moment means the body cannot rotate about that axis, which is
   * how an immovable body is expressed.
   *
   * A cuboid of half-extents `(hx, hy, hz)` and mass `m`:
   *
   *     Ix = (1/3) m (hy² + hz²)     Iy = (1/3) m (hx² + hz²)     Iz = (1/3) m (hx² + hy²)
   */
  setMoments(index: i32, ix: f64, iy: f64, iz: f64): void {
    this.invInertiaX[index] = ix > 0.0 ? 1.0 / ix : 0.0;
    this.invInertiaY[index] = iy > 0.0 ? 1.0 / iy : 0.0;
    this.invInertiaZ[index] = iz > 0.0 ? 1.0 / iz : 0.0;
  }

  /** Inverse inertia about `axis`, or 0 when the body cannot rotate. */
  invInertiaAt(index: i32, axis: i32): f64 {
    if (axis == 0) return this.invInertiaX[index];
    if (axis == 1) return this.invInertiaY[index];
    if (axis == 2) return this.invInertiaZ[index];
    return 0.0;
  }
}

// ── sleep ────────────────────────────────────────────────────────────────

/**
 * Per-body sleep bookkeeping: how long each body has been slow, and whether it
 * has been put to sleep.
 *
 * Sleeping is a **numerical and visual** feature. Chunk 6's pile crept at
 * 0.057 m/s and no sub-step count reached the ideal 0.05, so the last bodies of
 * a settled pile kept drifting; sleeping is what makes the picture stop, and
 * its clauses in the acid test are equalities (kinetic energy exactly 0,
 * positions bit-for-bit unchanged) rather than thresholds. It is not a
 * performance feature: the solver integrates one system rather than N bodies,
 * so a sleeping body still costs its slots in every step.
 *
 * The policy: a body that spends `frames` consecutive frames below `speed`
 * sleeps. It wakes when an awake body touches it, or when the caller says so —
 * `wake`, `wakeAll`, `place`, `setVelocity`, `setParams`. Raw writes through
 * `Body`'s accessors do **not** wake it: those are views over the state vector
 * and cannot be observed, and pretending otherwise would be worse than saying
 * so. That asymmetry is the one place this API can surprise a caller.
 */
export class SleepState {
  /** Consecutive frames below the threshold, per body. */
  counter: Uint32Array;
  /** 1 when the body is asleep. Handed to the derivative as its mask. */
  asleep: Uint8Array;
  /** The speed below which a body counts as still, in m/s. */
  speed: f64 = 0.1;
  /**
   * The *angular* speed below which a body counts as still, in rad/s — 0.06,
   * which is 0.001 rad per frame at 60 Hz. The grounding is chunk 8a's Q5: a
   * resting box turned at most 0.0079 rad over 600 frames, ~1.3e-5 rad/frame
   * (7.9e-4 rad/s), so the threshold sits two orders of magnitude above the
   * measured jitter and well below any spin a viewer would call motion. Only
   * the angular model reads it.
   */
  angularSpeed: f64 = 0.06;
  /** Consecutive frames below it before a body sleeps. */
  frames: u32 = 30;

  constructor(count: i32) {
    this.counter = new Uint32Array(count);
    this.asleep = new Uint8Array(count);
  }

  isAsleep(index: i32): bool {
    return index >= 0 && index < this.asleep.length && this.asleep[index] != 0;
  }

  /** Wake one body: clear the flag and the counter, so it gets a fresh run
   * below the threshold before it sleeps again. */
  wake(index: i32): void {
    if (index < 0 || index >= this.asleep.length) return;
    this.asleep[index] = 0;
    this.counter[index] = 0;
  }

  /** Wake every body — what a caller that changes the world underneath the
   * pile wants, since nothing here can tell which bodies that touched. */
  wakeAll(): void {
    for (let i = 0; i < this.asleep.length; i++) {
      this.asleep[i] = 0;
      this.counter[i] = 0;
    }
  }
}

// ── the state, as bodies ─────────────────────────────────────────────────

/**
 * One body's view of the state array: three accessors, and the layout written
 * down once. `base` is where the vector starts — 1 when the array is the
 * solver's `[t, y…]` buffer, 0 when it is the bare vector.
 */
export class Body {
  private state: Float64Array;
  private count: i32;
  private base: i32;
  /** Slots per body per half: 3 in the linear model, 7 in the angular one. */
  private half: i32;
  private omega_scratch: Float64Array = new Float64Array(3);

  constructor(state: Float64Array, count: i32, base: i32 = 0, half: i32 = 3) {
    this.state = state;
    this.count = count;
    this.base = base;
    this.half = half;
  }

  /** How many bodies this view holds. */
  size(): i32 { return this.count; }

  /** Slots per body per half — 3 linear, 7 angular. */
  slotsPerHalf(): i32 { return this.half; }

  /** Whether this view is over the angular layout at all. */
  hasAngular(): bool { return this.half == 7; }

  /** Position component `axis` (0 = x, 1 = y, 2 = z), or 0 for a stray index. */
  pos(index: i32, axis: i32): f64 {
    if (index < 0 || index >= this.count || axis < 0 || axis > 2) return 0.0;
    return this.state[this.base + index * this.half + axis];
  }

  setPos(index: i32, x: f64, y: f64, z: f64): void {
    if (index < 0 || index >= this.count) return;
    const at = this.base + index * this.half;
    this.state[at + 0] = x;
    this.state[at + 1] = y;
    this.state[at + 2] = z;
  }

  /** Velocity component `axis`, read from the *second* half of the vector. */
  vel(index: i32, axis: i32): f64 {
    if (index < 0 || index >= this.count || axis < 0 || axis > 2) return 0.0;
    return this.state[this.base + this.count * this.half + index * this.half + axis];
  }

  setVel(index: i32, x: f64, y: f64, z: f64): void {
    if (index < 0 || index >= this.count) return;
    const at = this.base + this.count * this.half + index * this.half;
    this.state[at + 0] = x;
    this.state[at + 1] = y;
    this.state[at + 2] = z;
  }

  /**
   * Orientation component `component` (0 = x, 1 = y, 2 = z, 3 = w) of body
   * `index`, from the *first* half — the four slots after the position. All
   * zeroes in the linear model, which has no orientation.
   */
  quat(index: i32, component: i32): f64 {
    if (this.half != 7 || index < 0 || index >= this.count ||
        component < 0 || component > 3) return 0.0;
    return this.state[this.base + index * this.half + 3 + component];
  }

  setQuat(index: i32, qx: f64, qy: f64, qz: f64, qw: f64): void {
    if (this.half != 7 || index < 0 || index >= this.count) return;
    const at = this.base + index * this.half + 3;
    this.state[at + 0] = qx;
    this.state[at + 1] = qy;
    this.state[at + 2] = qz;
    this.state[at + 3] = qw;
  }

  /** Quaternion-derivative component `component`, from the second half. */
  dquat(index: i32, component: i32): f64 {
    if (this.half != 7 || index < 0 || index >= this.count ||
        component < 0 || component > 3) return 0.0;
    return this.state[this.base + this.count * this.half + index * this.half + 3 + component];
  }

  setDquat(index: i32, qx: f64, qy: f64, qz: f64, qw: f64): void {
    if (this.half != 7 || index < 0 || index >= this.count) return;
    const at = this.base + this.count * this.half + index * this.half + 3;
    this.state[at + 0] = qx;
    this.state[at + 1] = qy;
    this.state[at + 2] = qz;
    this.state[at + 3] = qw;
  }

  /**
   * Recover body `index`'s angular velocity from the state's own pair, into
   * `out[0..2]`: `ω = 2 q'⊗q⁻¹`. With `q' = ½ω⊗q` that is exact for any
   * non-zero quaternion, so the state is self-contained — no angular velocity
   * table, and `set_state` means what it says. Does nothing in the linear model.
   */
  recoverOmega(index: i32, out: Float64Array, outBase: i32 = 0): void {
    if (this.half != 7 || index < 0 || index >= this.count) {
      out[outBase + 0] = 0.0; out[outBase + 1] = 0.0; out[outBase + 2] = 0.0;
      return;
    }
    const at = this.base + index * this.half + 3; // the quaternion
    const dt_at = this.base + this.count * this.half + index * this.half + 3;
    const qx = this.state[at + 0], qy = this.state[at + 1];
    const qz = this.state[at + 2], qw = this.state[at + 3];
    const dx = this.state[dt_at + 0], dy = this.state[dt_at + 1];
    const dz = this.state[dt_at + 2], dw = this.state[dt_at + 3];
    const n2 = qx * qx + qy * qy + qz * qz + qw * qw;
    if (n2 <= 0.0) {
      out[outBase + 0] = 0.0; out[outBase + 1] = 0.0; out[outBase + 2] = 0.0;
      return;
    }
    // p = q' ⊗ q*, the (x, y, z) components; ω = 2 p / |q|².
    const s = 2.0 / n2;
    out[outBase + 0] = s * (-dw * qx + dx * qw - dy * qz + dz * qy);
    out[outBase + 1] = s * (-dw * qy + dx * qz + dy * qw - dz * qx);
    out[outBase + 2] = s * (-dw * qz - dx * qy + dy * qx + dz * qw);
  }

  /** Angular velocity component `axis`, or 0 in the linear model. */
  omega(index: i32, axis: i32): f64 {
    if (this.half != 7 || axis < 0 || axis > 2) return 0.0;
    this.recoverOmega(index, this.omega_scratch);
    return this.omega_scratch[axis];
  }

  /**
   * Write the pair back consistently: a unit quaternion, and
   * `q' = ½ω⊗q` from the angular velocity given. This is the angular model's
   * write path — what turns an impulse's `Δω` into a state change.
   */
  writePose(index: i32, wx: f64, wy: f64, wz: f64): void {
    if (this.half != 7 || index < 0 || index >= this.count) return;
    const at = this.base + index * this.half + 3;
    let qx = this.state[at + 0], qy = this.state[at + 1];
    let qz = this.state[at + 2], qw = this.state[at + 3];
    const n = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (n > 0.0) { qx /= n; qy /= n; qz /= n; qw /= n; }
    this.state[at + 0] = qx; this.state[at + 1] = qy;
    this.state[at + 2] = qz; this.state[at + 3] = qw;
    const dt_at = this.base + this.count * this.half + index * this.half + 3;
    // The (w, x, y, z) components of ½ ω⊗q, written into the (x, y, z, w) slots.
    this.state[dt_at + 0] = 0.5 * (wx * qw + wy * qz - wz * qy);
    this.state[dt_at + 1] = 0.5 * (-wx * qz + wy * qw + wz * qx);
    this.state[dt_at + 2] = 0.5 * (wx * qy - wy * qx + wz * qw);
    this.state[dt_at + 3] = 0.5 * (-wx * qx - wy * qy - wz * qz);
  }

  /** Renormalize body `index`'s quaternion. The angular model runs this once
   * per sub-step, after the impulses: chunk 8a measured the drift at 0.00014 %
   * against a 0.1 % budget, so it is safe and it is required. */
  normalizeQuat(index: i32): void {
    if (this.half != 7 || index < 0 || index >= this.count) return;
    const at = this.base + index * this.half + 3;
    const qx = this.state[at + 0], qy = this.state[at + 1];
    const qz = this.state[at + 2], qw = this.state[at + 3];
    const n = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (n <= 0.0) return;
    this.state[at + 0] = qx / n;
    this.state[at + 1] = qy / n;
    this.state[at + 2] = qz / n;
    this.state[at + 3] = qw / n;
  }
}

// ── contacts ─────────────────────────────────────────────────────────────

/** Eight f64 per contact: body, other body (-1 for a plane), axis (-1 for a
 * pair), the normal, the penetration, and one slot of headroom. */
const CONTACT_STRIDE: i32 = 8;

/**
 * A fixed-capacity contact buffer, filled by the generators and read by
 * `resolve`. Nothing here allocates after construction: a frame's contacts are
 * transient, and a buffer that grows is a buffer that fragments.
 *
 * A contact's normal points **from `a` toward `b`** for a pair, and **into the
 * container** for a plane (the direction that separates the body from the wall).
 */
export class Contacts {
  private data: Float64Array;
  private capacity: i32;
  private used: i32 = 0;

  constructor(capacity: i32) {
    this.data = new Float64Array(capacity * CONTACT_STRIDE);
    this.capacity = capacity;
  }

  clear(): void { this.used = 0; }
  /** How many contacts the last `detect` pass produced. */
  count(): i32 { return this.used; }
  capacityOf(): i32 { return this.capacity; }

  bodyA(i: i32): i32 { return <i32>this.data[i * CONTACT_STRIDE + 0]; }
  bodyB(i: i32): i32 { return <i32>this.data[i * CONTACT_STRIDE + 1]; }
  axis(i: i32): i32 { return <i32>this.data[i * CONTACT_STRIDE + 2]; }
  normal(i: i32, component: i32): f64 { return this.data[i * CONTACT_STRIDE + 3 + component]; }
  penetration(i: i32): f64 { return this.data[i * CONTACT_STRIDE + 6]; }

  private push(a: i32, b: i32, axis: i32, nx: f64, ny: f64, nz: f64, penetration: f64): bool {
    if (this.used >= this.capacity) return false;
    const at = this.used * CONTACT_STRIDE;
    this.data[at + 0] = <f64>a;
    this.data[at + 1] = <f64>b;
    this.data[at + 2] = <f64>axis;
    this.data[at + 3] = nx;
    this.data[at + 4] = ny;
    this.data[at + 5] = nz;
    this.data[at + 6] = penetration;
    this.used += 1;
    return true;
  }

  /**
   * Two spheres: one contact when their surfaces overlap. Equal shapes, so the
   * normal is the line between the centres; the normal points from `a` to `b`.
   *
   * `touched` is the rolling-resistance gate: it is marked for a contact
   * *candidate* — surfaces touching, before the slop decides whether the pair is
   * worth resolving — because a resting body sits inside the slop and the decay
   * has to see it anyway (the module doc says why).
   */
  sphereSphere(body: Body, params: PhysicsParams, a: i32, b: i32, slop: f64,
               touched: Uint8Array | null = null): bool {
    const dx = body.pos(b, 0) - body.pos(a, 0);
    const dy = body.pos(b, 1) - body.pos(a, 1);
    const dz = body.pos(b, 2) - body.pos(a, 2);
    const dist2 = dx * dx + dy * dy + dz * dz;
    const reach = params.radius[a] + params.radius[b];
    if (dist2 >= reach * reach || dist2 <= 1.0e-18) return false;
    if (touched != null) { touched[a] = 1; touched[b] = 1; }
    const dist = Math.sqrt(dist2);
    const penetration = reach - dist;
    if (penetration <= slop) return false;
    return this.push(a, b, -1, dx / dist, dy / dist, dz / dist, penetration);
  }

  /**
   * A sphere against an axis-aligned plane. `inside` is +1 when the container's
   * interior is at larger coordinates along `axis` (a floor, the -x wall) and -1
   * when it is at smaller ones; `distance` is how far inside the plane the
   * centre is. The stored normal points into the container, which is the
   * direction that separates the body from the wall.
   */
  spherePlane(body: Body, params: PhysicsParams, index: i32, axis: i32, inside: f64,
              distance: f64, slop: f64, touched: Uint8Array | null = null): bool {
    const penetration = params.radius[index] - distance;
    if (penetration <= 0.0) return false;
    if (touched != null) touched[index] = 1;
    if (penetration <= slop) return false;
    const nx = axis == 0 ? inside : 0.0;
    const ny = axis == 1 ? inside : 0.0;
    const nz = axis == 2 ? inside : 0.0;
    return this.push(index, -1, axis, nx, ny, nz, penetration);
  }
}

/**
 * `n · ((I⁻¹ (r × n)) × r)`: the rotational part of the effective mass along
 * `n` for an impulse applied at `r`. Zero for an axis through the centre, which
 * is what makes a head-on sphere contact behave exactly as it did linearly.
 */
function rotational_term(params: PhysicsParams, index: i32, rx: f64, ry: f64, rz: f64,
                         nx: f64, ny: f64, nz: f64): f64 {
  const cx = ry * nz - rz * ny;
  const cy = rz * nx - rx * nz;
  const cz = rx * ny - ry * nx;
  const ix = params.invInertiaX[index] * cx;
  const iy = params.invInertiaY[index] * cy;
  const iz = params.invInertiaZ[index] * cz;
  const tx = iy * rz - iz * ry;
  const ty = iz * rx - ix * rz;
  const tz = ix * ry - iy * rx;
  return nx * tx + ny * ty + nz * tz;
}

/**
 * `ω += sign · I⁻¹ (r × (j·n))`: the angular half of an impulse `j·n` applied
 * at `r`. The linear half is the caller's, because the linear velocities live
 * in the state and the angular ones in `omega` until the write-back.
 */
function apply_torque(params: PhysicsParams, omega: Float64Array, index: i32,
                      rx: f64, ry: f64, rz: f64, j: f64, nx: f64, ny: f64, nz: f64,
                      sign: f64): void {
  const px = ry * (j * nz) - rz * (j * ny);
  const py = rz * (j * nx) - rx * (j * nz);
  const pz = rx * (j * ny) - ry * (j * nx);
  omega[index * 3 + 0] += sign * params.invInertiaX[index] * px;
  omega[index * 3 + 1] += sign * params.invInertiaY[index] * py;
  omega[index * 3 + 2] += sign * params.invInertiaZ[index] * pz;
}

/**
 * One impulse pass over every contact: a normal impulse with restitution, a
 * tangential impulse clamped by Coulomb friction, and a positional bias — the
 * part that stops a settled pile sinking through the floor, expressed as a
 * velocity rather than as a position fix so it travels through the same channel
 * as everything else.
 *
 * **`omega != null` selects the angular model** (chunk 8): the same pass with
 * the contact point `r = p − centre` entering the effective mass, the impulse
 * gaining a torque `I⁻¹(r × j n)`, and friction gaining one too — which is what
 * makes a ball roll. `omega` is a per-body table recovered from the state's
 * `q'` before the pass and written back into it after, because the state carries
 * `q' = ½ω⊗q` rather than `ω` (§5.1 for why it must).
 *
 * **Two rules separate the angular pass from the linear one, and both are
 * measured rather than assumed:**
 *
 *   * the **positional bias is linear-only**. It never enters `j`, so it can
 *     never become a torque: a correction that moved a body by spinning it would
 *     turn a resting pile. Chunk 8a measured a resting box accumulating
 *     **0.0 rad** this way, against **0.0356 rad (2.04°)** when the bias is
 *     folded into `desired` — the wiring this function does not use. The bias
 *     keeps its 1.0 m/s cap.
 *   * the contact point is **derived**, not carried in the record: a sphere
 *     against a plane touches at its deepest point, a pair in the middle of the
 *     overlap. Both follow from the normal and the penetration, so the contact
 *     buffer did not have to grow a field.
 *
 * Impulses are divided by the sum of the inverse masses, so two bodies of
 * different mass meet each other the way they should; a plane has infinite mass
 * and takes none of the impulse. Restitution and friction are averaged over the
 * pair. Nothing here iterates: each contact is resolved once, in the order it
 * was generated, and a contact resolved earlier is not revisited by a later one.
 */
export function resolve(contacts: Contacts, body: Body, params: PhysicsParams, sleep: SleepState,
                        beta: f64, dt: f64, omega: Float64Array | null = null,
                        slop: f64 = 0.0): void {
  for (let i = 0; i < contacts.count(); i++) {
    const a = contacts.bodyA(i);
    const b = contacts.bodyB(i);
    // Sleeping bodies are still collision targets — a moving body has to land on
    // a sleeper, not pass through it — so the skipping lives here rather than in
    // the generator. Two sleepers have nothing to resolve because neither can
    // move; a sleeper touched by an awake body wakes and resolves normally,
    // which is the whole wake rule. A plane wakes nothing: it is not a body, and
    // nothing about the floor changes while a body rests on it.
    if (b < 0) {
      if (sleep.isAsleep(a)) continue;
    } else {
      const a_asleep = sleep.isAsleep(a);
      const b_asleep = sleep.isAsleep(b);
      if (a_asleep && b_asleep) continue;
      if (a_asleep) sleep.wake(a);
      if (b_asleep) sleep.wake(b);
    }
    const axis = contacts.axis(i);
    const nx = contacts.normal(i, 0);
    const ny = contacts.normal(i, 1);
    const nz = contacts.normal(i, 2);
    const penetration = contacts.penetration(i);
    let bias = beta * penetration / dt;
    if (bias > params.biasCap) bias = params.biasCap;

    if (omega != null) {
      // ── the angular model ────────────────────────────────────────────────
      const inv_a = params.invMass[a];
      const inv_b = b >= 0 ? params.invMass[b] : 0.0;
      const inv_sum = inv_a + inv_b;

      // The contact point, and `r` from each centre to it. Derived, not carried:
      // a sphere against a plane touches at its deepest point, a pair in the
      // middle of the overlap — both follow from the normal and the penetration.
      let rax = 0.0, ray = 0.0, raz = 0.0;
      let rbx = 0.0, rby = 0.0, rbz = 0.0;
      if (b < 0) {
        const reach = params.radius[a] - penetration;
        rax = -reach * nx; ray = -reach * ny; raz = -reach * nz;
      } else {
        const gap = params.radius[a] + params.radius[b] - penetration; // centre distance
        const along = params.radius[a] - penetration * 0.5;
        rax = along * nx; ray = along * ny; raz = along * nz;
        rbx = rax - gap * nx; rby = ray - gap * ny; rbz = raz - gap * nz;
      }

      // The contact-point velocities, `v + ω × r` (a plane does not move).
      const wax = omega[a * 3 + 0], way = omega[a * 3 + 1], waz = omega[a * 3 + 2];
      const avx = body.vel(a, 0) + (way * raz - waz * ray);
      const avy = body.vel(a, 1) + (waz * rax - wax * raz);
      const avz = body.vel(a, 2) + (wax * ray - way * rax);
      let bvx = 0.0, bvy = 0.0, bvz = 0.0;
      let wbx = 0.0, wby = 0.0, wbz = 0.0;
      if (b >= 0) {
        wbx = omega[b * 3 + 0]; wby = omega[b * 3 + 1]; wbz = omega[b * 3 + 2];
        bvx = body.vel(b, 0) + (wby * rbz - wbz * rby);
        bvy = body.vel(b, 1) + (wbz * rbx - wbx * rbz);
        bvz = body.vel(b, 2) + (wbx * rby - wby * rbx);
      }

      // Separating velocity along the normal. The two cases read differently
      // because the stored normal does: from `a` toward `b` for a pair, and out
      // of the wall for a plane — the same mirroring the linear path has.
      const vn = b < 0
        ? (avx * nx + avy * ny + avz * nz)
        : ((bvx - avx) * nx + (bvy - avy) * ny + (bvz - avz) * nz);

      const restitution = b >= 0
        ? 0.5 * (params.restitution[a] + params.restitution[b]) : params.restitution[a];
      const mu = b >= 0
        ? 0.5 * (params.friction[a] + params.friction[b]) : params.friction[a];

      const rot_n = rotational_term(params, a, rax, ray, raz, nx, ny, nz) +
                    (b >= 0 ? rotational_term(params, b, rbx, rby, rbz, nx, ny, nz) : 0.0);
      const kn = inv_sum + rot_n;
      let jn = 0.0;
      if (kn > 0.0) {
        // The bias is absent from `desired` on purpose: this is the rule. A
        // correction that reached the impulse would be a torque with no force
        // behind it, and a resting body would turn on it (§5.1).
        const desired = Math.max(0.0, -restitution * vn);
        if (vn < desired) {
          jn = (desired - vn) / kn;
          if (b < 0) {
            body.setVel(a, body.vel(a, 0) + jn * inv_a * nx,
                           body.vel(a, 1) + jn * inv_a * ny,
                           body.vel(a, 2) + jn * inv_a * nz);
            apply_torque(params, omega, a, rax, ray, raz, jn, nx, ny, nz, 1.0);
          } else {
            body.setVel(a, body.vel(a, 0) - jn * inv_a * nx,
                           body.vel(a, 1) - jn * inv_a * ny,
                           body.vel(a, 2) - jn * inv_a * nz);
            apply_torque(params, omega, a, rax, ray, raz, jn, nx, ny, nz, -1.0);
            body.setVel(b, body.vel(b, 0) + jn * inv_b * nx,
                           body.vel(b, 1) + jn * inv_b * ny,
                           body.vel(b, 2) + jn * inv_b * nz);
            apply_torque(params, omega, b, rbx, rby, rbz, jn, nx, ny, nz, 1.0);
          }
        }
      }

      // Friction at the same point, from the velocity the normal impulse just
      // produced — and this is the half that spins a body up. A sphere sliding
      // on the floor gains ω until `ω × r = −v` at the contact, which is what
      // "rolling" means; a linear-only model slides to a halt instead (measured:
      // 0.051 v₀ with no rotation against 0.716 v₀ and 5.72 rad).
      if (mu > 0.0 && inv_sum > 0.0) {
        const w1x = omega[a * 3 + 0], w1y = omega[a * 3 + 1], w1z = omega[a * 3 + 2];
        let tvx = body.vel(a, 0) + (w1y * raz - w1z * ray);
        let tvy = body.vel(a, 1) + (w1z * rax - w1x * raz);
        let tvz = body.vel(a, 2) + (w1x * ray - w1y * rax);
        if (b >= 0) {
          const u1x = omega[b * 3 + 0], u1y = omega[b * 3 + 1], u1z = omega[b * 3 + 2];
          tvx = (body.vel(b, 0) + (u1y * rbz - u1z * rby)) - tvx;
          tvy = (body.vel(b, 1) + (u1z * rbx - u1x * rbz)) - tvy;
          tvz = (body.vel(b, 2) + (u1x * rby - u1y * rbx)) - tvz;
        } else {
          tvx = -tvx; tvy = -tvy; tvz = -tvz;
        }
        // The tangential part of the relative velocity.
        const vn_now = tvx * nx + tvy * ny + tvz * nz;
        tvx -= vn_now * nx; tvy -= vn_now * ny; tvz -= vn_now * nz;
        const tlen = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
        if (tlen > 1.0e-12) {
          const tx = tvx / tlen, ty = tvy / tlen, tz = tvz / tlen;
          const kt = inv_sum + rotational_term(params, a, rax, ray, raz, tx, ty, tz) +
                     (b >= 0 ? rotational_term(params, b, rbx, rby, rbz, tx, ty, tz) : 0.0);
          if (kt > 0.0) {
            // The impulse that would stop the sliding, clamped into the Coulomb
            // cone of the normal impulse it rides on — which for a resting body
            // is its weight's impulse for this sub-step, so the cone is right
            // without a special case.
            const cone = mu * jn;
            let jt = -tlen / kt;
            if (jt < -cone) jt = -cone;
            if (jt > cone) jt = cone;
            body.setVel(a, body.vel(a, 0) - jt * inv_a * tx,
                           body.vel(a, 1) - jt * inv_a * ty,
                           body.vel(a, 2) - jt * inv_a * tz);
            apply_torque(params, omega, a, rax, ray, raz, jt, tx, ty, tz, -1.0);
            if (b >= 0) {
              body.setVel(b, body.vel(b, 0) + jt * inv_b * tx,
                             body.vel(b, 1) + jt * inv_b * ty,
                             body.vel(b, 2) + jt * inv_b * tz);
              apply_torque(params, omega, b, rbx, rby, rbz, jt, tx, ty, tz, 1.0);
            }
          }
        }
      }

      // The positional correction, linear only: a velocity change along the
      // normal, split by inverse mass for a pair and whole for a plane, gated by
      // the slop so a contact that is barely touching is not corrected at all.
      if (penetration > slop) {
        if (b < 0) {
          body.setVel(a, body.vel(a, 0) + bias * nx,
                         body.vel(a, 1) + bias * ny,
                         body.vel(a, 2) + bias * nz);
        } else if (inv_sum > 0.0) {
          const share = bias / inv_sum;
          body.setVel(a, body.vel(a, 0) - share * inv_a * nx,
                         body.vel(a, 1) - share * inv_a * ny,
                         body.vel(a, 2) - share * inv_a * nz);
          body.setVel(b, body.vel(b, 0) + share * inv_b * nx,
                         body.vel(b, 1) + share * inv_b * ny,
                         body.vel(b, 2) + share * inv_b * nz);
        }
      }
      continue;
    }

    // Relative velocity along the normal: positive means separating.
    let vn = 0.0;
    let inv_a = 0.0, inv_b = 0.0;
    let restitution = params.restitution[a];
    let friction = params.friction[a];
    if (b < 0) {
      vn = body.vel(a, 0) * nx + body.vel(a, 1) * ny + body.vel(a, 2) * nz;
      inv_a = params.invMass[a];
    } else {
      vn = (body.vel(b, 0) - body.vel(a, 0)) * nx + (body.vel(b, 1) - body.vel(a, 1)) * ny +
           (body.vel(b, 2) - body.vel(a, 2)) * nz;
      inv_a = params.invMass[a];
      inv_b = params.invMass[b];
      restitution = 0.5 * (restitution + params.restitution[b]);
      friction = 0.5 * (friction + params.friction[b]);
    }
    const inv_sum = inv_a + inv_b;
    if (inv_sum <= 0.0) continue; // two immovable bodies, nothing to resolve

    const desired = Math.max(bias, -restitution * vn);
    if (vn < desired) {
      const impulse = (desired - vn) / inv_sum;
      if (b < 0) {
        body.setVel(a, body.vel(a, 0) + impulse * inv_a * nx,
                    body.vel(a, 1) + impulse * inv_a * ny,
                    body.vel(a, 2) + impulse * inv_a * nz);
      } else {
        body.setVel(a, body.vel(a, 0) - impulse * inv_a * nx,
                    body.vel(a, 1) - impulse * inv_a * ny,
                    body.vel(a, 2) - impulse * inv_a * nz);
        body.setVel(b, body.vel(b, 0) + impulse * inv_b * nx,
                    body.vel(b, 1) + impulse * inv_b * ny,
                    body.vel(b, 2) + impulse * inv_b * nz);
      }

      // Friction: the tangential component of the relative velocity, losing at
      // most `mu * impulse` of its momentum.
      const mu = friction * impulse;
      if (mu > 0.0) {
        let tx = 0.0, ty = 0.0, tz = 0.0;
        if (b < 0) {
          tx = body.vel(a, 0) - vn * nx;
          ty = body.vel(a, 1) - vn * ny;
          tz = body.vel(a, 2) - vn * nz;
        } else {
          tx = (body.vel(b, 0) - body.vel(a, 0)) - vn * nx;
          ty = (body.vel(b, 1) - body.vel(a, 1)) - vn * ny;
          tz = (body.vel(b, 2) - body.vel(a, 2)) - vn * nz;
        }
        const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tlen > 1.0e-12) {
          const impulse_t = Math.min(tlen, mu) / inv_sum / tlen; // <= mu / (1/m) / |t|
          if (b < 0) {
            body.setVel(a, body.vel(a, 0) - impulse_t * inv_a * tx,
                        body.vel(a, 1) - impulse_t * inv_a * ty,
                        body.vel(a, 2) - impulse_t * inv_a * tz);
          } else {
            body.setVel(a, body.vel(a, 0) + impulse_t * inv_a * tx,
                        body.vel(a, 1) + impulse_t * inv_a * ty,
                        body.vel(a, 2) + impulse_t * inv_a * tz);
            body.setVel(b, body.vel(b, 0) - impulse_t * inv_b * tx,
                        body.vel(b, 1) - impulse_t * inv_b * ty,
                        body.vel(b, 2) - impulse_t * inv_b * tz);
          }
        }
      }
    }
  }
}

// ── the world ────────────────────────────────────────────────────────────

/** What a `World` needs to exist: the bodies, the container, and the model's
 * constants. Everything has a default, so a caller states what it cares about. */
export class WorldConfig {
  bodies: i32 = 0;
  radius: f64 = 0.1;
  mass: f64 = 1.0;
  gravity: f64 = -9.81;
  /** Sub-steps per nominal frame — the cadence the penetration numbers chose. */
  substeps: i32 = 4;
  /** The nominal frame the sub-step size is derived from. */
  frameDt: f64 = 1.0 / 60.0;
  /** The most sub-steps one `step()` may take, however long the frame ran. */
  maxSubsteps: i32 = 8;
  restitution: f64 = 0.3;
  friction: f64 = 0.4;
  /** The positional bias, as a fraction of the penetration per sub-step. */
  bias: f64 = 0.2;
  /** Penetration left in place rather than corrected, to keep the bias quiet. */
  slop: f64 = 1.0e-3;
  /** The container: a floor at y = 0 and walls at ±extent in x and z. */
  extent: f64 = 4.0;
  /** Where the renderable ids start: body `i` is `firstRenderableId + i`. */
  firstRenderableId: u32 = 1;
  /** The motion entry's scale, so the mesh drawn is the sphere simulated. */
  meshScale: f64 = 1.0;
  /** The speed below which a body counts as still, in m/s. 0.1 is the acid
   * test's own rest threshold and sits above the 0.057 m/s creep chunk 6
   * measured — a threshold at 0.05 would sleep nothing. */
  sleepSpeed: f64 = 0.1;
  /** The angular counterpart, in rad/s — 0.001 rad/frame at 60 Hz, and only the
   * angular model reads it (see `SleepState.angularSpeed` for the grounding). */
  sleepAngularSpeed: f64 = 0.06;
  /**
   * Rolling resistance: the rate (1/s) at which a body in contact has its spin
   * decayed, `ω ← ω · max(0, 1 − k·h)` per sub-step, angular model only. `0.0`
   * disables it and reproduces chunk 8c2's undamped numbers.
   *
   * 13 is not a tuned value: it is what the chunk-8 fixture's own clauses
   * require. A *free* spinner decays at `k`; a *rolling* body decays at
   * `k·I/(I + m r²)` — 2/7 of it for a solid sphere — because a pure-angular
   * term cannot touch the linear momentum friction re-couples the spin to. The
   * fixture's roller needs ≥ 12 for that reason and the speed of a sliding
   * contact does not enter at all (chunk 9a-i's probe measured the whole curve).
   */
  rollResistance: f64 = 13.0;
  /** Consecutive frames below it before a body sleeps. */
  sleepFrames: u32 = 30;
  /**
   * Opt into the angular model: fourteen slots per body instead of six,
   * quaternions in the state, a diagonal inertia per body, and friction that
   * carries a torque (chunk 8). `false` is the linear model chunk 6 measured and
   * chunk 7 made stop — the default, and the permanent regression.
   */
  angular: bool = false;
  /**
   * What each body's inertia is. The *collider* set does not change — spheres
   * and planes either way — so a body with `SHAPE_BOX` is a sphere's contact
   * geometry carrying a box's inertia, which is what a tumbling crate needs from
   * this layer and what the probe measured.
   */
  shape: u32 = SHAPE_SPHERE;
  boxHalfX: f64 = 0.5;
  boxHalfY: f64 = 0.5;
  boxHalfZ: f64 = 0.5;
}

/** A body whose inertia is the sphere's: `I = (2/5) m r²` about every axis. */
export const SHAPE_SPHERE: u32 = 0;
/** A body whose inertia is a cuboid's, from `boxHalfX/Y/Z`. */
export const SHAPE_BOX: u32 = 1;

/**
 * The world: the solver, the state, the contacts and the cadence, in one place.
 *
 * `step(dt)` runs the whole loop the design calls for — `substeps` sub-steps of
 * advance → read → detect → resolve → write — and `pose(batch)` turns the
 * current state into one motion entry per body. Nothing else in the loop is the
 * caller's business, which is the point: the layout and the cadence are the two
 * things a game gets wrong, and neither is visible from here.
 */
export class World {
  private solver: Solver;
  private config: WorldConfig;
  /** `[t, y…]`: slot 0 is the solver's time, `dim` slots follow. */
  private buffer: Float64Array;
  // Definite assignment: the constructor below builds every one of these from
  // the config before anything can call a method, which is the invariant the
  // `!` states to the compiler.
  private body!: Body;
  private contacts!: Contacts;
  params!: PhysicsParams;
  sleep!: SleepState;
  /** Where each body was at the start of the current `step` call, for the sleep
   * signal: the displacement over a frame, not the stored velocity. */
  private previous!: Float64Array;
  /** And which way each body pointed, for the angular half of the signal. */
  private previous_quat!: Float64Array;
  /** How far each body has travelled during its current quiet window. */
  private travel!: Float64Array;
  /** How far it has *turned* during the same window, in radians. */
  private angular_travel!: Float64Array;
  /** Slots per body per half: 3 linear, 7 angular. */
  private half: i32;
  /** Bodies with a contact *candidate* this sub-step: the rolling-resistance
   * gate, one byte per body, cleared by `detect`. */
  private touched!: Uint8Array;
  private angular: bool;
  /**
   * The angular velocities recovered from the state's `q'` pair, one per body,
   * for the duration of one resolve pass. The state carries `q' = ½ω⊗q`, so the
   * response works here and the write-back puts the result back into the state —
   * there is no second source of truth, only a scratch for the pass.
   */
  private omega!: Float64Array;

  private constructor(solver: Solver, config: WorldConfig) {
    this.solver = solver;
    this.config = config;
    // Locals first: AssemblyScript refuses to read `this` before every field has
    // been assigned, and the fields below are sized from these.
    const angular = config.angular;
    const half = angular ? 7 : 3;
    this.angular = angular;
    this.half = half;
    const dim = config.bodies * half * 2;
    this.buffer = new Float64Array(dim + 1);
    this.body = new Body(this.buffer, config.bodies, 1, half);
    this.omega = new Float64Array(config.bodies * 3);
    this.touched = new Uint8Array(config.bodies);
    // One pair per body and one contact per body per plane is the common case;
    // the buffer is sized for the worst realistic pile rather than the best.
    this.contacts = new Contacts(<i32>Math.max(config.bodies * 8, 64));
    this.params = new PhysicsParams(config.bodies);
    this.sleep = new SleepState(config.bodies);
    this.sleep.speed = config.sleepSpeed;
    this.sleep.angularSpeed = config.sleepAngularSpeed;
    this.sleep.frames = config.sleepFrames;
    this.previous = new Float64Array(config.bodies * 3);
    this.previous_quat = new Float64Array(config.bodies * 4);
    this.travel = new Float64Array(config.bodies);
    this.angular_travel = new Float64Array(config.bodies);
    for (let i = 0; i < config.bodies; i++) {
      // The angular model's default orientation is the identity — an all-zero
      // quaternion is not a rotation at all, and a body that started as one would
      // have no orientation to recover ω from, so every angular path would be
      // silently dead. A caller who wants a different one calls `setQuat`.
      if (angular) this.body.setQuat(i, 0.0, 0.0, 0.0, 1.0);
      this.params.set(i, config.radius, config.mass, config.restitution, config.friction);
      if (this.angular && config.shape == SHAPE_BOX) {
        // A cuboid's principal moments: Ix = m(hy² + hz²)/3 and its cyclic twins.
        const m = config.mass;
        this.params.setMoments(i,
          m * (config.boxHalfY * config.boxHalfY + config.boxHalfZ * config.boxHalfZ) / 3.0,
          m * (config.boxHalfX * config.boxHalfX + config.boxHalfZ * config.boxHalfZ) / 3.0,
          m * (config.boxHalfX * config.boxHalfX + config.boxHalfY * config.boxHalfY) / 3.0);
      }
    }
  }

  /** The state vector's length: `6N` linear, `14N` angular. */
  stateDim(): i32 { return this.config.bodies * this.half * 2; }

  /**
   * Build a world, or `null` when the solver refuses the config — an
   * unavailable method, a dimension the ABI's buffer convention cannot hold
   * (dim = 6N must fit 8192 f64 slots, so N <= 1365), a full solver table.
   */
  static create(config: WorldConfig): World | null {
    const dim = config.bodies * (config.angular ? 14 : 6);
    // The state has to fit the ABI's 64 KiB callback buffer: 8192 f64 slots, so
    // N <= 1365 linear and N <= 585 angular.
    if (config.bodies <= 0 || dim > 8192) return null;
    const solver_config = new SolverConfig();
    solver_config.method = "verlet";
    solver_config.source = "wasm";
    solver_config.dim = dim;
    gravity_y = config.gravity;
    derivative_mode = config.angular ? MODEL_ANGULAR : MODEL_LINEAR;
    const solver = Solver.create(solver_config, {
      derivative: physics_derivative, bufIn: physics_buf_in, bufOut: physics_buf_out,
    });
    if (solver == null) return null;
    return new World(solver, config);
  }

  /** The state as bodies: positions in the first half, velocities in the second. */
  bodies(): Body { return this.body; }
  /** The parameters the response reads. */
  parameters(): PhysicsParams { return this.params; }
  /** How many contacts the last sub-step's detect pass produced. */
  contactCount(): i32 { return this.contacts.count(); }

  /** How many bodies are asleep. The number a loop watches to know it is done. */
  asleepCount(): i32 {
    let asleep = 0;
    for (let i = 0; i < this.config.bodies; i++) {
      if (this.sleep.asleep[i] != 0) asleep += 1;
    }
    return asleep;
  }

  /** Wake one body. Sleeping bodies do not move, so anything a caller does to
   * the world around them — a new obstacle, a change of gravity — has to say
   * who it touched, and this is how. */
  wake(index: i32): void { this.sleep.wake(index); }

  /** Wake every body, for a change that could have touched any of them. */
  wakeAll(): void { this.sleep.wakeAll(); }

  /** Push the buffer into the solver — what makes a write through the accessors
   * stick. `step` reads the solver's state back at the top of every sub-step, so
   * a write that stays in the buffer alone would be overwritten before it was
   * ever integrated. */
  private flush(): void {
    this.solver.setState(this.buffer[0], this.buffer.subarray(1, 1 + this.stateDim()));
  }

  /** Set a body's velocity, and wake it: a body that was asleep has not been
   * evaluated under this velocity, and a sleeping one ignores it entirely. The
   * write reaches the solver immediately, so this works mid-simulation and not
   * only before `seed`. */
  setVelocity(index: i32, vx: f64, vy: f64, vz: f64): void {
    this.body.setVel(index, vx, vy, vz);
    this.sleep.wake(index);
    this.flush();
  }

  /** Change a body's parameters, and wake it, for the same reason. */
  setParams(index: i32, radius: f64, mass: f64, restitution: f64, friction: f64): void {
    this.params.set(index, radius, mass, restitution, friction);
    this.sleep.wake(index);
  }

  /**
   * Place body `index` at rest. Bodies start where the caller puts them; nothing
   * here seeds an arrangement, because a game's opening positions are the game's
   * business.
   */
  place(index: i32, x: f64, y: f64, z: f64): void {
    this.body.setPos(index, x, y, z);
    this.body.setVel(index, 0.0, 0.0, 0.0);
    // "At rest" includes the orientation: with the angular model the derivative
    // slots are zeroed too, so a placed body is not still spinning.
    if (this.angular) this.body.setDquat(index, 0.0, 0.0, 0.0, 0.0);
    this.sleep.wake(index); // placed is not asleep, whatever it was before
  }

  /** Push the seeded state into the solver. Call once, after the placements. */
  seed(): i32 {
    const dim = this.stateDim();
    if (this.solver.setState(0.0, this.buffer.subarray(1, 1 + dim)) != 0) return -1;
    return 0;
  }

  /**
   * Set a body's angular velocity (chunk 8), and wake it. The state stores the
   * derivative `q' = ½ω⊗q`, so this writes the pair rather than a new field —
   * and it renormalizes the quaternion while it is there, which is why a caller
   * can hand this any orientation it likes.
   */
  setAngularVelocity(index: i32, wx: f64, wy: f64, wz: f64): void {
    if (!this.angular) return;
    this.body.writePose(index, wx, wy, wz);
    this.sleep.wake(index);
    this.flush();
  }

  /**
   * Advance by `dt`, in sub-steps of a **fixed size**.
   *
   * The sub-step size is `frameDt / substeps` — 1/240 s at the defaults — and a
   * call that covers more than one nominal frame takes proportionally more
   * sub-steps rather than bigger ones. That matters because the alternative was
   * measured: with a fixed *count* per call, a frame that advanced by two
   * rendered frames halved the sub-step resolution and the same pile settled to
   * 0.16 m/s windowed against 0.027 m/s headless. Physics must not depend on the
   * renderer's pacing.
   *
   * Returns 0, or -1 when the solver refuses — which for a physics loop is the
   * end of the simulation, not a hiccup: a refused step means the state is not
   * where the caller thinks it is.
   */
  step(dt: f64): i32 {
    // The sleep signal is the *displacement* over this call, not the stored
    // velocity, and that is a measured decision rather than a stylistic one: a
    // resting body's velocity carries the positional bias it was last pushed
    // out by — ~0.14 m/s for a 4 mm penetration — which is above any sensible
    // sleep threshold while the body is going nowhere at all. Displacement is
    // what "has this body stopped?" actually means, and it is immune to the
    // bias because the bias pushes out and gravity pulls back within the frame.
    for (let i = 0; i < this.config.bodies; i++) {
      this.previous[i * 3 + 0] = this.body.pos(i, 0);
      this.previous[i * 3 + 1] = this.body.pos(i, 1);
      this.previous[i * 3 + 2] = this.body.pos(i, 2);
      // The orientation too, when there is one to record: the angle between two
      // frames is the angular signal, and it needs the frame before.
      if (this.angular) {
        this.previous_quat[i * 4 + 0] = this.body.quat(i, 0);
        this.previous_quat[i * 4 + 1] = this.body.quat(i, 1);
        this.previous_quat[i * 4 + 2] = this.body.quat(i, 2);
        this.previous_quat[i * 4 + 3] = this.body.quat(i, 3);
      }
    }
    const per_frame = this.config.substeps;
    if (per_frame <= 0) return -1;
    const nominal = this.config.frameDt / <f64>per_frame;
    if (nominal <= 0.0) return -1;
    let count: i32 = <i32>Math.round(dt / nominal);
    if (count < 1) count = 1;
    if (count > this.config.maxSubsteps) count = this.config.maxSubsteps;
    const h = dt / <f64>count; // the requested advance, spread evenly
    for (let sub = 0; sub < count; sub++) {
      // The mask is set before every step and cleared after the last one: a body
      // that falls asleep below is still for the *next* step, and nothing
      // outside a step reads the mask at all.
      sleep_mask = this.sleep.asleep;
      if (this.solver.step(h) != 0) {
        sleep_mask = null;
        return -1;
      }
      this.readState();
      this.detect();
      if (this.angular) {
        // Recover ω from each body's own pair, resolve in the ω domain, and put
        // the result back as `q' = ½ω⊗q` — renormalizing the quaternion as it
        // goes. Sleeping bodies are left alone entirely: their pair is already
        // zero and their orientation already unit, and renormalizing a frozen
        // body would change its bits (the acid test's stillness is bit-for-bit).
        for (let i = 0; i < this.config.bodies; i++) {
          this.body.recoverOmega(i, this.omega, i * 3);
        }
        resolve(this.contacts, this.body, this.params, this.sleep, this.config.bias, h,
                this.omega, this.config.slop);
        // Rolling resistance, between the response and the write-back: it writes
        // the angular table only, so the canonicalization below is what puts the
        // decayed spin into the state, in the same write the impulses use.
        this.dampContacts(h);
        for (let i = 0; i < this.config.bodies; i++) {
          if (this.sleep.isAsleep(i)) continue;
          this.body.writePose(i, this.omega[i * 3], this.omega[i * 3 + 1], this.omega[i * 3 + 2]);
        }
      } else {
        resolve(this.contacts, this.body, this.params, this.sleep, this.config.bias, h);
      }
      const dim = this.stateDim();
      if (this.solver.setState(this.buffer[0], this.buffer.subarray(1, 1 + dim)) != 0) {
        sleep_mask = null;
        return -1;
      }
    }
    sleep_mask = null;
    // Once per call, which at the guest's cadence is once per rendered frame:
    // the window counts frames, as the policy says.
    this.updateSleep(dt);
    // And the zeroing above has to reach the solver, or it is only a claim about
    // a buffer nothing reads until the next call copies the old velocity back.
    // Measured: without this write, every body was asleep and the kinetic energy
    // was 0.0044 instead of 0 — sleepers holding the last velocity they had,
    // frozen but not zero.
    const dim = this.stateDim();
    if (this.solver.setState(this.buffer[0], this.buffer.subarray(1, 1 + dim)) != 0) return -1;
    return 0;
  }

  /**
   * The sleep policy, run once per `step` call — once per rendered frame at the
   * guest's cadence — on how far each body actually moved during it.
   *
   * A body slower than `sleepSpeed` (in displacement per second) for
   * `sleepFrames` consecutive frames sleeps, and sleeping means its velocity is
   * zeroed here and kept at zero by the derivative above. A body already asleep
   * is skipped rather than re-counted, and a body woken by `resolve` starts its
   * count over, which `SleepState.wake` already did.
   */
  private updateSleep(dt: f64): void {
    const threshold = this.config.sleepSpeed;
    const angular_threshold = this.config.sleepAngularSpeed;
    const span = dt > 0.0 ? dt : 1.0e-9;
    for (let i = 0; i < this.config.bodies; i++) {
      if (this.sleep.asleep[i] != 0) continue;
      const dx = this.body.pos(i, 0) - this.previous[i * 3 + 0];
      const dy = this.body.pos(i, 1) - this.previous[i * 3 + 1];
      const dz = this.body.pos(i, 2) - this.previous[i * 3 + 2];
      // The decision is the *average* speed over a full window of `frames`
      // frames, and the window is fixed rather than reset by a spike. Both
      // halves of that were measured against a failing pile: an instantaneous
      // signal reset the counter every 15-23 frames, and an average over a
      // window that a spike could reset never grew past 27, because a short
      // window is a noisy one and its average crosses the threshold. A body
      // that is genuinely moving still never sleeps: its average over the whole
      // window is its speed.
      this.travel[i] += Math.sqrt(dx * dx + dy * dy + dz * dz);
      // The angular half: how far the body turned this frame, in radians. The
      // shortest arc between the two orientations, with |dot| for the double
      // cover — q and −q are the same rotation, so the sign of the dot product
      // is not information and the arc must not be the long way round.
      if (this.angular) {
        const qx = this.body.quat(i, 0), qy = this.body.quat(i, 1);
        const qz = this.body.quat(i, 2), qw = this.body.quat(i, 3);
        let dot = qx * this.previous_quat[i * 4 + 0] + qy * this.previous_quat[i * 4 + 1] +
                  qz * this.previous_quat[i * 4 + 2] + qw * this.previous_quat[i * 4 + 3];
        if (dot < 0.0) dot = -dot;
        if (dot > 1.0) dot = 1.0;
        this.angular_travel[i] += 2.0 * Math.acos(dot);
      }
      this.sleep.counter[i] += 1;
      if (this.sleep.counter[i] < this.sleep.frames) continue;
      const average = this.travel[i] / (<f64>this.sleep.counter[i] * span);
      // Both signals have to say still. A body creeping along the floor and a
      // body spinning on it are both moving, and either one alone keeps it awake.
      let angular_average = 0.0;
      if (this.angular) {
        angular_average = this.angular_travel[i] / (<f64>this.sleep.counter[i] * span);
      }
      if (average < threshold && (!this.angular || angular_average < angular_threshold)) {
        this.sleep.asleep[i] = 1;
        // Zeroed here, and the derivative keeps it zero: this is what makes the
        // acid test's "kinetic energy is exactly 0" an equality. The angular
        // model zeroes the pair, so a slept body has no spin to wake up with.
        this.body.setVel(i, 0.0, 0.0, 0.0);
        if (this.angular) this.body.setDquat(i, 0.0, 0.0, 0.0, 0.0);
      }
      // Either way the window rolls: slept bodies stop being counted at the top
      // of the loop, and a body that did not sleep starts a fresh window.
      this.travel[i] = 0.0;
      this.angular_travel[i] = 0.0;
      this.sleep.counter[i] = 0;
    }
  }

  /**
   * Rolling resistance: a contact-only, pure-angular spin decay. Sleeping bodies
   * are skipped — a slept body's state has to stay bit-for-bit what it was — and
   * nothing else is: no stop threshold, because a rule that stopped the decay
   * below the sleep threshold parks a body on the threshold instead of letting
   * it sleep (chunk 9a-i measured that). No linear component either, and that is
   * a correctness requirement rather than a nicety: the sleep signal is
   * *displacement*, so a resistance that leaked into translation would keep
   * awake the very pile it exists to settle.
   *
   * The gate is the *candidate* contact `detect` marks, not the resolved one the
   * impulse pass sees: a resting body's penetration sits inside the slop, so a
   * resolved-contact gate reaches it in a quarter of its sub-steps.
   */
  private dampContacts(h: f64): void {
    const k = this.config.rollResistance;
    if (k <= 0.0) return;
    let factor = 1.0 - k * h;
    if (factor < 0.0) factor = 0.0;
    for (let i = 0; i < this.config.bodies; i++) {
      if (this.touched[i] == 0) continue;
      if (this.sleep.asleep[i] != 0) continue;
      this.omega[i * 3 + 0] *= factor;
      this.omega[i * 3 + 1] *= factor;
      this.omega[i * 3 + 2] *= factor;
    }
  }

  /** Copy the solver's state into the buffer the accessors read. */
  readState(): void {
    this.solver.state(this.buffer);
  }

  /**
   * Brute force: every pair, then every body against the container's five
   * planes. The pair loop is what the probe measured at 1.17 ms per pass for
   * 256 bodies — affordable where the state cap puts the ceiling, and the thing
   * a grid would replace if a later round raises it.
   */
  private detect(): void {
    this.contacts.clear();
    this.touched.fill(0); // the damping gate is per sub-step, like the contacts
    const count = this.config.bodies;
    const slop = this.config.slop;
    for (let a = 0; a < count; a++) {
      const a_asleep = this.sleep.isAsleep(a);
      for (let b = a + 1; b < count; b++) {
        // Two sleepers: neither can move, so the pair is not a contact and the
        // generator's arithmetic is the pair loop's whole cost. One array read
        // per pair, per sub-step — and the only place sleeping saves anything.
        if (a_asleep && this.sleep.isAsleep(b)) continue;
        this.contacts.sphereSphere(this.body, this.params, a, b, slop, this.touched);
      }
      const px = this.body.pos(a, 0), py = this.body.pos(a, 1), pz = this.body.pos(a, 2);
      const extent = this.config.extent;
      // Floor (interior above y = 0), then the four walls: `inside` says which
      // way the container's interior lies, and `distance` how far inside it is.
      this.contacts.spherePlane(this.body, this.params, a, 1, 1.0, py, slop, this.touched);
      this.contacts.spherePlane(this.body, this.params, a, 0, 1.0, px + extent, slop, this.touched);
      this.contacts.spherePlane(this.body, this.params, a, 0, -1.0, extent - px, slop, this.touched);
      this.contacts.spherePlane(this.body, this.params, a, 2, 1.0, pz + extent, slop, this.touched);
      this.contacts.spherePlane(this.body, this.params, a, 2, -1.0, extent - pz, slop, this.touched);
    }
  }

  /**
   * One motion entry per body, committed by the caller.
   *
   * In the linear model, positions only: that model has no orientation state, so
   * a body keeps the orientation it was submitted with, and painting a rolling
   * one on would be a kinematic face on a linear model — pleasant to look at and
   * not what the simulation computed.
   *
   * In the angular model the orientation **is** simulated, so `setPose` writes
   * it: the quaternion goes to the wire at @32 and the adapter applies it with
   * `setOrientation`, which is why tumbling needs no wire change at all.
   */
  pose(batch: MotionBatch): void {
    const scale: f32 = <f32>this.config.meshScale;
    if (this.half == 7) {
      for (let i = 0; i < this.config.bodies; i++) {
        const at = 1 + i * 7;
        batch.setPose(<u32>i, this.config.firstRenderableId + <u32>i,
                      <f32>this.buffer[at + 0], <f32>this.buffer[at + 1], <f32>this.buffer[at + 2],
                      <f32>this.buffer[at + 3], <f32>this.buffer[at + 4],
                      <f32>this.buffer[at + 5], <f32>this.buffer[at + 6], scale);
      }
      return;
    }
    for (let i = 0; i < this.config.bodies; i++) {
      batch.setFromState(<u32>i, this.config.firstRenderableId + <u32>i, this.buffer,
                         1 + i * 3, 1 + i * 3 + 1, 1 + i * 3 + 2, scale);
    }
  }

  /**
   * Sum of ½·m·|v|² over the bodies — the number the acid test bounds — plus
   * ½·ωᵀIω in the angular model, because a spinning body that is not going
   * anywhere still has energy and a simulation that called that zero would be
   * lying about its own state.
   */
  kineticEnergy(): f64 {
    let total = 0.0;
    for (let i = 0; i < this.config.bodies; i++) {
      const vx = this.body.vel(i, 0), vy = this.body.vel(i, 1), vz = this.body.vel(i, 2);
      const mass = this.params.invMass[i] > 0.0 ? 1.0 / this.params.invMass[i] : 0.0;
      total += 0.5 * mass * (vx * vx + vy * vy + vz * vz);
      if (this.angular) {
        this.body.recoverOmega(i, this.omega, i * 3);
        for (let axis = 0; axis < 3; axis++) {
          const w = this.omega[i * 3 + axis];
          const inv_i = this.params.invInertiaAt(i, axis);
          if (inv_i > 0.0) total += 0.5 * w * w / inv_i;
        }
      }
    }
    return total;
  }

  /** The fastest body's speed. */
  maxSpeed(): f64 {
    let fastest = 0.0;
    for (let i = 0; i < this.config.bodies; i++) {
      const vx = this.body.vel(i, 0), vy = this.body.vel(i, 1), vz = this.body.vel(i, 2);
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > fastest) fastest = speed;
    }
    return fastest;
  }

  /** Whether every body is slower than `threshold` — how a loop decides to stop. */
  allAtRest(threshold: f64): bool {
    return this.maxSpeed() < threshold;
  }

  /** The deepest penetration the contact buffer currently holds. */
  deepestPenetration(): f64 {
    let deepest = 0.0;
    for (let i = 0; i < this.contacts.count(); i++) {
      const p = this.contacts.penetration(i);
      if (p > deepest) deepest = p;
    }
    return deepest;
  }

  destroy(): void {
    this.solver.destroy();
  }
}
