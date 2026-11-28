# DL61 — I95 closed: spawned work runs, and the defect was ordering, not a missing method

**The gate is met.** Three tasks, none awaited, all three bodies run, on the fiber backend
that owns the queue. The brief's diagnosis was wrong in one specific way, and the correction
is the round's finding.

```
Tension        feat/dl59-ready-queue  c96da9d   clean
TensionScript  feat/dl59-ready-queue  56a37f6c  clean
```

---

## 1. The bisect: the synthesized method was never missing

The brief's reading — "the record arrives without its `drive` method" — is not what the
tree does. On the previous commit (`8ebfa18f`), the artifact contains:

```
(func $.../work$Rec#drive …)                ← present, compiled
  … TaskBase#drive@override …
   local.get $0
   call $.../work$Rec#drive                 ← and the stub calls it
```

`recFields[parameters.length]` is a `MethodDeclaration` with `body=true`, and the resolved
override is `compiled=true` — both measured on pristine `8ebfa18f`, with instrumentation
removed before the fix.

**So the property diff was empty**, and per decision 8 the suspect moved — to *ordering*,
which is where it was. The parts that differ between "the virtual stub calls the record" and
"the stub is a bare `unreachable`" are not properties of the `MethodDeclaration` at all:

| | statement-position spawn (`work(1);`) | explicit `__submitTask(work(1))` |
|---|---|---|
| `work$Rec#drive` in the artifact | **absent** | present |
| `TaskBase#drive@override` | `unreachable` (one instruction) | switch chain, calls the record |
| `__submitTask` in the artifact | absent | present |

The mechanism, in `compile()`:

- `TaskBase#drive` is `abstract`, so its stub is finalized from `unboundOverrides`, through
  the classes bound beneath it. DL60 emitted `__driveSlot` **in the tail**, after that loop.
- With a statement-position spawn, `__submitTask` is reached from *no call site* — the
  rewrite creates the only one — so nothing pulled the record into the stub's resolution
  either.
- Neither existed when the stub was built, so it finalized as `unreachable`, and the record's
  own `drive` was never compiled at all.

**The fix is a move plus the two pieces the round was for**: the fiber ABI block
(`__submitTask`, the `scheduler::ready` import, `__driveSlot`) now runs after
`drainLazyFunctions` and **before the override stubs**, and still before the runtime
features — that last part matters, because compiling `__driveSlot` after them fails
validation with `call target must exist (call $~lib/rt/__tostack)` (DL60 measured it, and I
reproduced it).

**Why the I103 workaround left I95 blocked, plainly.** DL56 fixed `await` on a handle by
routing it through the park ABI *instead of* through `drive()`. That was the right call — the
fiber park is what the host can complete — but it removed the only caller that would have
made an empty `drive()` visible. With no program driving a synthesized task, the stub could
stay `unreachable` indefinitely: nothing in the suite reached it, and the census read a
program that spawned and ran nothing as `ran`. The workaround was correct and it hid the
next defect behind the one it fixed. That is the lesson worth carrying: **a workaround that
removes a caller also removes a witness.**

## 2. What ran, and the evidence it is the queue's doing

```
$ tension-core tension-core/tests/programs/build/spawn-ready.wasm
entry
ran 1
ran 2
ran 3
```

Ten runs, one md5: **1 distinct transcript across 10 runs**.

The artifact, not only the transcript, says *how* the work started:

```
(import "scheduler" "ready" …)     ← the guest hands the slot over
(export "__driveSlot" …)           ← the host resumes it
```

`tension-core/tests/spawn_ready.rs` asserts three separate things: the import and export
present; the transcript equal to `probe/spawn-ready.expected.txt`; and ten runs identical.
Committed as `fixtures/fiber/spawn-ready.wasm` and added to the **Stackful proofs** CI step,
so the gate runs where no compiler is installed — the same rule `park_frame` follows.

**The red control**, one line reverted in `main.rs` (`drain_ready(&mut store, &instance)?;`
replaced by `let _ = drain_ready;`):

```
entry
```
— and only that. Restored, the same command prints all four lines. The gate fails when the
feature is removed, which is what makes it a gate.

**The corpus example**, `examples/spawn` — a program a user would write, and its output is
the design:

```
spawning three tasks and not awaiting any of them
the entry returns here; the host runs what was spawned
  step 1
work 1 finished (1)
  step 2
work 2 finished (1)
  step 3
work 3 finished (1)
```

The entry returns **first**, then the spawned bodies run — that is the difference between
spawning and awaiting, visible in one transcript. 10/10 runs identical.

## 3. `schedule-order` parity: refused by name, not silently zero

Continuation has no driver for a floating spawn: `__submitTask` pushes to the guest's own
executor ring, and the shell's core loop has already ended when the entry returns. There is
no guest-side "run the ring to empty" entry for the host to call — `__drainInbox` is reached
only from `__mainStep__`, inside the loop that has stopped. So the same program on that
backend would exit 0 having run none of its bodies.

Decision 7 says refuse by name rather than compile a silent zero, so:

```
ERROR AS100: Not implemented: a spawned task on the continuation backend (nothing drives the
executor ring after the entry returns, so the body would never run). Await the task, or build
with `--stackful-backend fiber`
```

This is a **capability difference between backends, not a bug in one of them**, and it is the
first thing a policy layer has to be able to say out loud. It belongs in the seam's own
vocabulary next round; for now it is a compile error that names the backend.

`2d/box-physics` keeps working: it spawns with a floating `drive(...)` call
(`scene.ten:827`) and `examples_2d` (6 tests) passes.

## 4. DL56's park path

Unchanged and re-verified, because this round moved the same emission:

```
probe: park     frame=0 resumes=0
probe: resume   frame=0 resumes=1
probe: park     frame=1 resumes=1
probe: resume   frame=1 resumes=2
```

`park_frame` 2 passed; `input_sources` 2 passed.

## 5. Gates

| gate | result |
|---|---|
| `--check` (`TENSIONSCRIPT_DIR` set) | **10/10 links PASS** |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| park_frame · input_sources · spawn_ready | **2 · 1 · 3** |
| `--bin` | **311 passed** |
| `examples_2d` | **6 passed** |
| `build:examples` | **23 of 23**, exit 0 |
| `run:examples` | **16 ran · 1 hung · 1 refused** — 16 ran, up from 15: `spawn` joined the corpus and ran |
| TensionScript's own suite | green, **zero `fixture mismatch`** |
| CI | Tension and TensionScript, run ids in the round's message |

**Artifact delta, declared before measuring and then measured**: one golden,
`fixtures/debug/main-policy.wasm` (+1 byte, DWARF line rows shifted because `task-stack.ts`
grew by the builtin declaration). Symbol sets are identical — `diff` of the sorted name tables
is empty. Plus the new `fixtures/fiber/spawn-ready.wasm` and its sidecar. Nothing else moved:
the hand-over is emitted only where it is called, so `interop/*`, `features/*` and
`bindings/*` are byte-identical (this repo's suite says so).

## 6. The census, and its blind spot

| | baseline (DL60 tip) | after |
|---|---|---|
| ran | 15 | **16** |
| hung | 1 (`ogre/input-camera`) | 1 (same) |
| refused-by-name | 1 (`solver/collision`, gnuplot) | 1 (same) |
| examples in the corpus | 22 | **23** (`spawn`) |

**The instrument still cannot tell "finished" from "gave up."** `run:examples` classifies by
exit status and a timeout; a program that exits 0 with work undone reads as `ran`, which is
exactly how I95 survived in the table for four rounds. The new Rust gate is the narrower
instrument that *can* see it — it asserts a transcript, not an exit code — and the honest
statement is that the census needs a per-example expected transcript before it can make the
same claim. That is a finding about the instrument, not a defect in this round.

## 7. What the seam can and cannot express (owed since DL59)

`tension-core/src/ready.rs`:

- **Can**: which ready slot runs next (`ReadyPolicy::next`), FIFO by default, and the
  refused-when-full count. A LIFO policy swaps the order with no change to the queue or its
  caller — `the_policy_is_an_object_not_a_branch` pins that.
- **Cannot**: priorities across families (a slot is a guest table index; the host does not
  know the family), a concurrency cap (nothing holds a task "ready but not running"), preemption
  (a policy is consulted between tasks, never during one), migration (decided at spawn by
  `__spawnOn`/`__spawnOnMasked`), and fairness across stores (each store has its own queue).
- **The concurrency class per backend** is not printed, and I am not printing one: the thing
  that would make it honest is the per-backend capability refusal above (fiber runs floating
  spawns, continuation refuses them), which is now a *compile-time* fact rather than a runtime
  property a log line could reveal. Printing "class 1" beside a label nobody reads would be
  the kind of green line this project keeps finding.

## 8. What the tree contradicted in this brief

- **"The record arrives at the artifact without its `drive` method."** It arrives with it.
  The stub was built before the call existed, so the *stub* was empty. The distinction matters
  because the brief's framing points at the transform's synthesis (a design-adjacent fix);
  the actual cause is a phase ordering in `compile()`.
- **"A fix that special-cases `drive` has not fixed this."** Agreed, and the landed fix
  special-cases nothing: it compiles the submitted path *before* stub finalization, which is a
  statement about phase order. Any future synthesized method reachable from a compiled body
  inherits the fix.
- **Decision 3's two-method fixture.** I did not build one, because the bisect moved the
  defect out of the member-emission question entirely: methods of a synthesized class emit
  correctly (measured — `work$Rec#drive` is in the artifact). A two-method fixture would
  assert a property that was never broken and would not have caught this. The gate that *does*
  catch it is behavioural and is the one that ships.
- **`schedule-order`'s "same number on both backends"** is not achievable and is now a
  named refusal instead; that is a real answer to decision 7, not a dodge.

## 9. What I did not verify

- **CI at the time of writing.** Both branches are pushed; conclusions are in the round's
  message, quoted from `gh run list`, not assumed.
- **The two-method fixture of decision 3.** Reasoned above; not built.
- **Windows and macOS.** A floating spawn on fiber is portable ABI (an import plus an export,
  no stack switching), but this round ran only on Linux.
- **`examples/ai` and `async-io` determinism for this round.** Both `ran` in the census
  at their usual times, and neither touches the spawn path; DL60's 10/10 was not re-run here.
- **The `async method` gap (I126)** — untouched, and now the next round's subject: an
  unawaited `game.run()` needs spawn to work before it can be judged, which is what this
  round delivered.
