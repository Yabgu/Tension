# Backlog: the gate's configuration audit

**Status:** backlog, and a class of defect rather than a task list. Five findings
in Pass 2 were the same bug at five scales: **the gate tested a configuration
other than the one that ships, on an environment other than the one a reviewer
runs, and reported a figure that depended on its own cache.** Each was found
late, each was green in CI's shape and red (or silently inert) in reality, and
each was fixed as an instance without naming the class.

The rule this file exists to state:

> The gate must run the shipped configuration, and must run on any environment a
> reviewer or a CI job will run it on. Where a configuration cannot be gated
> (a vendored llama.cpp build, a real GPU), the gate must say so and the
> exclusion must be a decision written down, not an accident of flags.

Finding 4 adds a third clause, because a deterministic verdict over a
nondeterministic measurement is only half a gate:

> **and the gate's own measurements must be deterministic.** A number that
> depends on the state of a build cache cannot distinguish a real change from a
> cold-cache artefact, so it cannot be a freeze figure.

Finding 5 adds a fourth:

> **and the gate must be able to say what it exercised.** An assertion added to a
> fixture that already passed changes no verdict, no count and no warning, so the
> projection cannot distinguish it from a commit that added nothing.

## The six findings so far

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

5. **An assertion added inside an existing fixture is invisible to the gate.**
   In 4b-6, `RecordBuffer.place` gained five checks in
   `tension-framework/tests/guest-buffers.ts` — the move, the clip, the count,
   the dropped count, and `flags` travelling with a moved record. The gate ran
   that fixture and the fixture failed if the checks failed, so the check *was*
   executed; but the projection's four sections (suites, verdicts, `test result:`
   counts, warnings) are all unchanged by an assertion added to a fixture that
   already ran and already passed. **A commit that added a check and a commit
   that added nothing project identically.** That is the gate auditing itself:
   findings 1–4 are the gate not exercising the product, and this one is the
   gate not being able to say what it exercised. *Shape: the gate's coverage
   grew and its report could not tell.*

The five are one statement: **a gate that does not run the shipped
configuration, on the reviewer's environment, measure it deterministically, and
report what it exercised, is a gate for a different product.**

Finding 5 has no cheap fix and is not scheduled. Two shapes exist and both cost
something a future round should choose between deliberately:

- **assertion counts per fixture.** Each fixture prints its own total (several
  already do: "61 checks passed", "OK", a FAIL count) and the projection adds a
  section for them. The cost is a convention every fixture must follow, and a
  fixture that prints nothing is invisible in a *different* way.
- **diff the test sources.** A commit that touches a `tests/` or `fixtures/`
  file under a suite whose verdict did not change is reported for review. Cheaper
  and requires no convention, but it reports source churn rather than assertions
  — a comment edit trips it and a fixture that grows a loop does not.

6. **A feature-gated dependency looks unused in the configuration the gate
   builds.** Found on `ui-threading`, on the first gate run after Rust 1.90.0 ->
   1.100.0: cargo 1.100 brought `unused_dependencies` (warning by default), and
   the gate's `Preparing` step builds the debug host with
   `--no-default-features` — no features at all — under which
   `arc-swap` is genuinely unreferenced, because its only user is
   `audio::real`, which is `cfg(feature = "audio")`. The measured effect is one
   new warning row (`Cargo.toml:76 unused dependency arc-swap`) and nothing
   else: 85 in 18 distinct rows -> 86 in 19. *Shape: finding 1 again, one layer
   down. The dependency is not unused; the configuration the gate compiled is one
   the dependency set was not sized for, and no `Cargo.toml` can be true for
   every feature subset.*

   This one is **not** a defect in the tree and should not be "fixed" by removing
   the dependency. Its two honest answers are finding 1's (make the prepare step
   build the shipped feature set, which changes what the guest suites run
   against and is a gate change with its own risk) or an explicit
   `[lints.cargo] unused-dependencies = "allow"` with the reason beside it. It is
   recorded rather than silenced because the same lint will fire for the next
   feature-gated dependency, and a reader who meets it should know it is the
   gate's configuration talking, not the tree's.

## What a green gate means, now that finding 4 is known

Finding 4 has two possible answers. This file records which one the gate uses,
so that the next reviewer does not have to infer it from an exit code.

**Chosen: the warning section is advisory and is reported separately, never as a
hard figure.** The gate takes one pass/fail decision — the suites, the verdicts
and the `test result:` counts — and warnings are printed beside it as context.
This is already what `scripts/project-gate.mjs --diff` does: it exits 1 on
suites, verdicts or cargo and exits 0 on a warnings-only difference. What this
file fixes is the *reporting* rule that goes with it:

- a commit's declared delta must not promise a warning number it cannot keep;
  the honest form is "warnings unchanged, modulo the cold-cache OGRE probe rows
  (finding 4)";
- anyone citing a warning count states the cache state it was measured on —
  `warm` means the adapter build directory already held the stbi probe,
  `cold` means it did not. The two figures for one unchanged tree are 85 in 18
  distinct rows and 87 in 20;
- a warning count never blocks a commit on its own. A *new* message on a line
  the change touched is a review question, not a gate verdict.

The alternative — force a cold build on every gate run so that one number exists
— was rejected: it buys determinism by paying a full adapter rebuild per run,
and the cold path is itself the thing whose warnings we do not control
(`third_party/`). Marking the section advisory is the cheaper true statement.

Findings 1–3 are unaffected: a version-dependent verdict and a configuration
that ships different from the one tested are hard failures, and stay hard.

## Artefacts outside the gate's view

`third_party/assemblyscript/` was deleted on `ui-nested-guest` (27,332,969
bytes, 1,294 files). It was untracked — `.gitmodules` had lost the entry in
`b771bfd` — so the deletion appears in no diff and no commit records it. What
remains is `.git/modules/third_party/assemblyscript/`, inert git metadata: it
holds that checkout's objects and packed refs, is read by nothing, and will not
be removed by deleting or recreating the parent directory. If a future
`git submodule` or `git status` report mentions it, that directory is the
reason. Removing it is safe (`rm -rf .git/modules/third_party/assemblyscript`)
and was left alone deliberately: it is repository internals, not a working-tree
artefact, and this round removed only what the user named.

## The platform a feature was exercised on

Finding 4 says the gate's own measurements must be deterministic. There is a
sibling: a green gate must also say **where** it was green. Until the threading
branch, no test in this tree asserted a property that only one platform can have,
so the question never came up. It does now.

Stack switching — the mechanism a cooperative thread is made of — is **x86_64
only** in wasmtime 50. `Config::wasm_stack_switching(true)` is refused elsewhere,
so a test that exercised it would have to either fail or skip on aarch64 and
Windows. **It fails, and the failure names the platform**:

    this platform (aarch64 macos) cannot compile stack switching: ...
    The cooperative-thread contract is x86_64-Linux only in wasmtime 50;
    a machine that refuses this config cannot prove it.

The rule that follows, and the reason this is a section rather than a footnote:

> A test whose **subject** is a platform-limited feature must fail on the wrong
> platform, not skip. A skip is a green gate asserting nothing about the thing the
> test was written for.

This is deliberately different from the 2D suites, which exit 0 when a machine
has no usable GPU or no display. That skip is honest because the *subject* there
is the renderer's behaviour given a device, and a machine without one has not
refused the claim — it has no opinion. A machine without stack switching **has**
refused the claim: the contract cannot exist there at all.

The cost is named rather than hidden: **the gate is x86_64-only while the
proposal is.** An aarch64 or Windows contributor gets a red gate on this branch,
not a quietly smaller guarantee. If that becomes unacceptable, the fix is a
declared matrix (the test reports "not applicable on this target" through a
mechanism the gate *counts*), not a skip — but no such mechanism exists today,
and inventing one is not worth it for a branch with one platform.

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
