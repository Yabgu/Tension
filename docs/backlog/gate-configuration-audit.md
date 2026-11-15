# Backlog: the gate's configuration audit

**Status:** backlog, and a class of defect rather than a task list. Four findings
in Pass 2 were the same bug at four scales: **the gate tested a configuration
other than the one that ships, on an environment other than the one a reviewer
runs, and reported a figure that depended on its own cache.** Each was found
late, each was green in CI's shape and red (or silently inert) in reality, and
each was fixed as an instance without naming the class.

The rule this file exists to state:

> The gate must run the shipped configuration, and must run on any environment a
> reviewer or a CI job will run it on. Where a configuration cannot be gated
> (a vendored llama.cpp build, a real GPU), the gate must say so and the
> exclusion must be a decision written down, not an accident of flags.

## The four findings so far

1. **`--no-default-features` also dropped `render2d-core`.** The `core` suite ran
   `cargo test --no-default-features --features audio`; the flag was meant to say
   "no `ai`" and silently disabled the in-core 2D renderer instead, so the gated
   cargo tests exercised only the C++ DSO escape hatch — a build this tree no
   longer ships. Found by `11699b7`, fixed by naming the feature.
   *Shape: a flag whose meaning was broader than its intent.*

2. **The default build did not compile.** `ai::stub` was `cfg(any(not(feature =
   "ai"), test))` while `HostState::build` named it unconditionally, so
   `cargo build`, `cargo run` and a plain `cargo test` failed with `E0433`.
   Every gate invocation passes `--no-default-features`, so the shipped
   configuration was compiled by nothing at all, and stayed broken through a
   dozen commits. *Shape: the gate and the product differed by a flag, and no
   suite compiled the product's own configuration.*

3. **`node --test <dir>` stopped resolving on Node 24.** The `cli` suite passed
   its directory to Node, which resolved tests inside it on the version the gate
   was written against and treats an argument as a module path on v24
   (`MODULE_NOT_FOUND`). The suite was red on one machine and green on another
   for a reason that had nothing to do with the CLI. *Shape: the gate's verdict
   depends on the interpreter's version.*

4. **The warning count moved without the tree changing.** Two `unused
   parameter` warnings from OGRE's `OgreTextureGpu.h` reach the projection
   through `tension-ogre/tests/probe_stbi_codec.cpp`. They are emitted only when
   that probe is *recompiled*, so a warm build directory projects 85 occurrences
   in 18 distinct rows and a cold one 87 in 20, for the same source. Measured on
   consecutive runs of one unchanged tree. The projection is the freeze list for
   a commit, so a figure that depends on cache state is the same defect as a
   verdict that depends on the interpreter: it makes "nothing changed" a claim
   nobody can check. *Shape: the gate's own measurement is not deterministic.*

The four are one statement: **a gate that does not run the shipped
configuration, on the reviewer's environment, and measure it deterministically,
is a gate for a different product.**

## Every invocation the gate makes, with its flags

Suites that compile or run Rust (`tension-core/Cargo.toml`):

- `cargo test --test {platform_surface,platform_window,platform_create,platform_control}`
  with `--no-default-features --features audio`, or `--features ai` when
  `TENSION_AI=1`. **None of these name `render2d-core`.**
- `cargo test` (the `core` suite) with
  `--no-default-features --features audio,render2d-core`, or
  `--features ai,render2d-core` when `TENSION_AI=1`.

That is the whole of the Rust surface, and it is why finding 2 survived: no
invocation omits `--no-default-features`, so `default = ["audio", "ai",
"render2d-core"]` in `tension-core/Cargo.toml` is never the configuration under
test.

Suites that run Node (`scripts/test.mjs` unless stated):

- `eol` — `scripts/test-eol-gate.mjs`, then `scripts/normalize-eol.mjs --check`.
- `deps` — `scripts/check-deps.mjs`: the naga pin, and the lockfile mirrors.
- `win32-headers`, `ogre-capacities`, `codegen` — generated artifacts vs sources.
- `abi-docs` — `scripts/test-abi-docs.mjs`: regenerates and compares
  `docs/abi/*.md`, plus the pre-commit hook's own refusal.
- `framework` — `scripts/test-framework.mjs`, `TENSION_SESSION_READY=1`.
- `cli` — `node --test` over the files enumerated from `packages/cli/test`.
- `docs` — `apps/docs/tools/check.mjs`: bundle, search index, font bake, and a
  recorded transcript per `runnable` block.
- `ogre-guest`, `ogre-unit`, `input`, `window-close`, `res`, and the six 2D
  example suites (`hello-sprites`, `isometric`, `isometric-art`,
  `isometric-framework`, `box-physics`, `stiff-boxes`), `starter`,
  `platform-surface` … `platform-control` where they are node probes.

Every suite runs with `suiteEnv()`, which is not `process.env`:

- `TENSION_2D_HEADLESS=1` — a suite asserts pixels; a window would make the
  result depend on a compositor.
- `TENSION_SESSION_READY=1` for the suites that would otherwise race on
  `gen-session.mjs`.
- `baseEnv()` — the toolchain environment (MSVC through vcvars, MSYS2 UCRT64,
  a Zig installed without a PATH shim), resolved in `scripts/lib/toolchain.mjs`.
- `LD_LIBRARY_PATH` (or `PATH` on Windows) prefixed with
  `third_party/ogre-next-install/lib` when it exists.

## Environment dependencies, stated

- **Node version.** `engines: >=20`, and finding 3 is exactly why this must be
  treated as a gate input: the suite's verdict moved between v20/v22 and v24 for
  an invocation reason. Anything the gate passes to Node must behave the same on
  every version it claims to support.
- **A display.** `platform-*` and `window-close` hold the `display` tag: they
  open a real window through SDL. They need a display server, and a compositor
  changes timings. `TENSION_2D_HEADLESS=1` does not apply to them.
- **A GPU / ICD.** The 2D suites create an SDL_GPU device. `SDL_VIDEODRIVER=dummy`
  is refused by name (`device.rs`), `offscreen` with a software or dzn ICD is the
  supported headless path. Which ICD is present is not asserted anywhere.
- **`TENSION_AI=1`** optionally adds the `ai` feature: a vendored llama.cpp
  build needing `LIBCLANG_PATH`. `AGENTS.md` excludes it from the default suite;
  that exclusion is a decision, and this file records it as one.
- **`gfortran`** for `tension-solver`; the build warns when it is unpinned
  (`TENSION_ALLOW_UNPINNED=1` acknowledges).
- **`ar`, `g++`/`c++`, `zig`, `cmake`/`ninja`** for the archives and the OGRE
  adapter, all through `scripts/lib/toolchain.mjs`.

## What an audit would have to check

Not scheduled. The shape a future pass would take:

- a suite that runs `cargo build` (no flags) and `cargo test` (no flags) — the
  shipped configuration — even if only on one platform and in one job;
- a check that every flag passed to a build in the gate is a flag the shipped
  build uses, with the exceptions named in this file;
- a Node-version matrix for the suites that shell out to Node, or a standing rule
  that the gate passes no path form whose meaning is version-dependent;
- a recorded ICD and display driver for the 2D suites, so "passes on my machine"
  and "passes in CI" are the same claim;
- a guard that the exclusion list (vendored `ai`, real windows) is reviewed when
  a feature moves, so an exclusion cannot outlive its reason.
