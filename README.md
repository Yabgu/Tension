# TensionCore (alpha)

A **command-line interpreter** for text games. `tension-core` loads a guest
`game.wasm` into a Wasmtime VM and supplies the **`tension::io`** host ABI
(plus `tension::audio` and `tension::ai`).
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

- **`tension-core/`** — the Rust host (wasmtime). Registers the `tension::io`,
  `tension::audio` and `tension::ai` imports, loads `game.wasm`, and calls its
  exported `_start_game()` (falling back to `_start`). Run:
  `tension-core <game.wasm> [args...]`. `--debug` and `--symbol-path` shape a
  debugger session around that run — see [Debugging](#debugging).
- **`tension-framework/`** — the guest SDK. `assembly/` holds the
  AssemblyScript bindings through which the game imports the host services.
  `index.d.ts` declares the same surface so TS-aware tooling can type game
  sources.
- **`examples/`** — one folder per example: `io/` (arguments + prints +
  read-line, `game.ts`), `audio/` (guest-synthesised PCM playback, `demo.ts`)
  and `ai/` (an interactive chat session over the model host, `story.ts`).
  `solver/` is a subtree of three guests written against the solver's ABI —
  `wasm/` (rk45 on y' = -y), `world/` (a YAML scene through
  `source: "world"`) and `collision/` (two soft spheres in a square wall,
  rendered to a GIF with gnuplot) — indexed in `examples/solver/README.md`.
  `ogre/` is the renderer's front door, five guests that print rather than
  assert: `hello-triangle/` (a triangle built out of the guest's own memory with
  `MeshBuilder`, no file involved), `hello-mesh/` (a barrel loaded through
  the job queue out of a packed volume), `bouncing-ball/` (a solver-driven bounce through the
  motion table), `walking-stickman/` (a rigged mesh posed through the bone
  table) and `bouncing-bodies/` (sixty-four rigid bodies colliding in a box,
  through the physics layer; add `--angular` to run the model that simulates
  orientation, and the bodies tumble). Each of those that loads meshes carries
  its own `resources/` tree and a `pack.sh`: the assets are packed into
  `build/assets.tns` — a Tension Volume, made with the same packer `examples/res`
  uses — and the guest mounts it under `resources/`, so the loader reads bytes
  out of the volume instead of off the disk.
  Each folder is a standalone npm project — its own `package.json`,
  `node_modules`, and `build` / `start` scripts — and there is no project at
  the `examples/` level itself. `io/` also carries a `build:debug` script and
  `.vscode/` launch configs for debugging the guest (see
  [Debugging](#debugging)).

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

For the same reason `readLine()` always follows its probe with a consuming
call, *even when the probe answered `0`* (an empty line): the probe does not
consume, so returning early there would leave that line parked and every
later read would see the same `0` — the stream would never advance again.

The AssemblyScript `stub` runtime also imports `env.abort` to signal a trap
(panic); the host decodes and prints the AS message, then exits non-zero.

## The `tension::ai` ABI

`tension::ai` is the third host service (after `io` and `audio`): a **chat
session** engine. llama.cpp is linked **in-process** as a library — never a
sidecar, an HTTP endpoint, or Ollama. The host is deliberately low-level: no
model registry, no prompt policy, no agent loop. **The game names the model
and writes the conversation; the host runs it.**

Every verb takes/returns `i32`, where `-1` means error/unknown:

- **`session_create(cfg_ptr, cfg_len)`** → `> 0` session handle, `0` on
  failure (bad dict, no model key, load error, session cap reached). Blocking
  on the model load.
- **`session_add(session, role, ptr, len)`** → `0` ok, `-1` unknown handle /
  generating / bad role. Roles: `0` system, `1` user, `2` assistant.
- **`session_generate(session)`** → `0` ok; starts a completion over the whole
  history and returns immediately (the host generates on its own thread).
- **`session_read(session, ptr, cap)`** → `cap <= 0` probes the unread byte
  count (idempotent, non-consuming); `cap > 0` copies and consumes
  `min(cap, unread)` and returns the **bytes written**. Stream semantics —
  deliberately not `read_line`'s total-length semantics.
- **`session_state(session)`** → `0` idle, `1` generating, `-1` unknown.
- **`session_cancel(session)`** → stop the in-flight generation, keep partial
  text readable.
- **`session_reset(session)`** → clear history, discard unread text.
- **`session_close(session)`** → stop the session, free model + context.

At most 4 sessions are live at once. The host also closes every live session
when the game exits, so a forgotten `close()` is not a leak.

The guest is only ever handed **whole UTF-8 codepoints**: adapters decode
through an incremental decoder and buffer a trailing partial codepoint until a
later token completes it, so a freshly read buffer is always safe to decode.

### Config: the `argmap` wire format

`session_create` takes a flat little-endian TLV **argmap**, decoded by a
hand-rolled codec so the host carries no serialization dependency:

```text
argmap := u32 entry_count
entry  := u8 key_len, key (UTF-8), u8 tag, payload
tag 1 bool   : u8 0/1         tag 4 string : u32 len, bytes
tag 2 i64    : 8 bytes LE     tag 5 blob   : u32 len, u32 guest_ptr
tag 3 f64    : 8 bytes LE (IEEE-754 bits)
```

Duplicate keys: last wins. Unknown keys are ignored with a
`[tension:ai] ignoring unknown key '...'` note. Malformed or truncated payloads
fail the whole create (`0`). Keys, with host defaults in parentheses:
`model.path`, `model.blob`, `model.gpu_layers` (0), `context.size` (2048),
`context.threads` (0), `context.batch` (512), `sampler.temp` (0.8),
`sampler.top_p` (0.95), `sampler.top_k` (40), `sampler.seed` (0),
`sampler.max_tokens` (256), `chat.template`. Exactly one of `model.path` /
`model.blob` is required — a dict without either is refused.

The blob source is adapter-dependent in v1. The headless stub accepts it; the
llama.cpp adapter refuses a blob-only config, because the pinned `llama-cpp-2`
exposes only `LlamaModel::load_from_file` and has no in-process loader for
guest-supplied GGUF bytes. It answers `0` with the reason on the `[tension:ai]`
trace rather than failing obscurely deeper in.

### stderr: host events vs the ABI trace

The host reports its own events on stderr, prefixed `[tension:ai]`: the model
loading and how long it took, the ready session with its context size, refused
configs, template fallbacks and generation errors. The per-call trace of every
ABI verb is **off by default**, because a guest draining a reply polls
`session_state` / `session_read` in a tight loop — millions of calls over a
single generation — and tracing those buries the event lines under hundreds of
megabytes. Set `TENSION_AI_TRACE=1` for the full per-call stream.

llama.cpp's own logging is **silenced at backend init**, so stderr carries this
host's events and nothing else. One process-global callback serves the library
and ggml alike (`llama_log_set` hands the same callback to `ggml_log_set`),
which is why the model loader's per-tensor dump and its sampler warnings no
longer land there. `TENSION_AI_LLAMA_LOG=1` turns them back on when a load
misbehaves.

### v1 scope

Free text only. Grammar / structured-output keys are deliberately **not**
exposed: in the pinned llama.cpp the grammar sampler aborts the process
(`GGML_ASSERT(!stacks.empty())`). That is a version constraint, not a design
taste — a later llama.cpp adds it without an ABI change, and therefore without
a guest rebuild. Model caching is likewise deferred (each session loads its
own model); a host-side cache keyed by resolved config can be added later
without any ABI change. In-memory `model.blob` loading is deferred for the same
kind of reason: the key is typed, encoded and decoded, but only the stub
adapter honours it today, because the pinned crate ships no in-memory loader.

The `ai` cargo feature is **on by default**: a plain `cargo build` links
llama.cpp in-process (a long vendored C++ build; needs `cmake` + `g++`). Build
with `--no-default-features --features audio` and `tension::ai` is served by a
deterministic headless adapter instead — the same one the tests use — so the
SDK and the example run with no GGUF file at all.

## Build & run

```sh
# 1. build the interpreter. `ai` is a default feature: this links llama.cpp
#    (needs cmake + a C++ compiler; a one-time ~2 min build).
cargo build --manifest-path tension-core/Cargo.toml

# 2. compile the game (AssemblyScript -> wasm), from the example's own folder.
#    Each example is a standalone npm project: its package.json links the
#    framework into its own node_modules (a `file:` dependency).
cd examples/io
npm install
npm run build   # asc game.ts -o build/game.wasm --runtime stub --target release

# 3. run it (args after the wasm are the game's arguments)
printf 'hello\n' \
  | ../../tension-core/target/debug/tension-core build/game.wasm alpha beta gamma

# 4. the audio demo (generates a sine + square in the guest and plays them
#    through the system device; a `--no-default-features` build uses the
#    headless adapter and renders the session to tension-audio.wav instead)
cd ../audio
npm install
npm run build
../../tension-core/target/debug/tension-core build/demo.wasm

# 5. the AI demo: an interactive chat session over tension::ai. The default
#    build from step 1 links llama.cpp in-process, and the demo answers from
#    the model named below — without the weights the host refuses the config.
#    For the deterministic headless adapter (any model path works, no GGUF
#    file, no cmake/C++ compiler needed), rebuild tension-core with
#    `--no-default-features --features audio`.
#    `npm install` runs prepare.sh, which downloads the ~2.3 GB q4 weights
#    into models/ -- a no-op once they are there, and never committed
#    (.gitignore has *.gguf). Install offline with TENSION_SKIP_MODEL_FETCH=1
#    and fetch later with `npm run fetch-model`, or point MODEL= at any other
#    .gguf.
cd ../ai
npm install   # deps + models/Phi-3-mini-4k-instruct-q4.gguf (~2.3 GB, one time)
npm run build
printf 'hello\n/quit\n' \
  | ../../tension-core/target/debug/tension-core build/story.wasm \
      models/Phi-3-mini-4k-instruct-q4.gguf
```

Or use the demo runner:

```sh
./demo.sh
```

It builds the interpreter and runs every example, the ai demo included. `ai`
is a default feature, so when the gguf file exists and cmake + a C++ compiler
are available the ai demo answers from the model (linking llama.cpp is a
one-time ~2 min build); otherwise the script builds with
`--no-default-features --features audio`, says so, and runs the ai demo on the
headless adapter. It never downloads the ~2.3 GB weights by itself —
`npm install` inside `examples/ai` does that.

Or just build everything — interpreter, guest API, and every example —
without running it:

```sh
./build.sh
```

Or, from inside any example, build and run with npm (assumes `tension-core`
is built first):

```sh
cd examples/io    && npm start  # io example (build + run)
cd examples/audio && npm start  # audio example (build + run)
cd examples/ai    && npm start  # ai example (fetches models/Phi-3-mini-4k-instruct-q4.gguf on first run; MODEL=... to override)
```

The two renderer examples run through their own script, because a guest that
uses a capability needs the adapter built and the framework's generated layout:

```sh
cd examples/ogre/hello-triangle && ./run.sh                          # a real window
cd examples/ogre/hello-triangle && TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only
cd examples/ogre/bouncing-ball  && ./run.sh                          # a real window
cd examples/ogre/bouncing-ball  && TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only
```

## Debugging

The host is an ordinary native process holding a JIT'd guest, so the host side
is ordinary Rust debugging, and two flags shape the session:

- **`--debug`** — turns on wasmtime's DWARF handling (`Config::debug_info(true)`),
  and, when the guest carries none of its own, synthesizes it from the guest's
  source map before the module is loaded (see below). Before the guest runs it
  also reports what a debugger can actually see: DWARF sections, the `name`
  section, the source map (and where it resolved to). It is what makes wasmtime
  register the compiled guest with the platform debugger through the GDB JIT
  interface — **with the flag, lldb lists the guest as a `JIT(0x…)` image;
  without it, nothing is registered and no guest breakpoint can bind.**
- **`--symbol-path <PATH>`** — where the debugger should look for the guest's
  symbols and sources (lldb's `target.debug-file-search-paths`); repeatable.

Options must precede `<game.wasm>`: everything after it belongs to the game, so
a game argument that happens to read `--debug` is still the game's. `--` ends
options explicitly. `-h`/`--help` and `-V`/`--version` print and exit `0`; a
missing guest file, an unknown option, or a `--symbol-path` with no value exits
`2`.

```sh
../../tension-core/target/debug/tension-core \
  --debug --symbol-path . build/game.wasm alpha beta gamma
```

### It still works: the host synthesizes the DWARF `asc` leaves out

`asc` (AssemblyScript 0.28) emits **no DWARF** — a guest carries only a `name`
custom section and, with `--sourceMap`, a `sourceMappingURL` (verified by
parsing `examples/io/build/game.wasm`). Nothing in the binary records which
source line a wasm instruction came from, so a debugger attached to wasmtime
would have no line table to break on at all.

Rather than hand source debugging to a second, JavaScript runtime, the host
supplies what `asc` leaves out. With `--debug`, `tension-core` reads the guest's
source map, maps every wasm instruction offset to a `game.ts` line and column,
and **synthesizes `.debug_line`, `.debug_info`, `.debug_abbrev` and
`.debug_ranges` for the guest in memory** before the module reaches wasmtime
(`tension-core/src/dwarf.rs`). Cranelift carries that DWARF across the JIT
boundary — translating the guest's wasm addresses to the native code it
actually emitted — and wasmtime registers the result through the GDB JIT
interface. **`game.wasm` on disk is never touched.**

The upshot: an ordinary source breakpoint in `game.ts` resolves and hits against
the real guest, in the real interpreter, with no Node process anywhere.

```
(lldb) breakpoint set -f game.ts -l 11
(lldb) process launch
* thread #1, name = 'tension-core', stop reason = breakpoint 1.1
    frame #0: 0x… JIT(0x…)`game/_start_game at game.ts:11:8
-> 11  	  print("Arguments passed to the game:");
```

Three properties are worth knowing, because each one is load-bearing:

- **A guest breakpoint is pending until the guest exists.** At set time the JIT
  image does not exist yet, so lldb reports `no locations (pending)`; it
  resolves at launch, when wasmtime registers the module. Pending is the
  correct state for a script the runtime has not compiled yet, not a failure.
- **`initCommands` must enable the GDB JIT loader** (`settings set
  plugin.jit-loader.gdb.enable on`), or that registration goes unseen and every
  guest breakpoint stays unresolved.
- **Stepping shows native code, not wasm bytecode.** Cranelift compiles the
  guest to the machine's own instructions, so the disassembly pane shows x86-64
  (or arm64) while the source pane shows `game.ts`. That is the same trade
  CPython, the JVM and V8 make, and the reason source-level breakpoints work at
  all.

Guest function names survive too, so you can also break by name: guest
functions appear as `wasm[0]::function[N]::<module>/<name>` — for this example,
`wasm[0]::function[42]::game/_start_game`.

### Local variables, and one line of noise

- **Locals work — with the names `asc` kept.** In a `--debug` build the guest's
  `name` section also carries a local-name subsection, and the host turns each
  wasm local into a `DW_TAG_variable` whose location is the standard
  `DW_OP_WASM_location 0x00 <index> DW_OP_stack_value` expression. wasmtime's
  transform rewrites those through cranelift's value-label ranges into real
  register / stack-slot locations, so `frame variable` prints the guest's
  variables:

  ```
  (lldb) breakpoint set -f game.ts -l 14
  (lldb) run --debug --symbol-path . build/game.wasm alpha beta gamma
  (lldb) frame variable
  (WasmtimeVMContext *) __vmctx = 0x…
  (int) n = 3
  (int) i = 0
  (int) line = <variable not available>
  ```

  Three properties are worth knowing:

  - **Types are the four wasm scalars.** Locals show as `i32`/`i64`/`f32`/
    `f64`; an AssemblyScript object is a heap pointer, so it appears as an
    `i32`. No structure types are synthesized.
  - **A local is available exactly where its value is live.** Before the
    statement that assigns it (and after its last use is optimized away), lldb
    prints `<variable not available>` — cranelift simply has no machine
    location holding it there. That is the same contract a C debugger offers
    for register-allocated locals.
  - **Names need `--debug`.** Without it, `asc` drops the local-name
    subsection and the host falls back to `param0`/`local1`-style names; the
    values still appear.
- **Three lines of lldb noise at launch.** On this guest lldb prints
  `error: JIT(0x…) unable to resolve a line table file address 0x… back to a
  compile unit, please file a bug …` three times before it stops. They are line
  rows wasmtime emits over native code no unit range covers: the transform maps
  each body's range to per-instruction native ranges, and the slack between
  those is left orphaned. The noise is cosmetic — the breakpoint resolves, the
  source is listed, the run proceeds — and the fix belongs in wasmtime's DWARF
  transform rather than here; widening our ranges to hide the symptom was tried
  and did not remove a single one of them, so we do not carry that change.

A guest that already ships DWARF (a C or Rust guest) is passed through untouched
and is source-debuggable the same way.

`examples/io/.vscode/launch.json` carries two configurations, and both launch
the *real interpreter on the real guest*:

- **`lldb: tension-core --debug (io example)`** — the debug host
  (`target/debug/tension-core`; `cargo build` first). Rust symbols are present,
  so you can step across the host ABI boundary and watch the host do its job.
- **`lldb: tension-core --debug (release host, no Rust symbols)`** — the same
  guest under `target/release/tension-core` (`cargo build --release` first), so
  the stack holds guest frames instead of wasmtime's. This is the "debug the
  script, not the engine" configuration.

Both run the `build:debug` task first (`.vscode/tasks.json`) — the only build
that emits a source map — and both need `vadimcn.vscode-lldb`
(`.vscode/extensions.json` recommends it) or a system `lldb`. In the Debug
Console:

```
image list                        # the guest is the JIT(0x...) entry
breakpoint set -f game.ts -l 11   # a source line (or use a gutter breakpoint)
breakpoint set -r 'game/'         # or a wasm function name
source list                       # the AssemblyScript around the stop
```

Use `-r` for function names, not `-n`: the real symbol is the long
`wasm[0]::function[N]::game/_start_game` form, so `-n _start_game` never
matches. Expect a spurious `failed to set breakpoint site at 0x…: error: 9` —
the guest's symbol carries a duplicate location with a wrapped offset; the real
location binds and hits.

Adding `--debug` to a plain run is safe: the guest behaves identically, and the
diagnosis prints on stderr before any guest output.

## Scope & notes

- There is **no `tension-cli`** — compilation is plain `asc`; the "Tension API"
  is the `tension::io` ABI, not an npm CLI package. Each example is its own npm
  project, and its `build` script wraps the `asc` invocation.
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
- `readLine()` round-trips an empty line without wedging the stream: the SDK
  consumes the line its probe measured, so a blank line advances stdin instead
  of parking in the host forever (the ai example treats `""` as a no-op line
  and still exits on `/quit`).
- `examples/ai/story.ts` opens a `tension::ai` session, streams replies through
  the probe-then-consume read path, and honours `/reset` + `/cancel` against the
  headless adapter; a config with no model key is refused by the host before any
  model work happens.
- The host reports the model load on stderr at every `session_create`: `loading
  model (...)` before the blocking wait, `model loaded in <t>s` after it, then
  `session <n> ready (...; ctx=<n>)`. The per-call ABI trace is opt-in
  (`TENSION_AI_TRACE=1`), so by default a guest's poll loop cannot bury those
  lines.
- llama.cpp's own logging is silenced at backend init, so a real session's
  stderr carries only those `[tension:ai]` lines; `TENSION_AI_LLAMA_LOG=1`
  brings the loader dump back when a model misbehaves.
- Guest debugging: `tension-core --debug` reports the guest's debug surface and
  registers it with the platform debugger. Against lldb 22.1.3, breaking on
  `wasmtime_jit_debug::gdb_jit_int::register_gdb_jit_image` is reached with
  `--debug` and never without it; `image list` then shows the guest as
  `JIT(0x…)`.
- **Source-level AssemblyScript debugging works with no Node in the path.**
  Against lldb 22.1.3, with a `--sourceMap` build and the GDB JIT loader on,
  `breakpoint set -f game.ts -l 11` resolves at launch and stops in the guest:
  ``frame #0: 0x… JIT(0x…)`game/_start_game at game.ts:11:8``, with `source
  list` printing the AssemblyScript line. The host synthesizes that DWARF from
  the guest's source map; `md5sum examples/io/build/game.wasm` is unchanged
  across a `--debug` run (`d789929c…`), and the guest's own stdout is
  byte-identical with and without the flag.

## Licensing

This project is MIT-licensed (see `LICENSE`). ECMA-208 specification material is
not distributed with this project; `tension-res/spec/README.md` records the
edition, how to obtain it, and its checksums. ECMA-208 references are for
interoperability description only, and this project is not affiliated with or
endorsed by Ecma International.
