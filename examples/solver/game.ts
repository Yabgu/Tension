// examples/solver/game.ts — RK45 demo: y' = -y, y(0) = [1, 2]
//
// The host drives all RK45 staging (6 evaluations per adapted step,
// Dormand-Prince tableau, PI step-size control). The guest supplies:
//   _derivative      — pure f(t, y) → dy, one call per stage
//   deriv_buf_in/out — guest-owned flat f64 regions; the host writes and
//                      reads through guest addresses, no host memory crosses

import { print, Solver, SolverConfig } from "tension-framework";

// Two non-overlapping 64 KiB regions in linear memory, aligned to f64.
// Host writes y into BUF_IN before each _derivative call,
// reads dy from BUF_OUT after.
const BUF_IN:  usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);

export function deriv_buf_in():  i32 { return i32(BUF_IN);  }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

// f(t, y) = -y, elementwise. Pure function of (y, t) — no RNG, no clocks,
// no hidden state. That is what keeps integration bit-reproducible.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  for (let i = 0; i < len; i++) {
    const offset = <usize>i << 3;
    store<f64>(dyPtr + offset, -load<f64>(yPtr + offset));
  }
  return 0;
}

export function _start_game(): void {
  print("=== TensionCore solver demo: rk45 on y' = -y ===");

  const config = new SolverConfig();
  config.method = "rk45";
  config.source = "wasm";
  config.dim = 2;
  config.relTol = 1e-8;
  config.absTol = 1e-10;

  const s = Solver.create(config, {
    derivative: _derivative,
    bufIn: deriv_buf_in,
    bufOut: deriv_buf_out,
  });
  if (s == null) {
    print("solver create failed");
    return;
  }

  // State buffer layout: [t, y0, y1]
  // t slot at index 0 is written by state() on readback; setState takes y only.
  const state = new Float64Array(3);
  state[1] = 1.0;
  state[2] = 2.0;

  // NOTE: subarray() is zero-copy — a view into the same backing buffer
  if (s.setState(0.0, state.subarray(1)) != 0) {
    print("setState failed"); s.destroy(); return;
  }

  // Ten 0.1-wide requests to reach t = 1.0; rk45 adapts step size internally.
  for (let i = 0; i < 10; i++) {
    if (s.step(0.1) != 0) {
      print("step failed"); s.destroy(); return;
    }
  }

  if (s.state(state) < 0) {
    print("state failed"); s.destroy(); return;
  }

  print("t  = " + state[0].toString());
  print("y0 = " + state[1].toString() + "   (analytic: e⁻¹  ≈ 0.36787944117144233)");
  print("y1 = " + state[2].toString() + "   (analytic: 2e⁻¹ ≈ 0.73575888234288470)");

  s.destroy();
  print("--- end ---");
}
