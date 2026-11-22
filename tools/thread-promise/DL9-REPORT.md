# DL9 — a worker that runs an entry, with no continuations

Round: give a build without an async shell a worker that does work. Compiler
branch **`fix/plain-worker`** @ **`dddd8849`** (pushed), off `a764f8f4`:

| commit | what |
|---|---|
| `695f51d3` | the plain worker — `src/compiler.ts`, `src/builtins.ts`, `std/assembly/thread.ts` |
| `dddd8849` | the `features/threads` golden, regenerated (derived output) |

Nothing merged, `main` untouched, no PR.

## 1. Phase A — is a plain worker expressible? Yes, with one thing missing

The six items, and the measurement that settled each.

**1. `__spawnThread(id, entryIndex, argSlot)`** — `std/assembly/thread.ts:1663`:

```ts
if (!SHARED || __controlBase == 0) return -1;
if (id <= 0 || id >= __executorTotal) return -1;
let sig = signalBase(recordBase(id));
if (atomicLoad<i32>(sig + 12) != 0) return -2;
atomicStore<i32>(sig + 16, entryIndex);   // ← the spawn entry
atomicStore<i32>(sig + 20, argSlot);      // ← the argument
let status = __startThread(id);
if (status != 0) atomicStore<i32>(sig + 12, 2);
return status;
```

Pure guest code, two words at `sig+16` and `sig+20`, then the host import. Its
own doc says "`entryIndex` is a `$starts` index (identical in every store)".

**2. The entry table.** `entryIndex` indexes **`$starts`** (`docs/thread-abi.md`
§5.1: "Cross-thread work therefore carries a `funcIndex` into `$starts` — one
table, identical in every instance"). The table is emitted by
`Compiler#emitStartsTable`, and only from the suspending branch of `__start`
emission — so a non-suspending build has none. Measured on the DL8 Promise
build: the module's only table was `(table $0 2 2 funcref)` with one element
(`$~lib/task/noopWake`), i.e. the compiler's closure-dispatch table. Its
elements are `funcref` of the closure thunk shape, **not** the canonical
`() -> i32` that a spawn entry has. What has to be emitted instead is a table
whose entries are `() -> i32`: mechanically the same `$starts` table the
suspending shell already emits (`(table $starts N N funcref)` + an active
segment), so nothing new is needed in the *table*, only in who fills it and how
it is called.

**3. `__serveOne(e, funcIndex, argSlot, taskKey, origin)`** — `thread.ts:1167`:

```ts
servingArg = argSlot; servingKey = taskKey; servingOrigin = origin;
let slot = __serveSlot(funcIndex);          // → __serveCont → cont.new
let awaited = __resumeTask(slot);           // → resume
...
return __lastStatus();
```

The subset that is a plain indirect call is the table read at the top of
`__serveSlot` → `__serveCont` (`thread.ts:57-63`): `$starts[funcIndex]`, cast to
the canonical `(ref $ft)`. Everything after it — `cont.new`, `table.set`,
`resume`, the slot bookkeeping — is the continuations path. So the plain
dispatch is `call_indirect $starts (type (func (result i32)))`, and nothing else.

**4. What a worker must still do, continuation-free.** From `__workerMain`
(`thread.ts:1591-1651`): the header reads `H_TOTAL`/`H_STRIDE`/`H_CAPACITY`/
`H_REQUESTS` (1595-1602) are `atomicLoad` from `./atomics`; the layout globals
assignment (1598-1605) is plain stores; the arena bounds check (1616-1619) is
`atomicLoad` + `__arenaHeapBase()`; the state word and both `atomicNotify`s
(1647-1649) are plain atomics. **Continuation-bearing, and not in the plain
body:** `__setSelfExecutor(id)` (1609, the store-local id `__parkOn` routes by),
`bindExecutor` + `installWakeSink` (1620-1624, task machinery), `__serveOne`
(1628), `__drainInbox`/`e.step` (1631-1639), `__lastStatus()` (1650, written by
a `resume`). Six pieces out of thirteen.

**5. `__threadJoin`** — `thread.ts:1700`: waits on `signalBase(recordBase(id)) + 12`
reaching `2`, with `atomicWait`. That word is written by the worker itself
(`atomicStore(sig + 12, 2)` at 1647) or by `__executorExit`. **Nothing a served
body produces is required** — a plain body can and does write it.

**6. The two docs.** `docs/thread-abi.md` §2.2 fixes the host contract — "the
host's `env.__startThread(id)` import creates that instance and calls
`__arenaInit(...)` and `__workerMain(id)`, in that order" — and §5.1 fixes the
index rule. The harness's `docs/threads.md:20-22` says the two imports are
"emitted only by a `--sharedMemory` build, **and only when the module has an
async shell** (a program with no `$starts` table has nothing to serve requests
from)". **That sentence is false as of DL8** (the imports are emitted for every
shared build) and stays false here — I34, reported, not fixed.

**Where the round could have stopped, and where it actually had to work.**
None of the three STOP conditions holds: the table is emittable, `__threadJoin`
waits on a word any body can write, and the boot reaches the entry by
`call_indirect`. But **the entry index is not obtainable**: the only mechanism
in the language is `~lib/task-stack/__spawnIndexOf`, and it is a *lookup*, not a
registration. Measured, with the pre-round compiler on a stackful build whose
`$starts` was `[~asyncMainStart, ~coreloopAwait]`:

```
workIndex=-1
```

`emitStartsTable` builds the table from continuation installation only, and
`__spawnIndexOf` returns `-1` for anything the served path had not already
reached. So the round's real work was three lines of mechanism the brief did not
name: make the index obtainable. That is the design decision this round took,
explained in §3.

## 2. Phase B — the change

`git diff` is in the commit; the shape is:

- **`std/assembly/thread.ts`**: `__workerMainPlain(id)` and `__callStart`'s
  declaration and `__workerArg()`, all **appended at EOF** — this file's line
  numbers are in every shared artifact's DWARF, and inserting above an existing
  body moves `DW_LNS_advance_line` (DL8 measured exactly that).
- **`src/builtins.ts`**: `__callStart` → `module.call_indirect(STARTS_TABLE, …,
  createType([]), TypeRef.I32)`; `__spawnIndexOf` loses
  `checkStackIntrinsic` for "a `$starts` table will exist".
- **`src/compiler.ts`**: the thread-surface export loop maps `__workerMain` to
  `__workerMainPlain` when `!asyncShellSuspends`; `emitStartsTable` is called
  for the non-suspending case; `emitStartsTable` **appends** `__spawnIndexOf`'s
  targets after the shell's own; `--sharedMemory` implies reference types.
- `workerExported` latch; the suspending branch of `__start` emission is
  untouched.

**The served-body worker did not move — proof by artifact.** All **25** debug
conformance artifacts rebuilt from this bundle are **byte-identical** to the
`cf14aa5c` baseline (`diff` of `sha256sum` lists, empty; the four shared+stackful
thread programs included). The conformance census is 71/11 with no case moved.

**One bug found by the control build, kept in the history.** The first draft had
`__spawnIndexOf` insert its target into `asyncStartFunctions`. In a stackful
build that put the user's entry at index 0 and pushed `~asyncMainStart` to 1 —
the shell then resumed the user's function as main's continuation, and the run
hung. Fixed by appending in `emitStartsTable` instead; the control then reports
`workIndex=2` and both builds pass.

## 3. Phase C — a worker does work, without continuations

Scratch program (not in `tension-core/tests/programs/thread/`): a `StaticArray<i32>`
in the shared memory; the worker reads the record's argument through
`__workerArg()`, does `atomicLoad` + `atomicAdd<i32>(addr, 10)`, then
`__executorExit(__selfExecutor())` so the served body's loop ends; main prints
`before`, `workIndex`, `spawn`, `join`, `counter`.

Built with `THREAD_FLAGS` (`--sharedMemory --importMemory --enable threads
--initialMemory 2 --maximumMemory 256 -O0`), **`--executors 2` before the module
path** — after it the host ignores the flag and answers `executors=1`
(measured; unchanged, I32).

| | plain (no `--enable stack-switching`) | control (`--enable stack-switching`) |
|---|---|---|
| size | 15 729 B | 24 249 B |
| sha256 | `2952849fa89be404…11334f` | `36c54063de27e663…b9c1d4` |
| `workIndex` | 0 | 2 |
| stdout | `before=0 / workIndex=0 / spawn=0 / join=0 / counter=10` | `before=0 / workIndex=2 / spawn=0 / join=0 / counter=10` |
| exit | 0 | 0 |
| `cont.new`/`resume`/`suspend` in the module | **0** | 7 |

Both exports: `__threadInit __threadJoin __workerMain __spawnThread
__executorExit __mainArena{Base,Size} __workerArena{Base,Size} __heapBase
__controlBase __controlStride __ringCapacity __executorTotal $starts memory
__start`, plus `_start_game`; the control adds `main`, `__asyncStatus`,
`__asyncPump`.

`counter=10` in both is the same number reached by opposite mechanisms: the
control through `cont.new` + `resume` of a served body, the plain build through
one `call_indirect`. The plain module has no continuation instruction anywhere.

**The one difference between the two sources, stated plainly.** The control
carries an `async main` because a suspending shell needs `hasAwait`; the plain
build does not. That is not cosmetic: adding the `async main` to the *plain*
build made it fail to run at all —

```
ERROR thread: executor 1 could not run: the module did not instantiate as a
worker … unknown import: `scheduler::park` has not been defined
```

A Promise build (async main, no stack switching) imports `scheduler::park`, and
`thread.rs`'s worker linker defines `env::memory, env::abort,
env::__executorCount, env::__startThread` and not that one. **Reported, not
fixed** — it is a host-side link, and §5 says report. It also bounds what this
round bought: a worker does work without continuations for a program that does
not reach `scheduler::park`, i.e. a synchronous or await-free one. A framework
game with an async main needs the host change first.

## 4. Phase D — deferred, with the reason

The narrowing the brief asks for — "export only when the program names a thread
API" — does not survive first contact with what the exports are *for*.

`__threadInit` is host-driven: nothing in the program ever names it, so a
"is it named" test removes it from exactly the builds that need it. `ThreadPool`
is the API a program *does* name, and it is a symbol in `~lib/thread`, reachable
transitively through any framework import — so a shallow test ("does the entry
file import `~lib/thread`") says no for the real case and a deep one ("is
`~lib/thread` reachable from user code") is close to always yes for a game.

The signal that would work is a *usage* question the compiler does not currently
ask: does any element of `~lib/thread` have a reference from outside `~lib/`?
That needs a resolution pass over sources, not a `program.lookup`. Per the
brief's own rule — "if it is more than a small change, stop and report; it must
not put Phase C at risk" — it is not attempted. I33 stands, and DL8's statement
of it stands with the numbers.

## 5. Gate

| gate | declared | measured |
|---|---|---|
| `npm run check` | green | exit 0 |
| `npm test` | — | **exit 0**, 20 suites `[ SUCCESS ]`, no failure block |
| `npm run test:compiler -- --parallel` | — | exit 0; `features/threads` compare SUCCESS (debug + release) after the golden regeneration |
| `cargo test --test threads` | 5 passed | **5 passed**: `a_shared_memory_guest_can_print`, `a_worker_runs_on_its_own_store_and_joins`, `one_executor_count_plus_the_pool`, `the_contracts_refusals_are_values`, `two_workers_observe_every_value_exactly_once` |
| `cargo test --test async_main_promise` | 2 passed | **2 passed** |
| census, `--workers 8`, alone | 71 / 11, nothing leaves `pass` | **71 / 11 / 0 / 0 / 0, no case moved**, all `pass` lines identical |
| stackful artifacts | byte-identical to `cf14aa5c` | **all 25 byte-identical** |
| compiler bundle | changes, hash reported | **`cf14aa5c` → `767d3d7a`** (`asc.js` `e635a221` → `c95a819f`) |
| `git diff --stat -- tension-core/tests/programs/thread/` | empty | empty |

## 6. Not verified

- **Two engines only.** Everything ran on `tension-core/target/release`
  (2026-11-21, `async backend: continuations`). Nothing ran on Windows; this
  branch exists so that host can.
- **The Promise path cannot run a worker** (`scheduler::park`), so the plain
  worker is measured only on a build with no `scheduler.park` import. That is a
  real limit on the win, not a detail.
- **`__spawnIndexOf` now answers a real index where it used to answer `-1`** for
  a function the served path had not installed. No program in either tree is
  affected (the 25 artifacts are byte-identical), but it is a behaviour change
  in a std builtin, and a third-party program that relied on `-1` would see it.
- **The reference-types consequence is broader than the worker:** every
  `--sharedMemory` build now encodes element segments in the explicit-table form.
  No behaviour changes, and no measured artifact moved — but a shared non-stackful
  build's bytes differ from before this round for that reason alone.
- I assumed the host's `__workerMain` call is the only entry a worker needs
  (`thread.rs:415`); the plain body relies on that and does not implement
  `__executorExit`'s `stop` flag (no `Executor` is bound), which is fine because
  the body returns immediately.
