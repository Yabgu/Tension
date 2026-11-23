# DL18 — the park table is the library's, and main can read a worker's park

`~/work/Tension` `integration/dwarf-debug` @ **`f41fd5c`**, pushed. PR **#83**,
merged fast-forward. CI: **two runs on the merged SHA, both success** —
`45089198370` (push) and `45089532529` (push, E2E debug 1m10s).

`~/work/TensionScript-a2` `main` @ `3f59ec08`, **untouched**. Bundle still
**`aa74d6a1`** — no compiler change.

Phase A memo: `tools/thread-promise/DL18-PHASE-A.md`. This file is the round.

## 0. Phase 0

```
Tension            integration/dwarf-debug  2c786b0   clean
TensionScript-a2   main                    3f59ec08  clean
bundles            aa74d6a1 (tree) = aa74d6a1 (installed)
std/assembly/thread.ts   tree = package, byte-identical (1905948486…)  ← I46 closed
dist/asc.js              tree = package (da283bcd)
```

**The binary was stale and was rebuilt before any measurement.** Before:
`33594528 @ 00:25:55`, with `src/thread.rs` and `src/main.rs` both at `00:43:04`.
After `cargo build --release --bin tension-core`: **`33603864 @ 01:26:54`**, and
`find src -newer target/release/tension-core -name '*.rs'` is **empty**. Every
number below comes from that binary.

## 1. Phase A — the two questions, answered

### A1: the split, and why it decides the round

`Scheduler` (binary) holds `tables: HashMap<u32, ParkTable>` plus counters. Its
**entire** dependency on `session::arena` is one import (`scheduler.rs:50-54`):

```rust
use crate::session::arena::{
    CLASS_AI_DONE, CLASS_AI_ERROR, CLASS_AI_READY, CLASS_COUNT, CLASS_DEVICE_LOST, CLASS_FRAME,
    CLASS_INPUT_KEY, CLASS_INPUT_MOUSE, CLASS_JOB_DONE, CLASS_JOB_FAILED, CLASS_LOG,
    CLASS_RESOURCE_FAILED, CLASS_RESOURCE_READY, CLASS_SUBMISSION_REJECTED,
};
```

**Fourteen scalars. No type, no function, no other path in the file.**

The 240, measured now (whole repo, `node_modules` and `third_party/` excluded):

| where | count |
|---|---|
| Rust | 156 (of which `scheduler.rs` 36, `session/` 97, `ai/` 13, rest 10) |
| guest TS | 91 |
| **total** | **247** |

All 247 are references to those 14 names — there are no scheduler *internals* in
the count, because the count is defined as references to the class identifiers.
The number that actually matters for the round is what a library table must name:
**14 scalars, and it turns out it need not name even those**, because the two
policies can be injected. That is the design.

### A2/A3/A4: the renumber stops here

**A2 says it is safe in principle.** `__taskBindFamily` has seven callers, all
guest-side (`tension-framework/assembly/runtime/rt.ts:70-81`, inside
`rt.start()`). The host does not bind, and std does not call it, so the host could
adopt `family = class >> 4` alone.

**A3/A4 say not in this round, and not for the reason the ref count suggests.** A
`tag << 4 | ordinal` encoding reproduces every family, but `CLASS_COUNT = 13`
sizes arrays **indexed by the raw class id**:

```
main.rs:2314            data.drop_seen[class as usize]
session/config.rs:292   ring_capacities[class as usize]
session/subring.rs:132  capacities[class as usize]          (also :172, :212)
session/epoch.rs:74     slot_address(capacities: &[u32; CLASS_COUNT], class, slot)
scheduler.rs:252        capacities: [u32; CLASS_COUNT]
adapter/mod.rs:1315     drop_seen: [0; CLASS_COUNT]
rt.ts:42-46 (guest)     for (let i = 0; i < class_; ++i) …   ← walks every class below
config.ts:78 (guest)    effectiveRingCapacities[class_] = capacity
```

Values to 144 make all of those out-of-bounds indices or a 144-iteration walk.
Fixing them needs a `class → dense ordinal` map on **both** sides — more agreement,
not less. And the ids are a wire value (`session/arena.rs:212-217`: *"Moving one is
an SDK bump, not a local edit"*), pinned by guest tests that subscribe by number.

Reported; it becomes its own two-repo round whose first decision is the mapping.

## 2. Phase B — the change

**`ParkTable` moved to the library and the binary adopts it.** `scheduler.rs` loses
93 lines and gains:

```rust
/// **The table is the library's type, adopted here (DL18).** It used to be defined
/// in this file, which made it unreachable from a worker — `scheduler` is a module
/// of the binary (`main.rs:81`) and a worker's store comes from the library
/// (`lib.rs:40`). Defining it there and using it here is one type with two
/// holders, which is what "a worker gets a table at birth" needs.
use tension_core::thread::ParkTable;
```

`Scheduler`'s own code is unchanged: `tables: HashMap<u32, ParkTable>`,
`.entry(family).or_insert_with(|| ParkTable::new(bound))`, `insert`,
`take`, `take_upto`. Only `new` and `insert` became `pub`.

**The library gains `ParkLedger`** — `family → ParkTable` plus the two injected
policies:

```rust
pub struct ParkLedger {
    tables: HashMap<u32, ParkTable>,
    /// `class -> family` — `scheduler::family_of` on the binary side.
    family_of: fn(u32) -> u32,
    /// `family -> key bound`, `None` when the family is not awaitable —
    /// `scheduler::key_capacity` on the binary side.
    bound_of: fn(u32) -> Option<u32>,
}
```

with `record(class, key, task_id) -> bool`, `get`, `parked`, `snapshot()`,
`take(class, key)`. It speaks **class** at its boundary and stores by **family**,
exactly as `Scheduler` does.

**`ExecutorPool` gains `parks: Mutex<ParkLedger>`**, built at pool creation from
the binary's two functions (`host/guest.rs:231-241`):

```rust
let pool = ExecutorPool::new(
    config.engine.clone(), module.clone(), memory.clone(), config.executors + 1,
    crate::scheduler::family_of,
    crate::scheduler::key_capacity,
)?;
```

The pool is the object the host already shares between every store it creates, so
the table exists where main can reach it.

**The park seam writes both records.** The store-local `Vec<WorkerPark>` (DL10's
recorder — kept, because the strand refusal counts it while the store is alive)
and the shared ledger:

```rust
let recorded = {
    let mut ledger = pool.parks.lock().unwrap_or_else(|p| p.into_inner());
    ledger.record(park.class, park.key, park.task_id)
};
```

**References moved: zero.** The class-constant count is identical before and after
— 156 whole-repo, 36 in `scheduler.rs`, 0 in `thread.rs`. The 240 was never a
migration cost; under "create it where the worker can reach it", it is 0.

## 3. Phase C — main can see a worker's park

`strand-nested.ts`, `--executors 2`, `TENSION_LOG_LEVEL=debug`:

```
DEBUG thread: executor 1: the pool's park table holds 1 entry
DEBUG thread: main reads the pool's park table: [(4, 7, 0)]
```

`(family, key, task_id)` — jobs, key 7, task 0. Read **on main**, through
`pool.parks()`, in `strand_refusal`, after the worker's store is gone. The entry
matches DL11's own measurement of this guest (`task 0 on class 4 key 7`), so the
two independent reaches agree.

Before this round the observation was impossible: the record lived in
`WorkerState::parks` and died with the store, and the binary's table was
unreachable from a worker. DL19's wake has something to iterate now.

**The strand refusal still fires** — exit 1:

```
Error: a worker's task cannot be resumed on this host, so this run would otherwise
have exited successfully with it stranded: executor 1 left 1 task(s) parked and
never resumed (first: task 0 on class 4 key 7). …
```

**`resolved` is still dead, and both sites say so.** `ParkLedger::take` is the
resolver (absence from the table *is* resolution) and nothing calls it — a wake is
what would. `WorkerPark::resolved` keeps its DL12B meaning and is still written
`false` by the only code that builds one, with the comment naming what sets it
next. The round adds the *representability*; DL19 adds the caller.

## 4. Regressions

| check | result |
|---|---|
| `cargo test --test threads` | **5 passed** |
| `cargo test --test async_main_promise` | **2 passed** |
| `cargo test --bin tension-core` | **307 passed** (unchanged) |
| `cargo test --test e2e_debug` | 3 passed — what this repo's CI runs |
| `cargo test --test debugger` | 5 passed — ditto |
| `examples/async-on-main` | **28 lines**, `main: done, total=67`, exit 0 |
| `plain-worker.ts` | `before=0 workIndex=0 spawn=0 join=0 counter=10`, exit 0 |
| stranding guest | exit 1, DL12B refusal |

Artifacts **force-rebuilt** first (`25 built, 0 up to date`). The suites were run
**twice**: once after the change, and again after the final build, because the
last edit (removing a stale `mut`) rebuilt the binary. Both runs are green; the
numbers above are the second.

**No census**: it measures continuations, this round does not touch the compiler,
and the decline is declared.

## 5. What the delta actually was

| file | declared? | changed |
|---|---|---|
| `tension-core/src/thread.rs` | yes | +364/−10 |
| `tension-core/src/scheduler.rs` | yes | −103/+4 |
| `tension-core/src/main.rs` | yes | +16/−2 |
| `tension-core/src/host/guest.rs` | **no** | +6 — the pool constructor gained its two policy arguments; unavoidable |
| `docs/abi/guest.md` | conditional | 9 rows, **line numbers only**, regenerated because `thread.rs` grew |
| `lib.rs`, `arena.rs`, `docs/threads.md` | conditional on the renumber | **untouched** |

The renumber did not clear, so no prose doc joins the delta. The ABI regeneration
is mechanical (the doc embeds `file:line`; leaving it stale fails
`test-abi-docs.mjs`). Row count unchanged at 96. `test-abi-docs.mjs` still reports
only I36 (the hook-copy check), reported not fixed.

No compiler change: `dist/assemblyscript.js` = `aa74d6a1`.

## 6. What I did not verify

- **That a park recorded on main reaches the same ledger.** It does not, by
  design: main's parks go to the binary's `Scheduler`, which now uses the library
  *type* but its own storage. The brief asked for one type and for workers to get
  a table at birth; a single table for both would mean main's `Scheduler` handing
  its whole state to the library, which is larger than this round. So "one type,
  two holders" is exact, and "one storage" is not claimed.
- **The `record` refusal path at Trace.** A park outside the awaitable space (a
  family `key_capacity` answers `None` for) logs at Trace and is kept as a strand.
  No guest in this repo parks on such a class, so that branch is unexercised.
- **DL11's stackful hang** (EXIT=124) — untouched, still undiagnosed.
- **A worker parking twice on one key.** `ParkTable::insert` overwrites (its own
  documented rule), and the ledger inherits that; the displaced entry is dropped
  rather than reported. Unmeasured here.
- **Windows.** Unchanged by this round and not run.
