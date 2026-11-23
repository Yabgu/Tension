# DL21 — the wake proof is a test, and a second waiter is silent

**Verdict for Part 2: (b).** One completion for the shared key resumes one waiter,
the other becomes a strand, the refusal fires, exit **1**. Nothing vanishes silently
— in *this* ordering. §2 shows why that is an accident and not a guard, and names
the line that would make it (c).

`~/work/Tension` `integration/dwarf-debug`, pushed: `4ecfd46` → **`f2c8e8d`**.
`~/work/TensionScript-a2` untouched at **`3f59ec08`**, clean, bundle **`aa74d6a1`**.

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`4ecfd46`**, `git status --porcelain` empty, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `sha256sum dist/assemblyscript.js` → **`aa74d6a1`** (installed copy too) |
| binary | `33 628 976` bytes, mtime **2026-11-23 12:25:47** |
| newest source | `src/thread.rs` **2026-11-23 03:02:41** |
| sources newer than the binary | **0** |

The preflight's `stale:2026-11-23:thread.rs` was correct and is now clear: the
binary is 9h22m newer than the newest source.

## 1. Part 1 — the wake proof became a guard (I51)

**Test:** `a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake` in
`tension-core/tests/threads.rs`. **CI command** (`.github/workflows/e2e-debug.yml`,
step `Wake path guard`):

```sh
cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
  --test threads -- a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake
```

CI ran it on `f2c8e8d` (run **`45167921753`**): `1 passed; … 5 filtered out;
finished in 0.86s`.

### The four assertions, and how each is made non-vacuous

1. **Buffered before any park, then claimed.** Not "the string appears twice" but
   `at(stderr, "buffered (no park yet: sticky)") < at(stderr, "claimed a completion
   that had already arrived")` — the *order* in the log is the sticky half's only
   evidence, so it is compared as a position and not asserted as presence.
2. **Both `AFTER` lines**, i.e. the continuation ran: `inner: AFTER the await,
   value=0` and `worker: AFTER the await, value=0`.
3. **`main: wakes served=1`**, `join=0`, **exit 0**.
4. **No refusal and no `detached`** anywhere in the log.

`run_with` sets `TENSION_LOG_LEVEL=debug` because the claim line is Debug; it also
cannot reuse `run()`'s skip branch, which skips every thread guest on a target
without stack switching — this guest is built **without** stack switching on
purpose, so that branch would skip the guard on exactly the engine it targets.

### The runs, pasted

**With `--post-completion 4,7` — exit 0:**

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

```
INFO  core: --post-completion: class 4 key 7 -> buffered (no park yet: sticky)
DEBUG thread: executor 1: park on class 4 key 7 claimed a completion that had already arrived (sticky wake)
DEBUG thread: executor 1: woke task 0 for class 4 (1 this session)
INFO  thread: executor 1 left its session loop after 1 wake(s)
INFO  thread: executor 1 left the park seam having recorded 1 park(s) (first: task 0 on class 4 key 7)
```

**Negative control, the same guest without the flag — exit 1:**

```
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
main: wakes served=0
main: join=0
main: done
```

```
INFO  thread: executor 1 left the park seam having recorded 1 park(s) (first: task 0 on class 4 key 7)
Error: a task was left parked when the session stopped: executor 1 left 1 task(s) parked and never resumed (first: task 0 on class 4 key 7). …
```

Neither `AFTER` line appears, the exit is non-zero, and the refusal names
`executor 1`.

### Both halves proven able to fail (measured, then reverted)

- **Positive half:** with the fixture swapped for `strand-nested.wasm` (a guest that
  never resumes) and the compiler moved aside, the test **FAILED** at
  `tests/threads.rs:287` — the claim assertion, i.e. the sticky evidence, not a
  late line.
- **Negative half:** with the control run given `--post-completion 4,7`, the test
  **FAILED** at `tests/threads.rs:331` — *"without `--post-completion` nothing
  completes the pair, so `inner: AFTER the await` must not be printed"*. So the
  control bites: a wake path that resumed everything unconditionally would be
  caught.
- **The CI path:** with `node_modules/@yabgu_gm/tensionscript` moved aside (the CI
  shape), the test passes in **0.82 s** from the committed fixture.

### Where the guest and the fixture live, and why

The guest moved to `tension-core/tests/programs/thread/wake-on-worker.ts` so the
flag table, the builder and `guest()` all find it by name. `WAKE_FLAGS` is
`THREAD_FLAGS` **minus `--enable stack-switching`** — with the folder default it
would measure the stackful shell under the same test name.

The artifact is committed at `tests/programs/fixtures/thread/wake-on-worker.wasm`
(29 315 B, `23ed47bfe51733ac…`) with the recipe beside it, because **the CI job has
no compiler** (I19). `guest_thread_fixture` builds from source when a checkout has
a compiler and takes the fixture when it does not — deliberately the reverse of
`guest_debug`, where the fixture *is* the artifact under test.

## 2. Part 2 — two waiters on one key (I52)

**Guest:** `tools/thread-promise/programs/two-waiters.ts` (committed, unchanged
semantics). Two tasks on one worker both await `class 4 key 7`; each prints
`waiter N: BEFORE the await` and `waiter N: AFTER the await`.

The shape is two **tasks**, not two awaits in one task, because a worker's entry
task cannot park (DL11 shape 1): each waiter is a nested `async` function called
and **not** awaited, so it runs to its `await`, parks, and hands back a suspended
handle.

### Run 1 — no `--post-completion`. Exit **1**

```
main: spawning
main: index=0
main: spawn=0
worker: starting two waiters on class 4 key 7
waiter 1: BEFORE the await
waiter 2: BEFORE the await
worker: both waiters started
main: wakes served=0
main: join=0
main: done
```

```
INFO  core: async backend: continuations (wasmtime stack switching)
INFO  core: res: writing under /home/acakar/work/Tension
INFO  thread: executor 1 left its session loop after 0 wake(s)
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
Error: a task was left parked when the session stopped: executor 1 left 1 task(s) parked and never resumed (first: task 1 on class 4 key 7). A session pool now resumes parked tasks (docs/threads.md), so this means either nothing completed that `(class, key)` before shutdown, or the guest exports no `__taskWake` for its executor to call (the scheduler contract §2.2 confines the wake to the store's owner thread, so only the owning store can resume its own task).
```

### Run 2 — `--post-completion 4,7`. Exit **1**

```
INFO  core: --post-completion: class 4 key 7 -> buffered (no park yet: sticky)
main: spawning
main: index=0
main: spawn=0
worker: starting two waiters on class 4 key 7
waiter 1: BEFORE the await
waiter 2: BEFORE the await
worker: both waiters started
waiter 1: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
```

```
INFO  thread: executor 1 left its session loop after 1 wake(s)
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
Error: a task was left parked when the session stopped: executor 1 left 1 task(s) parked and never resumed (first: task 1 on class 4 key 7). …
```

### The verdict, and the number to keep

**(b)** — one resumed, one stranded, the refusal fired, exit 1. Not (c): nothing
was lost silently **in this run**.

**The measurement that matters is `2 → 1`.** Both runs record **two** parks at the
seam and report **one** in the refusal. That is not a counting bug in the refusal;
it is the ledger's shape. `record_strand` counts a park only while its task id is
still in `parked_task_ids()`, and `ParkedTable` holds **one entry per key**, so the
displaced waiter is unrepresentable, not merely miscounted.

### Why (b) and not (c) — stated exactly, with the line that decides it

It is an ordering accident, not a guard. The host's completion sits in the sticky
buffer before any park exists, so the **first** park claims it at the seam
(`claim_early`) and resumes — that is why `waiter 1` (task 0) is the line that
appears. Had the completion arrived *after* both parks, `ParkLedger::take` would
have answered with the second waiter (the entry the ledger still holds), resumed
it, and left the **first** parked with its entry already overwritten — so
`parked_task_ids()` would no longer contain it, `is_strand` would filter it out,
`unresolved` would be **0**, and the run would **exit 0 with a task stranded**.
That is (c).

The line that makes it reachable: `ParkLedger::record` does

```rust
table.insert(key, entry);
```

and drops the `Option<ParkedTask>` that `insert` deliberately returns — the entry it
displaced. There is nowhere to put it today, which is the fan-out decision.

**No semantics changed.** Refusing the second park, queueing it, or broadcasting is
a contract choice the brief reserves for the user, so this round stops here.

## 3. Declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--bin` count | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 pass / 11 no-source | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** `feature not enabled` and **0** capability-reason skips | unchanged (see note) |
| thread suite | +1 case | **6 passed** (was 5) | +1 exactly |
| compiler / std | no change | `3f59ec08` clean, std byte-identical | unchanged |
| bundle | `aa74d6a1` | **`aa74d6a1`** | unchanged |

**Note on `test:compiler`.** `npm run test:compiler -- --parallel` reports 99
`SKIPPED` *sub-results*: 2 `instantiate debug`, 60 `instantiate release`, 2
`rtrace`, plus comparison steps. None is a capability skip — the two lines DL15
introduced (`not listed in ASC_FEATURES`, `this runtime cannot run it`) occur **0**
times, and `feature not enabled` occurs **0** times. So the metric DL15 declared is
0 and unchanged; the raw `SKIPPED` count is large by the harness's own per-case
opt-outs (`skipInstantiate` and release-only shapes) and would have been the same
before this round, which changed no compiler file (`git status` empty at
`3f59ec08`).

### Files touched beyond the brief's named list

| file | why |
|---|---|
| `.github/workflows/e2e-debug.yml` | **CI did not run `--test threads` at all** — the only job ran `e2e_debug` and `debugger`. Wiring the test into that suite would have guarded nothing, so the step is new. |
| `.gitignore` | the fixture was silently ignored by a blanket `*.wasm`; see §4. |
| `scripts/build-test-programs.mjs` | `WAKE_FLAGS` + the `PROGRAMS` entry, without which the guest cannot be built by name. |
| `tension-core/tests/support/programs.rs` | `thread_fixtures_dir` + `guest_thread_fixture` (the resolution order). |
| `tension-core/tests/programs/thread/wake-on-worker.ts` | moved here from `tools/thread-promise/programs/` (content unchanged) so the suite finds it. |
| `tension-core/tests/programs/fixtures/thread/{wake-on-worker.wasm,README.md}` | the committed artifact + recipe. |
| `tools/thread-promise/programs/README.md`, `DL20B-REPORT.md` | the moved path, the new hash, the two-waiter section, a path note on the merged report. |

## 4. Bugs I made, and what caught each

1. **The fixture did not travel.** `git add -A` staged its README and skipped the
   `.wasm`, because the repository ignores `*.wasm` wholesale and whitelists each
   fixture by path — `fixtures/debug/` has such a line, my new directory did not.
   `git status` looked right, the local run passed (the file was on disk), and
   **CI's first run failed on the new step by name**. Caught by CI, which is the
   only place a clean checkout exists.
2. **The fixture was built before its source's last edit.** I copied the artifact,
   then corrected the guest's header comment, then committed — so the recipe did
   not reproduce the bytes. Caught while checking my own README's hash claim.
   Measured cause: same path, same flags, same bundle, source differing **only in
   comments** (`diff` with comment lines stripped shows identical code), deterministic
   compiler (two builds of one source, identical) — and **four bytes** of the module
   differ, two pairs of `i32.const` immediates each off by 8. Mechanism not
   established; the rule it produces is, and it is now written next to the fixture:
   regenerate after any edit, comments included.
3. **A shell slip**: `cd X && setsid … &` backgrounds the whole list, so the outer
   shell never changed directory and `stat` failed. Visible immediately; no impact.
4. **Corrected in passing, not a bug I introduced**: the guest's header listed
   `main: worker finished, stopping`, which it has never printed. A program's own
   header is the first thing a reader trusts.

## 5. Commits, and CI

| SHA | what |
|---|---|
| `a5af218` | `test(threads): the wake proof becomes a guard, and CI finally runs it (I51)` — test, CI step, fixture resolution, guest move, build flags, docs |
| `8b8ccd3` | `probe(thread): two waiters on one key — the ledger holds one, and says one (I52)` |
| `7349377` | `build(ci): the wake fixture travels — .gitignore said *.wasm (I51)` |
| `f2c8e8d` | `test(threads): regenerate the wake fixture from the committed source` |

CI runs on `integration/dwarf-debug`:

| run | SHA | result |
|---|---|---|
| `45166596544` | `8b8ccd3` | **failure** — `Wake path guard`: fixture not committed (bug 1) |
| `45167175603` | `7349377` | **success** |
| `45167921753` | `f2c8e8d` | **success** — `Wake path guard`: `1 passed … 0.86s` |

**A departure to declare:** I pushed straight to `integration/dwarf-debug` rather
than opening a PR from a feature branch, which is how #83 and #84 landed. The brief
said "branches only; `main` is production", and that branch is not `main` — but the
convention differs and the red first run is on the integration branch's history
because of it.

## 6. What I did not verify

- **Whether (c) happens.** I did not produce it, because the host's only way to post
  a completion is a startup flag, and the sticky buffer is therefore always claimed
  by the first park. The claim in §2 that (c) is one ordering away is a reading of
  `ParkLedger::record` + `record_strand`, not a measured run. Producing it needs a
  guest-side post (an epoch pump on main) or a delayed post — both out of scope.
- **A stale fixture is not detected by any test.** The resolution order builds from
  source only where a compiler exists; CI compares nothing against the `.ts`. Bug 2
  was found by hand. The recipe and the hash are the mitigation, not a guard.
- **`test:compiler`'s 99 `SKIPPED` sub-results** were not compared against a
  pre-round baseline run; I established only that no *capability* skip is among
  them and that no compiler file changed.
- **Two workers on one key** (the ledger is pool-wide, so this is the same defect
  across stores) — not measured; only the one-worker shape the brief named.
- **Windows**, as the brief says; and the DL11 stackful hang, I45, I36, I47, I50.
- The suite's four pre-existing `never used` warnings in `tests/threads.rs` are
  unchanged in kind and number; I did not clean them up (out of scope).
