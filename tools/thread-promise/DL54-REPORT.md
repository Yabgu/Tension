# DL54 — the default must *run* the corpus

**One defect, three disagreeing rules, one contract.** An async `_start_game` now starts and
runs exactly once on the fiber default. The corpus still builds 22 of 22 and its artifacts do
not move by a byte.

```
TensionScript  feat/dl54-start-path @ 40402d3a   CI 16/16 (45917930690)
Tension        feat/dl54-start-path @ de07629    (gitlink + re-vendor)
both `main`s untouched
```

---

## 1. Phase 0 — the three rules, and where they disagreed

### Rule 1: entry selection, compiler side

`compiler.ts`, the module-exports walk — the two names that claim the root:

```ts
if (prefix.length == 0 && name == "main") this.mainFunction = functionInstance;
else if (prefix.length == 0 &&
        (name == STACKFUL_ENTRY_EXPORT || name == this.options.exportStart)) {
  this.startGameFunction = functionInstance;
}
```

`exportStart` is **not** in this list's spirit: it names the export the compiler *creates*
for the shell start, not a guest function (DL52, `AS110`).

### Rule 2: entry selection, host side

`tension-core/src/main.rs:2753`:

```rust
let guest_result = if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start_game") {
    func.call(&mut store, ())
} else if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start") {
    func.call(&mut store, ())
} else if runtime_initialised { Ok(()) } else { Err(… "did not export `_start_game` or `_start`") };
```

Three facts: it looks up **`_start_game` first**; it requires **`() -> ()`**; and the
`runtime_initialised` arm means "the module booted through `__start`, nothing left to run".

### The table

| entry | async? | shell? (before) | what the compiler emitted | what the host did |
|---|---|---|---|---|
| `main` | sync | no | start body calls it | nothing — not a name it looks for |
| `main` | **async** | **yes** | `__start` shell, `main` untouched as root | `__start` (exported), then `runtime_initialised` → ok. **Works.** |
| `_start_game` | sync | no | start body calls it | called it. **Works** (measured: `examples/io`) |
| `_start_game` | **async** | **no** ← R1 | task **factory** exported under that name | `() -> ()` lookup **fails** (factory answers a handle) → "did not export" |
| `_start_game` | **async**, latch widened only | yes | shell **calls the factory**, whose body moved to `f$spawnStart` where nothing dispatches it | ran, printed nothing, exited 0 |
| `_start_game` | **async**, latch + `__start` forced | yes | `__start` **and** `_start_game` both exported | `__start` ran it, then `_start_game` again → **twice**, `-16` |

### `latchAsyncEntry` — why the spelling `main`

`transforms.ts:120`, before: `if (declaration.name.text != "main") continue;`

It runs **before any element or export table exists**, so it can only read declarations. It
was written when `main` was the only root DL52 hadn't yet added. `hasAsyncMain` is read in
**exactly one place** (`shouldEmitAsyncShell`), so a rename cannot break anything else —
verified by grep, not assumed.

### The start section: what DL53's "none at all" actually was

Not a fibre bug. `compiler.ts:2533`: `if (!startIsEmpty) { … setStart / exportStartUnder }`.
For a fibre build containing an `await`, `asyncShellSuspends` is true, so the shell branch
runs and `emitAsyncShellStart`/`emitAsyncFiberShellStart` push into `startFunctionBody` —
**only if `asyncShellStartReady`**, i.e. only if a shell was selected. When it was not, the
body stayed empty → `startIsEmpty` → no start section, no export, no call. The condition was
`shouldEmitAsyncShell`, one layer up.

### The missing `__start` fallback

The host has one, and it works — but only if the module exports `__start() -> ()`. Nothing
emitted that name for a fibre build unless `--exportStart __start` was passed, and the
examples' shared `session.asconfig.json` sets exactly that (which is why the corpus builds
resolve differently from the fixtures). There is no name the compiler invents on its own.

---

## 2. The contract, stated

> **When the fiber shell owns the entry, the boot body is exported as `__start() -> ()`,
> and the root is not also exported under a name the host calls.**

`async main` has always satisfied this **by accident**: the host's lookup list is
`_start_game`, `_start` — and `main` is neither, so the shell's call was the only one.
`_start_game` is exactly a name it looks for, which is why making it a root exposed the
double call.

Three edits, one per rule:

| file | change |
|---|---|
| `src/common.ts` | `STACKFUL_ENTRY_EXPORT` moves here (one spelling, one home — `compiler.ts` imports `transforms.ts`, so a shared home is the only cycle-free option). Re-exported from `compiler.ts` where it was declared. |
| `src/transforms.ts` | `latchAsyncEntry` accepts `main` **or** `_start_game` |
| `src/async/stack.ts` | the transform treats an **exported** `_start_game` as the root, like `main` |
| `src/compiler.ts` | boot body exported as `__start` when the shell owns it; the `_start_game` export is removed |

The two compiler rules are scoped to `this.mainFunction.declaration.name.text ==
STACKFUL_ENTRY_EXPORT` — a root that **is** the guest's `_start_game`. A program with an
async `main` beside a sync `_start_game` (the corpus has two) keeps every byte.

---

## 3. The evidence that it fires once

A session guest with an **async** `_start_game` that awaits:

```
2026-11-27 INFO core: requires: backend fiber target portable features [] — met
2026-11-27 INFO core: executor: fiber (scheduler::park suspends an OS thread's stack)
2026-11-27 INFO session: session_open(cfg_len=277, arena=6250528, ceiling=8388608) -> 0
dl54: session open, awaiting a task that settles in its own entry
dl54: awaited value = 42
dl54: done
2026-11-27 INFO session: session_close() -> 0
```

**`session_open` occurrences: 1.** `-16` does not appear. Before the export suppression the
same program printed its whole transcript twice.

The fixture `tests/compiler/stackful-async-entry-root.{ts,json,js}` pins the artifact:
`$starts` present, `__asyncPump` present, `__start` present, **no start section**, and **no
`_start_game` export**. Red case on `7922bba4`:

```
Error: the artifact must export `__asyncPump`
```

---

## 4. Phase C — the declarations, before and after

**Before: 8. After: 8.** Declared delta was "fewer, if they run"; they do not, so none was
removed. Each of the two candidates was tested with its declaration removed, built, and run:

| example | builds under fiber | starts (session_open) | runs to completion |
|---|---|---|---|
| `async-io` | yes | **1** (the `-16` is gone) | **no** — parks on `await rt.frame()`, 120 s kill |
| `platform-control` | yes | **1** | **no** — paints its surface, then parks the same way |

The residue, named:
- **6 × ogre `async run(): void`** — async-method lowering gap (I126), unchanged from DL52.
- **2 × `async-io`, `platform-control`** — the guest parks a task on the host's frame loop
  and nothing produces the completion. That is **I95/I128's drain**, and it is why the brief
  put the drain round after this one: a drain probe needs a start path that runs once, and
  now there is one.

Removing those two declarations stays wrong until the drain lands — a build without a run is
the failure this round existed to stop treating as success.

---

## 5. Gates (`TENSIONSCRIPT_DIR=~/work/TensionScript-a2` on every `rebuild.mjs` line)

| gate | result |
|---|---|
| `build:examples` | **22 of 22, exit 0** |
| `--check` | **10/10 links PASS**, every row below |
| program artifacts changed | **0 of 35**; fixtures re-pinned **0** |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| `--bin` default · audio-only | **307 · 298** |
| compiler suite · CI | `[ SUCCESS ]` · **16/16** (`45917930690`) |

```
compiler: src → dist/assemblyscript.js  159 inputs → 6e0d0c76110a   PASS
compiler: dist → installed              e5546875b613 (tree)         PASS
compiler: std mirror                    81 files identical          PASS
runtime: src → release / debug          84 inputs → c3c82a76c21f     PASS
fixtures: committed .wasm -> build      15 current (13 bytes, 2 dwarf)  PASS
guests: tests/programs/**/*.ten → build  35 current                 PASS
guests: built by the installed compiler  70 of 70 current            PASS
guests: read set vs .debug_line          35 of 35 agree              PASS
docs: docs/abi/*.md                      current                    PASS
```

**Five examples run**, two of them fiber and one of them a suspending promise guest:

| example | `tension.requires` | output |
|---|---|---|
| `solver/world` | `backend fiber … — met` | `match: \|err\| = 6.599878976665252e-11` |
| `io` | `backend fiber … — met` | `=== TensionCore demo game ===` … `You said: hello from the terminal` … `--- end ---` |
| `async-io` | `backend promise … — met` | `async-io: awaiting guest tasks` · `pipeline() completed with 83` |
| `ogre/hello-triangle` | `backend promise … — met` | `rendered 342 frames, 42050 non-background pixels` |
| **async-entry session guest** (the previously-hanging shape) | `backend fiber … — met` | `dl54: awaited value = 42` · `dl54: done` |

---

## 6. What the tree contradicted in this brief

- **"A sync entry under fiber emits no start section, so the guest runs nothing and hangs."**
  Two halves, and only one is right. A **sync** entry under fiber **does** run — measured on
  `examples/io` with a one-line `_start_game`: `sync entry ran`. Its start body is emitted and
  called normally. What had no start section was the fibre build containing an `await` whose
  shell was not selected — a different thing.
- **"`async-io` printed nothing, needed a 120 s kill."** True, but the cause was not the start
  path: it is a guest that parks on the host's frame loop with no producer. It still hangs
  after this round — now having opened its session **exactly once**, which is the difference
  the round actually delivers.
- **"The correct shape is `program.asyncEntries.has(mainFunction.declaration)`."** That was
  DL53's sketch and it is **insufficient**: it selects the shell correctly, but the shell then
  calls a **task factory** whose body nothing dispatches, because the transform lowers
  `_start_game` like any other async function. The round needed the transform change too.
- **The double-start does not come from the shell being selected twice.** It comes from the
  artifact exporting **both** `__start` and `_start_game`, so the host runs one and then the
  other. Suppressing the export is the fix; narrowing the shell condition would only have
  hidden it.
- **`--sharedMemory` builds already export `__start`**, so forcing the name there was
  `AS110: Start function name '__start' is invalid or conflicts with another export` — caught
  by three existing fixtures (`stackful-fiber-{record,pruned,section}`), and why the rule is
  scoped to non-shared builds.

## 7. What I did not verify

- **Windows and macOS.** Nothing was run there.
- **The drain.** Four of the five "previously hanging" shapes now start and still hang; the
  async-entry one runs to completion only because the task it awaits settles in its own
  entry. Whether a guest awaiting `rt.frame()` under fiber completes is I95/I128's question.
- **The six ogre async-method examples.** Refused by the compiler, declared, unchanged.
- **A real marketplace/editor path**: no `.vsix`, no editor, this round touched no extension.
- **`async main` + sync `_start_game` under `--sharedMemory`** — the corpus pair is built and
  byte-identical, but only the default profile was checked.
