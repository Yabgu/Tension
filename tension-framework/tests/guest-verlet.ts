// P0 (chunk 6a): does the solver capability actually deliver velocity Verlet
// to a guest?
//
// `tension-solver/GUEST_ABI.md` §7 says verlet and implicit_euler "return
// -ENOSYS from create". `tension-solver/src/tension_solver.c` sizes and
// dispatches both, `build.sh` compiles the symplectic module, and the P6 tests
// exist. One of those is stale, and chunk 6's whole integrator choice rests on
// which — Verlet is the fixed-step, two-evaluation, symplectic method an
// impulse-driven physics loop wants, and rk45 is the fallback with a three-fold
// cost model.
//
// So this asks the question where it matters: through the guest boundary, with
// a real config, real callbacks and a real step, rather than by reading the
// dispatch table. The check is arithmetic, not "it did not throw": a body
// dropped from y = 10 for 60 steps of 1/60 s must land at
// 10 − ½·9.81 ≈ 5.0950 with v = −9.81 (velocity Verlet is exact for constant
// acceleration), which is what says the method ran rather than merely existed.
//
// The shape follows the framework's other fixtures: print OK, exit 0
// (`tension-framework/tests/run.sh`).

import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../assembly/runtime";
import { Solver, SolverConfig } from "../assembly/solver";

const DT: f64 = 1.0 / 60.0;
const GRAVITY: f64 = -9.81;
const FRAMES: i32 = 60;
const DROP_HEIGHT: f64 = 10.0;
/** What the drop must produce, and how far off it may be. */
const EXPECTED_Y: f64 = DROP_HEIGHT - 0.5 * 9.81;
const EXPECTED_V: f64 = GRAVITY;
const TOLERANCE: f64 = 1e-9;

// The two callback buffers: 64 KiB each in the guest's own memory, the
// addresses the host writes and reads through (GUEST_ABI.md §3.6).
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);
export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

/// Verlet's convention (`tension-solver/DESIGN.md` §10): the state is `[q, v]`
/// — the first `dim/2` slots are positions, the last `dim/2` velocities — and
/// the derivative returns `[q', v'] = [v, a]`. Dim 6 is one body in 3D: three
/// positions, three velocities.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  const half = len / 2;
  if (dyCap < len || half < 3) return -22; // -EINVAL
  for (let i = 0; i < half; i++) {
    store<f64>(dyPtr + <usize>i * 8, load<f64>(yPtr + <usize>(half + i) * 8)); // q' = v
  }
  store<f64>(dyPtr + <usize>half * 8, 0.0);
  store<f64>(dyPtr + <usize>(half + 1) * 8, GRAVITY);
  store<f64>(dyPtr + <usize>(half + 2) * 8, 0.0);
  return 0;
}

export function _start_game(): void {
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("FAIL session_open");
    assert(false, "session_open refused");
  }

  const config = new SolverConfig();
  config.method = "verlet";
  config.source = "wasm";
  config.dim = 6;
  const solver = Solver.create(config, {
    derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out,
  });
  if (solver == null) {
    print("FAIL create(method=verlet, source=wasm, dim=6) returned no solver");
    assert(false, "verlet refused by create");
  }
  print("P0 create(method=verlet, source=wasm, dim=6) -> a solver id");

  // [t, x, y, z, vx, vy, vz]: dropped from ten units up, at rest.
  const state = new Float64Array(7);
  state[1] = 0.0;
  state[2] = DROP_HEIGHT;
  state[3] = 0.0;
  if (solver!.setState(0.0, state.subarray(1)) != 0) {
    print("FAIL setState refused the seed");
    assert(false, "setState refused");
  }

  for (let frame: i32 = 0; frame < FRAMES; frame++) {
    if (solver!.step(DT) != 0) {
      print("FAIL step refused at frame " + frame.toString());
      assert(false, "step refused");
    }
  }
  if (solver!.state(state) < 0) {
    print("FAIL state refused the read");
    assert(false, "state refused");
  }
  solver!.destroy();

  const y = state[2], vy = state[5];
  const dy = abs(y - EXPECTED_Y), dv = abs(vy - EXPECTED_V);
  print("P0 after " + FRAMES.toString() + " steps of 1/60 s: y=" + y.toString() + " (expected " +
        EXPECTED_Y.toString() + "), vy=" + vy.toString() + " (expected " +
        EXPECTED_V.toString() + ")");
  print("P0 |dy|=" + dy.toString() + " |dv|=" + dv.toString() + " tolerance=" +
        TOLERANCE.toString());
  if (dy > TOLERANCE || dv > TOLERANCE) {
    print("FAIL verlet ran but is not velocity Verlet: the drop does not match the closed form");
    assert(false, "wrong integrator");
  }

  if (RuntimeSession.close() != 0) {
    print("FAIL session_close");
    assert(false, "session_close refused");
  }
  print("OK verlet from a guest: dim=6, 60 steps, exact constant-acceleration drop");
}
