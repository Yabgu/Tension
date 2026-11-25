//! The thread ABI's host half: `env.__executorCount` and `env.__startThread`.
//!
//! TensionScript's `docs/thread-abi.md` is the contract; this module is the
//! Tension side of it. Both imports are emitted by a `--sharedMemory` build, and
//! nothing else in this tree answers them — Wasmtime 50 can create a
//! `SharedMemory` and instantiate the same module twice over it, but it has no
//! thread spawning at all. The spawn is ours, which is why the import exists.
//!
//! # What the guest publishes, and what the host may do
//!
//! Before `__startThread(id)` is called, the guest has already written that
//! executor's record — arena bounds, both rings, the spawn entry — into the
//! carved control block, and set its state word to `1`. So:
//!
//! * **the host writes no guest memory** here. Not the boot words, not the state
//!   word, not the arena bounds. `__spawnThread` is the only writer, and it is
//!   guest code (`std/assembly/thread.ts`);
//! * **the host reads the record only through the guest's own accessors** —
//!   `__workerArenaBase(id)` / `__workerArenaSize(id)` — so the layout stays the
//!   guest's to change;
//! * **`__start()` is never called on a worker**, and `main` never runs again.
//!   `__start` is main's boot body and shell; a second call on a worker's store
//!   would run `main` against the shared memory on a second thread.
//!
//! # Why a fresh `Store` and not the caller's
//!
//! A wasm reference — a continuation, an object — belongs to the store that made
//! it and cannot cross. The instance is therefore **the same module** (so
//! `$starts` indices mean the same functions everywhere) with **new globals,
//! tables and stack** (so each thread has its own continuation table and its own
//! heap), over **one memory** (the only thing they share).
//!
//! # Why this type is in the library
//!
//! `tests/threads.rs` is an integration test, so it links this crate's library
//! target rather than the binary. The pool is here for the same reason
//! `platform` and `render2d` are: it is core infrastructure that a test — and,
//! next, a nested guest — has to be able to stand up, and it needs nothing from
//! `main` to do it.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use wasmtime::{Caller, Engine, ExternType, Linker, Module, SharedMemory, Store};

use crate::logging::{self, Level};

/// A store whose epoch never fires: half the range, for the reason
/// `host/guest.rs` records — `u64::MAX` overflows once the engine's epoch has
/// advanced.
const NEVER_TRAPS: u64 = u64::MAX / 2;

/// Refusals. The contract fixes only "0 is success"; these are the host's own
/// negatives, and `docs/threads.md` lists them for an operator reading a log.
///
/// **These numbers share a channel with the guest's own refusals** — the value
/// an exported `__workerMain` answers (`std/assembly/thread.ts` in TensionScript
/// answers `-1` for a bad id or a non-shared build, `-2` for an uncarved control
/// block and `-3` for an arena that does not cover the record). `-1` agrees;
/// `-2` and `-3` do not. Nothing reads the guest's answer today except the Debug
/// lines in [`run_worker`] and [`ExecutorPool::join_finished`], so the collision
/// is latent rather than active — but a negative read off a log belongs to
/// whichever side produced it, and renumbering either half is an ABI change with
/// its own round. See I39.
pub const ERR_ID_OUT_OF_RANGE: i32 = -1;
pub const ERR_ALREADY_BORN: i32 = -2;
pub const ERR_INSTANTIATE: i32 = -3;
pub const ERR_EXPORT_MISSING: i32 = -4;
pub const ERR_WORKER_TRAPPED: i32 = -5;
pub const ERR_SPAWN_FAILED: i32 = -6;

/// The store data of a worker instance.
///
/// Deliberately tiny: a worker is an executor of the same program, not a second
/// guest. It reaches nothing but the pool, so the two imports a worker's own
/// module also imports (`__executorCount`, `__startThread`) can be answered from
/// inside a worker too.
///
/// **`parks` is a record, not a table.** A worker is a `Store` and therefore an
/// *owner thread* under `docs/scheduler-contract.md` §2.2, so `scheduler::park`
/// may legally be called here — but the contract's other half is that the guest
/// MUST be resumable from the park the moment the call returns, and nothing can
/// resume this store: no host loop runs on a worker, and `wake` may only be
/// called on this store's owner thread, which is inside `__workerMain`. So the
/// seam records the three integers the contract's call carries and nothing more.
/// `run_worker` logs the count, which is the difference between "reached the
/// seam" and "was resumed", kept as two facts on purpose.
///
/// Why the record is a plain tuple list rather than the binary's `Scheduler`:
/// that type is keyed by the session ABI's class ids and per-class key spaces
/// (`src/session/arena.rs`, 36 references in `scheduler.rs`), and `session` is a
/// module of the **binary**. This crate is the library, so a park that could be
/// resolved the way main's is would need that ABI moved into the library — which
/// no round is allowed to do casually. The record is the honest fraction that
/// fits on this side of the boundary.
///
/// **Since DL22 it is also the authoritative answer to "did this store resume
/// this park"**, which the shared ledger cannot give: the ledger holds one entry
/// per key, so a displaced second waiter is absent from it whether or not it was
/// ever resumed. This list holds one entry per park, in the order they happened.
pub struct WorkerState {
    pool: Arc<ExecutorPool>,
    parks: Mutex<Vec<WorkerPark>>,
    /// **The word each delivery carried, by task id** (DL41).
    ///
    /// `scheduler::completion(task_id)` asks "what did the producer say when you
    /// resumed me?", and on a worker store the only honest answer is the payload
    /// of the delivery the *session loop* applied to that task. The channel already
    /// carries it (`Delivery::payload`); before this the loop used only the id, so
    /// the word was dropped on the floor for a worker-resumed task.
    ///
    /// Bounded by construction: one entry per task the store has resumed, and a
    /// store's task table is the guest's own (16 slots in every program here). A
    /// later delivery for the same id replaces the word, because the task that
    /// consumed the first one has already resumed.
    delivered: Mutex<Vec<(u64, i32)>>,
    /// Wakes this store has served by resuming a suspended park (DL41). Header word
    /// 6 is what the guest reads; the session loop keeps its own count in
    /// `service_wakes`, and the two never apply the same delivery.
    served: std::sync::atomic::AtomicU64,
    /// **Which executor this store is.** The ledger's `owner` is routing, and this
    /// is where a worker learns its own, so a park it records names the store that
    /// must later call `__taskWake`. It is the id the host gave `__workerMain`.
    id: i32,
}

/// The empty marker in a direct table. `u64::MAX` rather than 0, because task id
/// 0 is a valid slot index in the guest's table.
const EMPTY_TASK: u64 = u64::MAX;

/// One family's parked tasks: a direct array indexed by the producer's key.
///
/// **This type is the library's, and that is the point of DL18.** It lived in the
/// binary's `scheduler.rs`, where a worker could not reach it: `session` and
/// `scheduler` are modules of the binary (`main.rs:81`, `:90`) while
/// `WorkerState` and `ExecutorPool` are the library's (`lib.rs:40`). A worker
/// gets its store from the library, so a table it can reach had to be *created*
/// here — main then adopts it (`scheduler::Scheduler` holds
/// `HashMap<u32, ParkTable>` of this type, unchanged).
///
/// The type names **no class constant and no session type**: the family→bound
/// policy belongs to the producers (`scheduler::key_capacity`), so it is handed
/// in by [`ParkLedger::new`] as a function. That is what keeps the library free
/// of `session::arena` — the 14 scalars `scheduler.rs` still needs are its own
/// business.
#[derive(Debug)]
pub struct ParkTable {
    /// One entry per key in `0..=bound`. EMPTY_TASK when nothing is parked.
    slots: Vec<u64>,
    parked: u32,
}

impl ParkTable {
    pub fn new(bound: u32) -> ParkTable {
        ParkTable {
            slots: vec![EMPTY_TASK; bound as usize + 1],
            parked: 0,
        }
    }

    /// How many tasks are parked in this family.
    pub fn parked(&self) -> u32 {
        self.parked
    }

    /// The task id parked on `key`, if any.
    pub fn get(&self, key: u32) -> Option<u64> {
        let slot = *self.slots.get(key as usize)?;
        (slot != EMPTY_TASK).then_some(slot)
    }

    /// Register `task_id` for `key`, answering the id it displaced (if any).
    ///
    /// **Overwrite, not refuse**, because the guest's own registration already
    /// overwrites: `__taskPark` does `byKey.set(keyOf(family, key), record)`
    /// (`task-rt.ts:246`). A re-park of a key is how a task awaits the same
    /// producer id twice — the AI stream does it every chunk, and the OGRE
    /// loader every sequential load — so a host that refused would strand the
    /// second park while the guest considered it parked.
    ///
    /// Liveness is the guest's to know, not the host's: the slot table is where
    /// the continuation lives (contract §1.2), so a displaced entry whose task
    /// had already resumed is a stale hint, not a live park. A wake for such an
    /// id is a no-op in `__taskWake` (its slot is empty). §4.9's "refuse a
    /// second concurrent park on one pair" is enforced where it can be decided
    /// — the guest's slot table — not by a host that cannot see a resume.
    pub fn insert(&mut self, key: u32, task_id: u64) -> Result<Option<u64>, ()> {
        let slot = match self.slots.get_mut(key as usize) {
            Some(slot) => slot,
            None => return Err(()),
        };
        let displaced = (*slot != EMPTY_TASK).then_some(*slot);
        if displaced.is_none() {
            self.parked += 1;
        }
        *slot = task_id;
        Ok(displaced)
    }

    /// Remove and answer the task parked on `key`.
    pub fn take(&mut self, key: u32) -> Option<u64> {
        let slot = self.slots.get_mut(key as usize)?;
        if *slot == EMPTY_TASK {
            return None;
        }
        let task_id = *slot;
        *slot = EMPTY_TASK;
        self.parked -= 1;
        Some(task_id)
    }

    /// Take up to `limit` parked ids, lowest key first.
    ///
    /// The drop path's accessor (§4.4): a lost signal is attributed to a
    /// *family*, not a record — the producer's count cannot say which stream
    /// lost it (`pre0`'s note, and `rt.ts`'s rollup) — so the wake names the
    /// family's parked tasks rather than trying to match a key that never
    /// arrived. Lowest key first only so the order is deterministic in a test.
    pub fn take_upto(&mut self, limit: usize) -> Vec<u64> {
        let mut taken = Vec::new();
        if limit == 0 {
            return taken;
        }
        for index in 0..self.slots.len() {
            if taken.len() == limit {
                break;
            }
            if self.slots[index] != EMPTY_TASK {
                taken.push(self.slots[index]);
                self.slots[index] = EMPTY_TASK;
                self.parked -= 1;
            }
        }
        taken
    }

    /// Every parked `(key, task_id)` in key order — the reader behind
    /// [`ParkLedger::snapshot`].
    pub fn entries(&self) -> Vec<(u32, u64)> {
        let mut out = Vec::new();
        for (key, slot) in self.slots.iter().enumerate() {
            if *slot != EMPTY_TASK {
                out.push((key as u32, *slot));
            }
        }
        out
    }
}

/// A completion that arrived **before** its park (§4.3).
///
/// Bounded by the class's declared key space, and keyed by `(class, key)` — the
/// await's identity, which is repeatable, as opposed to a task's handle, which is
/// not. One outstanding completion per pair is the contract's default coalescing
/// (`docs/scheduler-contract.md` §1.6); a stream class that declares otherwise
/// would need a queue per pair, which nothing declares today.
#[derive(Clone, Copy, Debug)]
pub struct EarlyCompletion {
    pub class: u32,
    pub key: u32,
    pub payload: i32,
}

/// A matched task, waiting for its owner to consume it (§3.4's hand-off).
///
/// **The owner is named because the queue is shared.** All executors' inboxes are
/// one `Vec` under one lock, and a worker takes only its own entries. That is what
/// keeps `wake` on the store's owner thread (§2.2): this struct is *data* a
/// non-owner may write; calling it is the owner's job alone.
#[derive(Clone, Copy, Debug)]
pub struct Delivery {
    pub owner: u32,
    pub task_id: u64,
    pub class: u32,
    /// The producer id the completion was posted for. Carried **only** so a refusal can
    /// name the pair a foreign delivery was for (I55): the wake itself needs the task id
    /// alone. Without it the refusal would say "some completion" and the reader would
    /// have nothing to search the producer for.
    pub key: u32,
    pub payload: i32,
}

/// One parked task, as the **session ledger** holds it: three words.
///
/// **Why three and not one.** The handle is the right *identity* — a record's
/// address is an offset into the session's one shared linear memory, the same
/// number in every store and unique across them (measured: `HEAP_BASE = ARENA ?
/// initialHeapBase() : __heap_base`, and the collector frees without compacting).
/// But it is **not** the argument `__taskWake` takes: that is a *store-local*
/// slot id (`std/assembly/task-rt.ts`), and `TaskRecord` carries no slot field —
/// `state.slot` lives on `TaskState`. Deriving the id from the pointer would mean
/// scanning the owning store's `slots` table for `slot.record == handle`, which is
/// O(capacity) per wake against the contract's §3.3 O(1).
///
/// So the entry carries both, plus the route:
///
/// - `handle` — where the suspended task lives. The identity; survives a policy
///   moving the task, because a move is then a field update inside the record.
/// - `owner` — the executor that **parked**. Routing only: it says which store
///   must be told to call its own `__taskWake`. It is not the executor the task
///   will run on — a policy may move a task later, and the ledger does not encode
///   where it runs.
/// - `task_id` — the store-local slot id, which is what the owner's `__taskWake`
///   actually reads.
///
/// **Liveness is the owning store's** (`slots[id].record` roots the record), so
/// this handle must never be the only reference to one. The ledger is an index,
/// not an owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParkedTask {
    pub handle: u64,
    pub owner: u32,
    pub task_id: u64,
}

/// One family's parked tasks, as the ledger holds them: a direct array indexed by
/// the producer's key, each cell a [`ParkedTask`].
///
/// **Not [`ParkTable`]** — that type is the scheduler's and carries a bare task
/// id, which is all main's own tables need. Parameterising it over its value type
/// for one wider field would have widened main's tables too; two shapes, one for
/// each holder, is the smaller diff and states the difference rather than hiding
/// it.
#[derive(Debug)]
struct ParkedTable {
    slots: Vec<Option<ParkedTask>>,
    parked: u32,
}

impl ParkedTable {
    fn new(bound: u32) -> ParkedTable {
        ParkedTable {
            slots: vec![None; bound as usize + 1],
            parked: 0,
        }
    }

    /// Register `entry` for `key`, answering the one it displaced.
    ///
    /// **Overwrite, not refuse**, for the same reason [`ParkTable::insert`] is:
    /// the guest's own registration overwrites, so a re-park of a key is how a
    /// task awaits the same producer id twice. See that method for the full
    /// argument.
    fn insert(&mut self, key: u32, entry: ParkedTask) -> Option<ParkedTask> {
        let Some(slot) = self.slots.get_mut(key as usize) else {
            return None;
        };
        let displaced = *slot;
        if displaced.is_none() {
            self.parked += 1;
        }
        *slot = Some(entry);
        displaced
    }

    fn get(&self, key: u32) -> Option<ParkedTask> {
        *self.slots.get(key as usize)?
    }

    fn take(&mut self, key: u32) -> Option<ParkedTask> {
        let slot = self.slots.get_mut(key as usize)?;
        let entry = slot.take()?;
        self.parked -= 1;
        Some(entry)
    }

    fn parked(&self) -> u32 {
        self.parked
    }

    fn entries(&self) -> Vec<(u32, ParkedTask)> {
        let mut out = Vec::new();
        for (key, slot) in self.slots.iter().enumerate() {
            if let Some(entry) = slot {
                out.push((key as u32, *entry));
            }
        }
        out
    }
}

/// Every family's parked tasks, for one executor set.
///
/// **One ledger type, held by both halves.** `ExecutorPool` owns one and main's
/// `scheduler::Scheduler` owns per-family tables of the same [`ParkTable`], so a
/// park recorded on a worker and a park recorded on main are the same kind of
/// record in the same kind of table — and the pool's copy is reachable from main
/// because the pool is an `Arc` both stores share.
///
/// **The bound policy is a parameter, not a constant.** Which families are
/// awaitable and how wide their key space is (`jobs = 768`, `resources = 1024`,
/// `ai = 4`, …) is a *producer* fact, and it lives in
/// `scheduler::key_capacity` on the binary side. Handing it in as a function is
/// what lets this type be the library's without naming a single class id.
pub struct ParkLedger {
    tables: HashMap<u32, ParkedTable>,
    /// `class -> family` — `scheduler::family_of` on the binary side.
    family_of: fn(u32) -> u32,
    /// `family -> key bound`, `None` when the family is not awaitable —
    /// `scheduler::key_capacity` on the binary side.
    bound_of: fn(u32) -> Option<u32>,
}

impl ParkLedger {
    /// A ledger that resolves and sizes with the **producer's** two policies.
    ///
    /// Both are functions rather than tables so this type can live in the library
    /// without naming a class id: the family map and the key spaces are facts
    /// about producers (`docs/scheduler-contract.md` §3), not about threads.
    pub fn new(
        family_of: fn(u32) -> u32,
        bound_of: fn(u32) -> Option<u32>,
    ) -> ParkLedger {
        ParkLedger {
            tables: HashMap::new(),
            family_of,
            bound_of,
        }
    }

    /// Records a park, answering `false` when it could not be stored.
    ///
    /// `false` means the *family* has no key space (not awaitable — a class
    /// refusal in `scheduler`'s terms) or the key is wider than it. The caller
    /// keeps its own record either way: on a worker the store-local list is what
    /// the strand refusal reads, and a park the ledger declined is still a park
    /// that never resumed.
    pub fn record(&mut self, class: u32, key: u32, entry: ParkedTask) -> bool {
        let family = (self.family_of)(class);
        let Some(bound) = (self.bound_of)(family) else {
            return false;
        };
        if key > bound {
            return false;
        }
        let table = self
            .tables
            .entry(family)
            .or_insert_with(|| ParkedTable::new(bound));
        table.insert(key, entry);
        true
    }

    /// The task parked on `(class, key)`, if one is parked and unresolved.
    pub fn get(&self, class: u32, key: u32) -> Option<ParkedTask> {
        let family = (self.family_of)(class);
        self.tables.get(&family)?.get(key)
    }

    /// How many tasks are parked for a class's family.
    pub fn parked(&self, class: u32) -> u32 {
        let family = (self.family_of)(class);
        self.tables.get(&family).map_or(0, |table| table.parked())
    }

    /// Every parked entry as `(family, key, entry)`, ordered by family then by
    /// the table's own key order.
    ///
    /// **Family, not class**: the tables are keyed by family (a park on
    /// `JOB_DONE` and one on `JOB_FAILED` wait on the same table), so the family
    /// is what an observer can name without re-deriving the map.
    ///
    /// The observation a caller **on another thread** uses: the pool is shared,
    /// so main can read what a worker parked after that worker's store is gone.
    /// A snapshot rather than a reference because the lock must not travel.
    pub fn snapshot(&self) -> Vec<(u32, u32, ParkedTask)> {
        let mut families: Vec<u32> = self.tables.keys().copied().collect();
        families.sort_unstable();
        let mut entries = Vec::new();
        for family in families {
            let Some(table) = self.tables.get(&family) else {
                continue;
            };
            for (key, entry) in table.entries() {
                entries.push((family, key, entry));
            }
        }
        entries
    }

    /// Removes the park for `(family, key)`, answering its entry.
    ///
    /// **This is a bookkeeping step, not a wake.** A wake takes the id and resumes
    /// the task; this only removes the entry, which is the half the host can do
    /// from any thread. `deliver` is its caller.
    ///
    /// **It is no longer the liveness answer (DL22).** The strand refusal reads the
    /// owning store's own `WorkerPark::resolved`, because this ledger holds one
    /// entry per key and so cannot speak for a displaced second waiter. Removing an
    /// entry here says "no park is waiting on this pair any more"; it does not say
    /// which task was resumed, and it never could.
    pub fn take(&mut self, class: u32, key: u32) -> Option<ParkedTask> {
        let family = (self.family_of)(class);
        self.tables.get_mut(&family)?.take(key)
    }
}

/// Which park record a delivery of `task_id` must resume, or why there is none.
///
/// **This is the delivery validation (I55) and the re-park answer (I62) in one
/// function**, because they are the same question asked of the same `Vec`.
///
/// # Why it is not `find(|p| p.task_id == id)`
///
/// A task's `task_id` is its **slot index**, and it is the same for every park that
/// task ever makes (`std/assembly/task-rt.ts`'s `parkState`: `const id = state.slot;
/// hostPark(<i64>id, …)` — one call per suspension, same id each time). The seam
/// pushes a record per park and nothing prunes the vec, so a task that awaited twice
/// leaves **two records with one id**: the first already `resolved`, the second not.
///
/// Find-first therefore marks the **resolved** record a second time and leaves the
/// live park unresolved, and `record_strand` — whose predicate is `!park.resolved` —
/// then reports a stranded task that in fact resumed correctly, failing a healthy run
/// with exit 1. Preferring the unresolved record is the whole of the fix, and it is
/// also what "the park this wake is for" means: a delivery can only resume a task that
/// is waiting.
///
/// # Why `None` is a refusal and not a no-op
///
/// A delivery is produced by `ParkLedger::take`, i.e. by a park that this ledger
/// recorded. A store with **no** record for the id is therefore a store that never
/// parked it: a foreign owner, a recycled slot, or a stale delivery. Waking it would
/// call `__taskWake` with an id that means something else in this store's `slots`
/// table — resuming an unrelated task. There is no legitimate reading of a foreign id,
/// so it is refused by name (see `service_wakes`) rather than passed through.
///
/// The `resolved`-only case is deliberately **not** refused here: a second post for a
/// key that already completed is the engine's own behaviour to keep (the AI stream's
/// READY-then-DONE posts twice for one key by design), and it is measured, not
/// changed, in `DL26-REPORT.md` §C.
pub fn delivery_target(parks: &[WorkerPark], task_id: u64) -> Option<usize> {
    // The unresolved record first: that is the park a wake is *for*.
    if let Some(index) = parks
        .iter()
        .position(|park| park.task_id == task_id && !park.resolved)
    {
        return Some(index);
    }
    // Otherwise a record that exists but is already resolved. Still this store's own
    // task, so the wake proceeds — `__taskWake` is a no-op for an id whose slot is
    // empty (`task-rt.ts:349`: `if (state == null) continue;`). Returning its index
    // marks an already-true flag.
    parks.iter().position(|park| park.task_id == task_id)
}

/// One delivery's timings, in nanoseconds — DL27's instrument.
///
/// **Every field is a segment, never a blend.** The brief is explicit that a number
/// which hides queue wait inside dispatch is a wrong number, so the split is the point
/// of the type and `call_ns` carries the warning that matters:
///
/// - `queue_wait_ns` — the park was recorded until the delivery was taken. **This is
///   the producer's cadence, not an engine cost.** In this round's probe the producer
///   is the park seam itself, so this is the tightest cadence that exists; a real
///   producer (a decode thread, an I/O completion) adds to it and does not change what
///   the engine spends.
/// - `validate_ns` — `delivery_target` under the store's lock, i.e. the I55 guard.
/// - `scratch_ns` — writing the task id into the executor's dead spawn-record words.
/// - `call_ns` — `wake.call`, the call into wasm. **This is not host work.** The guest
///   runs inside it: `__taskWake` → `state.resume` → `f$resume`, until the guest parks
///   again or returns. It is reported as its own column for exactly that reason.
/// - `mark_ns` — setting `resolved` on the record the lookup chose.
#[derive(Clone, Copy, Debug, Default)]
pub struct WakeTiming {
    pub queue_wait_ns: u64,
    pub validate_ns: u64,
    pub scratch_ns: u64,
    pub call_ns: u64,
    pub mark_ns: u64,
}

impl WakeTiming {
    /// The engine's own host work for one wake: everything except the call into wasm.
    pub fn host_ns(&self) -> u64 {
        self.queue_wait_ns + self.validate_ns + self.scratch_ns + self.mark_ns
    }
}

/// Whether the instrument is on (`TENSION_MEASURE=1`).
///
/// **Read once**, because it is consulted on every delivery and every park: a
/// per-call `std::env::var` would itself be the cost being measured. Off by default,
/// and when off the only thing any of this costs is one relaxed atomic load.
pub fn measuring() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        matches!(
            std::env::var("TENSION_MEASURE").as_deref(),
            Ok("1") | Ok("true") | Ok("yes")
        )
    })
}

/// One `scheduler::park` seen on a worker: the contract's three integers.
#[derive(Clone, Copy, Debug)]
pub struct WorkerPark {
    pub task_id: u64,
    pub class: u32,
    pub key: u32,
    /// Whether this store has resumed this park — i.e. some wake named its task.
    ///
    /// **Written by exactly one place**: the session loop's owner thread, at the
    /// moment it calls this store's `__taskWake` for this task id
    /// (`service_wakes`, DL22's P1). Read by exactly one place: the strand
    /// refusal's predicate (`record_strand`), which asks whether *this store* left
    /// it unresolved.
    ///
    /// It is the store's own record on its own thread in both directions, which is
    /// what makes it answerable at all — the shared ledger holds one entry per key
    /// and so cannot speak for a displaced waiter.
    pub resolved: bool,
}

/// A worker that finished with a task parked and never resumed.
///
/// Recorded on the **pool** rather than the store because the store dies with the
/// worker, and the only place that can turn this into a refusal runs on main
/// (`main.rs`, after `join_finished`).
#[derive(Clone, Copy, Debug)]
pub struct Strand {
    /// The executor that stranded: 0 is main, so a real strand is >= 1.
    pub executor: i32,
    /// How many parks were left unresolved on that store.
    pub unresolved: u32,
    /// The first one, for the message: a bare count is not actionable in a
    /// loading zone with eight workers.
    pub first: WorkerPark,
}

/// A delivery the owning store refused to wake: it had no park for that task id.
///
/// **This is a bug whenever it happens** — a foreign owner, a recycled slot, or a
/// stale delivery — so it is recorded rather than logged and dropped, and it fails the
/// run the way a stranded task does (`main.rs`'s refusal path, exit 1). Silence is how
/// the class went unnoticed before DL26.
#[derive(Clone, Copy, Debug)]
pub struct RefusedDelivery {
    /// The executor the delivery was routed to.
    pub executor: i32,
    /// The task id it named.
    pub task_id: u64,
    pub class: u32,
    pub key: u32,
}

impl std::fmt::Display for RefusedDelivery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "executor {} refused to wake task {} (class {} key {}): this store has no park \
             for that id, so the delivery names a foreign or recycled task",
            self.executor, self.task_id, self.class, self.key
        )
    }
}

/// What a linked instance's store must be able to answer for the two imports.
///
/// Implemented by `HostState` in the binary (the process's own guest) and by
/// [`WorkerState`] here (a worker). `None` means "this instance has no pool",
/// which is the honest answer for a module that did not import a shared memory:
/// there is one executor, main.
pub trait ThreadImports: 'static {
    fn executor_pool(&self) -> Option<&Arc<ExecutorPool>>;
}

impl ThreadImports for WorkerState {
    fn executor_pool(&self) -> Option<&Arc<ExecutorPool>> {
        Some(&self.pool)
    }
}

/// The executors of one configured guest: main plus the pool.
///
/// **Named for what it is.** Not a "thread table": the ids belong to the guest's
/// carved control block (`docs/thread-abi.md` §3.2), the arenas belong to the
/// guest, and what the host owns is exactly one OS thread per successfully
/// A test-only request to post one completion **once N parks have landed on a
/// pair** — the deterministic way to get DL22's ordering.
///
/// # Why this exists and what it is not
///
/// DL21's silent-loss shape needs the completion to arrive **after** both waiters
/// have parked, which is what a real producer does and what a loading zone does.
/// `--post-completion` posts at startup, so it always lands in the sticky buffer
/// and is claimed by the first park — the opposite ordering. Reproducing the
/// defect therefore needs a *later* post, and it must be deterministic rather than
/// slept-for.
///
/// The park seam is where "N parks have landed" is an observable fact, and it is
/// the only place that knows it: the ledger holds **one entry per key** (by
/// design — holding N is the fan-out decision), so counting entries cannot answer
/// it. So the counter lives here, incremented by the seam, and the post fires from
/// the seam that reached the target.
///
/// **Nothing about parks, waking or the ledger changes.** The watch counts; it does
/// not store an entry, does not hold a displaced one, and does not wake anything.
/// The post goes through [`ExecutorPool::deliver`], the same door every producer
/// uses, so whatever park a post wakes today it wakes tomorrow.
/// DL28's probe flag: hand executor `owner`'s queue a delivery **the ledger would never
/// produce**, once a park on `(class, key)` has been recorded.
///
/// # Why a separate type from `EachParkWatch`
///
/// They are armed from the same place and for the same reason — the seam is the only spot
/// that knows a worker is *waiting* — but they produce opposite kinds of delivery. The
/// each-park watch posts through `Pool::deliver`, so the ledger matches it and the delivery
/// is legitimate. This one bypasses `deliver` entirely and enqueues directly, which is
/// precisely what makes the delivery foreign: the ledger is never consulted, so nothing has
/// agreed that `task_id` is this store's.
///
/// **A test instrument, and nothing else.** It exists so the refusal path
/// (`service_wakes` → `note_refused_delivery` → main's widened refusal → exit 1) can be
/// measured end to end. A production run cannot arm it.
#[derive(Clone, Copy, Debug)]
pub struct ForeignDelivery {
    pub class: u32,
    pub key: u32,
    /// The task id to name. Deliberately *not* checked against anything: an id the store
    /// never parked is the point.
    pub task_id: u64,
    /// Which executor's queue to hand it to.
    pub owner: u32,
}

/// DL27's probe flag: post a completion for the key of each of the first `remaining`
/// parks of `class`. See [`ExecutorPool::arm_post_each_park`].
#[derive(Clone, Copy, Debug)]
pub struct EachParkWatch {
    pub class: u32,
    pub remaining: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct ParkWatch {
    pub class: u32,
    pub key: u32,
    /// How many parks on `(class, key)` to wait for before posting.
    pub target: u32,
    /// Parks seen on the pair so far. Guarded by the pool's `watch` mutex.
    pub seen: u32,
}

/// started executor, plus the count it was configured for.
pub struct ExecutorPool {
    engine: Engine,
    module: Module,
    /// The one memory every instance of this module sees. Created from the
    /// module's own declared memory type, so the host mirrors the guest's build.
    memory: SharedMemory,
    /// Main **plus** the workers: the value `__executorCount` answers.
    count: i32,
    /// **Whether this module was built for the fiber backend** (DL41).
    ///
    /// Read from the module's own import list, not from a flag: a fiber build is
    /// the only one that imports `scheduler::completion` (measured — the
    /// continuation shape imports `scheduler::park` and never `completion`), so
    /// the artifact says which backend it wants and the worker does what it is
    /// told. Nothing has to be threaded through `ExecutorPool::new`'s callers.
    fiber_backend: bool,
    /// The threads that have been started. `BTreeMap` for deterministic teardown
    /// order, which is what a log line about a live worker should read like.
    workers: Mutex<BTreeMap<i32, JoinHandle<i32>>>,
    /// Workers that finished with a task parked and never resumed, in the order
    /// they finished. Read by [`ExecutorPool::take_strands`] on main.
    strands: Mutex<Vec<Strand>>,
    /// **Workers that could not run at all** (DL41): the message each one refused
    /// with. Separate from `strands`, because a worker that never instantiated made
    /// no parks — counting it as a strand would be a wrong number in a right
    /// sentence. Taken, like the strands, so one failure refuses one run.
    failures: Mutex<Vec<String>>,
    /// DL27's probe: post for every park (see [`ExecutorPool::arm_post_each_park`]).
    /// `None` in an ordinary run.
    each_park: Mutex<Option<EachParkWatch>>,
    /// DL28's probe: inject one foreign delivery once a matching park lands
    /// (see [`ExecutorPool::arm_foreign_delivery`]). `None` in an ordinary run.
    foreign: Mutex<Option<ForeignDelivery>>,
    /// DL27's instrument: one entry per delivery, **only when `TENSION_MEASURE=1`**.
    /// Empty otherwise, so an unmetered run allocates nothing.
    timings: Mutex<Vec<WakeTiming>>,
    /// When the most recent park was recorded, for `queue_wait_ns`.
    ///
    /// Only the latest is kept, and that is sound for this probe's shape (one worker,
    /// parks strictly in sequence, each completing before the next begins). It would
    /// not be sound for concurrent parks, and a future round measuring those needs a
    /// per-park stamp rather than a pool-level "last".
    last_park_at: Mutex<Option<std::time::Instant>>,
    /// Deliveries refused by their store because it had no park for the id (I55).
    /// Read by [`ExecutorPool::take_refused_deliveries`] on main.
    refused_deliveries: Mutex<Vec<RefusedDelivery>>,
    /// **The park table, owned by the executor set rather than by a store.**
    ///
    /// This is the change DL18 exists for. Before it, a worker's parks lived in
    /// the worker's own `Store` (`WorkerState::parks`) and died with it, so main
    /// could never see one; the binary's `Scheduler` had a table no worker could
    /// reach, because `scheduler` is a binary module and this crate is the
    /// library. The table now lives where the host already shares one object
    /// between the stores it creates — the pool, an `Arc` both sides hold — so
    /// main reads a worker's park through `parks()` after the worker is gone.
    parks: Mutex<ParkLedger>,
    /// Completions that arrived before their park, per `(class, key)` — §4.3's
    /// sticky wake, for the whole session.
    ///
    /// Main has had this since the epoch work (`scheduler::RecentCompletions`),
    /// but only *main's* `Scheduler` had it, so a completion posted before a
    /// **worker's** park had nowhere to wait and was dropped. This is the same
    /// protection for the pool, which is where a worker's park lives.
    early: Mutex<Vec<EarlyCompletion>>,
    /// Matched tasks, per owner, waiting for that owner to come round and call
    /// its own `__taskWake` (§3.4's hand-off).
    inboxes: Mutex<Vec<Delivery>>,
    /// Test-only: post once N parks have landed on a pair (DL22's ordering).
    ///
    /// `None` unless `--post-completion-after-parks` armed it, so a production run
    /// carries an empty `Option` and nothing else.
    watch: Mutex<Option<ParkWatch>>,
    /// Set by session shutdown; every worker's loop wakes and leaves.
    stop: AtomicBool,
    /// Paired with `stop`: a real primitive, not a spin (§3.2/§4.4).
    wake: Condvar,
}

impl ExecutorPool {
    /// Whether the module was built for the fiber backend (see the field).
    pub fn is_fiber_backend(&self) -> bool {
        self.fiber_backend
    }

    /// Build a pool for a module whose memory import is shared.
    ///
    /// `count` is main plus the worker threads; it is what `__executorCount`
    /// answers, and the guest decides everything else from it (`__threadInit`
    /// carves `count` records).
    pub fn new(
        engine: Engine,
        module: Module,
        memory: SharedMemory,
        count: usize,
        family_of: fn(u32) -> u32,
        bound_of: fn(u32) -> Option<u32>,
    ) -> anyhow::Result<Arc<Self>> {
        let count = i32::try_from(count.max(1))
            .map_err(|_| anyhow::anyhow!("the executor count does not fit in an i32"))?;
        let fiber_backend = module
            .imports()
            .any(|import| import.module() == "scheduler" && import.name() == "completion");
        Ok(Arc::new(ExecutorPool {
            engine,
            module,
            memory,
            count,
            fiber_backend,
            workers: Mutex::new(BTreeMap::new()),
            strands: Mutex::new(Vec::new()),
            failures: Mutex::new(Vec::new()),
            refused_deliveries: Mutex::new(Vec::new()),
            each_park: Mutex::new(None),
            foreign: Mutex::new(None),
            timings: Mutex::new(Vec::new()),
            last_park_at: Mutex::new(None),
            parks: Mutex::new(ParkLedger::new(family_of, bound_of)),
            early: Mutex::new(Vec::new()),
            inboxes: Mutex::new(Vec::new()),
            watch: Mutex::new(None),
            stop: AtomicBool::new(false),
            wake: Condvar::new(),
        }))
    }

    /// The value `__executorCount` answers.
    pub fn count(&self) -> i32 {
        self.count
    }

    /// Records that executor `id` finished with `parks` left unresolved.
    ///
    /// Called once per worker, from [`worker_main`], at the last moment the
    /// worker's own store is alive. One `Strand` per worker, not one per park: a
    /// loading zone with eight workers needs "which one, how many", and the first
    /// park is carried for the message.
    fn record_strand(&self, id: i32, parks: &[WorkerPark]) {
        // **The owner's own record is the truth (DL22 / P2).**
        //
        // Until now liveness came from the *shared ledger* — a park was a strand
        // while some `ParkLedger::take` had not removed its entry. That is a
        // main-side view of a worker's park, and it holds one entry per key, so it
        // could not answer for a second waiter: the displaced task was absent from
        // the ledger for a reason that has nothing to do with being resumed, and
        // the count came out **0** while a task sat abandoned (DL22's reproduction,
        // exit 0 with `waiter 1` never resumed).
        //
        // The park vec this is handed is the store's own list, one entry per park
        // in the order they happened, and `service_wakes` sets `resolved` on the
        // entry whose task it just woke — on this thread, about this store. So the
        // predicate reads the only party that can actually know:
        //
        //     let is_strand = |park: &WorkerPark| !park.resolved;
        //
        // A park the ledger declined (a family that is not awaitable) was never
        // resumable and is `!resolved` too, which is right: it is a strand.
        //
        // The predicate is unconditional and per park, so it is the same statement
        // for one waiter or eight, and it survives any fan-out policy: a policy
        // that resumes two tasks of one key marks two entries resolved, and this
        // line needs no change.
        let is_strand = |park: &WorkerPark| !park.resolved;
        let unresolved = parks.iter().filter(|park| is_strand(park)).count();
        if unresolved == 0 {
            return;
        }
        let first = match parks.iter().find(|park| is_strand(park)).copied() {
            Some(park) => park,
            None => return,
        };
        let mut strands = self
            .strands
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        strands.push(Strand {
            executor: id,
            unresolved: unresolved as u32,
            first,
        });
    }

    /// Record a delivery this store refused to wake (I55).
    ///
    /// Called by [`service_wakes`] on the owning thread, for a delivery whose task id
    /// this store has no park record for. The delivery is **not** woken — see
    /// [`delivery_target`] on why a foreign id is never resumed — and the run is failed
    /// later, on main, the same way a strand is.
    pub fn note_refused_delivery(&self, refused: RefusedDelivery) {
        logging::log(Level::Error, "thread", &format!("{refused}"));
        let mut list = self
            .refused_deliveries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        list.push(refused);
    }

    /// The refused deliveries recorded since the last call, oldest first.
    ///
    /// Taken, not read, for the same reason [`ExecutorPool::take_strands`] is: a second
    /// reader must not be able to turn one refusal into two.
    pub fn take_refused_deliveries(&self) -> Vec<RefusedDelivery> {
        let mut list = self
            .refused_deliveries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *list)
    }

    /// Stamp the moment a park was recorded, for `queue_wait_ns`.
    ///
    /// Called from the seam, only when `measuring()`. Stores the latest rather than a
    /// map: the probe's parks are strictly sequential (see the field's doc).
    fn note_park_time(&self) {
        let mut slot = self
            .last_park_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(std::time::Instant::now());
    }

    /// How long ago the last park was recorded, if one was.
    fn since_last_park(&self) -> Option<std::time::Duration> {
        let slot = self
            .last_park_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.map(|at| at.elapsed())
    }

    /// Record one delivery's timings. No-op unless `measuring()`.
    fn note_timing(&self, timing: WakeTiming) {
        let mut list = self
            .timings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        list.push(timing);
    }

    /// The timings recorded so far, taken rather than read.
    ///
    /// Public so a caller can summarise them; `service_wakes` logs the summary at the
    /// end of the session loop, which is where the process still has them.
    pub fn take_timings(&self) -> Vec<WakeTiming> {
        let mut list = self
            .timings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *list)
    }

    /// The strands recorded since the last call, oldest first.
    ///
    /// Taken, not read: the caller turns them into a refusal, and a second
    /// caller must not be able to turn the same strand into a second one.
    pub fn take_strands(&self) -> Vec<Strand> {
        let mut strands = self
            .strands
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *strands)
    }

    /// Record that a worker never started. Read by [`ExecutorPool::take_failures`].
    pub fn note_failure(&self, message: String) {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        failures.push(message);
    }

    /// Take the failures, emptying the list: the caller turns them into the run's
    /// outcome, and a second caller must not be able to refuse the same run twice.
    pub fn take_failures(&self) -> Vec<String> {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *failures)
    }

    /// A completion arrived for `(class, key)`: match it against the session's
    /// ledger, or buffer it for a park that has not happened yet (§4.3).
    ///
    /// Callable from **any** thread — that is the whole reason it exists as data
    /// rather than as a guest call. Matching is O(1) (a direct array lookup in the
    /// family's table, §3.3) and the matched id goes into the owner's inbox, where
    /// only the owner will act on it (§2.2, §3.4).
    ///
    /// Answers the owner it matched, or `None` when the completion was buffered.
    pub fn deliver(&self, class: u32, key: u32, payload: i32) -> Option<u32> {
        let matched = {
            let mut parks = self
                .parks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            parks.take(class, key)
        };
        let Some(entry) = matched else {
            // §4.3: no waiter yet. Buffer it; the park that comes later claims it.
            let mut early = self
                .early
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // One per `(class, key)` — the same coalescing main's buffer uses.
            if let Some(slot) = early
                .iter_mut()
                .find(|buffered| buffered.class == class && buffered.key == key)
            {
                slot.payload = payload;
            } else {
                early.push(EarlyCompletion {
                    class,
                    key,
                    payload,
                });
            }
            return None;
        };
        self.enqueue(Delivery {
            owner: entry.owner,
            task_id: entry.task_id,
            class,
            key,
            payload,
        });
        Some(entry.owner)
    }

    /// Arm DL28's probe: inject **one foreign delivery** the next time a park on
    /// `(class, key)` is recorded.
    ///
    /// Enqueued straight onto `owner`'s queue, bypassing `Pool::deliver` and therefore the
    /// ledger — which is what makes it foreign. See [`ForeignDelivery`] on why this is an
    /// instrument rather than a mechanism.
    pub fn arm_foreign_delivery(&self, foreign: ForeignDelivery) {
        let mut slot = self
            .foreign
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(foreign);
    }

    /// Inject the armed foreign delivery if this park matches it; disarm either way.
    ///
    /// Answers the injected task id, so the caller can log **that** id rather than the
    /// park's — they are different numbers and confusing them in a log line about a foreign
    /// delivery would be the one mistake the line exists to make impossible. `None` when it
    /// did not fire.
    ///
    /// Disarms on firing (a second injection would be a second refusal for one instrument).
    /// A park that does not match leaves the arm in place, so a run whose first park is the
    /// wrong pair waits for the right one rather than firing early.
    fn note_park_for_foreign_delivery(&self, class: u32, key: u32) -> Option<u64> {
        let foreign = {
            let mut slot = self
                .foreign
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match slot.as_ref() {
                Some(foreign) if foreign.class == class && foreign.key == key => slot.take(),
                _ => None,
            }
        };
        let Some(foreign) = foreign else {
            return None;
        };
        // **Straight onto the queue.** No `deliver`, so no ledger `take`, so nothing has
        // agreed that `task_id` is a task this store ever parked.
        self.enqueue(Delivery {
            owner: foreign.owner,
            task_id: foreign.task_id,
            class: foreign.class,
            key: foreign.key,
            payload: 0,
        });
        Some(foreign.task_id)
    }

    /// Arm the DL27 probe's "post for every park" watch: for each of the next `limit`
    /// parks whose class matches, post a completion for **that park's own key**.
    ///
    /// The producer here is the park seam itself, so the queue wait being measured is
    /// the tightest cadence that can exist — the host learns of the park the instant it
    /// is recorded. A real producer adds to that wait; it does not change what the
    /// engine then spends, which is what the other columns price.
    pub fn arm_post_each_park(&self, class: u32, limit: u32) {
        let mut watch = self
            .each_park
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *watch = Some(EachParkWatch {
            class,
            remaining: limit,
        });
    }

    /// Answer the class this park should be completed for, if the each-park watch is
    /// armed and still has parks to serve. Consumes one.
    ///
    /// `None` in an ordinary run (the watch is `None`), so the seam's behaviour is
    /// exactly what it was.
    fn note_each_park(&self, class: u32) -> Option<u32> {
        let mut watch = self
            .each_park
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let watch = watch.as_mut()?;
        if watch.class != class || watch.remaining == 0 {
            return None;
        }
        watch.remaining -= 1;
        Some(class)
    }

    /// Arm the test-only "post once N parks have landed" watch.
    ///
    /// Idempotent in the sense that matters: a second call replaces the first, and
    /// a pool that was never armed carries `None`.
    pub fn arm_park_watch(&self, class: u32, key: u32, target: u32) {
        let mut watch = self
            .watch
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *watch = Some(ParkWatch {
            class,
            key,
            target,
            seen: 0,
        });
    }

    /// Count a park at the seam; answer `true` when this one **just reached** the
    /// watch's target and the completion must be posted now.
    ///
    /// Deliberately not a "count the parks" reader: the ledger cannot answer that
    /// (one entry per key), and this is a measurement instrument rather than a
    /// record of anything the engine decides. It answers `true` exactly once even
    /// if more parks follow — "reposting never" is part of the flag's contract.
    fn note_park(&self, class: u32, key: u32) -> bool {
        let mut watch = self
            .watch
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(watch) = watch.as_mut() else {
            return false;
        };
        if watch.class != class || watch.key != key {
            return false;
        }
        watch.seen = watch.seen.saturating_add(1);
        watch.seen == watch.target
    }

    /// A park happened on `(class, key)` owned by `owner`: claim a buffered
    /// completion for it, if one is already waiting (§4.3's other order).
    ///
    /// Answers whether a completion was claimed — the caller logs it, because
    /// "the wake was already there" is the fact that makes a deterministic test
    /// deterministic rather than lucky.
    pub fn claim_early(&self, class: u32, key: u32, owner: u32, task_id: u64) -> bool {
        let claimed = {
            let mut early = self
                .early
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match early
                .iter()
                .position(|buffered| buffered.class == class && buffered.key == key)
            {
                Some(index) => Some(early.remove(index)),
                None => None,
            }
        };
        let Some(completion) = claimed else {
            return false;
        };
        // The park is resolved by this completion, so take it back out of the
        // ledger: leaving it would keep the strand predicate counting a task that
        // is about to run, exactly as main's `scheduler.rs` does.
        {
            let mut parks = self
                .parks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            parks.take(class, key);
        }
        self.enqueue(Delivery {
            owner,
            task_id,
            class: completion.class,
            key: completion.key,
            payload: completion.payload,
        });
        true
    }

    fn enqueue(&self, delivery: Delivery) {
        let mut inboxes = self
            .inboxes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inboxes.push(delivery);
        drop(inboxes);
        // §3.4's boundary: the owner is told there is work, and it acts on it.
        self.wake.notify_all();
    }

    /// Take every delivery addressed to `owner`, in arrival order (§4.5).
    /// Take **one** delivery for `owner` naming `(task, class, key)`, leaving the
    /// rest in place.
    ///
    /// `take_deliveries` drains the whole inbox, which is right for the session
    /// loop (it applies them all) and wrong for a fiber's producer, which is
    /// answering exactly one park and must not swallow deliveries meant for later
    /// ones (DL41).
    pub fn take_delivery(&self, owner: u32, task_id: u64, class: u32, key: u32) -> Option<Delivery> {
        let mut inboxes = self
            .inboxes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = inboxes.iter().position(|delivery| {
            delivery.owner == owner
                && delivery.task_id == task_id
                && delivery.class == class
                && delivery.key == key
        })?;
        Some(inboxes.remove(index))
    }

    pub fn take_deliveries(&self, owner: u32) -> Vec<Delivery> {
        let mut inboxes = self
            .inboxes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut mine = Vec::new();
        let mut rest = Vec::with_capacity(inboxes.len());
        for delivery in inboxes.drain(..) {
            if delivery.owner == owner {
                mine.push(delivery);
            } else {
                rest.push(delivery);
            }
        }
        *inboxes = rest;
        mine
    }

    /// How many deliveries are waiting for `owner`. For logs and tests.
    pub fn pending_for(&self, owner: u32) -> usize {
        self.inboxes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|delivery| delivery.owner == owner)
            .count()
    }

    /// Ask every worker to leave. Idempotent.
    pub fn stop_all(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.wake.notify_all();
    }

    /// Whether shutdown has been declared.
    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Block until there is something for `owner` to do, shutdown is declared, or
    /// `timeout` elapses.
    ///
    /// **A real primitive, not a spin** (§3.2, §4.4). The timeout exists so the
    /// loop re-checks its own state word even if a notify is missed — the same
    /// read-then-check discipline the served body uses with `atomicWait`, and it
    /// is a bound on a pathological wait, not a polling interval.
    pub fn wait_for_work(&self, owner: u32, timeout: std::time::Duration) {
        let inboxes = self
            .inboxes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.stopping() || inboxes.iter().any(|delivery| delivery.owner == owner) {
            return;
        }
        let _unused = self
            .wake
            .wait_timeout(inboxes, timeout)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }

    /// Every park the executor set has recorded, as `(family, key, task_id)`.
    ///
    /// **The evidence DL18 was built to produce.** A worker's parks go into the
    /// pool's ledger, and the pool is an `Arc` shared with main, so this answers
    /// after the worker's store has dropped — which is exactly what no reader
    /// could do before. Resumption is still DL19's: an entry here is a task
    /// parked and *not* resumed.
    pub fn parks(&self) -> Vec<(u32, u32, ParkedTask)> {
        self.parks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot()
    }

    /// The memory every instance shares, for the caller that has to define it
    /// under the import name the module used.
    pub fn memory(&self) -> &SharedMemory {
        &self.memory
    }

    /// `env.__startThread(execId)`: create the instance, then let the thread be
    /// the worker's whole body.
    ///
    /// Returns `0` once the thread is running. Every non-zero answer means the
    /// worker never started, which the guest treats as "unborn"
    /// (`__spawnThread` marks the executor exited and returns the code).
    pub fn start_thread(self: &Arc<Self>, id: i32) -> i32 {
        if id <= 0 || id >= self.count {
            return ERR_ID_OUT_OF_RANGE;
        }
        {
            let workers = self.lock_workers();
            if workers.contains_key(&id) {
                return ERR_ALREADY_BORN;
            }
        }

        let pool = Arc::clone(self);
        let handle = std::thread::Builder::new()
            .name(format!("executor-{id}"))
            .spawn(move || run_worker(pool, id));
        match handle {
            Ok(handle) => {
                self.lock_workers().insert(id, handle);
                0
            }
            Err(error) => {
                logging::log(
                    Level::Error,
                    "thread",
                    &format!("__startThread({id}): could not spawn the thread: {error}"),
                );
                ERR_SPAWN_FAILED
            }
        }
    }

    /// Join every worker thread that finishes within a short grace, and report
    /// the ones that do not.
    ///
    /// **The grace is for the gap between the guest's `__threadJoin` returning
    /// and this thread returning.** `__workerMain` writes the record's state word
    /// *before* it returns, and the Rust side then drops its `Store` — so a guest
    /// that joined correctly still has a live `JoinHandle` for a moment, and
    /// calling that "still running" was a warning on every well-behaved run
    /// (measured on `two-workers.ts`: both joins answered 0 and both workers were
    /// reported as detached).
    ///
    /// A worker that really was never joined is blocked in its idle
    /// `atomicWait`, so it does not finish in the grace; that one is named and
    /// detached rather than joined, because blocking here would turn "the guest
    /// forgot to join" into a hang with no explanation.
    pub fn join_finished(&self) {
        /// Long enough for a finishing worker's remaining host work, short
        /// enough that a forgotten join is reported rather than waited on.
        const GRACE: std::time::Duration = std::time::Duration::from_secs(2);

        let deadline = std::time::Instant::now() + GRACE;
        loop {
            let mut workers = self.lock_workers();
            let finished: Vec<i32> = workers
                .iter()
                .filter(|(_, handle)| handle.is_finished())
                .map(|(id, _)| *id)
                .collect();
            for id in finished {
                if let Some(handle) = workers.remove(&id) {
                    match handle.join() {
                        Ok(status) => logging::log(
                            Level::Debug,
                            "thread",
                            &format!("executor {id} joined (__workerMain answered {status})"),
                        ),
                        Err(_) => logging::log(
                            Level::Error,
                            "thread",
                            &format!("executor {id} panicked; the store is gone with it"),
                        ),
                    }
                }
            }
            if workers.is_empty() || std::time::Instant::now() >= deadline {
                for id in workers.keys() {
                    logging::log(
                        Level::Warn,
                        "thread",
                        &format!(
                            "executor {id} is still running after the guest returned: the guest \
                             did not call __threadJoin({id}), so the thread is detached (the \
                             process exit is its end)"
                        ),
                    );
                }
                return;
            }
            drop(workers);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// How many worker threads are live. For tests and for the log line.
    pub fn live_workers(&self) -> usize {
        self.lock_workers().len()
    }

    fn lock_workers(&self) -> std::sync::MutexGuard<'_, BTreeMap<i32, JoinHandle<i32>>> {
        self.workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register the two imports on a linker for any store the pool can answer
    /// for.
    ///
    /// `__executorCount` answers `1` for an instance with no pool: a module that
    /// did not import a shared memory has exactly one executor, and a guest that
    /// asks gets the truth rather than a refusal.
    ///
    /// Free-standing rather than an associated function taking `&Arc<Self>`,
    /// because the pool lives in the store's own data — the same place every
    /// other verb reaches its state (`Caller::data()`) — and a second handle
    /// passed to the linker would be a second owner for one thing.
    pub fn link<T: ThreadImports>(linker: &mut Linker<T>) -> anyhow::Result<()> {
        linker.func_wrap(
            "env",
            "__executorCount",
            |caller: Caller<'_, T>| -> i32 {
                caller
                    .data()
                    .executor_pool()
                    .map(|pool| pool.count)
                    .unwrap_or(1)
            },
        )?;
        linker.func_wrap(
            "env",
            "__startThread",
            |caller: Caller<'_, T>, id: i32| -> i32 {
                match caller.data().executor_pool() {
                    Some(pool) => {
                        let pool = Arc::clone(pool);
                        pool.start_thread(id)
                    }
                    // No pool means the module did not import a shared memory,
                    // so there is no second instance to make.
                    None => ERR_ID_OUT_OF_RANGE,
                }
            },
        )?;
        Ok(())
    }

    /// The imports a **worker** instance needs: the memory, `env.abort`, and the
    /// two thread imports.
    ///
    /// This is the narrowest set that lets the same module instantiate. It is
    /// narrower than main's on purpose: a capability's state is a process
    /// singleton (one window, one GPU device, one input layer — `host/mod.rs`
    /// lists them), so its verbs are only meaningful on the thread that owns
    /// it. A module that imports one therefore cannot be started as a worker
    /// yet; [`run_worker`] answers [`ERR_INSTANTIATE`] and logs the import that
    /// had no answer.
    fn link_worker(
        pool: &Arc<Self>,
        store: &mut Store<WorkerState>,
        linker: &mut Linker<WorkerState>,
    ) -> anyhow::Result<()> {
        define_memory(&pool.memory, store, linker)?;
        linker.func_wrap(
            "env",
            "abort",
            |mut caller: Caller<'_, WorkerState>, msg: i32, file: i32, line: i32, col: i32| -> wasmtime::Result<()> {
                let location = memory_string(&mut caller, file);
                let message = memory_string(&mut caller, msg);
                logging::log(
                    Level::Error,
                    "thread",
                    &format!(
                        "a worker aborted: {message} (in {location}, line {line}, col {col})"
                    ),
                );
                // A trap, not a return: the guest's `abort` expects control not
                // to come back, and a worker that returned from it would run on
                // with whatever the failing branch left in its locals.
                Err(wasmtime::Error::msg("a worker guest aborted"))
            },
        )?;
        ExecutorPool::link(linker)?;
        // **The park seam, for a worker's store.** A worker instantiates the same
        // module as main, so it imports the same names; every async program
        // imports `scheduler::park` whether or not it ever parks, because
        // `parkState` is reachable from `__taskPark` in any module that links
        // `~lib/task-rt`. Without a definition here the module fails at
        // instantiation — `unknown import: scheduler::park` — and no executor
        // could host a suspending task even in principle.
        //
        // What it does *not* do: **resume anything.** The park is recorded and
        // the call returns (contract §2.1: the call returns, the suspension is
        // the guest returning to its executor). There is no host loop on this
        // store and no channel to hand it ids, so the record is where a future
        // round's wake would start — not a wake that exists.
        // **`scheduler::completion(task_id)` on a worker store** (DL41, I96).
        //
        // A fiber guest imports it unconditionally: `__parkHost` calls `hostPark`
        // and then `hostCompletion` to learn what the wake carried, so a module
        // built for the fiber backend references both names even if the program
        // never parks. Without a definition here the worker never instantiated —
        // `unknown import: scheduler::completion` — and the run went on as if it
        // had.
        //
        // The honest answer, and why: **the payload of the delivery this store's
        // session loop last applied to that task, or `0` when it has applied
        // none.** That is not a guess — `Delivery::payload` is the producer's word
        // and the loop is the only thing that resumes a task in this store, so the
        // map it fills is the store's own record of what it was told. Nothing is
        // invented and no channel is added: the value already crossed.
        linker.func_wrap(
            "scheduler",
            "completion",
            |caller: Caller<'_, WorkerState>, task_id: i64| -> i32 {
                // **Two answers, and which one is asked is a fact of this
                // thread, not a choice.** Inside a fiber the park *suspended* and
                // the producer's word came back through `fiber::run`, so that is
                // the answer — the same thread-local main's `scheduler` uses.
                // Outside a fiber the park returned to the guest and was served
                // later by this store's session loop, so the word is the one that
                // loop applied (the map below).
                if crate::fiber::running() {
                    return crate::fiber::completion_value();
                }
                let words = caller
                    .data()
                    .delivered
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                words
                    .iter()
                    .find(|(id, _)| *id == task_id as u64)
                    .map(|(_, payload)| *payload)
                    .unwrap_or(0)
            },
        )?;
        linker.func_wrap(
            "scheduler",
            "park",
            |mut caller: Caller<'_, WorkerState>, task_id: i64, class: i32, key: i32| {
                let (park, pool) = {
                    let data = caller.data();
                    (
                        WorkerPark {
                            task_id: task_id as u64,
                            class: class as u32,
                            key: key as u32,
                            // **False here by construction, and it stops being
                            // false on this store's own thread**: the session loop
                            // sets it when it calls this store's `__taskWake` for
                            // this task id (`service_wakes`). Written at the seam
                            // and at the wake, read only by the strand refusal.
                            resolved: false,
                        },
                        Arc::clone(&data.pool),
                    )
                };
                {
                    let mut parks = caller
                        .data()
                        .parks
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    parks.push(park);
                }
                // **DL27's queue-wait stamp.** Taken after the record exists, which is
                // the moment a producer could first learn of this park. Off unless
                // `TENSION_MEASURE=1`, so an ordinary run pays one atomic load.
                if measuring() {
                    pool.note_park_time();
                }
                // **The same park, into the table main can reach (DL18).** Two
                // records, one truth: the store-local list above is what the
                // strand refusal counts (it must survive this store — it is read
                // in `worker_main` while the store is still alive), and this
                // ledger is what main can see after the store is gone. A park the
                // ledger declines (family not awaitable, key outside its space)
                // is still a strand, which is why the two are separate answers
                // rather than one.
                let owner = caller.data().id as u32;
                let recorded = {
                    let mut ledger = pool
                        .parks
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    ledger.record(
                        park.class,
                        park.key,
                        ParkedTask {
                            // **Not observable yet.** The contract fixes `park` at
                            // three integers and does not carry the continuation
                            // (§2.1: "The continuation is not a parameter"), and
                            // `TaskRecord` carries no slot, so the host has no way
                            // to learn the record's address without a std change —
                            // which this round forbids. `0` means "identity not
                            // provisioned"; `owner` + `task_id` are what the wake
                            // path needs, and they are both present.
                            handle: 0,
                            owner,
                            task_id: park.task_id,
                        },
                    )
                };
                if !recorded {
                    logging::log(
                        Level::Trace,
                        "thread",
                        &format!(
                            "park on class {} key {} is outside the awaitable space; \
                             recorded as a strand only",
                            park.class, park.key
                        ),
                    );
                } else if pool.is_fiber_backend()
                    && crate::fiber::suspend_current(crate::fiber::Park {
                        task: park.task_id,
                        class: park.class,
                        key: park.key,
                    })
                {
                    // **The park suspended and has now been resumed** (DL41, I97).
                    // Before this, the worker's park recorded the task and then
                    // returned to the guest — `suspend_current` was never called
                    // here — so a served body that parked ran straight through
                    // with a zero, and the record it left behind turned the run
                    // into a strand refusal.
                    //
                    // The record is resolved *here*, on the store's own thread,
                    // because `fiber::run`'s producer cannot reach the `Store`
                    // (its signature is `FnMut(Park) -> Option<i32>`). That is the
                    // same seam `service_wakes` writes at the wake; the two are
                    // disjoint by construction, since a fiber park returns here
                    // and never through the loop.
                    let mut parks = caller
                        .data()
                        .parks
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if let Some(last) = parks.last_mut() {
                        last.resolved = true;
                    }
                    drop(parks);
                    // **Header word 6, written where `service_wakes` writes it.** The
                    // session loop bumps it per delivery; this path consumes the
                    // delivery instead, so it bumps here. Doing it from the fiber's
                    // producer was wrong twice over: the producer cannot reach this
                    // `Store`, and a worker's `__controlBase` is 0 until
                    // `__workerMain` binds it — measured, the transcript said
                    // `wakes served=0` for a run that had resumed.
                    let base = caller
                        .get_export("__controlBase")
                        .and_then(|export| export.into_global())
                        .and_then(|global| global.get(&mut caller).i32())
                        .filter(|base| *base > 0);
                    if let Some(base) = base {
                        let served = caller
                            .data()
                            .served
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                            + 1;
                        let memory = caller.data().pool.memory().clone();
                        bump_served(&memory, base as usize, served);
                    }
                } else if pool.claim_early(park.class, park.key, owner, park.task_id) {
                    // §4.3's other order, and the one the deterministic test uses:
                    // the completion was already waiting, so this park never
                    // suspends for real — the owner is told immediately.
                    logging::log(
                        Level::Debug,
                        "thread",
                        &format!(
                            "executor {owner}: park on class {} key {} claimed a completion \
                             that had already arrived (sticky wake)",
                            park.class, park.key
                        ),
                    );
                }
                // **DL28's instrument**: if a foreign delivery is armed for this pair, hand
                // the owner's queue a delivery the ledger never matched. Placed *after*
                // `claim_early` and after the each-park post, so a run that arms both gets
                // the legitimate delivery first and the guest resumes before the refusal —
                // which is the ordering the test asserts on.
                if recorded {
                    if let Some(foreign_task) =
                        pool.note_park_for_foreign_delivery(park.class, park.key)
                    {
                        logging::log(
                            Level::Info,
                            "core",
                            &format!(
                                "--deliver-foreign: injected class {} key {} for task {foreign_task} \
                                 straight onto the executor's queue — the ledger never matched it",
                                park.class, park.key
                            ),
                        );
                    }
                }
                // **DL27's producer**: with `--post-completion-each-park` armed, post a
                // completion for *this* park's key. The seam is the producer, which is
                // the tightest cadence a producer can have — see the flag's doc.
                if recorded {
                    if let Some(class) = pool.note_each_park(park.class) {
                        let matched = pool.deliver(class, park.key, 0);
                        logging::log(
                            Level::Debug,
                            "core",
                            &format!(
                                "--post-completion-each-park: class {class} key {} -> {}",
                                park.key,
                                match matched {
                                    Some(owner) => format!("matched a park on executor {owner}"),
                                    None => "buffered (no park yet: sticky)".to_string(),
                                }
                            ),
                        );
                    }
                }
                // **The other ordering, as a test instrument (DL22).** Only when
                // `--post-completion-after-parks` armed a watch, and only on the
                // park that reaches its target. The post goes through `deliver`,
                // the same door every producer uses, so it can wake exactly what a
                // completion arriving at that instant would wake — no more, no
                // less. `seen` counts parks on the pair, which the ledger cannot
                // (one entry per key), and this is why the counter lives here.
                if recorded && pool.note_park(park.class, park.key) {
                    let matched = pool.deliver(park.class, park.key, 0);
                    logging::log(
                        Level::Info,
                        "core",
                        &format!(
                            "--post-completion-after-parks: class {} key {} -> {}",
                            park.class,
                            park.key,
                            match matched {
                                Some(owner) => format!("matched a park on executor {owner}"),
                                None => "buffered (no park yet: sticky)".to_string(),
                            }
                        ),
                    );
                }
            },
        )?;
        // `tension::io` too, and for a reason that is not convenience: the
        // module is **the same module** as main's, so it imports exactly what
        // main's build imports. A worker instance that cannot resolve `print`
        // does not instantiate at all, which would make every guest that logs
        // unusable as a worker. The rest of `main`'s namespace stays out — see
        // the doc comment above and `docs/threads.md` §4.
        link_worker_io(linker)?;
        Ok(())
    }
}

/// The whole body of one worker OS thread.
///
/// Everything a worker needs is built **here**, on this thread: the `Store`, the
/// `Linker`, the instance. Nothing that is not `Send` ever crosses a thread
/// boundary, which is what makes `HostState`'s `!Send` irrelevant to this path.
fn run_worker(pool: Arc<ExecutorPool>, id: i32) -> i32 {
    let status = match worker_main(&pool, id) {
        Ok(status) => status,
        Err(error) => {
            let message = format!("executor {id} could not run: {error}");
            logging::log(Level::Error, "thread", &message);
            // **Named, and released** (DL41). The message is kept for the run's own
            // refusal — logged alone it was a fact nobody acted on — and the state
            // word is written so a guest waiting in `__threadJoin` gets out.
            pool.note_failure(message);
            stop_executor(&pool.memory(), id);
            ERR_INSTANTIATE
        }
    };
    logging::log(
        Level::Debug,
        "thread",
        &format!("executor {id} finished (__workerMain answered {status})"),
    );
    status
}

/// Instantiate the module over the shared memory, configure the worker's arena,
/// and call `__workerMain(id)`.
/// Increment the session's served-wake counter (header word 6).
///
/// **A diagnostic word, not a protocol one.** Nothing in the host reads it; a guest
/// may, to order itself against a wake having landed. It is the honest way to make
/// the DL20 proof deterministic without either side polling a heap address, and
/// without inventing a synchronisation primitive the contract does not name.
///
/// `HEADER_WORDS` is 16 with `0..=4` in use (`H_MAGIC`, `H_TOTAL`, `H_STRIDE`,
/// `H_CAPACITY`, `H_REQUESTS`), `5` is `H_STOP`, so `6` is free. Written through
/// the `SharedMemory`'s `UnsafeCell` for the reason every shared write is: it is
/// shared by construction, so there is no `&mut` to take.
/// Write one `i32` word of the shared memory, or `false` when it would leave it.
fn write_word(memory: &wasmtime::SharedMemory, at: usize, value: i32) -> bool {
    if at.checked_add(4).map_or(true, |end| end > memory.data_size()) {
        return false;
    }
    let cells = memory.data();
    let base = cells.as_ptr() as *mut u8;
    for (offset, byte) in value.to_le_bytes().iter().enumerate() {
        // SAFETY: the bound was checked above. `SharedMemory` has no `&mut` to
        // take — it is shared with every instance by construction — so the write
        // goes through its `UnsafeCell`, as `bump_served` does for its own word.
        unsafe { *base.add(at + offset) = *byte };
    }
    true
}

/// The control block's address, found the way the guest finds it (DL41).
///
/// `std/assembly/thread.ts:controlBlockBase` computes it as `__heap_base` rounded
/// up to a page and confirms it with a magic word, because a worker's copy of the
/// global is zero. The host has the same problem and no `__heap_base` to read, so it
/// looks for the same magic at the same boundaries — at most one read per 64 KiB of
/// a memory that is 16 MiB at most. `None` means main never carved a block, which is
/// the ordinary case for a guest with no shared memory.
fn control_block_base(memory: &wasmtime::SharedMemory) -> Option<usize> {
    const CONTROL_MAGIC: i32 = 0x5448_5244;
    const PAGE: usize = 65536;
    let mut at = 0usize;
    while at < memory.data_size() {
        if read_word(memory, at) == Some(CONTROL_MAGIC) {
            return Some(at);
        }
        at += PAGE;
    }
    None
}

/// **Publish "this executor has stopped"** so that a guest waiting in
/// `__threadJoin` returns instead of waiting for a worker that will never answer
/// (DL41, I96).
///
/// Before this, a worker that could not instantiate logged the reason and ended; the
/// guest's join then blocked on a state word nobody would ever write, so the run hung
/// — not the exit 0 the brief recorded, because a program that waits for a wake waits
/// forever. Writing the word and notifying is what turns "the worker failed" into a
/// run that finishes and can be refused by name.
///
/// The layout is the guest's own (`docs/thread-abis`): `rec = base + 64 + id*stride`,
/// and the state word sits 12 bytes before the end of `sig` (`rec + stride - 24 + 12`).
fn stop_executor(memory: &wasmtime::SharedMemory, id: i32) {
    const HEADER_BYTES: usize = 64;
    const STATE_IN_SIGNAL: usize = 12;
    let Some(base) = control_block_base(memory) else {
        return;
    };
    let Some(stride) = read_word(memory, base + 8) else {
        return;
    };
    if stride <= 0 || id < 0 {
        return;
    }
    let stride = stride as usize;
    let record = base + HEADER_BYTES + (id as usize) * stride;
    let state = record + stride - 24 + STATE_IN_SIGNAL;
    if !write_word(memory, state, 2) {
        return;
    }
    // A waiter already blocked has to be woken, or the write is invisible to it.
    let _ = memory.atomic_notify(state as u64, u32::MAX);
}

/// One `i32` word of the shared memory, or `None` when the read would leave it.
///
/// The read side of [`bump_served`], and it exists for the same reason: the host
/// addresses the control block by arithmetic on a guest constant, so every read has
/// to be bounded before it happens (DL41).
fn read_word(memory: &wasmtime::SharedMemory, at: usize) -> Option<i32> {
    if at.checked_add(4)? > memory.data_size() {
        return None;
    }
    let cells = memory.data();
    let base = cells.as_ptr() as *const u8;
    let mut bytes = [0u8; 4];
    for (offset, slot) in bytes.iter_mut().enumerate() {
        // SAFETY: the bound was checked above, and a shared memory has no `&mut`
        // to take; every reader of the control block reads it the same way.
        *slot = unsafe { *base.add(at + offset) };
    }
    Some(i32::from_le_bytes(bytes))
}

fn bump_served(memory: &wasmtime::SharedMemory, control_base: usize, served: u64) {
    /// Header word 6.
    const WORD: usize = 6;
    let at = control_base + WORD * 4;
    if at + 4 > memory.data_size() {
        return;
    }
    let cells = memory.data();
    let base = cells.as_ptr() as *mut u8;
    // SAFETY: the bound was checked above; this is the owner thread writing a
    // word it alone writes.
    unsafe {
        let mut word = [0u8; 4];
        for (offset, slot) in word.iter_mut().enumerate() {
            *slot = *base.add(at + offset);
        }
        let value = i32::from_le_bytes(word).saturating_add(1);
        let _ = served;
        for (offset, byte) in value.to_le_bytes().iter().enumerate() {
            *base.add(at + offset) = *byte;
        }
    }
}

/// The worker's session loop: wait for a matched task, then call the guest's
/// `__taskWake` on this store.
///
/// **Why the wait is a `Condvar` and not the guest's `atomicWait`.** §3.2 forbids
/// a spin and §4.4 forbids "ask the state, then ask again", so the wait must be a
/// real primitive; a Rust `Condvar` is one, and it keeps the whole mechanism in
/// the host so no guest rebuild is needed (the round's gate: `asc.js` and the
/// bundle are unchanged). §3.4's "the owner thread calls `wake` at a defined
/// boundary" is exactly this function: the executor matched the id, and the owner
/// is the one that invokes.
///
/// **The scratch is the executor's own spawn record.** `__taskWake` reads packed
/// `u64` ids from guest memory, so one id has to be written somewhere the guest
/// will not read it back. The spawn record's `entry`/`arg` words (`sig + 16`,
/// `+ 20`) are dead by now: `__workerMain` read them once, before calling the
/// entry, and `__spawnThread` refuses an id that is already born. Eight bytes
/// there hold exactly one id, and `sig = record + stride - 24`, so the whole
/// address is arithmetic on two exported globals — no guest call, no allocation,
/// and no sharing with main's own scratch.
fn service_wakes(
    store: &mut Store<WorkerState>,
    instance: &wasmtime::Instance,
    id: i32,
    wake: &wasmtime::TypedFunc<(i32, i32), ()>,
    pool: &Arc<ExecutorPool>,
) -> anyhow::Result<()> {
    /// How long a wait lasts before the loop re-checks shutdown. A bound on a
    /// missed notify, not a polling interval: a notify returns immediately.
    const SLICE: std::time::Duration = std::time::Duration::from_millis(50);

    let control_base = instance
        .get_global(&mut *store, "__controlBase")
        .and_then(|global| global.get(&mut *store).i32())
        .ok_or_else(|| anyhow::anyhow!("the worker exports no readable `__controlBase`"))?;
    let stride = instance
        .get_global(&mut *store, "__controlStride")
        .and_then(|global| global.get(&mut *store).i32())
        .ok_or_else(|| anyhow::anyhow!("the worker exports no readable `__controlStride`"))?;
    if control_base <= 0 || stride <= 0 {
        anyhow::bail!("executor {id}: the control block is not carved (base {control_base}, stride {stride})");
    }
    // **The pool's memory, not an exported one.** A `--sharedMemory` guest built
    // with `--importMemory` (every guest in this repo) *imports* its memory, so
    // there is no `memory` export to look up; the host defined it at link time and
    // the pool holds the handle.
    let memory = pool.memory().clone();
    // `rec = base + HEADER_BYTES(64) + id * stride`, `sig = rec + stride - 24`,
    // and the entry word is `sig + 16` — so this is `rec + stride - 8`.
    let scratch = (control_base as usize) + 64 + (id as usize + 1) * (stride as usize) - 8;
    let memory_size = memory.data_size();
    let scratch_ok = scratch + 8 <= memory_size;

    let mut served: u64 = 0;
    loop {
        if pool.stopping() {
            break;
        }
        let mine = pool.take_deliveries(id as u32);
        if mine.is_empty() {
            pool.wait_for_work(id as u32, SLICE);
            continue;
        }
        for delivery in mine {
            // **DL27's per-delivery clock.** `taken_at` is the moment this delivery was
            // in hand; the queue wait is how long the park had been waiting when it was
            // — which is the producer's cadence, not the engine's cost.
            let metered = measuring();
            let taken_at = std::time::Instant::now();
            let queue_wait_ns = if metered {
                pool.since_last_park().map_or(0, |wait| wait.as_nanos() as u64)
            } else {
                0
            };
            if !scratch_ok {
                anyhow::bail!(
                    "executor {id}: the wake scratch ({scratch}) is outside the module's memory \
                     ({} bytes)",
                    memory_size
                );
            }
            // ── delivery validation (I55, DL26) ───────────────────────────────
            //
            // **Before the wake, not after it.** The wake call below is unconditional
            // and `__taskWake` resumes whatever `slots[id]` names in this store, so a
            // delivery carrying a foreign or recycled id would resume an unrelated
            // task — and, with the find-first mark that used to live here, could also
            // mark the wrong park. The store's own records are the only thing that can
            // say whether this id is its own, so they are consulted first.
            //
            // `None` means "this store never parked that id". It is a bug every time,
            // so it is refused by name and fails the run; see `delivery_target`.
            let target = {
                let parks = store
                    .data()
                    .parks
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                delivery_target(&parks, delivery.task_id)
            };
            let Some(target) = target else {
                pool.note_refused_delivery(RefusedDelivery {
                    executor: id,
                    task_id: delivery.task_id,
                    class: delivery.class,
                    key: delivery.key,
                });
                // **Not woken, and not marked.** The task this id names in *this*
                // store is a different task; resuming it would be worse than the
                // refusal. The loop keeps serving: a later delivery may still be
                // legitimate.
                continue;
            };

            // Validation ends here — the target index is known and the delivery is
            // known to be this store's. The scratch write below is its own segment,
            // because folding it into validation is exactly the "blended figure" the
            // brief forbids.
            let validated_at = std::time::Instant::now();
            {
                // **Unsafe on purpose, and narrow.** A `SharedMemory` has no
                // `&mut` to take — it is shared with every other store by
                // construction — so the write goes through its `UnsafeCell`.
                // This is the owning store's own scratch word (the dead
                // `entry`/`arg` of its record), written on its own thread, so no
                // other thread can be reading it; the unsafety is the API's, not
                // a shortcut around a rule.
                let cells = memory.data();
                let base = cells.as_ptr() as *mut u8;
                // **The wake cell is two words: the id, then the producer's value**
                // (DL42, I98). It used to be one `u64` holding the id, of which the
                // guest read the low `i32` and dropped the high one — the ids are
                // store-local slot indices, so the half `__taskWake` threw away was
                // always zero. That half now carries the payload, which is what makes
                // this backend settle a resumed record with the producer's word
                // exactly as the fiber backend does through `scheduler::completion`.
                //
                // Eight bytes still, so the record does not grow and no artifact
                // moves for a reason other than the one this round declares.
                let cell = [
                    delivery.task_id as u32,
                    delivery.payload as u32,
                ];
                for (word, value) in cell.iter().enumerate() {
                    for (offset, byte) in value.to_le_bytes().iter().enumerate() {
                        // SAFETY: `scratch + 8 <= memory_size` was checked above, and
                        // this thread is the only writer of this address.
                        unsafe { *base.add(scratch + word * 4 + offset) = *byte };
                    }
                }
            }

            // §2.2: this store's own `__taskWake`, on this store's own thread.
            // **The word this delivery carries, kept for `scheduler::completion`**
            // (DL41). Recorded *before* the wake: the resumed task asks for it on
            // the very next line it runs, and a guest that asked first and was
            // written to afterwards would read the previous task's word.
            {
                let mut words = store
                    .data()
                    .delivered
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match words.iter_mut().find(|(id, _)| *id == delivery.task_id) {
                    Some(slot) => slot.1 = delivery.payload,
                    None => words.push((delivery.task_id, delivery.payload)),
                }
            }
            let before_call = std::time::Instant::now();
            wake.call(&mut *store, (scratch as i32, 1))?;
            let after_call = std::time::Instant::now();
            // **P1 (DL22): the owner answers for its own park, at the moment it
            // resumes it.** This is the store's own record, written on the store's
            // own thread, so there is no lock ordering to get wrong and no
            // cross-thread write: the `Mutex` is the one `WorkerState` already
            // carries, and this thread is the only one that ever holds that store.
            //
            // Before this, `resolved` was written once at the seam and never read,
            // and liveness came from the *shared* ledger — which holds one entry
            // per key, so it could not answer for a task the ledger had displaced
            // (DL21's `2 → 1`). The count is now "parks this store left
            // unresolved", which is true for any N.
            //
            // **The record the lookup chose**, not the first one with this id. A
            // re-parking task leaves one record per park and the earlier ones are
            // already resolved, so marking by `find` would leave the live park
            // unresolved and produce a false STRANDED — see `delivery_target`.
            //
            // A refused delivery never reaches this line: it `continue`s above.
            {
                let mut parks = store
                    .data()
                    .parks
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(park) = parks.get_mut(target) {
                    park.resolved = true;
                }
            }
            if metered {
                let marked_at = std::time::Instant::now();
                pool.note_timing(WakeTiming {
                    queue_wait_ns,
                    validate_ns: (validated_at - taken_at).as_nanos() as u64,
                    scratch_ns: (before_call - validated_at).as_nanos() as u64,
                    call_ns: (after_call - before_call).as_nanos() as u64,
                    mark_ns: (marked_at - after_call).as_nanos() as u64,
                });
            }
            served += 1;
            // **A shared counter for the guest to observe.** Header word 6 (5 is
            // `H_STOP`; `HEADER_WORDS` is 16 and 0-4 are in use) counts wakes this
            // session has served. It exists so a guest can order itself against a
            // wake having landed without either side polling a *heap* word — which
            // cannot work, because a `--sharedMemory` guest's heap is its own arena
            // (measured: main spinning on a worker-owned `StaticArray` waited
            // forever). The control block is the one region every store addresses
            // identically.
            bump_served(&memory, control_base as usize, served);
            logging::log(
                Level::Debug,
                "thread",
                &format!(
                    "executor {id}: woke task {} for class {} ({} this session)",
                    delivery.task_id, delivery.class, served
                ),
            );
        }
    }
    logging::log(
        Level::Info,
        "thread",
        &format!("executor {id} left its session loop after {served} wake(s)"),
    );

    // **DL27's summary.** Printed here because this is the last place the process still
    // holds the samples, and because a metered run is the only kind that has any. One
    // line per segment plus the host total, each with p50/p95/min/max, so no reader has
    // to take a blended figure on trust.
    if measuring() {
        let timings = pool.take_timings();
        if timings.is_empty() {
            logging::log(
                Level::Info,
                "measure",
                &format!("executor {id}: no deliveries were timed"),
            );
        } else {
            log_timing_summary(id, &timings);
        }
    }
    Ok(())
}

/// p50/p95/min/max of one column, in nanoseconds, as one log line's worth of text.
fn percentiles(values: &mut Vec<u64>) -> (u64, u64, u64, u64) {
    values.sort_unstable();
    let n = values.len();
    let min = values[0];
    let max = values[n - 1];
    // Nearest-rank: the smallest value at or above the requested fraction. Stated
    // because a percentile is only meaningful with its definition attached.
    let at = |fraction: f64| {
        let rank = ((n as f64) * fraction).ceil() as usize;
        values[rank.clamp(1, n) - 1]
    };
    (at(0.50), at(0.95), min, max)
}

/// DL27's summary table, one line per column.
///
/// **The columns are named for what they contain**, which is the round's whole
/// discipline: `call` is the guest running, not the host, and `queue_wait` is the
/// producer, not the engine.
fn log_timing_summary(id: i32, timings: &[WakeTiming]) {
    let n = timings.len();
    let mut columns: Vec<(&str, Vec<u64>)> = vec![
        ("queue_wait", timings.iter().map(|t| t.queue_wait_ns).collect()),
        ("validate", timings.iter().map(|t| t.validate_ns).collect()),
        ("scratch", timings.iter().map(|t| t.scratch_ns).collect()),
        ("call(guest runs inside)", timings.iter().map(|t| t.call_ns).collect()),
        ("mark", timings.iter().map(|t| t.mark_ns).collect()),
        (
            "host_dispatch(v+s+m)",
            timings
                .iter()
                .map(|t| t.validate_ns + t.scratch_ns + t.mark_ns)
                .collect(),
        ),
        ("host_total(no call)", timings.iter().map(|t| t.host_ns()).collect()),
        (
            "round_trip(all five)",
            timings
                .iter()
                .map(|t| t.queue_wait_ns + t.validate_ns + t.scratch_ns + t.call_ns + t.mark_ns)
                .collect(),
        ),
    ];
    // `round_trip` is the whole park-to-park cycle for one pair, per sample, and it is
    // what a throughput figure must be derived from. Wall clock is **not**: a metered run
    // of 1000 pairs takes ~52 ms, of which ~4 ms is these segments and the rest is
    // process startup plus the session loop's 50 ms shutdown slice
    // (`wait_for_work(SLICE)` noticing the stop). Dividing the wall clock by the pair
    // count would report the loop's slice as a per-await cost.
    //
    // **Two totals, because one of them is not host work.** `host_total` includes
    // `queue_wait`, which is the producer's cadence; `host_dispatch` is the engine's own
    // per-wake work (validate, scratch, mark) and nothing else. Summing percentiles
    // would be wrong — they do not add — so both are computed per sample.
    for (name, mut values) in columns.drain(..) {
        let (p50, p95, min, max) = percentiles(&mut values);
        logging::log(
            Level::Info,
            "measure",
            &format!(
                "executor {id}: {name:<24} n={n} p50={p50}ns p95={p95}ns min={min}ns max={max}ns"
            ),
        );
    }
}

fn worker_main(pool: &Arc<ExecutorPool>, id: i32) -> anyhow::Result<i32> {
    let mut store = Store::new(
        &pool.engine,
        WorkerState {
            pool: Arc::clone(pool),
            parks: Mutex::new(Vec::new()),
            delivered: Mutex::new(Vec::new()),
            served: std::sync::atomic::AtomicU64::new(0),
            id,
        },
    );
    store.set_epoch_deadline(NEVER_TRAPS);

    let mut linker: Linker<WorkerState> = Linker::new(&pool.engine);
    ExecutorPool::link_worker(pool, &mut store, &mut linker)?;

    let instance = linker.instantiate(&mut store, &pool.module).map_err(|error| {
        anyhow::anyhow!(
            "the module did not instantiate as a worker — the worker's import set is \
             env::memory, env::abort, env::__executorCount, env::__startThread, \
             scheduler::park and tension::io, and a capability import has no answer on a \
             worker thread: {error}"
        )
    })?;

    // **No boot words, no `__start`.** The guest carved the control block on
    // main; a worker's globals are zero and its only state is what
    // `__workerMain` binds from the block.
    let arena_base = instance
        .get_typed_func::<i32, i32>(&mut store, "__workerArenaBase")
        .map_err(|_| anyhow::anyhow!("the module exports no `__workerArenaBase`"))?;
    let arena_size = instance
        .get_typed_func::<i32, i32>(&mut store, "__workerArenaSize")
        .map_err(|_| anyhow::anyhow!("the module exports no `__workerArenaSize`"))?;
    let base = arena_base.call(&mut store, id)?;
    let size = arena_size.call(&mut store, id)?;
    if base == 0 || size == 0 {
        // The guest answers 0 before `__threadInit` has carved, or for an id it
        // does not know. `__workerMain` refuses this itself (`-3`); refusing one
        // step earlier names the cause.
        anyhow::bail!("the record for executor {id} publishes no arena (base {base}, size {size})");
    }

    // `__arenaInit` moves `__stack_pointer`, so it must run with no live guest
    // frame — the reason the guest does not call it from `__threadInit`, and the
    // reason this is the host's job (`docs/thread-abi.md` §2.2).
    let arena_init = instance
        .get_typed_func::<(i32, i32), ()>(&mut store, "__arenaInit")
        .map_err(|_| anyhow::anyhow!("the module exports no `__arenaInit`"))?;
    arena_init.call(&mut store, (base, size))?;

    let worker_main = instance
        .get_typed_func::<i32, i32>(&mut store, "__workerMain")
        .map_err(|_| anyhow::anyhow!("the module exports no `__workerMain`"))?;
    // ── the served entry, on a fiber, when the artifact asks for one (DL41) ──
    //
    // **This is I97's other half.** `scheduler::park` now suspends when a fiber is
    // running, so the served entry has to *be* on one — otherwise the park records
    // itself, returns to the guest, and leaves the record stranded. The entry is
    // the same call either way; only what happens at a park differs.
    //
    // The producer is the pool, not the session loop, and that is not a second
    // mechanism: `claim_early` is the same door the loop's `service_wakes` uses to
    // learn that a completion had already arrived, and it answers the word the
    // producer carried. It runs here, on this thread, between the park and the
    // resume — which is exactly the ordering `Delivery` was built for.
    let status = if pool.is_fiber_backend() {
        match crate::fiber::run(
            &mut store,
            instance,
            |store, instance| {
                let entry = instance
                    .get_typed_func::<i32, i32>(&mut *store, "__workerMain")
                    .expect("__workerMain was resolved above");
                Ok(entry.call(store, id)?)
            },
            |park| {
                // **Two places a completion can be, and both are the pool's.** The
                // inbox holds one that matched this park in the ledger (a producer
                // that arrived after the park); `claim_early` holds one that
                // arrived before it (the sticky half, §4.3). The old loop path
                // handled both — inbox in `take_deliveries`, sticky in
                // `claim_early` — so the producer checks them in the same order.
                let take = |pool: &Arc<ExecutorPool>, task: u64, class: u32, key: u32| {
                    pool.take_delivery(id as u32, task, class, key)
                };
                let delivery = take(&pool, park.task, park.class, park.key).or_else(|| {
                    pool.claim_early(park.class, park.key, id as u32, park.task);
                    take(&pool, park.task, park.class, park.key)
                });
                let delivery = delivery?;
                Some(delivery.payload)
            },
        )? {
            crate::fiber::Outcome::Done(status) => status,
            // **Refused, not hung** — the same sentence the plain-guest path uses.
            // A served task nobody completes is a reported fact, and the stranded
            // fiber is leaked because a suspended fiber cannot be dropped.
            crate::fiber::Outcome::Stranded(stranded) => {
                anyhow::bail!("fiber executor: {stranded}")
            }
        }
    } else {
        worker_main.call(&mut store, id).map_err(|error| {
            anyhow::anyhow!("the worker's `__workerMain({id})` failed: {error}")
        })?
    };
    let mut loop_error: Option<anyhow::Error> = None;

    // ── the session loop (DL20) ───────────────────────────────────────────
    //
    // **The round's subject.** Until now `worker_main` returned here, so a park
    // that arrived after the entry returned had nowhere to be resumed and the
    // run either stranded (DL12B's refusal) or, worse, exited 0 with the task
    // still parked. The worker now stays for the session: it blocks on a real
    // primitive, and when a completion is matched for it, it calls the guest's
    // own `__taskWake` on **this** store — which is the only thread allowed to
    // (§2.2), and the reason the wait is here and not in a guest loop.
    //
    // **What this loop does not do.** It does not decide *which* tasks resume
    // (the ledger and `deliver` do), it does not carry a continuation (it names
    // store-local ids, §2.1), it does not touch the ready/inbox rings the served
    // body uses (`I31`: those move continuations), and it does not run the
    // guest's own step. It waits, takes, and calls `__taskWake`.
    let wake = instance.get_typed_func::<(i32, i32), ()>(&mut store, "__taskWake").ok();
    match wake {
        None => {
            // A guest that does not export `__taskWake` cannot be woken by name,
            // and inventing a mechanism for it is out of scope. Said out loud:
            // this is the DL19 limitation narrowing, not the limitation gone.
            logging::log(
                Level::Info,
                "thread",
                &format!(
                    "executor {id} exports no `__taskWake`, so it serves no wake path; \
                     a park after its entry returns still strands"
                ),
            );
        }
        Some(wake) => {
            // **A failed loop is reported, but it does not skip the strand
            // record.** Measured while building this: an error here returned
            // early, so a worker that had parked was never counted and the run
            // exited 0 with the task stranded — exactly the silent success DL12B
            // exists to prevent. The error is carried to the end and raised
            // *after* the bookkeeping.
            if let Err(error) = service_wakes(&mut store, &instance, id, &wake, pool) {
                loop_error = Some(error);
            }
        }
    }

    // **What the park seam actually did on this executor**, counted at the end of
    // its life rather than the end of its entry: with a session loop the two are
    // different moments, and the strand predicate is about the life.
    let parks = {
        let parks = store
            .data()
            .parks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        parks.clone()
    };
    logging::log(
        Level::Info,
        "thread",
        &format!(
            "executor {id} left the park seam having recorded {} park(s){}",
            parks.len(),
            match parks.first() {
                Some(first) => format!(
                    " (first: task {} on class {} key {})",
                    first.task_id, first.class, first.key
                ),
                None => String::new(),
            }
        ),
    );

    // **A park that was never resolved is a strand, and main will refuse it.**
    // Recorded on the pool, because this store is about to drop and the refusal
    // has to be decided on main (`main.rs`, after `join_finished`). The predicate
    // is `!resolved` — *unresolved at exit*, not "recorded at all" — and
    // `resolved` is set by this store's own session loop, so a task the owner
    // resumed is not a strand and a task it lost is one, for any number of
    // waiters (DL22).
    pool.record_strand(id, &parks);
    // **The same parks, seen from the pool (DL18).** Read back through the shared
    // ledger rather than from the local list: this is the path main uses, so the
    // log line is evidence that the table is reachable from the other side and
    // not merely written to. Empty here means the ledger declined every park
    // (a family that is not awaitable), which is a different fact from "the
    // guest never parked".
    let visible = pool.parks();
    logging::log(
        Level::Debug,
        "thread",
        &format!(
            "executor {id}: the pool's park table holds {} entr{}",
            visible.len(),
            if visible.len() == 1 { "y" } else { "ies" }
        ),
    );
    match loop_error {
        Some(error) => Err(error),
        None => Ok(status),
    }
}


/// The `tension::io` verbs, for a worker instance.
///
/// **Why a worker gets io at all.** A worker instantiates the *same module* as
/// main, so it imports the same names; a name with no definition is a failed
/// instantiation, not a verb the worker declines to call. `tension::io` is the
/// one namespace whose verbs are a pure function of the store (argv, stdin, a
/// line buffer) — no adapter, no device, no singleton — so it is the one that
/// can be answered on a worker thread honestly.
///
/// The answers differ from main's in the three places where a worker genuinely
/// has nothing:
///
/// * `print` goes to the terminal. A worker is never a sandboxed guest, so there
///   is no captured sink; two threads writing to stdout interleave, which is
///   what threads do.
/// * `arg`/`arg_count` answer `-1`/`0`: a worker has no argv.
/// * `read_line` answers `-1` (EOF): stdin belongs to the process's main thread.
fn link_worker_io(linker: &mut Linker<WorkerState>) -> anyhow::Result<()> {
    use std::io::Write;

    linker.func_wrap(
        "tension::io",
        "print",
        |mut caller: Caller<'_, WorkerState>, ptr: i32, len: i32| {
            let Some(memory) = GuestMemory::of(&mut caller) else {
                return;
            };
            let start = ptr as usize;
            let bytes = memory.copy(&caller, start, start.saturating_add(len.max(0) as usize));
            let text = String::from_utf8_lossy(&bytes);
            let mut out = std::io::stdout();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
        },
    )?;
    linker.func_wrap(
        "tension::io",
        "log",
        |mut caller: Caller<'_, WorkerState>, level: i32, name: i32, name_len: i32, msg: i32, msg_len: i32| {
            let Some(memory) = GuestMemory::of(&mut caller) else {
                return;
            };
            let name = memory.copy(&caller, name as usize, (name as usize).saturating_add(name_len.max(0) as usize));
            let msg = memory.copy(&caller, msg as usize, (msg as usize).saturating_add(msg_len.max(0) as usize));
            let level = match level {
                0 => Level::Trace,
                1 => Level::Debug,
                2 => Level::Info,
                3 => Level::Warn,
                4 => Level::Error,
                _ => Level::Fatal,
            };
            logging::log(
                level,
                &format!("worker:{}", String::from_utf8_lossy(&name)),
                &String::from_utf8_lossy(&msg),
            );
        },
    )?;
    linker.func_wrap("tension::io", "arg_count", |_caller: Caller<'_, WorkerState>| -> i32 { 0 })?;
    linker.func_wrap("tension::io", "arg", |_caller: Caller<'_, WorkerState>, _i: i32, _p: i32, _cap: i32| -> i32 {
        -1
    })?;
    linker.func_wrap("tension::io", "read_line", |_caller: Caller<'_, WorkerState>, _p: i32, _cap: i32| -> i32 {
        -1
    })?;
    Ok(())
}

/// A guest's linear memory — **either kind**.
///
/// `Extern::into_memory()` answers `None` for a `SharedMemory`, because the two
/// are different extern variants. That difference is invisible until a guest is
/// compiled with `--sharedMemory`: then every verb that reads guest bytes through
/// `into_memory()` finds nothing, and `print` — the one verb whose job is to say
/// what is happening — is where it surfaces first (measured: the export is
/// present, `is_some()` is true, and the `expect` fired anyway).
///
/// The verbs a thread guest actually calls read through this instead. The rest
/// still take the linear path; `docs/threads.md` records that as the open edge.
pub enum GuestMemory {
    Linear(wasmtime::Memory),
    Shared(SharedMemory),
}

impl GuestMemory {
    /// The caller's own `memory` export, whichever kind it is.
    pub fn of<T>(caller: &mut Caller<'_, T>) -> Option<Self> {
        match caller.get_export("memory")? {
            wasmtime::Extern::Memory(memory) => Some(GuestMemory::Linear(memory)),
            wasmtime::Extern::SharedMemory(memory) => Some(GuestMemory::Shared(memory)),
            _ => None,
        }
    }

    /// The number of bytes currently addressable.
    pub fn len<T>(&self, caller: &Caller<'_, T>) -> usize {
        match self {
            GuestMemory::Linear(memory) => memory.data(caller).len(),
            GuestMemory::Shared(memory) => memory.data().len(),
        }
    }

    /// Bytes `start..end`, clamped to the memory, copied out.
    ///
    /// A copy rather than a borrowed slice because a shared memory's bytes are
    /// `UnsafeCell<u8>`: another thread may be writing them, so a `&[u8]` view
    /// would be a promise the memory does not make. One read per byte is the
    /// honest cost of a verb that only ever reads a small record.
    pub fn copy<T>(&self, caller: &Caller<'_, T>, start: usize, end: usize) -> Vec<u8> {
        let len = self.len(caller);
        let start = start.min(len);
        let end = end.min(len);
        match self {
            GuestMemory::Linear(memory) => memory.data(caller)[start..end].to_vec(),
            GuestMemory::Shared(memory) => {
                let cells = &memory.data()[start..end];
                // Safety: each `get()` is one read of a `u8` cell; the values are
                // copied out immediately, and no reference to the cell escapes.
                cells
                    .iter()
                    .map(|cell| unsafe { *cell.get() })
                    .collect()
            }
        }
    }
}

/// Define one shared memory under both import names a guest may use.
///
/// Both, because the compiler emits `env::memory` and Tension documents
/// `session::memory`; the session registers both for the same reason. An unused
/// definition is harmless.
pub fn define_memory<T>(
    memory: &SharedMemory,
    store: &mut Store<T>,
    linker: &mut Linker<T>,
) -> anyhow::Result<()> {
    linker.define(&*store, "env", "memory", memory.clone())?;
    linker.define(&*store, "session", "memory", memory.clone())?;
    Ok(())
}

/// A TensionScript string (`rtSize` at `ptr - 4`, UTF-16LE at `ptr`), for the
/// worker's `abort` message. The binary has the same reader for `HostState`;
/// it is generic over the store data, which is the only difference.
fn memory_string<T>(caller: &mut Caller<'_, T>, ptr: i32) -> String {
    if ptr == 0 {
        return String::new();
    }
    let Some(memory) = GuestMemory::of(caller) else {
        return String::new();
    };
    let p = ptr as u32 as usize;
    let Some(head) = p.checked_sub(4) else {
        return String::new();
    };
    let header = memory.copy(caller, head, head + 4);
    if header.len() < 4 {
        return String::new();
    }
    let units = u32::from_le_bytes(header.try_into().unwrap_or([0; 4])) as usize / 2;
    let bytes = memory.copy(caller, p, p + units * 2);
    let mut text = String::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        text.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
    }
    text
}

/// Whether a module imports a **shared** linear memory, and its declared type.
///
/// This is the switch that decides whether a guest gets a thread pool at all: a
/// `--sharedMemory` build imports one, and the host must create the
/// `SharedMemory` itself (a module-defined shared memory is a fresh one per
/// instantiation, which is the opposite of sharing).
pub fn shared_memory_import(module: &Module) -> Option<wasmtime::MemoryType> {
    module.imports().find_map(|import| match import.ty() {
        ExternType::Memory(ty) if ty.is_shared() => Some(ty),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::Config;

    /// The engine the host builds, in the two lines that matter here.
    fn engine() -> Engine {
        let mut config = Config::new();
        config.wasm_threads(true);
        config.shared_memory(true);
        config.epoch_interruption(true);
        // Stack switching is negotiated by the same helper `main` uses; the
        // returned backend is ignored here because these fixtures use no
        // continuation types — shared memory is what is under test.
        let (engine, _) =
            crate::async_backend::build(&config).expect("an engine with shared memory");
        engine
    }

    /// A worker that writes one word and exits: enough to prove the spawn is a
    /// real thread over the same memory.
    const WORKER: &str = r#"
(module
  (import "env" "memory" (memory 1 64 shared))
  (import "env" "__executorCount" (func $count (result i32)))
  (import "env" "__startThread" (func $start (param i32) (result i32)))
  (func (export "__arenaInit") (param i32 i32))
  (func (export "__workerArenaBase") (param i32) (result i32)
    (i32.const 16))
  (func (export "__workerArenaSize") (param i32) (result i32)
    (i32.const 4096))
  (func (export "__workerMain") (param $id i32) (result i32)
    (i32.atomic.store (i32.const 0) (local.get $id))
    (i32.const 0))
  (func (export "spawn") (param i32) (result i32)
    (call $start (local.get 0)))
  (func (export "count") (result i32)
    (call $count)))
"#;

    /// One 32-bit word of a shared memory, read atomically.
    ///
    /// `SharedMemory::data` hands out `&[UnsafeCell<u8>]`, so a plain cast is
    /// not available; `AtomicI32` is the load the worker's `i32.atomic.store`
    /// pairs with.
    fn read_word(memory: &SharedMemory, offset: usize) -> i32 {
        use std::sync::atomic::{AtomicI32, Ordering};
        let cell = &memory.data()[offset] as *const std::cell::UnsafeCell<u8>;
        unsafe { (*(cell as *const AtomicI32)).load(Ordering::SeqCst) }
    }

    struct Plain(Arc<ExecutorPool>);

    impl ThreadImports for Plain {
        fn executor_pool(&self) -> Option<&Arc<ExecutorPool>> {
            Some(&self.0)
        }
    }

    #[test]
    fn a_pool_spawns_a_real_thread_over_the_shared_memory() {
        let engine = engine();
        let module = Module::new(&engine, WORKER).expect("the fixture compiles");
        let ty = shared_memory_import(&module).expect("the fixture imports a shared memory");
        let memory = SharedMemory::new(&engine, ty).expect("a shared memory");
        // The policies this test's hand-written wat needs: no families, so every
        // park is its own family and one key space wide enough to hold it. The
        // production values arrive from `scheduler::{family_of, key_capacity}`.
        fn identity_family(class: u32) -> u32 {
            class
        }
        fn wide_enough(_family: u32) -> Option<u32> {
            Some(1024)
        }
        let pool = ExecutorPool::new(
            engine.clone(),
            module.clone(),
            memory.clone(),
            2,
            identity_family,
            wide_enough,
        )
        .expect("a pool of two");

        let mut store = Store::new(&engine, Plain(Arc::clone(&pool)));
        store.set_epoch_deadline(NEVER_TRAPS);
        let mut linker: Linker<Plain> = Linker::new(&engine);
        define_memory(&memory, &mut store, &mut linker).expect("the memory defines");
        ExecutorPool::link(&mut linker).expect("the imports register");
        let instance = linker
            .instantiate(&mut store, &module)
            .expect("the fixture instantiates over the pool's memory");

        let count = instance
            .get_typed_func::<(), i32>(&mut store, "count")
            .expect("count")
            .call(&mut store, ())
            .expect("count runs");
        assert_eq!(count, 2, "__executorCount is main plus the pool");

        let spawn = instance
            .get_typed_func::<i32, i32>(&mut store, "spawn")
            .expect("spawn");
        assert_eq!(
            spawn.call(&mut store, 1).expect("spawn runs"),
            0,
            "the spawn is accepted"
        );
        assert_eq!(
            spawn.call(&mut store, 1).expect("spawn runs"),
            ERR_ALREADY_BORN,
            "a live id is refused rather than started twice"
        );
        assert_eq!(
            spawn.call(&mut store, 5).expect("spawn runs"),
            ERR_ID_OUT_OF_RANGE,
            "an id past the configured count is refused"
        );

        // The worker's write is the observation: it is in the memory this store
        // reads, and it is the id it was given.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut seen = 0;
        while std::time::Instant::now() < deadline {
            seen = read_word(&memory, 0);
            if seen != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(seen, 1, "the worker wrote its id into the shared memory");
        pool.join_finished();
        assert_eq!(pool.live_workers(), 0, "the finished worker was joined");
    }
}
