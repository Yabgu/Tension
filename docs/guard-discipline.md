# Guard discipline — checks that establish correctness, not presence

This page exists because the instance list outgrew any single limitations
entry. This is a class-level defect, not a bug report.

## The rule

> **A guard must derive its expected value from the single source of truth and
> compare.** `existsSync`, presence checks, and hardcoded literals that mirror a
> source all fail silently the moment the source moves.

The source of truth is whichever file the consumer is actually compiled or run
against:

| what is being checked | source of truth |
| --- | --- |
| `tensionscript` version | `tension-framework/package.json` + `package-lock.json` |
| Ogre-Next build flags | `third_party/ogre-next-build/CMakeCache.txt` |
| adapter ABI version | `tension-core/include/tension_adapter.h` |
| binary freshness | `packages/build-stamp.json` via `scripts/build-stamp.mjs` |
| Win32 overlay symbols | `CMake/Templates/OgreVulkanBuildSettings.h.in` |

A guard that asks "does this exist?" answers a question nobody asked. The
question is always "is this the one the build expects?".

## Why it matters more than an ordinary bug

Every instance below produced a *green* signal while the tree was wrong. A
presence check cannot fail loudly, because the condition it tests — something is
there — is almost always true after the first successful build. The failure
surfaces later, in a different component, with a symptom that names the wrong
subsystem.

## Instances

### 1. `scripts/bootstrap.mjs:229-234` — install presence, not flag divergence

`let installed = mediaOk && mainLib !== ''` decides "nothing to do" from whether
an Ogre-Next install exists. A change to `OGRE_CONFIG_ENABLE_FREEIMAGE` (or any
other configure flag) does not invalidate it, so the old install is kept and the
new flag is silently ignored.

Observed: `npm run bootstrap` reported "already exists — nothing to do", exit 0,
while `CMakeCache.txt` still said `OGRE_CONFIG_ENABLE_FREEIMAGE:BOOL=ON` and the
installed `RenderSystem_Vulkan.so.4.0` still listed `NEEDED libfreeimage.so.3`.
Documented in [`build.md`](build.md) §2.

*Correction:* stamp the configure flag set beside the install (the way
`writeStamp` already works for the adapters) and reconfigure on divergence.

### 2. `scripts/build-framework.mjs:46` — compiler exists, not declared version

```js
if (!existsSync(compiler)) { npm(['install', ...]); }
```

A stale `tensionscript` satisfies this forever.

Observed: `@acakar/tensionscript 0.7.1` installed 2026-10-21, while
`package.json` declared `@yabgu_gm/tensionscript@^0.13.2` and the lock had
recorded 0.13.2 since 2026-11-04. The facade's source began using `@managed`
struct field defaults on 2026-10-23, which 0.7.1 rejects with
`TS1109: Expression expected` and `TS1206: Decorators are not valid here`. 40
parse errors per example, 4 of 18 examples failing, and the Ogre guest fixtures
unbuildable — all from a two-month-old binary. Cleared by one `npm install`.

### 3. `scripts/build-examples.mjs:126` — dependency link exists, not version

```js
const wired = existsSync(join(dir, 'node_modules', '@yabgu_gm', 'tension-core'));
if (!wired) { npm(['install', ...]); }
```

The comment above it shows the author was reaching for this exact distinction —
"a tree installed before these packages existed has a node_modules and no link
to them" — but checks the link's existence rather than its version. Same defect
as #2, one level down: a tree with the package present at the wrong version
passes.

### 4-8. Test scripts check binaries by existence, not freshness

`scripts/build-stamp.mjs` exists precisely to answer "was this binary built from
the current sources", and `scripts/run-example.mjs:35` is the one caller of
`staleness()`. Every test script instead does `existsSync`:

- `scripts/test-ozz.mjs:27` (core binary), `:31` (adapter), `:45` (compiler)
- `scripts/test-ogre.mjs:37` (core), `:44`/`:49` (DSO), `:103` (compiler)
- `scripts/test-input.mjs:93` (compiler)
- `scripts/test-input-edge.mjs:47-48` (compiler — no guard at all: it spawns
  whatever `npmBin()` returned, so an absent compiler is a spawn error rather
  than a clear message)
- `scripts/test-framework.mjs`

> `scripts/test-2d.mjs` was deleted in Pass B of the 2D merge along with the stub
> core it drove and the C++ adapter under test, and
> the 2D example launcher went in Pass C with the launcher layer itself. The
> instances below that cite either are kept as written: they are the record of
> what those harnesses taught, and the lesson outlives the files. What replaced
> them is `tension-core/tests/render2d_open.rs` (behaviour),
> `scripts/parity-2d.mjs` (the two backends against each other), and each 2D
> example's own `test.mjs` (the pixel assertion the launcher used to own).
  (same shape)

A stale binary passes every one of them. That is how an adapter built against
adapter ABI 5 kept being loaded by a host at ABI 6 during the v6 work — it was
caught only because the DSO's own version check refused it at `dlopen`, which is
the *right* kind of guard arriving by luck.

### 9. ABI version mirrored as literals in three tests

`tension-core/tests/ogre_smoke.rs:306`, `tension-core/tests/session_smoke.rs:192`,
and `tension-core/tests/ogre_surface.rs` each held `TENSION_ADAPTER_ABI_VERSION`
as a number. All three said `5` after the ABI became `6`. `ogre_smoke`'s
assertion compared against the literal, so it tested the number rather than the
stub, under a comment claiming it tested "the current ABI".

Fixed in `f812072`: all three now parse `#define TENSION_ADAPTER_ABI_VERSION`
out of `tension-core/include/tension_adapter.h`, following the pattern
`framework_layout.rs` already used for `TENSION_ADAPTER_LAYOUT_HASH`.

## The other half: a guard that never runs

> **A guard has to run, and has to be able to say whether it ran.** A suite that
> is not in the gate is not evidence; one whose startup failure reads like an
> assertion failure — or whose driver crash reads like a defect — tells a reader
> the wrong thing about the tree.

The rule at the top of this file governs a guard that runs and answers wrongly.
Everything under **Instances** is that: a check that ran, passed, and was
describing something else. This section is the other way a guard fails, and it is
not the smaller one, because a suite nobody runs and a suite that passes produce
exactly the same amount of evidence.

### 10. `scripts/test-2d.mjs` — the suite was never in the gate, and its harness could not start

The 2D capability's only test is a standalone script; it has no entry in
`scripts/test.mjs`. Nothing ran it but a person who remembered to.

It also could not run at all. `tension-2d/tests/smoke_core.cpp` builds its
`tension_core_api` by hand and left `abi_version` zeroed; `adapter_init` refuses
a mismatched table, so **every** invocation answered `init -> -22` from `3896be6`
(ABI v6, 2026-11-07) until `272309e`, and exited 1. The message named the adapter,
so a reader who did see it would have looked at `adapter.cpp`.

Neither half is a presence check. The suite was correct and would have passed;
nobody had wired it in, and when its harness broke the failure described the
wrong component.

Fixed by `272309e`: the stub sets `TENSION_ADAPTER_ABI_VERSION`, and the test
script now names a driver crash as a driver crash.

### 11. `npm test -- --isometric` — a crashed run reads as a failing one

The isometric suites *are* in the gate, and on this rig they fail: `tension-core
exited null` immediately after `2d: open: GPU device up`. That is SIGSEGV inside
the GL driver on the first `present`, not a defect in the adapter — proven by
running the same suite against a DSO built from the previous commit, which dies
identically.

Until `272309e`, `test-2d.mjs` reported that same death as `FAIL (exit spawn
error)`, the line an adapter defect produces. A reader has no way to tell "this
machine cannot run the scenario" from "the code is wrong", so the honest report —
"the driver died" — was unavailable for exactly the failures most likely to be
environmental.

**What makes these guards rather than comments that run:**

- A suite the gate does not run is a scratch script. Either wire it in, or say
  where its results are recorded and who is expected to read them.
- A harness must fail at startup with a message that names the harness. The
  zeroed `abi_version` produced `init -> -22`, which reads as an adapter refusal
  and was not one.
- Exit codes must separate pass, skip, assertion failure and harness death. Four
  states, four codes — a signal is not an exit status, and conflating them hides
  the environment.

## Guards in this tree that are already correct, and why

Worth naming so the shape is copyable:

- `scripts/check-win32-headers.mjs` — compares the overlay's symbol set against
  the upstream template **in both directions** and fails on drift either way.
  Derives, does not restate.
- `scripts/build-native.mjs` `auditLinkage()` — reads `ldd`/`readelf` output from
  the built artifact rather than trusting the build's exit code.
- `scripts/build-native.mjs` `auditSdlSourceReferences()` / `auditSdlLinkage()` —
  scan the actual tree and the actual ELF `NEEDED` lists.
- `framework_layout.rs` — parses the layout hash from the header.
- `tension-2d/reference/adapter.cpp:412` (then `tension-2d/src/adapter.cpp`) — checks `core->abi_version` at load. It did
  not, until ABI v6; the omission is what made a stale 2D DSO undetectable.

## Applying the rule

For a **version**: read both sides and compare. Never `existsSync`.
For a **flag set**: read the generated config (`CMakeCache.txt`,
`OgreBuildSettings.h`) and compare against what the script passes.
For a **binary**: call `staleness()` from `build-stamp.mjs`.
For a **mirrored constant**: parse the source of truth at test time.

If a guard cannot derive the expected value, it is not a guard — it is a
comment that runs.
