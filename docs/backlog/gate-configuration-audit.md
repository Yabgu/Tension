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

## The thirteen findings so far

Findings 1-7 were found across Pass 2. Findings 8-11 were found by a **fresh
agent on a different machine** (rustc 1.99.1, WSL2, dzn) running the gate for
the threading round of 2026-11-16 — which is the point: the gate had been green
on the machine that wrote it, and the new environment surfaced three defects that
environment had masked. Findings 12 and 13 were found on that same machine while
fixing 8, 9 and the crash it was hiding. See
`docs/plan/handoff-to-compiler-round.md` ("Fresh-agent machine addendum") for the
measurements.

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

7. **`project-gate --diff` compares cargo results by position, so one added test
   renumbers every line after it.** Measured on `ui-threading`: adding a single
   test executable (`tests/cooperative_round_trip.rs`, one test) produced
   **28 "hard differences"** for a change of exactly `passed 629 -> 630` and
   `result lines 42 -> 43`. The new line landed at index 7 (test binaries run in
   name order, and `cooperative_round_trip` sorts early), so indices 8-43 each
   differed by one — and `compare()` in `scripts/project-gate.mjs` walks the two
   lists by index. A multiset check confirms the honest delta: the 42 old lines
   appear unchanged, plus one `passed=1` line.

   *Shape: the diff reports **position**, which carries no meaning, instead of
   **content**, which does.* The warning section already gets this right — it
   goes through `diffLines`, a multiset difference. The cargo section does not,
   and `--diff` exits non-zero on any hard difference, so a legitimate one-test
   commit reads as a 28-line breakage.

   The cost is habituation, and that is worse than noise: a reviewer who learns
   that "28 hard differences" means "a test was added" will read past a real
   28-line change the same way.

   **Fixed** in `fix(gate): diff cargo results by content, not by index`, the
   round after it was found, because the scheduler slice adds tests and each one
   would otherwise have read as a 28-line breakage. `compare()` now routes the
   cargo section through `diffLines` — the multiset difference the warning
   section already used. Suites and verdicts stay index-compared, because there
   position *is* the fact.

   Measured before and after, on the same two projections (`fc8655a` ->
   `9b49bb2`, one test file added):

       28 hard differences   ->   1:  +ok  passed=1 failed=0 ignored=0

   and the synthetic cases were checked separately: one test file added at the
   head of the order reads as one `+` line; one test *removed* reads as a
   `-passed=3` / `+passed=2` pair; a FAILED verdict still exits 1 with the
   verdict line named. The projection itself is unchanged by the fix — a saved
   log re-projects byte-for-byte identically — so a green tree's projection
   before and after this commit is the same artefact.

   Reading either operand of a `--diff` is unaffected: a raw log still projects,
   and a rendered projection still re-reads as itself.

8. **A stale build artifact is accepted because it exists.** Found on
   2026-11-16. `tension-framework` failed with
   `SPECIMEN FAIL: loading the atlas -> -38`; the atlas was valid and so was the
   code. `findRender2d()` (`scripts/test-framework.mjs:266-272`) returns any
   `tension-2d/build/libtension_2d.so` that exists, with **no staleness check**,
   and the file on that machine was dated **2026-11-09** against a **2026-11-16**
   checkout — a pre-Pass-B artifact from before the renderer moved in-core
   (`build-2d.mjs` now links no DSO unless given `--cpp`). The gate then measured
   a binary that no source in the tree corresponds to.

   *Shape: finding 4's cousin — the measurement depended on the state of a build
   directory rather than on the tree. Finding 4 was "the same tree projects two
   numbers"; this is "two trees project the same number".*

   **Diagnosis method, reusable:** exclude the artifact without deleting it —
   `TENSION_2D_LIB=/nonexistent/none.so node scripts/test.mjs framework`. With
   the stale DSO out of the way the suite passes, which isolates the artifact
   from the code in one command. **Fix applied on that machine:** rebuilt with
   `node scripts/build-2d.mjs --cpp`, then confirmed the specimen *ran* rather
   than skipped (`26684 lit pixels`) — a rebuild that skipped would otherwise be
   a false green.

   **Two proposed fixes, pick one:**

   - **Compare the DSO's mtime against its inputs** — refuse (naming why) any
     `libtension_2d.so` older than the newest of `tension-2d/reference/*.cpp`,
     its headers, and the `third_party/ImageViewer` IWI sources it links. *This is
     the honest test: an artifact is stale relative to what it was built from.*
   - **Refuse any file older than the checkout's HEAD commit time.** Cheaper, no
     input list to maintain, but a proxy: checking out an older commit can leave
     the DSO newer than `HEAD` while still disagreeing with the working tree.

   **Either fix is incomplete alone.** The companion defect is below.

   **Fixed** in `fix(gate): stale DSO rejection and release-build env exclusion`,
   2026-11-16, taking the first of the two shapes: the artifact's mtime against
   the newest source `build-2d.mjs --cpp` compiles. The walk and the refusal now
   live in `scripts/lib/render2d-lib.mjs`, because the hole was never one
   function — it was four copies of `existsSync` in the example suites plus the
   one in `test-framework.mjs`, and a fix in one file would have left the rest.
   Measured in all three states: a fresh DSO runs the specimen (26,684 lit
   pixels), a forced 2026-11-09 mtime is **refused** naming both dates and the
   rebuild command, and an absent DSO fails the framework suite (finding 9) while
   the example suites fall back to the in-core renderer by design. No suite
   relied on a stale DSO: the one that did was the one this found.

9. **A suite can pass while its central assertion never ran.** Found on
   2026-11-16, in the same place as finding 8 and with the same cause.
   `runFontSpecimenFixture` prints
   `SKIP — no tension::2d (build tension-2d, or set TENSION_2D_LIB)` and returns
   when no DSO is found, and `tension-framework` reports `PASSED` either way.
   Measured: with `TENSION_2D_LIB` pointed at a nonexistent path the suite passes
   with the font specimen skipped. So the *one* assertion in that suite that
   exercises a real GPU frame is optional in practice, and the gate's verdict
   cannot tell "the specimen drew 26,684 lit pixels" from "the specimen never
   ran".

   This is finding 5's shape (the gate cannot say what it exercised) sharpened
   into the worst case: not "an added assertion is invisible" but "a *skipped*
   assertion is indistinguishable from a passed one".

   *Shape: the gate's verdict is stable across two different amounts of exercise.*

   Note the skip was defensible when the DSO was the only 2D renderer. It is not
   any more: the renderer is in-core (`render2d-core`), so the DSO is the *bisect*
   path and its absence should not silently drop the suite's GPU coverage. The
   fix is to make a missing/refused DSO **fail** this suite (or to run the
   specimen against the in-core renderer directly), not to skip it.

   **Fixed**, same commit: the framework suite asks for the artifact with
   `required: true` and fails on absence, and the example suites ask with
   `required: false` *on purpose* — running in-core is a supported configuration
   for them. What is never allowed, in either case, is an artifact that exists
   and is stale (finding 8), so "absent" and "out of date" cannot be confused
   with each other or with "passed".

10. **A crashed test binary projects as zero tests, not as unknown.** Found on
    2026-11-16. The `tension-core` suite's lib binary **SIGSEGV**d during the
    run. libtest therefore never printed its `test result:` summary, and the
    projection (which counts `test result:` lines) reported:

    ```
    cargo-result-lines: 0
    cargo-total: passed=0 failed=0 ignored=0
    ```

    145 individual tests had already printed `... ok`, and **none** had printed
    `... FAILED`. A reader of the projection alone sees "zero tests" — which reads
    as "nothing to report", the most benign possible interpretation of a hard
    crash.

    *Shape: a crash and a clean, empty run project identically. This is finding 5
    one layer down: the gate cannot distinguish "the suite ran and everything
    passed" from "the suite did not run".*

    **A crash does reach the verdict** — the suite is `[FAIL]` in the summary and
    the gate exits non-zero — so this is not a silent pass. The defect is in the
    *projection*, which is the artefact a freezed commit cites and a `--diff`
    compares. A `--diff` across a crashing run shows `cargo 0 lines` rather than
    naming the crash.

    **Proposed fix:** `project-gate` must treat a missing libtest summary as a
    **failure**, not as a count of zero. Concretely: if a suite's log contains
    `test result:` lines *before* the failure but not after, or contains
    `SIGSEGV`/`signal:` without a matching summary, the projection emits a
    `crashed:` section naming the binary. "Zero `test result:` lines from a suite
    that was expected to run cargo" and "all tests passed" must never be the same
    projection.

11. **Which renderer a 2D suite tests depends on which cargo profile exists.**
    Found 2026-11-16, chasing a "regression" that was not one. The example suites'
    `findCore()` (`examples/2d/*/test.mjs`) prefers `release` and falls back to
    `debug`:

    ```
    for (const profile of ['release', 'debug']) { ... }
    ```

    The gate's `Preparing` step builds the **debug** binary with
    `--no-default-features`, which has **no in-core 2D renderer**; such a binary
    loads the `--capability <DSO>` the suites pass, so the suite exercises the
    C++ bisect path. A **release** binary built with `render2d-core` answers
    `tension::2d` itself, so the DSO is skipped and the suite exercises the
    in-core renderer instead.

    Measured: gate run 1 (no release binary present) failed `box-physics`,
    `stiff-boxes` and `starter`; gate run 2 (a release binary had been built for
    an unrelated change) passed all three, on the same sources. The suites changed
    behaviour without the tree changing.

    *Shape: finding 4 again — the gate's verdict depends on build-directory state
    rather than on the tree — but through binary selection rather than cache
    contents, which is why the warning-count rule did not catch it.*

    **Cost:** worse than a flaky number. It made a stale-artifact failure
    (`docs/backlog/bug-iwi-tns-corruption.md`) look like an in-core decoder
    regression, and it will make the next one look like that too.

    **Proposed fix:** the suite must name the renderer it intends to test, not
    accept whichever binary happens to exist. Either (a) pin the profile per
    suite, or (b) resolve the binary the way the gate's own `Preparing` step does
    — one profile, one feature set — and fail loudly when it is absent, instead of
    silently preferring a different build of the product.

12. **A GPU device torn down on a libtest worker thread SIGSEGVs, after every
    assertion has passed.** Found 2026-11-16; it was the `tension-core` suite's
    only red for two gate runs, and it is what finding 10 was measuring. Isolated
    in four steps:

    - **Which tests:** all five `render2d::device::replay_tests` crash run
      individually; `capture_tests` (7) and `render2d_open` pass. Not the
      pipeline-1000 case specifically — every one of them.
    - **What part of them:** a minimal `open_offscreen(8, 8)` followed by a drop
      reproduces it with no replay code in the process at all, and
      `std::mem::forget` on the same state does **not** crash. The fault is the
      device's *destructor*.
    - **Which thread:** the process's main thread exits 0; a libtest worker
      thread takes the SIGSEGV. Kernel report: `RAX == RIP`, an unmapped target,
      plus `dxgkio_query_adapter_info: Ioctl failed: -22`.
    - **Which wasmtime:** it crashes at **24.0.13** as well (throwaway worktree at
      `4da7cd7`, the nested-guest merge, with the old pin), so the 50.0.1 upgrade
      did not introduce it. The renderer was not touched by the branch either.
      Only `dzn_icd.json` is installed on this machine (no lavapipe), but the
      driver is not the cause: dzn opens and draws fine, and the same code on the
      main thread exits clean.

    *Shape: the tree documents this invariant and honours it in five probes.*
    `tests/render2d_open.rs` says it outright — `sdl3::init()` lets the **first**
    calling thread claim main-thread status and refuses every later one, so a
    normal `#[test]` on a spawned thread fails, and `harness = false` is the fix.
    The five tests that create the most devices of anything in the tree were
    `#[test]`s serialized on a `Mutex`, and **a lock cannot fix thread affinity**.

    **Fixed**: moved to `tests/replay_device.rs` as a `harness = false` binary in
    the tree's own pattern. One `fn main()` on the real main thread runs the five
    tests with their assertions unchanged, each inside `catch_unwind` so one
    failure still reports the other four; a `NoDevice` refusal is a counted skip
    rather than a silent return. Measured: **5/5 pass, exit 0, no SIGSEGV**, and
    the lib test binary now completes and prints its `test result:` line (145
    passed) — which is also the end of finding 10's "0 result lines": the count
    moved from 0 to a real number because the binary finishes, not because the
    projection changed.

13. **An example suite passed `undefined` as a capability path.** Found while
    fixing 8. `examples/2d/isometric-framework/test.mjs` spawned the interactive
    run with `'--capability', fwCtx.dso`, but `prepare()` in
    `examples/2d/synthetic/runner.mjs` never returned a `dso` — it returns
    `capabilityArgs`. So the argument was `undefined`, which `spawnSync` rejects,
    and the block only runs when there is a display, is not `--headless`, and
    `TENSION_2D_CHILD` is unset: a desktop run with `npm start`, which no CI job
    does. *Shape: a code path the gate never enters, holding a reference that was
    never there.* Fixed by spreading `fwCtx.capabilityArgs`, the same list the
    assertions above it run with.

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
