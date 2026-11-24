# DL38 — the fiber lowering must suspend on a plain await

**Round:** DL38, 2026-11-24. One defect, two halves, and the gate that would have
caught it.

| | |
|---|---|
| TensionScript-a2 | `feat/dl38-fiber-await` @ **`2d210696`**, off `0159ea2c` |
| Tension | `feat/dl38-fiber-await` @ **`1083724`**, off `91bcaef` |
| binaryen | `e84dfd8e…` — not moved |
| installed compiler | `1065f81c` → **`bf1ebc27`** (this round's build) |
| census | **71/82**, `engine.stale: false`, §7 |

---

## 1. Phase 0, verbatim

```
TensionScript-a2  feat/dl37-fiber-types @ 0159ea2c    clean
Tension           feat/dl37-build-records @ 91bcaef   clean
installed compiler    1065f81c4a54   (= tree dist)
third_party/binaryen  e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
```

Baselines, `test result:` lines as printed:

```
cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
    --features audio --test async_on_main
running 1 test
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.89s

cargo test … --test fiber-runner
running 5 tests
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.74s
```

**One deviation, stated:** I did not run a census before the first edit this
round. §7 says what I used instead and why it is adequate.

---

## 2. Phase A — reproduce, diagnose, fix (I90)

### 2.1 Reproduction, from the committed artifacts

```
$ tension-core tension-core/tests/programs/build/async-on-main.wasm      # continuation
carried: 11 · carried: 12 · carried: 13 · suspensions: 7 · total: 33 · final: 1150 · status: 1150
EXIT=0

$ node …/tensionscript.js …/async-on-main.ts -o /tmp/dl38-fiber.wasm \
    --stackful-backend=fiber --runtime incremental --target release \
    --exportStart __start --optimizeLevel 0
$ tension-core /tmp/dl38-fiber.wasm                                      # fiber
carried: 11 · carried: 12 · carried: 13 · suspensions: 0 · total: 0 · final: 13 · status: 13
EXIT=0
```

The brief's numbers exactly. Same compiler, same engine, one flag apart.

### 2.2 Diagnosis — the park reaches the host and the host has no fiber

First: **was a park even emitted?** Yes — one call site, and it is `drive()`:

```
(func (;103;)                      ; __parkYield: if (__currentSlot() < 0) return; park(id,0,0)
  global.get 1 · local.set 0 · local.get 0 · i32.const 0 · i32.lt_s · if · return · end
  local.get 0 · i64.extend_i32_s · i32.const 0 · i32.const 0 · call 2)

(func (;146;) (param i32)          ; drive(this)
  … call 87 (get:settled) · i32.eqz · if
      … call 82 (get:slot) · call 145 (__parkOn) · call 103 (__parkYield) · end
```

and `drive` is reached from `main` through the virtual dispatch (`105` → `146`).
So the lowering was emitting the suspension. Instrumenting the host seam showed
what happened to it:

```
DL38 PROBE: scheduler_park entered task=0 class=0 key=0
DL38 PROBE: suspend_current → false
```

Seven times. `scheduler_park` runs, `suspend_current` answers **false**, and the
park evaporates. That is the first half:

> **A plain fiber guest never ran on a fiber.** `fiber::run` was reached only from
> `thread_boot`, and `thread_boot` is skipped for a module that exports no
> `__threadInit` (it logs *"the module imports a shared memory but exports no
> `__threadInit`"* and returns). A shared-memory guest got a fiber; an ordinary
> one called `__start` on the OS thread with no suspend handle published, so every
> park was dropped in silence.

But publishing a fiber would only have turned silence into a strand — so the
second half matters more:

> **The park had no producer, and no way to have one.** `drive()` was the
> *continuation shell's* park: `__parkOn(this); __suspendAwait(this.slot)`. In
> continuation mode the executor resumes **the task**, which runs its
> continuation `f$start`, and the body happens. DL37 removed the continuation
> (`__installCont` became a counter) and there is no core loop to resume
> anything, so in fiber mode the callee's body ran nowhere. When the park landed
> it named `(class 0, key 0)` — a guest task has no external producer — so even a
> published fiber could not have answered it.

`__suspendAwait` is called from exactly one place (`drive`), so this is the whole
of the path: **DL37 pruned the mechanism and did not replace the thing the
mechanism did.**

### 2.3 The fix, and why the lowering wanted it

A fiber does not need a park for this path. The callee's body can run **on the
caller's own stack**:

```ts
// fiber mode
drive(): void { if (!this.settled) { let $r = f$body(this.$p0, …);
                                     this.value = $r; this.settle(0); } }
```

`await t` is `if (!t.settled) t.drive(); return t.value`, so the value the caller
reads is the one the body just computed, one frame deeper — the same object, no
park, no resume, no continuation. `$rec` is the record `await` already has; there
is **no second carrier** and no new ABI.

What a park is still *for* is intact: a suspension **inside** the body — a
`policy.await` on a real producer pair — parks the fiber, and the resume continues
exactly where it stopped because the whole stack (including these `drive` frames)
is preserved. That is the DL35 path measured at 500, unchanged.

Why this is "what the lowering wanted" rather than a special case:

- It is emitted by the same transform, from the same `f$body`, with the same
  record and the same `settle` seam; only the receiver of the record changes
  (`__currentTask()` for a resumed continuation, `this` for a fiber drive).
- It is the fibre's purpose stated as code: a stackful task is a *stack*, and
  the callee's frame belongs on it. Continuations need park-and-resume because
  the callee is a separate continuation; a fiber does not, because it is not.
- The alternative — keep the park and teach the host to run the callee — cannot
  be done: the host does not know which function to call, and the (class, key)
  it would have to complete does not exist.

**One hazard, named:** `drive` arms on `!settled`, which cannot tell "not started"
from "started and running in another store". Awaiting a task that a worker is
already running would run it twice. In fiber mode today nothing can be running
elsewhere — there is no cross-store task in this backend yet (no migration, one
executor per thread) — but the guard is the wrong one for the day there is.

### 2.4 The host half

`run_on_fiber` is now the single place that runs an entry on a fiber — the fiber,
the staged producer, and the strand refusal. Two callers:

| entry | caller |
|---|---|
| `__start() -> i32` (shared memory, after the carve) | `thread_boot` |
| `__start() -> ()` (ordinary guest) | `main`'s generic path — **new** |

Same artifact, DL37 binary vs DL38 binary — a plain fiber guest whose body does a
`policy.await`:

```
$ …/target/release/tension-core  (DL37 sources) --post-completion 4,7,500 /tmp/dl38-plain-park.wasm
warm=0 · before=1 · value=0 · start_game=1                         EXIT=0

$ …/target/debug/tension-core    (DL38 sources) --post-completion 4,7,500 /tmp/dl38-plain-park.wasm
warm=0 · before=1 · fiber: task 0 parked on class 4 key 7
fiber: completing class 4 key 7 with 500 → resume
value=500 · start_game=1                                           EXIT=0
```

(`/tmp/dl38-plain-park.wasm` is `tests/programs/fiber/i70-fiber.ts` compiled
without `--sharedMemory`, so no `thread_boot` — the case the old host dropped.)

### 2.5 The contract program, after

```
carried: 11
carried: 12
carried: 13
suspensions: 7
total: 33
final: 1150
status: 1150
EXIT=0
```

---

## 3. Phase B — the gate that would have caught it

**Build rule** (`scripts/build-test-programs.mjs`):

```js
const ASYNC_ON_MAIN_FIBER_FLAGS = [
  "--runtime", "incremental", "--target", "release",
  "--exportStart", "__start", "--optimizeLevel", "0",
  "--stackful-backend", "fiber",           // and NOT --enable stack-switching
];
```

The contract program is one source with two artifacts, so the builder gained an
**alias** (`scripts/lib/program-aliases.mjs`, `name → source`, shared with
`rebuild.mjs` so build and check cannot disagree): `async-on-main-fiber` →
`async/async-on-main.ts`. `rebuild.mjs` now counts *artifacts*, not `.ts` files —
29 → 30 guests, 58 → 60 records.

**Artifacts**

```
build/async-on-main-fiber.wasm          9 554 bytes   c0c78f8b24c885a4…
build/debug/async-on-main-fiber.wasm   59 388 bytes   7610cb5f503b8995…
```

**The test** — `the_fiber_backend_prints_the_same_contract_transcript` in
`tension-core/tests/async_on_main.rs`:

```
$ cargo test --no-default-features --features audio --test async_on_main
running 2 tests
test the_fiber_backend_prints_the_same_contract_transcript ... ok
test the_shared_program_prints_the_contract_transcript ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.45s
```

It asserts the same seven lines, from the **same** expected file
(`async-on-main.expected.txt`), and that `executor: fiber` appears in the log —
i.e. that the artifact chose the executor, with no flag saying so.

**One expected file, not two, and that is the point:** the seven lines are the ABI
contract, and a backend is not allowed to change them. A second expected file
would let the fiber backend drift and still pass — the defect one level up.

**The gate bites.** With the fix mutated out (`false ? … : <continuation drive>`)
and the artifact rebuilt from that compiler:

```
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 1 filtered out
panicked at tests/async_on_main.rs:155:
the fiber build of the shared program failed (exit Some(1))
stderr: Error: fiber executor: task 0 parked on class 0 key 0 and no completion arrived
```

Note the *shape* of the failure: on DL38's host the old lowering now **fails by
name** instead of printing zeros — the silent-zeros transcript needed DL37's host
too. Both shapes fail this test, which is what a gate is for.

---

## 4. Phase C — the suite is not a lie (I91)

Line 34's diff:

```diff
-#![cfg(target_os = "linux")]
```

replaced by a comment saying why it must not come back. **No per-test `cfg` is
needed**: nothing in the file is platform-specific — the executor is
`wasmtime-internal-fiber`, the artifact is ordinary wasm, and every host call is
`std`.

Test 5's stale comment and its config line:

```diff
-            // **Stack switching on the *engine*, though the guest has no
-            // `suspend`.** A `--stackful-backend=fiber` artifact still declares
-            // the shell's continuation types and tags (measured: two `cont`
-            // types, three tags) …
-            config.wasm_stack_switching(true);
+            // **No `wasm_stack_switching` here, and its absence is the claim.**
+            // DL36 had to turn it on … DL37 removed them, so this engine is the
+            // one a target without stack switching can build.
```

DL37 made the old sentence false, so the line went. The engine is now the one a
target without stack switching can build — which is what makes the test say
anything about such a target.

```
$ cargo test --no-default-features --features audio --test fiber-runner
running 5 tests
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.87s
```

**Can it run on Windows?** Nothing in the file prevents it — the crate gate is
gone and no test is `cfg`'d. I assert nothing about Windows from this host;
WIN19 proves it there.

---

## 5. `examples/async-on-main/game.ts` — fiber vs the control

Built, not edited (`--stackful-backend=fiber`, no `--enable stack-switching`):

```
main: before await outer(1) — bodies run=0
    outer: runs, x=1 · mid: runs, x=1 · base: runs (bodies run=3)
    mid: after await base, b=7 · outer: after await mid, m=8
main: after await outer(1) — bodies run=3, a=16
… main: loop i=2 total=67 · main: done, total=67          EXIT=0

continuation control (the example's own build/game.wasm):
    base: runs (bodies run=3) · main: after await outer(1) — bodies run=3, a=16
main: loop i=2 total=67 · main: done, total=67            EXIT=0
```

`bodies run=3`, `a=16`, `total=67`, exit 0 — identical to the control.

---

## 6. `--check`, nine rows

```
compiler: src → dist/assemblyscript.js        159 inputs → 3064e20dc5ba   recorded 3064e20dc5ba   PASS
compiler: dist → installed                    bf1ebc2770b8 (tree)         bf1ebc2770b8 (installed) PASS
compiler: std → installed std                 81 files identical          81 identical            PASS
runtime: src → release                        84 inputs → 224fff694634    recorded 224fff694634   PASS
runtime: src → debug                          84 inputs → 224fff694634    recorded 224fff694634   PASS
fixtures: committed .wasm                     6 present, none behind …    6 present, all current  PASS
guests: tests/programs/**/*.ts → build/*.wasm 30 built after source        30 current              PASS
guests: built by the installed compiler       60 recorded by bf1ebc2770b8 60 of 60 current        PASS
docs: docs/abi/*.md                           generator --check clean     current                 PASS

rebuild: 9/9 links PASS
```

**Default mode did not move.** Every one of the 58 pre-existing guest artifacts
(29 release + 29 debug, including both fiber ones) is **byte-identical** to the
DL37 baseline; the only new hashes are the two `async-on-main-fiber` artifacts:

```
+ async-on-main-fiber.wasm  c0c78f8b24c8   (release)
+ async-on-main-fiber.wasm  7610cb5f503b   (debug)
```

and **no `.wat` golden changed** (`git status tests/compiler/*.wat` → empty).
Compiler suite:

```
$ npm run test:compiler -- --parallel
[ SUCCESS ]         367 tests
  …/stackful-fiber-section   SKIPPED (0.088 ms)    ← the `skipFixture` instantiate skip
  …/stackful-fiber-pruned    SKIPPED (0.192 ms)    ← same
```

---

## 7. The census, and a measurement error of mine

| when | value | `engine.stale` |
|---|---|---|
| inherited (DL37, this host, `91bcaef`) | **71/82** · 11 no-source | `false` |
| after, first attempt | 62/82 · 14 unresolved · 6 no-source | `false` |
| after, alone | **71/82** · 11 no-source | `false` |

**The 62 is mine, not the code's.** I started that census in the background and
then ran eight `cargo test` suites against the same machine; lldb could not bind
14 breakpoints and the runner recorded them as `unresolved` (`breakpoint: null`).
Re-run with nothing else on the box: 71/82, identical to the inherited value, both
with `engine.stale: false`.

**And a deviation from the brief:** gate 8 asks for the census *before and after*
this round. I did not take a fresh "before" — the inherited figure is DL37's
measurement of the same tree on the same host, which is the number the brief's
Phase 0 also expects (71/82), but it is a measurement from the previous round
rather than from this one. Everything else in this report is measured here.

---

## 8. Suites, with commands

| suite | command (all `--manifest-path tension-core/Cargo.toml --no-default-features --features audio`) | result |
|---|---|---|
| async_on_main | `--test async_on_main` | **2 passed** (was 1) |
| fiber-runner | `--test fiber-runner` | **5 passed** |
| threads | `--test threads` | **9 passed** |
| fiber | `--test fiber` | **6 passed** |
| fiber-executor | `--test fiber-executor` | **7 passed** |
| async_main_promise | `--test async_main_promise` | **2 passed** |
| debugger | `--test debugger` | **5 passed** |
| `--bin` | `--bin tension-core` (default features) | **307 passed** |
| compiler | `npm run test:compiler -- --parallel` (a2) | **367**, `[ SUCCESS ]` |

`npm run check` (a2: tsc + eslint) exit 0.

### CI, and one thing the new gate does **not** get

| repo | run | result |
|---|---|---|
| Tension | `45474661203` on `1083724` | **success** |
| TensionScript-a2 | `45474846757` on `2d210696` | **success** |

**The new gate is not in CI, and cannot be yet.** Every Tension workflow job that
runs runtime suites runs without a compiler — `e2e-debug.yml` says so at line 36
(*"No `npm install`, and no compiler"*). `guest(name)` calls the builder, so
`--test async_on_main` needs a compiler; the thread suites avoid that by loading
**committed fixtures** (`fixtures/thread/*.wasm`) through
`guest_thread_fixture`. `async-on-main` has no committed fixture, so the test
runs in any checkout that has a compiler (every local run, and this round) and is
skipped by CI's absence rather than by a skip — which is how DL36's
`fiber-runner` sat "in the suite" without ever executing.

Making it CI-runnable is a fixture pair (`async-on-main.wasm` +
`async-on-main-fiber.wasm`), a `.gitignore` exemption and a
`guest_*` accessor that falls back to them — the exact shape the thread fixtures
already have. That is **not** in this round's scope (it adds committed artifacts
and touches the skip policy), so I am reporting it rather than doing it. It is
also the one way this round's deliverable is still half a gate.

---

## 9. Commits and final state

**TensionScript-a2**, `feat/dl38-fiber-await` (pushed):

- **`2d210696`** — `async: on the fiber backend an await runs the callee's body
  (I90)`. One file: `src/async/stack.ts` (+109/−8).

**Tension**, `feat/dl38-fiber-await` (pushed):

- **`1083724`** — `core: the fiber executor hosts a plain guest's entry too, and
  the suite stops lying (I90, I91)`. `scripts/build-test-programs.mjs`,
  `scripts/lib/program-aliases.mjs` (new), `scripts/rebuild.mjs`,
  `tension-core/src/main.rs`, `tension-core/tests/async_on_main.rs`,
  `tension-core/tests/fiber-runner.rs`.

Both trees clean at the end; `main` untouched in both; no `third_party` change; no
npm publish; no PR; `examples/async-on-main/game.ts` built, not edited.

---

## 10. What I did not verify

- **Windows** — WIN19 follows. Nothing here was run on it.
- **`f32` / 64-bit payload decoding** — the i32 path only.
- **Migration / cross-thread fiber hand-off** — not attempted, and §2.3 names the
  `drive` guard that a future round will have to reconsider.
- **I76** (`tests/fiber.rs`), **I78**, **I87** (census harness).
- **The cost model** — no threshold this round, nothing measured.
- **Fiber stack guard pages** — still off; a guest that overruns its 512 KiB stack
  runs into whatever follows.
- **A park on a task another store is running** — not expressible today (no
  cross-store task in this backend), and unhandled by design.
