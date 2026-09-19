# The solver examples

Three guests written against the solver's ABI
(`tension-solver/GUEST_ABI.md`), in growing order of what they ask of it.
Each one is a standalone npm project — its own `package.json`, `node_modules`,
and `build` / `start` scripts — so `cd` into it and run `./run.sh` or
`npm start`.

- **`wasm/`** — the smallest `source: "wasm"` guest: **rk45 on y' = −y** with
  the analytic answer printed beside the numerical one (y(1) vs e⁻¹). This is
  where the callback convention lives — `_derivative`, `deriv_buf_in`,
  `deriv_buf_out`, and the `SolverConfig` object — and it is the file to copy
  when starting a guest of your own.

- **`world/`** — the same solver with **no derivative in the guest at all**: a
  harmonic-oscillator scene authored as YAML, compiled host-side, and
  integrated through `source: "world"`. It shows what the world source means
  to a guest — you write a scene, `dim` is derived for you, and the host's
  evaluator is the f. `oscillator.yaml` is the canonical authored form; the
  guest embeds the same bytes because guests cannot read files.

- **`collision/`** — physics a game would want: **two soft spheres, gravity,
  and a square wall**, integrated by rk45 through `source: "wasm"`. The run
  records a CSV every 0.1 s and renders an animated GIF with gnuplot. It shows
  contact, bounce, and damping, and why a soft-spring contact model suits an
  explicit integrator: the right-hand side stays continuous, so nothing has to
  detect the moment of impact. Heavier than the other two — it needs gnuplot.

Read them in that order: `wasm/` is the contract, `world/` is the same
contract with the physics moved host-side, `collision/` is the contract with
real dynamics and a renderer attached.
