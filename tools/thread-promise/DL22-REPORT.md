# DL22 — the owner's own park record is the truth (I53)

**Part 1 reproduced the defect exactly as predicted: exit 0 with a task abandoned.**

`~/work/Tension` `integration/dwarf-debug`, pushed: `24b6c07` → **`3fe99b6`**.
`~/work/TensionScript-a2` untouched at **`3f59ec08`**, clean, bundle **`aa74d6a1`**,
`std` byte-identical. **No compiler change, no std change.**

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`24b6c07`**, `git status --porcelain` empty, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `std/assembly/thread.ts` | identical to the installed package |
| binary (final) | `33 643 504` bytes, mtime **2026-11-23 14:11:11** |
| newest source | `src/thread.rs` **2026-11-23 14:07:07** |
| sources newer than the binary | **0** |

The binary was rebuilt twice: at 14:04 for the Part 2 measurement, and again at
14:11 after §7's bug 4 (a mutation revert moved `thread.rs`'s mtime past the
binary). The final numbers in §4 were re-taken on the 14:11 build.

The brief's `I53` was verified before it was acted on:

```
$ grep -rn "resolved" tension-core/src | grep -v unresolved
thread.rs:1071    resolved: false      ← the only write to a WorkerPark
$ grep -rn "park.resolved" tension-core/src   → (no output)
```

## 1. Part 1 — the defect, measured on the unmodified engine

Engine state for this run: the tree at `24b6c07` **plus the test flag only** — a park
watch that counts and posts, and no change to `park`, `service_wakes`, the ledger or
the strand predicate. Binary built 13:03.

Guest: `two-waiters-late.ts`, two tasks parked on one worker on `(4, 7)`, the
completion posted **after both parks**:

```
tension-core --executors 2 --post-completion-after-parks 4,7,2 <artifact>
```

Verbatim, **exit 0**:

```
INFO  core: async backend: continuations (wasmtime stack switching)
INFO  core: res: writing under /home/acakar/work/Tension
INFO  core: --post-completion-after-parks: armed for class 4 key 7 after 2 park(s)
main: spawning
main: index=0
main: spawn=0
worker: starting two waiters on class 4 key 7
waiter 1: BEFORE the await
waiter 2: BEFORE the await
INFO  core: --post-completion-after-parks: class 4 key 7 -> matched a park on executor 1
worker: both waiters started
waiter 2: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
INFO  thread: executor 1 left its session loop after 1 wake(s)
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
EXIT=0
```

Read it as the defect: **two parks recorded**, one wake served, `waiter 2` resumed,
`waiter 1` never printed its `AFTER` line — and **no refusal, exit 0**. The process
reported success over an abandoned task.

And the same engine, same guest, the *sticky* ordering (`--post-completion 4,7`), to
establish the baseline the round must not disturb — **exit 1**:

```
waiter 1: AFTER the await, value=0
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
Error: … executor 1 left 1 task(s) parked and never resumed (first: task 1 on class 4 key 7) …
```

The first park claims the buffered completion, the later park is the one left in the
ledger, so the ledger's answer happened to be right. The late ordering is where the
same bookkeeping is wrong, which is why the flag exists.

### The flag

`--post-completion-after-parks <CLASS>,<KEY>,<COUNT>`, in `HOST_OPTIONS` **and**
`USAGE` (the gate, and DL20B's bug 3). It does not post from `main`: the **park
seam** posts, on the park that brings the count to `COUNT`, because that is the only
place "N parks have landed" is knowable — the ledger holds one entry per key and
therefore cannot count them. The count is a bare `u32` beside the armed watch, not a
stored entry: nothing about parks, waking or the ledger changes.

`--post-completion` is byte-identical. A `COUNT` of 0 is refused at parse time,
because it would mean "post before any park", which is the other flag's job and
would silently be a duplicate under a different name.

## 2. Part 2 — the owner answers for its own parks

**P1.** `service_wakes` marks the store-local park for the task it just woke as
resolved, immediately after `__taskWake` returns:

```rust
wake.call(&mut *store, (scratch as i32, 1))?;
// **P1 (DL22): the owner answers for its own park, at the moment it resumes it.**
if let Some(park) = store
    .data()
    .parks
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .iter_mut()
    .find(|park| park.task_id == delivery.task_id)
{
    park.resolved = true;
}
```

It is the store's own record, written on the store's own thread, in the `Mutex`
`WorkerState` already carries — no lock ordering changes, no cross-thread write. A
wake for an id this store never parked marks nothing, which is the honest answer:
there is no record of it.

**P2.** The refusal reads that record and nothing else. The new predicate, verbatim:

```rust
let is_strand = |park: &WorkerPark| !park.resolved;
```

Unconditional and per park: the same statement for one waiter or eight, and it
survives any fan-out policy — a policy that resumes two tasks of one key marks two
entries resolved and this line needs no change. The count is now "parks this store
left unresolved".

**P3.** `parked_task_ids()` is **deleted**. Its only caller was `record_strand`; after
P2 nothing called it, and a helper that no longer decides anything is the same class
of thing DL21 found in `resolved` itself.

`ParkedTable` keeps its one-entry-per-key shape, and `record` still discards what
`insert` displaces. Holding N is the fan-out decision; what changed is that the
*naming* of a lost task no longer depends on it.

**Comments that had become false, and were changed** (five sites, all quoted in the
commit): `take`'s *"nothing calls it in this round, which is why
`WorkerPark::resolved` is still written `false`"*; the construction site's *"Nobody
here can resume it"*; `WorkerPark::resolved`'s *"Always `false` today"*;
`WorkerState`'s *"its emptiness is a measurement"*; and `main.rs`'s *"Today nothing on
a worker can resume one"*. DL21's finding was a field nothing read; its mirror is a
sentence that reads well and describes a world that no longer exists.

## 3. Part 3 — the guard

**Test:** `a_second_waiter_is_refused_when_the_completion_arrives_after_both_parks`,
in `tension-core/tests/threads.rs`. **CI command** (`.github/workflows/e2e-debug.yml`,
step `Wake path guard` — the same step DL21 added, now with two filters; `libtest` ORs
them, verified: `running 2 tests … 5 filtered out`):

```sh
cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
  --test threads -- \
    a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake \
    a_second_waiter_is_refused_when_the_completion_arrives_after_both_parks
```

CI on `3fe99b6` (run **`45181590736`**, **success**): `running 2 tests`, both ok,
1.05 s, on the fixture path (that job installs no compiler).

### The two runs, pasted

**Fixed engine, late post — exit 1, count exactly 1:**

```
main: spawning / main: index=0 / main: spawn=0
worker: starting two waiters on class 4 key 7
waiter 1: BEFORE the await
waiter 2: BEFORE the await
worker: both waiters started
waiter 2: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
Error: a task was left parked when the session stopped: executor 1 left 1 task(s) parked and never resumed (first: task 0 on class 4 key 7). …
```

**Mirror, sticky — exit 1, count exactly 1, the *other* waiter resumes:**

```
waiter 1: BEFORE the await
waiter 2: BEFORE the await
worker: both waiters started
waiter 1: AFTER the await, value=0
main: wakes served=1 / main: join=0 / main: done
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
Error: … executor 1 left 1 task(s) parked and never resumed (first: task 1 on class 4 key 7). …
```

That mirror is the round not moving wake semantics: the same park is woken in both
runs (whichever one the post reaches), and only the *count* gained a truthful
answer.

### Both halves proven able to fail, by mutating the engine

| # | what I changed | what failed | which half |
|---|---|---|---|
| A | `let is_strand = \|_park\| false;` — model DL22's defect (nothing is ever a strand, so the count is 0) | `tests/threads.rs:411`: *"an abandoned task must fail the run, not exit 0"* | the late/fix half |
| B | `claim_early` returns `false` at entry — the sticky buffer is never claimed | `tests/threads.rs:461`: *"the sticky count must stay 1"* (it became 2, because nothing was claimed and nothing was resumed) | the mirror half |
| C | P1's `park.resolved = true` replaced with `let _ = park;` — the wake does not mark resolution | `tests/threads.rs:418`: *"the count must be exactly 1 — 0 is DL22's defect, 2 means the wake did not mark resolution"* | pins the number between the two wrong values |

Each was reverted (`cmp` against the pre-mutation backup, `git diff | grep -c
MUTATION` → 0) and the suite re-run green after each.

**One test was extended but nothing weakened:** the shared runner gained
`run_guest(name, extra)` so this test can run one fixture twice; `run_with(extra)` now
delegates to it in one line, and **DL21's test body is untouched** — it passes
unmodified, which is its own gate item.

## 4. Declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--bin` count | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 pass / 11 no-source | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability-reason skips | unchanged |
| thread suite | **7** (6 + 1) | **7 passed** | +1 exactly |
| DL21's guard | passes unmodified | passes unmodified | ✓ |
| compiler / std | no change | `3f59ec08` clean, `std` identical | ✓ |
| bundle | `aa74d6a1` | `aa74d6a1` | ✓ |
| new flag in USAGE + HOST_OPTIONS | required | both, and the table test covers it | ✓ |

Also re-measured on the final binary, unchanged: `plain-worker` → `before=0
workIndex=0 spawn=0 join=0 counter=10`, exit 0 · `strand-nested` → exit 1 ·
`async_main_promise` → 2 passed.

### Files touched that the brief did not name

| file | why |
|---|---|
| `.github/workflows/e2e-debug.yml` | the second test filter — without it the new guard would exist and never run |
| `scripts/build-test-programs.mjs` | the `PROGRAMS` entry, or the guest cannot be built by name |
| `tension-core/tests/threads.rs` | the test, plus the runner generalisation |
| `tension-core/tests/programs/fixtures/thread/{two-waiters-late.wasm,README.md}` | the committed artifact for the no-compiler CI job (the `.gitignore` negation DL21 added already covers this directory — checked with `git check-ignore`, and the file is in the commit) |
| `tools/thread-promise/programs/README.md` | the new guest, the new flag, and which ordering each run is |
| `docs/abi/guest.md` | 14 rows, **line numbers only** — `thread.rs` grew above the registrations |

**The guest moved.** The brief named
`tools/thread-promise/programs/two-waiters-late.ts`; it is at
`tension-core/tests/programs/thread/two-waiters-late.ts`, because the flag table,
`guest()` and the fixture directory all live in the test tree — the same move DL21
made for `wake-on-worker`, and for the same reason. `two-waiters.ts` (DL21's
measurement, not a guard) stays where it is.

## 5. Commits and CI

| SHA | what |
|---|---|
| `3fe99b6` | `thread: the owner's own park record answers for its parks (I53)` — P1–P3, the flag, the guest, the test, CI, docs |
| *this report* | `docs: DL22 — …` |

CI: run **`45181590736`** on `3fe99b6`, **success** (`E2E debug`: `running 2 tests`,
both passed, 1.05 s).

## 6. Bugs I made, and what caught each

1. **`git mv` on a file I had created but never added** — `fatal: not under version
   control`. Caught by the command failing; used `mv`. No effect, but it is the same
   class as DL21's "the fixture was on disk but not in the repository".
2. **I built `strand-nested` with the wrong flags** (`--enable stack-switching`
   added) and got `AS100: the stackful backend requires an exported main`. Before
   that, I ran it against a `/tmp` artifact that no longer existed and read the
   usage text as a behaviour change — I diagnosed the missing file second, not first.
   Both were my errors in constructing a control, not engine changes.
3. **`cd X && setsid … &` backgrounded the whole list again** (third time in the
   arc), so the outer shell never changed directory and three `git` calls failed with
   "not a git repository". Visible in one line; re-run in the right directory.
4. **The one that mattered: a mutation revert made the binary look stale.** Restoring
   `src/thread.rs` with `cp` preserved its *content* but set its *mtime* to the revert
   (14:07) — after the 14:04 build. My own freshness check reported `sources newer:
   1`, which is exactly the trap the brief warns about; I rebuilt (14:11, 0 newer)
   and re-took every number in §4 on that binary. Worth recording because the
   content was correct and only the timestamp was wrong — a careless round would have
   reported the numbers anyway.

## 7. What I did not verify

- **A count of 2 or more waiters on one key beyond the second.** The predicate is
  per park, so three waiters should give 2 unresolved, but the fixture has two and I
  measured two. Nothing here depends on the specific number.
- **Two workers parking on one key.** The ledger is pool-wide; the count is now
  per-store, so each store's refusal should name its own parks. Not measured — the
  brief's shape is one worker, and a second store would be a fan-out-adjacent
  question.
- **Whether the fix reaches a guest-side detector.** It does not change what the
  program can observe: `waiter 1`'s task is still stranded, still never resumed, and
  the guest still cannot tell. The process became honest; the program did not. That
  is the same limit DL12B stated and it has not moved.
- **`docs/threads.md`**: the new flag is a test instrument and is documented in
  `USAGE` and in the programs' README, not in the contract document. I did not add it
  there; if the flag is meant to be permanent public surface rather than a test
  instrument, that is a doc decision I did not take.
- **Windows** (the brief excludes it), I50, I31, I47, I45, I36, and latency.
- The pre-existing `SKIPPED` sub-results in `test:compiler` (99 of them, all per-case
  opt-outs) were not compared against a baseline again; as in DL21 I established only
  that no capability-reason skip occurs.
