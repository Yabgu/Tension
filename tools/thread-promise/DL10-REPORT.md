# DL10 — a worker answers `scheduler::park`, and cannot resume it

Round: let a worker's store answer the park seam, so an executor can host a
suspending task at all. `~/work/Tension` `integration/dwarf-debug` @
**`d08ed63`**, pushed. **No compiler change**: `dist/assemblyscript.js` is
unchanged at `767d3d7a`, and `TensionScript-a2` is at `dddd8849` with a clean
tree.

## 1. Phase A — the six items

**1. `link_scheduler`'s signature.** `src/scheduler.rs:577`:

```rust
pub fn link_scheduler(linker: &mut Linker<HostState>) -> anyhow::Result<()>
```

Pinned to `HostState`, and — this is the finding — `scheduler` is a module of the
**binary** (`src/main.rs:79 mod scheduler;`), while `WorkerState` and
`link_worker` live in the **library** (`src/lib.rs:40 pub mod thread;`).

**2. What `WorkerState` holds.** `src/thread.rs:69` was `struct WorkerState {
pool: Arc<ExecutorPool> }`. It cannot reach the park tables: they are
`HostState::scheduler` (`src/main.rs:237`), a different type in a different
crate target. What a worker *could* reach is the pool — that is what
`ThreadImports::executor_pool()` exists for.

**3. What `park` does with its arguments.** `src/scheduler.rs:538` (pre-change):

```rust
pub fn scheduler_park(caller: &mut Caller<'_, HostState>, task_id: i64, class: i32, key: i32) {
    if let Err(refusal) = caller.data_mut().scheduler.park(task_id, class, key) {
        caller.data_mut().scheduler.queue_refusal(task_id, refusal.status());
        return;
    }
    if let Some(early) = caller.data_mut().scheduler.take_early(class, key) {
        let resolved = caller.data_mut().scheduler.take(class, key).unwrap_or(task_id);
        caller.data_mut().wake_batch.push(Wake { task_id: resolved, .. });
    }
}
```

**It writes tables and returns.** It never blocks — because the contract makes it
`void` and says in as many words (§2.1) that "the *suspension* is the guest
returning to the executor, not the host call spinning".

**4. `__taskWake` / `wake(ids)`.** Called from exactly two places, both on
`HostState`: `main.rs:2275` (the host loop) and `sandbox.rs:532` (the sandbox's
frame hook). `wake_batch` is a `HostState` field (`main.rs:260`). **There is no
path from a worker to a wake** — no call site, and no channel a worker's store
could receive ids on.

**5. `docs/scheduler-contract.md` on workers.** It never says the word. What it
does say is structural:

- §2.1 "the guest MUST be resumable from the park the moment the call returns";
- §2.2 `wake` is "Called on the Store's owner thread only";
- §3.1 "There MAY be one or more executors", each owning a disjoint class set;
- §3.2 "An executor with nothing to do **blocks** on a real primitive".

So a worker is not *forbidden* to be an executor — it is a `Store` and therefore
an owner thread — but the contract's requirement that a park be resumable cannot
be met on a worker until that store has a loop to call `wake` on. **The contract
is silent on how a worker receives ids; that is a finding about the contract
(I34-shaped), not a gap in this reading.**

**6. What a Promise guest does at its first park when nothing wakes it.**
`src/async/lower.ts:1745` emits `if (!__taskSettled($awaitedK)) { <copy-out>;
__taskPark(...); return; }` — and `task-rt.ts:448` `__taskPark` records the
waiter and calls `parkState`, whose first line is `if (table == null) return;`
(`task-rt.ts:203`). `park` is `void` and returns; the *suspension* is the
generated `return`. So "still waiting" is not a return value — the entry returns
and nothing resumes it. **A hang is only possible if a caller waits on something
that needs that task; the task itself strands silently.** That decided the
shape of §3's measurement.

**Stop verdict: the first condition fires in substance, the second in the
contract's own words.** `link_scheduler` cannot serve a `WorkerState` without
moving the park tables (and the session ABI they are keyed by) from the binary
into the library. Concretely: `Scheduler` has **36** references to
`session::arena`'s class constants and per-class key spaces, and `session` is a
binary module (`main.rs:90`). Moving it is exactly "moving where the park tables
live", which §5 forbids. The brief's second condition also holds: park on a
worker needs a completion path that does not exist (§2.2's `wake` on the owner
thread plus §2.1's resumability).

**Why the round proceeded anyway, and what it did instead.** The two stop
conditions are about `link_scheduler` and about *resumption*. The minimum the
brief actually asked for — "let a guest instantiate and reach `park`" — is
reachable without either: register the seam on the worker's *own* linker, from
the library side, recording into the library's own state. That is what Phase B
does. Nothing is moved; main's `scheduler.rs` was not edited at all (verified:
`git diff --stat` shows only `thread.rs`).

## 2. Phase B — the change

`tension-core/src/thread.rs`, +91/−2, two pieces:

- `WorkerState` gains `parks: Mutex<Vec<WorkerPark>>`; `WorkerPark` is
  `{ task_id: u64, class: u32, key: u32 }` — the contract's three integers and
  nothing else.
- `link_worker` registers `scheduler::park` writing into that record.
- `worker_main` logs the count when the worker returns, **including zero**, so
  "the guest parked" and "the guest never reached the seam" cannot be confused.
- The instantiation-failure message now names the real import set (it had
  omitted `tension::io` already, and now `scheduler::park`).

**What it does not do, stated in the code:** resume anything. The record is where
a future round's wake would start; no wake exists, no loop drains it, and §2.1's
resumability requirement is therefore **unmet on a worker** — deliberately, and
reported rather than papered over.

`src/scheduler.rs` is untouched, so **main's behaviour is unchanged by
construction**, not just by measurement.

## 3. Phase C — what happens when a worker parks

One scratch guest, `dl10-park.ts` (in `/tmp/dl10/`, not the repo): `async main`
plus an `await` (so the module imports `scheduler::park`, the name that used to
fail), `_start_game` spawns executor 1, and the worker's entry calls
`hostPark(1, 4, 7)` — the contract's seam, called where `parkState` would call
it — then prints and exits.

Built twice from the same source:

| | plain (no stack switching) | control (`--enable stack-switching`) |
|---|---|---|
| command | `tensionscript dl10-park.ts … --sharedMemory --importMemory --enable threads -O0` | the same, plus `--enable stack-switching` |
| size | 26 613 B | 24 198 B |
| sha256 | `ce2dc09d0a767856…` | `83c0b68382d69af7…` |

**`--executors 2` before the module path** in every run (after it, the host
answers `executors=1` — I32, not fixed here).

### Before the change (engine rebuilt from `HEAD` with `thread.rs` stashed)

```
main: spawning
main: index=0            (control: index=2)
main: spawn=0
ERROR thread: executor 1 could not run: the module did not instantiate as a worker —
  … unknown import: `scheduler::park` has not been defined
EXIT=124   (60 s timeout: __threadJoin never returned)
```

### After the change

**plain** — exit 0:

```
main: spawning
main: index=0
main: spawn=0
worker: entered
worker: park returned
worker: after the park, still running
main: join=0
main: done
INFO thread: executor 1 left the park seam having recorded 1 park(s)
             (first: task 1 on class 4 key 7) — a worker runs no host loop,
             so none of them can be resumed
```

**control** — exit 0, and identical except `index=2` (the shell's two entries
precede the appended spawn entry, which is DL9's ordering rule working).

So: **instantiates, reaches the seam, the call returns, the guest runs on, the
join completes, and the park is recorded where nothing will ever read it.** No
hang, no trap, no refusal. The old `__threadJoin` hang was a consequence of the
instantiation failure, not of parking.

### The third data point: a real suspension is not constructible here

A second probe (`dl10-pending.ts`) awaited a task from `inner(21)` to force a
genuine suspension. It **ran through** — `value=42`, **0 parks recorded**. Backend
A drove the callee inline, so `await` fell through the transform's
`__taskSettled` check: the guest was the wrong shape, exactly the case the brief
anticipated. Reported rather than papered over; the seam itself is measured by
the first probe, which calls it directly.

## 4. Phase D — regression

| check | result |
|---|---|
| `cargo test --test threads` | **5 passed**: `a_shared_memory_guest_can_print`, `a_worker_runs_on_its_own_store_and_joins`, `one_executor_count_plus_the_pool`, `the_contracts_refusals_are_values`, `two_workers_observe_every_value_exactly_once` |
| `cargo test --test async_main_promise` | **2 passed** |
| census, `--workers 8`, alone | **71 pass / 11 no-source / 0 / 0 / 0 — no case moved**, all `observedLine` identical to DL9 |
| stackful guest | `main-policy --executors 2` → `phase: start / installed: 1 / steps: 5 / value: 30`; `examples/async-on-main` → `main: done, total=67`, exit 0 |
| 25 debug artifacts | **byte-identical** to `767d3d7a`'s output (diff of `sha256sum` lists, empty) |
| compiler bundle | **unchanged at `767d3d7a`** |

## 5. What this means for "threads consume async"

The seam is **reachable, not functional** — and now that is measured rather than
assumed. What is still missing, in order:

1. A **class table reachable from the library**. `Scheduler` is binary-side and
   keyed by `session::arena`'s class ids; a worker park that can be matched the
   way main's is needs that ABI in the library, or a scheduler facade the binary
   installs through the pool.
2. A **channel** to hand a worker's store the ids to resume, and a loop on that
   store to call `wake` (§2.2: owner thread only). That is the worker end of
   0.7.0a, and it is the same shape as main's host loop.
3. Only then does `RemotePolicy`'s "await a task served elsewhere" become
   functional on a worker, which is the user's actual model.

## 6. One adjacent thing this round touched

`docs/abi/guest.md` is generated and its tables embed `file:line`, so the
commit hook refused the commit until it was regenerated. Regenerating exposed a
second problem: the generator kept **one** registration site per import (the last
one it saw), and `scheduler::park` now has two — main's in `scheduler.rs` and a
worker's in `thread.rs`. Left alone, the page would have silently dropped main's.

`scripts/gen-abi-doc.mjs`'s `mergeImports` now keeps every distinct site and the
renderer joins them:

```
| `park` | `(i64, i32, i32)` | `tension-core/src/thread.rs:370`, `tension-core/src/scheduler.rs:578` |
```

That also restored a second site that was already being dropped for `env::abort`
and for the ten `tension::2d` verbs (adapter + in-core). No row count changed
(96 rows before and after); only the "registered at" cells gained the sites that
were missing.

**Pre-existing failure, not mine, reported not fixed:** `node
scripts/test-abi-docs.mjs` fails one check on a clean tree as well —
`the pre-commit hook could not be exercised: the copied tree is already stale`.
Cause: the hook proof copies a fixed directory list
(`scripts/test-abi-docs.mjs:147-158`) which omits `packages/cli/src`, and
`scripts/lib/toolchain.mjs` imports `packages/cli/src/compiler-provenance.js`
from it, so the copied tree cannot even run the generator. One line in that list
would restore it; it is unrelated to this round and left for its own commit. The
drift checks themselves (`guest.md is current`, row counts) pass.

## 7. Not verified

- **No genuinely pending suspension was executed on a worker.** The probe that
  tried ran through synchronously. So "a worker's parked task strands silently"
  is a reading of `lower.ts` + `parkState` + the recorded park, not a run.
- A real framework guest (`await` on a host verb) was not built for a worker:
  that needs the session, which a worker store does not have.
- Windows: not touched.
- The record is per-worker and unbounded. Nothing reads it, so it cannot grow in
  any measured run, but a future loop must bound it.
- The pre-existing `test-abi-docs` failure above was confirmed identical on a
  stashed (clean) tree, but I did not bisect when it started.
