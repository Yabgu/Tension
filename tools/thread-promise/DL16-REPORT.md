# DL16 — the thread surface follows the program, not the flag

`~/work/TensionScript-a2` branch **`fix/thread-surface-reachability`** off
`main @ 00675020`, PR **#80**. Bundle **`767d3d7a` → `aa74d6a1`**
(`asc.js` `e635a221` → `f8297c0c`). Four files: `src/compiler.ts`,
`std/assembly/thread.ts`, and the two regenerated `features/threads` goldens.

Harness `~/work/Tension` `integration/dwarf-debug` @ `31e7ca4`, unchanged except
this report.

## 0. Phase 0, verbatim

```
$ cd ~/work/TensionScript-a2
$ git rev-parse --abbrev-ref HEAD; git rev-parse --short HEAD; git status --short
main
00675020
$ sha256sum dist/assemblyscript.js
767d3d7ae63f0e7dac98fb90d5200bbd191adacda081a74ab1b4ae4ec5fa5d08  dist/assemblyscript.js
$ git log --oneline -3
00675020 test(compiler): probe the runtime instead of trusting a list, and answer the thread imports
dddd8849 compiler(test): regenerate the `features/threads` golden for the plain worker
695f51d3 thread: a worker that runs an entry, with no continuations
```

As expected. Node is **v26.13.1**. Both builds reproduce their hashes here:
re-checked out `main`, `node scripts/build`, `767d3d7a`; this branch, `aa74d6a1`.

## 1. Phase A — the signal

### 1.1 Where the surface is emitted now

`src/compiler.ts` before this round — one gate, then `program.lookup` per name:

```ts
if (this.options.sharedMemory && !this.gcActive) {
  for (… arenaFunctions …) { … }
  {
    for (let i = 0, k = threadFunctions.length; i < k; ++i) {
      let name = threadFunctions[i];
      if (program.lookup(name) == null) continue; // program has no thread surface
      …
```

with, one screen above it, the list and its two claims:

```ts
/**
 * `env.__startThread` / `env.__executorCount` are the host imports a shared
 * build needs; … A program compiled without `--sharedMemory` references none of
 * them, so none of them — and neither import — is emitted …
 *
 * Looked up, not required: `~lib/thread` is pulled in by the async shell, so an
 * await-free program has no threading surface to export and simply exports
 * nothing here.
 */
export const threadFunctions = [ "__threadInit", …, "__workerArenaSize" ];
```

**The second paragraph is wrong, and measuring that is the whole of Phase A.**
A `--sharedMemory` build of a ten-line `main` that names no thread API emitted the
full surface and both import interfaces:

```
imports (5): env::__executorCount  env::__startThread  env::abort  env::console.log  env::memory
exports (18): main __arenaInit __arenaHeapBase __arenaEnd __threadInit __threadJoin
              __workerMain __spawnThread __executorExit __mainArenaBase __mainArenaSize
              __workerArenaBase __workerArenaSize __heapBase __controlBase __controlStride
              __ringCapacity __executorTotal memory $starts __start
```

So `lookup` returned non-null for every name. It always will.

### 1.2 The candidates, and whether each is reliable

**(a) `~lib/thread` present in the program's file/element list — NO, and this is
the trap.** `~lib/thread` is a *flat* std file, so the CLI parses it eagerly for
every build, as part of the global scope:

```js
// cli/index.js:539-541
Object.keys(libraryFiles).forEach(libPath => {
  if (libPath.includes("/")) return; // in sub-directory: imported on demand
  …
  assemblyscript.parse(program, libraryFiles[libPath], libraryPrefix + libPath + extension, false);
```

Measured, not inferred: a **non-shared** build of

```ts
export function main(): void { console.log("threadInit=" + __threadInit(0).toString()); }
```

compiles and runs (`imports (2): env::abort env::console.log`). `__threadInit`
resolved with no import statement. So "the file is present" is true of every
build, and a source-scan for the *import* would miss the ordinary std calling
convention (the same one `console.log` uses).

**(b) `program.lookup("__spawnThread") != null` — NO.** The brief flags it as
possibly circular; it is worse than circular, it is always true, for the reason
in (a). It is the candidate the current code relies on.

**(c) A textual scan for `ThreadPool` — NO.** Rejects re-export, aliasing,
namespace imports, and (a)'s global-scope form. The brief forbids it and the
measurement above shows why an import scan fails too.

**(d) Reachability — YES.** "Has this name been *compiled*?" means some body the
program reaches named it. That is exactly the question ("can this program use
them?"), it survives every form of naming, and the compiler already tracks it:
`CommonFlags.Compiled` is set by `compileFunction` / `compileGlobal`, and
`compileModuleExports` runs the program's own exports **before** the export block
(`compiler.ts:1682-1683` vs the block at `:1853`).

Two things had to be checked before trusting it:

- **`@lazy` functions are only queued.** `compileFunction` adds them to
  `lazyFunctions` and returns; their bodies are compiled by the loop that used to
  sit after the export block. Reading `Compiled` at the latch would see `false`
  for a callee that is reached but not yet built — the exact false negative the
  brief's asymmetry rule forbids. So the lazy pass is hoisted into
  `drainLazyFunctions()` and drained **before** the latch, for shared builds only.
- **Asking must not answer itself.** `requireFunction` + `compileFunction` is
  what emits the surface today; the latch runs strictly before either.

**Stop verdict: no stop.** The signal is structural and exact. What I could not
do is *demonstrate* the lazy drain being load-bearing: `@lazy` is valid only on
globals (`AS212` for a function and for a namespace, measured), so I could not
write a user function that gets enqueued. With the drain removed the fixture's
output is byte-identical (measured, both goldens). It stays as insurance and the
comment says so.

### 1.3 What `count.ts` does that a plain shared program does not

`tension-core/tests/programs/thread/count.ts` imports `~lib/thread` for four
layout globals and reads them from `_start_game`:

```ts
import { __controlBase, __controlStride, __executorTotal, __ringCapacity } from "~lib/thread";
…
export function _start_game(): void {
  line("executors=" + executorCount().toString());
  line("controlBase=" + (__controlBase != 0 ? "carved" : "0"));
```

Under the latch it is a threading program — not because of the import, but
because reading those globals compiles them. Measured after the change:
`executors=3 / controlBase=carved / executorTotal=3 / ringCapacity=1024 /
controlStride=16432`, unchanged.

### 1.4 What else depends on the surface existing — the item that decided the shape

The two imports are not symmetric, and `__threadInit` turned out to be
load-bearing for a reason that has nothing to do with threads.

`tension-core/src/main.rs:575`:

```rust
let Ok(init) = instance.get_typed_func::<i32, i32>(&mut *store, "__threadInit") else {
    logging::log(Level::Debug, "thread", "… exports no `__threadInit`; the pool answers the imports and nothing is carved");
    return Ok(());
};
```

and, immediately after the carve, `__start` is called from **inside** that
function, with this comment (`main.rs:1619-1623`):

```
// A shared-memory guest's `__start` answers `i32` (the shell's status) and
// has already been called by `thread_boot`; the `() -> ()` form is the one
// an ordinary build emits.
```

So a shared module with no `__threadInit` gets **no `__start` call at all** — its
`__start` is `() -> i32` and the fallback lookup at `main.rs:1629` is
`get_typed_func::<(), ()>`. Measured on the host: with `__threadInit` present the
debug log reads `main booted: __threadInit(1024), arena 102524+4222852, __start
answered 0`; the `() -> ()` path never runs.

**Therefore the narrowing cannot drop `__threadInit`, and it must not drop the
boot half.** That is what the brief's item 4 was asking, and the answer is "the
whole block cannot move; only the spawn half can, and `__executorCount` needs a
second body".

`__workerArenaBase/Size` are read only by the worker path (`thread.rs:521`), so
they belong to the spawn half. The five layout globals are read by nobody on the
host side (grep: no `__controlBase`/`__executorTotal`/… in `tension-core/src`),
only by guests — they stay in the boot half so a host can still read back what it
carved.

## 2. Phase B — the change

Three parts.

**(a) Two lists instead of one** (`compiler.ts:577`, `:596`):

```ts
export const threadBootFunctions = [ "__threadInit", "__mainArenaBase", "__mainArenaSize" ];
export const threadSpawnFunctions = [
  "__spawnThread", "__workerMain", "__threadJoin", "__executorExit",
  "__workerArenaBase", "__workerArenaSize",
];
```

**(b) The latch** (`compiler.ts:1615`), plus `isReached` (`:1630`) and the
hoisted `drainLazyFunctions` (`:1579`):

```ts
private usesThreadSurface(): bool {
  let program = this.program;
  for (let i = 0, k = threadBootFunctions.length; i < k; ++i) {
    if (this.isReached(program.lookup(threadBootFunctions[i]))) return true;
  }
  for (let i = 0, k = threadSpawnFunctions.length; i < k; ++i) {
    if (this.isReached(program.lookup(threadSpawnFunctions[i]))) return true;
  }
  for (let i = 0, k = threadGlobals.length; i < k; ++i) {
    if (this.isReached(program.lookup(threadGlobals[i]))) return true;
  }
  return false;
}
```

**(c) The block** (`compiler.ts:1853-1920`) — the rewritten comment, quoted in
full, is:

```
      // **The surface follows the program, not the flag.** `--sharedMemory`
      // says a module is instantiated more than once over one memory; it does
      // not say the program threads. Emitting the whole surface on the flag
      // alone made every shared build import `env.__executorCount` and
      // `env.__startThread` — a one-line `main` included — which is I33: a host
      // that defines only `env` cannot link the module at all.
      //
      // **The signal is reachability**, asked of the compiler rather than read
      // off the source: did any of these names get compiled? That is exact, and
      // it is available here because everything the program's own code reaches
      // is already compiled by now — its exports at `compileModuleExports`
      // above, and the `@lazy` callees those queued, drained just below, since
      // `compileFunction` only *enqueues* a `@lazy` function. The order matters:
      // requiring a thread function first and then asking whether it was
      // reached would answer its own question.
      //
      // A false positive costs two unused imports and is safe; a false negative
      // costs a guest that cannot thread, so anything reached counts, including
      // a reach through the async loop's `Executor`.
      //
      // `__workerMain` keeps its own alias, unchanged: its body is `__serveOne` /
      // `__drainInbox` / `Executor.step` / `__lastStatus`, and the last three
      // reach `__serveCont` and `__resumeTask` — the *served body* path, which is
      // the suspending shell's by construction (a continuation cannot leave the
      // store that made it). Emitting it without that shell is an AS100 compile
      // error, measured, not a run-time shape; so the plain body takes the name
      // where the served one cannot be compiled.
      this.drainLazyFunctions();
      let threads = this.usesThreadSurface();
```

followed by the boot half with its own comment —

```
        // The boot half. **Unconditional**, because the host boots by this name
        // (`main.rs:575`) and a shared module it cannot boot runs nothing: its
        // `__start` is `() -> i32` and the ordinary `() -> ()` lookup does not
        // match it. What the program decides is which body answers it.
```

— and the spawn half behind `if (threads)`.

**The guest side** (`std/assembly/thread.ts`), the second body:

```ts
export function __threadInit(capacity: i32): i32 {
  if (!SHARED) return -1;
  if (__controlBase != 0) return 0;
  let total = __executorCount();          // the only reader of this import
  if (total <= 0) return -1;
  return __carveThreadLayout(capacity, total);
}

export function __threadInitPlain(capacity: i32): i32 {
  if (!SHARED) return -1;
  if (__controlBase != 0) return 0;
  return __carveThreadLayout(capacity, 1);
}
```

`__carveThreadLayout` is the old `__threadInit` body with `total` as a parameter.
`__threadInitPlain` carries the doc comment that says *why* it exists, including
the host-keyed-on-the-name reason.

New bundle: **`aa74d6a1a33904c74daf4c4e835ef61f392288967896ebf9ba2042d28004316d`**.

## 3. Phase C — both directions

Flags for every build below: `--runtime incremental --target release
--sharedMemory --importMemory --initialMemory 2 --maximumMemory 256
--enable threads --optimizeLevel 0`.

### 3.1 A non-threading shared guest stops importing them — and still runs

The same source, a ten-line `main` that names no thread API, built before and
after (`bare.ts`; the console-log import is there because it prints):

```
BEFORE  imports (5): env::__executorCount  env::__startThread  env::abort  env::console.log  env::memory
        exports (18): main __arenaInit __arenaHeapBase __arenaEnd __threadInit __threadJoin
                      __workerMain __spawnThread __executorExit __mainArenaBase __mainArenaSize
                      __workerArenaBase __workerArenaSize __heapBase __controlBase __controlStride
                      __ringCapacity __executorTotal memory $starts __start
AFTER   imports (3): env::abort  env::console.log  env::memory
        exports (12): __arenaEnd __arenaHeapBase __arenaInit __controlBase __controlStride
                      __executorTotal __heapBase __mainArenaBase __mainArenaSize
                      __ringCapacity __start __threadInit
```

And a runnable copy with the host's own print seam — `plain-shared.ts`, a `for`
loop plus `String.UTF8.encode` so it allocates, `tension::io.print`, no thread
API: `imports (3): env::abort env::memory tension::io::print`, 12 exports. Run
under `tension-core/target/release/tension-core`:

```
no --executors : start_game total=45      exit 0
--executors 3  : start_game total=45      exit 0
debug log      : main booted: __threadInit(1024), arena 102524+4222852, __start answered 0
```

The `$starts` table is also gone — its only purpose is dispatching a worker
entry — and the host never reads it.

### 3.2 A threading guest still threads

| guest | imports | run |
|---|---|---|
| `plain-worker.ts` | `__executorCount`, `__startThread` | `before=0 workIndex=0 spawn=0 join=0 counter=10`, exit 0 |
| `strand-nested.ts` | both | worker parks (1 park, class 4 key 7), DL12B strand refusal |
| `ThreadPool.create(1)` | both | `lastStatus=0`, `workBase=carved` |
| `count.ts` (`--enable stack-switching`) | both (twice: its own `@external` + the std one) | `executors=3 controlBase=carved executorTotal=3 ringCapacity=1024 controlStride=16432` |

`plain-worker.ts` built with this bundle, so **I44 does not bind this round** —
DL9's limit was about `__workerArg`, and `767d3d7a` (which this branch contains)
has it. No fallback to `count.ts` was needed for the promise build; I used
`count.ts` anyway as the stackful control.

Then, with the harness artifacts **force-rebuilt** by this bundle
(`node scripts/build-test-programs.mjs --force` → `25 built, 0 up to date`):

```
cargo test --test threads               5 passed; 0 failed
cargo test --test async_main_promise     2 passed; 0 failed
```

(Worth recording: the first `cargo test --test threads` run I did said `0 built,
25 up to date` and passed — against **stale** artifacts. It proves nothing about
this bundle. The numbers above are the forced rebuild.)

### 3.3 The harness stub is unnecessary

Commenting out `__executorCount: () => 1` and `__startThread: () => -1` in
`tests/compiler.js` and running `npm run test:compiler -- --parallel`: **exit 0**.
Restored afterwards; `git status` shows `tests/compiler.js` unmodified.

### 3.4 Suites

`npm run check` 0 · `npm test` 0 (20 `[ SUCCESS ]` groups, no failure block,
0 `instantiate SKIPPED`) · `test:compiler -- --parallel` 0 · `test:arena`
76 checks · `test:atomics` 71 checks.

**Every non-shared fixture's golden is unchanged**, which is the byte-identity
proof for non-shared builds: the lookahead pass is gated on `--sharedMemory`.

### 3.5 The regenerated golden, read as a guard

`tests/compiler/features/threads` is a `--sharedMemory` build with atomics and no
thread API, so it is the first case the narrowing applies to.

```
exports 18 → 12
(export "__threadInit" (func $~lib/thread/__threadInitPlain))
```

Of the functions that survive, exactly two differ, and both are explained rather
than tolerated:

- `~lib/rt/tlsf/__arenaInit` loses its `__stack_pointer` epilogue and one local;
- `__start`'s constant moves 33084 → 32972 (112 bytes).

In the old module the only shadow-stack user was `__executorExit` — a spawn-half
function this change removes. `grep -c stack_pointer`: **18 → 0**; the
`~lib/memory/__stack_pointer` global disappears, so `__arenaInit`'s
`__stack_pointer = heap` is dead and elided, and 112 bytes is that global's
region. The fixture's own atomics are untouched (`i32.atomic.rmw` count: 42 → 42).

## 4. After the merge

PR #80 merged as a plain **fast-forward** (`00675020..9393acc9`), so the commits
CI verified are the commits on `main`.

```
PR #80        16/16 checks pass — including Bootstrap (debug), Bootstrap (release),
              Compiler (windows, both node lines), Coverage
main          45077077606  completed  success  16/16 jobs
```

`main` @ **`9393acc9`**, bundle `aa74d6a1`.

## 5. What I did not verify

- **The `@lazy` drain as a measured necessity.** `@lazy` is valid only on
  globals — `AS212` for a function and for a namespace — so I could not construct
  a user-level callee that gets enqueued rather than compiled. With the drain
  removed the fixture's bytes are identical. It is insurance against a case I
  could not build, and it costs a hoisted pass, not new logic.
- **Windows.** CI runs it; I did not read that log.
- **A guest that carves main-only and then spawns.** By construction `threads` is
  false only when no spawn name is reachable, so such a guest cannot be written
  in TS — but I could not produce a counterexample to prove the negative.
- **Whether narrowing the layout globals too would be safe.** They are in the
  boot half; nothing on the host reads them. I did not try removing them.
- `docs/threads.md` §1 still says the two imports are emitted "only when the
  module has an async shell" — stale since DL8 and doubly so now. Not touched.
