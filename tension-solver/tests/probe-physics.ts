// probe-physics.ts — P1b (chunk 6a): the guest's own numbers.
//
// P1a measured the solver through its C ABI with a C derivative. This measures
// the same loop from inside a guest, where chunk 6 will actually run, and it
// answers the three questions the design turns on:
//
//   A. Does writing the state back between steps perturb the integration?
//      One body thrown upward, sixty steps, three ways: untouched, with a
//      state() + set_state() every step, and with the solver destroyed and
//      recreated every step (the alternative if the write path were unsafe).
//      The apex is compared against v0^2 / (2g) and against each other.
//   B. What does the impulse response actually produce? Sixteen and 256
//      spheres dropped into a box: penetration at rest, jitter at rest,
//      settling frame, kinetic energy at frame 60.
//   C. What does detection cost, and how many derivative calls does a frame
//      make? Brute force at N = 16/64/256/1024, and the derivative count at
//      K = 1, 2, 4 sub-steps.
//
// The guest has no clock, so every cost is expressed in *renderer frames*: the
// run uses the null renderer, whose frame counter is the only timebase a guest
// has, and at frameHz 60 one frame is 1/60 s. That is the same instrument
// `guest-motion.ts` measures its throughput with.
//
// Build and run (from the repo root):
//   tension-framework/node_modules/.bin/asc tension-solver/tests/probe-physics.ts \
//       --config tension-framework/build/session.asconfig.json \
//       -o tension-solver/build/probe-physics/probe-physics.wasm
//   tension-core/target/debug/tension-core \
//       --capability tension-ogre/build/libtension_ogre.so \
//       tension-solver/build/probe-physics/probe-physics.wasm --renderer=null

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import { Solver, SolverConfig } from "../../tension-framework/assembly/solver";
import * as ogre from "../../tension-framework/assembly/ogre";

const DT: f64 = 1.0 / 60.0;
const GRAVITY: f64 = -9.81;
const FRAMES: i32 = 60;
const THROW_SPEED: f64 = 10.0; // m/s upward, from level with the ground
const APEX_ANALYTIC: f64 = (THROW_SPEED * THROW_SPEED) / (2.0 * 9.81);

// The world (experiment B). Chunk 6's proposed parameters: spheres, a box, a
// restitution low enough to settle inside a second, friction, and a positional
// bias small enough not to add energy.
const RADIUS: f64 = 0.1;
const RESTITUTION: f64 = 0.3;
const FRICTION: f64 = 0.4;
const BIAS: f64 = 0.2; // fraction of the penetration corrected per sub-step
const SLOP: f64 = 1.0e-3; // penetration left alone rather than corrected
const BOX: f64 = 4.0; // walls at ±BOX in x and z, the floor at y = 0
/** How wide a footprint the bodies are dropped into, so they pile up. */
const PILE_ACROSS: f64 = 2.0;
/** How many bodies share each column: what makes the pile touch itself. */
const LAYERS: i32 = 4;
const SUBSTEPS: i32 = 2;

// The solver's two callback buffers (GUEST_ABI.md §3.6).
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);
export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

let derivative_calls: i64 = 0;

/// Verlet's convention: [q, v], the first dim/2 slots positions and the last
/// dim/2 velocities; the derivative returns [v, a] with a = gravity.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  derivative_calls += 1;
  if (dyCap < len) return -22; // -EINVAL
  const half = len / 2;
  for (let i = 0; i < half; i++) {
    store<f64>(dyPtr + <usize>i * 8, load<f64>(yPtr + <usize>(half + i) * 8)); // q' = v
  }
  for (let i = half; i < len; i++) {
    const axis = i - half;
    store<f64>(dyPtr + <usize>i * 8, axis % 3 == 1 ? GRAVITY : 0.0); // only y falls
  }
  return 0;
}

function make_solver(dim: i32): Solver | null {
  const config = new SolverConfig();
  config.method = "verlet";
  config.source = "wasm";
  config.dim = dim;
  config.fixedStep = DT;
  return Solver.create(config, {
    derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out,
  });
}

// ── A. the state-write experiment ────────────────────────────────────────

/// One body thrown straight up, sixty steps, the apex it reached. `writes`
/// selects what happens between steps: nothing, a state() + set_state() of the
/// state as read, or a full recreate (destroy, create, set_state).
function throw_and_measure(writes: bool, recreate: bool): f64 {
  const dim = 6; // one body: [x, y, z, vx, vy, vz]
  let solver = make_solver(dim);
  if (solver == null) return -1.0;

  const state = new Float64Array(7); // [t, y...]
  const body = new Float64Array(dim);
  body[1] = 0.0;
  body[4] = THROW_SPEED;
  if (solver!.setState(0.0, body) != 0) return -1.0;

  let apex = 0.0;
  for (let frame: i32 = 0; frame < FRAMES; frame++) {
    if (solver!.step(DT) != 0) return -1.0;
    if (solver!.state(state) < 0) return -1.0;
    if (state[2] > apex) apex = state[2];
    if (!writes) continue;
    for (let i = 0; i < dim; i++) body[i] = state[i + 1];
    if (recreate) {
      solver!.destroy();
      solver = make_solver(dim);
      if (solver == null) return -1.0;
    }
    if (solver!.setState(state[0], body) != 0) return -1.0;
  }
  solver!.destroy();
  return apex;
}

function experiment_a(): void {
  const untouched = throw_and_measure(false, false);
  const written = throw_and_measure(true, false);
  const recreated = throw_and_measure(true, true);
  const d_written = abs(written - untouched) / apex_scale(untouched);
  const d_recreated = abs(recreated - untouched) / apex_scale(untouched);
  print("B A untouched apex      " + untouched.toString());
  print("B A written apex        " + written.toString());
  print("B A recreated apex      " + recreated.toString());
  print("B A analytic apex       " + APEX_ANALYTIC.toString());
  print("B A |written-untouched| / apex = " + (d_written * 100.0).toString() + " %");
  print("B A |recreated-untouched| / apex = " + (d_recreated * 100.0).toString() + " %");
}

/// The apex is ~v0²/2g; using the measurement itself as the denominator keeps
/// the fraction honest even if the number is wrong for a different reason.
function apex_scale(apex: f64): f64 {
  return abs(apex) > 1.0e-9 ? abs(apex) : 1.0;
}

// ── B. penetration and settling ──────────────────────────────────────────

/// A staggered drop of `count` spheres into the box, sixty frames of two
/// sub-steps each, with the response chunk 6 proposes: one normal impulse per
/// contact with restitution, one friction impulse clamped by mu·jn, and a
/// positional bias of the penetration over the sub-step. Prints what the
/// response produced: penetration at rest, jitter at rest, the frame it
/// settled on, and the kinetic energy at the end.
function drop(count: i32, substeps: i32): void {
  const dim = count * 6;
  const solver = make_solver(dim);
  if (solver == null) {
    print("B drop " + count.toString() + ": create refused");
    return;
  }
  const state = new Float64Array(dim + 1);
  const y = new Float64Array(dim);

  // Staggered: a grid with a little spread, dropped from a range of heights, so
  // they do not all arrive at once and the pile is not a stack.
  // A pile, not a carpet: `LAYERS` bodies stacked in each column, dropped from
  // low enough that the whole thing settles inside the acid test's sixty
  // frames. Bodies that land beside each other never touch, which is why the
  // first two versions of this experiment measured only the floor path; the
  // stacked ones are what exercises sphere against sphere.
  const columns = <i32>Math.ceil(<f64>Math.sqrt(<f64>(count / LAYERS)));
  const spacing = PILE_ACROSS / <f64>columns;
  const velocity_base = count * 3; // the state is [q, v]: positions first
  for (let b = 0; b < count; b++) {
    const layer = b % LAYERS;
    const column = b / LAYERS;
    const ix = column % columns, iz = column / columns;
    y[b * 3 + 0] = -PILE_ACROSS * 0.5 + (0.5 + <f64>ix) * spacing;
    y[b * 3 + 1] = RADIUS + 0.25 + <f64>layer * (2.2 * RADIUS);
    y[b * 3 + 2] = -PILE_ACROSS * 0.5 + (0.5 + <f64>iz) * spacing;
    for (let k = 0; k < 3; k++) y[velocity_base + b * 3 + k] = 0.0;
  }
  if (solver!.setState(0.0, y) != 0) {
    print("B drop " + count.toString() + ": setState refused");
    return;
  }

  const substep = DT / <f64>substeps;
  let settled_frame: i32 = -1;
  let max_pen = 0.0, max_speed = 0.0, ke = 0.0;
  let pair_contacts = 0;
  const started = ogre.frameCount();

  for (let frame: i32 = 0; frame < FRAMES; frame++) {
    for (let k = 0; k < substeps; k++) {
      if (solver!.step(substep) != 0) {
        print("B drop " + count.toString() + ": step refused at frame " + frame.toString());
        return;
      }
      if (solver!.state(state) < 0) return;
      for (let i = 0; i < dim; i++) y[i] = state[i + 1];
      resolve_contacts(y, count, substep);
      if (solver!.setState(state[0], y) != 0) return;
    }

    // Measurements, once per frame, on the state the response just wrote.
    max_pen = 0.0;
    max_speed = 0.0;
    ke = 0.0;
    pair_contacts = 0;
    for (let b = 0; b < count; b++) {
      const px = y[b * 3 + 0], py = y[b * 3 + 1], pz = y[b * 3 + 2];
      const vx = y[velocity_base + b * 3 + 0], vy = y[velocity_base + b * 3 + 1],
            vz = y[velocity_base + b * 3 + 2];
      max_speed = Math.max(max_speed, Math.sqrt(vx * vx + vy * vy + vz * vz));
      ke += 0.5 * (vx * vx + vy * vy + vz * vz);
      const wall_pen = RADIUS - py;
      if (wall_pen > max_pen) max_pen = wall_pen;
      const side_pen = abs(px) + RADIUS - BOX;
      if (side_pen > max_pen) max_pen = side_pen;
      const zside_pen = abs(pz) + RADIUS - BOX;
      if (zside_pen > max_pen) max_pen = zside_pen;
      for (let other = b + 1; other < count; other++) {
        const dx = y[other * 3 + 0] - px, dy = y[other * 3 + 1] - py,
              dz = y[other * 3 + 2] - pz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const overlap = RADIUS * 2.0 - dist;
        if (overlap > SLOP) pair_contacts += 1;
        if (overlap > max_pen) max_pen = overlap;
      }
    }
    if (settled_frame < 0 && max_speed < 0.05) settled_frame = frame;
  }

  RuntimeSession.wait(16); // pump the session once, or the frame count is frozen
  const frames = <i32>(ogre.frameCount() - started);
  print("B drop N=" + count.toString() + " (K=" + substeps.toString() + ", e=" +
        RESTITUTION.toString() + ", mu=" + FRICTION.toString() + "):");
  print("B   max penetration at rest   " + max_pen.toString() + " m (radius " +
        RADIUS.toString() + ")");
  print("B   max |v| at frame " + FRAMES.toString() + "       " + max_speed.toString() + " m/s");
  print("B   sphere-sphere contacts at rest " + pair_contacts.toString());
  print("B   settling frame (|v|<0.05) " + settled_frame.toString() + " of " +
        FRAMES.toString());
  print("B   total KE at frame " + FRAMES.toString() + "     " + ke.toString());
  print("B   wall clock                " + frames.toString() + " renderer frames (" +
        (<f64>frames / 60.0).toString() + " s at 60 Hz for the guest loop's " +
        (substeps * FRAMES).toString() + " sub-steps of " + count.toString() + " bodies)");
  solver!.destroy();
}

/// One impulse pass over every contact: spheres against the floor and the four
/// walls, then sphere against sphere. The normal impulse carries restitution,
/// the tangential one is clamped by Coulomb friction, and the positional part
/// is a velocity bias proportional to the penetration — Baumgarte's shape,
/// which is what keeps a settled pile from sinking through the floor.
///
/// The state is Verlet's `[q, v]`: **every body's position first, then every
/// body's velocity** — not interleaved per body. Body `b`'s positions are at
/// `3b..3b+2` and its velocities at `3N + 3b .. 3N + 3b + 2`. This probe's first
/// version read the state as interleaved and launched a body at 225 m/s; the
/// layout is exactly the kind of thing a physics layer exists to hide, which is
/// why chunk 6's SDK has a `World` rather than asking every game to remember it.
function resolve_contacts(y: Float64Array, count: i32, dt: f64): void {
  const velocity_base = count * 3;
  for (let b = 0; b < count; b++) {
    const px = y[b * 3 + 0], py = y[b * 3 + 1], pz = y[b * 3 + 2];
    plane_contact(y, b, velocity_base, 1, 1.0, py, dt);    // floor: interior above y = 0
    plane_contact(y, b, velocity_base, 0, 1.0, px + BOX, dt);  // -x wall
    plane_contact(y, b, velocity_base, 0, -1.0, BOX - px, dt); // +x wall
    plane_contact(y, b, velocity_base, 2, 1.0, pz + BOX, dt);  // -z wall
    plane_contact(y, b, velocity_base, 2, -1.0, BOX - pz, dt); // +z wall
    for (let other = b + 1; other < count; other++) {
      sphere_contact(y, b, other, velocity_base, dt);
    }
  }
}

/// One body against one axis-aligned plane. `inside` is +1 when the box's
/// interior is at larger coordinates along `axis` (the floor, the -x wall) and
/// -1 when it is at smaller ones (+x); `distance` is how far inside the plane
/// the body's centre is, so the sphere is in contact when that is below the
/// radius.
///
/// The contact normal — the direction that separates the body from the wall —
/// is `inside`, pointing *into* the box: the impulse has to push the body back
/// inside, and getting that backwards is an energy pump rather than a bounce.
///
/// The normal impulse aims for a separating speed of `max(bias, -e*vn)` and
/// only ever pushes: a body already leaving faster than that is left alone,
/// which is what keeps one pass from adding energy to a settled pile.
function plane_contact(y: Float64Array, body: i32, velocity_base: i32, axis: i32, inside: f64,
                       distance: f64, dt: f64): void {
  const penetration = RADIUS - distance;
  if (penetration <= SLOP) return;
  const at = velocity_base + body * 3 + axis;
  const vn = y[at] * inside; // positive = moving away from the wall
  const bias = BIAS * (penetration - SLOP) / dt;
  const desired = Math.max(bias, -RESTITUTION * vn);
  if (vn >= desired) return;
  const dv = desired - vn;
  y[at] += dv * inside;
  const mu = FRICTION * dv; // the normal impulse, in these units
  const body_at = velocity_base + body * 3;
  for (let k = 0; k < 3; k++) {
    if (k == axis) continue;
    const tangential = y[body_at + k];
    const change = Math.min(abs(tangential), mu) * (tangential < 0.0 ? 1.0 : -1.0);
    y[body_at + k] += change;
  }
}

/// One body against another. Equal masses, so the relative velocity along the
/// normal changes by the full impulse and each body takes half of it; the
/// normal points from `a` to `b`, so a positive `vn` means they are separating.
function sphere_contact(y: Float64Array, a: i32, b: i32, velocity_base: i32, dt: f64): void {
  const dx = y[b * 3 + 0] - y[a * 3 + 0];
  const dy = y[b * 3 + 1] - y[a * 3 + 1];
  const dz = y[b * 3 + 2] - y[a * 3 + 2];
  const dist2 = dx * dx + dy * dy + dz * dz;
  const reach = RADIUS * 2.0;
  if (dist2 >= reach * reach || dist2 <= 1.0e-18) return;
  const dist = Math.sqrt(dist2);
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  const penetration = reach - dist;
  if (penetration <= SLOP) return;
  const a_at = velocity_base + a * 3, b_at = velocity_base + b * 3;
  const rvx = y[b_at + 0] - y[a_at + 0];
  const rvy = y[b_at + 1] - y[a_at + 1];
  const rvz = y[b_at + 2] - y[a_at + 2];
  const vn = rvx * nx + rvy * ny + rvz * nz;
  const bias = BIAS * (penetration - SLOP) / dt;
  const desired = Math.max(bias, -RESTITUTION * vn);
  if (vn >= desired) return;
  const dv = (desired - vn) * 0.5;
  y[a_at + 0] -= dv * nx;
  y[a_at + 1] -= dv * ny;
  y[a_at + 2] -= dv * nz;
  y[b_at + 0] += dv * nx;
  y[b_at + 1] += dv * ny;
  y[b_at + 2] += dv * nz;
  // Friction between the two, the same clamp: tangential speed loses at most
  // mu times the normal impulse.
  const mu = FRICTION * dv * 2.0;
  const tx = rvx - vn * nx, ty = rvy - vn * ny, tz = rvz - vn * nz;
  const tlen = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tlen > 1.0e-12) {
    const scale = Math.min(tlen, mu) / tlen * 0.5;
    y[a_at + 0] += tx * scale;
    y[a_at + 1] += ty * scale;
    y[a_at + 2] += tz * scale;
    y[b_at + 0] -= tx * scale;
    y[b_at + 1] -= ty * scale;
    y[b_at + 2] -= tz * scale;
  }
}

// ── C. detection cost, and derivative calls per frame ────────────────────

/// Brute-force pair detection over `count` bodies, run `repeats` times: the
/// cost of the pass chunk 6 starts with, in milliseconds per pass. The timing
/// is the renderer's frame counter, because a guest has no clock — the loop is
/// inline rather than passed as a closure, which AssemblyScript does not have.
function detection_cost(count: i32, repeats: i32): void {
  const y = new Float64Array(count * 6);
  for (let i = 0; i < count; i++) {
    // Closer together than one diameter, so the pass actually finds contacts
    // rather than only rejecting pairs.
    y[i * 6 + 0] = <f64>(i % 16) * 0.15;
    y[i * 6 + 1] = 1.0;
    y[i * 6 + 2] = <f64>(i / 16) * 0.15;
  }
  let contacts = 0;
  const before = ogre.frameCount();
  for (let r = 0; r < repeats; r++) {
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const dx = y[b * 6 + 0] - y[a * 6 + 0], dy = y[b * 6 + 1] - y[a * 6 + 1],
              dz = y[b * 6 + 2] - y[a * 6 + 2];
        const dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 < 4.0 * RADIUS * RADIUS) contacts += 1;
      }
    }
  }
  RuntimeSession.wait(16); // a frame boundary after the work, so the count sees it
  const frames = <i32>(ogre.frameCount() - before);
  const per_pass_ms = <f64>frames * (1000.0 / 60.0) / <f64>repeats;
  print("C detection brute force N=" + count.toString() + ": " + per_pass_ms.toString() +
        " ms/pass over " + repeats.toString() + " passes (" + frames.toString() +
        " renderer frames, " + contacts.toString() + " contacts seen)");
}

/// How many derivative calls one renderer frame's worth of physics costs, at K
/// sub-steps: exact, because the callback counts itself.
function derivative_calls_per_frame(count: i32, substeps: i32): void {
  const solver = make_solver(count * 6);
  if (solver == null) return;
  const y = new Float64Array(count * 6);
  for (let b = 0; b < count; b++) y[b * 6 + 1] = 1.0 + <f64>b * 0.01;
  solver!.setState(0.0, y);
  derivative_calls = 0;
  const frames = <i32>FRAMES / 10;
  for (let frame = 0; frame < frames; frame++) {
    for (let k = 0; k < substeps; k++) solver!.step(DT / <f64>substeps);
  }
  print("C derivative calls N=" + count.toString() + " K=" + substeps.toString() + ": " +
        (<f64>derivative_calls / <f64>frames).toString() + " per frame (" +
        derivative_calls.toString() + " over " + frames.toString() + " frames)");
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
  print("PHYSICS probe (P1b): renderer=" + renderer + ", frameHz 60, dt 1/60, guest-side");

  experiment_a();
  drop(16, 1);
  drop(16, 2);
  drop(16, 4);
  drop(256, 2);
  detection_cost(16, 4000);
  detection_cost(64, 1000);
  detection_cost(256, 200);
  detection_cost(1024, 40);
  derivative_calls_per_frame(256, 1);
  derivative_calls_per_frame(256, 2);
  derivative_calls_per_frame(256, 4);

  ogre.shutdown();
  RuntimeSession.close();
  print("OK P1b complete");
}
