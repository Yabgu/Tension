# DL23 — the neutrality probe: the seam is (b), and the resume is missing upstream

**The answer is shape (b), and it is worse than (b) as the brief worded it.** The
stackful await never touches `scheduler::park` — the module does not even *import*
it — and the host could not resume a continuation even if it saw one, because
wasmtime 50.0.2 does not expose continuation resume to embedders.

`~/work/Tension` `integration/dwarf-debug`, from **`0e595f9`**, pushed with two new
scratch probes. `~/work/TensionScript-a2` untouched at **`3f59ec08`**, clean, bundle
**`aa74d6a1`**, `std` byte-identical. **No ABI change, no engine behaviour change,
no compiler change, no std change.**

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`0e595f9`**, `git status --porcelain` empty, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `std/assembly/thread.ts` | identical to the installed package |
| binary | `33 643 504` bytes, mtime **2026-11-23 14:11:11** |
| newest source | `src/thread.rs` **2026-11-23 14:07:07** |
| sources newer than the binary | **0** |

The rebuild was a no-op: `cargo build` finished in seconds and the binary's mtime is
still DL22's 14:11:11, which is later than every source file. So the engine measured
here is byte-identical to the one DL22 measured — which is why its counts carry.

## 1. Q1 — what the stackful lowering emits at an `await`

**Emission site**, `src/async/stack.ts` (the `drive` body it synthesizes on each
`f$Rec`), quoted from the code that builds it and from the comment above it:

```ts
// `drive(): void { if (!this.settled) { let $awaitSlot = this.slot;
//                                   __parkOn(this); __suspendAwait($awaitSlot); } }`
let driveBody = Node.createBlockStatement([
  Node.createIfStatement( /* !this.settled */ …,
    Node.createBlockStatement([
      /* let $awaitSlot = this.slot */
      /* __parkOn(this)          */
      /* __suspendAwait($awaitSlot) */
    ]) …
```

The two callees are the whole story, and neither is the host's:

- **`__parkOn`** (`std/assembly/task-stack.ts:191`) registers a `Waiter` in this
  store's heap: `waiter.exec = selfExecutor; waiter.slot = __currentSlot();
  list.push(waiter)`. **No host call, no import.**
- **`__suspendAwait`** (`src/builtins.ts:12369`, codegen at `:12383`) is

  ```ts
  return module.suspend(ASYNC_AWAIT_TAG, [ slot ]);
  ```

  with `export const ASYNC_AWAIT_TAG = "await"` (`src/compiler.ts:280`) — the wasm
  **`suspend` instruction**.

**Confirmation at the binary level**, which is the part that cannot be argued with:

```
stackful-external-await.wasm imports: env::abort, tension::io::print,
  env::__executorCount, env::__startThread, env::memory        ← no scheduler::park
two-waiters-late.wasm    imports: env::abort, tension::io::print,
  scheduler::park, env::__startThread, env::__executorCount, env::memory
```

Both guests contain an `await`. Only the Promise build imports the park seam.

**The choice site** is `src/compiler.ts:1716` — the seat's note was right in shape,
stale by ~100 lines:

```ts
this.asyncShellSuspends = program.hasAwait && options.hasFeature(Feature.StackSwitching);
```

It is still **whole-program**: one boolean for the module, decided before the first
body compiles, from `hasAwait` and a compile flag. There is no per-call-site or
per-function selection, and `program.hasAwait` is syntactic — a program that
suspends only through `policy.await(...)` (a method named `await`, not an await
expression) is refused at compile time:

```
ERROR AS100: Not implemented: ~lib/task-stack/__suspendParked requires the
suspending async shell, which this program does not emit
```

measured while writing the Q4 probe. That refusal is itself a data point: the two
backends are chosen by *syntax*, not by what the program does.

**One sentence:** the stackful lowering emits a guest-side registration followed by
the wasm `suspend` instruction, and it does not call `scheduler::park` — not "as
well", not "after": at all.

## 2. Q2 — what the wake callable is, and what `park` does

**Where `wake` is resolved** — `tension-core/src/thread.rs:1531`, by export name on
the worker's own instance:

```rust
let wake = instance.get_typed_func::<(i32, i32), ()>(&mut store, "__taskWake").ok();
```

`None` is not fatal: the host logs *"executor {id} exports no `__taskWake`, so it
serves no wake path"* and the park strands.

**That export's body**, guest side — `std/assembly/task-rt.ts:349`:

```ts
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

and `TaskState.resume` is declared as *"The function that resumes this task —
`f$resume`, assigned by the entry"* (`task-rt.ts:64-78`).

**The host's `park`** — `thread.rs:1137`, the closure registered on a worker's
store — records the park twice (store-local `Vec`, shared ledger), offers it to the
sticky buffer via `claim_early`, and **returns**:

```rust
|caller: Caller<'_, WorkerState>, task_id: i64, class: i32, key: i32| {
    … parks.push(park); … ledger.record(…, ParkedTask { handle: 0, owner, task_id }) …
    } else if pool.claim_early(park.class, park.key, owner, park.task_id) { … }
}
```

It does **not** block the store, suspend a fiber, or install a continuation. The
closure's type is `() -> ()`: the call returns to the guest, and the suspension is
whatever the guest does next — which in the Promise backend is returning to its
executor.

**One paragraph: what resumption actually is today.** A wake is: the host writes a
store-local task id into the guest's own memory (`sig + 16`, the dead
`entry`/`arg` words of the executor's spawn record) and calls `__taskWake`, which
looks that id up in the **Promise backend's** `slots` table and calls the state
machine's `f$resume`. Park and wake are therefore two halves of one promise
mechanism, and the mechanism is named by a Promise-side data structure: a slot id
in `slots`. A stackful task has no `slots` entry and no `f$resume` — it is a
suspended continuation in the engine — so for it, `__taskWake` is not "the wrong
wake", it is **not a wake at all**: the id could not name anything.

## 3. Q3 — DL11's hang, diagnosed

DL11's artifact is lost (it lived in `/tmp`, never committed, and `/tmp` has been
cleared since). It was reconstructed: `strand-nested.ts` plus the `async main` the
stackful shell requires, built with `--enable stack-switching`. It builds to
**31 306 B** against DL11's recorded 31 285 B, and reproduces DL11's `main: index=6`
exactly.

But the useful result came from splitting the question, which is what
`tools/thread-promise/programs/stackful-worker.ts` now does: no park, no await, no
wake, just one worker whose entry is one line — with two knobs.

| `ASYNC_ENTRY` | `STOP_FIRST` | measured |
|---|---|---|
| false | false | `main: spawning / index=4 / spawn=0 / worker: entered (sync entry)` → **EXIT=124** at 20 s |
| false | true | same lines, then `join=0 / done` → **exit 0, 0 s** |
| **true** | **false** | `main: spawning / index=4 / spawn=0`, **no worker line** → **EXIT=124** at 20 s ← **DL11's symptom** |
| true | true | same, plus `recorded 0 park(s)` → **exit 0, 0 s** |

And the reconstructed shaped guest, today, with the stop word every current guest
uses:

```
main: spawning
main: index=6
main: spawn=0
main: join=0
main: done
INFO  thread: executor 1 exports no `__taskWake`, so it serves no wake path; …
INFO  thread: executor 1 left the park seam having recorded 0 park(s)
→ exit 0, 0.0 s
```

**Diagnosis: yes, and it is not the missing resume path.** Two independent causes,
both measured, neither of them about parks:

1. **An async worker entry never runs under stack switching.** A plain-function
   entry runs and prints; an `async` entry is a continuation-shaped spawn entry and
   produces **no line and no park** — `recorded 0 park(s)`. That is DL11's
   "the worker never printed `BEFORE`", and it is a served-body defect, not a
   park/wake one.
2. **A join with no stop word waits forever.** DL20B made a worker live for the
   session, so `__threadJoin` returns only after the worker is told to stop. In
   DL11's era there was no stop word, so a worker that never finished its entry
   (cause 1) meant `__threadJoin` never returned — **that is the EXIT=124**.

So DL11 is **not** the B4 receipt for a missing resume: the task never parked. And
the hang has since become a **silent success** — the same failure now exits 0 in
0 s, because the stop word releases the join while the entry still never ran. That
is a worse failure mode than the hang, and it is a finding in its own right.

**The one experiment that would decide what remains:** whether `$starts[6]` is
being *served as a continuation* or *called as a plain function* by the served
body — i.e. instrument `__serveSlot`/`__callStart` for a continuation-typed spawn
entry. I did not run it: it is served-body machinery (I31), outside this round's
scope, and Q4 does not need it.

## 4. Q4 — the smallest stackful policy, or the exact missing call

**It can be written, it runs, and it cannot be resumed.**
`tools/thread-promise/programs/stackful-external-await.ts`: one task, one park, one
would-be resume, no worker, no second store, on the current seam with no ABI change
and no engine change. It uses the guest library's own designed path for an external
completion, `policy.await(task)` → `__parkOn(task); __suspendParked();`.

Verbatim, `--executors 2 --post-completion 4,7`, **exit 0 in 0.0 s**:

```
main: leaf=0
main: BEFORE the policy await
main: _start_game (host entry)
INFO  core: --post-completion: class 4 key 7 -> buffered (no park yet: sticky)
```

`main: AFTER the policy await` never prints, so the continuation **did** suspend —
`__suspendParked` works. And the completion stayed buffered because the park seam
never saw a park: this module does not import `scheduler::park`. Nothing in the
process knows a task is suspended, so nothing can wake it, and the run ends
"successfully" with a suspended continuation abandoned.

That is **suspend-without-park** — shape (b) — with nothing left over for a policy
layer to unify, because there is no stackful park to unify.

### The exact missing call, and the reason it is not merely uncalled

Two things are missing, and the second is upstream:

1. **A park registration on the stackful path.** `scheduler::park` would be the
   natural seam, but `__parkOn` cannot call it today: the contract's `park` carries
   `(task_id, class, key)`, and the stackful waiter has no `class`/`key` — it has a
   *continuation*. So the signature would have to change to name the thing being
   parked: something like
   `scheduler::parkCont(owner: i32, cont: contref) -> i32`, called from
   `__parkOn`'s new tail (or a new `__parkCont` beside it), with the host recording
   it in the same `ParkLedger` under a synthetic `(class, key)` pair or under its own
   key space.
2. **A resume call in the host.** This is the blocker, and it is not in this tree:

   ```
   wasmtime-50.0.2/src/runtime/values.rs:7-13
   /// A stub implementation for continuation references.
   /// This is a placeholder until continuation objects are fully integrated
   /// with the GC system (see #10248).
   pub struct ContRef;
   ```

   ```
   wasmtime-50.0.2/src/runtime/values.rs:328-331
   HeapType::NoCont | HeapType::ConcreteCont(_) | HeapType::Cont => {
       // TODO(#10248): Required to support stack switching in the embedder API.
       unimplemented!()
   }
   ```

   So the call the policy would need —
   `resume(store, cont: ContRef, tag: &str, payload: &[Val]) -> Result<ContRef>`,
   called from `tension-core/src/thread.rs`'s `service_wakes` **in place of**
   `wake.call(&mut *store, (scratch as i32, 1))?` when the matched task is a
   continuation — **cannot be written against wasmtime 50.0.2 at all.** The guest
   can resume its own continuations (its coreloop emits `cont.new` / `resume`), the
   host cannot resume one it did not create.

**What the guest must do today instead:** use the Promise backend. That is
`wake-on-worker.ts` built *without* `--enable stack-switching`: it parks through
`parkState` → `scheduler::park`, the host's session loop calls `__taskWake`, and
`state.resume` runs `f$resume`. Concretely, quoted from the running guests:

```ts
// src/async/lower.ts:1736-1755, the Promise park seam — verified in the source
// this round, not quoted from an earlier report:
if (!__taskSettled($awaitedK)) { <copy-out>; __taskPark($state, $awaitedK); return; }
```

**Answer to the round's question, stated once:** the park/wake seam is **the
Promise backend wearing a general name**. It is not the stackful path at all — a
stackful await suspends without parking, and per-call-site policy today would mean
two suspension mechanisms, of which only one is visible to the host. The closest
honest statement of the target is not "unify two registries" but "give the stackful
path a registration, then wait for an engine that can resume".

## 5. Declared versus measured

**Declared before the first run: the scratch-program case.** No code changed, so no
count may move; Q4's probe goes under `tools/thread-promise/programs/` committed
with its recipe.

| item | declared | measured | verdict |
|---|---|---|---|
| `--bin` count | 307 | **307** (see §7 bug 1) | unchanged |
| census `--workers 8`, alone | 71 pass / 11 no-source | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability skips | unchanged |
| thread suite | 7 | **7 passed** (+ `async_main_promise` 2) | unchanged |
| bundle / std | unchanged | `aa74d6a1`, std identical | ✓ |
| park ABI, ledger, fan-out | untouched | `git diff` shows no `.rs` change at all | ✓ |

### Files touched (all new, all declared)

| file | why |
|---|---|
| `tools/thread-promise/programs/stackful-external-await.ts` | Q4's probe — the suspend-without-park measurement |
| `tools/thread-promise/programs/stackful-worker.ts` | Q3's probe — the 2×2 that separates the pool-lifetime hang from the async-entry hang |
| `tools/thread-promise/programs/README.md` | a section naming both probes and what they are not |
| `tools/thread-promise/DL23-REPORT.md` | this report |

**No `.rs` file changed.** `git diff --name-only | grep -c '\.rs$'` → 0, which is
the strongest form of "no ABI change, no engine change" available.

## 6. Commits and CI

| SHA | what |
|---|---|
| `a24497c` | `probe(thread): two stackful probes — the seam is suspend-without-park (DL23)` |
| *this report* | `docs: DL23 — …` |

CI: run id and conclusion in the message that carries this file (the two commits
land on `integration/dwarf-debug`, and the workflow runs on push).

## 7. Bugs I made, and what caught each

1. **I ran `cargo test --bin tension-core` concurrently with `cargo test --test
   threads`, and got 305 passed / 2 failed** — two `sandbox::tests` with "the outer
   guest runs: error while executing at wasm backtrace". Re-run **alone**, 307/307.
   The gate item is unchanged; what broke was my own rule about one suite at a time
   (DL21 wrote that rule down after a half-written `.wasm` produced a breakpoint
   that did not bind). Recorded because a concurrency artefact is exactly the kind
   of thing that would otherwise be reported as a real delta.
2. **`policy.await(...)` is not an `await` expression**, so my first Q4 probe was
   refused with `AS100: … requires the suspending async shell` even though I had
   passed `--enable stack-switching`. The fix (a real `await leaf()`) is load-bearing
   and now carries a comment saying why — and the refusal itself became a finding
   about how the backend is selected.
3. **My own wasm export parser returned 0 exports for every module**, including one
   that obviously exports thirteen. I did not debug it; I replaced it with
   `WebAssembly.Module.exports` under Node, which is the arbiter anyway. A parser I
   wrote in a hurry is not evidence about the bytes.
4. **I referenced a file I had not written** (`stackful-worker-stop.ts`) in a header,
   and caught it while re-reading the header I was about to commit. Replaced by a
   `STOP_FIRST` constant inside the one probe, so the control travels with the
   measurement and there is no second file to forget.

## 8. What I did not verify

- **DL11's original artifact.** Lost; the reconstruction is behaviourally faithful
  by size (31 306 vs 31 285 B) and by `index=6`, not byte-identical.
- **Why an async worker entry does not run.** I measured it (no line, 0 parks) and
  bounded it to the served-body path; I did not instrument `__serveSlot` /
  `__callStart`. That is the one experiment named in §3, and it belongs to I31.
- **Whether a stackful continuation can be resumed by any *other* route** (a guest
  exporting a `cont`-typed function the host could call). wasmtime 50.0.2's embedder
  API cannot construct or pass a `ContRef` at all (`unimplemented!()`), so I did not
  look for a workaround — but I did not prove none exists in a later engine.
- **A second consumer for the Promise seam** (the brief's neutrality test). There is
  none in this round: no program in the tree parks through the seam except the
  thread-promise guests the previous rounds wrote. That absence *is* one of the
  answers.
- **Windows**, latency, fan-out, I50's ABI, I47/I45/I36 — all excluded by the brief.
