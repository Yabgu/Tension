# Debugging a guest

Source-level debugging of a TensionScript guest, in the real interpreter, with
no Node process in the path. The host is an ordinary native process holding a
JIT'd module, so the host side is ordinary Rust debugging; this page is the
guest side, which is the part with a recipe.

It is derived from code — `tension-core/src/debug.rs` is the whole feature —
plus observations against lldb 22.1.3 on this rig, marked where they are
observations rather than test assertions.

> **Citations are point-in-time.** No drift gate exists for this page;
> re-verify before acting.

## 1. What the host does with `--debug`

There is exactly one host-side lever: `Config::debug_info(cli.debug)`
(`tension-core/src/main.rs:853`). With it, wasmtime registers the compiled guest
with the platform debugger through the GDB JIT interface; without it no
registration happens at all (`tension-core/src/debug.rs:4-9`).

`--debug` also makes the host report, before the guest runs, what a debugger
can actually see — because whether source breakpoints work is a property of the
*guest*, and the first breakpoint that never hits is a bad way to find out. The
report is `debug.rs:report` (`tension-core/src/debug.rs:121-175`), on stderr:

```text
[tension-core] debug: guest build/game.wasm
[tension-core] debug:   DWARF: present (compiler-emitted) — passed through as-is
[tension-core] debug:   source map: game.ts.map (found)
[tension-core] debug:   symbol path: .
[tension-core] debug:   lldb: settings set plugin.jit-loader.gdb.enable on
[tension-core] debug:   lldb: breakpoint set -f game.ts -l <line>   # source line
[tension-core] debug:   lldb: breakpoint set -r 'game/'   # or by function name
```

Those commands are printed for the paths you passed, so the recipe cannot drift
from the session. Copy them rather than reading them off a document.

`--symbol-path <PATH>` is repeatable and is the host's record of where the
debugger should look; lldb wants the same value in
`target.debug-file-search-paths`. Options precede the guest path — everything
after `<game.wasm>` is the game's — and a missing guest, unknown option, or
valueless `--symbol-path` exits `2`.

## 2. Build the guest with debug info

DWARF comes from the compiler, not the host. TensionScript 0.14 and later embed
`.debug_abbrev`, `.debug_info`, `.debug_line` and `.debug_ranges` when the guest
is built with `--debug --sourceMap` (`tension-core/src/debug.rs:11-16`); the
host passes those sections through untouched.

```sh
npm run build        # release: -O3, no source map — not debuggable
npm run build:debug  # --debug --sourceMap — the only build that is
```

(`examples/io/package.json:8-9`.) A source map is the one thing that links a
wasm instruction to a source line, and the release build omits it.

A guest from an **older** compiler (0.13.x) carries only a `name` custom section
and, with `--sourceMap`, a `sourceMappingURL`. The host does not synthesize
DWARF; it runs the guest and reports:

```text
[tension-core] debug:   DWARF: absent — no .debug_* sections in the module
[tension-core] debug:   rebuild with TensionScript 0.14.0 or later to embed DWARF at compile time
```

**A trap worth knowing:** `tension-framework/package.json:31` pins
`@yabgu_gm/tensionscript ^0.13.2` while the examples pin `^0.14.1`. A guest
built inside `tension-framework/` gets the old compiler and no DWARF. If a
fixture has no line table, check which `node_modules` built it.

A guest that already ships DWARF — a C or Rust guest — is passed through the
same way and is source-debuggable without any of this.

## 3. lldb, by hand

```sh
lldb -- ../../tension-core/target/debug/tension-core \
  --debug --symbol-path . build/game.wasm alpha beta gamma
```

Four properties are load-bearing — each is a thing to check when a
breakpoint misbehaves:

- **The guest is a `JIT(0x…)` image.** It appears in `image list` at launch.
  No such entry means `--debug` was not passed, or the JIT loader is off.
- **A guest breakpoint is pending until launch** (`no locations (pending)`); it
  resolves when the module is compiled. Pending is correct, not a failure.
- **Enable the GDB JIT loader if your front-end needs it** —
  `settings set plugin.jit-loader.gdb.enable on`. System lldb has it on by
  default (`debug.rs:5`); editor front-ends do not always inherit that, which
  is why the host prints the command either way.
- **Break by name with `-r`, not `-n`.** The real symbol is
  `wasm[0]::function[N]::<module>/<name>` — `-n _start_game` never matches.

```text
(lldb) breakpoint set -f game.ts -l 11
(lldb) run
* thread #1, name = 'tension-core', stop reason = breakpoint 1.1
    frame #0: 0x… JIT(0x…)`game/_start_game at game.ts:11:8
-> 11  	  print("Arguments passed to the game:");
```

**Stepping shows native code, not wasm bytecode** — Cranelift compiles the guest
to the machine's own instructions, so the disassembly pane shows x86-64 (or
arm64) while the source pane shows `game.ts`. That is the same trade CPython,
the JVM and V8 make, and the reason source-level breakpoints work at all.

### Locals

`frame variable` prints the guest's locals: the compiler emits a
`DW_TAG_variable` per wasm local, and wasmtime's transform rewrites its
`DW_OP_WASM_location` into real register and stack-slot locations.

- **Types are the four wasm scalars** — `i32`/`i64`/`f32`/`f64`. A
  TensionScript object is a heap pointer, so it shows as an `i32`; structure
  types are not emitted.
- **A local is available exactly where its value is live.** Elsewhere lldb
  prints `<variable not available>` — the contract a C debugger offers for
  register-allocated locals.

### Noise you will see

Two lines are expected and harmless; both are rig observations, not test
assertions:

- Three `unable to resolve a line table file address …` errors at launch. They
  are rows lldb has no compile unit for: wasmtime maps each function body to
  per-instruction native ranges, and the slack between them is orphaned. The
  breakpoint still resolves and the run proceeds. Widening our ranges to hide
  the symptom was tried and removed none of them, so the change is not carried.
- A `failed to set breakpoint site at 0x…: error: 9` after setting a breakpoint.
  The guest's symbol carries a duplicate location with a wrapped offset; the
  real location binds and hits.

## 4. Editor configuration

`examples/io/.vscode/launch.json` is the reference: it launches
`target/debug/tension-core` with `--debug --symbol-path ${workspaceFolder}`,
sets the JIT loader and search path in `initCommands`, maps the source, and
runs the `debug` task first — which chains `build:debug`
(`examples/io/.vscode/tasks.json`), because the default build emits no map.

**It carries one configuration, not two.** An earlier README claimed a second
"release host, no Rust symbols" configuration; no `launch.json` here has one,
and `git log` shows none ever did. The OGRE examples carry two, and they are
windowed and headless:

- `lldb: tension-core --debug (hello-triangle example)`
- `lldb: tension-core --debug (hello-triangle example, headless)`

(`examples/ogre/hello-triangle/.vscode/launch.json`.) The headless one is for
breakpoints in guest logic when no display or GPU is available; it cannot stop
inside a draw.

The extension is `vadimcn.vscode-lldb` (`.vscode/extensions.json` recommends
it) or a system `lldb`; the commands are §3's.

## 5. Common failures

- **`DWARF: absent` at startup.** The guest was built without `--debug
  --sourceMap`, or by a compiler older than 0.14. Rebuild with
  `npm run build:debug`; check which `tensionscript` resolved (see §2's trap).
- **`DWARF: present`, breakpoint never hits.** The file and line are right but
  the guest never executes that line — check the guest actually runs that branch
  before blaming the debugger. If `image list` shows no `JIT(0x…)` entry, the
  JIT loader is off (§3).
- **`source map: MISSING`.** The map path is resolved relative to the guest's own
  directory; the build wrote a relative URL and the guest was moved. Rebuild in
  place.
- **Breakpoint set on the wrong function.** `-n _start_game` never matches; use
  `-r 'game/'` and read the full symbol from `image list`.
- **Locals unavailable everywhere.** The guest has no DWARF, so there are no
  local names at all — `--debug` on the host cannot invent them.

## 6. Environment variables

**Runtime**, read by the host and the adapters:

| Variable | Effect |
| --- | --- |
| `TENSION_LOG_LEVEL`, `TENSION_LOG_FORMAT`, `TENSION_LOG_FILE` | logger fallbacks, overridden by the flags (`docs/logging.md`) |
| `TENSION_CAPABILITY_PATH` | colon-separated dirs resolving `--capability <name>` as `libtension_<name>.so` (`main.rs:263-268`) |
| `TENSION_RENDERER` | operator renderer override, resolved against the guest's config (`adapter.cpp:142-162`) |
| `TENSION_OGRE_HEADLESS=1` | no window, no GPU device |
| `TENSION_OGRE_DSO_PATH`, `TENSION_OGRE_PLUGIN_DIR`, `TENSION_OGRE_MEDIA_DIR` | adapter path, Ogre plugin and media dirs |
| `TENSION_2D_HEADLESS=1`, `TENSION_2D_OPEN_WINDOWED` | the 2D capability's headless and windowed modes |
| `TENSION_2D_FREEZE_FRAME=1` | freeze the frame index in the 2D smoke harness |
| `TENSION_AI_TRACE=1`, `TENSION_AI_LLAMA_LOG=1` | per-call AI trace; llama.cpp's own logging |

**Test harness**, read by `scripts/test*.mjs` and the Rust integration tests:

| Variable | Effect |
| --- | --- |
| `TENSION_CORE` | the host binary to run, instead of the built one |
| `TENSION_OGRE_WINDOW_TEST=1` | opt into the windowed Ogre suite; skipped otherwise (`docs/build.md` §6) |
| `TENSION_SESSION_READY=1` | marks a session-capable build; several suites refuse without it |
| `TENSION_TEST_TRACE` | echo the stub adapter's log lines immediately — the only channel that survives a render-thread crash |
| `TENSION_EXAMPLES`, `TENSION_SKIP_MODEL_FETCH` | narrow the example set; skip the 2.3 GB weight fetch (`docs/build.md` §5) |
| `TENSION_ALLOW_UNPINNED=1` | build on a below-floor Zig/gfortran toolchain — an override, not a fix |

## 7. Not covered here

- **GPU debugging** — RenderDoc or `VK_LAYER_KHRONOS_validation`; today's VUIDs
  are in `docs/known-limitations.md`.
- **Guest memory** — read the arena through a session verb or a Rust
  breakpoint, not a debugger expression.
- **Profiling** — not instrumented; the benchmark scripts are the closest thing.
- **Crash triage** — a render-thread crash kills the process; use
  `TENSION_TEST_TRACE` and a core dump.
