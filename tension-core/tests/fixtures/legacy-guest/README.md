# `legacy-guest` — a pre-DWARF-compiler guest

Built once by the last published TensionScript release that emits no DWARF. Its
job changed when the host stopped building DWARF: it is now the input that proves
the host **reports** a guest without debug info clearly, names the fix, and still
runs the guest.

## What the host does with it

The guest runs. Functions are still named, because the `name` section survives.
A source breakpoint has no line table to bind to, and the host says so at startup:

```text
[tension-core] debug:   DWARF: absent — no .debug_* sections in the module
[tension-core] debug:   rebuild with TensionScript 0.14.0 or later to embed DWARF at compile time
```

It does not offer to build DWARF for it, and it does not call the user's build
deprecated. `tension-core/tests/e2e_debug.rs` asserts both of those absences, so
re-introducing a host-side fallback fails the suite rather than passing quietly.

## Provenance

- Compiler: `@yabgu_gm/tensionscript@0.13.2` from npm — the release that
  predates compiler-side DWARF emission. (`npm view
  @yabgu_gm/tensionscript version` reported `0.13.2` when this was built.)
- Source: the same `game.ts` as `dwarf-guest` (TensionScript's add-locals
  fixture), so the two guests differ only in the compiler that built them.
- Command (run with the source file in the working directory):

  ```sh
  npm install @yabgu_gm/tensionscript@0.13.2
  node_modules/.bin/tensionscript game.ts \
    -o game.wasm --debug --sourceMap --optimizeLevel 0
  ```

## Bytes

- `game.wasm` — size 352, SHA-256
  `a50b4b876602f984f08af13e1a6a6dac60d7a1ca61a6bbfaf6308a15fa2cc5f0`
- Sections: `type`, `function`, `table`, `memory`, `global`, `export`, `elem`,
  `code`, `name`, `sourceMappingURL` — **no `.debug_*` section**, which is the
  no-DWARF report's precondition.
- `game.wasm.map` — size 48708, SHA-256
  `d5f2f81c46ff27f4cd87eeb41b650aa827a79bdacec0f50ae5997414f0841379`

The map is kept as provenance: it records what the 0.13.2 build produced
alongside the guest. Nothing reads it now — the host no longer builds a line table
from a source map — and the suite would still pass if it were deleted. It stays
because it is part of this fixture's recorded build, not because it is an input.

## Why this guest is not rebuilt at test time

The suite must not depend on npm at test time, and the fixture must not drift
with the compiler. This file is the only committed input that pins what a
pre-0.14.0 guest looks like on the wire, which is what makes the no-DWARF
diagnostic testable without a compiler in the loop.

## Where the remaining exceptions live

Five examples do not produce a debug artifact at all (a compile failure, a
release-only build, or a missing packed resource). They are listed with their
reasons in `tests/e2e/config/known-skips.json`; none of them exercises anything
in this directory.
