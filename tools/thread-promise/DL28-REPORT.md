# DL28 — the refusal, end to end: a foreign delivery fails the run by name

**I55's last unmeasured piece is measured.** A delivery the ledger never matched now fails
the run, names the task, the pair and the executor, and carries its own sentence — and the
negative control shows that without the guard the same run is **completely silent** (exit 0,
nothing logged at all).

`~/work/Tension` `integration/dwarf-debug`: `96a30ac` → **`cd688b1`**. CI **`45234048774`**,
success, `Wake path guard`: `3 passed; 5 filtered out`. `~/work/TensionScript-a2` untouched
at **`3f59ec08`**, bundle **`aa74d6a1`**, std identical.

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`96a30ac`**, `git status --porcelain` **empty**, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `package-lock.json` | clean; **no `npm install`** (I63 stays closed) |
| binary **before** | `33 647 504` B, mtime **2026-11-23 18:37:29** |
| newest source **before** | `src/thread.rs` **2026-11-23 18:37:01** — 0 newer |
| binary **after** | `33 653 336` B, mtime **2026-11-23 18:56:30** |
| newest source **after** | 0 files newer than it |

**Control captured before any edit**, so §F's comparison is against a measurement rather
than a memory:

```
$ tension-core --executors 2 --post-completion 4,7 wake-on-worker.wasm
EXIT=0
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
inner: AFTER the await, value=0
worker: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done

$ tension-core --executors 2 wake-on-worker.wasm      # no post at all
EXIT=1
```

## 1. Declared before the first run

- **Flag:** `--deliver-foreign <CLASS>,<KEY>,<TASK_ID>`, default off, in `USAGE` **and**
  `HOST_OPTIONS`.
- **Test:** `a_foreign_delivery_fails_the_run_by_name` in `tension-core/tests/threads.rs`,
  beside DL22's guard.
- **Counts:** `--test threads` **7 → 8**; CI `Wake path guard` filter **2 → 3** filters;
  `--bin` 307, census 71/11, `test:compiler` 0 skips, `--test fiber` 6,
  `--test fiber-executor` 7, bundle `aa74d6a1`, std identical.
- One suite at a time.

All measured exactly as declared — **no delta to report beyond the one mandated** (§G).

## A — the flag

Its help line, from `USAGE`:

```
  --deliver-foreign <CLASS>,<KEY>,<TASK_ID>
                         DL28 test-only: inject ONE delivery naming TASK_ID straight
                         onto executor 1's queue once a park on <CLASS>,<KEY> is
                         recorded, bypassing the ledger. A test instrument: it
                         exists so the foreign-delivery refusal can be measured end
                         to end, and it must fail the run by name. Needs --executors
                         and a --sharedMemory guest
```

The code path, in two halves.

**Armed on main** (`main.rs`, beside the other probe flags):

```rust
if let Some((class, key, task_id)) = config.deliver_foreign {
    match store.data().executors.clone() {
        Some(pool) => pool.arm_foreign_delivery(ForeignDelivery { class, key, task_id, owner: 1 }),
        None => anyhow::bail!("--deliver-foreign needs --executors and a --sharedMemory guest …"),
    }
}
```

**Fired from the park seam** (`thread.rs`), after `claim_early` and after the each-park post:

```rust
if recorded {
    if let Some(foreign_task) = pool.note_park_for_foreign_delivery(park.class, park.key) {
        logging::log(Level::Info, "core", &format!(
            "--deliver-foreign: injected class {} key {} for task {foreign_task} \
             straight onto the executor's queue — the ledger never matched it",
            park.class, park.key));
    }
}
```

and the injection itself — the one line that makes the delivery foreign:

```rust
// **Straight onto the queue.** No `deliver`, so no ledger `take`, so nothing has
// agreed that `task_id` is a task this store ever parked.
self.enqueue(Delivery { owner: foreign.owner, task_id: foreign.task_id, class, key, payload: 0 });
```

`note_park_for_foreign_delivery` answers the **foreign** task id, not the parking task's, so
the log line cannot print one number while meaning another — that was a bug I introduced and
caught (§H).

**No existing flag changed.** `--deliver-foreign` is a separate `HostOptionKind`, a separate
`Option` field and a separate parse function. The comparison in §F is the proof.

**Is there a smaller existing mechanism?** No. `--post-completion` and
`--post-completion-after-parks` both go through `Pool::deliver`, which *takes* a ledger entry
— so by construction they cannot produce an id the ledger never matched. The instrument has
to bypass `deliver`, which means a code path, not a flag on one.

## B — the run

```
$ tension-core --executors 2 --post-completion 4,7 --deliver-foreign 4,7,9999 \
    wake-on-worker.wasm
EXIT=1
```

**stdout** (the guest — unchanged, and that is assertion 5):

```
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

**stderr**, verbatim and unfiltered apart from the two startup Info lines:

```
INFO  core: --post-completion: class 4 key 7 -> buffered (no park yet: sticky)
INFO  core: --deliver-foreign: armed for class 4 key 7, naming task 9999 (never parked)
INFO  core: --deliver-foreign: injected class 4 key 7 for task 9999 straight onto the executor's queue — the ledger never matched it
ERROR thread: executor 1 refused to wake task 9999 (class 4 key 7): this store has no park for that id, so the delivery names a foreign or recycled task
INFO  thread: executor 1 left its session loop after 1 wake(s)
INFO  thread: executor 1 left the park seam having recorded 1 park(s) (first: task 0 on class 4 key 7)
Error: a completion was delivered to a task its store never parked: executor 1 refused to wake task 9999 (class 4 key 7): this store has no park for that id, so the delivery names a foreign or recycled task
```

The assertions, and which fired:

| # | assertion | result |
|---|---|---|
| 2 | exit **1** | `Some(1)` |
| 3 | `refused to wake task 9999` | present |
| 3 | `class 4 key 7` | present |
| 3 | `executor 1` | present |
| 4a | `a completion was delivered to a task its store never parked` | present, exactly once |
| 4b | strand sentence `a task was left parked when the session stopped` | **absent (0 occurrences)** |
| 5 | `inner: AFTER the await, value=0` and `worker: AFTER the await, value=0` | both present |
| 6 | `detached` | **absent (0)** |
| — | the instrument reports its own injection | present |

**The ordering, stated because it is what makes 4b reachable.** The legitimate completion is
claimed at the same seam by `claim_early`, which runs *before* the injection block, so it is
enqueued first. The loop takes both deliveries in arrival order: the legitimate one resumes
the task (and marks its park resolved), the foreign one is refused. Because the task
resolved, `record_strand` finds zero unresolved parks and emits nothing — so the run's error
is the delivery sentence **alone**. Had the order been reversed the loop would have refused
the foreign id first and then still resumed the task; 4b would hold either way, but the
assertion would no longer be able to distinguish "the task resumed" from "the task was never
asked to". This ordering lets it.

## C — the negative control

**What I broke:** in `service_wakes`, the guard's `None` branch was ignored, restoring the
pre-DL26 unconditional wake:

```rust
// MUTATION C: ignore `delivery_target`'s None — wake anyway, as the code did
// before DL26's guard. The delivery then resumes whatever `slots[id]` names.
let target = target.unwrap_or(0);
let Some(target) = Some(target) else { … };
```

Rebuilt release, ran the test.

**The failing assertion** — the test's own, not a crash elsewhere:

```
thread 'a_foreign_delivery_fails_the_run_by_name' panicked at tests/threads.rs:520:5:
assertion `left == right` failed: a foreign delivery must fail the run:
  left: Some(0)
 right: Some(1)
test result: FAILED. 0 passed; 1 failed; … finished in 0.32s
```

**And the mutation's behaviour is worse than "the test fails":** the same command run
directly exits **0** with **zero** refusals logged and **zero** delivery sentences —

```
$ (mutant) tension-core --executors 2 --post-completion 4,7 --deliver-foreign 4,7,9999 …
EXIT=0
main: wakes served=1
main: join=0
main: done
refusals logged: 0
delivery sentence: 0
```

So the guard's entire effect on this path is **converting total silence into a named
failure**. That is the I55 class precisely: not a wrong answer, an unasked question. `id
9999` is past the guest's slot table, so `__taskWake` skips it (`task-rt.ts:349`, `if (id < 0
|| id >= table.length) continue;`) and nothing anywhere records that a delivery arrived for a
task that does not exist.

Reverted: `cmp` against the pre-mutation backup is identical, `grep -c MUTATION` → **0**,
release rebuilt, and the full suite re-run green (8 passed).

## F — the control with the flag absent, versus `96a30ac`

```
$ tension-core --executors 2 --post-completion 4,7 wake-on-worker.wasm
EXIT=0
$ cmp dl28-base.out dl28-after.out
YES — byte-identical to the pre-change control
$ tension-core --executors 2 wake-on-worker.wasm
EXIT=1
```

Byte-identical stdout against the capture taken **before** the first edit, and the stranded
control still exits 1. The flag is inert when absent, and the "no post at all" path is
unchanged.

That comparison is also the **second half of the same test** — the control block after the
assertions above, not a test of its own (§H bug 2) — so it is asserted in CI on every push
rather than being a pasted log that would go stale.

## G — declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--test threads` | 7 → **8** | **8 passed** | as declared |
| CI `Wake path guard` filters | 2 → **3** | `3 passed; 5 filtered out` | as declared |
| `--bin` | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 / 11 | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability skips | unchanged |
| `--test fiber` | 6 | **6** | unchanged |
| `--test fiber-executor` | 7 | **7** | unchanged |
| bundle / std | unchanged | `aa74d6a1`, `cmp` exit 0 | unchanged |
| flag absent behaves as `96a30ac` | required | byte-identical stdout | ✓ |

**No delta beyond the declared one.** The one place I was tempted into a delta is recorded
in §H, and I folded the control into the existing test rather than adding a ninth.

### Files touched

| file | why |
|---|---|
| `tension-core/src/thread.rs` | `ForeignDelivery`, the pool's `foreign` slot, `arm_foreign_delivery`, `note_park_for_foreign_delivery`, the seam's injection |
| `tension-core/src/main.rs` | the option: kind, table entry, `USAGE`, `parse_foreign`, arm site, config field, the table test's value |
| `tension-core/src/host/config.rs`, `host/dev.rs`, `sandbox.rs` | the config field and its construction sites |
| `tension-core/tests/threads.rs` | `a_foreign_delivery_fails_the_run_by_name`, with the control as its second half |
| `.github/workflows/e2e-debug.yml` | the third filter |
| `docs/abi/guest.md` | regenerated — at commit time, from the final source (§H) |

## H — bugs I made, and what caught each

1. **A log line that named the wrong number.** My first injection report printed
   `task_id` from the **park** (the cooperative task's id), while the sentence around it said
   "never parked" about the **foreign** id. Two different numbers, one line, and the line
   exists precisely to disambiguate them. Caught by re-reading it while adding the arm
   function — before any run. Fixed by having `note_park_for_foreign_delivery` answer
   `Option<u64>` (the id it injected) instead of `bool`.
2. **I added two tests where one was declared.** The natural shape was a separate
   `without_the_foreign_injection_the_same_run_succeeds`, which made `--test threads` **9**
   against a declared 8. I folded it into the first test as its second half — DL21's idiom in
   this file — because the pair is one claim, and because a delta declared after the fact is
   exactly the kind of thing this project's gates exist to catch. Recorded here rather than
   silently absorbed.
3. **The same relative-path `cmp` slip, third time this arc.** `cmp … node_modules/…` run
   from the wrong directory reported "No such file", which reads as a missing package rather
   than a wrong cwd. Re-run with absolute paths: `cmp` exit 0. I have now made this mistake in
   DL27, DL26 and here; the fix is to always pass both paths absolute, and I should have
   applied it after the first time.
4. **The pre-commit hook caught a stale `docs/abi/guest.md` in the previous three rounds; this
   time I regenerated *after* the last source edit** and it passed first time. That is the
   lesson from DL27 applied rather than repeated.

## I — what I did not verify

- **A foreign delivery to an *in-range* id.** Task 9999 is past the guest's slot table, so
  `__taskWake` would have skipped it even under the mutation — the mutant's silence is
  therefore doubly silent. A delivery naming an id that is **live but not parked** (say task 0
  while it is running, or a recycled slot) would have exercised `__taskWake` resuming
  something real. I did not produce one: ``--deliver-foreign` names an id and the probe's
  guest is single-task, so "live but not parked" needs a guest with two tasks and a way to
  know which is which. **That is the sharper test, and it is not in this round.**
- **More than one executor.** The flag hardcodes `owner: 1`. A foreign delivery to a
  *different* executor than the one that parked is the more dangerous case (it would wake a
  task belonging to another store); not measured.
- **The refusal's interaction with a trap.** If the guest traps after the foreign delivery is
  queued, `main.rs` keeps the trap's own reason over the refusal (`Some(refusal) if
  guest_result.is_ok()`). Ordering of the two sentences in that case is inspected, not
  measured.
- **Repeat injections.** The instrument disarms after one; the `Vec`-of-refusals path
  (`take_refused_deliveries` answering two) is tested at the pool level in DL26 but not end
  to end.
- **Windows**, latency, fan-out, I57/I58/I64/I66, I60 — all excluded by the brief.
