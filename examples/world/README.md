# examples/world — a scene authored as YAML, run through `source: "world"`

This example demonstrates the world path end to end: a scene written in
the vocabulary of `tension-world/schema.yaml`, compiled to the binary
format of `tension-world/DESIGN.md`, evaluated by the host-side
evaluator, and integrated by the solver through `source: "world"`. The
guest defines **no derivative** — the world *is* the f(t, y) — and calls
`Solver.create` with the config alone.

## Run it

    npm install     # once: gets asc and the framework
    npm run build   # asc game.ts -> build/game.wasm
    ./run.sh        # (or npm start)

The last line of the output is a self-check: the guest compares its final
state against the analytic solution and prints `match` or
`MISMATCH: delta=...`.

## The scene

`oscillator.yaml` is the canonical authored form — the file you would
write by hand (and, in a real build, the input to a packer):

```yaml
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
```

A pivot (anchor) at the origin, a bob (point_mass, mass 1) one unit
beyond the spring's rest length, and a spring (k = 1, rest = 1) between
them. The bob's displacement from rest, q = x − 1, obeys
q″ = −(k/m)·q = −q, so with q(0) = 1, q′(0) = 0:

    x(t) = 1 + cos(t),   v(t) = −sin(t)

The guest advances 31 steps of dt = 0.1 (t lands just past π, where the
bob has swung back through the rest position at x = 1) and checks its
state against those formulas at the achieved t.

## Why the YAML is also in the .ts

The YAML lives in the guest as a template literal because a guest cannot
read files: a game's world would be embedded by a packer into the module
or the resource set, and the `.yaml` file here is the canonical authored
form that a packer would consume. The two copies are kept identical by
hand in this example.

## Where the pieces are documented

- The guest ABI (`Solver.create`, configs, errors): `tension-solver/GUEST_ABI.md`
- The world's vocabulary: `tension-world/schema.yaml`
- The world's binary format and the evaluator's force conventions: `tension-world/DESIGN.md` (§12)
