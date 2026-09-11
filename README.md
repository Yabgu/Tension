# TensionCore (alpha)

A **command-line interpreter** for text games. `tension-core` loads a guest
`game.wasm` into a Wasmtime VM and supplies the **`tension::io`** host ABI.
The game authors logic in **AssemblyScript** (a TypeScript dialect, compiled
to wasm with `asc`) and compiles *against* that ABI; the interpreter implements it.

The split is the point: **the host owns the terminal, the game owns the world.**
That makes `tension-core` a language runtime, not a linker.

## Architecture

```
[ BUILD ]  game (AssemblyScript)  --asc-->  build/game.wasm     (imports tension::io)
[ RUN   ]  tension-core game.wasm [args...]                 (host: implements tension::io)
                 │
                 ▼
            Wasmtime VM + tension::io host API
```

Because strings cross wasm as raw bytes, games are written in
**AssemblyScript** (a TypeScript dialect) and compiled by `asc`; the package
ships `index.d.ts` so TS-aware tooling types game sources, while `index.ts`
is the AssemblyScript barrel `asc` resolves as the package entry. There is no
second, runnable surface.

## Components

- **`tension-core/`** — the Rust host (wasmtime). Registers the `tension::io`
  imports, loads `game.wasm`, and calls its exported `_start_game()` (falling
  back to `_start`). Run: `tension-core <game.wasm> [args...]`.
- **`tension-framework/`** — the guest SDK. `assembly/` holds the
  AssemblyScript bindings through which the game imports `tension::io`.
  `index.d.ts` declares the same surface so TS-aware tooling can type game
  sources.
- **`examples/`** — one folder per example: `io/` (arguments + prints +
  read-line, `game.ts`) and `audio/` (guest-synthesised PCM playback,
  `demo.ts`).

## The `tension::io` ABI

`tension::io` is a core-wasm import module name — the guest imports it, the
host implements it; it is not a WIT/Component-Model interface id.

Strings pass as UTF-8 bytes with an explicit pointer + length:

| Import | Signature | Behavior |
| --- | --- | --- |
| `print` | `(ptr: i32, len: i32)` | write exactly `len` bytes at `ptr` to stdout (no newline appended) |
| `read_line` | `(ptr: i32, cap: i32) -> i32` | read one line (terminator stripped); `cap <= 0` probes the length without consuming, `cap > 0` consumes the line, writes `min(cap, len)` bytes, and returns `len`; `-1` on EOF, `0` for an empty line |
| `arg_count` | `() -> i32` | number of extra CLI args passed to the game |
| `arg` | `(i: i32, ptr: i32, cap: i32) -> i32` | write arg `i` as UTF-8, return byte count (`-1` OOB); `cap == 0` probes size |

The host's `print` is a byte sink; the SDK owns the line terminator —
`print` appends it, `write` does not.

`read_line` is the ABI's first stateful call: a `cap <= 0` probe parks the
line in host-side `pending_line` and is idempotent until the line is
consumed — repeated probes return the same length and never advance stdin.
A probed-but-never-consumed line stays buffered for the store's lifetime
(there is no discard API); future host designs (multi-guest, VM resume)
must account for per-guest pending-line state. Because the framework probes
the exact size before consuming, the guest never requests a partial line,
so UTF-8 codepoint-boundary truncation cannot occur in the decode path — a
consequence of the contract, not a separate fix.

The AssemblyScript `stub` runtime also imports `env.abort` to signal a trap
(panic); the host decodes and prints the AS message, then exits non-zero.

## Build & run

```sh
# 1. build the interpreter
cargo build --manifest-path tension-core/Cargo.toml

# 2. compile the game (AssemblyScript -> wasm). The framework is linked
#    into examples/node_modules (see package.json / the `file:` dependency).
cd examples
npx asc io/game.ts -o io/build/game.wasm --runtime stub --target release

# 3. run it (args after the wasm are the game's arguments)
printf 'hello\n' \
  | ../tension-core/target/debug/tension-core io/build/game.wasm alpha beta gamma

# 4. the audio demo (generates a sine + square in the guest and plays them
#    through the system device; a `--no-default-features` build uses the
#    headless adapter and renders the session to tension-audio.wav instead)
npx asc audio/demo.ts -o audio/build/demo.wasm --runtime stub --target release
../tension-core/target/debug/tension-core audio/build/demo.wasm
```

Or use the demo runner:

```sh
./demo.sh
```

Or, from inside `examples/`, build and run via npm (assumes `tension-core` is
built first):

```sh
cd examples
npm start           # io example (build + run)
npm run start:audio # audio example (build + run)
```

## Scope & notes

- There is **no `tension-cli`** — compilation is plain `asc`; the "Tension API"
  is the `tension::io` ABI, not an npm CLI package. A package script in
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
- `examples/io/game.ts` round-trips args (including multi-word args) and read-line
  through the ABI; `examples/audio/demo.ts` synthesises sine + square PCM in
  the guest and plays it through the system device (cpal).
