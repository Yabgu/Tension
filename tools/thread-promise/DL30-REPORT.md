# DL30 — the serve-chain link, isolated; and a body that really suspends

**Round:** DL30, 2026-11-23. **Diagnosis only — no fix applied**, per the brief: the
`__spawnIndexOf` change and the serve chain are the I60 governance seam.

**Baseline:** `Tension` `integration/dwarf-debug` @ `693cc4b`, clean, nothing unpushed.
`TensionScript-a2` `main` @ `3f59ec08`, clean. Bundle **`aa74d6a1`**. Binary
33 653 336 B @ 2026-11-23 18:56:30, newest source `thread.rs` @ 18:56:00, **0 newer**.
`package-lock.json` clean; no `npm install` ran.

---

## 1. What this round was asked, and what it answered

DL29 bounded the defect from outside: an async worker entry prints nothing, index 4 (the
factory) and index 3 (`$spawnStart`) both produced no worker line, and index 0 (the body
continuation) ran. It could not say **which link** breaks, because the only instrument was a
worker that printed nothing.

**Q1's answer, in one line:** `__serveOne` resumes the served continuation and gets **`-1`**
back — `__resumeTask`'s "ran to completion" sentinel — so its `if (awaited >= 0)` guard skips
`e.ready.push`, and the task the factory just created and bound is **orphaned in the slot
table**, never driven, never settled. Measured directly: after serving index 4 the slot table
holds `slot 4: a task, .entry=3, .settled=0`.

**Q2's answer, in one line:** both index 0 and index 3 run a genuinely-suspending body up to
the suspension, and it is **never resumed** — because the stackful suspension records
**0 parks** with the host, so no completion can ever reach it. The run exits 0 in ~1.04 s with
no AFTER line.

**And a correction to DL29**, which changes the size of the problem: DL29's "finding 2"
(index 3 also fails) was **an artifact of its own probe**. Its `STOP_FIRST` knob defaults to
`true`, and that path calls `__executorExit(1)` **before** joining — main kills the worker
before it serves. With `STOP_FIRST=false`, index 3 **runs the body**. §6 has the measurements.

So the defect is **one** thing, not two: `__spawnIndexOf` answers the factory's index where the
serve path needs `$spawnStart`'s.

---

## 2. Declared before the first run

- **Instrument:** guest-side probes. No `std` print, no `src` change, so the bundle is never at
  risk; expected to end on `aa74d6a1` and it did.
- **Route:** reproduce the serve chain in a store I can print from — main's own store, and then
  a worker's store through a **sync** entry (which DL23 measured *does* run), calling the same
  exported internals `__workerMain` → `__serveOne` call.
- **Timeout:** 25 s per run. A timeout means a worker parked and nothing resumed it.
- **Pinned shape:** one `__spawnIndexOf` call site per probe, so `$starts` stays the 5-entry
  shape DL29 pinned; the element segment is quoted for every build in this report.
- **Predicted:** the factory's resume would answer a heap pointer (DL29 saw
  `__workerMain answered 170176`). **Wrong** — it answers `-1`. §9.

---

## 3. Q1 — which link breaks

### 3.1 The chain is sound in main's store

`tools/thread-promise/programs/serve-chain-probe.ts` — `__taskBindTable`, then
`__serveSlot(3)` → `__resumeTask` → `__taskAt` → `__resumeTask`, printing every value:

```
step 0: task table bound
step 1: __spawnIndexOf(workerEntryAsync)=4 (expect 4 = the factory)
step 2: __serveSlot(3)=1
step 3: __resumeTask(serveSlot)=2
step 4: __taskAt(2)=a task, its .slot=2, .entry=3, .settled=0
BODY: workerEntryAsync ran
step 5: __resumeTask(awaited)=-1
```

Element segment (5 entries, the pinned shape):

```
elem $$starts$elem (table $$starts) (i32.const 0) func
  $serve-chain-probe/workerEntryAsync$start $~asyncMainStart $~lib/async/__coreloopAwait
  $serve-chain-probe/workerEntryAsync$spawnStart $serve-chain-probe/workerEntryAsync
```

### 3.2 The chain is sound in a worker's store too

`serve-chain-probe-worker.ts` runs the same steps **inside a worker**, entered through a sync
entry so the defect cannot prevent the probe from running:

```
W: worker entry ran (sync)
W step 0: task table bound
W step 1: __spawnIndexOf(workerEntryAsync)=4
W step 2: __serveSlot(3)=2
W step 3: __resumeTask(serveSlot)=3
W step 4: __taskAt(3)=a task, .slot=3, .entry=3, .settled=0
W-BODY: workerEntryAsync ran (in the WORKER's store)
W step 5: __resumeTask(awaited)=-1
W probe: done (the W-BODY line is the pass condition)
```

So `__serveSlot` → `__resumeTask` → `__taskAt` → `__resumeTask` works, in both stores. **The
chain is not the defect.**

### 3.3 The failing link, with its value

`serve-index-probe.ts` serves index 3 and index 4 side by side, then scans the table:

```
api: __spawnIndexOf(workerEntryAsync)=4  (4 = the factory)
--- serve spawnStart (index 3) ---
spawnStart: __serveSlot=1
spawnStart: __resumeTask(slot)=2                     ← a slot id: queueable
spawnStart: __taskAt(awaited)=a task, .slot=2, .entry=3
BODY: workerEntryAsync ran
BODY: after the await, value=0
spawnStart: __resumeTask(awaited)=-1
--- serve factory (index 4) ---
factory: __serveSlot=3
factory: __resumeTask(slot)=-1                       ← THE VALUE
--- scan: tasks in the slot table after both serves ---
slot 2: a task, .entry=3, .settled=1
slot 4: a task, .entry=3, .settled=0                 ← created, bound, orphaned
```

**The failing link is `std/assembly/thread.ts:1174-1184`, `__serveOne`:**

```ts
let awaited = __resumeTask(slot);
if (awaited >= 0) {
  …
  e.ready.push(awaited);
}
```

`__resumeTask`'s contract (`src/builtins.ts:12654-12680`, quoted verbatim):

> ```
> //   record the slot the continuation will read,
> //   resume table[slot] with an `on $await` handler,
> //   normal completion: store the status, answer -1,
> //   suspension: write the suspended continuation back at the same slot and
> //   answer the payload the suspension carried.
> ```

The factory `f` **runs to completion** — it creates the record, installs `f$start`, binds the
task, returns the task — so the resume answers **`-1`**, `awaited >= 0` is false, nothing is
queued, and the task at slot 4 is left unsettled forever. That is the whole defect:

> **A task is created and bound by the served continuation, and the served continuation
> reports "no suspension", so the executor has no reason to ever run it — and no sentence is
> printed, because nothing was refused.**

The serve chain the brief asked about (`__serveOne`'s `awaited` → `e.ready` → `driveReady` →
`__resumeTask`) is therefore **correct as written**. It is handed the wrong entry.

---

## 4. Q2 — does a body that genuinely suspends serve at all

### 4.1 The first construction did not suspend, and that is a finding

`serve-suspend.ts` v1 used `await pendingJob(KEY)` — the same idiom as
`tests/programs/thread/wake-on-worker.ts`. Under the stackful shell it **does not suspend**:
both entries ran straight through it, `wakes served=0`, `recorded 0 park(s)`, and the host's
`--post-completion` stayed `buffered`. The Promise-path park only exists on the non-stackful
shell; on the stackful shell this await resolves synchronously with `value=0`.

### 4.2 A body that really suspends also loses its spawn entries

v2 used `RemotePolicy(1, 0, -1).await(...)` — the real suspension (`stackful-external-await.ts`,
DL23 Q4). The `$starts` table collapsed:

```
elem $$starts$elem (table $$starts) (i32.const 0) func
  $~asyncMainStart $~lib/async/__coreloopAwait $serve-suspend/workerEntryAsync
(table $$starts 3 3 funcref)
```

**Three entries — no `$start`, no `$spawnStart`** — because `asyncShellSuspends` is syntactic
(DL23 Q1): `policy.await` is not an `await` expression, so the function is not lowered as a
suspending body. For such a body, "serve it by index 0 and by index 3" **is not expressible**:
index 0 is main's start, and index 3 does not exist (`ENTRY=3` trapped inside
`__workerMain(1)`). This is itself worth knowing: a program whose only suspension is a policy
await gets no spawn entry at all.

### 4.3 The measurement the brief asked for

v3 keeps a **syntactic** `await leaf()` so the stackful shape survives, and adds the **real**
`policy.await` after it. Table back to 5 entries with both siblings. Both entries, 25 s
timeout, `--post-completion 4,7`:

```
ENTRY=0 (body continuation)
main: ENTRY=0 (body continuation)
main: __spawnIndexOf(workerEntryAsync)=4
main: spawn=0
W-BODY: entered
W-BODY: leaf=0
main: wakes served=0
main: join=0
main: done
EXIT=0 elapsed=1043ms
  thread: executor 1 left its session loop after 0 wake(s)
  thread: executor 1 left the park seam having recorded 0 park(s)

ENTRY=3 ($spawnStart)
… identical, EXIT=0 elapsed=1042ms
```

**Both entries run the body up to the suspension and stop there.** The pass condition — the
line after `policy.await` — is never printed in either. `recorded 0 park(s)` is the sentence
that explains it: the stackful suspension registers **nothing** with the host, so the sticky
completion has no park to attach to and no wake can ever be served.

**What the timeout would have meant:** that the worker parked and stayed parked — the "cannot
host a suspended body" answer. It did not happen: the run ends cleanly, in ~1.04 s (my own
bounded wait), because the worker's loop finds nothing to do and the executor stops. A
suspended body that nobody can wake is indistinguishable, from outside, from a body that
finished — except that its continuation is still suspended.

**Consequence for I60:** the served path cannot host a suspending body, and index 0/3 make no
difference to that. The suspension itself never becomes a host-visible park, so nothing short
of the `resume(store, ContRef, tag, payload)` primitive DL23 named can resume it.

---

## 5. Q3 — the seams, quoted, not applied

### 5.1 The `__spawnIndexOf` seam (compiler)

`src/builtins.ts:12432` `builtin_async_spawnIndexOf` resolves the argument to a `Function`
`target`, registers `target.internalName`, and hands the name to `emitStartsTable`:

```ts
compiler.spawnIndexTargets.set(helper, target.internalName);   // builtins.ts:12487
```

`src/compiler.ts:1670-1701` then does the damage in two steps — it **adds the factory** to the
table, and it **answers the factory's index**:

```ts
let helpers = this.spawnIndexTargets;
for (…) { … if (!known) names.push(target); }                  // compiler.ts:1677
…
for (…) {
  let index = -1;
  for (let j = 0; j < count; ++j) {
    if (unchecked(list[j]) == target) { index = j; break; }    // compiler.ts:1697-1698
  }
  module.addFunction(helper, TypeRef.None, TypeRef.I32, null, module.i32(index));  // :1700
}
```

The builtin's **own doc comment contradicts it** (`builtins.ts:12413-12416`):

> `// __spawnIndexOf(start: () => i32) -> i32`
> `// The `$starts` index of a synthesized `f$spawnStart`, so a task can carry the`

The change that satisfies it: answer the index of the **`$spawnStart` sibling**, whose name the
lowering already computes at `src/async/stack.ts:693` —

```ts
spawnName = name + SPAWN_SUFFIX;     // SPAWN_SUFFIX = "$spawnStart"  (stack.ts:125)
```

— and which the lowering already registers into `$starts` (`stack.ts:686` names it in
`__spawnIndexOf(f$spawnStart)` when it fills `TaskBase.entry`). Concretely, in
`emitStartsTable` the name pushed and searched for a spawn entry must be `target +
"$spawnStart"` when that sibling exists, falling back to `target` for a plain function
(`__workerMainPlain` uses `__spawnIndexOf` on sync entries, where no sibling exists). The test
that separates the two cases is the same one the lowering already makes: a parameterless async
function gets a spawn entry (`async/stack.ts:685-693`); anything else does not.

**Layer: compiler.** Nothing a guest or the host can do can substitute — the host sees only an
`i32` index, and "is this index an async factory" is guest-only knowledge (DL29).

### 5.2 The serve chain (std) — no change needed

The link Q1 named is `std/assembly/thread.ts:1174`:

```ts
let awaited = __resumeTask(slot);
if (awaited >= 0) {
  let taskOrNull = __taskAt(awaited);
  …
  e.ready.push(awaited);
}
```

This is **correct for every entry it is meant to be given**. `$spawnStart` suspends while
creating the task and yields the task's slot, so the guard is true and the task is queued
(`serve-chain-probe`, `serve-chain-probe-worker`, and `serve-suspend` ENTRY=3 all confirm).
Given the factory it behaves exactly as specified: the factory does not suspend, `-1` means
"nothing to queue". The `__serveOne` doc block (`thread.ts:1150-1165`) already states the
contract — *"`$starts[funcIndex]` is `f$spawnStart`, which creates a task and parks on it
without running the body"* — and the defect is that `$starts[4]` **is not `$spawnStart`**.

Its own words: the serve path is written for the sibling the index fails to name.

**Layer: std is already correct; compiler is where the wrong index is produced.** If a defence
in std is wanted anyway, the honest one is not a silent scan of the slot table — it is a
**refusal**: a served continuation that answers `-1` while the current task slot gained an
unsettled record is exactly the orphaned shape, and the run should fail by name. That would be
a guard, not a fix, and it belongs to I60's decision, so this round did not write it.

---

## 6. The DL29 correction — finding 2 was a probe artifact

DL29 reported that index 3 (`$spawnStart`) also produced no output, and concluded there were
**two** independent failures. Re-running DL29's own committed probe shows the cause is its
`STOP_FIRST` knob, whose default is `true`:

```ts
line("main: spawn=" + __spawnThread(1, INDEX, 0).toString());
if (STOP_FIRST) __executorExit(1);        // ← kills the worker before it can serve
line("main: join=" + __threadJoin(1).toString());
```

Measured, DL29's probe unchanged except the two constants:

```
INDEX=3  STOP_FIRST=true   → main: spawn=0, join=0, done. No worker line. EXIT=0
INDEX=3  STOP_FIRST=false   → main: spawn=0, worker: entered (async entry)   EXIT=124
INDEX=4  STOP_FIRST=false   → main: spawn=0, no worker line                  EXIT=124
```

So index 3 **does** run the body once the worker is allowed to serve, and index 4 does not —
which is the single defect §3 names, visible from outside. The `EXIT=124` is the known
pool-lifetime hang (main joins a worker nobody stopped), not a serve failure: the probe's
`STOP_FIRST=true` half exists precisely to avoid it, and it also prevents the serve.

`stackful-worker-index.ts` is restored to its committed state (`INDEX=4`, `STOP_FIRST=true`),
verified by `git status`. **The defect DL29 found is real and its index answer is right; its
"two failures" is one failure, and the second was the instrument.**

---

## 7. Gates

- `--bin` **307** (default features; the `--no-default-features` build is **298**, 9 behind a
  feature — stated so the number is not mistaken for a change).
- `--test threads` **8** · `--test fiber` **6** · `--test fiber-executor` **7** — all pass.
- Bundle **`aa74d6a1`**. `TensionScript-a2` clean: **0** files changed under `std/`, **0** under
  `src/`.
- **`std` "byte-identical" is verified differently than in earlier rounds, and I am correcting
  the check rather than repeating it:** there is no `dist/std` in this tree
  (`ls dist/std` → no such file), so the `cmp` earlier rounds describe has no target here. What
  is true and checkable is that the installed compiler reads the tree's `std/` and the tree is
  unmodified: `git status --porcelain std/` → 0 files. My first `cmp` against
  `dist/std/assembly/thread.ts` reported DIFFERS, which was a **missing path**, not a diff —
  recorded because a bare "differs" in a gate list is exactly how a false alarm becomes a
  finding.
- **Census and `test:compiler` skipped**: nothing compiler-side or `src`-side changed (0 files
  in both), which is the brief's stated condition.

---

## 8. Declared versus measured delta

| item | declared | measured |
|---|---|---|
| probes | 4 (guest-side), bundle `aa74d6a1` | 4, bundle `aa74d6a1` |
| timeout | 25 s | 25 s |
| `--test threads` | 8 | **8** |
| `--test fiber` | 6 | **6** |
| `--test fiber-executor` | 7 | **7** |
| `--bin` | 307 | **307** |
| census / `test:compiler` | may skip | **skipped**, 0 compiler/src files |
| `tension-core/src`, `src/`, `std/` | unchanged | **unchanged** |
| test/CI counts | no change | **no change** |

**Touched beyond the brief's naming:** the brief assumed two probes ("the probe(s)"); this
round needed four, because each measurement that *worked* invalidated the next assumption
(main vs worker store; index 3 vs 4; a syntactic-plus-real suspension). All four are committed
as instruments, not as tests. Nothing else was touched.

---

## 9. Bugs I made, and what caught them

1. **Predicted the wrong value.** I declared the factory's resume would answer a heap pointer
   (from DL29's `answered 170176`) and reasoned from there. It answers **`-1`**. Caught by
   printing it (3.3) instead of trusting the inheritance — the same slip DL29 made in the other
   direction by inferring a pointer from a status word.
2. **Two compile errors in my own probes**, both caught by the compiler and fixed before any
   run: `let index, label: string;` (TS1110, no shared type annotation), and an initial build
   with no exported `main` (AS100: *"the stackful backend requires an exported main"*).
3. **`$starts` shifted on me twice more** — 6 entries when I added a second `__spawnIndexOf`
   call site, and **3 entries** when the body's only suspension was `policy.await`. Both caught
   by dumping the element segment before trusting an index. The second one is a real finding
   (§4.2), not just a trap.
4. **A run that looked like success.** `serve-suspend` v1 printed `after the await, value=0`
   and I nearly recorded "a suspending body serves". It had not suspended at all —
   `recorded 0 park(s)` caught it. The pass line was not the proof; the park count was.
5. **The `std` gate false alarm** in §7: `cmp` against a path that does not exist reads as a
   diff.

---

## 10. What I did not verify

- **The fix.** Not applied, per the brief — the seam is quoted, not exercised. I have not built
  a compiler with the `$spawnStart` index correction, so "index 3 is sufficient" is measured
  for *serving by index 3*, not for `__spawnIndexOf` returning 3.
- **Why index 4 ends in `EXIT=124` rather than exit 0 inside the worker.** In main's store the
  same serve ends cleanly; in a worker the loop waits on an empty inbox forever. I did not
  trace whether the orphaned task leaves the worker's `ready`/`inbox` genuinely empty or
  whether something else keeps it parked — it is consistent with the orphan hypothesis, and I
  have not proven it is not a second cause.
- **`f$spawnStart`'s compiled signature.** Inferred from `cont.new` not trapping, not read out
  of the WAT as a typed func.
- **Parameterized async entries.** Only parameterless functions get `$spawnStart` (Gate 3d,
  `stack.ts:685`); a parameterized served entry was not measured.
- **Whether a *non*-sticky ordering changes Q2.** The body suspended with a sticky completion
  already buffered; with `--post-completion-after-parks` the park would still be 0, since the
  park never reaches the host — but I did not run it to show that.
- **The 3-entry finding across other body shapes.** One shape was measured (`policy.await`
  only). A body with no `await` at all, or with `await` inside a nested function, was not.
