# DL12B — a stranded task now fails the process

Option 4, confirmed in DL12 Phase A, implemented. `~/work/Tension`
`integration/dwarf-debug` @ **`f24701d`** (the change) plus this report.
`TensionScript-a2` `fix/plain-worker` @ `dddd8849`, untouched. **Compiler bundle
`767d3d7a`** — unchanged, as declared.

## 0. Phase 0, and the rebuild

```
integration/dwarf-debug  3055cd8   clean
binary  33548160 bytes  2026-11-22 17:39:03   (DL11's build)
src newer than binary:  (none)
fix/plain-worker  dddd8849  clean
```

Preflight was clean. After the change I rebuilt — **binary 33 586 784 bytes,
2026-11-22 18:13:56, no `src` file newer** — so Phase C measures the new engine,
not DL11's.

## 1. Phase B — the diff

`tension-core/src/thread.rs` (+79) and `tension-core/src/main.rs` (+67), plus
`docs/abi/guest.md` regenerated (line numbers only — the tables embed `file:line`).

**The record** (`thread.rs`):

```rust
pub struct WorkerPark {
    pub task_id: u64,
    pub class: u32,
    pub key: u32,
    pub resolved: bool,      // ← always false today; the wake path sets it
}

pub struct Strand {
    pub executor: i32,
    pub unresolved: u32,
    pub first: WorkerPark,
}
```

`ExecutorPool` gains `strands: Mutex<Vec<Strand>>`, plus:

```rust
fn record_strand(&self, id: i32, parks: &[WorkerPark]) {
    let unresolved = parks.iter().filter(|park| !park.resolved).count();
    if unresolved == 0 { return; }
    …
}
pub fn take_strands(&self) -> Vec<Strand> { … std::mem::take … }
```

**The predicate, exactly as written:** `!park.resolved` — "unresolved at exit",
not "recorded at all". Every worker park is unresolved today, so the two agree;
the field is there so the wake path sets it and a resumed task stops being a
strand with no change to the check.

**Where it is filled:** `worker_main`'s tail (`thread.rs:475` is the call; the
record itself is the last thing before `Ok(status)`) — the last moment the
worker's own store is alive, since `parks` dies with it.

**The refusal** (`main.rs`): `strand_refusal(&pool)` returns
`Option<wasmtime::Error>`, and the call site **replaces `guest_result`**:

```rust
let guest_result = match store.data().executors.clone() {
    Some(pool) => match strand_refusal(&pool) {
        Some(refusal) if guest_result.is_ok() => Err(refusal),
        _ => guest_result,
    },
    None => guest_result,
};
```

That is deliberate: the existing trap path then tears down the adapters and drops
the window, so a strand exits the same way a guest trap does instead of
short-circuiting the cleanup. A guest that already trapped keeps its own reason.

**The message** names the executor, the count and the first park, and says where
the limit is rather than blaming the guest:

```
Error: a worker's task cannot be resumed on this host, so this run would otherwise
have exited successfully with it stranded: executor 1 left 1 task(s) parked and
never resumed (first: task 0 on class 4 key 7). A worker's store has no host loop,
and `wake` is confined to a store's owner thread (docs/scheduler-contract.md §2.2),
so a parked task on a worker has no path to a completion here.
```

**What it does not do, and the comment says so:** it does not tell the guest. The
program's own `await` never returns either way; this makes the *process* honest,
not the program.

## 2. Phase C — both directions

### The strand is loud

`strand-nested` (DL11's guest: a worker's nested async function awaiting a
never-completed record), `--executors 2` before the module path:

```
exit 1

main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
main: join=0
main: done

INFO  thread: executor 1 left the park seam having recorded 1 park(s)
             (first: task 0 on class 4 key 7) — …
Error: a worker's task cannot be resumed on this host, … executor 1 left 1
       task(s) parked and never resumed (first: task 0 on class 4 key 7). …
```

**Exit 1.** Note the guest's stdout is unchanged — `main: done` still prints, and
`join=0` — which is the honest picture: the *program* never learns, the *process*
refuses. That asymmetry is the whole content of this round.

### The healthy path

`examples/async-on-main` Promise build: **exit 0**, 28 transcript lines ending
`main: done, total=67`. Unchanged.

### The served-body guests cannot trigger it — proved per guest

The suite going green proves `output.status.success()`; that is not the same as
proving the check did not fire for the right reason. Each guest run individually:

| guest | exit | park line |
|---|---|---|
| `count` | 0 | (no worker spawned) |
| `spawn-join` | 0 | `recorded 0 park(s)` |
| `two-workers` | 0 | `recorded 0 park(s)` |
| `spawn-refusals` | 0 | `recorded 0 park(s)` |

They are served-body guests: they move tasks by continuation, never call
`scheduler::park`, so `parks` is empty and `record_strand` returns without
recording.

### Suites

`cargo test --test threads` → **5 passed**: `a_shared_memory_guest_can_print`,
`a_worker_runs_on_its_own_store_and_joins`, `one_executor_count_plus_the_pool`,
`the_contracts_refusals_are_values`, `two_workers_observe_every_value_exactly_once`.
`cargo test --test async_main_promise` → **2 passed**.

**No census**, as declared: it measures the continuation engine's DWARF and
nothing here changes compiler output.

## 3. State

`integration/dwarf-debug` @ `f24701d` (the change) + this report, clean, pushed. Compiler bundle
`767d3d7a` in the tree and installed. No status-word change (I39 stays open), no
wake path, no worker loop, no compiler edit.

## 4. What I did not verify, and what I assumed

- **The teardown path was not observed.** I route the strand through the trap
  path precisely so adapters and the window are torn down, but nothing in these
  runs holds an adapter, so "no leak" is reasoned from the code path, not
  measured.
- **One guest, one shape.** Only DL11's `strand-nested` exercises the refusal.
  A guest that strands on a *second* executor while main traps is handled by the
  `guest_result.is_ok()` guard but was not run.
- **`resolved` is never set to `true` by anything.** It is read by the predicate
  and constructed `false`; a Rust reader will find a field that cannot become
  true. That is intended and documented as the wake path's insertion point, but
  it is dead-by-design today.
- **Assumed** the thread programs' `recorded 0 park(s)` line is definitive for
  "no park was recorded" — it is printed from the same `parks` vector the
  predicate reads, so the two cannot disagree.
- `docs/abi/guest.md` changed only in its `file:line` cells (verified by
  diffing the row text), because `thread.rs` grew above the registrations.
