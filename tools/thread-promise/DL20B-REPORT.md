# DL20B — a task parked on a worker is resumed

`~/work/Tension` `integration/dwarf-debug` @ **`88bafb8`**, pushed. PR **#84**,
merged fast-forward. CI on the merged SHA: run **`45097923033`**, E2E debug,
**success** (the one job this repo runs).

`~/work/TensionScript-a2` untouched at `3f59ec08`; **bundle `aa74d6a1`**, `std`
byte-identical. **No compiler change, no std change.**

## 0. Phase 0

```
Tension            integration/dwarf-debug  0fa27f8   clean
TensionScript-a2   main                    3f59ec08  clean
bundles            aa74d6a1 (tree) = aa74d6a1 (installed)
std/assembly/thread.ts   identical (cmp -s)
binary             33603864  2026-11-23 01:45:25
find src -newer <binary>   (empty)
```

All five facts held; no rebuild was needed.

## 1. The proof (Phase C)

> **Path note (DL21).** This guest moved to
> `tension-core/tests/programs/thread/wake-on-worker.ts` when it became a
> regression test. Its content and the run below are unchanged; the path in this
> report is the one it had when the round landed.

The committed guest `tools/thread-promise/programs/wake-on-worker.ts`, run with
`--executors 2 --post-completion 4,7`. Full stdout **and** the `DEBUG` thread log,
because the ordering claim is in the log:

```
INFO  core: --post-completion: class 4 key 7 -> buffered (no park yet: sticky)
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
DEBUG thread: executor 1: park on class 4 key 7 claimed a completion that had already arrived (sticky wake)
DEBUG thread: executor 1: woke task 0 for class 4 (1 this session)
inner: AFTER the await, value=0
worker: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
INFO  thread: executor 1 left its session loop after 1 wake(s)
INFO  thread: executor 1 left the park seam having recorded 1 park(s) (first: task 0 on class 4 key 7)
exit 0 — no strand refusal
```

Read the order: the completion is **buffered before there is a park** (line 1), the
park **claims** it (line 6), the worker's own `__taskWake` **resumes** it (line 7),
and both the before and after lines are the worker's. Nothing was stranded, so
DL12B's refusal did not fire — and line 13 shows the park recorded, so the absence
is a real absence and not an empty ledger.

**The guest needs bundle `aa74d6a1`** (I44) and two one-line exports, neither of
which needs a compiler change:

- `export { __taskWake } from "~lib/task-rt";` — because `__taskWake` is not a
  module export of a plain guest (DL19 A2 measured this, and the first run of this
  fixture confirmed it: `executor 1 exports no __taskWake`);
- `export function _game_running(): i32 { return 0; }` — the load-time coexistence
  rule refuses a guest exporting only one of the pair. `0` is truthful: the fixture
  wants no host frames.

## 2. What each item became

| item | where | note |
|---|---|---|
| **B1** | `thread.rs` `ParkedTask { handle, owner, task_id }` + `ParkedTable` | the ledger's own table type; `ParkTable` stays the scheduler's |
| **B2** | `session/epoch.rs` | main's scheduler first, then the pool |
| **B3** | `thread.rs` `early` + `claim_early` | the sticky half |
| **B4** | `thread.rs` `inboxes` + `Condvar` | one shared queue, taken per owner |
| **B5** | `thread.rs` `service_wakes` | host-side, after `__workerMain` returns |
| **B6** | `thread.rs` `record_strand` | strand = still in the ledger |
| **B7** | `main.rs` teardown + `signal_session_stop` | stop → join → check; `H_STOP` = header word 5 |
| **B8** | `main.rs` `--post-completion` | table entry + `USAGE` + parser |

### B1 — why three words, and one word that is `0`

The type carries the reason:

> **Why three and not one.** The handle is the right *identity* … But it is **not**
> the argument `__taskWake` takes: that is a *store-local* slot id, and `TaskRecord`
> carries no slot field — `state.slot` lives on `TaskState`. Deriving the id from the
> pointer would mean scanning the owning store's `slots` table for
> `slot.record == handle`, which is O(capacity) per wake against the contract's §3.3
> O(1).

**`handle` is written `0` today, and that is reported rather than papered over.**
The contract fixes `park` at three integers and deliberately does not carry the
continuation (§2.1), so the host cannot learn a record's address without a std
change — which the round forbids. `owner` + `task_id` are what the wake path needs
and both are real. The field exists so the identity has a home when it can be
filled.

### B5 — the loop, and what it does not do

```rust
let mut served: u64 = 0;
loop {
    if pool.stopping() {
        break;
    }
    let mine = pool.take_deliveries(id as u32);
    if mine.is_empty() {
        pool.wait_for_work(id as u32, SLICE);
        continue;
    }
    for delivery in mine {
        ... write delivery.task_id at `scratch` ...
        wake.call(&mut *store, (scratch as i32, 1))?;
        served += 1;
        bump_served(&memory, control_base as usize, served);
    }
}
```

Its comment, verbatim:

> **What this loop does not do.** It does not decide *which* tasks resume (the
> ledger and `deliver` do), it does not carry a continuation (it names store-local
> ids, §2.1), it does not touch the ready/inbox rings the served body uses (`I31`:
> those move continuations), and it does not run the guest's own step. It waits,
> takes, and calls `__taskWake`.

**The scratch.** `__taskWake` wants a pointer to packed `u64` ids in guest memory.
The executor's spawn record has `entry`/`arg` at `sig + 16`/`+20`, both dead once
`__workerMain` has read them and `__spawnThread` refuses an already-born id. Eight
bytes there hold exactly one id, and `sig = record + stride - 24`, so the whole
address is arithmetic on `__controlBase` and `__controlStride` — no guest call, no
allocation, no sharing with main's own scratch (which lives in the session control
block tail).

### B7 — teardown, quoted

```rust
if let Some(pool) = store.data().executors.clone() {
    let stopping = std::time::Instant::now();
    pool.stop_all();
    signal_session_stop(&mut store, &instance);
    pool.join_finished();
    logging::log(Level::Debug, "thread", &format!(
        "session pool stopped and joined in {} ms", stopping.elapsed().as_millis()));
}
```
and the strand check is the next thing that runs, unchanged in place.

**A limit stated in the code:** the host cannot `atomic.notify` a guest — that is a
wasm instruction. So `signal_session_stop` writes `H_STOP` and each state word, and
a guest blocked in an endless `atomicWait(-1)` stays blocked. It does not affect
this round's loop (a Rust `Condvar`) and changes nothing on the served path, but it
is the exact reason a future guest-side loop would want a notify of its own.

## 3. Three bugs I made, and how each was caught

1. **The strand predicate's sense was inverted.** My first cut counted a task as a
   strand when it was *no longer* in the ledger. Symptom: `join=0`,
   `wakes served=1`, the continuation printed — and the run still exited 1 naming
   the task it had just resumed. Caught by running the proof.
2. **A worker-loop error skipped the strand record.** The first version returned
   early, so a worker that had parked was never counted and the run exited **0**
   with the task stranded — DL12B's exact failure, reintroduced. Caught by the
   first (broken) proof run, which exited 0 while printing `TIMEOUT`. Fixed by
   carrying the error past the bookkeeping.
3. **I added the flag to the table but not to `USAGE`** — and my own DL17B test
   `the_usage_text_and_the_table_agree_about_every_dash_token` failed by name
   before CI saw it. That guard was worth writing.

## 4. Phase D — every number

| check | result |
|---|---|
| completed await | **exit 0**, no refusal, before+after from the worker |
| `strand-nested` (nothing completes it) | **exit 1**, refusal names `executor 1 … task 0 on class 4 key 7` |
| `plain-worker.ts` | `before=0 workIndex=0 spawn=0 join=0 counter=10`, exit 0 |
| `cargo test --test threads` | **5 passed** |
| `cargo test --test async_main_promise` | **2 passed** |
| `cargo test --bin tension-core` | **307 passed** (unchanged; no test added or removed) |
| `cargo test --test e2e_debug` | 3 passed |
| `cargo test --test debugger` | 5 passed |
| `examples/async-on-main` | **28 lines**, `main: done, total=67`, exit 0 |
| "detached" in healthy logs | **0** in the proof, in `plain-worker`, in async-on-main |
| census `--workers 8`, alone | **71 pass / 11 no-source / 0 skipped** |

The census matches the standing baseline exactly (`71/11`), so no case left `pass`.
The 11 `no-source` are the pre-existing upstream range-transform issue, not this
round's.

**One test was extended, not weakened:** `host_option_table_tests`' canned value
table gained `HostOptionKind::PostCompletion => "4,7"`, because a class id is a
number and the generic `"value"` produced a parse error rather than the
table/parser disagreement that test exists to detect. The test's assertions are
untouched.

The refusal message changed (see §5), and `cargo test --test threads` was re-run
afterwards to confirm nothing asserted on it.

## 5. Where I departed from the brief, and why

**"Same function, same message, same predicate."** The function and the predicate
are the same. **The message changed**, because its explanation was *"a worker's
store has no host loop, and `wake` is confined to a store's owner thread … so a
parked task on a worker has no path to a completion here"* — which is precisely
what this round built. Shipping that sentence would have told a reader to look for
a loop that now exists. It now reads:

> a task was left parked when the session stopped: …. A session pool now resumes
> parked tasks (docs/threads.md), so this means either nothing completed that
> `(class, key)` before shutdown, or the guest exports no `__taskWake` for its
> executor to call (the scheduler contract §2.2 confines the wake to the store's
> owner thread, so only the owning store can resume its own task).

## 6. Scope — declared vs actual

| file | declared | actual |
|---|---|---|
| `thread.rs` | yes | +623/−… (the round's bulk) |
| `main.rs` | yes | +214 (teardown, stop word, flag, message) |
| `scheduler.rs` | yes | **untouched** — the pool does the work |
| `lib.rs` | yes | **untouched** |
| `session/epoch.rs` | no | +14 — **B2's routing had to live here**; the brief named B2 but not its file |
| `host/config.rs`, `host/dev.rs`, `sandbox.rs` | no | +8 total — the new config field is compiler-enforced at every construction site |
| `docs/abi/guest.md` | no | 14 rows, **line numbers only**, regenerated because `thread.rs` grew |
| guest + README | yes | `wake-on-worker.ts` + the pool-lifetime section |

`test-abi-docs.mjs` reports the docs current and only the pre-existing I36 hook
failure.

## 7. What I did not verify

- **`handle` is `0`.** Reported in §2. The type is ready; the value needs an ABI
  change (a std edit) that this round forbids.
- **A `--post-completion` for a non-awaitable family** is buffered and never
  claimed; logged at Trace, exercised by no fixture.
- **Two workers parking on the same `(class, key)`.** `ParkedTable::insert`
  overwrites (inherited from `ParkTable`'s documented rule). With one worker the
  question does not arise; with two it is §4.9's territory and untested here.
- **Windows.** Unchanged guest-visible surface; not run.
- **The DL11 stackful hang** — still undiagnosed, untouched.
- **A long-lived pool under a real frame loop**: the census exercises main's loop,
  not a session pool with a steady stream of completions. That is the latency
  round's subject, and the user has already re-framed it (park/resume and batch
  handoff, not frame budget).
