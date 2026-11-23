# DL20 — Phase A: the pointer is safe, and the sticky wake is the hard half

**Stop point.** Phase A only. Decisions A and B are the user's; nothing is
implemented.

## 0. Phase 0, verbatim

```
$ cd ~/work/Tension
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
integration/dwarf-debug
cf7478f
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

All five expected facts hold, including a fresh binary — no rebuild needed.

## A1 — the record is in shared memory

`TaskRecord` is a **managed class**, not a hand-carved struct:

```ts
// std/assembly/task.ts:20
export class TaskRecord {
  class_: i32 = 0;   // offset 0
  key: i32 = 0;      // offset 4
  ...
  done: i32 = 0;     // offset 28
}
```

allocated by

```ts
// std/assembly/task-rt.ts:384
let record = make != null ? make() : new TaskRecord();
```

**Where that heap is, under `--sharedMemory`:**

```ts
// std/assembly/rt/common.ts:120
@lazy export let HEAP_BASE: usize = ARENA ? initialHeapBase() : __heap_base;
```
```ts
// std/assembly/rt/common.ts:176  (inside __arenaInit)
HEAP_BASE = heap; noteArena(end, heap);
```

So a store's GC heap **is** its arena — `__arenaInit(__mainArenaBase(), …)` for
main, `__arenaInit(__workerArenaBase(id), …)` for a worker (`thread.rs`, before
`__workerMain`). Those arenas are disjoint slices of **one linear memory**
(`__carveThreadLayout`: `WORKER_ARENA_BYTES = 1 << 20`, `arenasBase + (id-1) *
WORKER_ARENA_BYTES`, main's at the tail).

**Verdict A1: the record lives in shared linear memory. Its address is an offset
into that one buffer — the same number in every store, and unique across them.**
That is exactly what the user's framing assumed.

## A2 — the collector does not move objects

**The sweep frees; it never copies** (`std/assembly/rt/itcms.ts:225-232`):

```rust
case STATE_SWEEP: {
  obj = iter;
  if (obj != toSpace) {
    iter = obj.next;
    if (DEBUG) assert(obj.color == i32(!white)); // old white
    free(obj);
    return SWEEPCOST;
  }
```

and `free` (`itcms.ts:243`) unlinks the object and returns its block to the
allocator:

```rust
function free(obj: Object): void {
  if (ARENA ? (HEAP_BASE > changetype<usize>(obj)) : (changetype<usize>(obj) < __heap_base)) {
    obj.nextWithColor = 0; // may become linked again
    obj.prev = changetype<Object>(0);
  } else {
    total -= obj.size;
    ...
    __free(changetype<usize>(obj) + BLOCK_OVERHEAD);
  }
}
```

**TLSF does not compact.** Grepping the allocator for anything that moves an
object finds exactly one `memory.copy` (`tlsf.ts:544`), inside
`reallocateBlock` — the explicit resize behind `__realloc` (`tlsf.ts:578-582`).
The collector never calls `__realloc`, and `TaskRecord` is fixed-size, so the one
relocating path is unreachable for it.

**Verdict A2: mark-sweep with stable addresses. The pointer is safe — no index +
generation needed.** Stop condition not met.

**The one caveat, stated because it constrains Phase B.** A pointer is stable
*while the object is live*, and liveness is the **owning store's**: the worker's
`slots[id].record = awaited` and `state.record` are what root it. Main's
collector knows nothing about a worker's record and must not be relied on to keep
it alive. That is the correct split (the park belongs to the store that parked),
but it means the ledger's handle must never be the *only* reference.

## A3 — how a worker learns the session ended

**The state word**, documented on the accessor (`std/assembly/thread.ts:1343`):

> `signal + 4` is the arena base, `+ 8` its size, `+ 12` the state
> (0 unborn / 1 running / 2 exited), `+ 16` the spawn entry and `+ 20` its argument.

**The served loop already uses it** (`thread.ts:1676`):

```ts
while (!e.stop && atomicLoad<i32>(sig + 12) != 2) {
```

**`__executorExit(id)` is the stop signal, and it is complete:**

```ts
export function __executorExit(id: i32): i32 {
  if (!SHARED || __controlBase == 0) return -1;
  if (id < 0 || id >= __executorTotal) return -1;
  let sig = signalBase(recordBase(id));
  let e = __executorOf(id);
  if (e) changetype<Executor>(e).stop = true;
  atomicStore<i32>(sig + 12, 2);
  atomicNotify(sig + 12, -1);
  atomicNotify(sig, -1);
  return 0;
}
```

It sets the state, sets the store-local `stop` flag where there is one, and
**notifies both** `sig + 12` and `sig` — so a worker blocked in
`atomicWait<i32>(sig, …)` is released. Callable repeatedly: it is idempotent
(writes `2` again, notifies again) and answers `0` each time. It is a guest
export, so main's guest code can call it — measured, `__executorExit` is in
`strand-nested.wasm`'s export list.

**A session-wide stop word: the space already exists.**

```ts
// std/assembly/thread.ts:1243-1250
const HEADER_WORDS: i32 = 16;
const H_MAGIC: i32 = 0;
const H_TOTAL: i32 = 1;
const H_STRIDE: i32 = 2;
const H_CAPACITY: i32 = 3;
const H_REQUESTS: i32 = 4;
```

The header is 16 words and **words 5–15 are unused**, so `H_STOP = 5` needs no
layout change. (That is a guest-side constant, so putting a *guest* reader on it
is a std change — see Decision A.)

## A4 — teardown, precisely

**The order today** (`main.rs:2058-2090`):

1. the entry runs (`_start_game` / `_start`) → `guest_result`
2. `pool.join_finished()` — `main.rs:2061`
3. `strand_refusal(&pool)` — `main.rs:2081`, replacing `guest_result` when it was `Ok`
4. on `Err`: `teardown_adapters`, `drop_host_window`, return the error

**So the strand check sits *after* `join_finished`** (DL12B's design). Moving it
to teardown is **a move of the moment, not a rewrite of the check**: the
function, its message and its predicate are unchanged.

**`join_finished`'s policy, quoted** (`thread.rs`):

```rust
const GRACE: std::time::Duration = std::time::Duration::from_secs(2);
...
if workers.is_empty() || std::time::Instant::now() >= deadline {
    for id in workers.keys() {
        logging::log(Level::Warn, "thread", &format!(
            "executor {id} is still running after the guest returned: the guest \
             did not call __threadJoin({id}), so the thread is detached (the \
             process exit is its end)"));
    }
    return;
}
```

**This is now the wrong policy, and it is the sharpest thing Phase A found.**
Under a session pool a healthy worker *is* still running when the guest returns.
`join_finished` would therefore print, on **every healthy run**:

```
WARN thread: executor 1 is still running after the guest returned: the guest did
not call __threadJoin(1), so the thread is detached (the process exit is its end)
```

and detach it — turning the round's normal case into a warning, and leaving the
thread alive when the process should be stopping it. **Teardown must shut the
pool down before joining**: signal every executor (set its state word, notify its
wait primitive), then join, then run the strand check.

**What stops a blocked worker from being detached forever: today, nothing but
the 2-second grace — and the grace *detaches* rather than stops.** `__executorExit`
already notifies the guest `sig` word, so a worker blocked in the guest primitive
is reachable; a host-side loop blocking on a Rust primitive (Decision A (i))
would need the host to notify its own primitive instead. Either way the shutdown
must be explicit, and it is one store-local signal per executor.

**A consequence for the strand check.** `strand_refusal` runs `take_strands()`,
which reads what workers have *already recorded* — and a worker records its
strand only when it leaves `worker_main`. While workers are long-lived, a strand
is invisible until that worker stops. So the teardown order must be
**stop → join → check**, not **check → stop**.

## A5 — the producer verb

**What exists**: `--post-test-events` (`main.rs:2000`), three events, hard-coded:

```rust
match posting.post(1, session::arena::CLASS_JOB_DONE, 0, 1 + index * 2, 2 + index * 2, 1.5, 0.25)
```

`a` is the key for this class (keys 1/3/5), and the calls happen **before** the
entry.

**The smallest addition** is a sibling flag that posts one event with a chosen
class and key, in the same place (before the entry, so a park can claim it):

```
--post-completion <CLASS>[,<KEY>]
```

It reaches `posting.post(source_id, class_id, flags, key, b, f0, f1)`
(`posting.rs:424`), which is the same entry `--post-test-events` uses, and from
there the epoch's delivery path — `session/epoch.rs:299`,
`data.scheduler.deliver(*class, *key, *payload)`.

**But it cannot complete a worker's park today**, and this is the finding:

```rust
// scheduler.rs:462 — the claim is main's, and only main's
if let Some(early) = caller.data_mut().scheduler.take_early(class, key) {
    let resolved = caller.data_mut().scheduler.take(class, key).unwrap_or(task_id);
    caller.data_mut().wake_batch.push(Wake { task_id: resolved, ... });
}
```

`deliver`/`take_early` read **main's `Scheduler`**; a worker's park is in DL18's
`ExecutorPool::parks`. `thread.rs`'s park registration has no `take_early` call
at all (grepped: absent). So with the right class and key, the flag matches
nothing. Phase B item 2 is what makes it reach — and the brief's Phase C step 2
(post *before* the park) additionally needs the early buffer to be visible from a
worker's park, which the brief's list does not name. **Reported as an extra
Phase B item: the sticky wake needs the completion buffer on the pool, not only
on main's `Scheduler`.**

## A6 — the two decisions

### Decision A — where the worker's loop lives

**(i) `worker_main`, host side, after `__workerMain` returns**, still holding
`&mut Store`.
*For*: no std change, so `asc.js` and the bundle stay `aa74d6a1`; the wait can be
a real `Condvar` (§3.2/§4.4 without spin); §3.4's "the owner thread calls wake at
a defined boundary" is literally this, with the boundary being "after the entry
returns, before the thread ends"; §2.2 is enforced by `&mut Store` rather than by
prose, since no other thread can hold one.
*Against*: the loop is invisible to a reader of `thread.ts`, so it must be
described in `thread.rs` in as much detail as the guest loop is.

**(ii) `std/assembly/thread.ts`, `atomicWait` like the served body.**
*For*: the loop sits where the other loop is; the guest already computes the
signal address; the session stop word (A3: `H_STOP = 5`) is natural there.
*Against*: **a std change, so `asc.js` moves and every guest recompiles** — which
this round forbids without your agreement, and it would make this a two-repo
round with a new bundle hash.

**Recommendation: (i).** It satisfies the contract's wait requirements with no
compiler or std change, and it is the only shape that keeps the declared gate
(`aa74d6a1`) intact. The cost is prose, not behaviour.

### Decision B — how an uncompleted park is refused at teardown

**(i) session shutdown declares it** — at teardown, any unresolved entry in the
session ledger fails the process, with DL12B's message and a wider scope.
*Consequence*: one place decides, one message, and it fires for a park on **any**
executor including one that has already stopped. Needs the shutdown order
(stop → join → check) so the ledger is complete when it is read.

**(ii) per-worker** — a worker asked to stop with unresolved parks fails the run.
*Consequence*: names the executor that stranded, which is the more actionable
message; but each worker must fail the process from a teardown path, and a
worker that was never asked to stop (because main returned early) contributes
nothing — so (i) and (ii) differ exactly on the case the guarantee exists for.

**(iii) count and report, exit 0** — rejected by the brief, and rightly: it is the
silent success this arc has been removing.

**Recommendation: (i)**, with the message keeping (ii)'s per-executor detail —
`Strand` already carries `executor`, `unresolved` and the first park, so (i) can
print exactly what (ii) would. That keeps DL12B's guarantee and its wording while
moving the moment to where a live pool can be read.

### One consequence of the binding handle decision, for Phase B

The wake handle is the record pointer (safe, A1/A2), but **it is not the argument
`__taskWake` takes.** `__taskWake(idsPtr, count)` reads **store-local slot ids**
(`task-rt.ts:349`), and `TaskRecord` carries no slot field — only `class_`, `key`,
`payload`, `status`, `f0`, `f1`, `tag`, `done` (task.ts:20-38). `state.slot`
lives on `TaskState`, not on the record.

So the ledger entry needs **both**: the pointer (identity + routing: which arena
it falls in tells the owner, arithmetically, from `__workerArenaBase(id)` /
`__workerArenaSize(id)` which the host already calls) **and** the store-local task
id, which is what the owning store passes to its own `__taskWake`. Deriving the
id from the pointer instead would mean scanning the worker's `slots` table for
`slot.record == ptr` — O(capacity) per wake, against the contract's §3.3 O(1).

Proposed entry: `(handle: u64, owner: u32, task_id: u64)` — three words, O(1)
everywhere, and the pointer stays the identity as decided.

## Stop

Waiting on **Decision A** (recommend (i), host-side loop) and **Decision B**
(recommend (i), session-scope refusal with per-executor detail).

Phase B then has six items, the brief's five plus **the sticky wake**: the
early-completion buffer has to be reachable from a worker's park, or Phase C's
deterministic "post before the park" cannot land.
