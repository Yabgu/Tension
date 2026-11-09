# Build

How the tree goes from source to the four artifacts a guest run needs — the
interpreter binary, the Ogre capability DSO, the Ogre-Next runtime payload, and
the guest's wasm — and which guard refuses to let a stale one through.

This page is a reference, not a walkthrough: it says which scripts exist, what
each produces, which guards exist and what each catches. A reader who wants the
commands can run `npm run build`; a reader who wants to know *why* a build failed
should find that here.

It is derived from code. Every claim carries a `file:line`; anything that is
intent rather than current behaviour is marked **[I]**, and anything unverified on
this rig is marked as such.

## 1. Build layout

Four build products, in dependency order (`package.json:8`):

| product | script | output |
|---|---|---|
| guest codegen | `tools/codegen/generate.mjs` (`npm run build:codegen`) | `tension-framework/assembly/ogre/generated/*.ts` + `tension-ogre/src/generated/*.h` |
| interpreter + adapters + payloads | `scripts/build-native.mjs` | `packages/core-<suffix>/bin/tension-core`, `packages/ogre-<suffix>/lib/libtension_ogre.so`, `packages/ogre-next-<suffix>/lib` |
| guest framework | `scripts/build-framework.mjs` | `tension-framework/build/` — the `asc`/`tensionscript` flags and the base wasm |
| examples | `scripts/build-examples.mjs` | one `.wasm` per example, beside its source |

`npm run build` is exactly those four in that order (`package.json:8`). The
ordering is load-bearing in one direction only: `build:framework` regenerates
`assembly/runtime/layout.ts` on every run with byte-identical content
(`scripts/build-stamp.mjs:19-24`), which is why the stamp is a **content hash and
never an mtime** — an mtime comparison would call a good adapter stale after every
framework build.

**Three build shapes, one tree.**

- **In-tree** — `third_party/ogre-next-build` → `third_party/ogre-next-install`.
  What developers and the test suites use; the adapters' rpath names it
  (`third_party/README.md:34-38`).
- **Packaged** — `packages/*` carries platform payloads, one directory per
  suffix (`packages/core-linux-x64`, `packages/ogre-next-linux-x64`, …), consumed
  through `file:` dependencies. This is the shape a guest run resolves
  (`packages/core/package.json:1-16`).
- **Examples** — each is its own npm project with its own `node_modules` and its
  own build recipe (`scripts/build-examples.mjs:1-7`).

**The two artifacts a run needs** are the interpreter and the DSO. Both also link
the Zig archive built from `tension-res/` — the adapter directly, the core through
`rustc-link-lib=static=tension_res` — which is why `tension-res` is in both stamp
input sets (`build-stamp.mjs:1-14`).

## 2. The bootstrap

`node scripts/bootstrap.mjs` builds Ogre-Next from the pinned submodule into
`third_party/ogre-next-build`, installs into `third_party/ogre-next-install`, and
applies the project's patches first (`bootstrap.mjs:27-69`).

`ensure-ogre.mjs` runs it automatically when the install is missing
(`ensure-ogre.mjs:1-16`): `npm run build` on a fresh clone bootstraps once and
continues. Steady state is a few `stat` calls.

**What `--force` means.** Without it, a complete install short-circuits the whole
run (`bootstrap.mjs:243-249`); with it, the build reconfigures and rebuilds
unconditionally (`:248`).

**The idempotence caveat, and it is a real defect.** The "already installed" gate
answers *"is there an install?"* — it checks for the main library and the Media
tree — and never *"was this install produced by the current flag set?"*
(`bootstrap.mjs:243-249`). Run a bootstrap with `-DOGRE_CONFIG_ENABLE_FREEIMAGE=OFF`
(`bootstrap.mjs:418-419`: `FREEIMAGE=OFF`, `STBI=ON`) against a tree that was
installed *before* that change, and the script says "already exists — nothing to
do", exit 0, while the installed `RenderSystem_Vulkan.so` still links
`libfreeimage.so.3`. The required fix is to stamp the cmake flag set beside the
install and reconfigure when it diverges. **Not fixed**; `--force` is currently
the only remedy, which is exactly what the entry objects to.

The one consequence worth repeating: after touching anything in
`third_party/patches/`, run bootstrap with `--force`. A patch is applied to the
*source* tree and reverted after the build (`:40-46`), so skipping the rebuild
leaves an install that predates the patch.

## 3. The native build

`scripts/build-native.mjs` does five things in order: copy the Ogre-Next payload
(`:166-223`), build `tension-res` with Zig (`:224-314`), configure and link the
adapter against the payload (`:315-402`), build the core with cargo (`:577-604`),
and write the stamp (`:625-634`). Each of those has a guard.

**G1 — the payload's linkage resolves inside itself.** `auditLinkage`
(`:403-463`) runs `ldd` on `packages/ogre-<suffix>/lib/libtension_ogre.so` with
`LD_LIBRARY_PATH` **deleted** (`:421-423`), and fails on: an unresolved dependency;
any `freeimage` soname (a provenance signal — this tree builds Ogre-Next with the
codec off, so FreeImage can only come from a pre-change install, `:434-441`); or
any `libOgreNext*` resolving outside the payload and outside `third_party`
(`:442-453`).

Why it exists: the build succeeding proves nothing about loading. `tension-ogre/build/`
reaches Ogre through the third_party rpath, so every C++ and Rust test passes even
when the packaged copy resolves somewhere else — measured, and recorded in the
comment at `:407-412`. Deleting `LD_LIBRARY_PATH` is the point: it is the one
variable that can hide a wrong rpath on a developer machine, and a guest does not
get it.

**G2 — no SDL2-era window key in project source.** `auditSdlSourceReferences`
(`:486-523`) walks project source (skipping `node_modules`, `third_party`,
`build`, `target`) looking for the string `SDL2`+`x11` assembled at run time so
the scan cannot match itself (`:484`). It fails with the file and line
(`:506-521`).

The history behind it: that literal is a **key in Ogre-Next's parameter list**, not
a library dependency, and reaching for it is how a second SDL generation comes
back. The guard's comment states the two failure shapes it catches: a linker
resolving `libSDL2` from somewhere on the search path, and source drifting back to
Ogre's SDL2-era window params (`:466-483`).

**G3 — no packaged library links a pre-SDL3 SDL.** The soname half of the same
audit (`:524-575`): `readelf -d` over every packaged library, failing on
`libSDL2`, `libSDL-1.2`, `libSDL.so.1`, and noting whether SDL3 appears at all
(`:558-573`). The reason is stated in the failure text: two SDL instances mean two
event queues and a window neither one sees (`:565-568`).

**G4 — package size budget.** A report, not a failure (`:658-696`): three limits
(core 50 MB, ogre-next 40 MB, ogre 40 MB) and an "OVER BUDGET" line. A number over
budget means something unexpected is being copied, which is cheaper to see here
than in a consumer's tree (`:659-661`).

The two 40s are not the same 40. `ogre-next` ships Ogre's libraries plus the
pruned `Media/` tree (1.3 MB of an install's 144 MB —
`packages/ogre-next/README.md`). `ogre` ships one adapter, and on Windows the
DLL closure that has to sit beside it, which is 15-22 MB on its own; 25 MB was
below that floor and reported over budget on a package with nothing removable in
it, so it was raised to 40. Neither limit is a target: a package over its limit
means the sample-asset prune regressed, and the limit should not be raised again
without a measurement (`:663-680`).

**There is no capacity guard in the native build.** The ogre adapter's table
capacities are checked by `scripts/check-ogre-capacities.mjs`, which runs as the
`ogre-capacities` suite in `npm test` (`scripts/test.mjs:161-167`), not here. That
is the right place — it compares two source files and needs no build — but it
means `npm run build:native` alone will not catch a capacity drift.

**The stamp.** `writeStamp` (`:625-634`, `build-stamp.mjs`) hashes the input sets
that produced each binary — content, sorted by repo-relative POSIX path — into
`packages/build-stamp.json`. `scripts/run-example.mjs` reads it back and refuses
to run a stale adapter (`build-native.mjs:630-632`). This is the guard that turns
"the guest loaded an adapter built from different source" from a mystery into a
line.

## 4. The Ogre-Next submodule and its patches

**The pin.** `475f783d76f21b530e718aab4a548cdd9a222e50`
(`scripts/build-ogre.mjs:47`), 788 commits past the v3.0.0 tag, recorded in
`third_party/README.md:4`. `build-ogre.mjs` compares the submodule's `HEAD` to it
and refuses on a mismatch unless `TENSION_OGRE_ALLOW_DRIFT=1`
(`build-ogre.mjs:86-93`). The pin is a source fact, not a wire fact: no format in
this tree reads it.

**Patches.** Two, applied in order, each with an explicit `touches` list
(`bootstrap.mjs:40-69`):

| patch | what it changes | why |
|---|---|---|
| `ogre-no-freeimage-codec.patch` | guards `BROKEN_FILES_IN_UNITY_BUILD` in `OgreMain/CMakeLists.txt` on `OGRE_CONFIG_ENABLE_FREEIMAGE` | the codec is disabled; CMake unconditionally added the TU via the unity exclude list |
| `ogre-external-surface.patch` | Vulkan window adoption, the resize path, the teardown guard, `validateDevice` | lets Ogre render into a host-owned `VkSurfaceKHR` (`docs/modules/ogre.md` §6) |

**Revert discipline.** After the build, `git checkout --` restores exactly the
files in `touches` (`bootstrap.mjs:40-44`) — never the whole submodule, which
would discard unrelated local edits. Adding a patch means adding its files to the
list, or the revert misses them.

**The proof is the file, not the exit status.** `applyOgrePatch` refuses to trust
`patch`'s return value: after applying it greps for a `marker` in a known file
(`:144-190`). A patch that reports success and did not land is a hard failure with
`patch`'s own output attached. A patch reported as already-applied is skipped
(`:166`); anything else is a real failure and is reported as "the submodule moved"
(`:169-171`), which is the honest cause.

**The patch-file hazard.** A hunk whose context has drifted still applies with
fuzz and can land in the wrong place — which is why the marker check exists and
why `tests/ogre_host_surface.rs` is the runtime proof that the external-surface
patch is in effect. `--force` after any patch edit is mandatory (§2).

## 5. Examples

`scripts/build-examples.mjs` discovers every directory under `examples/` at depth
1 or 2 that has a `package.json` with a `build` script (`:51-90`), and shells out
to `npm run build` in each (`:115-150`). It does not compile anything itself: the
per-example recipe is what knows which `.ts` to compile and where the output goes
(`:1-7`).

Two environment knobs, both load-bearing:

- `TENSION_EXAMPLES="ogre/hello-triangle io"` narrows the set (`:16`, `:92-104`).
- `TENSION_SKIP_MODEL_FETCH=1` is set for the install step, because the `ai`
  example's postinstall fetches 2.3 GB of weights; `examples/ai/prepare.sh` does
  that on demand instead (`:8-12`).

**The dependency on the guest toolchain is real and it is versioned.**
`build-framework.mjs` compares the installed `tensionscript` against the version
the lockfile resolves, and installs when they differ (`build-framework.mjs:45-70`).
The comment records why: the guard used to be "does the compiler binary exist",
which is satisfied forever by the first successful install — and a `node_modules`
older than a facade syntax change kept its compiler, so 40 parse errors per
example were blamed on the source for two weeks (`:45-60`). This is
`docs/guard-discipline.md` instance 2.

**A missing `session.asconfig.json` is an error, not a skip**
(`build-examples.mjs:106-110`): the examples compile with the framework's flags,
and a fallback set would produce guests that do not match the session.

### How to run a 2D example

```sh
cd examples/2d/hello-sprites
npm run build
tension-core build/game.wasm --windowed
```

From another directory:

```sh
tension-core examples/2d/hello-sprites/build/game.wasm --windowed
```

That is the whole invocation. There is no launcher, no DSO to find, no
environment to set: the renderer is in the binary. **`--windowed` is the
application's own word**, not a runtime flag — it comes after the wasm path, the
guest reads it from `arg()`, and the guest calls
`tension::platform.create_window` when it sees it. Drop the word and the same
guest draws offscreen instead, which is what `npm test` does.

`npm start` in the example's directory is that same line; `npm test` runs it
headless and asserts the frame.

### Running one, and the flags that are still there

```
tension-core [--debug] [--symbol-path <dir>] [--res <pak>] [--capability <path|name>]
             [--log-level <spec>] [--log-format <text|json>] [--log-file <path>]
             <game.wasm> [game args...]
```

**Options go before the guest path; everything after it is the guest's own
`tension::io arg()` stream.** That ordering is the whole contract, and it is why
`--windowed`/`--window` is a *guest* word while `--res` is a *host* flag. A run
that puts `--res` after the wasm path passes the string to the game and loads no
resources; the log will say so, which is the only warning you get.

**There is no window flag, and there will not be one.** A window is application
configuration: the guest calls `tension::platform.create_window` with a target
(`plain`, `gpu`, `vulkan`), a size and flags, and the host creates it. A runtime
that opened a window unasked would be deciding something the application owns —
the same reason `node` has no `--title`.

`--window` still appears in a guest's `arg()` stream when an application wants
it there, and the 2D examples use `--windowed` for exactly that: the guest reads
the word and decides. The runtime does not know the word exists.

The ordering rule has a second half now: **`createWindow` before `ogre::init`.**
A renderer that asks the host for its surface before a window exists is refused
with `-ENODEV`; it does not create a window of its own and it does not wait.

The rest are transitional, and their retirement is scheduled rather than
forgotten:

| flag | retires when | owner |
|---|---|---|
| `--capability` | Ogre's own discovery lands — the sibling-payload lookup that lets `tension-core game.wasm` find the adapter without being told | Pass D |
| `--res` | the same pass, for the same reason: a pak named on the command line is a path the runtime should resolve | Pass D |
| `--log-level`, `--log-format`, `--log-file` | a guest can declare its own log destination and level through an import (`tension::log.set_level`) | future |
| `--session-open`, `--session-callbacks`, `--post-test-events` | the A1/A2 fixtures retire; all three are marked "test-only" in `USAGE` | when those fixtures go |
| `--debug`, `--symbol-path` | never — they are the debugger's interface, and a guest has no business setting them | — |
| `--window` | **retired by the programmatic window API** — it was the last application flag; the guest creates its window with `platform.createWindow`, and `--windowed` in a guest's `arg()` stream is the application's own word | done |
| the 2D example launcher | **retired by Pass C** — replaced by the invocation at the top of this section, and its pixel assertion by each 2D example's `test.mjs` | done |
| `scripts/test-2d.mjs` | **retired by Pass B** — it drove a stub core against the C++ adapter, and both are gone | done |

### The two 2D backends, and the one command that compares them

`cargo build` produces a binary with the 2D renderer in core; that is the
default and the shipped path. The C++ DSO survives as a bisect escape hatch:

```sh
node scripts/build-2d.mjs --cpp        # build the DSO from tension-2d/reference/
TENSION_RENDER2D=cpp npm run build:native
```

`node scripts/parity-2d.mjs` builds both binaries, runs the same guest through
each, and compares them — shader modules byte for byte, the ordering table
against the graph, and stdout line for line. See
[`modules/2d.md`](modules/2d.md) §7 for what each part asserts and what it skips.

### Skipping a test whose fixture is absent — one flag

`TENSION_TEST_ALLOW_SKIP=1` is the tree's **only** skip flag. Without it a test
that cannot find its fixture (a guest `.wasm`, an Ogre payload, a GPU that can
create a graphics pipeline) **fails**, in every environment; with it the test
prints `skipped: <reason>` and returns. The policy lives in one place,
`tension-core/tests/support/ci.rs`, and the `harness = false` 2D probes read the
same `skip_allowed()` helper.

New tests do not introduce a second flag. A GPU-less rig is a missing fixture
like any other: it names the reason in the skip message (`Vulkan:
vkCreateGraphicsPipelines → VK_ERROR_OUT_OF_HOST_MEMORY under Mesa dzn`) rather
than spelling the opt-out differently. Two spellings of "may I skip?" is how a
tree ends up with a suite that skips under one flag and fails under the other —
which is exactly what happened for one pass, when a second, GPU-only flag
coexisted with this one.

## 6. Tests

`node scripts/test.mjs` is the runner. Eighteen suites (`scripts/test.mjs:126-341`),
scheduled by needs and resource holds; `npm test -- --<name>` runs a subset
(`:405-415`).

**Gates that are not tests of behaviour** — no build, seconds to run:

- `eol` — every text file is LF (`normalize-eol.mjs --check`).
- `deps` — no two naga copies (`check-naga-pin.mjs`); two copies mean two `Options`
  types and a graph that compiles with one and is compared against the other.
- `win32-headers` — the checked-in Win32 overlay matches upstream's template,
  both directions (§9).
- `ogre-capacities` — the adapter's table capacities equal the guest SDK's
  (`docs/modules/ogre.md` §4.1).
- `codegen` — the generated record headers/structs match `schema/ogre.json`.
- `abi-docs` — the generated ABI pages match the header and a C compiler's
  `offsetof` (§7).

**Guest suites** — build a framework guest and run it under the real interpreter:

- `framework` — the TensionScript SDK's own tests.
- `ogre-guest` — 36 cases by default plus 17 opt-in, driving the Ogre adapter
  through real guests (`scripts/test-ogre.mjs`).
- `input` — the input capability.
- `res` — the Zig resource library (`zig build test`).
- `hello-sprites`, `isometric`, `isometric-art`, `isometric-framework` — the 2D
  pixel suites (`docs/modules/2d.md` §7). `hello-sprites` is the one that
  asserts an absolute count (10240 = 10 × 32×32); the other three assert colours
  at named probes.

**Native suites:**

- `ogre-unit` — `config_test`, `scene_test`, `loader_test`, `stbi_codec_test`; no
  Ogre linked.
- `platform-surface`, `platform-window`, `platform-control` — the host's SDL3
  surface, window and control bus.
- `core` — the Rust integration tests, including `ogre_host_surface`,
  `ogre_hierarchy`, `session_smoke`, `ogre_surface`, `render2d_open` and
  `render2d_parity`.

**Which suites are load-bearing for which guard:** `ogre-capacities` for the
cross-language capacity agreement; `codegen` for the record shapes; `abi-docs` for
the vtable offsets; `ogre-guest` for the adapter's behaviour; `core` for the
session and the host-surface path. The native build's guards (G1–G3) are *not* in
this list because they run in `build-native.mjs` — `npm test` does not re-run them.

The suite list is **[V]** (`scripts/test.mjs:126-341`). Which suite *runs* on this
rig was not re-executed for this page; the last full run recorded before it was
the pass-4 ogre suite (36 cases, exit 0) plus the unit suites. The 2D pixel
suites need a GPU device the CI image supplies through lavapipe; on a machine
that cannot create a graphics pipeline they fail rather than skip, by the policy
in `tension-core/tests/support/ci.rs`. `render2d_open` and part of
`render2d_parity` run anywhere. `node scripts/parity-2d.mjs` is the separate
command that compares the two 2D backends.

## 7. The ABI doc generator

`scripts/gen-abi-doc.mjs` renders `docs/abi/adapter.md` and `docs/abi/guest.md`
from the header and the registration sites. `--check` compares what is on disk to
what the generator would write, and `scripts/test-abi-docs.mjs` adds a C probe that
compiles against the real header and compares `offsetof` for all 33 rows
(`docs/abi/adapter.md` — the generated files carry a "do not edit" banner).

**The fragility, and it is real.** `guest.md`'s table embeds the source
`file:line` of every registration — `tension-ogre/src/adapter.cpp:1336` and so on
(`docs/abi/guest.md:32-49`). Any edit *above* a `registrations[]` table shifts
every number below it, so the page goes stale for a reason that has nothing to do
with the ABI. The generated files are drift-gated, so this is caught rather than
shipped — but it means a code change in `adapter.cpp` fails `abi-docs` until
someone regenerates.

- **Today's mitigation:** regenerate per commit. Pass 4 had to split its commits
  for exactly this reason, and `npm run docs:abi` is one command.
- **The long-term fix** is to stop emitting line numbers: cite the slot by name
  and the table by its anchor, not by `:1336`. That is a change to the generator's
  output, deliberately deferred (`docs/guard-discipline.md` — the same "presence
  vs correctness" family, since a line number is a fact about a file that moves).

**What the generator does not project:** the numbered `Rules` block, including rule
11 (append-only). `docs/abi/adapter.md`'s preamble says so explicitly
(`scripts/gen-abi-doc.mjs:557-568`), because the earlier preamble claimed
otherwise.

## 8. CI

Two paths, both real, neither a substitute for the other.

**Container — `node ci/docker.mjs test`.** One Arch image carries the full
toolchain, a headless graphics stack (Xvfb, Mesa software GL, lavapipe) and locally
built OGRE-Next packages; `test` mounts the repo at `/app` and runs `npm test`
(`ci/README.md:1-6`, `:38-48`). The run is **strict**: a missing fixture fails
rather than skipping, through `tension-core/tests/support/ci.rs`
(`ci/README.md:42-46`), so green means the fixtures were built. `ci/docker.mjs test
--core` forwards arguments to one suite (`:31`).

**Software rendering is pinned** — `LIBGL_ALWAYS_SOFTWARE=1`, lavapipe
(`ci/README.md:62-67`). Hardware rendering needs a device pass-through and
`LIBGL_ALWAYS_SOFTWARE=0`.

**LinSYS2 — cross-compiling the Win32 translation units** (`ci/linsys2.md`). A
Wine prefix with the Windows toolchain, used to compile TUs that only build on
Win32. Setup, packages, and the gotcha list are in that file; the ones that cost
time once are not repeated here.

**What runs where, honestly:**

- The container runs the guest and native suites under Xvfb with software Vulkan.
  It is the only path that runs everything.
- `ogre_host_surface` needs a **real Vulkan display** — it opens an SDL3 window and
  a host-owned `VkSurfaceKHR`. Under Xvfb + lavapipe it may run, but the
  authoritative proof on this rig is Wayland with a hardware ICD.
- `ci/README.md`'s "everything runs under Xvfb, so the OGRE test suites work
  without a display or GPU" is accurate for the adapter suites and **not** for the
  host-surface test, which needs a window the compositor will map. Treat that line
  as scoped to the suites the container runs.
- LinSYS2 proves compilation, not execution: nothing on that path runs a guest.

## 9. Cross-platform

**Win32 is compiled, not verified.** The `#if defined(_WIN32)` branches in
`tension-ogre/src/` and `backend_ogre.cpp` are exercised by the LinSYS2
cross-compile (`ci/linsys2.md:137-193`) and by nothing at run time on this rig.
Three known gaps:

1. **The generated-header overlay.** Ogre-Next generates
   `OgreVulkanBuildSettings.h` at configure time, selecting the XCB backend on
   Linux; a Win32 TU cannot use that copy. `third_party/patches/win32-headers/`
   carries a checked-in Win32 answer, and `check-win32-headers.mjs` compares its
   symbol set to the template's **both directions** — every `#cmakedefine` must be
   mentioned, and every mention must still exist (`check-win32-headers.mjs:1-22`).
   A checked-in copy of a generated file goes stale silently; a missing symbol
   compiles, links, and leaves a backend quietly absent.
2. **The adapter's Vulkan include path.** `OgreVulkanDevice.h` and the Vulkan
   headers are not on the Win32 overlay's include path — documented in
   `ci/linsys2.md:171-193`, not fixed (held).
3. **No rpath on Windows.** `auditLinkage` returns early (`build-native.mjs:416`);
   the DLL closure is staged and walked instead, which is a weaker check.

**macOS is untested throughout**, including the `-G` versus `-V` difference in
the shader build that the 2d design note flagged; no test in this tree covers
it, and the note is deleted.

## 10. Kinds of failure

Four kinds of drift, each with a different blast radius and a different guard.
This is the section that says what the tree can and cannot catch.

**Schema drift — a record's shape changes on one side.** Caught by `codegen
--check` (`scripts/test.mjs:168-184`): `schema/ogre.json` is the single source, and
both the C++ structs and the guest's structs are generated from it. A field that
moves without the schema moving is impossible; a schema edit that is not
regenerated is a failing suite. **Not caught by schema:** the *capacities*, which
are not in the schema — that is `ogre-capacities`.

**Code drift — a guard that checks presence rather than correctness.** This is the
family `docs/guard-discipline.md` names, with nine recorded instances. The pattern
is always the same: the check answers "does X exist?" when the question is "is X
the X we built?" — an install directory, a compiler binary, a dependency link, an
ABI version written as a literal in three tests (`docs/guard-discipline.md:6-25`,
`:34-110`). What each guard *should* do is compare against a recorded fact: a
stamp, a lockfile, a generated constant.

**Patch drift — a hunk lands against moved context.** Caught by the marker check
after applying (`bootstrap.mjs:181-190`) and by the runtime tests that depend on
the patch being in effect (`ogre_host_surface`). **Not caught:** a patch that
applies cleanly but to the wrong region, where the marker happens to exist
elsewhere. That is what `--force` plus the test suite is for.

**Dependency drift — a stale binary winning a load.** Caught by G1's `ldd` audit
(`build-native.mjs:403-463`) and by the content-hash stamp
(`build-stamp.mjs:19-24`). This is the most expensive kind when it slips through,
because the build and the tests both pass; the failure needs a *load*, and the
load happens in a consumer's tree.

Everything in §10 up to here is **[V]** — each guard's failure condition is the
code at the cited line. The judgement of *which* of the nine guard-discipline
instances is most dangerous is **[I]**, and `docs/guard-discipline.md` does not
rank them either.

**What no guard catches:** a behaviour change that is correct in every checked
respect and wrong in what it does. That is the test suites' job, and the reason
the pixel fixtures assert specific colours at specific coordinates rather than
"something changed" (`docs/modules/2d.md` §7, `docs/modules/ogre.md` §8).

## 11. Non-goals

- **Deployment, packaging and distribution.** `packages/*` exists so a guest run
  can resolve a binary; it is not a published product, and every manifest is
  `"private": true` (`packages/core/package.json:4`).
- **The runtime contract** — the adapter ABI, the session, the guest imports:
  `docs/abi/adapter.md`, `docs/session.md`, `docs/abi/guest.md`.
- **The host loop's timing**: `docs/architecture.md` §4.
- **Per-module behaviour** — `docs/modules/ogre.md`, `docs/modules/2d.md`.
- **The LinSYS2 gotcha list**: `ci/linsys2.md`.
- **The Ogre-Next pin's rationale, and the removal of the FreeImage
  dependency**: `third_party/README.md`.

## 12. Source index

**Citations are point-in-time.** They go stale when a cited file changes
above them, and no drift gate exists for this page — only the generated
`docs/abi/*.md` are drift-checked. Re-verify a citation before acting on
it. The real fix (generated citations, or slot names without line
numbers) is a future project.

- `package.json` — the four-step `build` and every `npm run` alias.
- `scripts/bootstrap.mjs` — patch, configure, build, install, revert.
- `scripts/ensure-ogre.mjs` — the auto-bootstrap for a missing install.
- `scripts/build-native.mjs` — payload copy, Zig archive, adapter link, core
  build, stamp, budget; guards G1–G4.
- `scripts/build-2d.mjs` — GLSL → SPIR-V → the modules the parity test compares
  against. `--cpp` also links the bisect DSO.
- `scripts/parity-2d.mjs` — both 2D backends, then the comparison.
- `scripts/build-ogre.mjs` — the adapter build and the pin check.
- `scripts/build-input.mjs`, `scripts/build-hlms-skin.mjs` — the other two DSOs.
- `scripts/build-framework.mjs` — the guest toolchain, its version guard, and the
  generated flags.
- `scripts/build-examples.mjs` — discovery and the per-example `npm run build`.
- `scripts/build-stamp.mjs` — the content-hash stamp and its input sets.
- `scripts/gen-session.mjs` — `session.json` → `asc` flags + generated constants.
- `scripts/gen-abi-doc.mjs`, `scripts/test-abi-docs.mjs` — the ABI pages and their
  drift gate.
- `scripts/check-ogre-capacities.mjs`, `scripts/check-naga-pin.mjs`,
  `scripts/check-win32-headers.mjs`, `scripts/normalize-eol.mjs` — the cheap gates.
- `scripts/test.mjs` — the eighteen suites and the scheduler.
- `ci/README.md`, `ci/linsys2.md`, `ci/docker.mjs` — the two CI paths.
- `third_party/README.md`, `third_party/patches/` — the pin, the patches, the
  Win32 overlay.
