# Threads: the host's half of the ABI

The guest half is TensionScript's: `docs/thread-abi.md` in the pinned submodule
is the contract, `std/assembly/thread.ts` implements it, and
`tests/rt/gate4.js` exercises it under Node. **This page is the host side** —
what `tension-core` must do, what it must not do, and where each piece lives.

One sentence of context matters before anything else: **Wasmtime 50 has no
thread spawning.** It can create a `SharedMemory`, instantiate one module twice
over it, and run two `Store`s on two OS threads — but nothing in the API starts
that thread for you. That is the entire reason the guest imports two functions
instead of calling into something.

## 1. The two imports

```ts
@external("env", "__executorCount") declare function __executorCount(): i32;
@external("env", "__startThread")  declare function __startThread(execId: i32): i32;
```

Both are emitted only by a `--sharedMemory` build, and only when the module has
an async shell (a program with no `$starts` table has nothing to serve requests
from, so it gets neither).

- **`__executorCount() -> i32`** answers the number of executors this instance
  was configured for: main plus the pool. It is read once, by `__threadInit`, and
  decides the carved header's `executorTotal`. On this host it is
  `--executors <N>` + 1, and `1` for a guest with no pool.
- **`__startThread(execId) -> i32`** is called *after* the guest has filled that
  executor's record and set its state word to `1`. It creates the worker's
  instance and starts its thread. `0` means the thread is running; anything else
  means the worker never started, and `__spawnThread` treats that as "unborn".

## 2. Who writes what

**The guest writes the spawn record.** `__spawnThread(id, entryIndex, argSlot)`
is guest code: it fills the record's spawn entry and argument, calls
`__startThread(id)`, and on a non-zero answer marks the executor exited. The host
never writes one word of guest memory on this path — not a boot word, not the
state word, not the arena bounds.

**The host reads only what the guest published, through the guest's own
accessors**: `__workerArenaBase(id)` and `__workerArenaSize(id)`. Reading the
record by offset would be a second statement of a layout the guest owns.

**The host does call `__arenaInit`** — on main, before `__start`, and on each
worker, before `__workerMain`. That is not a contradiction: `__arenaInit` moves
`__stack_pointer`, so it must run with **no live guest frame**, and the only
caller with no live frame is the host. `__threadInit` deliberately does not call
it, for a measured reason (a frame's shadow-stack slots are addressed relative to
that pointer).

## 3. The boot order, and the one entry each instance gets

Main:

```text
instantiate  →  __threadInit(capacity)  →  __arenaInit(__mainArenaBase(), __mainArenaSize())
             →  __start()               →  _start_game() (if the guest exports one)
```

Worker:

```text
instantiate (same module, new Store, same memory)
             →  __arenaInit(__workerArenaBase(id), __workerArenaSize(id))
             →  __workerMain(id)        ← and that call is the thread's whole body
```

**A worker never calls `__start`, and `main` never runs again.** A
`--sharedMemory` module has no start section precisely so this is possible: a
start section runs on *every* instantiation, so every worker would run `main` on
its own globals against the shared memory. `__start` is main's boot body and
shell; a worker's globals are zero, and its only state is what `__workerMain`
binds from the carved block (which it finds from `__heap_base`, the same constant
in every instance).

`__threadInit` is a no-op on a second call, so a guest that calls it itself is
not an error.

## 4. What the host must not do

- **Write guest memory before a spawn.** The guest has already published the
  arena bounds, both rings and the spawn entry. A host write is a second writer
  racing the guest's own.
- **Run `main`, `_start_game` or `__start` on a worker.** One entry per
  instance; the wrong one means two `main`s against one memory.
- **Call `__arenaInit` from inside guest code** (see §2).
- **Block on a worker the guest never joined.** `__threadJoin` is the guest's
  obligation; the host joins what has finished, gives the rest a short grace (a
  finishing worker still has a `Store` to drop after writing the exit word), and
  then names the unjoined executor in the log rather than hanging.

## 5. Where the code is

| piece | file |
|---|---|
| `ExecutorPool` — the count, the shared memory, the worker threads | `tension-core/src/thread.rs` |
| `WorkerState` — a worker's store data (it reaches nothing but the pool) | `tension-core/src/thread.rs` |
| `GuestMemory` — a linear **or shared** memory, for verbs that read guest bytes | `tension-core/src/thread.rs` |
| `define_memory`, `shared_memory_import`, `link` (the two imports) | `tension-core/src/thread.rs` |
| pool creation + memory definition, in the per-guest build | `tension-core/src/host/guest.rs` |
| the boot sequence (`thread_boot`) and the join at teardown | `tension-core/src/main.rs` |
| the pool handle the imports read through `Caller::data()` | `HostState::executors` |
| the flag | `--executors <N>` (worker threads; main is always one) |
| the tests | `tension-core/tests/threads.rs`, programs in `tension-core/tests/programs/` |

## 6. Edges this host has, measured

These are the places where the contract and this host disagree or are silent.
Each was found by running a real guest, not by reading.

1. **A worker's import set is narrow, and `tension::io` had to join it.** A worker
   instantiates *the same module*, so it imports exactly what main's build
   imports: a name with no definition is a failed instantiation, not a declined
   verb. Measured: `spawn-join.ts` refused to start its worker with
   `unknown import: tension::io::print has not been defined`. `tension::io` is the
   one namespace that can be answered on a worker honestly — it is a pure function
   of the store — so the worker gets it, with the three answers a worker can give
   (`arg_count` 0, `arg` `-1`, `read_line` `-1`). Everything else (session,
   platform, and every capability) stays out: its state is a process singleton
   (one window, one device, one input layer), so it is only meaningful on the
   thread that owns it. **A guest that imports a capability therefore cannot be
   started as a worker yet**, and the refusal names the import.
2. **`Extern::into_memory()` answers `None` for a shared memory.** A
   `--sharedMemory` guest exports `Extern::SharedMemory`; the export is present,
   `is_some()` is true, and `into_memory()` is still `None`. Measured as a panic
   in `tension::io print` — "game must export a memory named 'memory'" while the
   export sat right there. `GuestMemory` resolves either kind; `print` and a
   worker's `abort` read through it. The other verbs still take the linear path,
   which is a real edge for a shared-memory guest that calls them.
3. **Several requests in flight collapse to the last one's argument** at this pin.
   Measured with three requests posted before a worker drains them: `work` was
   served three times and every serve observed the *third* request's argument.
   The same fixture fails identically under TensionScript's own Node harness, so
   it is the guest runtime, not this host. `two-workers.ts` therefore posts one
   request, pumps until it is observed, and posts the next; that loop is the thing
   to collapse when the runtime is fixed.
4. **`__executorCount` is a host value, not a guest one.** A guest that asks gets
   the pool it was configured with. A hand-written module with a shared memory
   and no `__threadInit` gets no carve and the pool still answers — which is what
   `tension-core/src/thread.rs`'s unit test exercises.

## 7. Tests

`tension-core/tests/threads.rs` runs four guests through the real binary:

- **count** — `__executorCount()` answers `--executors + 1`, and the carved
  block's numbers are readable from the guest's exports (which is how the boot
  *order* becomes observable).
- **spawn and join** — a request crosses to a worker, the worker replies with its
  own id and its computed value packed into one `i32` (`242` for `21` doubled on
  executor 1), main serves the reply, `__threadJoin(1)` is `0`.
- **two workers, twelve tasks** — every value observed exactly once: count 12,
  value sum 66, worker sum 30.
- **the refusals** — `-1` for an id out of range at both ends, `-2` for a second
  spawn of a live id.

The programs are `.ts` in `tension-core/tests/programs/`, built by
`scripts/build-test-programs.mjs` with the repository's pinned compiler. They are built at
`--optimizeLevel 0` for speed and artifact size. That is a choice, not a limit: the pin at
`150a6e97` compiles a continuation module at `-O1..-O3`, and
`tension-core/tests/gallery_optimized.rs` runs `async/schedule-order.ts` at `-O2` and
asserts its transcript is identical to the `-O0` one (169,839 → 23,332 bytes).

Cross-reference: TensionScript `docs/thread-abi.md` §4 (the imports), §5.1 (why
an index crosses and a reference does not), and `tests/rt/gate4.js` (the same
shapes under Node, which is where a host difference shows up).
