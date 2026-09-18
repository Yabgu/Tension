// examples/world/game.ts — a world-source demo: the scene is DATA.
//
// The guest embeds a world (oscillator.yaml, the canonical authored form)
// as a YAML string, hands it to Solver.create with source: "world", and
// defines no derivative at all: the host compiles the world and the
// evaluator in tension-core supplies f(t, y). The callbacks argument is
// omitted — a world-source solver has none.

import { print, Solver, SolverConfig } from "tension-framework";

// The same YAML bytes as oscillator.yaml. Guests cannot read files: a real
// build would embed this with a packer; here the two copies are kept
// identical by hand (README.md).
const worldYaml = `
version: 1
dimensions: 2
components:
  - name: pivot
    type: anchor
    position: [0.0, 0.0]
  - name: bob
    type: point_mass
    mass: 1.0
    position: [2.0, 0.0]
    velocity: [0.0, 0.0]
connections:
  - name: spring_1
    type: spring
    from: pivot
    to: bob
    stiffness: 1.0
    rest_length: 1.0
`;

// source: "world" — the config carries the YAML itself and states no dim
// (the host derives it from the compiled world). The callbacks argument is
// omitted at create below: a world-source solver has none.
const config = new SolverConfig();
config.method = "rk45";
config.source = "world";
config.world = worldYaml;
config.relTol = 1e-10;
config.absTol = 1e-12;

export function _start_game(): void {
  print("=== TensionCore world demo: a YAML spring, integrated by rk45 ===");

  const s = Solver.create(config); // no callbacks: the world is the f
  if (s == null) {
    print("solver create failed");
    return;
  }

  // The YAML's authored position/velocity are the initial state, and the
  // evaluator reads the current state from the state vector — so the guest
  // seeds it to match: bob at [2, 0], at rest. dim = 4: x, y, vx, vy.
  const state = new Float64Array(5); // [t, x, y, vx, vy]
  state[1] = 2.0;
  if (s.setState(0.0, state.subarray(1)) != 0) {
    print("setState failed");
    s.destroy();
    return;
  }

  // 31 steps of 0.1: t lands just past pi, where the bob has swung back
  // through the rest position at x = 1.
  for (let i = 0; i < 31; i++) {
    if (s.step(0.1) != 0) {
      print("step failed");
      s.destroy();
      return;
    }
  }

  if (s.state(state) < 0) {
    print("state failed");
    s.destroy();
    return;
  }

  const t = state[0];
  const x = state[1];
  const v = state[3];
  const exactX = 1.0 + Math.cos(t);
  const exactV = -Math.sin(t);

  print("t  = " + t.toString());
  print("y0 = " + x.toString() + "   (analytic: 1 + cos(t) = " + exactX.toString() + ")");
  print("y1 = " + v.toString() + "   (analytic: -sin(t) = " + exactV.toString() + ")");

  // Self-check: the example verifies itself, it does not just print.
  const worst = Math.max(Math.abs(x - exactX), Math.abs(v - exactV));
  if (worst < 1e-8) {
    print("match: |err| = " + worst.toString());
  } else {
    print("MISMATCH: delta = " + worst.toString());
  }
  s.destroy();
  print("--- end ---");
}
