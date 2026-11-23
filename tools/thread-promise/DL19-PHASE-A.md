# DL19 — Phase A: what the wake path needs, and the two decisions

**Stop point.** Phase A only. Both decisions are the user's; nothing is
implemented.

## 0. Phase 0, verbatim

```
$ cd ~/work/Tension
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
integration/dwarf-debug
bbf947d
$ cd ~/work/TensionScript-a2
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
main
3f59ec08
$ sha256sum dist/assemblyscript.js ~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d  /home/acakar/work/TensionScript-a2/dist/assemblyscript.js
aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d  …/node_modules/@yabgu_gm/tensionscript/dist/assemblyscript.js
$ cmp -s std/assembly/thread.ts …/std/assembly/thread.ts && echo "std: identical"
std: identical
$ stat -c '%s %y' ~/work/Tension/tension-core/target/release/tension-core
33603864 2026-11-23 01:45:25.263041766 +0100
$ find tension-core/src -newer tension-core/target/release/tension-core -type f | head -3
(empty)
```

All five expected facts hold: both trees clean at the expected commits, both
bundles `aa74d6a1`, `std` identical, **binary newer than every `src` file**.

## A1 — the contract, and which of the three is not implemented

`third_party/TensionScript/docs/scheduler-contract.md` (the pinned copy; the
harness's own reading of it is `docs/threads.md`).

**§2.1 `park` — implemented on both halves.** Three normative clauses:

> - **The executor maintains a task table keyed by `task_id`; each entry carries
>   the task's continuation.** This is normative: without it `wake(ids)` has
>   nothing to resolve an id to.
> - **Called after the continuation is recorded.** … so the guest MUST be
>   resumable from the park the moment the call returns.
> - **The call returns.** It does not block the owner thread.

What it requires of the host: record `(class,key) → task_id`, hold the
continuation under the id, and **return without blocking**, leaving the guest
resumable *the instant it returns*.

The recording is done — `scheduler::park` on main (`scheduler.rs:441`, into
`Scheduler`) and on a worker (`thread.rs`, into `WorkerPark` + DL18's
`ParkLedger`). The third clause is met (it returns). **The second is not met on a
worker**, and that is the whole gap: a worker's guest is *not* resumable when its
park returns, because nothing will call back into it.

**§2.2 `wake` — not implemented for a worker at all.**

> - **Called on the Store's owner thread only.** … must not call `wake` from a
>   producer or manager thread; the manager hands ids to the owner (§3.4).
> - **Each id is resolved through the task table and its continuation invoked
>   exactly once** …
> - **Batched.** Multiple ids per call are valid and expected.
> - **An id that is not parked is a runtime error.** The host MUST NOT invent
>   ids.

Main has this: `main.rs:1816` resolves the guest's `__taskWake`, `epoch.rs:299`
matches through `Scheduler::deliver`, `main.rs:2620-2660` writes the batch into
guest memory and calls it. On a worker, **nothing calls `__taskWake`** — the
export is not even resolved in `worker_main` — and DL18 left `ParkLedger::take`
with no caller.

**§1.2 the continuation — satisfied trivially on Backend A.**

> resume the function's execution **exactly once**, with the completion's
> result, at the point it parked.

> **The continuation is stored, not passed.** It is recorded when the Task is
> created and held by the executor under the task id (§2.1).

A Promise-backend task's continuation is `TaskState::resume`, a plain function —
this is exactly what makes the worker path reachable without `~lib/task-stack`
(no continuation type, no table, no shell).

**Two further requirements in the contract that the current host does not meet,
reported because the round's shape depends on them:**

**§3.1 — the class→executor partition is not implemented.**

> Each executor owns a **disjoint** set of classes, and the `class → executor`
> function is total and fixed for the session's lifetime.

Today every park, from any store, lands in one `ParkLedger`. There is no
partition, so "which executor owns this class" has no answer.

**§3.4 — the hand-off exists only for main.** The executor matches, queues the
ids for the store's owner thread, and *the owner thread* calls `wake`. Main has
that (`HostState::wake_batch`). A worker has no queue and no boundary.

## A2 — the guest's `__taskWake`

```ts
// std/assembly/task-rt.ts:349
export function __taskWake(idsPtr: usize, count: i32): void {
  const table = slots;
  if (table == null || count <= 0) return;
  for (let i = 0; i < count; ++i) {
    const id = <i32>load<u64>(idsPtr + <usize>i * 8);
    if (id < 0 || id >= table.length) continue;
    const slot = table[id];
    const state = slot.state;
    if (state == null) continue;            // already resumed: a stale id
    slot.state = null;
    slot.record = null;
    state.resume(state);
  }
  drainReady();
}
```

**Signature**: `(idsPtr: usize, count: i32) -> void` — a pointer to `count`
packed little-endian `u64` **task ids** in guest memory, which the host writes
before the call.

**What it does**: for each id, resolve `slots[id]`; skip an empty slot (a stale
id, not an error — §2.2's "MUST NOT invent ids" is enforced by the table, not by
a check on the host); `state.resume(state)` runs the rest of the async body
**exactly once**; then `drainReady()` flushes whatever the resumed body queued.

**What it needs to be called with**: a **task id**, which is the guest's own slot
index — `state.slot`, the number `parkState` hands to the host as
`hostPark(<i64>id, class, key)` (`task-rt.ts:223`). **It is store-local**: each
store has its own `slots` table, so id 0 on worker 1 and id 0 on worker 2 are
different tasks. This is the fact that shapes A4.

**Is it exported?** From std, yes (`~lib/task-rt/__taskWake`). As a **module
export** of a compiled guest, **no** — measured on `strand-nested.wasm`:

```
task/__ exports: __arenaEnd … __spawnThread __start __threadInit __threadJoin
                 __workerArenaBase __workerArenaSize __workerMain
```

**But a guest can re-export it with one line, and that needs no compiler
change.** Measured in this round:

```ts
// /tmp/dl19/exp.ts
export { __taskWake } from "~lib/task-rt";
export function _start_game(): void {}
```

→ compiles with bundle **`aa74d6a1`**, and the export section contains
`__taskWake`. So the gate ("bundle must stay `aa74d6a1`") is satisfiable: the
guest opts in, the compiler is untouched.

**What calls it today**: only the host, and only for main — `main.rs:1816`
(resolved after instantiation), `main.rs:2640` (the host loop),
`src/sandbox.rs:532` (the sandboxed-guest loop). It is gated on the guest
exporting **both** `__taskWake` and `_game_running` (`main.rs:1847-1856`), a
coexistence rule this round does not need to disturb.

## A3 — the served body's loop, and how much of it is continuation-shaped

`std/assembly/thread.ts`, `__workerMain`:

```ts
  while (!e.stop && atomicLoad<i32>(sig + 12) != 2) {
    if (e.inbox.depth > 0) {
      __drainInbox(e);
      continue;
    }
    if (e.ready.depth > 0) {
      if (e.step(e)) break;
      continue;
    }
    // Read the signal **before** the final check: a push in between changes the
    // value this wait expects, so the wait returns instead of sleeping.
    let seen = atomicLoad<i32>(sig);
    if (e.inbox.depth > 0 || e.ready.depth > 0) continue;
    atomicWait<i32>(sig, seen, -1);
  }
```

| step | continuation-shaped? |
|---|---|
| `e.stop` / `sig + 12` state check | **plain** — two atomic loads |
| `e.inbox.depth` + `__drainInbox(e)` | **continuation** — `__serveSlot` and `__resumeTask`, both `~lib/task-stack` |
| `e.ready.depth` + `e.step(e)` | **continuation** — `Executor.step` resumes through `__serveCont` |
| `atomicLoad(sig)` + `atomicWait(sig, seen, -1)` in a loop | **plain** |

**The plain part is exactly what a worker's wake path needs**: block on the
record's `signal` word, re-read it before the final check so a push between the
read and the wait cannot be lost. **The queues are the part a plain worker must
not copy** — both are the served-request machinery (`I31`), which needs the
suspending shell.

**So what has to be different, named:** the plain loop has **one** job — take a
batch of ids and hand it to `__taskWake` — where the served loop has three
(drain requests, run ready tasks, wait). There is no `Executor`, no ring, no
`step`, and no `__serveCont`. What remains is: *wait, take, wake, repeat*.

## A4 — where a completion comes from, and how it crosses

### The three gaps, each measured

**Gap 1 — the ledger does not record which executor parked.** (`thread.rs:271`)

```rust
pub fn record(&mut self, class: u32, key: u32, task_id: u64) -> bool {
```

It stores a bare `task_id`. Since task ids are **store-local** (A2), a ledger
entry cannot say *which* store owns the task, so a completion matched on
`(class, key)` has no route to a store. With one worker it is ambiguous only in
principle; with two it is wrong, and `ParkTable::insert` **overwrites** a live
entry (`scheduler.rs`, "overwrite, not refuse") — which is right for a *re-park
of the same task* (the AI stream) and wrong for a *second task* on the same
`(class, key)`, which §4.9 says MUST be refused. The table cannot tell the two
apart today.

**Gap 2 — `Scheduler::deliver` never consults the pool.** (`scheduler.rs:330`,
called from `session/epoch.rs:299`)

```rust
if let Some(task_id) = data.scheduler.deliver(*class, *key, *payload) {
```

`data.scheduler` is main's own tables. A worker's park is in `ExecutorPool::parks`.
**So a completion posted on main's side cannot match a worker's park at all** —
DL18 made the table *readable* from main; nothing made it *matchable*.

**Gap 3 — there is no producer verb a plain guest can call.** The producer side
is capability imports (`session::submit` from an adapter) or the host's own
epoch. The one test producer, `--post-test-events` (`main.rs:2000`), posts
**three JOB_DONE events with keys 1, 3, 5** through the posting ring — there is
no way to name a `(class, key)`, and the worker guests park on key 7.

### What data structure carries a completion

`ExecutorPool` already has the carrier's *storage*: `parks: Mutex<ParkLedger>`,
shared host memory, reachable from main and from every worker. What it lacks is
(a) an executor id per entry, (b) a per-executor list of matched ids, and (c) a
signal word a blocked worker can be woken on. (c) already exists in guest memory:
each executor's record has a `signal` word (`std/assembly/thread.ts:1347`) and
`blockPush` already bumps-and-notifies it.

**Can the host call `__taskWake` from a worker?** Yes — on the worker's own
thread only, which Rust enforces: `worker_main` holds `&mut Store` for its whole
duration and no other thread can have one. That *is* §2.2, by the type system
rather than by prose. And `main` reading/writing guest memory or an atomic in it
is not a `wake` call, so §2.2 does not forbid the *post*.

## A5 — the two decisions

### Decision 1 — the worker's loop shape

**(a) Guest-side `atomicWait`**, as the served body does.
*For*: the primitive is already in the record, the wait is cheap and the guest
already knows the address. *Against*: the loop is **guest code**, so it must live
in `std/assembly/thread.ts` → a std change → **`dist/asc.js` moves** and every
guest recompiles. The brief forbids a guest-side change without stopping first.

**(b) Host-side block on a real primitive** — a `Condvar`/channel in the pool.
*For*: **host-only.** §3.2/§4.4 are satisfied by a real blocking primitive with
no spin; §3.4's "the owner thread calls `wake` at a defined boundary" is exactly
this, with the boundary being "between `__workerMain` returning and the thread
ending"; §2.2 is enforced by `&mut Store`. It also puts the wait where the
completion arrives (host memory), so no guest-visible state changes.
*Against*: the loop is not visible in the guest's own code, so a reader of
`thread.ts` will not see it — it belongs in `thread.rs`'s prose.

**(c) Spin/poll.** *Against*: §4.4 forbids it outright ("No busy-spin; no
`try_recv` plus sleep"), and a loading zone would burn a core.

**(d) One-shot** — what happens today. *Against*: it makes "threads consume
async" impossible, which is the round's purpose.

**Recommendation: (b).** It is the only shape that satisfies §3.2 and §4.4 while
leaving the compiler and std untouched. The loop would live in `worker_main`,
after the guest's `__workerMain` returns and while `&mut Store` is still held.

### Decision 2 — worker lifetime

This is the one that changes what the pool *is*.

**(a) Bounded — exit when the entry returned and its parks are all resolved.**
The worker blocks while parks remain, exits when the last resolves.
*Consequence*: a park **no producer will ever complete** blocks forever →
`__threadJoin` never returns → the process **hangs**, and DL12B's refusal can
never fire (it is decided after `join_finished`). That directly contradicts the
brief's "a stranded worker must still refuse … the refusal must never become
unfireable."

**(b) One-shot + one non-blocking drain.** Exit after the entry returns, after
delivering only what is *already matched*.
*Consequence*: the refusal keeps firing, nothing hangs, and the common case
(completion already in hand when the entry returns) works. But a completion that
arrives after the worker exited cannot be delivered — so cross-worker async
works only when main completes promptly and before the worker's entry returns.
Honest and small; not "a task parked on a worker gets resumed" in general.

**(c) Long-lived pool — the worker lives until `__executorExit`.**
*Consequence*: this is a real executor pool (thread-per-pool, not
thread-per-task). It requires moving the strand refusal from "at exit" to "at
shutdown", and it means a worker that never gets `__executorExit` keeps the
process alive. It also needs an answer for "a park nobody completes" that is not
a hang — the refusal has to be *asked for*, e.g. main declares shutdown and any
outstanding park refuses the run.

**(d) Bounded with a timeout** — (a) plus "exit after T with nothing new".
*Consequence*: keeps the refusal firing and never hangs, at the cost of a
constant in the contract that the spec does not name, and a wall-clock dependency
in a test.

**What I would choose, if asked:** **(b) now, (c) as the target.** (b) delivers
the round's *sentence* — a task parked on a worker resumes, prints after the
await, and the run exits 0 — without inventing a shutdown protocol or an idle
timeout, and without ever making the refusal unfireable. (c) is what a loading
zone needs, and it needs the shutdown decision made explicitly, which is a round
of its own.

**Neither (a) nor (c) can ship without also answering:** what happens to a park
whose producer never completes. Today that answer is the DL12B refusal, and it is
the one guarantee this arc has not lost.

### One thing Phase C will need, whichever way the decisions go

**A producer that can complete a chosen `(class, key)`.** Measured above: there
is no guest-callable verb, and `--post-test-events` is hard-coded to keys 1/3/5.
The smallest honest route inside this round's declared delta is a **test-only
host post** in `main.rs` (the `--post-test-events` shape, with the class and key
as arguments), or a scratch guest that drives the session posting face. I am
flagging it now because it is a `main.rs` edit the brief did not name, and
because "main posts the completion" in the Phase C spec cannot be done by main's
*guest* code today.

## Stop

Waiting on **Decision 1** (recommend (b), host-side blocking) and **Decision 2**
(recommend (b) now, (c) as the target), and on whether the test-only producer
verb is acceptable inside the declared delta.

Phase B is then: executor id + per-executor queue + signal on the pool; the
`deliver`-consults-the-ledger arm; the loop in `worker_main`; and `resolved` set
by the caller of `ParkLedger::take`. Phase C needs the committed scratch guest
whose worker prints both before and after an await that main completes.
