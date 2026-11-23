# DL29 — the async worker entry: diagnosed to two seams, and neither is this round's

**The round stops at the seam, and the diagnosis is precise: there are two independent
failures, not one.**

1. `__spawnIndexOf(anAsyncFunction)` answers the **factory** — the `f` the lowering
   synthesizes to *construct a task and return it* — not `f$spawnStart`, the function that
   creates *and drives* it. Its own doc at `src/builtins.ts:12413` says it answers "the
   `$starts` index of a synthesized `f$spawnStart`"; for the lowering's internal call that is
   true, and for a user's call naming `f` it is not.
2. **Even `$spawnStart` does not run the body.** Spawning that index produces no output
   either, so correcting the index would not fix the defect.

And one positive fact that bounds both: **the body continuation itself runs when served.**
Spawn index 0 (the body's `f$start`) and the worker prints. So `__serveCont` → `cont.new` →
`__resumeTask` → ready → step is sound; what fails is everything between "a task is created"
and "its body continuation is resumed".

Reading `src/builtins.ts` is a **compiler** change and the serve/drive chain is **std**; both
are the brief's governance seam. So: no code changed, no test added, and the reason is stated
rather than worked around.

`~/work/Tension` `integration/dwarf-debug`: from **`2c90554`**, docs and one probe only.
`~/work/TensionScript-a2` untouched at **`3f59ec08`**, bundle **`aa74d6a1`**, std identical.

## 0. Phase 0

| fact | measured |
|---|---|
| `Tension` | `integration/dwarf-debug` @ **`2c90554`**, `git status --porcelain` **empty**, nothing unpushed |
| `TensionScript-a2` | `main` @ **`3f59ec08`**, clean, nothing unpushed |
| bundle | `aa74d6a1` (tree) = `aa74d6a1` (installed) |
| `package-lock.json` | clean; no `npm install` |
| binary | `33 653 336` B, mtime **2026-11-23 18:56:30** |
| newest source | `src/thread.rs` **2026-11-23 18:56:00** — 0 newer |

## A — the 2×2, re-run at `2c90554`

Rebuilt all four combinations from DL23's probe (its two knobs, restored to `false/false`
afterwards — `git status` on that file is clean). The engine needs **no** runtime flag; stack
switching is the *compile* flag `--enable stack-switching`, and the host picks the
continuations backend at startup (`async backend: continuations (wasmtime stack switching)`).
`--executors 2`, 25 s timeout, `STOP_FIRST` decides termination.

| `ASYNC_ENTRY` | `STOP_FIRST` | measured |
|---|---|---|
| false | false | `main: spawning / index=4 / spawn=0`, `worker: entered (sync entry)` → **EXIT=124** (25 s) |
| false | true | same lines, then `join=0 / done` → **exit 0** |
| **true** | false | `main: spawning / index=4 / spawn=0`, **no worker line** → **EXIT=124** (25 s) |
| **true** | true | same, `recorded 0 park(s)` → **exit 0, 0 s** |

**Identical to DL23's four rows.** Nothing has changed on the engine; the defect is exactly
where DL23 left it.

## B — the served body's call site, and the entry's kind

**The call site.** `std/assembly/thread.ts:1671-1674`, in `__workerMain`:

```ts
let entry = atomicLoad<i32>(sig + 16);
if (entry >= 0) {
  __serveOne(e, entry, atomicLoad<i32>(sig + 20), 0, 0);
}
```

`entry` is the `$starts` index `__spawnThread` wrote. `__serveOne`
(`thread.ts:1166`) does:

```ts
let slot = __serveSlot(funcIndex);       // -> __serveCont: cont.new over $starts[i]
let awaited = __resumeTask(slot);        // resume it with the shell's "$await" handler
if (awaited >= 0) { …; e.ready.push(awaited); }   // the *payload* is treated as a slot
```

and `__serveSlot` is `__serveCont(funcIndex)` (`task-stack.ts:62`), whose codegen
(`src/builtins.ts:12542`) is `cont.new(ref_cast(table.get($starts, funcIndex), () -> i32))`.

**The entry's kind.** I built the async variant with `--textFile` and read the element
segment. For a program that names an async function:

```
elem $$starts$elem (table $$starts) (i32.const 0) func
  $…/workerEntryAsync$start        ; 0  the BODY continuation (f$start)
  $~asyncMainStart                 ; 1
  $~lib/async/__coreloopAwait      ; 2
  $…/workerEntryAsync$spawnStart   ; 3  f$spawnStart: factory + drive() + return 0
  $…/workerEntryAsync              ; 4  the ENTRY: the factory (f)
```

and `__spawnIndexOf(workerEntryAsync)` answers **4** — printed by the probe as
`main: __spawnIndexOf(workerEntryAsync)=4`.

What a served function's *return* means is fixed by the lowering, `src/async/stack.ts:23-41`:
`f` (index 4) creates the record, installs `f$start`, binds it, sets `$rec.entry`, and
**returns the task**; `f$spawnStart` (index 3) calls `f()`, sets `.home`, calls **`drive()`**,
and returns `0`; `f$start` (index 0) runs the body.

**The one sentence.** *The served body calls the entry as a continuation and reads its return
value as an awaited slot, but for an async function the thing it resumes is the factory, whose
return value is a task handle — not a slot.*

**Measured corroboration of the mis-read**: under `TENSION_LOG_LEVEL=debug` the host logs
`executor 1 finished (__workerMain answered 170176)` — a heap pointer, i.e. the
task handle the factory returned, surfacing as the worker's status. That is also why DL17B
saw a heap address in I39's neighbourhood.

## The index experiment — which function actually runs

`tools/thread-promise/programs/stackful-worker-index.ts`, committed. It keeps both
`__spawnIndexOf` call sites (so the table keeps the 5-entry shape) and spawns a **literal**
index instead:

| `INDEX` | spawned | measured |
|---|---|---|
| **4** (default; what the API answers) | the factory | `main: __spawnIndexOf(workerEntryAsync)=4`, `spawn=0`, `join=0`, `done`, **no worker line**, exit 0 |
| 3 | `$spawnStart` | same, **no worker line**, exit 0 |
| 0 | the **body continuation** | `worker: entered (async entry)` — **the body runs**, exit 0 |

Two things fall out, and the second is why this round cannot fix it:

1. **`__spawnIndexOf` names the factory.** Registering `f` rather than `f$spawnStart` is a
   decision inside `builtin_async_spawnIndexOf` (`src/builtins.ts:12431`), which adds
   `target.internalName` — the name as written — to `asyncStartFunctions`.
2. **`$spawnStart` fails too.** It is the function the lowering *itself* stores in
   `$rec.entry`, so if the index were the only defect this row would work. It does not. So
   something in `spawnStart` → `f()` → `drive()` → `__parkOn`/`__suspendAwait` →
   `__serveOne`'s `awaited` → `e.ready` → `driveReady` → `__resumeTask` does not reach the
   body, and I did not isolate which link.

**A caveat I have to state because it bit the experiment once:** the numbering is not stable
across builds. A variant with **no** `__spawnIndexOf` call sites has a 4-entry table
`[mainStart, coreloop, start, spawnStart]`, where the body is index 2 — and my first run of
"index 3" was against that 4-entry table, where 3 *was* `spawnStart`. Both variants agree on
the conclusion, but only the 5-entry numbers belong in the table above, and the probe pins
the 5-entry shape on purpose. That instability is itself part of the finding: only the
lowering's own `$rec.entry` is trustworthy, because it is resolved in the same build that
uses it.

## C — which path, and why not 1 or 2

- **Path 1 (serve it correctly inside the served body)** — not available. The served body
  cannot tell a factory from a spawn entry: both are `() -> i32` in wasm, and the difference
  is which *statements* the lowering put in them. Making `__serveOne` recognise "this return
  value is a task handle, not a slot" means teaching std the difference — a std change, which
  the brief forbids. And even then, index 3 shows the deeper link is broken.
- **Path 2 (refuse by name)** — also not available *host-side*, and this is worth being exact
  about: the host knows only an `i32` index. Whether that index names an async entry's factory
  is known **only to the guest**. A host-side check would have to guess, and guessing wrong
  would refuse working sync workers. So the loud refusal belongs either in
  `__spawnThread`/`__spawnIndexOf` (std) or in the lowering (compiler).
- **Path 3 (stop, name the seam)** — taken, as the brief directs.

**The seam, exactly:**

1. **`builtin_async_spawnIndexOf`** (`TensionScript-a2/src/builtins.ts:12431`) — when the name
   it is given resolves to an async transform's entry `f`, it should register/answer the
   `f$spawnStart` sibling (which the lowering already knows how to name: it does so at
   `src/async/stack.ts:686` for `$rec.entry`). Compiler.
2. **The serve/drive chain in `std/assembly/thread.ts`** — `__serveOne`'s treatment of
   `awaited`, and/or `drive()`/`__parkOn`/`__resumeTask` for a task created by a *served*
   continuation. std. I have not isolated the failing link; the honest statement is "index 3
   produces nothing, and index 0 proves the machinery below it works".

Both feed I60, and neither is a probe's to change.

## D — no guard, and why that is the round's answer

The brief asks for a test with two possible outcomes: the worker **runs**, or it is
**refused by name**. Neither is available without a code change this round is forbidden to
make. So there is no guard — and writing one that asserts today's behaviour would **enshrine
the silent exit 0**, which the brief says may not survive. A test asserting `main: done` with
no worker line would be the vacuity this project has spent eight rounds removing, with a green
tick in front of it.

What exists instead is the **probe**, committed, which reproduces the defect by default
(`INDEX = 4`) and carries the control (`INDEX = 0`) that proves the body *can* run. Running
it is the reproduction; flipping one constant is the diagnosis.

## E — declared versus measured

| item | declared | measured | verdict |
|---|---|---|---|
| `--test threads` | 8 → 9 | **8** | **not delivered — see below** |
| `Wake path guard` filter | 3 → 4 | **3** | **not delivered — same reason** |
| `--bin` | 307 | **307** | unchanged |
| `--test fiber` | 6 | **6** | unchanged |
| `--test fiber-executor` | 7 | **7** | unchanged |
| census | 71 / 11 | **not re-run** | see below |
| `test:compiler` | 0 skips | **not re-run** | see below |
| bundle / std | unchanged | `aa74d6a1`, std identical | unchanged |
| `tension-core/src` | no change (implied by the seam) | `git status --porcelain` **empty** before this round's docs | ✓ |

**The declared counts were not delivered, and that is the round's result rather than a
shortfall**: a guard needs an outcome, the outcome needs a fix, the fix is the seam. The two
counts I did not re-run — census and `test:compiler` — are runs that measure the *compiler*'s
behaviour, and this round changed no compiler and no `src`; I am stating that I skipped them
rather than implying I measured them.

**Files touched:** `tools/thread-promise/programs/stackful-worker-index.ts` (new probe) and
this report. Nothing else — no `src`, no test, no workflow.

**Commits and CI:** `67caf62` — `probe(thread): an async worker entry is served as its
factory — two seams (I57)` (probe + this report). CI **`45244975497`**, **success**; the
existing gates ran unmodified and unchanged.

## F — bugs I made, and what caught each

1. **My index-3 experiment was invalid the first time and I caught it by checking my own
   instrument.** Replacing the `__spawnIndexOf` ternary with a literal removed both call
   sites, which rebuilt `$starts` as 4 entries and shifted every index — so "index 3" was
   `spawnStart` in that build but the table no longer matched a real program's. Caught by
   dumping the element segment of the variant *after* running it, comparing it with the
   unmodified build's, and seeing the entry count change. Fixed by keeping both registrations
   (an unused `as_the_api_answers` call in the committed probe) so the table keeps its shape.
2. **My probe's own header table was wrong for its own build.** I wrote "index 2 = the body"
   from the 4-entry variant, then realised the committed probe has 5 entries where the body is
   index 0. Caught by building the committed file and reading its element segment before
   claiming anything. Both the table and `INDEX` were corrected, and the resulting default
   (4) was re-run to confirm it reproduces the defect.
3. **A stale handoff line nearly went into the report.** I started to write "DL17B saw a heap
   address as I39's worker status" as if it were the same number; 170176 here is the *factory's
   return*, and DL17B's 169888 was a different guest's entry return. Both are heap pointers and
   the mechanism rhymes, but they are not the same measurement, so the report says "in I39's
   neighbourhood" rather than identifying them.

## G — what I did not verify

- **Which link in `spawnStart` → body is broken.** I measured that it is (index 3 silent) and
  that the machinery below it works (index 0 runs), and did not bisect further. Bisecting means
  printing from inside std, which is the change this round forbids.
- **Whether index 3 with a body that *actually* suspends behaves differently.** Every variant
  here awaits `leaf()`, an async function with no `await` of its own, which §4.4 says has its
  modifier cleared — so the entry's body may have no real suspension at all. A body awaiting
  something genuinely unfinished might take a different path. Not tested, and it could change
  finding 2.
- **`f$spawnStart`'s compiled type in the async build.** `cont.new` needs `() -> i32` and the
  cast would trap if not; nothing trapped, so it matches — but I inferred that from "no trap"
  rather than reading the WAT signature.
- **The function's parameters.** `f$spawnStart` is documented as parameterless
  (`stack.ts:727`: "narrowed to what this gate needs — no parameters"), and `$start` reads its
  arguments from the `f$Rec`. A parameterized async function's spawn entry is a different
  shape, untouched here.
- **Windows, census, `test:compiler`** — see §E; and I60's A/B/C choice, which this round must
  not make.
