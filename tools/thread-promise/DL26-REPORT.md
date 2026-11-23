# DL26 — guards, re-park, delivery validation

**Two things in the brief's premises were wrong, and both corrections are findings.** The
probe's re-park test cannot reach the engine's find-first lookup — but that lookup was a
**live defect**, and it is fixed here. And a second post for one key never reaches
`__taskWake` at all: it is absorbed by the sticky buffer and **silently discarded**, which
this round measures but deliberately does not change.

`~/work/Tension` `integration/dwarf-debug`: `e20740d` → **`3adcd4b`**. Commits `fff4708`
(A+B+C) and `3adcd4b` (the test's remaining halves). CI run **`45222175321`**, **success**.
`~/work/TensionScript-a2` untouched at **`3f59ec08`**, bundle **`aa74d6a1`**, `std`
identical.

## 0. Phase 0

```
$ git checkout -- package-lock.json          → exit 0
$ git status --porcelain
                                             ← empty
$ grep -A1 '"resolved": "file:.packs/yabgu_gm-tensionscript-0.14.1' package-lock.json
  "resolved": "file:.packs/yabgu_gm-tensionscript-0.14.1-g41b8721bc4f0.tar",
  "integrity": "sha512-Bvuxb7m1rXZDzjQfvJz/irIdAPaG0mdkyLLhaVKt1CvoaAlKURKiFbXeSBbQEGbMD0JH2RNym5UAAs90cdOhBg==",
```

The checksum is back and the tree is empty before any other command ran. **No `npm install`
was run in `~/work/Tension` this round** — the guest builds and the census go through
`TENSIONSCRIPT=~/work/TensionScript-a2/bin/tensionscript.js`, which the conformance runner
and `build-test-programs.mjs` both accept, so nothing had a reason to touch the lock. It was
still clean at the end (`git status --porcelain` empty before both commits).

| fact | measured |
|---|---|
| `Tension` at Phase 0 | `integration/dwarf-debug` @ **`e20740d`**, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `std/assembly/thread.ts` | identical (`cmp` exit 0) |
| binary **before** the round | `33 643 504` B, mtime **2026-11-23 14:11:11** |
| newest source **before** | `src/thread.rs` **2026-11-23 14:07:07** — 0 newer |
| binary **after** this round's changes | `33 645 768` B, mtime **2026-11-23 17:46:22** |
| newest source **after** | `src/thread.rs` **2026-11-23 17:45:20** — 0 newer |

The rebuild after the `src` edits was necessary, not optional: my mutation reverts were
written with `cp`, which resets mtime past the binary — the DL22 trap. Rebuilt at 17:46:22
and every number in §5 was taken on that binary.

## A — the stackful proofs run in CI (I61)

The step, quoted from `.github/workflows/e2e-debug.yml`:

```yaml
      - name: Stackful proofs
        run: |
          cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
            --test fiber --test fiber-executor
```

Its comment records why it needs no install: both guests are inline WAT compiled by
wasmtime's own `wat` support at run time, so this step takes no skip path and runs **every**
test in both targets rather than a filtered subset (unlike `Wake path guard`, whose filters
exist because the other `--test threads` cases need a compiler).

**CI: run `45222175321`, conclusion `success`.** The step's own output:

```
     Running tests/fiber.rs (.../fiber-432c870dc89996fd)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
     Running tests/fiber-executor.rs (.../fiber_executor-9f9296587007c3a2)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

**12 tests, not the declared 11** — see §6. The runner needed nothing special: no thread
budget, no stack size, no kernel feature. Fibers are userspace stack switches on x86_64 and
the probes ask for 512 KiB.

## B — re-park is tested (I62)

`b_repark_one_task_parks_twice_and_both_wakes_resume_it`. The guest parks twice, is woken
twice, and returns 42. Verbatim:

```
guest (task 1): BEFORE the park
guest (task 1): inside __park(4, 7)
executor 1: parked class=4 key=7 (task 1)
guest (task 1): __park returned — resumed
guest (task 1): AFTER 1 keep=42
guest (task 1): inside __park(5, 1007)
executor 1: task 1 parked again class=5 key=1007
guest (task 1): __park returned — resumed
guest (task 1): AFTER 2 keep=42
executor 1: task 1 resumed and finished
```

`Done(42)`, no `STRANDED`, both `AFTER` lines in order, and `keep=42` on both sides of both
suspensions — the local was set once, before either park.

The wakes are **staged**, not simultaneous: the second park does not exist until the first
wake resumes the task, so the gate is waited on twice with the first wake posted in between.
No sleeps, and 10 consecutive runs were green.

### The hypothesis: find-first was **not reached** — and it was a real defect

The test passes, and the reason it cannot fail on find-first is structural:

1. **The probe defines its own `__park`.** `tests/fiber-executor.rs:463` registers
   `linker.func_wrap("env", "__park", …)`; that import is what the WAT guest calls. The
   probe never executes `service_wakes`, and `grep -c "service_wakes\|WorkerPark"` on the
   file is **0**.
2. **The probe keeps no `Vec`.** Its loop holds one `parked: Park` in a local and
   overwrites it (`parked = next;`). There is no list to search, so there is no find-first
   to be wrong.

So the probe test exercises the probe's `Err(next)` branch — which was genuinely untested —
and proves nothing about the engine. **Writing it and calling Part B closed would have been
the vacuous-gate class this round exists to close**, so the engine question was settled
separately.

**The defect is real.** Every link verified in source this round:

- a task's `task_id` is its **slot index**, and it is the same for every park that task
  makes — `std/assembly/task-rt.ts`, `parkState`:
  `const id = state.slot; … hostPark(<i64>id, awaited.class_, awaited.key);`
  with the doc *"`scheduler::park(task_id, class, key)` — one call per suspension (§2.1)"*;
- the seam pushes a record per park and nothing prunes the vec —
  `src/thread.rs:1162` `parks.push(park);`, and `grep` for `retain`/`clear`/`remove` on that
  vec finds nothing;
- the marking was find-first —
  `.iter_mut().find(|park| park.task_id == delivery.task_id)` — with no `!resolved`.

A task that awaited twice therefore leaves **two records with one id**, the first already
resolved; find-first marks the resolved one again, the live park stays unresolved, and
`record_strand`'s `!park.resolved` reports a strand — **exit 1 on a program that resumed
correctly.**

**It is fixed here, and the fix was not requested.** Part C's lookup has to pick a record, and
picking find-first would have preserved a known false refusal; `delivery_target` prefers the
unresolved record. Declared in §6 as the round's one unrequested change.

**It is not gated by a test that would have caught it in the engine** — the gate is on the
decision function (`c_delivery_target_…`), which is the part that was wrong. The integration
(the guard firing on a live worker) is not exercised; see §C.

## C — delivery validation (I55)

### What the guard does

`service_wakes`, **before** the wake call:

```rust
let target = { parks.lock(); delivery_target(&parks, delivery.task_id) };
let Some(target) = target else {
    pool.note_refused_delivery(RefusedDelivery { executor: id, task_id: …, class: …, key: … });
    continue;   // not woken, not marked
};
wake.call(&mut *store, (scratch as i32, 1))?;
// …then mark parks[target].resolved = true
```

`Delivery` gained a `key` field solely so the refusal can name the pair; the wake itself
still needs only the task id.

### The refusal's message, and its test

```
executor 1 refused to wake task 99 (class 4 key 7): this store has no park for that id, so
the delivery names a foreign or recycled task
```

It is emitted at `ERROR` through `note_refused_delivery` (the test above shows the real log
line), recorded on the pool, and turned into the run's failure on main by the widened
`strand_refusal` — the strand path's exit-1 shape, with **its own sentence**:

> a completion was delivered to a task its store never parked: …

so a reader is never told "something was left parked" when the actual fault was a bad
delivery.

**Test:** `c_delivery_target_prefers_the_unresolved_record_and_refuses_an_unknown_id`
asserts the decision (`unknown id 99 -> None`, `[resolved, unresolved] -> Some(1)`), the
message (all four facts present), and the pool bookkeeping (`note_refused_delivery` then
`take_refused_deliveries` answers once, then empty — taken, not read).

Verbatim from that test:

```
--- C: refusal message ---
executor 1 refused to wake task 99 (class 4 key 7): this store has no park for that id, so the delivery names a foreign or recycled task
--- C: delivery_target, all cases ---
two = [resolved(7), unresolved(7)] -> Some(1)
all_resolved(7)                     -> Some(0)
unknown id 99                       -> None
empty                               -> None
```

**The gap, stated rather than papered over:** the *wiring* is not asserted. Producing a real
foreign delivery needs a store to receive one, and nothing outside the crate can hand a store
a delivery — `pool.parks` is private, and `service_wakes` runs on a worker's own thread. It
would need either a `--bin` test (moving the count the brief pins at 307) or a hand-written
WAT worker exporting `__taskWake` plus the two control globals, which is a fixture-sized job.
So: decision tested, message tested, bookkeeping tested, wiring **inspected and not
measured**.

### The already-resolved case — measured, and it does not behave as the brief assumed

The brief expected a second post to reach `__taskWake`, which would see `slot.state == null`
and continue (`task-rt.ts:349`). **It never gets that far.** A double post for one key is
reachable with the existing flags — `--post-completion` posts at startup, and
`--post-completion-after-parks 4,7,1` posts again after the first park:

```
$ tension-core --executors 2 --post-completion 4,7 --post-completion-after-parks 4,7,1 \
    tension-core/tests/programs/fixtures/thread/wake-on-worker.wasm

INFO  core: --post-completion: class 4 key 7 -> buffered (no park yet: sticky)
INFO  core: --post-completion-after-parks: armed for class 4 key 7 after 1 park(s)
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
INFO  core: --post-completion-after-parks: class 4 key 7 -> buffered (no park yet: sticky)
inner: AFTER the await, value=0
worker: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
INFO  thread: executor 1 left its session loop after 1 wake(s)
INFO  thread: executor 1 left the park seam having recorded 1 park(s) (first: task 0 on class 4 key 7)
EXIT=0
```

**The second post is buffered, not delivered** — by the time it fires the ledger entry has
already been `take`n by the first delivery, so `Pool::deliver` finds no waiter and parks it
in the sticky buffer, where it is **dropped at shutdown with no message**. Exit 0, nothing
logged beyond the lines above. So:

- does the process exit 0? **yes**;
- is anything logged? **only the "buffered" Info line** — nothing says the completion was
  discarded;
- does `__taskWake` see `state == null`? **no: it is never called for that post.**

**No change was made to this case**, as instructed. It is recorded as the shape I55 has left
over: an unclaimed completion is silently discarded, which is the mirror of a delivery that
names nothing. A future round that wants "every post is accounted for" would need a
shutdown check on the `early` buffer.

### Who posts twice for one key

**No guest or fixture does.** A search of `tests/programs/**/*.ts` for producers finds none;
the `deliver` hits are guest *functions* named `deliver` in `spawn-join.ts` and
`two-workers.ts`, not posts.

And the case the brief cites is not a same-key double post. `scheduler.rs:143-149`:

> **One entry per `(family, key)`, replaced.** … these completions are *levels*, not events.
> The AI stream posts READY then DONE for one session; a park that finds both must see DONE
> (the newest) …

READY and DONE are **different classes in one family** (`scheduler.rs:78-79` maps
`CLASS_AI_READY | CLASS_AI_DONE | CLASS_AI_ERROR => CLASS_AI_DONE`), coalesced to one entry
per `(family, key)` — a levels rule, not two posts for one pair. And `scheduler.rs:515`
already asserts the guard the engine wants:

> Taking it twice yields nothing, so a completion cannot resume twice.

## 5. Declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| tree clean after Phase 0 | empty | **empty** | ✓ |
| `--bin` | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 / 11 | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability skips | unchanged |
| thread suite | 7 | **7**, DL21's and DL22's guards unmodified and passing | ✓ |
| `--test fiber` | 6 | **6** | unchanged |
| `--test fiber-executor` | 5 | **6** | **+1 over declared — see below** |
| bundle / std | unchanged | `aa74d6a1`, `cmp` exit 0 | ✓ |
| CI step | 11 tests, no skip env | **12 tests**, no skip env, success | **+1, same cause** |

**The one deviation, declared here and in the commit:** the brief expected one new test in
`fiber-executor` (re-park, 4 → 5). This round added **two** — re-park and the
`delivery_target` test — because Part C requires "the no-record refusal has a test", and
every other home for it either cannot reach the code (the decision lives in the library, the
store is private) or moves `--bin`, which the brief pins at 307. `--test fiber-executor` is
the one target this round is allowed to grow. The cost is `--test fiber-executor` = 6 and
the CI step = 12 instead of 5 and 11.

### Files touched, and everything not named by the brief

| file | why |
|---|---|
| `.github/workflows/e2e-debug.yml` | Part A's step |
| `tension-core/src/thread.rs` | `delivery_target`, `RefusedDelivery`, the pool's `refused_deliveries`, the guard and the validated mark, `Delivery::key` |
| `tension-core/src/main.rs` | `strand_refusal` widened to consume refused deliveries and to keep the two sentences apart |
| `tension-core/tests/fiber-executor.rs` | re-park test, `delivery_target` test, the gate now counts every park (not just the first), and `__print32` learned tags 3/4 for the re-park guest's two halves |
| `docs/abi/guest.md` | **regenerated** — the pre-commit hook caught it: `thread.rs` grew above the registrations, so 9 rows' line numbers moved. My own `npm run docs:abi` was not run first; the hook was right |

**`src/thread.rs` and `src/main.rs` are the round's only engine changes**, both required by
Part C. No guest ABI change (`scheduler::park`'s signature is untouched), no compiler
change, no std change.

## 6. Commits

| SHA | what |
|---|---|
| `fff4708` | `thread: stackful proofs in CI, re-park tested, deliveries validated (I61, I62, I55)` — Parts A–C |
| `3adcd4b` | `test(fiber-executor): the guard's three pieces, and an honest gap` |
| *this file* | `docs: DL26 — …` |

CI: **`45222175321`**, **success**, on `3adcd4b` (the code); and **`45222666379`**,
**success**, on `7209888` (this report).

## 7. Bugs I made, and what caught each

1. **`Delivery` has no `key`, and my refusal needed one.** `E0609: no field key on type
   Delivery` — caught by the compiler. Fixed by adding the field to `Delivery` and to both
   constructors, with a comment saying it exists *only* for the refusal message.
2. **The pre-commit hook caught a stale ABI doc.** My `thread.rs` edits moved every
   registration below them, so `docs/abi/guest.md` was wrong at line 32. The commit was
   refused with the exact stale/expected rows. I would not have noticed; this is the second
   round in a row where a generated artifact was the thing that broke. Regenerated, staged,
   committed.
3. **A shared-memory engine in a test needs explicit configuration.**
   `shared memory support is disabled for this engine` — my pool-half test built
   `Engine::default()` for a module importing `(memory 1 4 shared)`. Caught by running;
   fixed with `config.shared_memory(true)`.
4. **I declared 5 and shipped 6.** Not a runtime bug — a gate deviation, caught by re-reading
   the brief's gate list before writing this report. Reported in §5 rather than quietly
   updated.

## 8. What I did not verify

- **The guard firing end-to-end.** The decision, the message and the pool bookkeeping are
  tested; that `service_wakes` calls them on a live worker is inspected, not measured (§C).
  Producing a foreign delivery needs crate-private state or a new WAT worker fixture.
- **The find-first defect end-to-end.** It is established from source on both sides
  (`task-rt.ts`'s `hostPark(<i64>id, …)`, the push-only vec, the old find) and the decision
  is gated by a test, but no run produced a re-parking *worker* task and a second wake for it.
  Doing so needs a two-await guest plus two completions after the corresponding parks, which
  needs either a session producer (I31) or a new host flag — both out of scope.
- **The already-resolved `delivery_target` branch.** It is tested and it is reachable in
  principle, but nothing in this round produced a delivery for a record that is resolved but
  still in the vec; the `early`-buffer coalescing removes the obvious case first (§C). The
  branch is therefore defensive and could be removed by a future round that proves it is not.
- **`--test threads` under CI's flags.** DL21's guards run in CI; the whole target does not
  (it needs a compiler). Unchanged this round.
- **Windows**, latency, fan-out, I50/I57/I58/I59, I47/I45/I36 — excluded by the brief.
- **The `early` buffer's silent drop** (measured in §C, unchanged) — no fix attempted, per
  the brief's "no change to this case".
