# DL25 — the fiber executor: park suspends, a wake resumes, silence is named

**The executor works, and all three halves are measured.** A thread's loop owns one
suspended fiber, a wake posted from another thread resumes it with the guest's locals
intact, a parked fiber with no wake is **named** at shutdown instead of forgotten, and a
wake for a task the executor does not own is **refused by name** rather than resumed or
dropped.

`~/work/Tension` `integration/dwarf-debug`, from **`b01fc64`**. `~/work/TensionScript-a2`
untouched at **`3f59ec08`**, bundle **`aa74d6a1`**, `std` byte-identical. **No
`tension-core/src` change, no ABI change, no compiler change, no std change.**

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`b01fc64`**, nothing unpushed |
| working tree | **one pre-existing change**: `package-lock.json` (the DL24 npm artifact, still not mine) |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `std/assembly/thread.ts` | identical (`cmp` clean) |
| binary | `33 643 504` bytes, mtime **2026-11-23 14:11:11** |
| newest source | `src/thread.rs` **2026-11-23 14:07:07** |
| sources newer than the binary | **0** |

With `tension-core/src` untouched since DL22's build, the engine measured here is
byte-identical to the one DL24 measured — the probe's behaviour cannot be a stale-binary
artefact. `package-lock.json` is the same uncommitted npm artifact DL24 recorded; it is
**not** part of this round and is not in any commit.

## 1. Declared before the first run

- **Target:** `tension-core/tests/fiber-executor.rs` — a new integration-test target,
  **not** wired into CI. Auto-discovered (`[[test]]` entries are only needed for
  `harness = false`), so the manifest is unchanged.
- **Guest:** inline WAT, `run(task: i32, key: i32) -> i32`, importing `env.__park(class,
  key)` and `env.__print32(tag, value)`. Both imports are defined **by the test file**;
  the shipped `scheduler::park`, the ABI doc, std and the compiler are untouched.
- **H2's refusal form: an explicit `Outcome::Stranded` value**, not a non-zero process
  exit. A test target cannot assert on its own exit status without spawning itself, and a
  value is what the binary would consume anyway (`strand_refusal` returns an `Error` that
  becomes `Error: …` and exit 1). The reasoning is recorded here rather than discovered
  later.
- **Wake channel: `Mutex<VecDeque<Wake>>` + `Condvar`, one per executor.** Not an `mpsc`
  channel, because the executor must be able to *look* at a wake and refuse one that names
  someone else's task — a receiver that can only accept-or-block cannot do that. It is
  also the shape `src/thread.rs`'s `ExecutorPool` already uses (`inboxes` + `wake`), so
  the probe measures the arrangement the shipped pool would grow into.
- **Counts declared:** `--bin` 307, census 71/11, `test:compiler` 0 skips, thread suite 7,
  `--test fiber` 6 (DL24's, unmoved), bundle `aa74d6a1`, std identical, new target
  `--test fiber-executor` = **4 tests**.
- **One suite at a time**, and every count below was taken that way.

## 2. H1 — park suspends, a wake resumes, the local survives

One thread, one fiber, one park. The wake is posted **from the test's main thread**, so the
resume is driven across a thread boundary — that is what an executor is, and DL24's
single-threaded test could not show it.

Verbatim, `h1_park_suspends_a_wake_resumes_and_the_local_survives`:

```
guest (task 1): BEFORE the park
guest (task 1): inside __park(4, 7)
executor 1: parked class=4 key=7 (task 1)
guest (task 1): __park returned — resumed
guest (task 1): AFTER the park keep=42
executor 1: task 1 resumed and finished
```

Asserted by **position**, not presence: `BEFORE` < the park < the loop's own `parked` line
< `AFTER`. The outcome is `Outcome::Done(42)` — the guest's return value, so the fiber ran
to completion rather than being abandoned at the end of the wake. `keep=42` on the far side
is the contract's "locals unchanged".

## 3. H2 — a parked fiber with no wake is named

Same guest, same executor, **no wake**; the executor is told to stop. Verbatim:

```
guest (task 1): BEFORE the park
guest (task 1): inside __park(4, 7)
executor 1: parked class=4 key=7 (task 1)
executor 1: STRANDED — task 1 parked on class 4 key 7 and no wake arrived
```

and the result is

```
Outcome::Stranded(Strand { task: 1, park: Park { class: 4, key: 7 } })
```

The test asserts on the *rendered* refusal as well as the variant, because a refusal nobody
can read is not a refusal: `"task 1 parked on class 4 key 7 and no wake arrived"`.

### The compulsory control — what I broke

Two mutations, each applied, run, and reverted (`cmp` against the pre-mutation backup after
each; `grep -c MUTATION` on the committed file is 0).

**M1 — breaks H1.** In the loop, a *matching* wake is accepted and then never resumed:

```rust
// MUTATION M1: a matching wake is accepted and ignored — never resumed.
if true { break; }
```

Result: **H1 FAILED, H2 passed** — exactly the direction asked for.

```
thread 'h1_park_suspends_a_wake_resumes_and_the_local_survives' panicked at
tests/fiber-executor.rs:526:5:
the task must complete with the guest's result, got Stranded(Strand { task: 1,
park: Park { class: 4, key: 7 } })
```

H3's both halves also failed under M1, which is correct: they depend on the resume too.

**M2 — breaks H2, by making it silent.** At shutdown, the parked fiber is forgotten and
reported as success:

```rust
// MUTATION M2: a parked task at shutdown is forgotten silently — the
// exact failure mode (I58) this half exists to prevent.
None => Outcome::Done(0),
```

Result: **H2 FAILED**, everything else passed.

```
thread 'h2_a_parked_fiber_with_no_wake_is_named_at_shutdown' panicked at
tests/fiber-executor.rs:616:18:
a task parked with no wake must strand, got Done(0)
```

That is the guard biting on precisely the failure this round is about: before DL25 the
equivalent of M2 is what the engine does, and the test's job is to make it impossible to
land silently.

**Silence was not the only thing available** — that clause of the brief does not apply. The
executor can name a strand because it holds the park's payload; the naming cost is one
`Display` impl and one branch, and the price is stated in §5.

## 4. H3 — two executors, reverse order, and the pin

### 4a. Wakes in the reverse of the parking order

Two threads, one executor each, one parked fiber each. Task 1 parks on key 71, task 2 on
key 72 — different keys so the log needs no guessing.

Verbatim:

```
guest (task 1): BEFORE the park
guest (task 1): inside __park(4, 71)
guest (task 2): BEFORE the park
guest (task 2): inside __park(4, 72)
executor 2: parked class=4 key=72 (task 2)
executor 1: parked class=4 key=71 (task 1)
guest (task 2): __park returned — resumed
guest (task 2): AFTER the park keep=42
executor 2: task 2 resumed and finished
guest (task 1): __park returned — resumed
guest (task 1): AFTER the park keep=42
executor 1: task 1 resumed and finished
```

Both complete with `Done(42)`, and task 1's resume is **after** task 2's completion. The
point it proves: when task 2's wake was posted, task 1 was already parked and waiting, so a
wake routed by queue position would have resumed task 1. It resumed task 2 — the wake found
its **owner**, and the per-thread constraint is a shape, not a global ordering.

**How the order is made deterministic** (and why the first attempt was wrong — see §7): both
tasks park, task 2 is woken **and joined**, and only then is task 1 woken. Nothing sleeps.

### 4b. The pin: a wake for a task this executor does not own

The executor owns task 1; a wake naming **task 99** is posted. Verbatim:

```
guest (task 1): BEFORE the park
guest (task 1): inside __park(4, 7)
executor 1: parked class=4 key=7 (task 1)
executor 1 refused a wake for task 99 (class 4 key 7): it owns no such task
```

The refusal's exact text is the `Display` of `WrongOwner`:

```
executor {id} refused a wake for task {task} (class {class} key {key}): it owns no such task
```

→ `executor 1 refused a wake for task 99 (class 4 key 7): it owns no such task`

The outcome is `Outcome::RefusedWake { refusal, stranded }` — **both** facts in one value,
because a refusal that hid the strand would be the silent loss this round exists to prevent.
Asserted: the refusal names task 99 and executor 1; the guest never prints `AFTER` (so
nothing was resumed); and the executor's own task is still parked (`Stranded { task: 1, park:
4/7 }`), so nothing was dropped either.

## 5. The cost, stated plainly

Two things in this executor are costs rather than features, and both belong in the
capability table:

1. **A stranded fiber leaks its stack.** A suspended `Fiber` cannot be dropped
   (`debug_assert!(self.done.get(), "fiber dropped without finishing")`,
   `wasmtime-internal-fiber-50.0.2/src/lib.rs:304-306`), so H2's naming and H3's pin both
   end with `std::mem::forget(fiber)`. The probe reclaims properly on the happy path
   (`into_stack()` on a finished fiber) and leaks only an abandoned one. A shipping
   executor would need a policy for that leak — resume-or-refuse at shutdown rather than
   forget.
2. **One parked fiber per thread, honoured by construction.** DL24 measured that wasmtime's
   trap handler keeps a per-thread LIFO of activations, so `serve` creates, resumes and
   finishes its fiber inside one call on one thread and holds exactly one at a time. The
   constraint is not worked around; it is the loop's shape. H3's two executors are two
   threads because they have to be.

**Guard pages (the crate's `std` feature): I did not flip it, and I do not think H3 needs
it.** `nostd`'s `FiberStack::new` allocates a `TryVec<Align16>` with no guard page, so a
stack overflow inside the guest would run into whatever follows. That is a real hazard for
a shipping path and **not** something H3 exercises — no test here overflows a stack. Recorded
as a known limitation rather than silently enabled.

## 6. Declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--bin` count | 307 | **307** | unchanged |
| census `--workers 8`, alone | 71 pass / 11 no-source | **71 / 11**, 0 skipped | unchanged |
| `test:compiler` | 0 skips | exit 0, `[ SUCCESS ]`, **0** capability skips | unchanged |
| thread suite | 7 | **7 passed** | unchanged |
| `--test fiber` (DL24's) | 6, unmoved | **6 passed** | unchanged |
| new target | `--test fiber-executor` = 4 | **4 passed**, 20/20 consecutive runs | as declared |
| bundle / std | unchanged | `aa74d6a1`, `cmp` clean | ✓ |
| `tension-core/src` | untouched | no `src/` file in `git status` | ✓ |
| `Cargo.toml` / `Cargo.lock` | unchanged (DL24's dev-dep already present) | unchanged | ✓ |

### Files touched

| file | why |
|---|---|
| `tension-core/tests/fiber-executor.rs` (new) | the executor probe: 4 tests |
| `tools/thread-promise/DL25-REPORT.md` | this report |

Nothing else. The DL24 dev-dependency was already sufficient, so **not one line of manifest
or lockfile moved this round** — which is the cleanest possible answer to "no engine change".

**Stability check:** the target was run 20 consecutive times after the last edit (the wake
crosses a thread boundary in H1 and H3). 20/20 green; a race would have shown up as a
flaky order assertion, which is exactly what §7's bug 1 was.

## 6a. Commits

| SHA | what |
|---|---|
| `622611e` | `probe(fiber): the executor — park suspends, a wake resumes, silence is named (DL25)` — the four tests |
| *this file* | `docs: DL25 — …` |

CI: run **`45215463267`** on `e3966fa`, **success** — `Wake path guard` ran `2 tests`, both
ok in 1.32 s. The new target is **not** wired into the workflow, as declared, so it reaches
that job in no way.

Checked the thing a later round would ask: the committed probe also passes under the flags
that job uses —

```
cargo test --test fiber-executor --no-default-features   → 4 passed
```

— so wiring it in later is a one-line change to a working target rather than a porting
exercise.

## 7. Bugs I made, and what caught each

1. **H3's ordering assertion was a race, not an assertion.** My first version posted both
   wakes and then asserted task 2's `AFTER` came before task 1's. Two owner threads resume
   concurrently, so that ordering is the scheduler's choice, not the executor's. It failed
   first on a *matcher* bug (below), and while fixing that I noticed the assertion was
   unsound even with the matcher corrected. Rewritten to wake-and-join task 2 before waking
   task 1: deterministic, no sleeps, and it still proves the owner-finding point.
2. **A substring matcher that could never match.** The log line is
   `guest (task 2): AFTER the park keep=42` and I searched for `task 2: AFTER`. The paren
   means `"task 2: AFTER"` is not a substring of `"task 2): AFTER"`. The panic message
   printed the line I was looking for, which is how it was caught in one reading.
3. **`mkdir` after the redirect.** I started the census with `> /tmp/dl25/census.log`
   before `/tmp/dl25` existed, so the shell never launched the job — and my first poll
   reported a missing file rather than a failed run. Caught by noticing the poll said "no
   such file" instead of "still running". Created the directory, restarted, and the
   census then ran alone to completion.

## 8. What I did not verify

- **A pool with more than two executors**, or any hand-off between them. The pin means there
  is no hand-off to measure; the executor shape is per-thread by construction.
- **Re-parking.** The loop handles a second park from the same task (it logs and keeps
  serving), but no test parks twice — the guest parks once. The branch is exercised as dead
  code only.
- **Stack size.** 512 KiB, chosen not measured, as in DL24. A guest that overflows it has no
  guard page under `nostd` (§5).
- **Windows**, excluded by the brief; and **release mode** — every run is the `test` profile,
  so the "cannot drop a suspended fiber" behaviour is the `debug_assert!` being live. In
  release the drop would proceed to `inner.drop::<A, B, C>()` with `done == false`, and what
  that does to a live stack is untested (also unverified in DL24).
- **Whether the shipped `ExecutorPool` could adopt this** — the probe's imports are its own,
  so nothing here measures the change that would wire it into `thread.rs`. That is I60's
  round.
- **Latency.** Excluded; the wake path's cost is unmeasured, and per DL23's finding there is
  no stackful caller to measure it against yet.
- **I57 and I58 are not fixed.** H2's naming is the *probe's* shape, not the engine's: the
  shipped pool still exits silently when a promise-backend task is abandoned at shutdown.
  What this round establishes is that the fibre equivalent can be named, cheaply.
