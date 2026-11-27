# DL59 — I95: the seam is built, the spawn does not yet reach it

**The round's own gate is unmet and this report says so first.** The host's ready queue, its
policy seam, its bound and its invocation point all exist and are unit-tested. **A program
that spawns work still does not run that work on fiber** — the guest never hands the slot
over, and two precise blockers are named below. Nothing here is presented as finished.

```
Tension  feat/dl59-ready-queue @ 882df32   CI green (46075662957)
TensionScript  unchanged this round (cfcd05d5) — the guest-side work was reverted
```

---

## 1. Phase 0 — I95 as a number, both backends

Probe: three spawned tasks, each awaiting a leaf, each appending to an observable counter;
the entry does not await them.

```
continuation                      fiber
start                             start
ran 1 value 0                     order 0            ← zero of three bodies
ran 2 value 0                     end
ran 3 value 0                     rc=0
order 3
end
rc=0
```

And `async/schedule-order.ten`, which counts its own steps:

```
continuation   steps 15     (tension-core/tests/programs/build/schedule-order.wasm)
fiber          steps 0      (built from the same source, --stackful-backend fiber)
```

**Both `rc=0`.** A program that spawns three tasks and gives up reads as success — the exact
species of green line this project keeps finding. Note the probe had to await something
inside the spawned body: a body with no `await` is not lowered at all and runs inline on both
backends, which is why my first probe showed `order 3` on fiber and was measuring nothing.

## 2. What was built

`tension-core/src/ready.rs` — quoted in the commit; the shape:

```rust
pub trait ReadyPolicy: Send {
    fn next(&mut self, queue: &mut VecDeque<u32>) -> Option<u32>;
    fn name(&self) -> &'static str;
}
pub struct ReadyQueue { ready: VecDeque<u32>, policy: Box<dyn ReadyPolicy>, … }
```

- **`ReadyPolicy` is the seam.** Two questions only: which slot runs next, and `None` when
  nothing is ready. `the_policy_is_an_object_not_a_branch` inserts a LIFO policy into an
  otherwise untouched queue and gets the reverse order — the test exists to pin that a policy
  replaces an *object*, not a branch in the loop.
- **Bounds**: `READY_CAPACITY = 64`, deliberately the guest ring's own size so a program that
  fits one queue cannot be refused by the other. A submission to a full queue returns
  `false` and increments `refused_full` — counted, never silently dropped.
- **Invocation point, named**: `drain_ready`, called in `main.rs` as **the first thing after
  the guest's entry returns**, before the workers are joined and before any exit path. It pops
  through the policy and resumes each slot via the guest's `__driveSlot` export, one call per
  task; a trap in a spawned body is reported with its slot.
- **`scheduler::ready(slot)`**, registered for every guest like `park`: `1` accepted, `0` full.

Four unit tests pass (`ready::tests::*`, 4 passed).

### What the seam can and cannot express

- **Can**: which ready task runs next, in what order, and (via the queue's counters) whether
  anything was refused.
- **Cannot** — and each is a policy question for a later round, not a defect:
  priorities across families (a slot is a guest table index; the host does not know what
  family it belongs to), a concurrency cap (the loop drives each slot immediately, so there is
  nowhere to hold a task "ready but not running" — a cap needs the loop to ask a second
  question), preemption (a policy is consulted between tasks, never during one), migration
  (decided at spawn by `__spawnOn`/`__spawnOnMasked`), and fairness across stores (each store
  has its own queue; nothing arbitrates).

## 3. Why the spawn does not reach the queue — two blockers, both measured

**Blocker 1: nothing rewrites `work(1);` into a hand-over.** A program writes a call in
statement position and drops the handle; that position *is* the declaration of intent, so it
is what the rule must key on. I wrote that rule in the transform — `NodeKind.Expression` whose
callee is a lowered async function → wrap in `__submitTask` — and it never fired. Instrumented
with a diagnostic refusal, the walk reached **std and framework sources** (`hostPrint`,
`write`, `store`, `copyInto`) but the entry file's own statements never arrived at that case,
and `this.spawnable` (built at `afterParse` from every source's async declarations) held four
names and never `work`. I did not find why inside the round's budget. **The rule is not in the
commit**: dead code in a transform is worse than a documented gap.

**Blocker 2: an explicit `__submitTask(work(1))` does not work either**, and its failure is
more informative than the rule's silence:

```
[wasm-validator error in function ~lib/task-stack/__serveSlot] unexpected false:
call target must exist, on (call $$serveEntry (local.get $0))
```

On a guest whose root is a **sync** `_start_game`, the fiber build prepares no shell —
DL54's known residue — so `$serveEntry` is never emitted, and std's `__driveSlot` reaches
`__serveSlot`, which calls it. That is DL53's class (a call with no target) arriving from a new
direction. **The ready drain therefore cannot be compiled into a fiber guest that has no
shell**, which is precisely the guest that needs it most: the one whose only work is spawned.

Two possible fixes, both compiler rounds and both out of scope here: emit `$serveEntry` for
every fiber build (not only shell-having ones), or split `__driveSlot`'s fiber path from the
serve path so the drain does not pull the serve entry in.

## 4. Gates

| gate | result |
|---|---|
| `ready::tests` | **4 passed** |
| `--check` (`TENSIONSCRIPT_DIR` set) | **10/10 links PASS**, no artifact moved |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| park_frame · input_sources | **2 · 1** |
| `--bin` default | **311 passed** (307 + the 4 ready tests) |
| `build:examples` | **22 of 22**, exit 0 |
| CI | **green** (`46075662957`) |
| census | **15 ran · 1 hung (`ogre/input-camera`) · 1 refused (`solver/collision`)** — unchanged, as expected: no example spawns yet, which is the reason I95 has been invisible to the census |
| `examples/ai` ten runs | **10/10 rc=0**, guest output identical in all ten |

`docs/abi/*.md` regenerated for the one new import (`scheduler::ready`).

## 5. What the tree contradicted in this brief

- **"`__driveSlot(slot)` exists and nothing on the fiber host calls it."** True, and the fix is
  not "call it": std's `__driveSlot` pulls `__serveSlot`, which needs a `$serveEntry` a shell-less
  fiber build never emits. The brief's assumption that the host calling `__driveSlot` was the
  whole gap is wrong — measured, it does not validate.
- **"The corpus gains a spawn example."** It cannot, until the two blockers above are cleared:
  an example that spawns would join the corpus and read `ran` while printing `order 0`, which
  is worse than no example. Decision 7 is unmet for that reason.
- **Census `ran` still cannot distinguish "finished" from "gave up"** — a fourth class was not
  added, because detecting it needs a guest-side counter the host can read, which is the same
  seam this round could not finish. Stated as a finding rather than guessed at.

## 6. What I did not verify

- **That spawned work runs on fiber.** It does not. This is the round's unmet gate.
- **Why the transform's statement walk skipped the entry file.** Instrumented and observed, not
  explained.
- **The concurrency class per backend** (decision 5): not added, because printing a class for a
  seam nothing reaches would be a claim about a path no program takes.
- **Windows/macOS**, and `ogre/input-camera`'s hang (out of scope, unchanged).
