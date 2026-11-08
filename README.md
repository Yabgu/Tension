# Tension (alpha)

Tension is a runtime where a host owns the machine and guests own their worlds.
A Rust host (`tension-core`) embeds a Wasmtime VM and exposes native capabilities
to TensionScript guests through wasm import namespaces. It is deterministic by
construction — same inputs, same outputs, same machine or not — and it is a
development platform, not a game engine: the editor, the language and the
toolchain are part of the product.

What that means for beta, what is deliberately deferred, and what is
deliberately never being built: [`docs/vision.md`](docs/vision.md).

## Architecture

One process, one guest, one session. The host owns the window and the Vulkan
instance; a renderer borrows both and builds its own device and swapchain on
them. The guest reaches the host through the **session** — an arena both sides
read, an event ring, a job table and a resource table, driven by an **epoch**
that runs once per host-loop iteration, inside the guest's own turn. Capabilities
are either built into the host or `dlopen`'d at runtime as **DSO adapters**
speaking one vtable ABI; nothing about a DSO capability lives in the core except
the loader.

```
[ BUILD ]  game.ts --tensionscript--> build/game.wasm
[ RUN   ]  tension-core game.wasm [args...]

    session: arena · epoch · event ring · job table
             open close wait drain subscribe unsubscribe pending
                 │  tension_adapter_v1
    DSO capabilities: ogre · tension::2d · tension::input
    in the host:      io · audio · ai · res · solver
```

The full ownership table, the teardown order, the host loop and the two channels
into a layer are [`docs/architecture.md`](docs/architecture.md).

## Capabilities

| Capability | Guest imports | Form | Where |
| --- | --- | --- | --- |
| I/O | `tension::io` | host | `tension-core/` |
| Audio | `tension::audio` | host | `tension-core/` |
| AI | `tension::ai` | host, llama.cpp in-process | `tension-core/` |
| Resources | `tension::res` | host, Zig core statically linked | `tension-res/` |
| Solver | `tension::solver` | host, Fortran core statically linked | `tension-solver/` |
| Renderer | `ogre` | DSO adapter | `tension-ogre/` |
| 2D | `tension::2d` | DSO adapter | `tension-2d/` |
| Input | `tension::input` | DSO adapter | `tension-input/` |

`--capability <path-or-name>` loads an adapter; a name resolves as
`<dir>/libtension_<name>.so` through `TENSION_CAPABILITY_PATH`. Every import a
guest can make, with signatures, is the generated
[`docs/abi/guest.md`](docs/abi/guest.md); the vtable a DSO implements is
[`docs/abi/adapter.md`](docs/abi/adapter.md). The adapter ABI is core wasm
imports, not the Component Model: an adapter registers imports by name, and a
WIT layer could sit on top later without changing that shape.

`tension-ogre` and `tension-2d` are documented in
[`docs/modules/`](docs/modules/). `tension-input/DESIGN.md`,
`tension-solver/DESIGN.md`, `tension-res/DESIGN.md` and
`tension-world/DESIGN.md` are the only design notes left; none has a successor
doc yet.

## Run an example

Each example is a standalone npm project whose `package.json` links the
framework into its own `node_modules`.

```sh
cargo build --manifest-path tension-core/Cargo.toml      # the interpreter

cd examples/io
npm install
npm run build
../../tension-core/target/debug/tension-core build/game.wasm
```

The Ogre examples need the adapter and the generated layout, so they go through
the shared runner:

```sh
cd examples/ogre/hello-triangle && npm start          # a real window
TENSION_OGRE_HEADLESS=1 npm start                     # structural only
```

`npm run demo` builds and runs the io, audio and ai examples; `npm run build`
builds the interpreter, the framework and every example.

## Debugging a guest

`--debug` turns on wasmtime's DWARF handling and reports what a debugger can
actually see of the guest before it runs. `--symbol-path <PATH>` says where to
look for sources (repeatable). Options precede the guest path; `--` ends them.
A missing guest, an unknown option, or a `--symbol-path` with no value exits `2`.

TensionScript 0.14.0 and later embed DWARF when built with `--debug --sourceMap`;
the host passes those sections through untouched, and Cranelift carries them
across the JIT boundary so a source breakpoint resolves against the real guest.
An older guest carries only a `name` section, and the host says so instead of
building DWARF for it.

In lldb, three things are load-bearing:

- **Enable the GDB JIT loader** (`settings set plugin.jit-loader.gdb.enable on`),
  or the module registration goes unseen and breakpoints never resolve.
- **A guest breakpoint is pending until launch.** The JIT image does not exist
  when it is set; that is the correct state, not a failure.
- **Break by name with `-r 'game/'`**, not `-n`: the real symbol is
  `wasm[0]::function[N]::<module>/<name>`. Locals print as the four wasm scalars,
  and only while live; stepping shows native code while the source pane shows
  `game.ts`.

`examples/io/.vscode/launch.json` carries two working configurations — one
against the debug host with Rust symbols, one against the release host so the
stack holds guest frames. Expect a few cosmetic `unable to resolve a line table
file address` lines at launch: they are slack in wasmtime's DWARF transform, not
a failure.

## ABI notes the generated pages do not carry

`docs/abi/guest.md` states signatures. Three behaviour contracts live only here
until they get a hand-written home:

- **`read_line` is probe-then-consume.** `cap <= 0` returns the line's length
  without consuming and parks the line in host-side `pending_line`; repeated
  probes are idempotent. `cap > 0` consumes it, writes `min(cap, len)` bytes and
  returns the full length; `-1` is EOF, `0` an empty line. A probed-but-never-
  consumed line stays buffered for the store's lifetime — there is no discard
  API — so a future multi-guest host must make that state per-guest. The SDK
  always follows its probe with a consuming call, *even when the probe answered
  `0`*, or the stream would never advance past a blank line.
- **`session_read` returns bytes written**, not total length — deliberately
  unlike `read_line`. `cap <= 0` probes the unread count idempotently. At most
  four AI sessions are live at once, and the host closes any the guest leaves
  open. A guest is only ever handed whole UTF-8 codepoints; a trailing partial
  one is buffered until a later token completes it.
- **`session_create` takes a TLV argmap**: `u32 entry_count`, then
  `u8 key_len, key, u8 tag, payload` with tags 1 bool, 2 i64, 3 f64, 4 string,
  5 blob. Duplicate keys take the last value; unknown keys are validated and
  ignored with an `ai` logger note. Exactly one of `model.path` / `model.blob`
  is required. `model.blob` is refused by the llama.cpp adapter — the pinned
  crate has no in-memory loader — and accepted only by the headless stub. The
  per-call ABI trace is off by default (`TENSION_AI_TRACE=1` turns it on)
  because a drain loop would bury the event lines; llama.cpp's own logging is
  silenced at backend init (`TENSION_AI_LLAMA_LOG=1` restores it).
  The keys, with host defaults: `model.path`, `model.blob`,
  `model.gpu_layers` (0), `context.size` (2048), `context.threads` (0),
  `context.batch` (512), `sampler.temp` (0.8), `sampler.top_p` (0.95),
  `sampler.top_k` (40), `sampler.seed` (0), `sampler.max_tokens` (256),
  `chat.template`. Roles are `0` system, `1` user, `2` assistant;
  `session_generate` starts a completion and returns immediately, the host
  generating on its own thread, and `session_cancel` stops it while keeping the
  partial text readable. The `ai` feature is on by default (llama.cpp is linked
  in-process); `--no-default-features --features audio` serves the same imports
  from a deterministic headless adapter. Grammar and structured output are
  deliberately not exposed: the pinned llama.cpp's grammar sampler aborts the
  process, a version constraint rather than a design taste.

## Where to read next

| Topic | Document |
| --- | --- |
| What Tension is for; alpha→beta; deferrals; non-builds | [`docs/vision.md`](docs/vision.md) |
| Ownership, lifetime, the host loop, adapter and session boundaries | [`docs/architecture.md`](docs/architecture.md) |
| The wasm execution contract: seven verbs, epoch, arena | [`docs/session.md`](docs/session.md) |
| Every guest import, generated from the registration sites | [`docs/abi/guest.md`](docs/abi/guest.md) |
| The DSO vtable and its error codes, generated | [`docs/abi/adapter.md`](docs/abi/adapter.md) |
| The OGRE renderer: records, regions, render thread, host surface | [`docs/modules/ogre.md`](docs/modules/ogre.md) |
| The 2D capability: SDL_GPU path, graph compiler, its own window | [`docs/modules/2d.md`](docs/modules/2d.md) |
| Build products, bootstrap, guards, test suites, CI | [`docs/build.md`](docs/build.md) |
| How a guard fails silently, and the two halves of the discipline | [`docs/guard-discipline.md`](docs/guard-discipline.md) |
| Logger names, levels, formats, and who logs what | [`docs/logging.md`](docs/logging.md) |
| Defects with reproductions, resolved and open | [`docs/known-issues.md`](docs/known-issues.md) |
| What does not work today, and what unlocks it | [`docs/known-limitations.md`](docs/known-limitations.md) |
| Field notes from the render pipeline | [`docs/pipeline-notes.md`](docs/pipeline-notes.md) |
| Measurements behind the session design | [`docs/session-findings.md`](docs/session-findings.md) |

`AGENTS.md` holds the operating rules for an agent working in this tree.
`SESSION.md` records the argument for session plurality; the code is not plural,
and [`docs/architecture.md`](docs/architecture.md) §7 describes the code.

The test inventory that backs the claims in these pages is
[`docs/build.md`](docs/build.md) §6.

## Licence

MIT (see `LICENSE`). ECMA-208 specification material is not distributed with
this project; `tension-res/spec/README.md` records the edition, how to obtain it,
and its checksums. References to ECMA-208 describe interoperability only; this
project is not affiliated with or endorsed by Ecma International.
