# Logging — handoff

The reasoning lives in `docs/logging.md` and in the commit bodies; this page is
the map. Read it first, then the two things it points at.

## What shipped

One logger, owned by the Rust host (`tension-core/src/logging/`): it owns the
level, the per-name filter, the layout, the sinks, thread safety, and panic
containment. Every other language is a thin binding over it — a record carries
only a level, a logger name, and a message (or a structured payload), and the
host applies the one layout, so C, C++, Rust, Zig, AssemblyScript and the solver
all produce byte-identical output for the same record. Configuration is CLI-first
(`--log-level`, `--log-format`, `--log-file`), with `TENSION_LOG_LEVEL/_FORMAT/_FILE`
as fallback and CLI > env > defaults (`info`/`text`/stderr). Logging is a *verb*:
the arena, `layout_hash` (still `3451714980`), and the wire formats are untouched.

## Where the seams are

Four entry points and one callback; nothing else crosses into logging.

- **Free C symbols** — `tension_log`, `tension_log_structured`.
  `tension-core/include/tension_logger.h` (declaration), `tension-core/src/logging/ffi.rs` (definition).
  For any consumer linked *into* the host executable.
- **Adapter-table slots** — `log_named`, `log_structured` in `tension_core_api`
  (`tension-core/include/tension_adapter.h`, Rust `tension-core/src/adapter/ffi.rs`).
  Appended under rule 11; the legacy `log` slot stays populated (routed through
  the logger as `session`) for adapters built before the append. For DSOs.
- **WASM imports** — `tension::io.log`, `tension::io.log_structured`
  (registered in `tension-core/src/main.rs`; guest bindings
  `tension-framework/assembly/io.ts`).
- **AssemblyScript API** — `LogLevel`, `Logger.get(name)`
  (`tension-framework/assembly/log.ts`). `LogLevel`, never `Level` (see below).
- **Callback bridge** — `tension_solver_set_log(fn)`
  (`tension-solver/include/tension_solver.h`, installed by
  `tension-core/src/solver/mod.rs`). For native code that must link *without*
  the host; mirrors `tension_solver_bind_callbacks`.

Logger names already in use: `core`, `session`, `ai`, `audio`, `audio:real`,
`audio:headless`, `solver` (host); `ogre`, `input` (adapters); `guest`, or
whatever a game passes (`game`, `physics:collision`, …).

## Add a new logger namespace

Nothing to register. Pass the name:
`logging::log(Level::Info, "my:sub", "…")` (Rust), the `name` argument to
`tension_log` (C), `log_named(user, level, "my:sub", …)` (adapter), or
`Logger.get("my:sub")` (guest). Names are namespaces resolved by ancestor, so
`--log-level=my:warn` already filters `my:sub`.

## Add a new native consumer

Ask one question — does it link against the host executable?

- **No, and it must link standalone** (an archive/`static lib` that also links
  without `tension-core`, e.g. another numerical core): add a bound callback,
  mirroring `tension_solver_set_log` / `tension_solver_bind_callbacks`. Do **not**
  call the free symbol — it would make the archive unlinkable without the host,
  and `-rdynamic` is forbidden (rule 8).
- **No, it is a DSO** (a capability adapter): use the `log_named` /
  `log_structured` table slots, mirroring `tension-ogre` and `tension-input`
  (prefer the named slot; fall back to legacy `log`).
- **Yes, host-linked** (a tool, the Zig resource core): use the free
  `tension_log` / `tension_log_structured`.

## Known gaps

1. **The `--debug` report does not go through the logger** (`tension-core/src/debug.rs`,
   `dwarf/mod.rs`). It is a formatted human block the user asked for by flag, not
   a record; forcing it through the JSON layout would make `--debug` less useful.
   Deliberate exception. A *successful* non-`--debug` run at `--log-format=json`
   is all JSON.
2. **The `log_named == NULL` fallback is correct by construction but untested.**
   Every `core_api()` populates `log_named`, so no test reaches the legacy-slot
   path. Cheapest fixture: a small C object that fills a `tension_core_api` with
   `log_named = NULL` and a live `log`, then calls an adapter's `log_line`.
3. **Non-gap, environment only:** `ogre_window` / `test_ogre_vulkan_refused`
   fails in a tree whose OGRE-Next was built without the Vulkan RenderSystem
   plugin (the adapter returns `-EIO` where the test expects `-ENOSYS`). It fails
   identically on a pristine adapter — do not add a plugin or edit OGRE config.

## Do not relitigate

- **`LogLevel`, not `Level`.** `assembly/index.ts` re-exports with `export *`, and
  TypeScript drops both sides of a duplicate name silently. `Level` is the most
  collision-prone engine export. No alias.
- **`ai::trace` at INFO.** Its switch is `TENSION_AI_TRACE`; at DEBUG the
  documented env var would do nothing at the default level.
- **`snprintf` in the solver.** libc is the platform, not the host; the
  standalone-link property is "links without `tension-core`", which still holds.
- **The solver's bound callback.** A direct `tension_log` would break
  `probe_physics` and the Windows `midpoint.so`, or force `-rdynamic` (rule 8).
- **The append-only ABI extension.** `log_named`/`log_structured` are appended to
  `tension_core_api` under rule 11, with `_Static_assert`s on both sides. Not a
  break; do not remove, reorder, or retype existing slots.

## Owner action items

- **Push decision.** `main` is ahead of `origin/main`; nothing was pushed.
- **Optional follow-up:** the untested-fallback fixture (gap 2) — a future task,
  not part of this arc.
