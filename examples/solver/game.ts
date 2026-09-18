// examples/solver/game.ts — end-to-end solver demo.
//
// The guest defines the three callbacks the `source: "wasm"` convention
// needs — `_derivative` (the right-hand side), `deriv_buf_in` and
// `deriv_buf_out` (the two buffer addresses) — and passes them to
// `Solver.create`; the host calls `_derivative` per integration stage. The
// module is built with `asc --exportTable` (package.json) so the host can
// resolve the callbacks by their indices in the exported function table;
// nothing here registers or binds anything by hand.

import { print, Solver } from "tension-framework";

// The callbacks: two non-overlapping regions of this module's linear memory
// (at least 64 KiB each), and the derivative that reads y from the input
// region and writes f(t, y) to the output region. The host copies state
// through these regions; the guest never sees a host pointer.
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);

export function deriv_buf_in(): i32 {
  return i32(BUF_IN);
}

export function deriv_buf_out(): i32 {
  return i32(BUF_OUT);
}

// f(t, y) = -y, elementwise. A pure function of (y, t): no RNG, no clocks,
// no hidden state — that is what keeps the integration bit-reproducible.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  for (let i = 0; i < len; i++) {
    store<f64>(dyPtr + (<usize>i << 3), -load<f64>(yPtr + (<usize>i << 3)));
  }
  return 0;
}

export function _start_game(): void {
  print("=== TensionCore solver demo: rk45 on y' = -y ===");
  const s = Solver.create(
    '{"method":"rk45","source":"wasm","dim":2,"parameters":{"relTol":1e-8,"absTol":1e-10}}',
    { derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out },
  );
  if (s == null) {
    print("solver create failed");
    return;
  }

  // Start at t = 0, y = [1, 2] — a checkpoint is {t, y}, and setState takes
  // the pair.
  const state = new Float64Array(3);
  state[1] = 1.0;
  state[2] = 2.0;
  if (s.setState(0.0, state.slice(1)) != 0) {
    print("setState failed");
    s.destroy();
    return;
  }

  // Advance to t = 1.0 in ten fixed requests; rk45 adapts internally.
  for (let i = 0; i < 10; i++) {
    if (s.step(0.1) != 0) {
      print("step failed");
      s.destroy();
      return;
    }
  }

  const n = s.state(state);
  if (n < 0) {
    print("state failed");
    s.destroy();
    return;
  }
  print("t  = " + state[0].toString());
  print("y0 = " + state[1].toString() + "   (analytic: e^-1 ~= 0.36787944117144233)");
  print("y1 = " + state[2].toString() + "   (analytic: 2*e^-1 ~= 0.7357588823428847)");
  s.destroy();
  print("--- end ---");
}
