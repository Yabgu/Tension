# `legacy-guest` — a pre-DWARF-compiler guest

Built once by the last published TensionScript release, which emits no DWARF.
The host **must still synthesise DWARF for this guest** (and say that the
fallback is deprecated), because nothing else maps its wasm addresses back to
`game.ts`.

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
  fallback's precondition.
- `game.wasm.map` — size 48708, SHA-256
  `d5f2f81c46ff27f4cd87eeb41b650aa827a79bdacec0f50ae5997414f0841379`

The map is committed because the synthesiser reads it: `sourceMappingURL` in the
wasm is `./game.wasm.map`, resolved relative to the guest's own directory, which
is why the map must sit beside the wasm.

## Why this guest is not rebuilt at test time

The suite must not depend on npm at test time, and the fixture must not drift
with the compiler: this file is the only committed input that still proves the
fallback works. When the fallback is eventually removed (after a DWARF-emitting
release is adopted), this fixture becomes the record of what it used to do.
