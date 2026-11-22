# DL12 Phase A — three mechanisms, one recommendation, and one measured blocker

Round: make a stranded task a refusal instead of an invisible success. **Phase A
only** — the brief stops the round here for confirmation.

`~/work/Tension` `integration/dwarf-debug` @ `25bfa43` (this document is the only
change); `TensionScript-a2` `fix/plain-worker` @ `dddd8849`; compiler bundle
`767d3d7a`.

## 0. Phase 0

```
integration/dwarf-debug  25bfa43   clean
binary   33548160 bytes  2026-11-22 17:39:03
src newer than binary:   (none)
fix/plain-worker  dddd8849  clean
```

## 1. Where the check can live (item 1)

**The last place a worker's own state is readable** is inside `worker_main`, after
`__workerMain` returns and before its `Store` drops — `tension-core/src/thread.rs:475`:

```rust
let status = worker_main.call(&mut store, id).map_err(|error| { … })?;
// … the park log added in DL10 (thread.rs:485-505) reads store.data().parks here
Ok(status)
```

After that function returns, the store — and therefore `parks` — is gone. The only
things that survive are the `i32` status and the `Arc<ExecutorPool>`.

**Is the parked-but-unresumed count readable there?** Yes, and it is simply
`store.data().parks.len()`. On a worker, **every** recorded park is unresumed,
because nothing on that store drains the list (DL11 measured exactly that: 1 park,
task never resumed). So no new bookkeeping is needed to know the count — only a
channel to get it out.

**Where main can learn it.** `main.rs:1742`:

```rust
if let Some(pool) = store.data().executors.clone() {
    pool.join_finished();
}
```

This runs after the guest returned, on both the clean and the trapping path, and
`pool` is an `Arc` shared with every `WorkerState` (`thread.rs:70`). So anything
recorded on the pool is readable there — this is the cheapest place to refuse.

## 2. What "refuse" can mean, and what each costs (item 2)

First, a measured fact that rules one of the obvious answers out.

**The status channel is already meaningless.** With `TENSION_LOG_LEVEL=debug`, the
same three workers:

| guest | `__workerMain` answered |
|---|---|
| DL9 `wp-plain` (sync entry) | **0** |
| DL9 `wp-control` (served body) | **0** |
| DL11 `strand-nested` (async entry, Promise) | **169888** |

169888 is the address of the entry's `Task` handle: Backend A's entry returns its
handle, so the tail of `strand-nested.wat`'s `awaited` is `get:handle; return`,
regardless of whether it suspended. **A plain worker's status is a heap pointer
whenever the entry is an `async` function** — non-zero on a perfectly successful
run. So "return a non-zero status" is not a signal; it is already happening by
accident, and nothing reads it (`join_finished` logs it at **Debug**, `thread.rs:246-249`).

### Option 1 — return a non-zero status from `__workerMainPlain`

- **What reads it:** only `join_finished`, at Debug. `__threadJoin` reads the
  record's **state word** (`sig+12`), not the status, so the guest's `join` still
  answers 0 whatever the status is.
- **Blast radius:** to be meaningful the plain worker must stop forwarding the
  entry's raw return — a behaviour change for every plain-worker guest, plus a new
  code in `docs/threads.md`'s refusal list.
- **Does the guest see it:** no.
- **Verdict:** not sufficient alone. Two changes (define the status, then read it)
  to reach a place (a Debug log) that is still invisible at default verbosity.

### Option 2 — abort the worker (Error log + trap)

- **What main sees:** nothing, unless the exit path is changed too — and there is a
  trap-specific hazard: `__threadJoin` waits for the state word to become 2, which
  the worker's own tail writes. A worker that **traps** never reaches the tail, so
  the guest's join would spin forever. Converting a silent success into a hang is
  worse for CI than the current bug.
- **Does the guest see it:** no — the guest already returned from `__threadJoin`
  before main printed `done` in DL11's run.
- **Blast radius:** medium code, high risk (the hang), no extra benefit.
- **Verdict:** not recommended.

### Option 3 — a new refusal class in the scheduler vocabulary

- A guest-facing errno for something the guest cannot observe: there is no wake
  path, so the parked task never returns anything to its awaiter.
- **Blast radius:** `docs/scheduler-contract.md` §5.1 plus the class table plus a
  delivery path that does not exist. This is the largest of the three and buys
  nothing until the wake path lands.
- **Verdict:** belongs with DL12's successor (the wake path), not before it.

### Option 4 (recommended) — the host observes the strand and refuses at the process boundary

- **`ExecutorPool`** (library, `thread.rs`) gains a shared record of strands:
  `stranded: Mutex<Vec<Strand>>` with `{ executor: i32, parks: u32, first: (u32 class, u32 key) }`.
- **`worker_main`** records into it when `store.data().parks` is non-empty — i.e.
  exactly when the worker is finishing with a task nothing could resume. This is
  the same condition the DL10 Info line already tests; the change is where the fact
  goes, not what is measured.
- **`main.rs:1742`** after `join_finished()`: if the pool reports any strand,
  `bail!` with a message naming the executor, the count and the first
  `(class, key)` → `run()` returns `Err` → `fn main() -> anyhow::Result<()>`
  prints `Error: …` and exits **1**. That is the same exit path a guest trap takes.
- **Cost:** ~20 lines in `thread.rs`, ~6 in `main.rs`. No ABI change, no compiler
  change, no contract text, no wake, no guest-visible change.
- **Blast radius, stated plainly:** every guest that strands now fails its
  process. That is the requirement. It cannot fire on the 5 thread tests — they are
  stackful/served-body guests and never call `scheduler::park`, so `parks` is empty
  — and that is checked in Phase C rather than assumed.
- **What it does *not* do:** it does not make the *program* detect the strand. See
  item 3.

**Recommendation: Option 4.** It is the smallest change that satisfies the
binding decision ("the worker must report it in a way that changes the exit
status"), it reuses the measurement DL10 already produces, and it cannot hang.

## 3. What the guest itself sees (item 3)

**Nothing changes inside the program, for any of the four options.** In DL11's run
the strand was already invisible to the guest: `inner: AFTER` never printed,
`join=0`, and main went on to print `main: done`. The guest's own `await` does not
return and cannot be made to return without a wake path — which this round
explicitly does not build.

So the honest statement of what the round buys: **the process becomes honest; the
program does not.** A loading zone built this way will fail loudly at the process
boundary instead of appearing to succeed — which is the user's requirement as
stated ("i dont wanna show async await write and pray for it work": the *praying*
stops being invisible). But a program that ignores its own exit status would still
not know. Full guest-side detection is the wake path's job.

## 4. Can main be told (item 4)

Yes, for free — `main.rs:1742` already holds an `Arc<ExecutorPool>` after the guest
has returned, and the pool is shared with every worker store. The cost is one
field on the pool and one check at that site; no ABI, no guest memory, no second
channel. Option 4 is precisely this.

## 5. Stop

Per the brief, no implementation this round. Awaiting the mechanism decision; on
confirmation Phase B is the diff above and Phase C runs DL11's `strand-nested`
guest (expect **not** exit 0) plus `examples/async-on-main` Promise (expect 28
lines, exit 0) plus both test suites.
