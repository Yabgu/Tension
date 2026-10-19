# The scheduler contract in Tension — 0.7.0 implementation plan

**Status:** planning only. No code in this dispatch.
**Companion:** TensionScript `docs/scheduler-contract.md` (normative).
**Target:** Tension 0.7.0, on top of 0.6.0a/0.6.0b.
**Tree:** Tension `next` @ `8046327` plus the uncommitted 0.6.0a bump.

This plan answers one question: **given the contract, what does Tension have to
change, and what is the evidence that each change is real?** It is deliberately
specific — structures, threads, call sites, commit order — because the contract
deliberately is not.

A note on the version boundary: the contract's `park` is a guest→host call, so
the std half (`std/assembly/task-rt.ts`) must call a host import. That is a
TensionScript release, and it must ship *with* the Tension host that provides
the import: a guest built against the new std cannot instantiate on an old host.
The plan therefore proposes a co-released pair, and flags it as a decision
(§11.2).

---

## 1. The chain today, measured

The shipped scheduler is a pull at both ends and a poll in the middle:

| # | Step | Site |
|---|---|---|
| 1 | The transform records the continuation and emits `__taskPark(state, awaited)` when the await is unsettled | `src/async/lower.ts:1679-1695` (TensionScript) |
| 2 | std registers `(family, key) → record` in the flat `waitingByKey` map, or a `record → states` list | `std/assembly/task-rt.ts:193-260`; the maps are declared at `:88-104` |
| 3 | A producer posts: the loader worker calls `sink.post_event(JOB_DONE/JOB_FAILED, job_id, …)` | `tension-ogre/src/loader.cpp:433-439` |
| 4 | The posting side enqueues into a bounded per-class `ClassQueue`; `Sync`, any thread | `tension-core/src/session/posting.rs:102-196` |
| 5 | The guest calls `RuntimeSession.wait`, the host runs an epoch: queues flush into the arena ring, then `onBatch`/`onEvent` are invoked **on the guest thread, inside the host call** | `session/mod.rs:1376-1383`; `epoch.rs:142-165` (flush), `:192-240` (invoke) |
| 6 | The framework's `rt.deliver` hands five words to `__taskDeliver`; std copies them and queues the parked states | `runtime/rt.ts:147-160`; `task-rt.ts:264-300`, `:360-390` |
| 7 | The guest calls `rt.runReady()` → `reportDrops()` + `__taskTick()`; `__taskTick` drains the ready queue and resumes | `runtime/rt.ts:137-140`; `task-rt.ts:389-405` |
| 8 | Two guest pumps sit on top: `settleTask` and the AI REPL | `examples/ogre/bouncing-bodies/game.ts:128-141`; `examples/ai/story.ts:77-80` |

Step 5 is the pull (the guest asks the host to wait). Step 7 is the pull (the
guest asks the scheduler to run). Step 8 is the poll. The contract's `wake(ids)`
replaces steps 6–8 with one host call at a boundary the host owns.

The measured consequence of the current shape: **there is no host loop outside
the guest.** `tension-core` calls `_start_game` and tears down
(`main.rs:1226-1260`); the OGRE adapter's render thread runs independently
(`adapter.cpp:344-395`), and the guest's own loop is what consumes frames
(`game.ts:408-411`). The 0.7.0 inversion is therefore not a scheduler tweak: it
moves the loop from the guest to the host.

---

## 2. Per-class lookup structures

The contract requires bounded, O(1) matching and a key space the class
declares. These are Tension's structures. The flat
`Map<(family, key), TaskRecord>` (`task-rt.ts:95`) is a placeholder and goes
away; the replacement is host-side, because the host must name ids to call
`wake`.

| Class (id) | Key space | Structure | Bound | Evidence |
|---|---|---|---|---|
| `JOB_DONE` (4), `JOB_FAILED` (1) | job id | direct array, `index = id - 1`; the loader's table *is* the structure | 768 | `loader.h:119` (`kCapacity = 768`), `loader.cpp:107-108` (slot vector), `:220` (`job_id = index + 1`) |
| `RESOURCE_READY` (5), `RESOURCE_FAILED` (2) | resource id | direct array indexed by id; the loader's `resources_` vector is the same shape | 1024 (the region ceiling) | `loader.cpp:297` (`-ENOSPC` past 1024), `:313-315` |
| `AI_READY` (10), `AI_DONE` (11), `AI_ERROR` (12) | session handle | direct array, `index = handle - 1` | 4 | `ai/mod.rs:114` (`MAX_SESSIONS = 4`) |
| `FRAME` (9) | `key = 0` | one slot | 1 | `wire.ts:56`; mode `POLLED` (`arena.rs:275-289`) |
| `INPUT_KEY` (6), `INPUT_MOUSE` (7) | input key | direct array per class | 256 each | ring capacities, `arena.rs:266-267` |
| TIMER (no wire class today) | deadline | min-heap keyed by `(deadline, task_id)` | the class's declared capacity | the repeated wake shape, contract §1.5 |
| any future user class | producer key | tag-verified direct-mapped: `bucket = hash(key) & (capacity - 1)`, tag = the full key, bounded probe (4) | capacity | contract §3.3 |

Rules that come from the table:

- **A park outside the key space is refused**, not wrapped: a job id ≥ 769, a
  session handle ≥ 5, a frame key ≠ 0. The class's error is returned by
  `park`; the task does not wait for a completion that cannot arrive
  (contract §4.9, §5).
- **A direct-mapped collision** beyond the probe bound refuses the park with
  the class's error. It does not grow, chain unboundedly, or overwrite.
- **The pre-park buffer is per class, sized to the key space** (one pending
  completion per key for a one-shot/coalescing class; `k` per key for a class
  that declares `k`). Because the key space bounds the buffer, there is no
  eviction path for a conforming class (contract §4.3).
- **The key is never minted by the runtime.** The executor uses the producer's
  id verbatim, as `__taskDeliver` does today (`task-rt.ts:264-278`).

---

## 3. The executor and the manager

### 3.1 The partition

The class → executor map is fixed at session open, host-side. It sits next to
the family bindings the framework makes at `rt.start()` (`rt.ts:78-86`), but it
is the host's table, not the guest's:

- **JOBS + RESOURCES** → the loader/render family.
- **AI** → the AI family.
- **FRAME + INPUT + TIMER** → the owner.

A class belongs to exactly one executor, so a park and its completion meet in
one place and exactly-once is structural (contract §3.5).

### 3.2 Tension's first implementation: one executor, temporal separation

The first 0.7.0 cut uses **one executor: the Store's owner thread**, because
the owner is already where the epoch runs and where `wait` blocks. It performs
the two phases in order, with no guest code between them:

1. **wait** — block on the session's existing condvar
   (`wait_for_events(-1)`, `posting.rs:320-350`) or on a frame-complete signal;
2. **match** — drain each class's posting queue, look up `(class, key)` in the
   per-class structure, append the matched `task_id` to a ready batch, and then
   flush the same batch to the ring for the classes whose delivery mode says
   `RING` (so the sync path keeps its copy);
3. **wake** — call the guest's `wake(ids)` export.

The *match* touches only the park table and the queues. The ring flush and the
wake touch the Store, and both run on the owner thread. When the executor is
split onto a manager thread, only the match moves — and it never touches the
Store. When the phases share a thread the separation is temporal; when they
are split it is spatial.

**Why one is enough for 0.7.0.** Every producer already posts through a
`Sync` queue (`posting.rs:1-14`), so a dedicated manager thread would add a
second thread to move records the owner is about to consume anyway. The
per-class structures and the partition are in place, so splitting later is a
change to the class → executor map, not a redesign.

### 3.3 When a second executor is justified

Split when a class's completions are produced on a thread that already owns the
matching: the render thread drains loader completions and realizes resources
(`adapter.cpp:347`), so RESOURCES could match there; the AI worker produces
tokens, so AI could match there. Both then queue ids to the owner. The
contract's §3.4 is what makes this safe: a manager never touches the Store, so
the only shared state is the park table (per-class lock) and the id batch (a
small `Sync` queue).

### 3.4 Synchronization

- **Park table:** one mutex per class, or one per executor. Writers: parks
  (owner thread). Readers/removers: matches (executor). A completion that
  arrives with no park is written to the per-class buffer under the same lock,
  so a park cannot race the buffer's claim.
- **Id batch:** a `Mutex<Vec<u64>>` (or a lock-free MPSC if measured to
  matter). Producers: executors. Consumer: the owner, once per boundary.
- **Nothing in the manager calls into the Store or the guest.** That is the
  invariant that keeps a split safe.

---

## 4. The host main loop

### 4.1 OGRE

The render thread already blocks on a real primitive — `renderOneFrame()`
(`backend_ogre.cpp:526`) with vsync when enabled, paced by
`cv.wait_for(period)` (`adapter.cpp:395`). It keeps that. What changes is that
the **Store owner stops being the guest**:

```
after _start_game returns:
  loop:
    wait for (frame-complete | ready ids)          // condvar, real wait
    run the epoch: drain queues → match → queue ids
    flush the RING-mode classes to the ring
    if a FRAME task is parked: add its id
    wake(ids)                                      // guest resumes, runs, parks
```

- The frame boundary is the wake boundary. A frame that produced no completion
  still wakes the FRAME task, which is the point of the frame task.
- The render thread never calls `wake`; it signals the owner.
- The loader worker's post (`loader.cpp:439`) and the render thread's
  realization (`adapter.cpp:347`) keep their threads; only the *wake* moves.
- The guest's verbs (`ogre.submit*`) still run on the owner thread, and the
  adapter's `scene_mutex` already serializes them against the render thread
  (`adapter.cpp:352-356`). No new lock is introduced.

### 4.2 The CLI (`tension-core`)

There is no loop today: `main.rs:1226-1232` calls `_start_game` and the process
tears down after it returns (`:1250-1260`). 0.7.0 adds one:

```
after _start_game returns:
  loop while the guest has a live frame/task:
    wait_for_events(-1) or the frame timer     // condvar, real wait
    run the epoch; match; queue ids
    wake(ids)
```

The AI example needs exactly this loop (its "frames" are stream chunks). The
`readLine()` call inside the REPL task blocks the owner on stdin — a real wait,
not a poll — and no generation is in flight while it is blocked. A future
concurrent REPL would have to fold stdin into the host's wait (`poll(2)` on
stdin plus an eventfd for completions); that is named here so it is not
discovered as a spin later.

### 4.3 The "is this a host-driven guest?" question

A sync guest keeps its own loop inside `_start_game` and returns only at exit.
An async guest returns after spawning `gameLoop()`. The host must know which it
is before it starts a loop, or a sync guest would get an empty second loop
after it has already finished. Options are in §11.4; the recommendation is a
framework-provided export (`_game_running(): i32`) that the host checks after
`_start_game`, rather than a new arena word.

---

## 5. The guest's frame loop

```ts
async function gameLoop(): void {
  while (running) {
    await rt.frame();
    update();
    render();
  }
}

export function _start_game(): void {
  rt.start();
  gameLoop();          // floating task; runs to the first park
}
```

- `gameLoop()` is a **floating task**: the call runs its synchronous prefix and
  parks at the first `await rt.frame()`; the discarded handle is fine, because
  the park roots the state (contract §4.1; `docs/async-await-plan-v2.md` §6.5
  already states that a task nobody awaits still runs).
- `rt.frame(): Task<void>` is class `FRAME`, `key = 0`. The host adds the
  parked id to the batch at each frame boundary; nothing is posted to the ring
  for it (class 9 is `MODE_POLLED`, `arena.rs:275-289`).
- There is **no `while` around a wait** in the guest. The loop is a loop over
  frames, not over readiness.
- `_start_game` does setup only. It returns; the host owns the loop.

`spawn` is not a language keyword: the call-and-discard above is the shape
today (§6.5's floating tasks). If 0.7.0 wants an explicit `spawn`, that is a
language addition on top of this plan, not a requirement of the contract.

---

## 6. `settleTask`'s deletion

The pump at `game.ts:128-141` exists because `_start_game` must not return
until the loader's job is done, and the only way to make progress is to call
`wait` + `runReady` in a loop. Under the contract the loader is a task that
awaits, and the host's `wake` resumes it:

```ts
async function setup(): void {
  const mesh = await loadMesh("bouncing-bodies.mesh", 0);   // parks; host wakes
  if (mesh < 0) fail("mesh did not load (errno " + mesh.toString() + ")");
  // ... the rest of the setup that needs the mesh ...
  gameLoop();                                                // start frames
}

export function _start_game(): void {
  rt.start();
  setup();
}
```

- The `settleTask` guard loop and the `while (!task._record.done)` pattern go
  away.
- `grab()` (`game.ts:142-160`) loses its `for (guard…) { wait(5); runReady() }`
  and becomes `await rt.frame(); await rt.frame();` before reading the
  screenshot — a frame-shaped wait, not a retry loop.
- The `run()` frame loop (`game.ts:408-411`) is replaced by `gameLoop()`.
- The loader's error path is unchanged: the job still fails through
  `JOB_FAILED` (`loader.cpp:433-436`), the wrapper still returns the errno, and
  the task observes it as a negative value.
- The frame loop does **not** run during setup: `gameLoop()` is spawned after
  the awaits. The OGRE adapter keeps rendering empty frames while the loader
  works — the same visual as today, without the guest pumping.

---

## 7. The AI example

`story.ts` opens a session, adds the system prompt, and runs a REPL. The poll
at `:77-80` becomes:

```ts
async function repl(): void {
  while (true) {
    write("you> ");
    const line = readLine();                 // blocks on stdin — a real wait
    if (line === null) break;
    // ... commands ...
    session.add(AiRole.User, text);
    if (!session.generate()) { ... continue; }

    write("ai> ");
    while (true) {
      const n = await rt.stream(session);    // parks; resumed by AI_READY/DONE/ERROR
      if (n < 0) { /* class-delivered error */ break; }
      if (n == 0) break;
      write(session.read());
    }
    print("");
  }
  session.close();
}

export function _start_game(): void {
  // open the session, add the system prompt
  repl();
}
```

- `session.state()` is not in the loop. The stream's class decides data / done
  / error (the 0.6.0b design: `AI_READY` → unread count > 0, `AI_DONE` → 0,
  `AI_ERROR` → negative), never the payload alone.
- The 0.6.0b host posts the coalesced signal; this plan consumes it through
  the same executor, one parked stream task per session.
- The REPL task's `readLine` blocks the owner thread. That is a real wait
  (contract §3.2), but it means the host is not driving wakes during input —
  acceptable here, because the REPL has no frames and no generation in flight.
- **Container status (measured):** the GGUF is present
  (`examples/ai/models/Phi-3-mini-4k-instruct-q4.gguf`, 2.3 GB) and the `ai`
  feature is default-on (`Cargo.toml:7-13`), but the current
  `tension-core/target/debug/tension-core` is the **stub** build (its strings
  carry `[ai-stub]`), because the tree is built with
  `--no-default-features --features audio`. A real llama.cpp run requires the
  `ai` feature build (a ~2 min vendored C++ build). The 0.7.0 gate for this
  example must state which backend it exercised.

---

## 8. The migration: `__taskTick` → `__taskWake`

**The choice: add `__taskWake(idsPtr, count)` as the push entry and retire
`__taskTick`.** Not both. Keeping the pull entry leaves a second resume path in
the guest, which is exactly how the pumps survived to this point; the contract
says the guest must not need one (contract §2.2).

What changes, and in which repo:

| Piece | Change | Repo |
|---|---|---|
| transform | none — it still emits `__taskPark(state, awaited)` | TensionScript |
| std `__taskPark` | allocates an id, records the task in the id table, calls the host import `scheduler::park(id, class, key)` | TensionScript |
| std `__taskWake` | new export: for each id, look up the record/state and resume | TensionScript |
| std drop rule | moves host-side: the host reads its own counters and wakes the family's parked tasks; `__taskReportDrops` no longer reads the arena | TensionScript |
| host | new import `scheduler::park`; per-class tables; epoch match; `wake(ids)` call on the owner | Tension |
| framework `rt` | `reportDrops`/`runReady` retired; `rt.frame()`/`rt.stream()` added; `callbacks()` stays for non-awaitable classes | Tension |
| examples | `settleTask`, the poll loops, and the guest frame loops replaced | Tension |

Two compatibility rules:

- **The sync API is untouched.** `session.wait`, `session.drain`,
  `session.subscribe`, `session.pending` keep their ABI and semantics
  (`session.ts:18-35`). A sync guest that never parks is unaffected by the
  scheduler change; it still runs its own loop.
- **The ring's role becomes part of each class's declaration.** The executor
  matches from the posting queue and delivers by `wake`; a class whose
  declaration says `RING` (JOBS, RESOURCES, INPUT, LOG) is still flushed to the
  ring, so `session.drain(class)` sees its copy and the sync path is unchanged.
  A class whose declaration is executor-only (the AI stream) is not flushed:
  its transport is the reply buffer (`session.read`), and putting a chunk in
  the ring would be the per-chunk pressure the contract forbids. `session.drain`
  on such a class is empty by declaration, not by accident. The verbs
  themselves are untouched; the class's mode is what 0.6.0b declares and 0.7.0
  honours.

The record layout is unchanged (32 bytes, `task.ts`'s eight fields); the id is
an index into the guest's task table, and the host writes the result into the
record before `wake`. The contract keeps the layout out of its normative text
(contract §6).

**A park that finds a buffered completion.** The host queues the id for the
next wake batch instead of making the task wait. `park` keeps the contract's
`void` shape (contract §2.1), and §4.5's rule — a task is not resumed twice in
one batch — defines the boundary: the task resumes on the next `wake`, exactly
once, from the buffered result. The extra hop is a host call, not a poll.

---

## 9. The audit — every host wait site, measured

Classification: **blocking** (a real primitive; conforming), **drain** (does
not wait; must be driven by a real wait), **poll** (must be fixed).

| Site | File:line | Mechanism | Class |
|---|---|---|---|
| Loader worker waits for work | `loader.cpp:643` | `work_cv_.wait(lock, pred)` | blocking — fine |
| Loader `wait_for_idle` (test/introspection) | `loader.cpp:603` | `idle_cv_.wait_for` | blocking, bounded — fine |
| Loader stop/join | `loader.cpp:120-128` | `join()` | blocking — fine |
| AI worker waits for a job | `llama.rs:132` | `shared.cv.wait(inner)` | blocking — fine |
| AI generate handoff | `llama.rs:474-476` | set `run`, `notify_all` | signal — no wait |
| OGRE frame render | `backend_ogre.cpp:526` | `renderOneFrame()` (vsync when on) | blocking — fine |
| OGRE render-loop pacing | `adapter.cpp:395` | `cv.wait_for(period, pred)` | blocking, bounded — fine |
| OGRE teardown | `adapter.cpp:1439` | `cv.wait_for(timeout)` | blocking, bounded — fine |
| Guest session wait | `posting.rs:320-350` | `Condvar::wait` / `wait_timeout` | blocking — the suspension mechanism; 0.7.0 moves it host-side |
| Input event drain | `input.cpp:471` | `SDL_PollEvent` | drain — fine, while a real wait paces it |
| CLI host after `_start_game` | `main.rs:1226-1260` | **none — no loop** | **gap** — 0.7.0 adds the host loop |
| Guest `settleTask` | `game.ts:128-141` | `wait(10)` inside `while` | **poll** — delete |
| Guest `grab` | `game.ts:142-160` | `wait(5)` inside `for` | **poll** — delete |
| Guest AI REPL | `story.ts:77-80` | `session.state()` busy loop, no wait | **spin** — delete |
| Guest frame loops (every OGRE example) | `game.ts:408-411` | `wait(16)` + `runReady` in a loop | guest-driven — replaced by the host loop |
| Test-only sleeps | `epoch.rs:923` (10 ms), `posting.rs:681` (20 ms) | `thread::sleep` inside `#[cfg(test)]` (`epoch.rs:320`, `posting.rs:524`) | fine — tests |

The greps that must return zero after 0.7.0:

```
grep -rn "session.state()" examples/                     # 0
grep -rn "while .*_record.done" examples/                # 0
grep -rn "RuntimeSession.wait" examples/*/game.ts        # 0 (host drives)
grep -rn "thread::sleep" tension-core/src tension-ogre/src tension-input/src \
  | grep -v "#\[cfg(test)\]"                              # 0 in production
grep -rn "try_recv" tension-core/src tension-ogre/src     # 0
```

The first three are guest source; the last two are host source. A new wait
site must name its primitive in the same change (contract §8).

---

## 10. Commit plan and gates

Each commit is independently reviewable and has a gate that is measured, not
asserted.

| # | Commit | Repo | Gate |
|---|---|---|---|
| 1 | `docs: the scheduler contract` | TensionScript | the document; no code |
| 2 | `std: the park/wake seam` | TensionScript | `scheduler::park` import + `__taskWake` export; async suite; closure suite; fixtures; sync programs byte-identical |
| 3 | `core: the park table and the matcher` | Tension | `cargo test`; `framework_layout` (no layout change); `rt-dispatch`; a buffered-before-park unit test |
| 4 | `core: the host loop calls wake` | Tension | CLI + OGRE adapters build; a hand-written guest parks and is woken cross-thread |
| 5 | `framework: rt.frame and rt.stream` | Tension | `runReady` retired; the two wrappers; the four scheduler controls (exactly-once, buffered, ordering, no-poll) |
| 6 | `engine: the examples adopt` | Tension | bouncing-bodies + the five OGRE examples run; the AI example on a named backend |
| 7 | `test: the scheduler invariants` | Tension | the greps in §9; the multi-executor case if the split lands |

The 0.7.0 gate is the union of the above, plus the 0.6.0a/0.6.0b gates already
in flight. **Nothing in this plan changes the arena layout**, so the frozen
hash is not touched by 0.7.0; the park table is host-side and the guest's task
table is ordinary guest memory.

---

## 11. Open decisions for the ruling

1. **One executor or two in the first cut.** This plan recommends one (the
   owner), with the class → executor map in place so a split is a configuration
   change. A dedicated manager thread from day one is defensible; it adds a
   thread and a handoff for no measured gain at current event rates.
2. **The cross-repo release boundary.** The std half needs `scheduler::park`,
   so TensionScript and Tension must ship together (a guest built against the
   new std cannot instantiate on an old host). Name the pair (e.g.
   TensionScript 0.6.0 + Tension 0.7.0) and the pin.
3. **How the host learns a task's record.** Recommendation: one startup export
   `__taskBindTable(ptr, capacity)`, so `park` keeps the contract's exact
   three-argument shape and the host writes the result by id. The alternative —
   `park` carrying the record pointer — extends the interface for no semantic
   gain.
4. **How the host knows the guest is host-driven.** Recommendation: a
   framework export `_game_running(): i32` (1 while a frame or task is live),
   checked after `_start_game` returns; the host loop runs only when it says 1.
   A new arena word would move the frozen layout for a scheduling flag.
5. **The ring's role for awaited classes.** Recommendation (as §8): make it a
   per-class delivery mode — `RING` classes (JOBS, RESOURCES, INPUT, LOG) keep
   their flush, so `session.drain(class)` is unchanged; the AI stream is
   executor-only, because its transport is the reply buffer and a ring record
   per chunk is exactly the pressure the contract forbids. The alternative is a
   single path for every awaited class (no ring copy), which changes
   `session.drain` for jobs and resources and the counters in
   `FrameState.droppedEvents` — measurable, and not recommended.
6. **The drop rule's home.** Recommendation: host-side, because the executor
   already reads the class queues and the counters, and the guest should not
   need the arena layout to recover from a lost completion. This removes
   `rt.reportDrops`'s arena read (`rt.ts:111-133`) and keeps `__taskReportDrops`
   only if a guest-side pull implementation is retained.

---

## 12. What this plan does not do

- No code, no compiler change, no `tension-core` change, no example change.
- No removal of `settleTask` or the AI pump in this dispatch.
- No 0.6.0a or 0.6.0b work; they are in flight and untouched.
- No claim of green for anything. The only measured facts here are the wait
  sites in §9 and the build status in §7.
