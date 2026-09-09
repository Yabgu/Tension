# TensionCore (alpha)

A **command-line interpreter** for text games. `tension-core` loads a guest
`game.wasm` into a Wasmtime VM and supplies the **`std:tension/io`** host ABI.
The game authors logic in **TypeScript** (compiled to wasm with AssemblyScript's
`asc`) and compiles *against* that ABI; the interpreter implements it.

The split is the point: **the host owns the terminal, the game owns the world.**
That makes `tension-core` a language runtime, not a linker.

## Architecture

```
[ BUILD ]  game (TypeScript)  --asc-->  build/game.wasm     (imports tension::io)
[ RUN   ]  tension-core game.wasm [args...]                 (exports tension::io)
                 │
                 ▼
            Wasmtime VM + std:tension/io host API
```

Because strings cross wasm as raw bytes, the framework re-exports the same API
from both an **AssemblyScript ("wasmscript")** surface and a **TypeScript**
surface — one ABI, two languages to write the game in.

## Components

- **`tension-core/`** — the Rust host (wasmtime). Registers the `tension::io`
  imports, loads `game.wasm`, and calls its exported `_start_game()` (falling
  back to `_start`). Run: `tension-core <game.wasm> [args...]`.
- **`tension-framework/`** — the guest SDK. `assembly/` holds the real
  AssemblyScript bindings through which the game imports `std:tension/io`.
  `index.ts` re-exports the same surface as typed TypeScript.
- **`examples/`** — example games: `game.ts` (arguments + prints + read-line).

## The `tension::io` ABI

Strings pass as UTF-8 bytes with an explicit pointer + length:

| Import | Signature | Behavior |
| --- | --- | --- |
| `print` | `(ptr: i32, len: i32)` | write `len` bytes at `ptr` to stdout |
| `read_line` | `(ptr: i32, cap: i32) -> i32` | read a line into the buffer, return byte count, `-1` on EOF |
| `arg_count` | `() -> i32` | number of extra CLI args passed to the game |
| `arg` | `(i: i32, ptr: i32, cap: i32) -> i32` | write arg `i` as UTF-8, return byte count (`-1` OOB); `cap == 0` probes size |

The AssemblyScript `stub` runtime also imports `env.abort` to signal a trap
(panic); the host decodes and prints the AS message, then exits non-zero.

## Build & run

```sh
# 1. build the interpreter
cargo build --manifest-path tension-core/Cargo.toml

# 2. compile the game (TypeScript -> wasm). The framework is linked into
#    examples/node_modules (see package.json / the `file:` dependency).
cd examples
npx asc game.ts -o build/game.wasm --runtime stub --target release

# 3. run it (args after the wasm are the game's arguments)
printf 'hello\n' \
  | ../tension-core/target/debug/tension-core build/game.wasm alpha beta gamma
```

Or use the demo runner:

```sh
./demo.sh
```

Or, from inside `examples/`, build and run via npm (assumes `tension-core` is
built first):

```sh
cd examples
npm start
```

## Scope & notes

- There is **no `tension-cli`** — compilation is plain `asc`; the "Tension API"
  is the `std:tension/io` ABI, not an npm CLI package. A package script in
  `examples/package.json` wraps the `asc` invocation.
- The ABI is **core wasm imports** (not the Component Model / WIT) for alpha
  reliability; a WIT adapter can be layered later without changing the contract
  shape.
- `tension-plugin-vulkan` and `tension-plugin-nodes` (rendering / node-UI) are
  out of scope for the text-engine alpha.

## Verified

- `tension-core` builds and links the ABI; the guest imports exactly
  `tension::io.{print,arg_count,arg,read_line}` and exports `_start_game` +
  `memory`.
- `examples/game.ts` round-trips args (including multi-word args) and read-line
  through the ABI.
