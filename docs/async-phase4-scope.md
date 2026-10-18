# Phase 4 — async runtime: scope

**Status:** proposal. Read-only analysis; nothing implemented.
**Base:** TensionScript `feat/async-phase3b` @ `75dc74a9` (Phase 3 complete);
Tension `main` with arrow-this merged.
**Source of truth for the design:** `docs/async-await-plan-v2.md` §3.2, §4.7, §6,
§6.4, §7.1, §8. This document adds ordering, repo boundaries and gates; where it
disagrees with the plan it says so in §12.

---

## 1. What Phase 4 delivers, end to end

Phase 3 lowered async functions into state machines and proved their **shape**.
Every lowered entry traps at `std/assembly/task-rt.ts`'s stubs. Phase 4 replaces
those stubs with the machine, and converts shape assertions into value assertions.

### 1.1 The seven seam symbols

`std/assembly/task-rt.ts` declares seven functions, all `unreachable()` today:

| symbol | today | Phase 4 |
|---|---|---|
| `__taskRegister(state)` | trap | allocates the record, sets `state.record`, inserts `state` in the task table, returns the record |
| `__taskPark(state, awaited)` | trap | sets the state's resume point owner, registers it against `awaited`'s record, marks it parked |
| `__taskSettled(record)` | trap | `record.done != 0` |
| `__taskDeliver(class_, a, b, f0, f1)` | trap | looks the record up by `(family(class_), a)`, copies §3.2's five words **immediately** (review 8.3), sets `done`, derives `status`, appends the waiter(s) to the ready queue |
| `__taskTick()` | trap | drains the ready queue (one resume per task), then applies §6.4's drop rule |
| `__taskBindRecordFactory(factory)` | trap | implemented in 4b, or retired — see §13 decision 1 |
| `__taskBindFamily(class_, family)` | trap | implemented: fills the class→family table the dispatcher reads; std carries the default for the four capability classes, so a guest with no framework still resolves `JOB_DONE`/`JOB_FAILED` |

Two symbols are **new** (guest-side, both in std, neither an ABI change):

- `__taskHasRunnable(): bool` — what the frame loop tests to choose `wait(0)` over
  `wait(timeout)` (plan §6.3 uses `rt.hasRunnable()`; the seam has no such
  symbol today).
- The resume entry point, in whatever form §13 decision 2 settles. **This is the
  one real gap the plan does not yet close** — see §4.3.

`TaskEnv` and `TaskState` keep their shape; `TaskState` gains one field (§4.3).

### 1.2 The scheduler

Lives in `__taskTick()` (std). Called from the framework's `rt.runReady()`, which
the game loop calls after `RuntimeSession.wait(...)` returns — never before, and
never inside a callback (plan §6.3; the reentrancy rule is satisfied by ordering).

### 1.3 Payload correlation

Guest side of §6.2. The dispatcher maps `class_` → family, looks up
`(family, a)`, and calls `__taskDeliver` with the record's words **verbatim**.
No id minting; `a` is the producer's submit-time id. Verified for the target:
`loader.cpp:220` (`slot.job_id = index + 1`, the id *is* the slot) and
`adapter.cpp:194-197` (`post_event(class, a = job_id, b = resource_id)`).

### 1.4 Value assertions

Phase 3's six cases become executable: suspend, resume, lifted locals, early
return, nesting, case 6. §9 lists what each harness can prove.

---

## 2. The scheduler's shape

### 2.1 Where it sits

```ts
// the game's frame loop (examples/ogre/bouncing-ball/game.ts:186 is the shape)
const timeout = rt.hasRunnable() ? 0 : frameTimeoutMs;
RuntimeSession.wait(timeout);   // the yield; host delivers here
rt.runReady();                  // → __taskTick()
game.update();
```

`RuntimeSession.wait` already exists (`tension-framework/assembly/runtime/index.ts:76`
→ `session.ts:56` → `session::wait`). No new guest entry point is needed: the
loop already calls it in every example.

### 2.2 The ready queue

A **managed global** `Array<TaskState>` in `task-rt.ts` — managed because a task
queued for resume must stay alive between delivery and tick, and because the
collector must follow it (§4.4's root chain). Not an arena slot: arena regions
are host-owned/wire-laid-out, and a `TaskState` is a guest object.

- Append on delivery, in the order `__taskDeliver` is called — which is the
  epoch's flush order, class ascending and within a class in flush order (plan
  §6.2, §6.5), so "delivery order" is preserved without sorting.
- `__taskTick` drains entries **present at tick start**, at most once each. A
  task resumed during the tick that delivers again queues for the *next* tick —
  this keeps one frame from being starved by a chatty resumed task. (Plan §6.5
  says "in delivery order" and does not settle the re-entrancy case; this is the
  recommendation, recorded in §12 as an amendment.)

### 2.3 What "resume" means

Each parked state is resumed by calling its resume function with the state
struct. `__taskTick` does not know which function that is — see §4.3 for the
carrier. On resume, the state is removed from the parked set first, so a resume
that parks again (the next `await`) re-registers cleanly (§6.5).

### 2.4 The table

Two maps, both managed globals:

| map | key → value | written by |
|---|---|---|
| `pendingByKey: Map<i64, TaskRecord>` | `(family << 32) | a` → the record awaiting it | `rt.job(id)` (framework, 4b) and the handle path |
| `waiters: Map<TaskRecord, Array<TaskState>>` | record → the states parked on it | `__taskPark` |

A host completion arrives as `(class_, a)`; the dispatcher resolves the family,
finds the record in `pendingByKey`, copies the payload, and wakes the record's
waiters. A guest-created task handle (`await h`, `h._record`) needs no
`pendingByKey` entry at all: the record *is* the key. Keeping the two maps
separate is what makes "await another task" and "await a host job" one mechanism.

---

## 3. Dispatch and payload correlation

The framework supplies the two dispatchers (plan §7.1's D9 split):

```ts
function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  for (let i: u32 = 0; i < count; ++i) {
    const r = changetype<EventRecord>(ptr + i * 32);   // stride 32, arena.rs:124
    __taskDeliver(r.class_, r.a, r.b, <i32>r.f0, <i32>r.f1);
  }
  return 0;
}
```

- `onBatch` is **mandatory**: `JOB_DONE` (4) and `RESOURCE_READY` (5) are
  `MODE_BATCHED` (§6.1). `onEvent` carries the failure classes plus input/log.
- Batches mix tasks: the call is per-record, never per-batch.
- **Capture is immediate** — the sub-ring is transient (review 8.3,
  `arena.rs:645-655`). `__taskDeliver` writes the five words into the record
  before returning; nothing reads the ring at resume time.
- Both handlers must be plain functions: `makeCallbacks` refuses a handler that
  captures `this` (`callbacks.ts:34-36`). That guard is Phase 3's NC3 and stays.

---

## 4. Requirements the plan does not yet name

These are scope findings, not implementation choices. Each needs a ruling before
4a starts.

### 4.1 The record layout's home

§3.2 calls the record "framework source"; §7.1 says the task machine — including
"the record reads and writes at §3.2's offsets" — is std. Both cannot hold: a
runtime in std cannot write fields std does not declare, and `TaskRecord` today
declares none (`std/assembly/task.ts`).

**Recommendation:** declare §3.2's eight fields on `TaskRecord` in
`std/assembly/task.ts`. A capability that needs more subclasses it (a subclass
adds fields after the base's, so the offsets §3.2 fixes stay valid), and
`__taskBindRecordFactory` becomes the hook that makes `__taskRegister` allocate
the subclass. This also lets TensionScript test its own runtime without the
framework linked.

### 4.2 Which class a parked task remembers

A task parks on a **family** (`JOBS`), because `rt.job(id)` knows the job id but
not whether it will complete as `JOB_DONE` or `JOB_FAILED`. The record's
`class_` is 0 until delivery. So §6.4's "wakes every task parked on a class whose
counter advanced" cannot be implemented per class; **per family is the executable
form**, and it is the same set of tasks (the family is the union of its classes).

### 4.3 The resume function has no carrier

Nothing in the plan carries `f$resume` into the runtime. The entry calls it
directly for the synchronous prefix, then returns; the state struct holds no
reference to it, and `__taskRegister(state)` takes only the state. A parked task
therefore cannot be resumed by `__taskTick` at all.

**Two options:**

- **(a) A managed field on `TaskState`:** `resume!: (state: TaskState) => void`.
  The entry assigns `state.resume = f$resume` before registering. One lowering
  emission, no seam-signature change, and the value is traced (a `Function<T>`
  field is a managed reference).
- **(b) A seam parameter:** `__taskRegister(state, resume)`. No lowering writes
  a field, but the seam signature changes and the transform must pass a function
  value at the registration site.

**Recommendation: (a).** It keeps the seam's seven symbols stable, and it puts
the pointer where every other per-task fact already lives. Either way this is a
**TensionScript lowering commit** and a plan amendment to §4.7.3.

### 4.4 The drop counter's reader

`FrameState.droppedEvents` exists (`wire.ts:228-231`, offset 4 verified by `wire.ts:384`) and is
reachable as region 2 (`arena.rs:293`, `REGION_FRAME_STATE`), so the guest can
read it with `regionDesc(2)`/`regionOffset(2)` today — **no host change**. But
no framework accessor exposes it yet (`arena.ts` has none). §6.4's rule needs
one: a `frameState()` accessor and a per-class header read (the existing
`TableHeader.dropped`, `wire.ts:208`).

---

## 4b. A completion that arrives before the park (4e's scope)

`__taskDeliver` keys on `(family, key)` in `waitingByKey`, which `__taskPark`
writes — so a completion delivered **before** the guest awaits finds no entry and
is dropped silently. Measured: a job whose record was delivered before the
`await` left the task parked forever, and the four probe instruments read the
sentinel values (`A = -1`, `B = -1`) that only a body which never passed the
await produces.

For the OGRE job path this is a live race: a job fast enough to complete before
the guest's `await` runs would park a task nothing will wake (§6.5 defines
parking as registering the key; it says nothing about an early completion).

4e must resolve it one of two ways: the runtime **buffers unmatched deliveries**
until a park claims them, or `__taskPark` **checks the capability's terminal
table** on entry (for the job family, `jobState(job)` — the region is the truth,
`tension-ogre/DESIGN.md:1842-1844`). The buffer is general and keeps std free of
capability knowledge; the table check is O(1) and needs no lifetime questions.
Not fixed in 4d: the transform is not involved.

## 5. Dropped completions (plan §6.4)

**Rule, as scoped:** at each tick, before draining, read the drop rollup(s) and
compare against the last observed value. If a **family's** drop count advanced,
wake every task parked on that family with `status = -EIO`, and log the family
and the delta once.

- **Where:** inside `__taskTick`, ahead of the drain — so a woken task resumes in
  the same tick it is woken, and the frame does not run with a task that should
  have failed.
- **Attribution:** per family, not per key (drops are counted per class, never
  per record — `subring.rs:290-295`). The runtime cannot say *which* job was
  lost; the status says "your completion is gone".
- **Recovery:** the game reads the capability's region — `jobState`/`jobResult`
  are the truth (`tension-ogre/DESIGN.md:1842-1844`). A lost `JOB_DONE` costs a
  guest nothing it cannot read.
- **Test:** shrink `JOB_DONE`'s ring to 1 at open
  (`ConfigBuilder.ringCapacity`, `config.ts:67-69`), queue more loads than the
  ring holds without a tick, and assert the parked task wakes with `-EIO` and
  recovers through `jobResult`. This is §8.4's NC3 control, and the only
  negative control Phase 4 must build from scratch.

---

## 6. Repo boundary

### 6.1 TensionScript (`feat/async-phase4` from `75dc74a9`)

| commit | contents |
|---|---|
| 4a-1 | `TaskRecord` layout (§4.1); `TaskState.resume` field (§4.3) |
| 4a-2 | the lowering emission for `state.resume = f$resume` |
| 4a-3 | the runtime: `__taskRegister`, `__taskSettled`, `__taskPark`, `__taskDeliver`, `__taskTick`, `__taskHasRunnable`, `__taskBindFamily` |
| 4a-4 | tests: settled-path end-to-end executed in Node; the seam symbol table; `tests/compiler` async wat fixtures regenerated (they will change — see §7) |
| 4b-1 | `__taskBindRecordFactory` (or its retirement), the family table, the `-EIO` drop rule |
| 4d | `tests/async/runtime.js`: the six cases as values, guest-side dispatcher, no host |

### 6.2 Tension

| commit | contents |
|---|---|
| 4b-2 | framework `rt`: `job(id)`, `start(task)`, `hasRunnable`, `runReady`, the record subclass if decision 1 keeps one |
| 4b-3 | `onBatch`/`onEvent` decode → `__taskDeliver`; startup binds the record factory and the family map |
| 4c-1 | `tension-framework/tests/guest-async.ts` + `run.sh` case (stub adapter) |
| 4c-2 | `tension-core/tests/async_await.rs` against `libtension_ogre.so` (review 8.2's recommended harness) |
| 4e-1 | the drop-rule test: ring capacity 1, over-queue, assert `-EIO` and recovery |
| — | submodule/`package.json` bump after the TensionScript publish |

### 6.3 The publish flow

The framework and the examples consume the **published** package
(`tension-framework/package.json:31`: `"@acakar/tensionscript": "^0.1.0"`), not a
local build, and `std/assembly/*.ts` ships inside it. So the Tension-side commits
cannot build until a version containing the runtime is published.

**Order:** TensionScript 4a–4b → full verification → publish → Tension bumps the
dependency → framework commits → fixtures rebuilt → 4c/4e.

**Version:** `0.2.0` (the binary rename) is verified and unpublished; publish it
first, unchanged, so the rename's verification is what ships. Phase 4 then lands
as **0.3.0** — a new std runtime is a feature, and the trap-replacement changes
what previously-trapping programs do. 4a can begin before the publish; the
Tension side waits for it.

---

## 7. Trap retirement

| sub-phase | traps retired | traps that stay |
|---|---|---|
| 4a | `register`, `settled`, `park`, `deliver`, `tick`, `bindFamily`, `hasRunnable` | `bindRecordFactory` (4b), the drop rule inside `tick` (4e) |
| 4b | `bindRecordFactory` | the drop rule |
| 4e | the drop rule | — |

**Limitation 1** of `docs/async-phase3-complete.md` ("every async entry traps at
runtime") is retired by **4a**: `__taskRegister` stops being a stub, so an async
function with no pending await executes its synchronous prefix and returns a real
handle. It is not fully retired until 4d, which is what proves values.

A program that hits a not-yet-implemented path still traps. That is deliberate:
the alternative — silently doing nothing — is how a half-built runtime gets
mistaken for a working one.

**Async wat fixtures change.** `tests/compiler/async-closures-case6`,
`async-closure-value`, and any async fixture embed the runtime's code. 4a
regenerates them deliberately, with the diff reviewed for "the runtime appeared"
rather than "something else changed". The 249-fixture count must not change.

---

## 8. Host ABI verification (plan §7.1)

**Claim: no new import, no new export.**

| Phase 4 need | mechanism | verdict |
|---|---|---|
| yield / deliver | `session::wait` (existing, `session.ts:56`) | no change |
| dispatchers | the two callback slots (existing, `callbacks.ts`) | no change |
| drop counters | region 2 read by the guest (`arena.rs:293`) | no change |
| job completion | `ogre::queue_*`, `job_state`, `job_result` (existing) | no change |
| scheduler tick | guest function, called from the guest's own loop | no change |
| entry point | `_start_game` (existing, `main.rs:226`) | no change |

**Verified against the requirement set:** the guest owns the frame loop (every
example already loops on `RuntimeSession.wait`), so the scheduler needs no host
call-in. The one host-visible thing Phase 4 must *not* do is add a test-only
posting flag in `main.rs` — review 8.2 rejects it, and the recommended harness
uses the OGRE capability as the producer instead.

**Conclusion: no host ABI change.** If any sub-phase later needs one, that is a
scope expansion and stops here.

`tension-core` is otherwise untouched by Phase 4, **except** the new test
`tension-core/tests/async_await.rs` (a test, not production code).

---

## 9. Sub-phases and gates

Every sub-phase gate includes: `npm run build` (4 targets), `npm test` (249
fixtures, 30 resolver + 201 lowering at the base), byte-identity 10/10 for
non-async programs, probes 7 and 8. A gate that breaks any of these stops.

### 4a — the machine, settled path end to end

Lands: 4a-1 … 4a-4. **Proves:** a guest compiles and *runs* a program whose await
is already settled — `__taskSettled` returns true, no park, the value is
correct; and the seam's symbols are no longer traps for the paths exercised.

Scope refinement of the brief: **park/resume is not proved in 4a.** A park needs
a producer, and the first producer in the system is 4b's job registration (a task
with no await completes at its own entry, so it cannot seed a pending record).
4a's executed test is the settled path plus the registration bookkeeping; 4b
proves parking.

### 4b — payload correlation and a delivered completion

Lands: 4b-1 … 4b-3. **Proves:** `rt.job(id)` registers `(JOBS, id)` → record; a
guest that calls `__taskDeliver(JOB_DONE, id, …)` itself (the dispatcher's role,
played by the test) resumes the parked task with that payload; a second task
awaiting the same record also resumes; `status` derives from the class.

TensionScript-side gate: 4b-1 + a Node-executed fixture with the guest-side
dispatcher. Tension-side gate: `rt` + callbacks compile and the stub-adapter
fixture passes.

### 4c — the real host

Lands: 4c-1, 4c-2. **Proves:** §8.2's four criteria against a real cross-thread,
delayed completion: ordering, genuine yield (`frames-while-suspended >= 1`),
lifted locals survive, no reentrancy refusal; plus `jobResult == awaited value`
and `jobState == JOB_DONE`.

Gate adds: `tension-core/tests/async_await.rs` passes with the DSO, the packed
volume and `--renderer=null`; the guest asserts its own transcript. Note the
existing `tests/support/ci.rs` **panics unless `TENSION_TEST_ALLOW_SKIP=1`**, so
the skip policy must be stated in the test.

### 4d — every case as a value

Lands: TensionScript `tests/async/runtime.js`. **Proves** cases 1–6 as values:
straight line, loop, conditional, nesting, early return, and case 6 (a closure
called across an await). Runs in Node against a guest-side dispatcher — no host,
so it is fast and always available; 4c is what proves the host side.

### 4e — dropped completions

Lands: 4e-1 + the drop rule. **Proves** the `-EIO` wake and recovery through the
region readers, with the ring shrunk to capacity 1.

---

## 10. What Phase 4 does not do

- No C5 parent-chain captures (a capture across two environments stays refused).
- No Divergence 2 fix (nested arrows capturing `this` in async bodies).
- No Divergence 3 / D10 / D11 fix (untyped or type-parameter captures).
- No WasmFX Backend B (engine re-pin + separate plan, §5.7).
- No new closures features.
- No `nextTick()`/`nextFrame()` tick-awaitables (plan §6.5 leaves their order
  open; nothing in cases 1–6 needs them).
- No host ABI change, no production change in `tension-core`.
- No `Task<T>` reference-type payloads (§3.2 defers them).

---

## 11. Plan amendments required

1. **§3.2** — the record layout lives in `std/assembly/task.ts`, not the
   framework (§4.1). Capabilities subclass it.
2. **§4.7.3** — add `__taskHasRunnable` to the symbol table.
3. **§4.7.3 / §4.1** — a resume carrier: `TaskState.resume` (recommended) or a
   `__taskRegister` parameter (§4.3). This is the one genuine gap.
4. **§6.3** — `rt.hasRunnable()` = `__taskHasRunnable()`, `rt.runReady()` =
   `__taskTick()`.
5. **§6.4** — attribution is per **family** (§4.2); the counter is
   `FrameState.droppedEvents` plus per-class `TableHeader.dropped`; the wake
   happens at the start of the tick.
6. **§6.5** — a task queued during a tick runs in the *next* tick (one resume per
   task per tick).
7. **§8.1** — the second harness is `tension-core/tests/async_await.rs` against
   `libtension_ogre.so`, per review 8.2, with `ogre_jobs.rs` as its shape.

---

## 12. Risks

| risk | why it matters | mitigation |
|---|---|---|
| the resume carrier (§4.3) | without it the scheduler cannot work at all | settle it before 4a-3; it is one field and one emission |
| async wat fixture churn | a regenerated fixture can hide a real change | review the diff for "runtime appeared"; count stays 249 |
| the publish gate | Tension cannot build 4b until 0.3.0 ships | 4a is independent; publish 0.2.0 first |
| `droppedEvents` reading | a wrong offset silently wakes nothing | `checkLayout` already pins `FrameState.droppedEvents == 4` (`wire.ts:384`) |
| the `-EIO` rule waking too much | one lost completion fails every task on the family | that is the rule's stated cost (§6.4); the region is the recovery path |

---

## 13. Recommendation: Phase 4 before C5

**Phase 4 first.** Reasons, from this scope:

1. **Phase 3's guarantee is shape-only.** Every async test today asserts emitted
   wat, because every entry traps. The layering (async → closures → `$env`) has
   never been executed. C5 builds *more* capture shapes on top of an unexecuted
   foundation; a bad layering decision would be discovered after C5 had extended
   it.
2. **C5's own correctness needs a runtime.** Parent-chain captures are about
   environment lifetime across scopes; proving them requires running a program
   that suspends with a nested env — exactly what 4a–4d deliver.
3. **Blast radius.** 4a and 4b are TensionScript-only, gated by the existing
   suites; the Tension side begins at 4c. C5 touches the closure transform, which
   today every closure fixture depends on.
4. **Payoff.** Phase 4 turns the async work into something a game can use
   (`await rt.job(...)`), which is the whole reason the plan exists.

C5 is the right next phase *after* 4d (values), and it can run in parallel with
4c/4e if the architect wants concurrency — they touch different transforms.

---

## 14. Decisions requested

1. Record layout in std, with `__taskBindRecordFactory` as the subclass hook
   (§4.1) — or keep the layout in the framework and defer TensionScript-side
   runtime tests?
2. Resume carrier: `TaskState.resume` field (recommended) or a
   `__taskRegister(state, resume)` parameter (§4.3)?
3. 4a's scope: settled path only (recommended, §9), or add a guest-side producer
   to prove park/resume earlier?
4. Publish 0.2.0 unchanged, then 0.3.0 for Phase 4 (§6.3)?
