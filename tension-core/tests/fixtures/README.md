# Debug fixtures — version-locked inputs

These bytes are **committed inputs to Tension's own E2E test**
(`tension-core/tests/e2e_debug.rs`). Nothing here is rebuilt at test time, and
nothing here needs TensionScript, npm, or a network at test time.

Two guests, chosen because they exercise the two states `--debug` can see:

| fixture | built by | carries DWARF | what it pins |
| --- | --- | --- | --- |
| `dwarf-guest/` | `@yabgu_gm/tensionscript@0.14.0` | yes | pass-through |
| `legacy-guest/` | `@yabgu_gm/tensionscript@0.13.2` | no | the no-DWARF report |

The distinction is the whole point: the host leaves a compiler-emitted guest
alone, and for an older one it reports what is missing and names the fix without
inventing anything. `legacy-guest` still runs — the host does not refuse it — so
the fixture also pins that a pre-0.14.0 guest is not broken by the removal of the
fallback.

## Contract

- **Regenerate only deliberately.** A fixture is a snapshot of what a specific
  compiler version emitted; rebuilding it silently would let a regression in the
  compiler masquerade as a pass here.
- **Regenerate when** the compiler's DWARF changes shape in a way the host must
  accommodate, or when a compiler release changes the no-DWARF case this pairing
  distinguishes.
- **When you do**, re-run the fixture's own README recipe, update the checksum
  line in this file, and say in the commit message what changed and why.

Each fixture directory's `README.md` carries its exact build command, compiler
version, size, section list, and SHA-256. Those are the version-lock facts.

## What the assertions do *not* depend on

Nothing here asserts on wasm bytes. `dwarf-guest` is checked for the presence of
`.debug_info` + `.debug_line` (the host's pass-through condition) and for the
report string it produces; `legacy-guest` is checked for the absence of any
`.debug_*` section and for the report that says so, and for the absence of any
offer to synthesise or any "deprecated" wording. See `e2e_debug.rs`.

## Running the suite that consumes them

```sh
cargo test --manifest-path tension-core/Cargo.toml --test e2e_debug
```

That is the only command needed, and there is no optional test any more: the
three report assertions run under plain `cargo test`. These fixtures are checked
for the report strings they produce, not for breakpoint resolution — breakpoint
coverage lives in the Node E2E's `debug` mode (`node tests/e2e/runner.js --only
debug`), which drives lldb over `tension-core` for every built example.

CI still needs **Zig (>= 0.16)** and **gfortran (>= 14)** on the runner.
`--no-default-features` does not remove that requirement: the features gate
`cpal` and `llama-cpp-2` only, while `build.rs` runs `zig build` and
`tension-solver/build.sh` unconditionally. A clean
`--no-default-features --release` build took 1 m 42 s at ~1051 MB RSS here, on a
machine that already had both toolchains. See the header of `e2e_debug.rs` for
the measurement that shows this.
