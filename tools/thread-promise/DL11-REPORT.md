# DL11 — a worker's task does strand, and the strand is silent

Round: build the guest that DL10 could not, and measure what a worker does when its
task cannot complete. **No source change.** `~/work/Tension`
`integration/dwarf-debug` @ `52d18fa` + this report; `TensionScript-a2`
`fix/plain-worker` @ `dddd8849`; compiler bundle **unchanged at `767d3d7a`**.

## 0. Phase 0 — the rebuild

Preflight was red exactly as the brief said (`thread.rs` at 17:13, binary at
17:07 — DL10's stash/pop cycle had touched the file after the build).

```
cargo build --release --bin tension-core   → Finished in 16.23s, EXIT=0
binary      2026-11-22 17:39:03
newest src  2026-11-22 17:13:14  tension-core/src/thread.rs
YES: binary is newer than every file under tension-core/src
```

(`bin/preflight` is not in this tree — architect seat. The check above is the one
it performs.)

## 1. Phase A — the four items

**A1. When does `lower.ts` decide settled vs pending?** `src/async/lower.ts:1745-1770`
emits, for every `await`:

```ts
if ($state.resumePoint == 0) {
  $awaitedK = <operand>._record;
  $state.resumePoint = K;
  if (!__taskSettled($awaitedK)) { <copy-out locals>; __taskPark($state, $awaitedK); return; }
}
if ($state.resumePoint == K) { $state.resumePoint = 0; <the await expression> }
```

and `__taskSettled` is `record.done != 0` (`std/assembly/task-rt.ts:444-446`).
So the condition for the **pending** path is exactly: the awaited record's `done`
is still 0 **at the instant the await is evaluated**.

**A2. What makes it genuinely asynchronous?** Not the await itself. The transform
always tests first and **skips the park when the record is already done**. So a
callee that completed during the synchronous prefix never parks — which is what
happened in DL10: `inner(21)` has no await, so its whole body ran in the entry,
`__taskComplete` set `done = 1` (`task-rt.ts:555-561`), and the caller's await fell
through. The guest shape was the problem, not the backend.

**A3. What shape guarantees the unsettled path?** The awaited record must have
`done == 0` at that instant, and `class_ != 0` for the park to be recorded at all
(`parkState`, `task-rt.ts:203-224`: `if (table == null) return; if (awaited.class_
== 0) return;`). Judging the candidates:

| candidate | verdict |
|---|---|
| await a task a *different* executor must complete | needs a served body and a reply — `RemotePolicy`, which is `~lib/task-stack` machinery; not a plain-worker shape |
| await a *host import* returning a pending record | no std import does this; the classes are posted by adapters |
| **a manually constructed record that is never driven** | **reachable with `std` alone** — `TaskRecord`'s fields are public and `Task<T>._record` is public. This is exactly what the framework itself does: `tension-framework/assembly/runtime/rt.ts:270-282` `Runtime.job(jobId)` builds `record.class_ = CLASS_JOB_DONE; record.key = jobId;` and returns a `Task<u32>` handle. |
| two tasks awaiting each other | constructs with the same primitive but needs two states parked on each other; more moving parts, same mechanism |

So the shape is: **`await` a `TaskRecord` stamped with a producer class and key
and never completed.** It is reachable with today's `std` (`~lib/task`) and is the
framework's own job-handle shape, so it is not a contrivance.

**A4. Does the record carry enough to be woken?** Not on its own. `park` carries
`(task_id, class, key)` and the **guest's** table maps `task_id → state` (so a
wake with ids is resumable). What does not exist on a worker is the other
direction: `(class, key) → task_id`, which on main is `Scheduler`'s per-family
park tables (`scheduler.rs`), matched by the epoch and turned into ids. DL10's
worker seam records a flat list of `(task_id, class, key)` — enough to *show* a
park happened, not enough to match a completion to it. **That is the gap DL12
would close, and it is two things, not one: a matching table and a loop to call
`wake`.**

**Stop verdict: no stop.** A guest shape reaches the unsettled path with `std`
alone.

## 2. Phase B — the guest

Two shapes were built, because the first taught something the brief did not
anticipate. Both are scratch, `/tmp/dl11/`, same flags, Promise path only
(`THREAD_FLAGS` minus `--enable stack-switching`).

```ts
import { Task, TaskRecord } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";
import { __spawnIndexOf } from "~lib/task-stack";
import { __spawnThread, __threadJoin } from "~lib/thread";

const CLASS_JOB_DONE: i32 = 4;          // session/arena.rs:222

/** A handle nothing will ever complete: class stamped, `done` still 0. */
function pendingJob(key: i32): Task<i32> {
  const record = new TaskRecord();
  record.class_ = CLASS_JOB_DONE;
  record.key = key;
  const handle = new Task<i32>();
  handle._record = record;
  return handle;
}

// shape 1: the worker's own entry awaits it
async function workerEntry(): i32 {
  __taskBindTable(16);
  line("worker: BEFORE the await");
  let job: Task<i32> = pendingJob(7);
  let value: i32 = await job;
  line("worker: AFTER the await, value=" + value.toString());
  return 0;
}

// shape 2: the entry binds, then a nested async function awaits it
async function awaited(): i32 {
  let job: Task<i32> = pendingJob(7);
  let v: i32 = await job;
  line("inner: AFTER the await, value=" + v.toString());
  return v;
}
async function workerEntry(): i32 {
  __taskBindTable(16);
  line("worker: BEFORE the await");
  let v: i32 = await awaited();
  line("worker: AFTER the await, value=" + v.toString());
  return 0;
}
```

| | shape 1 | shape 2 |
|---|---|---|
| artifact | `strand-promise.wasm` | `strand-nested.wasm` |
| size | 29 342 B | 30 751 B |
| sha256 | `885e1a8bf3a222de…1da76c` | `ef56d394a653b2c1…33dbd9` |
| `scheduler.park` imported | yes | yes |

## 3. Phase C — what happens

Both run with **`--executors 2` before the module path** (I32: after it the host
answers `executors=1`).

### Shape 1 — the entry awaits directly: **does not proceed, and does not even park**

```
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
main: join=0
main: done
EXIT=0
INFO thread: executor 1 left the park seam having recorded 0 park(s)
```

`AFTER` absent — the suspension happened. But **0 parks**, and the reason is
mechanical, verified in the generated code rather than guessed:

- `workerEntry` (the entry) calls `__taskRegister` at wat line 11 126 — **before
  any body statement runs**;
- `workerEntry$resume` (the normal pass) calls `__taskBindTable` at line 10 886 —
  i.e. *after* registration.

At registration `slots == null`, so `__taskRegister` returns without claiming a
slot (`task-rt.ts:390-394`) and `state.slot` stays `-1`. At the await,
`parkState` reaches `const id = state.slot; if (id < 0) return;`
(`task-rt.ts:220-222`) and returns — `scheduler::park` is never called for a
worker's **own entry task**. It is a bootstrapping order the entry cannot escape:
the table it needs must be bound before the task that binds it exists.

### Shape 2 — a nested task awaits: **parks, and the task strands silently**

```
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
main: join=0
main: done
EXIT=0
INFO thread: executor 1 left the park seam having recorded 1 park(s)
             (first: task 0 on class 4 key 7) — a worker runs no host loop,
             so none of them can be resumed
```

**Classification A** — it parked and the guest did not proceed past the await.
The evidence, in order:

- `worker: BEFORE the await` printed; **neither** `inner: AFTER the await` nor
  `worker: AFTER the await` printed;
- the host logged **1 park**: task 0, class 4, key 7 — the nested task's slot;
- `main: join=0` and `main: done` printed, exit 0. **No hang** — I did not have to
  wait; the process ended on its own.
- **The worker thread was gone when `__threadJoin` returned.** The join answers 0
  only after `__workerMainPlain` writes the state word and returns
  (`thread.rs:1647-1650` equivalent), which it did as soon as the entry's own
  frame returned at its suspension. The parked task is not a thread; it is a slot
  in the guest's table that no loop will ever visit.

So the answer to the round's question is precise: **a worker CAN strand a task,
and the strand is silent.** Everything reports success — join 0, exit 0, no
error, no warning — while one task sits in slot 0 forever. The only trace is the
host's Info line, which exists solely because DL10 added it. That is the
strongest argument for DL12: without a wake, the failure mode is invisible.

### The stackful control (same guest, one flag different)

`strand-nested-stackful.wasm` (31 285 B, `a3f43dd7c4d56c1c…5be095`), same
`--executors 2`: **EXIT=124 at a 60 s timeout**, and it printed only

```
main: spawning
main: index=6
main: spawn=0
```

— the worker never printed `BEFORE`. Under stack switching `__workerMain` is the
**served body**, which binds an `Executor`, serves `$starts[6]` as a continuation
and then loops; it did not get as far as the entry's first line. **Not
investigated: out of this round's scope** (the served-body path is DL6/DL7
machinery, and this round measures the Promise path). Recorded because it is a
difference between the two backends on the same guest, and because a hang with no
output looks like the same class of silence.

## 4. Phase D — regression

| check | result |
|---|---|
| `cargo test --test threads` | **5 passed**: `a_shared_memory_guest_can_print`, `a_worker_runs_on_its_own_store_and_joins`, `one_executor_count_plus_the_pool`, `the_contracts_refusals_are_values`, `two_workers_observe_every_value_exactly_once` |
| `cargo test --test async_main_promise` | **2 passed** |
| `examples/async-on-main` **Promise** build | builds clean; runs → 28 transcript lines ending `main: done, total=67`, exit 0 |
| staleness | binary 17:39:03 newer than the newest `src` file 17:13:14 |

**No census, as instructed.** It measures the continuation engine's DWARF and
nothing in this round changes compiler output; running it would have been ritual.
The 25 debug artifacts are unchanged by construction — the bundle is byte-identical
at `767d3d7a` and no source changed.

## 5. No tracked change

`git status --short` shows nothing but this report. Compiler bundle `767d3d7a` in
both the tree and the installed copy. No host change, no compiler change.

## 6. What I did not verify, and what I assumed

- **The stackful hang was not diagnosed.** It is a different body (`__workerMain`
  served path) and I did not instrument it. It may be the same DL9-era shape
  (`$starts[6]` is `workerEntry`, the plain function, called as a continuation).
- **The strand is proven by absence of the marker, not by inspecting the slot
  table.** I did not dump the guest's `slots` array to show slot 0 occupied; the
  park log (task 0, class 4, key 7) plus the missing `inner: AFTER` is the
  evidence.
- **`CLASS_JOB_DONE` is written as the literal `4`** in the scratch guest,
  matching `session/arena.rs:222`. A future round should not copy that habit; a
  guest has no ABI constant for it unless the framework provides one.
- **The nested shape is what the framework would do naturally**, but I did not
  build a real framework guest as a worker (it needs the session, which a worker
  store does not have). Shape 2 stands in for it with `std` only.
- **Assumed** `__taskBindTable` is idempotent per store and that a second call in
  a worker would discard nothing that mattered — the first call in the worker is
  the only one, since a worker's globals start at zero.
