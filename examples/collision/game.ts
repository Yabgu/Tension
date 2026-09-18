// examples/collision/game.ts — two soft spheres in a square wall.
//
// The physics is a *soft-spring* contact model: circles push each other apart
// with a spring whose force grows with penetration (K_CC), and the wall does
// the same, softer (K_WALL). Nothing detects events and nothing applies
// impulses — the right-hand side is a continuous function of the state (C¹ in
// force; acceleration has a kink at the contact boundary, which rk45 steps
// through by shrinking its step). Visible overlap during a contact is the
// model working, not a bug. A position-based solver (spook) or an impulse
// solver would resolve contacts to zero overlap, but those need the
// constraint channel that is deferred — tension-solver/DESIGN.md §10.
//
// The solver owns the state; the guest supplies f(t, y). State layout, dim 8:
//
//   [x0, y0, vx0, vy0,  x1, y1, vx1, vy1]
//
// Static per-sphere props (radius, mass) live OUTSIDE the state, in a small
// buffer set once before the run: the solver never integrates them.
//
// Output: one CSV row per 0.1 s of sim time. The first lines start with '#'
// so gnuplot treats them as comments; the rows are pure numbers:
//
//   # t x0 y0 r0 x1 y1 r1
//
// The radius columns repeat the constant radius on every row because
// gnuplot's `with circles` style wants x:y:radius per circle. run.sh pipes
// stdout to positions.dat and renders collision.gif from it.

import { print, Solver, SolverConfig } from "tension-framework";

// Two non-overlapping 64 KiB regions in linear memory, aligned to f64.
// The host writes y into BUF_IN before each _derivative call and reads dy
// from BUF_OUT after — the copy-in / copy-out convention of GUEST_ABI.md §3.6.
const BUF_IN:  usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);

export function deriv_buf_in():  i32 { return i32(BUF_IN);  }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

// ── model constants ──────────────────────────────────────────────────────

const GRAVITY: f64 = -9.81;   // downward acceleration (mass does not enter)
const K_WALL:  f64 = 200.0;   // wall spring: softer than the circle spring,
                              // so wall contact looks smooth rather than snappy
const K_CC:    f64 = 800.0;   // circle-circle spring
const DAMPING: f64 = 2.0;     // velocity damping along the contact normal
                              // (the model's soft springs return almost all
                              // of a contact's energy; at a token 0.5 the
                              // spheres bounce forever and never settle)
                              // spheres settle instead of buzzing
const WALL:    f64 = 5.0;     // half-width of the square: walls at ±5
const EPSILON: f64 = 1e-10;   // guards the normal when two centres coincide

// ── static per-sphere props (set once, never integrated) ─────────────────

@unmanaged
class SphereProps {
  r: f64;
  m: f64;
}

// offsetof<SphereProps>() is the byte size of the layout — 16 for two f64s,
// r at 0 and m at 8 — and folds to a constant at compile time. Verified
// against the generated wasm for the pinned compiler (AS 0.28.8): the
// constant is emitted as 16. `sizeof<SphereProps>()` is *not* the same
// number there (it is the size of a reference, 4), so it is not used.
const PROPS_STRIDE: usize = offsetof<SphereProps>();
const PROPS_BASE: usize = memory.data(<i32>PROPS_STRIDE * 2, 8);

function propsAt(i: i32): usize { return PROPS_BASE + <usize>i * PROPS_STRIDE; }

function setProps(i: i32, r: f64, m: f64): void {
  const at = propsAt(i);
  store<f64>(at, r);
  store<f64>(at + 8, m);
}

function propRadius(i: i32): f64 { return load<f64>(propsAt(i)); }
function propMass(i: i32): f64 { return load<f64>(propsAt(i) + 8); }

// ── the right-hand side ──────────────────────────────────────────────────

// f(t, y): pure — the only state it reads is the state vector (plus the
// static props, which never change during a run). Address arithmetic is the
// raw inline form of GUEST_ABI.md §3.7 (pattern 1a), like the shipped
// examples/solver/game.ts: one f64 load or store per slot.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (len < 8 || dyCap < len) return -22;
  const bodies: i32 = len >> 2; // 4 f64 slots per body

  for (let i = 0; i < bodies; i++) {
    const at: usize = <usize>i << 5; // 4 f64 = 32 bytes per body
    const x = load<f64>(yPtr + at);
    const y = load<f64>(yPtr + at + 8);
    const vx = load<f64>(yPtr + at + 16);
    const vy = load<f64>(yPtr + at + 24);
    const r = propRadius(i);
    const m = propMass(i);

    // 1. gravity: an acceleration, not a force — mass does not enter.
    let ax = 0.0;
    let ay = GRAVITY;

    // 2. walls: four soft springs, one per side. The spring term grows with
    // penetration (so a body cannot escape); the damping term always opposes
    // the velocity on that axis, whichever wall it is.
    const right = (x + r) - WALL;
    if (right > 0.0) {
      ax -= K_WALL * right / m;
      ax -= DAMPING * vx / m;
    }
    const left = (-x + r) - WALL;
    if (left > 0.0) {
      ax += K_WALL * left / m;
      ax -= DAMPING * vx / m;
    }
    const top = (y + r) - WALL;
    if (top > 0.0) {
      ay -= K_WALL * top / m;
      ay -= DAMPING * vy / m;
    }
    const bottom = (-y + r) - WALL;
    if (bottom > 0.0) {
      ay += K_WALL * bottom / m;
      ay -= DAMPING * vy / m;
    }

    // 3. circle-circle: one soft spring per pair, plus damping along the
    // contact normal. The pair force is applied to i here and to j on j's
    // own pass through this loop.
    for (let j = 0; j < bodies; j++) {
      if (j == i) continue;
      const bt: usize = <usize>j << 5;
      const dx = x - load<f64>(yPtr + bt);
      const dy = y - load<f64>(yPtr + bt + 8);
      const dist2 = dx * dx + dy * dy;
      const minDist = r + propRadius(j);
      if (dist2 < minDist * minDist) {
        const dist = Math.sqrt(dist2) + EPSILON;
        const penetration = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        ax += K_CC * penetration * nx / m;
        ay += K_CC * penetration * ny / m;
        const vrel = (vx - load<f64>(yPtr + bt + 16)) * nx
                   + (vy - load<f64>(yPtr + bt + 24)) * ny;
        ax -= DAMPING * vrel * nx / m;
        ay -= DAMPING * vrel * ny / m;
      }
    }

    // 4. d/dt [x, y] = [vx, vy]; d/dt [vx, vy] = [ax, ay].
    store<f64>(dyPtr + at, vx);
    store<f64>(dyPtr + at + 8, vy);
    store<f64>(dyPtr + at + 16, ax);
    store<f64>(dyPtr + at + 24, ay);
  }
  return 0;
}

// ── the run ──────────────────────────────────────────────────────────────

const R0: f64 = 0.5;
const R1: f64 = 0.5;

/// One CSV row: t x0 y0 r0 x1 y1 r1 — state slots are [t, x, y, vx, vy] per
/// body, so body 0 starts at slot 1 and body 1 at slot 5.
function printRow(state: Float64Array): void {
  print(state[0].toString() + " " + state[1].toString() + " " + state[2].toString()
        + " " + R0.toString() + " " + state[5].toString() + " " + state[6].toString()
        + " " + R1.toString());
}

/// Every slot finite: a NaN or an Inf means the integration has broken down
/// (a division by a zero mass, a destabilised spring), and printing it would
/// only put a hole in the plot.
function stateIsFinite(state: Float64Array): bool {
  for (let i = 0; i < state.length; i++) {
    if (!isFinite(state[i])) return false;
  }
  return true;
}

export function _start_game(): void {
  print("# TensionCore collision demo: two soft spheres in a square (rk45, source: wasm)");
  print("# contact is a soft spring: the overlap you see in a collision is the model, not a bug");
  print("# t x0 y0 r0 x1 y1 r1");

  setProps(0, R0, 1.0);
  setProps(1, R1, 1.0);

  const config = new SolverConfig();
  config.method = "rk45";
  config.source = "wasm";
  config.dim = 8;
  config.relTol = 1e-6;
  config.absTol = 1e-8;

  const s = Solver.create(config, {
    derivative: _derivative,
    bufIn: deriv_buf_in,
    bufOut: deriv_buf_out,
  });
  if (s == null) {
    print("# solver create failed");
    return;
  }

  // Initial conditions: apart, falling, converging horizontally. They meet
  // near the middle, scatter, hit the walls, and settle on the floor.
  // [t, x0, y0, vx0, vy0, x1, y1, vx1, vy1]
  const state = new Float64Array(9);
  state[1] = -3.0; state[2] = 3.0; state[3] = 4.0; state[4] = 0.0;
  state[5] = 3.0;  state[6] = 1.0; state[7] = -4.0; state[8] = 0.0;

  if (s.setState(0.0, state.subarray(1)) != 0) {
    print("# setState failed");
    s.destroy();
    return;
  }

  if (s.state(state) < 0) {
    print("# state failed");
    s.destroy();
    return;
  }
  printRow(state); // t = 0

  // 80 steps of 0.1 s: 81 rows, t = 0 through 8.0 inclusive.
  for (let i = 0; i < 80; i++) {
    if (s.step(0.1) != 0) {
      print("# step failed at t = " + state[0].toString());
      s.destroy();
      return;
    }
    if (s.state(state) < 0) {
      print("# state failed");
      s.destroy();
      return;
    }
    if (!stateIsFinite(state)) {
      print("# NaN detected at t = " + state[0].toString());
      s.destroy();
      return;
    }
    printRow(state);
  }

  s.destroy();
  print("# --- end ---");
}
