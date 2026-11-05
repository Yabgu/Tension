# `dwarf-guest` — a compiler-emitted DWARF guest

Built once by the TensionScript compiler with DWARF emission, copied here as
bytes. The host must **pass this guest through untouched**.

## Provenance

- Compiler: `@yabgu_gm/tensionscript@0.14.0`, the published npm package —
  installed from the registry, not built from the dev tree.
- Source: `game.ts` in this directory, copied verbatim from
  `TensionScript/tests/debug/examples/add-locals/game.ts` — a named-local
  `add(a, b)` plus `_start_game`; the same shape as the Prompt A/B harness
  fixture.
- Command (run **inside this directory**):

  ```sh
  node <install>/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js \
    game.ts -o game.wasm --debug --sourceMap --optimizeLevel 0
  ```

  0.14.0 emits the `.debug_*` sections only when `--debug` **and**
  `--sourceMap` are both set.

## Bytes

- Size: 1241
- SHA-256: `cbac8dcb8ab9a15a44c268f2ced4ea8c6776668ff412059c4bfea90d2708d0df`
- Sections: `type`, `function`, `table`, `memory`, `global`, `export`, `elem`,
  `code`, `name`, `sourceMappingURL`, `.debug_abbrev`, `.debug_info`,
  `.debug_line`, `.debug_ranges`

`.debug_info` + `.debug_line` together are the host's pass-through condition
(`tension-core/src/dwarf/mod.rs`, `has_debug_sections`).

## One non-portable detail

`DW_AT_comp_dir` and the line table's include directory record the compiler's
working directory at build time
(`/home/acakar/work/Tension/tension-core/tests/fixtures/dwarf-guest`). The
compiler writes `process.cwd()`; 0.14.0 also has `--compDir` to override it, but
this fixture is built by running the compiler from this directory, which is what
the command above does.

Nothing in this suite reads that field for this guest — the assertion is on the
report string — but a debugger resolving `game.ts` against these bytes needs
`target.debug-file-search-paths` (or the baked directory) to point here. The
source is committed alongside the bytes so a fresh checkout has it.

The `.wasm.map` this build produced is intentionally not committed: a guest
that carries `.debug_info` + `.debug_line` is passed through untouched, so the
map is not an input to anything under test.
