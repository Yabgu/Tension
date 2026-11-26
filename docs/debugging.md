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
[tension-core] debug:   source map: game.ten.map (found)
[tension-core] debug:   symbol path: .
[tension-core] debug:   lldb: settings set plugin.jit-loader.gdb.enable on
[tension-core] debug:   lldb: breakpoint set -f game.ten -l <line>   # source line
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
(lldb) breakpoint set -f game.ten -l 11
(lldb) run
* thread #1, name = 'tension-core', stop reason = breakpoint 1.1
    frame #0: 0x… JIT(0x…)`game/_start_game at game.ten:11:8
-> 11  	  print("Arguments passed to the game:");
```

**Stepping shows native code, not wasm bytecode** — Cranelift compiles the guest
to the machine's own instructions, so the disassembly pane shows x86-64 (or
arm64) while the source pane shows `game.ten`. That is the same trade CPython,
the JVM and V8 make, and the reason source-level breakpoints work at all.

### Where it binds, and where it cannot

Measured, not inferred. Two guests, same host flag, same lldb commands.

- **Linux and macOS — yes.** lldb 23.1.5, wasmtime 50, a guest built with
  `--debug --sourceMap`. The stop carries the guest's own frame:

  ```text
  * thread #1, name = 'tension-core', stop reason = breakpoint 1.1
      frame #0: 0x00007ffff752054e JIT(0x7ffff5a14010)`async/rt-guards/_start_game at rt-guards.ts:96:21
  -> 96      line("job-key: " + handle._record.key.toString());
  ```

  `--debug` **on the host** is what makes it work. Without it the guest's bytes
  reach wasmtime with `debug_info(false)`, no JIT image is registered, and the
  breakpoint stays pending to the end of the process — with DWARF in the guest
  and a correct `-f`/`-l`. The startup report says which of the two you have.

- **A pending breakpoint can also mean the guest never ran.** The JIT image is
  created when the module is instantiated, so a host that exits before that —
  a missing argument, a refused session, a panic while loading a model — leaves
  lldb nothing to bind to. The transcript looks like broken DWARF and is not:

  ```
  (lldb) breakpoint list
  1: file = 'story.ts', line = 234, locations = 1,
     where = <Unknown>[0x00007ffff74e0d92], ..., unresolved, hit count = 0
  ```

  Note the missing `JIT(0x…)` module name and `resolved = 1`: a guest that ran
  prints `where = JIT(0x7ffff5a14010)`… at `file:line`. Measured on
  `examples/ai` with its GGUF absent — the host panics inside `session_create`
  before `_start_game`, so `story.ts:234` never binds while the same file binds
  in `examples/io`. Read the process output above the breakpoint list first:
  the reason the guest did not run is there. The `ai` example's debug task now
  checks for the model and names `npm run fetch-model`, rather than leaving a
  breakpoint that silently never hits.

  A guest compiled with `--importMemory` and launched **without** the session
  that defines `env::memory` fails the same way for the same reason
  (`unknown import: env::memory has not been defined`, exit 1). The thread
  programs import their memory too, which is why they are launched with the
  host's `--executors` and the shared-memory path.

- **Windows — yes, for a Promise guest.** Measured on the Windows host,
  2026-11-22. `examples/async-on-main` built on the **Promise** backend
  (`--debug --sourceMap`, no `--enable stack-switching`) under codelldb's lldb
  20.1.4:

  ```
  (lldb) image list
  [27] 2CE5EE3E 0x000002297fed1000 JIT(0x2290234a040) (0x000002290234a040)

  breakpoint set -f game.ten -l 77   -> stopped at game.ten:77   (game/main$resume)
  breakpoint set -f game.ten -l 81   -> stopped at game.ten:81
  breakpoint set -f game.ten -l 92   -> stopped at game.ten:92
  ```

  The same stop is asserted by `a_source_breakpoint_binds_in_a_promise_guest`
  against the committed fixture — `rt-guards.ts:96`, where msys2's lldb 23.1.5
  stops too on this machine. This page previously said the opposite — that
  `image list` shows **no `JIT(0x…)` image at all** and a guest breakpoint is
  impossible there. That is not reproducible here with either debugger build.
  *(Inference, not measured: the earlier reading most likely saw a
  stack-switching guest — the case immediately below — which the engine refuses
  before lldb is handed a module.)*

- **A stack-switching guest cannot bind on Windows — because it cannot load.**
  `tension-core` refuses the module (`this guest uses continuations, which
  wasmtime does not support on this target (windows)`), so lldb never receives
  anything to register. That is a **load refusal**, not a missing-symbols or
  JIT-registration problem, and it is the reason the stack-switching breakpoint
  test skips there.

### Known defect: some lines in async bodies bind without a source location

Measured on Linux x86-64, wasmtime 50, lldb 19, with a compiler-emitted DWARF
guest. Some breakpoints bind and stop, but lldb prints no `at file:line`, and
errors once per location with:

```
error: JIT(0x…) unable to resolve a line table file address 0x… back to a
       compile unit, please file a bug and attach the address and file.
```

A table from two guests, because the shape is not yet predictable. It is a **record of
a measurement** taken before DL45, so the row keeps the spelling the tree had then
(`.ts`, the pre-DL45 name). That guest is `tests/programs/async/async-on-main.ten`
today — renamed twice since, `.ts` → `.tension` (DL45) → `.ten` (DL46) — and `game.ten`
is the user's file, untouched by either rename.

| guest | line | what it is | result |
|---|---|---|---|
| `examples/async-on-main/game.ts` | 54 | first statement of `base()` | binds, **no location** |
| | 55 | second statement of `base()` | `game.ten:55:40` |
| | 69 | first statement of `outer()` | binds, **no location** |
| | 77 | first statement of `main()` | binds, **no location** |
| | 80, 83, 88, 89, 91, 95 | later lines in `main()` | resolve |
| `tests/programs/async/async-on-main.ts` | 34, 35, 36 | inside `step(x)` | bind, **no location** |
| | 41, 42 | inside `main()` | resolve |

Non-async lines in the same stack-switching modules resolve normally
(`main-policy.ts:41`, `schedule-order.ts:99` and `:148`), which is why the
suite's breakpoint test passes while this defect is live.

What has been **ruled out**, each measured rather than assumed:

- the DWARF is internally consistent — `.debug_ranges` is ascending,
  non-overlapping, non-empty (4,661 entries), it covers the whole code payload
  (extent `0x3..0x5c08` = the payload size exactly), every source-map row's
  address falls inside an entry, and every file index is in the file table;
- the guest runs to completion (exit 0, 14 transcript lines), so this is not
  the "guest never ran" case above;
- whole-body `DW_AT_ranges` is **worse**, not better: rewriting the section to
  one entry per body made `game.ten:80` stop resolving as well (16 unresolved
  errors). The row-granular tiling is loading-bearing and must stay;
- it is not the optimization level: both the failing and the passing example
  are built at the default `-O0`.

Still open: which rows lldb cannot attribute, and why. The next probe is
wasmtime's JIT translation (its per-function address map and the frame table it
hands the debugger), not the DWARF, because the DWARF side is now measured
consistent.

**A `.ts` breakpoint on Windows is a different question, and the answer there
is yes.** The lldb route above is `tension-core`; the Node route below is V8,
and V8 *does* take breakpoints in a wasm module at a byte offset — measured in
this tree with the inspector protocol:

```
setBreakpoint: {scriptId: "128", lineNumber: 0, columnNumber: 8394}
hits: [{reason: "other", offset: 8394, fn: "$~lib/array/Array<...>#constructor"}]
```

That is the half the guest must supply. The other half — mapping a `.ts` line to
that offset — is the guest's DWARF, and VS Code's JavaScript debugger reads it
through one helper extension:

1. Install `ms-vscode.wasm-dwarf-debugging` (its own text: the `enableDWARF`
   setting "Requires the ms-vscode.wasm-dwarf-debugging extension to function").
2. Set `"enableDWARF": true` on the Node launch configuration — the ones in
   `tension-core/tests/programs/.vscode/launch.json` already do.
3. Run a **debug** artifact. `runner.mjs` resolves `build/debug/<name>.wasm` and
   rebuilds it when it is missing or older than its source, and prints which
   artifact it loaded and which `.debug_*` sections it carries. A breakpoint in
   a `.ts` file cannot bind against `build/<name>.wasm`, which is a release
   build with no debug sections at all — silently, which is why the runner now
   says so out loud.

**Also on Windows**, two paths work without a debugger:

1. **Run the same artifact under Node** — the JS host half. V8 supports stack
   switching, so a guest `tension-core` refuses on Windows runs here, and the
   host side is JavaScript you can step with `node --inspect-brk`:

   ```sh
   node --experimental-wasm-wasmfx \
     tension-core/tests/programs/runner.mjs main-policy --trace
   ```

   `--trace` prints the imports it bound and the `__start` status, which is
   usually the whole question when a guest misbehaves before it prints anything.
   `--release` forces the release artifact for a plain run.
2. **Follow the source map** by hand. The debug build writes `<guest>.wasm.map`
   beside the artifact (`node scripts/build-test-programs.mjs --debug`), and it
   is a standard source map from wasm offsets to `.ts` lines — so a wasm offset
   in a trace, or a module loaded into Chrome DevTools, resolves to the line you
   would have set a breakpoint on. `tension-core --debug` still reports whether
   the guest carries DWARF and where its map is, on Windows too: that report is
   a property of the guest, not of the platform.

**This is asserted, not remembered.** `tension-core/tests/debugger.rs`:

```sh
cargo test --manifest-path tension-core/Cargo.toml --test debugger
```

The guest those tests bind in is **committed** —
`tests/programs/fixtures/debug/rt-guards.wasm` and its map, a pinned compiler's
`--debug --sourceMap` build of `async/rt-guards.ts`, regenerable with the
command in the README beside it. That is why the assertions run on a machine
with no compiler at all (CI does not install one). When the fixture is absent,
`tests/support/programs.rs` falls back to `node scripts/build-test-programs.mjs
--debug` if `node_modules/@yabgu_gm/tensionscript` exists, and otherwise prints
one line naming what is missing and what to run.

- `the_committed_debug_fixture_carries_dwarf` — every platform, no compiler
  needed: the fixture is in the tree, its map travels with it, and it carries
  `.debug_abbrev` / `.debug_info` / `.debug_line` / `.debug_ranges`. A hard
  failure, so a deleted fixture cannot leave CI green with nothing measured.
- `the_debug_report_names_what_a_debugger_can_see` — every platform: the report
  carries `DWARF: present`, the source map, and the three `lldb:` recipe lines.
- `a_source_breakpoint_binds_in_a_promise_guest` — lldb stops at
  `rt-guards.ts:96` on every platform where it registers the guest's JIT image,
  Windows included (measured 2026-11-22). It skips only on a **measured**
  capability gap — the guest does not load, or lldb holds no `JIT(…)` image
  after the run — and prints that measurement.
- `a_guest_without_dwarf_cannot_be_stopped_at_a_source_line` — the same bytes
  with every `.debug_*` custom section stripped does **not** bind, so the stop
  above is DWARF's doing and not the driver's default answer. Runs wherever the
  positive test runs; on Windows the stripped guest registers no image at all,
  which is the same conclusion by a different route. Runs in CI for that reason.
- `a_source_breakpoint_binds_in_a_stack_switching_guest` — a breakpoint in an
  async program on the stackful backend. The fixture carries DWARF; the test
  skips only where the **engine refuses to load** the module (Windows:
  continuations unsupported), printing the host's own sentence, and asserts a
  real stop wherever the module loads.

By hand, the same stop without the test wrapper:

```sh
node tools/e2e-debugger/runner.js --guest \
  tension-core/tests/programs/fixtures/debug/rt-guards.wasm \
  --file rt-guards.ts --line 96
```

It prints one JSON line — `stopped`, `hit_breakpoint`, `file`, `line`,
`function` — through the same lldb driver the examples use.

**What this means for the breakpoint you set in VS Code.**

- A `.ts` line in a **guest that carries DWARF** binds on Linux/macOS — and on
  Windows too, when the guest is a **Promise** build — any example built with its
  `build:debug` task, and `tests/programs/` built with `--debug`, as long as the
  launch configuration passes `--debug` to the host.
- A line in an **async program** on the **stackful** backend binds wherever the
  module loads: the guest carries DWARF, and `main-policy.ts:41` is asserted. On
  Windows the module is refused at load, so nothing binds — that is
  `wasmtime`'s continuation support, not the debugger.

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

**The 2D examples carry one configuration each**, added when the launcher was
retired: `examples/2d/{hello-sprites,isometric,isometric-framework}/.vscode/`.
They are the shortest configs in the tree, because there is nothing to resolve —
no `--capability`, no DSO, no environment. `isometric` and
`isometric-framework` also pass `--res`, which is a host option and therefore
comes **before** the wasm path; `--windowed` comes after it, because it is the
guest's own word — the runtime has no window flag at all, and the guest creates
the window itself.

Each has a `build:debug` task and a `build:debug` npm script, and the launch
configuration runs it — so `--debug` and `--sourceMap` reach the compiler. **It
still produces no DWARF**, and the script says so on every debug build rather
than leaving you to discover it at a breakpoint:

```
build-2d-guest: asked for --debug --sourceMap, but the wasm carries no DWARF; a
  breakpoint will land in wasm rather than in src/main.ts.
```

Measured with `tensionscript` 0.13.2: the *same* flag set
(`--runtime incremental --debug --sourceMap`) emits `.debug_info` for
`examples/io`, and emits none for any of the three 2D guests, with or without
`--config`, with `--target debug`, and with the config's `target`/`optimizeLevel`
removed. So it is a compiler gap for these guests rather than a missing flag, and
the cause is not isolated. Until it is, a 2D breakpoint resolves to wasm; the
host side (`--debug` on `tension-core`) is unaffected and still reports what a
debugger can see.

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
