# DL40 — a worker can serve a task on the fiber backend (I94)

**Round:** DL40, 2026-11-24. The three trapping parity rows now pass on both
backends, asserted by one test that runs the pair.

| | |
|---|---|
| Tension | `feat/dl40-fiber-serve` @ **`44aad42`**, off `8bd57ea` |
| TensionScript-a2 | `feat/dl40-fiber-serve` @ **`e1addaca`**, off `2d210696` |
| binaryen | `e84dfd8e…`, not moved |
| installed compiler | `bf1ebc27` → **`6edd95979ae4`** |
| census | **71/82**, run alone |
| CI | run **`45503291289`** — success; `Wake path guard` ran **5 tests, 5 passed** |

---

## 1. Phase 0, as measured

```
TensionScript-a2  feat/dl39-parity @ 2d210696   clean
Tension           feat/dl39-parity @ 8bd57ea    clean
installed compiler     bf1ebc2770b8   (= tree dist/assemblyscript.js)
third_party/binaryen  e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
```

Branches `feat/dl40-fiber-serve` created in both.

---

## 2. Phase A — reproduce, then diagnose

All six runs with output **redirected to files**, never read through a pipe.

| program | continuation | fiber (before this round) |
|---|---|---|
| `spawn-join` | `workIndex=4 deliverIndex=5 spawn=0 pumpRounds=11935 answer=242 replyOrigin=1 join=0` · exit **0** | trap in func 100, then `pumpRounds=2000000 answer=-1 replyOrigin=-1` · exit **124** |
| `two-workers` | `observed=12 valueSum=66 workerSum=30 join1=0 join2=0` · exit **0** | trap ×2, `observed=0`, **no** `valueSum`/`workerSum` · exit **0** |
| `spawn-entry-async` | `spawnIndexOf=3 spawn=0 · worker: entered · worker: AFTER the await, value=0 · main: join=0 · main: done` · exit **0** | `spawnIndexOf=1 spawn=0`, trap in func 135 · exit **124** |

### 2.1 The trap mapped to its intrinsic (the DL39 report's number, corrected)

DL39 named "function 100 → `unreachable`". Function indices are **per module**, so
the number is not the identity. Both traces are the same intrinsic:

```
spawn-join:        func (;100;) (type 1) (param i32) (result i32) unreachable
spawn-entry-async: func (;135;) (type 1) (param i32) (result i32) unreachable
```

and in both modules the caller is the five-parameter function `__serveOne`
(`(i32,i32,i32,i32,i32) -> i32`, `std/assembly/thread.ts:1172`) whose body is
`local.get 1; call <the stub>; local.set 5; unreachable` — param 1 is the
`$starts` index.

> **The stub is `__serveCont(index: i32) -> i32`** — `src/builtins.ts:12685`,
> whose fiber branch was `return module.unreachable()`. `__resumeTask` sits at
> `src/builtins.ts:12844` with the same body, and is reached the moment
> `__serveOne` gets past the first call (`std/assembly/thread.ts:1179`) or
> `Executor.step` drains a ready slot (`:941`).

### 2.2 What the worker needs at each step

1. **Receive an index.** `__workerMain` reads `sig + 16` and calls
   `__serveOne(e, entry, arg, key, origin)`.
2. **Produce something runnable and suspendable.** Continuation: allocate a slot,
   `cont.new` the `$starts[i]` function into it, answer the slot; `__resumeTask`
   resumes it. That is exactly what a fiber build has nowhere to put — no `$ct`, no
   table (DL37 removed them).
3. **On completion, run whatever the body queued.** `__resumeTask(slot)` for each
   ready entry.

The fiber equivalents are the ones DL38 already established one level up:
**run the body here**, and **a slot means "drive this task"**. Nothing in steps 1-3
needs a continuation; it needs the entry and the task object.

---

## 3. Phase B — the fiber serve path

### 3.1 What changed, and why each piece is shaped that way

**`__serveCont(index)`** (`src/builtins.ts:12685`) — fiber branch:

```rust
module.drop(module.call(SERVE_ENTRY, [ index ], TypeRef.I32)) ; module.i32(-1)
```

`$serveEntry` (`src/compiler.ts`, emitted by `emitStartsTable` **in fiber mode
only**) is an index chain over the `$starts` entries:

```wat
(func $serveEntry (param i32) (result i32)
  (if (i32.eq (local.get 0) (i32.const 0)) (then (call $~asyncMainStart)) (else
  (if (i32.eq (local.get 0) (i32.const 1)) (then (call $f$spawnStart)) (else
  (i32.const 0))))))
```

**An index chain, not `call_indirect`.** Every entry is `() -> i32` by
construction, but their *heap types* are not guaranteed to be the same type index,
and `call_indirect` on a mismatched type is a validation error; the chain calls the
functions whose names are already in the table, so there is nothing left to resolve.
It is emitted where the table is final, the same place and for the same reason as the
`__spawnIndexOf` helpers.

`-1` is the honest answer for "no slot": `__serveOne` reads `awaited < 0` and queues
nothing, because the body already ran.

**`__resumeTask(slot)`** (`src/builtins.ts:12844`) — fiber branch calls
`~lib/task-stack/__driveSlot(slot)`:

```ts
export function __driveSlot(slot: i32): void {
  let taskOrNull = __taskAt(slot);
  if (taskOrNull) changetype<TaskBase>(taskOrNull).drive();
}
```

**The `__resumeTask` decision, stated:** a fiber *cannot* be resumed by index — the
slot is not a table position any more. But the slot's **meaning** survives: "there
is a task here with work to do, run it". `drive()` is that call on this backend
(DL38 runs the body inline), so the intrinsic keeps its contract with an ordinary
call behind it, and no legal program can reach a trap. That is the brief's
"by construction, not by leaving a trap".

### 3.2 No new ABI, nothing moved

The park/completion imports, `tension.stackful-backend`, and the record's payload
word are untouched. `Fiber::new` has no `Send` bound and nothing crosses a thread;
the fiber still runs on the calling thread.

### 3.3 Measured, after

```
spawn-join          exit 0   workIndex=1 deliverIndex=2 spawn=0 pumpRounds=10558
                             answer=242 replyOrigin=1 join=0
two-workers         exit 0   observed=12 valueSum=66 workerSum=30 join1=0 join2=0
spawn-entry-async   exit 0   spawnIndexOf=1 spawn=0 · worker: entered (async entry) ·
                             worker: AFTER the await, value=0 · main: join=0 · main: done
```

Every value equals its continuation build. The `$starts` indices differ (1/2 vs
4/5; 1 vs 3) because the fiber shell's table has no core-loop entries — a fact of
the module, covered in §4.

### 3.4 One limitation this round did **not** remove, measured

A worker's `__workerMain` still runs **directly on its thread**, not on a fiber
(`worker_main` in `tension-core/src/thread.rs` calls it on the worker's `Store`).
So a served entry that **parks** would call `scheduler::park` → `suspend_current`
→ `false`, and the park would be dropped — the DL38 defect one level up. None of
the three programs parks inside a served entry (their `await` targets settle
immediately, which is why they were the ones that trapped rather than hung), so
this did not surface here. Making a worker's entry run on a fiber needs a producer
on the worker side — the session loop's own delivery — and that is a design change
of the same size as this round, not a line. **I did not attempt it, and I am not
claiming the fiber backend parks a served task.**

---

## 4. Phase C — the twins, and the pair test

### 4.1 The twins

| artifact | bytes | sha256 (12) |
|---|---|---|
| `fixtures/fiber/spawn-join-fiber.wasm` | 29 391 | `6a45d1f61e57` |
| `fixtures/fiber/two-workers-fiber.wasm` | 29 572 | `316143d4b3d0` |
| `fixtures/fiber/spawn-entry-async-fiber.wasm` | 26 040 | `61d8df896c94` |

`scripts/lib/program-aliases.mjs` gained three entries (`spawn-join-fiber` →
`thread/spawn-join.ts`, etc.); `scripts/build-test-programs.mjs` gained the three
names in `PROGRAMS` with `FIBER_FLAGS` (thread flags, **no** `--enable
stack-switching`, `--stackful-backend fiber`). Their continuation builds are
committed too, in `fixtures/thread/`, so the pair test runs where no compiler
exists — CI.

### 4.2 The test, and the two key classes it does not compare

`tests/threads.rs::the_cross_store_programs_print_the_same_values_on_the_fiber_backend`
— **`--test threads` 9 → 10**. It runs both artifacts of each program, parses every
`key=value` line, and requires them to match exactly, with two named exceptions:

- **`$starts` indices** (`workIndex`, `deliverIndex`, `spawnIndexOf`) — positions in
  a table the two shells build differently. The assertion is the
  backend-independent one: the index is **resolved (≥ 0) and is not the factory's
  (4)**. The exact `=3` stays in the continuation test, where it is a fact of that
  build.
- **`pumpRounds`** — an iteration count that moves between two runs of the *same*
  build (11935, 13272, 10558 across runs above), which is why the continuation tests
  use it as a bounded escape and never assert it.

Nothing else is narrowed: a value that differs fails, and so does a fiber line the
continuation build does not print.

### 4.3 Red case, on the fixture path

Runs are bounded at 30 s, because **the defect's signature is a hang** — the first
red attempt sat for the full 600 s command timeout, which is precisely the class of
silence this arc keeps removing.

```
# no compiler (CI's configuration), the pre-DL40 artifact in the fixture slot:
spawn-join-fiber: the fiber build did not finish in 30 s — a served task parked and
nothing resumed it. That is exactly how the pre-DL40 artifact fails.
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 9 filtered out; finished in 30.26s

# same path, the round's artifact back in place:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out; finished in 1.35s
```

### 4.4 CI

```diff
             --test threads -- \
               a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake \
               a_second_waiter_is_refused_when_the_completion_arrives_after_both_parks \
               a_foreign_delivery_fails_the_run_by_name \
-              an_async_worker_entry_is_served_as_its_spawn_entry
+              an_async_worker_entry_is_served_as_its_spawn_entry \
+              the_cross_store_programs_print_the_same_values_on_the_fiber_backend
```

Run **`45503291289`**, job `E2E debug`, step **`Wake path guard`**:

```
2026-11-24T22:46:03.4070293Z running 5 tests
2026-11-24T22:46:08.0443768Z test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 4.64s
```

Five, where DL39's run printed four — the added filter is the pair test, and it
passed there.

### 4.5 The parity table — all seven rows

| program | continuation | fiber | verdict |
|---|---|---|---|
| `async-on-main` | `suspensions: 7 total: 33 final: 1150 status: 1150` | **identical** | **PASS** (DL38; two tests) |
| `spawn-join` | `answer=242 replyOrigin=1 join=0` | **identical** | **PASS** |
| `two-workers` | `observed=12 valueSum=66 workerSum=30 join1=0 join2=0` | **identical** | **PASS** |
| `spawn-entry-async` | `worker: entered · AFTER the await, value=0 · join=0 · done` | **identical** | **PASS** |
| `count` | `executors=3 … controlStride=16432` | identical output | **excluded**: never parks — no `scheduler::park` import, no `__suspendAwait` — so a twin proves only that the artifact loads |
| `spawn-refusals` | `spawnMain=-1 … join=0` | identical output | **excluded**, same reason |
| `schedule-order` | 15 lines ending `steps 15` | 15 lines, call order not priority order, `steps 0` | **DIFF — out of scope (I95 / DL41)**. Both transcripts in `DL39-REPORT.md` §3.3 B; unchanged this round |

**0 trap, 0 hang** among the asserted rows. The one DIFF is the scheduling policy,
which the brief excludes by name.

---

## 5. Phase D — the three measurements

### 5.1 How many parked tasks a pool of N workers holds

**N — one per worker thread — and it is structural, not a limit of this code.**
wasmtime keeps its `CallThreadState` in a thread-local LIFO, so a second fiber
parked on one thread makes the first one's resume trip an assertion inside the
engine (DL24, measured). `tests/fiber-runner.rs::two_parked_tasks_on_two_threads_both_complete`
is the standing measurement that two threads can each hold one parked fiber and both
complete; nothing in this round changes that, and the worker path added here parks
nothing (§3.4).

I did **not** build a new probe for "two parked served tasks on one worker": no
program in the tree parks inside a served entry, and §5 of the brief forbids new
guest sources. The ceiling is inherited and cited, not re-measured.

### 5.2 What happens when the pool is exhausted — measured

`two-workers` wants two workers; the same artifact at two pool sizes:

```
--executors 2  → spawn1=0 spawn2=0  observed=12 valueSum=66 workerSum=30 join1=0 join2=0   exit 0
--executors 1  → spawn1=0 spawn2=-1                                                        exit 0
```

**Refused by name, with a negative value (`-1`), not queued and not blocked.**
`__spawnThread(2)` answers `-1` when the pool has no executor 2. (A park with no
completion is the other half of the same question and is answered elsewhere: it
strands, and the run fails naming the task — `fiber-runner`'s
`a_never_woken_park_is_refused_at_shutdown`.)

### 5.3 The cost of a served task, fiber vs continuation

**Not measured, and DL27's harness does not apply.** That instrument
(`TENSION_MEASURE=1`) times `round_trip`/`host_dispatch`/`queue_wait` for awaits
*inside one store* driven by `--post-completion-each-park`; a served task's cost is
dominated by what it does not touch — a `$starts` index crossing to another store,
a thread rendezvous, an entry compiled in the receiving store. Reporting DL27's
numbers as this cost would be reporting a different quantity, so the honest answer
is that this needs its own instrument.

---

## 6. Gates

| # | gate | measured |
|---|---|---|
| 1 | three trap cases pass on fiber, continuation beside them | §3.3 — all exit 0, all values equal |
| 2 | parity table 7 rows, 0 trap, 0 hang, reasons on exclusions, DIFF with both transcripts | §4.5 |
| 3 | `--test threads` rises by exactly the assertions added | **9 → 10** (declared before the run: one new test) |
| 4 | a CI run executing the new assertion | **`45503291289`**, `E2E debug` / `Wake path guard`, `ok. 5 passed` |
| 5 | compiler suite unchanged 367 | **367**, `[ SUCCESS ]` (a fiber `.wat` golden regenerated — §7) |
| 6 | `--check` 9/9; guests 30 → 33; artifacts 60 → 66 | `rebuild: 9/9 links PASS`; `33 current`; `66 recorded … 66 of 66 current` |
| 7 | continuation artifacts byte-identical to `bf1ebc27` | **30 of 30 release artifacts identical** — rebuilt with each compiler from clean, `moved: none` |
| 8 | suites | threads **10** · fiber **6** · fiber-executor **7** · async_main_promise **2** · debugger **5** · fiber-runner **5** · async_on_main **2** · `--bin` **307** — each from its own `test result:` |
| 9 | census 71/82 alone | `71/82 pass, 0 skipped, 11 no-source`, nothing else running |
| 10 | Phase D's three measurements | §5 |
| 11 | commits, branches, clean trees, `main` untouched | §8 |

---

## 7. Declared deltas

1. **`stackful-fiber-record.{debug,release}.wat` regenerated** (+568/−325 and
   +236 lines). Fiber builds now carry `$serveEntry`, which is the round's change
   and belongs in the golden. **No continuation `.wat` moved.**
2. **The 30 debug guest artifacts were not byte-compared across compilers.**
   Release ones were (§6.7). Debug artifacts embed source line numbers, and
   `std/assembly/task-stack.ts` gained `__driveSlot`, so lines shift below the
   insertion — the same declared class as DL35's four fixtures. I did not spend a
   second like-for-like rebuild to enumerate them, and I am saying so rather than
   claiming zero.
3. **`spawn-entry-async`'s `spawnIndexOf` is 3 on continuation, 1 on fiber.** A
   table position, not a behaviour; the pair test asserts "resolved and not the
   factory" instead of a fixed number (§4.2).

---

## 8. Commits

**TensionScript-a2**, `feat/dl40-fiber-serve` (pushed): **`e1addaca`** — `async: a
worker can serve a task on the fiber backend (I94)`. `src/builtins.ts`,
`src/compiler.ts`, `std/assembly/task-stack.ts`, two regenerated fiber `.wat`s.

**Tension**, `feat/dl40-fiber-serve` (pushed): **`44aad42`** — `test(threads): the
three cross-store programs run on both backends (I94)`.
`.github/workflows/e2e-debug.yml`, `scripts/lib/program-aliases.mjs`,
`scripts/build-test-programs.mjs`, `tension-core/tests/threads.rs`, six committed
artifacts + their `.build.json`s.

Both trees clean; `main` untouched in both; no `third_party/` change; no npm
publish; `game.ts` untouched; no new guest sources.

---

## 9. What I did not verify

- **A served entry that parks.** §3.4: a worker's `__workerMain` is still not on a
  fiber, so a park inside a served body would be dropped, not stranded. No program
  in the tree does it; the fix is a worker-side producer and is a design change.
- **Windows** — WIN22 follows.
- **Scheduling policy / `schedule-order`** — I95, DL41.
- **`f32` / 64-bit payloads**, **migration**, **I76**, **I78**, **I87**.
- **The cost of a served task** — §5.3, and why the existing harness does not apply.
- **Debug guest artifacts across compilers** — §7.2.
