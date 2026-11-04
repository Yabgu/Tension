# Debug fixtures — version-locked inputs

These bytes are **committed inputs to Tension's own E2E test**
(`tension-core/tests/e2e_debug.rs`). Nothing here is rebuilt at test time, and
nothing here needs TensionScript, npm, or a network at test time.

Two guests, chosen because they exercise the two states `--debug` can see:

| fixture | built by | carries DWARF | what it pins |
| --- | --- | --- | --- |
| `dwarf-guest/` | `@yabgu_gm/tensionscript@0.14.0` | yes | pass-through |
| `legacy-guest/` | `@yabgu_gm/tensionscript@0.13.2` | no | synthesised fallback |

The distinction is the whole point: the host must leave a compiler-emitted
guest alone and must still synthesise for an older one. The fixtures make both
observable without a compiler in the loop.

## Contract

- **Regenerate only deliberately.** A fixture is a snapshot of what a specific
  compiler version emitted; rebuilding it silently would let a regression in the
  compiler masquerade as a pass here.
- **Regenerate when** the compiler's DWARF changes shape in a way the host must
  accommodate, or when a new compiler release retires the fallback.
- **When you do**, re-run the fixture's own README recipe, update the checksum
  line in this file, and say in the commit message what changed and why.

Each fixture directory's `README.md` carries its exact build command, compiler
version, size, section list, and SHA-256. Those are the version-lock facts.

## What the assertions do *not* depend on

Nothing here asserts on wasm bytes. `dwarf-guest` is checked for the presence of
`.debug_info` + `.debug_line` (the host's pass-through condition) and for the
report string it produces; `legacy-guest` is checked for the absence of any
`.debug_*` section and for the synthesis report. A field-level check reads
`DW_AT_comp_dir` out of one synthesised dump. See `e2e_debug.rs`.

## Running the suite that consumes them

```sh
cargo test --manifest-path tension-core/Cargo.toml --test e2e_debug
```

Use that command, or `--release --features test-dump`; plain `--release` reports
`4 passed` while silently skipping the `DW_AT_comp_dir` half of A3 (it needs the
test-only dump flag, which a release build without that feature does not have).
The table in `e2e_debug.rs`'s header states which profile covers what.

CI still needs **Zig (>= 0.16)** and **gfortran (>= 14)** on the runner.
`--no-default-features` does not remove that requirement: the features gate
`cpal` and `llama-cpp-2` only, while `build.rs` runs `zig build` and
`tension-solver/build.sh` unconditionally. A clean
`--no-default-features --release` build took 1 m 42 s at ~1051 MB RSS here, on a
machine that already had both toolchains. See the header of `e2e_debug.rs` for
the measurement that shows this.
