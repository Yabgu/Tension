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
// and the frame stops changing. The solver still visits every slot — it
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
  }

  /** `mass <= 0` makes a body immovable: infinite mass, and it never moves. */
  set(index: i32, radius: f64, mass: f64, restitution: f64, friction: f64): void {
    this.radius[index] = radius;
    this.invMass[index] = mass > 0.0 ? 1.0 / mass : 0.0;
    this.restitution[index] = restitution;
    this.friction[index] = friction;
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

  constructor(state: Float64Array, count: i32, base: i32 = 0) {
    this.state = state;
    this.count = count;
    this.base = base;
  }

  /** How many bodies this view holds. */
  size(): i32 { return this.count; }

  /** Position component `axis` (0 = x, 1 = y, 2 = z), or 0 for a stray index. */
  pos(index: i32, axis: i32): f64 {
    if (index < 0 || index >= this.count || axis < 0 || axis > 2) return 0.0;
    return this.state[this.base + index * 3 + axis];
  }

  setPos(index: i32, x: f64, y: f64, z: f64): void {
    if (index < 0 || index >= this.count) return;
    this.state[this.base + index * 3 + 0] = x;
    this.state[this.base + index * 3 + 1] = y;
    this.state[this.base + index * 3 + 2] = z;
  }

  /** Velocity component `axis`, read from the *second* half of the vector. */
  vel(index: i32, axis: i32): f64 {
    if (index < 0 || index >= this.count || axis < 0 || axis > 2) return 0.0;
    return this.state[this.base + this.count * 3 + index * 3 + axis];
  }

  setVel(index: i32, x: f64, y: f64, z: f64): void {
    if (index < 0 || index >= this.count) return;
    const at = this.base + this.count * 3 + index * 3;
    this.state[at + 0] = x;
    this.state[at + 1] = y;
    this.state[at + 2] = z;
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
   */
  sphereSphere(body: Body, params: PhysicsParams, a: i32, b: i32, slop: f64): bool {
    const dx = body.pos(b, 0) - body.pos(a, 0);
    const dy = body.pos(b, 1) - body.pos(a, 1);
    const dz = body.pos(b, 2) - body.pos(a, 2);
    const dist2 = dx * dx + dy * dy + dz * dz;
    const reach = params.radius[a] + params.radius[b];
    if (dist2 >= reach * reach || dist2 <= 1.0e-18) return false;
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
              distance: f64, slop: f64): bool {
    const penetration = params.radius[index] - distance;
    if (penetration <= slop) return false;
    const nx = axis == 0 ? inside : 0.0;
    const ny = axis == 1 ? inside : 0.0;
    const nz = axis == 2 ? inside : 0.0;
    return this.push(index, -1, axis, nx, ny, nz, penetration);
  }
}

/**
 * One impulse pass over every contact: a normal impulse with restitution, a
 * tangential impulse clamped by Coulomb friction, and a positional bias — the
 * part that stops a settled pile sinking through the floor, expressed as a
 * velocity rather than as a position fix so it travels through the same channel
 * as everything else.
 *
 * Impulses are divided by the sum of the inverse masses, so two bodies of
 * different mass meet each other the way they should; a plane has infinite mass
 * and takes none of the impulse. Restitution and friction are averaged over the
 * pair. Nothing here iterates: each contact is resolved once, in the order it
 * was generated, and a contact resolved earlier is not revisited by a later one.
 */
export function resolve(contacts: Contacts, body: Body, params: PhysicsParams, sleep: SleepState,
                        beta: f64, dt: f64): void {
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
  /** Consecutive frames below it before a body sleeps. */
  sleepFrames: u32 = 30;
}

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
  /** How far each body has travelled during its current quiet window. */
  private travel!: Float64Array;

  private constructor(solver: Solver, config: WorldConfig) {
    this.solver = solver;
    this.config = config;
    const dim = config.bodies * 6;
    this.buffer = new Float64Array(dim + 1);
    this.body = new Body(this.buffer, config.bodies, 1);
    // One pair per body and one contact per body per plane is the common case;
    // the buffer is sized for the worst realistic pile rather than the best.
    this.contacts = new Contacts(<i32>Math.max(config.bodies * 8, 64));
    this.params = new PhysicsParams(config.bodies);
    this.sleep = new SleepState(config.bodies);
    this.sleep.speed = config.sleepSpeed;
    this.sleep.frames = config.sleepFrames;
    this.previous = new Float64Array(config.bodies * 3);
    this.travel = new Float64Array(config.bodies);
    for (let i = 0; i < config.bodies; i++) {
      this.params.set(i, config.radius, config.mass, config.restitution, config.friction);
    }
  }

  /**
   * Build a world, or `null` when the solver refuses the config — an
   * unavailable method, a dimension the ABI's buffer convention cannot hold
   * (dim = 6N must fit 8192 f64 slots, so N <= 1365), a full solver table.
   */
  static create(config: WorldConfig): World | null {
    if (config.bodies <= 0 || config.bodies * 6 > 8192) return null;
    const solver_config = new SolverConfig();
    solver_config.method = "verlet";
    solver_config.source = "wasm";
    solver_config.dim = config.bodies * 6;
    gravity_y = config.gravity;
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

  /** Set a body's velocity, and wake it: a body that was asleep has not been
   * evaluated under this velocity, and a sleeping one ignores it entirely. */
  setVelocity(index: i32, vx: f64, vy: f64, vz: f64): void {
    this.body.setVel(index, vx, vy, vz);
    this.sleep.wake(index);
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
    this.sleep.wake(index); // placed is not asleep, whatever it was before
  }

  /** Push the seeded state into the solver. Call once, after the placements. */
  seed(): i32 {
    const dim = this.config.bodies * 6;
    if (this.solver.setState(0.0, this.buffer.subarray(1, 1 + dim)) != 0) return -1;
    return 0;
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
      resolve(this.contacts, this.body, this.params, this.sleep, this.config.bias, h);
      const dim = this.config.bodies * 6;
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
    const dim = this.config.bodies * 6;
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
      this.sleep.counter[i] += 1;
      if (this.sleep.counter[i] < this.sleep.frames) continue;
      const average = this.travel[i] / (<f64>this.sleep.counter[i] * span);
      if (average < threshold) {
        this.sleep.asleep[i] = 1;
        // Zeroed here, and the derivative keeps it zero: this is what makes the
        // acid test's "kinetic energy is exactly 0" an equality.
        this.body.setVel(i, 0.0, 0.0, 0.0);
      }
      // Either way the window rolls: slept bodies stop being counted at the top
      // of the loop, and a body that did not sleep starts a fresh window.
      this.travel[i] = 0.0;
      this.sleep.counter[i] = 0;
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
    const count = this.config.bodies;
    const slop = this.config.slop;
    for (let a = 0; a < count; a++) {
      const a_asleep = this.sleep.isAsleep(a);
      for (let b = a + 1; b < count; b++) {
        // Two sleepers: neither can move, so the pair is not a contact and the
        // generator's arithmetic is the pair loop's whole cost. One array read
        // per pair, per sub-step — and the only place sleeping saves anything.
        if (a_asleep && this.sleep.isAsleep(b)) continue;
        this.contacts.sphereSphere(this.body, this.params, a, b, slop);
      }
      const px = this.body.pos(a, 0), py = this.body.pos(a, 1), pz = this.body.pos(a, 2);
      const extent = this.config.extent;
      // Floor (interior above y = 0), then the four walls: `inside` says which
      // way the container's interior lies, and `distance` how far inside it is.
      this.contacts.spherePlane(this.body, this.params, a, 1, 1.0, py, slop);
      this.contacts.spherePlane(this.body, this.params, a, 0, 1.0, px + extent, slop);
      this.contacts.spherePlane(this.body, this.params, a, 0, -1.0, extent - px, slop);
      this.contacts.spherePlane(this.body, this.params, a, 2, 1.0, pz + extent, slop);
      this.contacts.spherePlane(this.body, this.params, a, 2, -1.0, extent - pz, slop);
    }
  }

  /**
   * One motion entry per body, committed by the caller.
   *
   * Positions only: this model has no angular state, so a body keeps the
   * orientation it was submitted with. A rolling orientation would be a
   * kinematic face on a linear model — pleasant to look at and not what the
   * simulation computed — which is why the layer does not paint one.
   */
  pose(batch: MotionBatch): void {
    const scale: f32 = <f32>this.config.meshScale;
    for (let i = 0; i < this.config.bodies; i++) {
      batch.setFromState(<u32>i, this.config.firstRenderableId + <u32>i, this.buffer,
                         1 + i * 3, 1 + i * 3 + 1, 1 + i * 3 + 2, scale);
    }
  }

  /** Sum of ½·m·|v|² over the bodies — the number the acid test bounds. */
  kineticEnergy(): f64 {
    let total = 0.0;
    for (let i = 0; i < this.config.bodies; i++) {
      const vx = this.body.vel(i, 0), vy = this.body.vel(i, 1), vz = this.body.vel(i, 2);
      const mass = this.params.invMass[i] > 0.0 ? 1.0 / this.params.invMass[i] : 0.0;
      total += 0.5 * mass * (vx * vx + vy * vy + vz * vz);
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
