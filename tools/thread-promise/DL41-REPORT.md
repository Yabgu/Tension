# DL41 — a worker serves a task that suspends, and a failed worker is refused (I96, I97)

**Round:** DL41, 2026-11-25. A served body that *parks* is now resumed on the fiber
backend, and a worker that cannot start refuses the run instead of leaving it silent.

| | |
|---|---|
| Tension | `feat/dl41-suspend-serve` @ **`00fbc5e`**, off `f76fd9b` (DL40) |
| TensionScript-a2 | `feat/dl41-suspend-serve` @ **`e1addaca`** — **no commit this round** |
| binaryen | `e84dfd8e…`, not moved (`third_party/` untouched) |
| installed compiler | **`6edd95979ae4`**, unmoved — no compiler or `std` change |
| `--check` | **9/9 PASS**; guests **34 → 35**, artifacts **68 → 70** |
| census | **71/82**, 0 skipped, 11 no-source, run alone |
| threads | **10 → 11** (declared before the run) |
| CI | **`45520074681` success** (`b44641b`) — `Wake path guard`: `6 passed; 5 filtered out` |

---

## 1. Phase 0 — the trees, as measured

```
TensionScript-a2  feat/dl40-fiber-serve @ e1addaca   clean  →  feat/dl41-suspend-serve @ e1addaca, clean
Tension           feat/dl40-fiber-serve @ f76fd9b    clean  →  feat/dl41-suspend-serve @ f76fd9b
installed compiler     6edd95979ae4   (= tree dist/assemblyscript.js)
TENSIONSCRIPT_DIR      /home/acakar/work/TensionScript-a2
```

`TensionScript-a2` is **untouched** this round and that is a result, not an omission:
both defects were on the host side. The compiler hash the banner reports
(`yabgu_gm-tensionscript-0.14.1-g41b8721bc4f0.tar`) and the `dist` digest
(`6edd95979ae4`) are the same as DL40's, and `--check`'s two compiler links read
PASS, so every artifact in this round was produced by the compiler DL40 shipped.

---

## 2. Phase A — the control, and the two baselines

### 2.1 The control is green on continuation (`wake-on-worker`)

The shape the brief asks for — a served body that awaits a producer — already exists
as a green test, and it is the control:

```
$ tension-core --executors 2 --post-completion 4,7 \
    tension-core/tests/programs/fixtures/thread/wake-on-worker.wasm
exit=0
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
inner: AFTER the await, value=0
worker: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
```

Park → the session loop's own `__taskWake` (`wakes served=1`, host header word 6) →
resume → both `AFTER` lines → `join=0`. Entry index 0, flags `WAKE_FLAGS` (thread
flags minus `--enable stack-switching`: the Promise shell).

### 2.2 The value on the continuation backend is 0, and that is the channel

Same run with a payload posted:

```
$ tension-core --executors 2 --post-completion 4,7,500 <same artifact>
… identical, byte for byte: inner/worker `value=0`
```

The session loop resumes the task with `__taskWake(idsPtr, count)`
(`std/assembly/task-rt.ts:349`), which names **ids and nothing else** — it clears the
slot, nulls the record and calls `state.resume(state)`. `Delivery::payload` carries
the word as far as the host, and the host drops it. `__taskResume(idsPtr, classesPtr,
payloadsPtr, count)` exists in the same file for exactly this ("the host is the only
thing that knows what arrived, so the record has to come with the wake") but **no
compiled guest exports it** — re-exporting it is a guest-source change, and the
scratch region a payload needs is 16 bytes where the loop's scratch is 8. So the
continuation backend structurally answers 0.

**This round does not repair that** and §7 records it as I98.

### 2.3 The fiber baselines — two of them, and both are why this round exists

There are two shapes, and **neither parks on both backends**. That is the round's
finding.

**Shape A — a bare `await` on a stamped handle** (the control's own shape, plus an
exported `main` so the stackful shell will build it):

```
$ wasm-tools print build/suspend-serve-A-fiber.wasm | grep '(import "scheduler"'
(no output)
exit=0
main: spawning · main: index=2 · main: spawn=0
worker: BEFORE the await
inner: AFTER the await, value=0
worker: AFTER the await, value=0
main: join=0 · main: done
```

It imports **no `scheduler::park` at all**: on a fiber build the Promise-protocol
await has no suspension site, so the body runs straight through, reads 0, and exits
**0**. That is I97's "the park vanishes" — and note it does not even trap, so nothing
reports it.

**Shape B — `policy.await`**, the only await lowered to a real suspension on fiber.
Pre-fix it could not even start a worker:

```
$ tension-core --executors 2 --post-completion 4,7,500 <fiber artifact>
exit=124 (bound: 90 s)
main: spawning · main: index=1 · main: spawn=0
2026-11-24T23:44:04Z ERROR thread: executor 1 could not run: the module did not
instantiate as a worker — the worker's import set is env::memory, env::abort,
env::__executorCount, env::__startThread, scheduler::park and tension::io, and a
capability import has no answer on a worker thread: unknown import:
`scheduler::completion` has not been defined
```

I96, verbatim. The run then hung rather than exiting 0, because the guest waits for a
wake that can never arrive — see §4.2, which is the part the brief's "exits 0" was
missing.

---

## 3. Phase B — the worker can instantiate (I96)

### 3.1 What `scheduler::completion` answers on a worker store

`tension-core/src/thread.rs`, `ExecutorPool::link_worker`. Two answers, and which one
is asked is a fact of the thread:

- **Inside a fiber** — `fiber::running()` — answer `fiber::completion_value()`: the
  word the producer returned for the park that just resumed. This is the same
  thread-local main's `scheduler` answers from (`scheduler.rs:link_scheduler`), so the
  two stores cannot disagree about the meaning.
- **Otherwise** — answer the payload of the delivery this store's session loop last
  applied to that task id, or `0` when it applied none. The map is filled in
  `service_wakes` at the moment the wake is applied (before the call, because the
  resumed task asks on its very next line).

Neither path invents a channel: the fiber path reads the word `fiber::run` already
carries, and the loop path keeps the word `Delivery` already carries. `fiber::running`
is new (`fiber.rs`) and is a *predicate* rather than a flag beside `suspend_current`,
because one acts and one asks.

### 3.2 A worker that cannot start refuses the run

That is the second half, and it is not cosmetic: the log line alone was the DL26/DL28
silent-refusal class. Three pieces:

1. `run_worker`'s error path records the message in the pool (`note_failure`).
2. It publishes "this executor stopped" — writes `2` into the executor's state word
   and `atomic_notify`s it — so a guest waiting in `__threadJoin` returns. The block's
   address is found the way the guest finds it: `__heap_base` rounded to a page,
   confirmed by the control block's magic word `0x54485244`, scanning page boundaries
   (at most 256 reads, and only on the failure path).
3. `strand_refusal` (main.rs) takes the failures **before** the strand check and
   refuses, because a worker that never instantiated made no parks and the strand
   counts cannot see it.

**Red case, measured** (the linker definition removed, everything else unchanged):

```
$ tension-core --executors 2 --post-completion 4,7,500 \
    tension-core/tests/programs/fixtures/fiber/suspend-serve-fiber.wasm
exit=1
main: spawning · main: index=1 · main: spawn=0
main: wakes served=0 · main: join=0 · main: done
Error: 1 worker(s) could not run, so the run is refused rather than reported as a
success: executor 1 could not run: the module did not instantiate as a worker — …
unknown import: `scheduler::completion` has not been defined
```

**exit 1, named.** Before this the same run hung (exit 124, §2.3) and for a program
that did not wait it exited 0 with `wakes served=0`.

---

## 4. Phase C — a served body can suspend (I97)

### 4.1 The path, in order

1. The artifact says it wants the fiber backend. The host reads that **from the
   module's own import list** (`ExecutorPool` stores `fiber_backend`): a fiber build is
   the only one that imports `scheduler::completion` (measured — the continuation build
   imports `scheduler::park` and never `completion`), so nothing has to be threaded
   through `ExecutorPool::new`'s callers.
2. `worker_main` runs `__workerMain(id)` — the served-entry call — inside
   `fiber::run`, on the worker's own thread, with a producer.
3. The producer answers a park from the pool: the owner's inbox first
   (`take_delivery`, a new single-delivery take that leaves the rest), then the sticky
   buffer (`claim_early`) and the inbox again. That is the same two places the session
   loop used, in the same order.
4. The worker's `scheduler::park` now calls `fiber::suspend_current` when the artifact
   is a fiber build, **before** `claim_early`. On resume it marks this store's park
   record resolved — `fiber::run`'s producer cannot reach the `Store` (its signature is
   `FnMut(Park) -> Option<i32>`), so the store's own thread is the only place that
   write can happen.
5. It also bumps header word 6 (the guest's served-wake counter), because this path
   consumes the delivery that `service_wakes` would otherwise have counted. The first
   attempt did this from the producer and wrote nothing: a worker store's `__controlBase`
   is 0 until `__workerMain` binds it, so the base was 0 — measured as
   `wakes served=0` on a run that had resumed.
6. Back in the guest, `scheduler::completion` answers `fiber::completion_value()` and
   the awaited expression settles from the record (`__settleFromRecord`, DL35).

No ABI change, no new import, no second carrier: `Delivery` → producer → `fiber::run`'s
`COMPLETION` → `scheduler::completion`, the chain DL35/DL36 already built for main.

### 4.2 `--post-completion` for a fiber guest with a pool

The flag was excluded for **every** fiber guest (`executor != Backend::Fiber`), on the
stated ground that its park is resolved by the boot fiber's staged producer. That is
true for a guest with no pool. It is false for a **thread** guest: its workers are
separate stores whose parks are resumed by the pool, the staged vector is main's, and
`fiber::run` on main's entry never sees them — so nothing could ever complete a
worker's park. The exclusion now covers only `fiber && executors.is_none()`, which is
the case its comment describes, and `async-on-main-fiber` (no `--sharedMemory`) is
unchanged.

### 4.3 Measured

```
$ tension-core --executors 2 --post-completion 4,7,500 \
    tension-core/tests/programs/build/suspend-serve-fiber.wasm
exit=0
main: spawning
main: index=1
main: spawn=0
worker: BEFORE the await
inner: AFTER the await, value=500
worker: AFTER the await, value=500
main: wakes served=1
main: join=0
main: done
```

Three consecutive runs, byte-identical after the log lines. **The producer's word 500
reaches the resumed body inside a worker**, which is what DL40 declared impossible.

The ordering is worth one line: main's only wait is `__threadJoin`, and the body calls
`__executorExit(1)` **after** it has printed. Two earlier shapes were measured and
rejected — a bounded spin on the served word (200 000 000 iterations was not enough on
this host, so a healthy run read 0) and an unbounded spin (a worker that never started
left a spinner spinning instead of a join returning, which is the silence §3.2 removes).

---

## 5. Phase D — the gate, and what it cannot be

| | |
|---|---|
| artifact | `tension-core/tests/programs/fixtures/fiber/suspend-serve-fiber.wasm` |
| size / sha256 | **32 515 B** / `509cba41e15c7eed…` |
| sidecar | `…wasm.build.json`, compiler `6edd95979ae4`, source `thread/suspend-serve.ts` |
| test | `a_served_body_that_parks_is_resumed_with_the_producers_word_on_fiber` |
| threads delta | **10 → 11**, declared before the run; measured 11 |
| CI | the test's name added to the **Wake path guard** filter |

The artifact was verified as the **committed** one: `build/suspend-serve-fiber.wasm`
and the fixture `cmp`-identical, and a run on the fixture path directly gives exit 0
with the transcript above. It needs no compiler, which is why it can join that CI step.

### 5.1 It is not a pair, and that is the round's finding

The brief asks for a continuation/fiber pair like DL40's three. **No single program can
be one**, and both halves are measured, not argued:

- the shape that **completes on continuation** (a bare `await` on a stamped handle)
  imports no `scheduler::park` when built for fiber — there is no suspension site, so
  the twin asserts nothing (§2.3, shape A);
- the shape that **suspends on fiber** (`policy.await`) does not complete on the
  continuation backend:

```
$ tension-core --executors 2 --post-completion 4,7,500 build/suspend-serve-cont.wasm
exit=124 (bound: 90 s)
main: spawning · main: index=3 · main: spawn=0
worker: BEFORE the await
```

That is the DL29/DL30 serve split the brief excludes — but it means the two backends do
**not share a served-body suspension contract**: the Promise await parks on continuation
and has no fiber site; the stackful await has a fiber site and no continuation serve
path. Closing it is a lowering problem (a fiber park site for the Promise await, or a
serve path for the stackful one), not a host one, and it does not belong to this round.

So the continuation control for this behaviour is `wake-on-worker` (§2.1, already a
green test), and the fiber row is asserted on its own transcript. Per the brief's own
escape ("if no shape is green on continuation, stop and report that as the finding"),
this is the report; the pair is DL42's or a lowering round's to build.

### 5.2 The parity table — 8 rows

| # | program | continuation | fiber | note |
|---|---|---|---|---|
| 1 | async-on-main | PASS | PASS | DL38's gate |
| 2 | spawn-join | PASS | PASS | DL40 |
| 3 | two-workers | PASS | PASS | DL40 |
| 4 | spawn-entry-async | PASS | PASS | DL40 |
| 5 | count | — | — | excluded: never parks |
| 6 | spawn-refusals | — | — | excluded: never parks |
| 7 | schedule-order | PASS | **DIFF** | I95 — no core loop on fiber; DL42, out of scope |
| 8 | **suspend-serve** | **no twin** (§5.1) | **PASS, `value=500`** | this round |

0 trap, 0 hang, 0 silent zero on the rows that ran. Row 8's continuation column is the
finding, not a pass and not a skip.

---

## 6. Gates — each with the command that produced it

| gate | command | result |
|---|---|---|
| threads | `cargo test --no-default-features --features audio --test threads` | **11 passed**, 0 failed |
| fiber | `… --test fiber` | **6 passed** |
| fiber-executor | `… --test fiber-executor` | **7 passed** |
| async_on_main | `… --test async_on_main` | **2 passed** |
| fiber-runner | `… --test fiber-runner` | **5 passed** |
| debugger | `… --test debugger` | **5 passed** |
| async_main_promise | `… --test async_main_promise` | **2 passed** |
| `--bin` | `cargo test --bin tension-core` (default features) | **307 passed, 0 failed** |
| `--check` | `TENSIONSCRIPT_DIR=… node scripts/rebuild.mjs --check` | **9/9 PASS** |
| guests / artifacts | same, rows 5 and 8 | 35 / 35 current · 70 of 70 current (**34 → 35**, **68 → 70**) |
| census | `node tools/debug-conformance/runner.js --workers 8` | **71/82 pass, 0 skipped, 11 no-source** |

**`--bin` is 307 under default features**, which is the brief's number. Under the
thread suites' own set (`--no-default-features --features audio`) the same target
reports **298**, and I am quoting both rather than one: the nine extra tests are
feature-gated ones, not a discrepancy in the round.

Continuation artifacts: the compiler (`6edd95979ae4`) and `std` are unmoved, `--check`
reports `35 built after source, 35 current` and `70 of 70 current`, and the guest
builder rewrote **only** the two new artifacts (`2 built, 33 up to date`). Nothing else
was written, so nothing else moved.

Red cases:

1. **No `scheduler::completion` on the worker** → exit **1**, refused by name (§3.2).
2. **The fiber suspension mutated out** (`else if false && …` in the worker's park) →
   the new test **FAILED** at 30 s: `suspend-serve-fiber: the transcript is not the
   contract`. Restored, 11 passed.

---

## 7. Findings

- **I96 closed.** A fiber guest's worker instantiates; `scheduler::completion` has
  honest semantics on a worker store; a worker that cannot start refuses the run by
  name with exit 1.
- **I97 closed for the fiber backend.** A served body parks on the worker's fiber and
  is resumed by the pool's producer with the producer's word.
- **I98 (new, reported not fixed).** The continuation backend cannot carry a
  completion's payload into a resumed task: the session loop resumes with the ids-only
  `__taskWake`, and `__taskResume` — which does carry `(class, payload)` — is exported
  by no compiled guest, and needs 16 bytes of scratch where the loop has 8. Measured:
  `--post-completion 4,7,500` prints `value=0` on continuation and `value=500` on
  fiber. Fixing it is a control-block scratch change → an artifact change → its own
  round.
- **I99 (new).** The two backends have no shared served-body suspension contract
  (§5.1). A fiber park site for the Promise await, or a continuation serve path for the
  stackful one, is a lowering change. Until then no pair test can cover a suspending
  served body, and row 8 of the parity table will stay single-column.
- **`--post-completion`'s fiber exclusion was too wide** (§4.2) and is now the case it
  describes.

---

## 8. CI

| run | commit | what it says |
|---|---|---|
| `45518215598` | `83ee68e` | before the filter was extended — the new test did not run |
| `45518298844` | `00fbc5e` | **failure**, and it was worth having: see below |
| `45519246318` | `fcb41b9` | failure, same cause; that commit is the report only |
| **`45520074681`** | **`b44641b`** | **success** — `Wake path guard`: `running 6 tests`, `test a_served_body_that_parks_is_resumed_with_the_producers_word_on_fiber ... ok`, `6 passed; 0 failed; … 5 filtered out` |

**CI caught a race this host did not.** On `45518298844` the transcript came back with
`main: spawn=0` *after* the worker's lines:

```
left:  ["main: spawning", "main: index=1", "worker: BEFORE the await", …,
        "main: spawn=0", "main: wakes served=1", …]
right: ["main: spawning", "main: index=1", "main: spawn=0", "worker: BEFORE the await", …]
```

That is the program, not the backend: `main: spawn=0` is printed *after*
`__spawnThread` returns, and that call has already started the worker, so which line
lands first is a race. Locally main always won it; on CI it lost. The assertion now
requires the line **exactly once** with the value `0` and does not fix its position —
the only line whose position is not asserted, with the reason stated beside it. Every
other line is exact and in order, and mutating the fiber suspension out still fails
the test (re-measured after the tolerance was added).

Branch `feat/dl41-suspend-serve` on `Yabgu/Tension`. `main` untouched; nothing pushed
to `main` in either repo.

---

## 9. What I did not verify

- **Windows.** Nothing was run there (WIN22 follows).
- **Scheduling policy** (I95) — untouched, as the brief requires.
- **`f32` / 64-bit payloads** — the completion word is `i32`; the `f0` rule in
  `rt.classify` is still unused by this path.
- **Migration**, I76, I78, I87 — untouched.
- **A producer that completes a worker's park from a second guest.** The producer used
  here is the host's `--post-completion`; a cross-store guest producer for a
  *suspending* served body is not exercised.
- **The `--bin` count under each feature set** — 307 default, 298 with
  `--no-default-features --features audio` (§6). Both were run; neither is extrapolated.
