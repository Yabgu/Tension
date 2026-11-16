# Backlog: the environment-variable audit

**Status:** audit and classification, **all three dangerous shipped reads fixed**
(`TENSION_CAPABILITY_PATH`, `TENSION_OGRE_PLUGIN_DIR`, `TENSION_OGRE_MEDIA_DIR`).
Written 2026-11-16.
**Why it exists:** gate finding 8 turned on an environment variable that chose a
library to load, and the shape — *env var → file path → load* — is a class, not an
incident. This page walks the whole tree so the next one is found here rather than
by a fresh agent's bug hunt.

## The rule this audit applies

> An environment variable that causes the process to **load a library**, **read a
> configuration file**, **connect to a URL or socket**, or **execute a command** is
> a code-injection or data-injection surface. In a shipped binary it must not
> exist: the read is compiled out of release builds (`#[cfg(debug_assertions)]`),
> not present and ignored. A runtime `if release { ignore }` is weaker — a check
> can be bypassed by anything that can already influence the process, while absent
> code cannot run. The release path for such a thing is an **explicit CLI flag the
> operator typed**, never an inherited variable.

Classification:

- **HARMLESS** — a number, a timeout, a log level, an enumerated switch, a boolean.
  No path is loaded, no URL contacted, no command run.
- **DANGEROUS** — a path that is loaded (DSO, config), a URL contacted, a command
  executed, a socket connected.
- **REVIEW** — fits neither cleanly.

Shipped vs harness matters: a test runner or build script reading a path is a
developer convenience. The same read in `tension-core` or `tension-ogre` is the
product. Only shipped reads can be an injection surface in a release artifact.

## Shipped artifacts

### DANGEROUS

1. **`TENSION_CAPABILITY_PATH`** — `tension-core/src/main.rs`, `resolve_capability_paths`.
   A colon-separated directory list; a `--capability <name>` is resolved to
   `<dir>/libtension_<name>.so` and **`dlopen`ed**. Anything that can set the
   environment chooses native code that runs in the host.
   **FIXED this round.** The whole name search is compiled out of release builds
   (`capability_by_name` is `#[cfg(debug_assertions)]`); a release binary takes a
   capability only from an explicit `--capability <path>` and refuses a name with a
   message saying the search is not in this build. Verified: the release binary
   contains **zero** occurrences of the variable name (`strings | grep -c` == 0),
   and a release-only test asserts the name is refused.

2. **`TENSION_OGRE_PLUGIN_DIR`** — `tension-ogre/src/backend_ogre.cpp`, resolved by
   `plugin_dir()` and consumed by `root_->loadPlugin(...)`. A directory from which
   OGRE **`dlopen`s a render-system plugin** (`.so` / `.dll`). Same severity as the
   one above: environment-selected native code.
   **FIXED this round.** The read moved into `tension-ogre/src/env_override.h`,
   where `TENSION_ENV_OVERRIDES` is defined only when `NDEBUG` is not — so a
   release build's `plugin_dir()` is `return nullptr`, with no `getenv` and no
   mention of the variable's name in the binary. The release path is the directory
   CMake baked in from the Ogre prefix it linked against
   (`TENSION_OGRE_PREFIX` for `scripts/build-ogre.mjs`) — chosen at build time by
   whoever produced the artifact, not inherited at run time. Verified on both
   configurations, `strings` over the staged DSO:

   ```
   Release: TENSION_OGRE_PLUGIN_DIR 0   TENSION_OGRE_MEDIA_DIR 0
   Debug:   TENSION_OGRE_PLUGIN_DIR 2   TENSION_OGRE_MEDIA_DIR 1
   ```

   and by a paired test (`tension-ogre/tests/env_override_test.cpp`, run by
   `scripts/build-ogre.mjs --test`): debug asserts that a set variable resolves
   and an empty one does not; release asserts both resolve to nothing and prints
   `refused: compiled out of this release build`. The same source compiled in both
   configurations is what makes the pair mean something.

   **Consequence, stated rather than discovered later:** the packaged CLI
   (`packages/cli/src/bundle.js`) exports this variable from the launcher it
   writes, and the staged DSO bakes an absolute *build-tree* prefix. Those
   exports are now inert for a release DSO, so a shipped bundle must be built
   against its own prefix (`TENSION_OGRE_PREFIX=<payload>` when building the DSO
   it ships) before it is packaged. Named as open work below, not fixed here: the
   alternative is a path transport in the capability config, and the config TLV
   (`tension-ogre/include/tension_ogre.h`) carries `i64` values only, so that is
   an ABI decision rather than a patch.

3. **`TENSION_OGRE_MEDIA_DIR`** — `tension-ogre/src/backend_ogre.cpp`, the media
   root the Hlms archives load from. **Data, not code** — it cannot introduce a
   new library — but it does choose files the renderer parses, so it is
   data-injection rather than harmless.
   **FIXED this round**, same shape and same header as 2 (`env::media_dir()`) so
   the two cannot drift. Fixed rather than deferred because the change is five
   lines beside one already being made and the surface is the same class; the
   lower severity is why it was ranked after 2, not a reason to leave it.

### REVIEW

4. **`TENSION_LOG_FILE`** — `tension-core/src/main.rs:763`. A path the process
   **appends to**, never loads. It is a write surface, not an injection surface,
   and the operator running the binary can already write where they can write. Kept
   in REVIEW only because it is a path: if a future change makes the logger *read*
   a config beside it, this becomes DANGEROUS.

### HARMLESS (shipped)

5. **`TENSION_LOG_LEVEL`** — a level spec, parsed; invalid specs are refused.
6. **`TENSION_LOG_FORMAT`** — `text` | `json`.
7. **`TENSION_RENDERER`** — `tension-ogre/src/adapter.cpp:149`. Matched against a
   fixed allowlist (`auto|d3d11|vulkan|gl3plus|null`) and **refused with `-EINVAL`
   otherwise**; it selects among renderers the build already carries, and cannot
   name a path. That is exactly the safe shape (enumerated, not free-form), worth
   citing as the pattern the dangerous ones should approach.
8. **`TENSION_AI_TRACE`** — boolean.
9. **`TENSION_AI_STUB_STALL_MS`** — a number (milliseconds).
10. **`TENSION_AI_STUB_FAIL`** — boolean.
11. **`TENSION_AI_LLAMA_LOG`** — boolean.

## Test harness and build scripts (not shipped)

These are developer tooling. A path here chooses what a **test** loads; it cannot
be reached by a release binary, because the scripts are not in one. Listed so the
audit is complete and so a future `cfg` decision does not re-derive them.

**HARMLESS (switches, booleans, numbers, enumerated):**
`TENSION_TEST_ALLOW_SKIP`, `TENSION_TEST_TRACE`, `TENSION_SESSION_READY`,
`TENSION_KEEP_STARTER`, `TENSION_SKIP_MODEL_FETCH`, `TENSION_ALLOW_UNPINNED`,
`TENSION_DEBUG`, `TENSION_AI`, `TENSION_RENDER2D`, `TENSION_STATIC_SDL`,
`TENSION_OGRE_BACKEND`, `TENSION_OGRE_HEADLESS`, `TENSION_OGRE_VULKAN_TEST`,
`TENSION_OGRE_WINDOW_TEST`, `TENSION_2D_HEADLESS`, `TENSION_2D_CHILD`,
`TENSION_INPUT_*` set-up flags, `EDGE_CADENCES`, `EDGE_MOTION_COUNT`,
`EDGE_MOTION_MS`, `DONT_SHOW_UI_ERRORS`, `SDL_VIDEODRIVER`, `DISPLAY`,
`WAYLAND_DISPLAY`.

**DANGEROUS, harness-only (a path that is loaded, but only by a test):**
`TENSION_2D_LIB`, `TENSION_INPUT_LIB` (`scripts/test-framework.mjs` — a DSO path),
`TENSION_OGRE_DSO_PATH`, `TENSION_2D_DSO_PATH`, `TENSION_OGRE_DSO` (test binaries
naming a DSO), `TENSION_OGRE_*_FIXTURE` (fixture `.wasm` paths),
`TENSION_PARITY_CPP`, `TENSION_PARITY_RUST`, `TENSION_ASYNC_GUEST`,
`TENSION_CORE`, `TENSIONSCRIPT`, `TENSIONSCRIPT_BIN` (interpreter/compiler paths).

> **`TENSION_2D_LIB` is the one finding 8 was diagnosed with, and it now
> staleness-checks its target** (`scripts/lib/render2d-lib.mjs`: a DSO older than
> the sources it was built from is refused by name, and the framework suite fails
> rather than skips when the DSO is absent). That is the direct precedent for the
> two-part fix: validate what the variable names, and — for anything shipped —
> remove the read from release.

**REVIEW (path, harness-only, write or read of data):**
`TENSION_OGRE_MEDIA_DIR` is shipped (above); its harness mirrors
`TENSION_OGRE_PREFIX`, `TENSION_SDL3_PREFIX`, `TENSION_EXAMPLES`, `TENSION_PACK`,
`TENSION_IMAGE`, `TENSION_MSYS2`, `PATCHELF`, `GNUPLOT`, `MODEL`,
`GRADIENT_TEST_DIR`, `LOCALAPPDATA`.

**Build toolchain selection (`CXX`, `CC`, `TENSION_CXX`, `PATH`,
`LD_LIBRARY_PATH`, `CARGO_*`, `OUT_DIR`, `TARGET`):** these choose the **compiler
and linker** for a build. That is inherently arbitrary code execution, but it is
execution *of the build*, on the builder's own machine, by design — a build system
that could not choose its compiler could not build. Classified HARMLESS *in
context*; the audit lists them so the exception is a decision rather than an
oversight.

## The count

- **DANGEROUS in shipped artifacts: 3 — all fixed.** `TENSION_CAPABILITY_PATH`,
  `TENSION_OGRE_PLUGIN_DIR`, `TENSION_OGRE_MEDIA_DIR`: each read is compiled out
  of a release build and the variable's name is absent from the binary
  (`strings | grep -c` == 0), each with a test that asserts the release side.
- **REVIEW in shipped artifacts: 1** — `TENSION_LOG_FILE`.
- **HARMLESS in shipped artifacts: 7.**
- **Harness/build only: the remainder** — 2 dangerous-by-path but not shipped
  (`TENSION_2D_LIB`, `TENSION_INPUT_LIB`), the OGRE/parity/fixture DSO and binary
  paths, and the switches.

## Open work this audit names

1. **Packaging.** `packages/cli/src/bundle.js` exports
   `TENSION_OGRE_PLUGIN_DIR` / `TENSION_OGRE_MEDIA_DIR` from the launcher it
   writes. With the reads compiled out of release, those exports no longer reach
   a shipped DSO. Either the bundled DSO is built against the payload prefix
   (`TENSION_OGRE_PREFIX`), or the capability config gains a path transport —
   which needs an ABI decision, because the config TLV is `u32` key / `u8` tag /
   `i64` value and has no string slot.
2. **`TENSION_LOG_FILE`** becomes DANGEROUS the day the logger *reads* a config
   beside it. It is a write path today.
3. **The class, not the instance.** Every dangerous read found was
   *env var → path → load*. A future URL, socket, or command-execution variable
   should be added to this page when it is written, not after a fresh agent finds
   it.

## What this audit does not claim

It found no URL, socket, or command-execution variable in a shipped artifact; every
dangerous read is a **path that is loaded**. That is a property of this tree today,
not of trees in general — the next feature that reads a URL or spawns a command
from the environment should be added here, not discovered.
