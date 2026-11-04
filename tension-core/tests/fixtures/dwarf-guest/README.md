# `dwarf-guest` — a compiler-emitted DWARF guest

Built once by the TensionScript compiler with DWARF emission, copied here as
bytes. The host must **pass this guest through untouched**.

## Provenance

- Compiler: TensionScript `0.13.2` plus the DWARF emission added on branch
  `feat/debug-harness` (commit `7670229c`, "test(debug): simplify baseline
  capture (DWARF is on disk)").
- Source: `TensionScript/tests/debug/examples/add-locals/game.ts` — a named-local
  `add(a, b)` plus `_start_game`; the same shape as the Prompt A/B harness
  fixture.
- Command (run with the source file in the working directory):

  ```sh
  node TensionScript/bin/tensionscript.js game.ts \
    -o game.wasm --debug --sourceMap --optimizeLevel 0
  ```

## Bytes

- Size: 1137
- SHA-256: `41a2bb111fd409774acb818abfa991cc820f2e2df43b5e318bcf31ada5c9ff98`
- Sections: `type`, `function`, `table`, `memory`, `global`, `export`, `elem`,
  `code`, `name`, `sourceMappingURL`, `.debug_abbrev`, `.debug_info`,
  `.debug_line`, `.debug_ranges`

`.debug_info` + `.debug_line` together are the host's pass-through condition
(`tension-core/src/dwarf/mod.rs`, `has_debug_sections`).

## One non-portable detail

`DW_AT_comp_dir` and the line table's include directory record the compiler's
working directory at build time (`/tmp/fx-dwarf`). The compiler writes
`process.cwd()` and has no flag to override it, so the path is baked into these
bytes. Nothing in this suite reads that field for this guest — the assertion is
on the report string — but a debugger resolving `game.ts` against these bytes
would need that directory to exist. Making fixtures portable would need a
`--compDir`-style compiler flag; that is a compiler change, not a host one.

The `.wasm.map` this build produced is intentionally not committed: a guest
that carries `.debug_info` + `.debug_line` is never synthesised for, so the map
is not an input to anything under test.
