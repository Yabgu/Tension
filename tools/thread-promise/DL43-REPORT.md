# DL43 — the identity names the file that runs; the park that registers

| | |
|---|---|
| `~/work/Tension` | branch `feat/dl43-policy-park` off `febe79e` |
| `~/work/TensionScript-a2` | branch `feat/dl43-policy-park` off `c93ecdf9` |
| installed compiler | `6edd9597` → final **`3d6941da8d7d`** (it moved three times as this round's own compiler edits landed; the last is the shipped one) |
| binaryen | `e84dfd8e` unmoved; `main` untouched in both repos |
| `--check` | **9/9 PASS** at Phase 0 and at the end |
| threads | 12 → **15** (`k = 3`, declared before the tests were written) |
| CI (Tension) | **`45613177518` success** — `Wake path guard`: `running 10 tests`, `10 passed; … 5 filtered out` |
| CI (TensionScript) | run **`45613183279`**: every job green **except `Gate 4 (threads)`** — §6 |

**I99 and I101 are closed. I102 is closed. One job in the compiler's own CI is red and
its cause is localised, not fixed (§6).**

---

## 1. Phase 0 — the four items

**Preflight.** `Tension` @ `febe79e` and `TensionScript-a2` @ `c93ecdf9` — the SHAs
the brief names, both clean. Installed compiler `6edd95979ae4` = the tree's
`dist/assemblyscript.js`, std `diff -r` silent, binaryen `e84dfd8e`. `--check`
**9/9 PASS**, exit 0.

**Delta arithmetic, both directions.** Artifacts whose exports include `__taskWake`:

```
release:  suspend-serve-fiber  suspend-serve  two-waiters-late  wake-on-worker
debug:    the same four
```

DL42 moved **11** (4 release + 7 debug). The export set is **8**, not 11 — and the
three extra are real: `async-main-promise`, `promise-fallback` and `rt-guards` moved in
the **debug** profile only, and their only difference is **17 bytes in `.debug_line`**.
DL42's std edit was net **+23 lines**, and a debug build records task-rt line numbers
for every inlined function it keeps — those three carry `TaskSlot`/`TaskState`
accessors from after the edit point, so their line table shifted. Release builds carry
no DWARF, which is why exactly four moved there.

**So the brief's sharpening is too sharp**, and the honest rule is: *an artifact moves
iff it contains `__taskWake` code, or it is a debug build whose DWARF names a task-rt
line after the edit.* Not "iff it exports `__taskWake`". Nothing to stop for: the
declared 11 was complete; the export set was never the same thing as the moved set.

**I102 red case, from clean, smallest form.** Comment-only line appended to
`std/assembly/task-rt.ts`, chain run **without `--force`**:

```
compiler: src → dist/assemblyscript.js   159 inputs → 411ca27a0e4b   recorded 411ca27a0e4b   PASS
compiler: dist → installed               6edd95979ae4 (tree)        6edd95979ae4 (installed) PASS
build-test-programs: 0 built, 35 up to date
guests: tests/programs/**/*.ts → build/*.wasm   35 built after source   35 current   PASS
rebuild: 9/9 links PASS
```

The **input digest moved**; the **identity did not**; every guest was skipped; the check
was green. Then a real line (`const DL43_PROBE_CONST: i32 = 42;`) — identical result,
`2ce70117c344` beside `6edd95979ae4`, `0 built, 35 up to date`, **9/9**. Reverted,
rebuilt, 9/9. That is the before-picture §2 fixes.

**I103 probe — PROVEN.** `wake-on-worker.ts` copied to `/tmp/dl43-probe/` with an inert
exported `main`, built with the wake flags + `--stackful-backend=fiber`, run bounded at
90 s:

```
EXIT=0
main: spawning / main: index=2 / main: spawn=0
worker: BEFORE the await
inner: AFTER the await, value=0        <- the producer posted 500
worker: AFTER the await, value=0
main: wakes served=0
main: join=0 / main: done
```

The artifact imports **no `scheduler::park`** (`node /tmp/imports.mjs … | grep scheduler`
→ empty), and the host logged `executor 1 left the park seam having recorded 0 park(s)`.
A bare `await` on a stamped handle is `if (!t.settled) t.drive(); t.value`, and a
producer handle's `drive()` is `{}`: the value is never delivered and nothing says so.
**I103 stands as written.** Not added to `tests/programs/`.

**Declared deltas** (written to `/tmp/dl43-declared.md` before Phase A ran): A — 0
artifact bytes, 70 records rewritten. B — `dist` moves, 70 records rewritten, 4
artifacts move, threads 12 → 15.

---

## 2. Phase A — I102: the identity names the bundles that run

### The load chain, established by breaking each file

```
bin/tensionscript.js  →  await import("../dist/asc.js")
dist/asc.js           →  from "@yabgu_gm/tensionscript"
                      →  package.json exports["."] = ./dist/assemblyscript.js
```

Proven both ways, by appending a `throw` to each file and compiling a guest:

| broken file | compile |
|---|---|
| `dist/asc.js` | **exit 1**, `Error: DL43 probe: this file is broken` |
| `dist/assemblyscript.js` | **exit 1**, the same throw, surfacing from that module's body |

And the std is in the **first** one: `dist/asc.js` contains `libraryFiles` and
`export function __taskWake`; `dist/assemblyscript.js` contains neither. That is the
hole: a `std/` edit moves `asc.js` and leaves `assemblyscript.js` byte-identical, which
is exactly what the identity hashed.

### The change

`toolchain.mjs`'s `compilerIdentity()` now digests **both** bundles, in a fixed order
(`COMPILER_BUNDLES = ['asc.js', 'assemblyscript.js']`), through one exported helper
`compilerBundleDigest(distDir)`. It is the same primitive as before — sha256 over file
bytes concatenated, no structured form — so it is not a second canonical form.

`rebuild.mjs`'s `compiler: dist → installed` row compares **the same pair through the
same helper**, which it did not before: it compared `assemblyscript.js` alone and would
have called a `std/`-only rebuild equal.

### The `std → installed std` row: what it actually checks

**Nothing reads the installed `std/` directory at compile time.** Measured: appending
`export function __dl43Broken( {}` to
`node_modules/@yabgu_gm/tensionscript/std/assembly/task-rt.ts` and compiling a guest
gave **exit 0**. The library a guest compiles against is embedded in `dist/asc.js`.

So the row is retitled **`compiler: std mirror (no compile reads it)`**, its comment
corrected (it used to claim "the guest compiles against the wrong library", which was
false), and it now states what it checks: that the install step left the package's
on-disk sources in step with the tree. The load-bearing guarantee moved to the identity.

### The four cases, each with the check's own rows

**1. clean → 9/9** (after the records were rewritten by the identity change):

```
compiler: dist → installed   5da4fa6b8380 (tree)   5da4fa6b8380 (installed)   PASS
guests: built by the installed compiler   70 recorded by 5da4fa6b8380   70 of 70 current   PASS
rebuild: 9/9 links PASS
```

**Delta, measured**: **0 of 70 artifacts moved**, **70 of 70 records rewritten** — exactly
as declared (35 release + 35 debug sidecars each now name `5da4fa6b8380`).

**2. edit `std/assembly/task-rt.ts` → the chain without `--force` rebuilds:**

```
build-test-programs: 35 built, 0 up to date, 35 total (35 for a new compiler)
compiler: dist → installed   79dba7aeeabb (tree)   79dba7aeeabb (installed)   PASS
rebuild: 9/9 links PASS
```

The identity moved (`5da4fa6b` → `79dba7aa`) and **every guest rebuilt**, no `--force`.
That is the defect closed.

**3. revert → 9/9**, identity back to `5da4fa6b8380`, and a byte comparison across the
whole round trip: **0 of 70 artifacts moved** — the probe constant never changed codegen.

**4. control — a doc edit is not an input:**

```
build-test-programs: 0 built, 35 up to date, 35 total
rebuild: 9/9 links PASS
```

An identity that moves on everything is not an identity.

---

## 3. Phase B — I99 + I101: the park that registers

### What the park carries, and who writes it

`policy.await` on the continuation shell lowered to `module.suspend(tag, [-2])` and
**told the host nothing**, so a producer's completion for the awaited `(class, key)` had
no park to match. `builtin_async_suspendParked`'s continuation arm now emits:

```ts
__parkRemote(task);                     // ~lib/task-stack
module.suspend(ASYNC_AWAIT_TAG, [-2]);  // unchanged
```

`__parkRemote` writes two facts before the suspension:

- the **`(class, key)`**, through `scheduler::park` — an import this build already has,
  so **no new ABI import**;
- the **slot, the record and the handle**, through a registry in `~lib/task-stack`.

and the host hands the completion back through **the same `__taskWake` the plain backend
uses** — the wake cell (`{id, payload}`) then this store's own wake entry, which settles
`record.payload/status/done` and calls `__settleFromRecord` on the handle, then queues
the slot on the shell's ready ring. `drainReady`'s ring is what resumes the continuation.

**Why the park and not the session loop.** On the continuation shell the worker **owns
its thread**: `__workerMain` is a loop that blocks in `atomicWait`, so `service_wakes`
never runs for that store. The park seam is the only moment the host holds it. The seam
therefore waits for its own completion (`take_delivery` → `claim_early` → condvar, bound
**30 s**) and hands it back before returning.

### The choice among DL42 §3's two options

Neither, exactly — and the reason is the measurement above. Both candidates assumed the
*wake* would come from the session loop. It cannot, on this backend. So the slot is
published through a registry keyed by the continuation slot (DL42 §3's second option,
"publish `slot → TaskState`"), and the host is given the same `(class, key)` the fiber
backend gets. No `drive()` emission changed; the change is in the builtin that *is* the
`policy.await` suspension, which is narrower than a `drive()` rewrite.

### The four orderings — one source, two builds, one transcript

| ordering | flag | continuation | fiber |
|---|---|---|---|
| sticky | `--post-completion 4,7,500` | `value=500`, exit 0 | `value=500`, exit 0 |
| live | `--post-completion-after-parks 4,7,1` | `value=0`, exit 0 | `value=0`, exit 0 |

Both print:

```
main: spawning
main: index=<i>
main: spawn=0
inner: AFTER the await, value=<v>
worker: AFTER the await, value=<v>
main: wakes served=1
main: join=0
main: done
```

**Byte-identical over 10 runs each**, all four orderings (`1 distinct stdout hash(es)
over 10 runs`). `main: wakes served=1` is part of the contract and is written on both
paths — the fiber park already did, the continuation hand-back now does.

**Payload control**: `4,7` → `value=0` on both; `4,7,500` → `value=500` on both.

### I101 — determinism by construction

Two changes, both in the program:

1. **The pre-park marker moved to stderr** — `worker: BEFORE the await` was the one line
   the worker emitted before its park, so on stdout it raced `main: spawn=` (measured in
   CI at DL41, run `45518298844`). It goes through `tension::io::log` at level 2, so a
   hang is still diagnosable: `INFO worker:worker: BEFORE the await` on stderr.
2. **A `go` word (control-block header word 7).** The worker's first act is to wait for
   main to publish it, and main publishes it *after* printing `main: spawn=`. So every
   main line precedes every worker line on both backends, without either side guessing a
   clock.

Nothing was excluded from the expectation: `main: index=` is matched **by prefix**
(DL40's rule), and every other line is exact and in order.

### Two regressions I hit on the way, and what they cost

- The hand-back fired on the **plain** shell too (`!is_fiber_backend` covers both), and
  `a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake` plus
  `a_second_waiter_is_refused…` went red: `__taskWake` resumed a Promise state machine
  from inside its own park. Fixed by gating on the shell: `ExecutorPool::runs_own_loop()`,
  detected from the module's exports (`__asyncPump` is emitted only by the stackful
  shell) — the same module-surface idiom DL41 used for `scheduler::completion`.
- `--post-completion-after-parks` **had never worked on fiber**: the armed producer fires
  at the *end* of the park seam, which the fiber arm never reaches because it suspends
  inside its own `if`. Measured on the way in: `fiber executor: task 0 parked on class 4
  key 7 and no completion arrived`, exit 1. The producers now run **before** any
  suspension; the plain path is unchanged (`claim_early` still runs first, so a sticky
  completion is claimed before a producer can post).

### Red cases

| test | mutation | result |
|---|---|---|
| continuation sticky + live | pre-fix artifact in the fixture slot, compiler hidden (the CI path) | **FAILED** — `suspend-serve (live): did not finish in 30 s — the served body parked and nothing resumed it`; sticky failed on the transcript |
| fiber live | producers disabled for fiber (the pre-DL43 ordering) | **FAILED** — `exit was not 0` / `fiber executor: task 0 parked on class 4 key 7 and no completion arrived` |

### The delta set, both ways

Declared: 4 artifacts, 70 records, threads +3. **Measured: 70 of 70 artifacts moved.**
The declaration was wrong, and here is why:

- Adding the continuation park needs guest-side code in a module every async guest
  links. The first shape (registry in `~lib/task-rt`) put **+1 336 B** into `count.wasm`,
  because an *exported* function in an always-parsed module is a DCE root.
- Moved behind a function-value hook in `~lib/task`, the registry lives in
  `~lib/task-stack` (parsed only by stackful builds): **+341 B** on `count.wasm`, and
  the three new globals appear in `features/threads.debug.wat`.
- Every artifact that links `~lib/task` therefore grew slightly; `suspend-serve` and
  `suspend-serve-fiber` changed substantially (the program itself changed).

**Zero is not reachable this way.** A zero-cost design exists — a stackful-only wake
entry the host calls instead of `__taskWake` — but that is a second completion route, and
one route is what this round is for. If code size matters more than that invariant, the
alternative is stated here rather than guessed at.

---

## 4. Phase C — the gate, the register, the docs

- The three tests are in `--test threads` and in the `Wake path guard` step (seven names
  → ten).
- Parity table: **row 8 `suspend-serve` is PASS on both backends, both orderings.** Row 9
  `wake-on-worker` stays not-a-pair — I103 is proven (§1). Row 7 `schedule-order` stays
  the one DIFF, out of scope.
- `--check` **9/9** from bare `cargo build` + `cargo build --release`, digests quoted in
  §5.
- **`docs/build.md` has no §9 on records** — §9 is "Cross-platform", and its `--force`
  guidance is about the Ogre bootstrap. The note went to a new **§6.3, "The rebuild chain
  and what its identity covers"**, beside the non-behaviour gates, and says the identity
  now covers both loaded bundles, that a `std/` edit no longer needs `--force`, and the
  one case that still wants it.

---

## 5. Gates, each from its own line

| gate | result |
|---|---|
| threads | **15 passed, 0 failed** |
| fiber | **6 passed** |
| fiber-executor | **7 passed** |
| async_on_main | **2 passed** |
| fiber-runner | **5 passed** |
| debugger | **5 passed** |
| async_main_promise | **2 passed** |
| `--bin` default | **307 passed** |
| `--bin` audio-only | **298 passed** |
| census | **71/82 pass, 0 skipped, 11 no-source**, no stale-engine warning |
| `--check` | **9/9 PASS**; release and debug both `7c4bb3dcb174`; identity `3d6941da8d7d` |
| guests / artifacts | **35 / 70** (no new programs) |

---

## 6. The one failing job, localised not fixed

**`TensionScript-a2` run `45613183279`**: `Check`, `Binaryen`, `Coverage`,
`Bootstrap (debug)`, `Bootstrap (release)`, `Async core loop`, `Loader`, `Runtimes`,
`Compiler (ubuntu)`, `Features`, `Compiler (windows)` — **all success**.
**`Gate 4 (threads)` — failure**, at `tests/rt/gate4.js`, instantiating the fixture:
first `TypeError: WebAssembly.Instance(): Import #3 "scheduler": module is not an object
or function`; with the harness's `scheduler` namespace added, an `abort` inside the
fixture.

**Bisect, measured:**

| variant | Gate 4 |
|---|---|
| emission disabled in `builtin_async_suspendParked` | **[ SUCCESS ] 134 checks** |
| emission on, registry's sink install disabled | failure |
| emission on, `__parkRemote` = the bare `hostPark` call only | failure |

So it is **not** the registry, the `Map`, or the `__settleFromRecord` write: the bare
host call in that position reproduces it. Tension's wasmtime host runs the same artifact
correctly on both backends, so the difference is the engine — Gate 4 runs under Node with
`--experimental-wasm-wasmfx`, and V8's wasmfx is the only place a host import call from
inside a resumable frame is exercised. Two plausible causes, neither verified: V8 refuses
the host call in that frame, or the fixture's small arena cannot take the path.

**Not fixed, and not hidden.** The `scheduler` namespace was added to Gate 4's harness
because the import exists whether or not a program parks (`thread.rs`'s `link_worker`
documents the same for `parkState`); it does not make the test pass.

---

## 7. Findings

- **I99 CLOSED.** One source, two builds, one transcript; the continuation park registers
  and the host hands the completion back through `__taskWake`.
- **I101 CLOSED by determinism**, not by exclusion: stderr marker + `go` word; 10/10
  identical runs on four orderings.
- **I102 CLOSED.** The identity digests both bundles a compile loads; a `std/` edit now
  rebuilds the guests without `--force`; the `std` row says what it checks.
- **I103 PROVEN** (§1): a bare `await` on a stamped handle on the fiber backend imports no
  `scheduler::park`, prints `value=0` for a producer that posted 500, `wakes served=0`,
  exit 0.
- **I104 (proposal, new): `--post-completion-after-parks` never worked on fiber.** The
  armed producer fires at the end of the park seam and the fiber arm suspends before it.
  Closed by moving the producers ahead of the suspension; the flag's doc should say the
  ordering it describes now holds on both backends.
- **I105 (proposal, new): the continuation park imports `scheduler::park` into every
  shared stackful build**, because the registry entry point is an exported std function.
  Cost +341 B on `count.wasm`. Named with the alternative in §3.
- **Gate 4 (a2) is red** and its cause is localised to the bare host call in a resumable
  frame under V8's wasmfx (§6).

---

## 8. Commits and state

```
TensionScript-a2  5a3955f6  the continuation policy park registers, so the host can resume it
TensionScript-a2  4a0b46ef  std: emit the continuation park only for shared builds; regenerate
                            fixtures; Gate 4 stub
Tension           3e26b9e   DL43: the identity names the file that runs; the park that registers
Tension           7a3b902   tests: refresh the served-park fixtures for the final compiler
```

Both branches `feat/dl43-policy-park`, pushed, both trees clean, `main` untouched in both
(`Tension` `56ddabb`, `TensionScript` `3f59ec08`), binaryen `e84dfd8e` unmoved.

---

## 9. What I did not verify

Windows (WIN22), the scheduler (I95), `schedule-order`, the fiber pool ceiling, migration,
cross-thread fiber hand-off, `f32`/64-bit payloads, `npm ci`, and the cause of the Gate 4
abort (§6) — localised to one call, not understood.
