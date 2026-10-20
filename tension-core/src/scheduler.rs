//! The scheduler's host half: `scheduler::park`, the per-family park tables,
//! and the ids the host hands back to the guest's `__taskWake`.
//!
//! `docs/scheduler-contract.md` is the specification; this is one
//! implementation. The split it pins: the guest names a task id and parks
//! (§2.1), the host matches a completion to that id and calls `wake(ids)`
//! (§2.2), and the guest resolves each id to its continuation and resumes it
//! (§1.2). Nothing here decides *how* a resume happens — that is `__taskWake`'s
//! body, in the guest.
//!
//! # Why the tables are keyed by family, not by class
//!
//! A park happens once per await, and an await does not know whether it will be
//! completed by the success class or the failure class: a job await parks on
//! `JOB_DONE`'s stamp and is resumed by `JOB_DONE` **or** `JOB_FAILED`. The
//! guest already resolves this with a family map (`__taskBindFamily`,
//! `rt.ts:78-86`) and registers under `keyOf(familyOf(class), key)`
//! (`task-rt.ts:246`). The host must key identically or the two halves disagree
//! about what a parked task is waiting for — so the tables below are per
//! **family**, and a delivered class is resolved through `family_of` before the
//! lookup.
//!
//! # Bounds
//!
//! Every table is a direct array indexed by the producer's key, sized to the
//! largest key the producer can mint. That is what makes matching O(1) and
//! bounded (contract §3.3): no hashing, no probing, no growth. A key outside a
//! family's space is a **class refusal** (contract §5.1); a full *task table* is
//! the **scheduler refusal** (`-ENOSPC`), and it is counted here rather than
//! inferred from a table being full — the two are different failures.
//!
//! # What is live in 0.7.0a-pre0
//!
//! The import is registered and records. **Nothing reads the tables yet** — no
//! completion path matches against them until the host loop lands (0.7.0a), and
//! the guest does not call `park` at all until std 0.6.0 (0.7.0a-pre). So this
//! module is inert by construction: registering an unused import changes no
//! behaviour, and no existing guest imports `scheduler::park`.

// 0.7.0a-pre0 registers the import and the tables; the completion path that
// reads them lands in 0.7.0a. Until then the readers are exercised by this
// module's own tests and by nothing else, which is the honest shape of an inert
// phase — not a reason to leave the API unwritten.
#![allow(dead_code)]

use std::collections::HashMap;

use wasmtime::{Caller, Linker};

use crate::session::arena::{
    CLASS_AI_DONE, CLASS_AI_ERROR, CLASS_AI_READY, CLASS_DEVICE_LOST, CLASS_FRAME, CLASS_INPUT_KEY,
    CLASS_INPUT_MOUSE, CLASS_JOB_DONE, CLASS_JOB_FAILED, CLASS_LOG, CLASS_RESOURCE_FAILED,
    CLASS_RESOURCE_READY, CLASS_SUBMISSION_REJECTED,
};
use crate::HostState;

/// `-ENOSPC`: the scheduler's own refusal — the task table is full. Contract
/// §5.1 keeps this distinct from a class refusal, which carries the class's
/// error.
pub const ENOSPC: i32 = -28;

/// `-EINVAL`: a key outside the family's declared space, i.e. a class refusal
/// the scheduler can detect without knowing the class's own errno.
pub const EINVAL: i32 = -22;

/// The empty marker in a direct table. `u64::MAX` rather than 0, because task id
/// 0 is a valid slot index in the guest's table.
const EMPTY: u64 = u64::MAX;

/// The family a completion class belongs to. Mirrors the framework's bindings
/// (`tension-framework/assembly/runtime/rt.ts:78-86`) and the std's
/// `familyOf` fallback: an unbound class is its own family.
pub fn family_of(class: u32) -> u32 {
    match class {
        CLASS_JOB_DONE | CLASS_JOB_FAILED => CLASS_JOB_DONE,
        CLASS_RESOURCE_READY | CLASS_RESOURCE_FAILED => CLASS_RESOURCE_READY,
        CLASS_AI_READY | CLASS_AI_DONE | CLASS_AI_ERROR => CLASS_AI_DONE,
        // Everything else is its own family.
        other => other,
    }
}

/// The largest key a family's producer can mint — the table's bound, and the
/// line between a class refusal (key past it) and a scheduler refusal (no room).
///
/// A key is the producer's submit-time id, so the numbers come from the
/// producers, not from the ring capacities:
///
/// | family | bound | source |
/// |---|---|---|
/// | jobs | 768 | `loader.h:119` (`kCapacity`); ids are `slot + 1` |
/// | resources | 1024 | `loader.cpp:297` (`-ENOSPC` past 1024) |
/// | ai | 4 | `ai/mod.rs:114` (`MAX_SESSIONS`) |
/// | frame | 0 | key 0, one slot |
/// | input | 256 | the ring capacity `arena.rs:266-267` |
/// | log | 1024 | the ring capacity |
///
/// `None` means the class is not awaitable in this chunk: no producer parks on
/// it, so a park naming it is a class refusal.
pub fn key_capacity(family: u32) -> Option<u32> {
    match family {
        CLASS_JOB_DONE => Some(768),
        CLASS_RESOURCE_READY => Some(1024),
        CLASS_AI_DONE => Some(4),
        CLASS_FRAME => Some(0),
        CLASS_INPUT_KEY | CLASS_INPUT_MOUSE => Some(255),
        CLASS_LOG => Some(1023),
        CLASS_DEVICE_LOST | CLASS_SUBMISSION_REJECTED => Some(0),
        _ => None,
    }
}

/// One family's parked tasks: a direct array indexed by the producer's key.
#[derive(Debug)]
pub struct ParkTable {
    /// One entry per key in `0..=bound`. EMPTY when nothing is parked.
    slots: Vec<u64>,
    parked: u32,
}

impl ParkTable {
    fn new(bound: u32) -> ParkTable {
        ParkTable {
            slots: vec![EMPTY; bound as usize + 1],
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
        (slot != EMPTY).then_some(slot)
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
    fn insert(&mut self, key: u32, task_id: u64) -> Result<Option<u64>, ()> {
        let slot = match self.slots.get_mut(key as usize) {
            Some(slot) => slot,
            None => return Err(()),
        };
        let displaced = (*slot != EMPTY).then_some(*slot);
        if displaced.is_none() {
            self.parked += 1;
        }
        *slot = task_id;
        Ok(displaced)
    }

    /// Remove and answer the task parked on `key`.
    pub fn take(&mut self, key: u32) -> Option<u64> {
        let slot = self.slots.get_mut(key as usize)?;
        if *slot == EMPTY {
            return None;
        }
        let task_id = *slot;
        *slot = EMPTY;
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
            if self.slots[index] != EMPTY {
                taken.push(self.slots[index]);
                self.slots[index] = EMPTY;
                self.parked -= 1;
            }
        }
        taken
    }
}

/// Why a park was refused. Both variants are the contract's, kept apart (§5.1).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ParkRefusal {
    /// The class refuses: the family is not awaitable, or the key is outside its
    /// declared space. Status: the class's error.
    Class { family: u32, key: u32 },
    /// The scheduler refuses: no room for another parked task. Status: -ENOSPC.
    SchedulerFull { task_id: u64 },
}

impl ParkRefusal {
    /// The status the guest's task must settle with (contract §5.1: a refusal is
    /// a completion, not a silence).
    pub fn status(&self) -> i32 {
        match self {
            // The arena's general class error. A class may declare a more
            // specific one; this is what the scheduler can say without it.
            ParkRefusal::Class { .. } => EINVAL,
            ParkRefusal::SchedulerFull { .. } => ENOSPC,
        }
    }
}

/// Every family's table, and the counters that make the refusals observable.
#[derive(Debug)]
pub struct Scheduler {
    tables: HashMap<u32, ParkTable>,
    /// The largest number of tasks parked at once since start.
    high_water: u32,
    parked: u32,
    class_refusals: u64,
    scheduler_refusals: u64,
    /// The peak number of distinct keys occupied at once — the number the table
    /// capacity has to hold.
    /// Refused parks awaiting delivery: `(task_id, status)` in refusal order.
    ///
    /// Contract §2.1 makes `park` `void`, and §5.1 says a refusal is a
    /// **completion**, not a return value — so the refusal cannot travel back
    /// through the call. It is queued here and the next `wake(ids)` carries it;
    /// the guest sets the record's status before resuming, which is exactly the
    /// shape a lost completion already uses (§4.7).
    pending_refusals: Vec<(u64, i32)>,
}

impl Default for Scheduler {
    fn default() -> Self {
        Scheduler::new()
    }
}

impl Scheduler {
    pub fn new() -> Scheduler {
        Scheduler {
            tables: HashMap::new(),
            high_water: 0,
            parked: 0,
            class_refusals: 0,
            scheduler_refusals: 0,
            pending_refusals: Vec::new(),
        }
    }

    /// Register `task_id` as parked on `(class, key)`.
    ///
    /// `class` is the class the guest stamped on its record — the success class,
    /// not whatever completes it later; the family resolution is what makes a
    /// failure class find the same task.
    pub fn park(&mut self, task_id: u64, class: u32, key: u32) -> Result<(), ParkRefusal> {
        let family = family_of(class);
        let Some(bound) = key_capacity(family) else {
            self.class_refusals += 1;
            return Err(ParkRefusal::Class { family, key });
        };
        if key > bound {
            self.class_refusals += 1;
            return Err(ParkRefusal::Class { family, key });
        }
        let table = self
            .tables
            .entry(family)
            .or_insert_with(|| ParkTable::new(bound));
        if table.insert(key, task_id).is_err() {
            // Unreachable: the bound check above already excluded it.
            self.class_refusals += 1;
            return Err(ParkRefusal::Class { family, key });
        }
        self.parked = self.tables.values().map(|t| t.parked()).sum();
        self.high_water = self.high_water.max(self.parked);
        Ok(())
    }

    /// Remove the park for `(class, key)`, answering the task id that held it.
    /// This is what a completion does before the id goes to `wake`.
    pub fn take(&mut self, class: u32, key: u32) -> Option<u64> {
        let family = family_of(class);
        let table = self.tables.get_mut(&family)?;
        let task_id = table.take(key)?;
        self.parked = self.tables.values().map(|t| t.parked()).sum();
        Some(task_id)
    }

    /// Take up to `limit` parked ids from one family — the drop path (§4.4).
    ///
    /// A family with no park answers with an empty vector, which is the common
    /// case: a drop only costs a wake when something was actually waiting on it.
    pub fn take_from_family(&mut self, family: u32, limit: usize) -> Vec<u64> {
        let Some(table) = self.tables.get_mut(&family) else {
            return Vec::new();
        };
        let taken = table.take_upto(limit);
        if taken.is_empty() {
            return taken;
        }
        self.parked = self.tables.values().map(|t| t.parked()).sum();
        taken
    }

    /// Record a refused park for the next wake to carry.
    pub fn queue_refusal(&mut self, task_id: u64, status: i32) {
        self.pending_refusals.push((task_id, status));
    }

    /// Drain the refusals that still owe a wake, oldest first.
    pub fn take_refusals(&mut self) -> Vec<(u64, i32)> {
        std::mem::take(&mut self.pending_refusals)
    }

    /// Take the task parked on `(class, key)` — the frame add's accessor.
    /// Same call the completion path makes; the FRAME family's table is one
    /// slot, so this is the whole of "is a frame awaited?".
    pub fn take_frame(&mut self) -> Option<u64> {
        self.take(CLASS_FRAME, 0)
    }

    /// Tasks parked right now, and the high-water mark.
    pub fn parked(&self) -> u32 {
        self.parked
    }

    pub fn high_water(&self) -> u32 {
        self.high_water
    }

    /// How many parks each refusal kind turned away.
    pub fn refusals(&self) -> (u64, u64) {
        (self.class_refusals, self.scheduler_refusals)
    }
}

/// `scheduler::park(task_id, class, key): void` — the guest's one call per
/// suspension (contract §2.1).
///
/// **Void, as the contract says.** The guest has already written its own task
/// table entry — it owns the continuation — so this call only records the
/// rendezvous. A refusal has nowhere to go in a `void` signature, and §5.1 is
/// explicit that a refusal is a completion rather than a return value, so it is
/// queued: the next `wake(ids)` carries the id, and `__taskWake` sets the
/// record's status before resuming. That is the same mechanism a lost completion
/// uses (§4.7), which is why it needs no second one.
///
/// Measured against a `-> i32` shape first: a `.wat` declaring
/// `(func (param i64 i32 i32))` fails to instantiate against a host that
/// registered `(func (param i64 i32 i32) (result i32))` —
/// "types incompatible". The contract's signature is the one that compiles.
pub fn scheduler_park(caller: &mut Caller<'_, HostState>, task_id: i64, class: i32, key: i32) {
    let task_id = task_id as u64;
    let class = class as u32;
    let key = key as u32;
    if let Err(refusal) = caller.data_mut().scheduler.park(task_id, class, key) {
        caller
            .data_mut()
            .scheduler
            .queue_refusal(task_id, refusal.status());
    }
}

/// Register the `scheduler` import namespace.
///
/// **Additive and inert.** Wasmtime resolves a linker definition only when a
/// guest actually imports it, so this changes nothing for the guests compiled
/// against std 0.5.1 — measured: a `.wat` importing `scheduler::park` against a
/// host without this entry fails at *instantiation* with "unknown import", which
/// is exactly the failure this registration removes for the next release.
pub fn link_scheduler(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    linker.func_wrap(
        "scheduler",
        "park",
        |mut caller: Caller<'_, HostState>, task_id: i64, class: i32, key: i32| {
            scheduler_park(&mut caller, task_id, class, key)
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_park_records_and_takes_once() {
        let mut scheduler = Scheduler::new();
        assert_eq!(scheduler.park(7, CLASS_JOB_DONE, 3), Ok(()));
        assert_eq!(scheduler.parked(), 1);

        // A re-park of the same key displaces the old id — the guest's own
        // registration does the same, and a task awaiting one producer id twice
        // (the AI stream, every chunk) depends on it.
        assert_eq!(scheduler.park(8, CLASS_JOB_DONE, 3), Ok(()));
        assert_eq!(scheduler.parked(), 1, "one key, still one park");
        assert_eq!(scheduler.take(CLASS_JOB_DONE, 3), Some(8));

        assert_eq!(scheduler.parked(), 0);
        // Taking it twice yields nothing, so a completion cannot resume twice.
        assert_eq!(scheduler.take(CLASS_JOB_DONE, 3), None);
    }

    #[test]
    fn a_failure_class_finds_the_task_parked_on_the_success_class() {
        // The whole reason the tables are per family: a job await parks on
        // JOB_DONE's stamp and must be resumed by either outcome.
        let mut scheduler = Scheduler::new();
        assert_eq!(scheduler.park(11, CLASS_JOB_DONE, 42), Ok(()));
        assert_eq!(scheduler.take(CLASS_JOB_FAILED, 42), Some(11));
    }

    #[test]
    fn the_ai_family_is_one_table_of_four() {
        let mut scheduler = Scheduler::new();
        for handle in 0..4u32 {
            assert_eq!(scheduler.park(handle as u64, CLASS_AI_READY, handle), Ok(()));
        }
        // Session handles are 1..=MAX_SESSIONS (4) — `session_create` answers
        // `> 0` or 0-for-failure — so key 5 is outside the space. A class
        // refusal, not a scheduler one.
        let refused = scheduler.park(99, CLASS_AI_READY, 5).unwrap_err();
        assert_eq!(refused, ParkRefusal::Class { family: CLASS_AI_DONE, key: 5 });
        assert_eq!(refused.status(), EINVAL);
        assert_eq!(scheduler.refusals(), (1, 0));

        // And any of the three classes resolves the same parked task.
        assert_eq!(scheduler.take(CLASS_AI_DONE, 2), Some(2));
        assert_eq!(scheduler.take(CLASS_AI_ERROR, 3), Some(3));
    }

    #[test]
    fn a_key_past_the_bound_is_a_class_refusal_and_enospc_is_distinct() {
        let mut scheduler = Scheduler::new();
        // The job space is 0..=768.
        assert!(scheduler.park(1, CLASS_JOB_DONE, 768).is_ok());
        let past = scheduler.park(2, CLASS_JOB_DONE, 769).unwrap_err();
        assert_eq!(past.status(), EINVAL);
        assert_eq!(scheduler.refusals(), (1, 0));

        // The scheduler refusal is its own status and its own counter.
        assert_eq!(ParkRefusal::SchedulerFull { task_id: 1 }.status(), -28);
        assert_eq!(ENOSPC, -28);
        assert_ne!(EINVAL, ENOSPC);
    }

    #[test]
    fn an_unawaitable_class_is_a_class_refusal() {
        let mut scheduler = Scheduler::new();
        // LOG declares a key space even though nothing awaits it in this chunk,
        // so a park on it is accepted — the table exists, the producer does not.
        assert_eq!(scheduler.park(1, CLASS_LOG, 0), Ok(()));
        // A class the scheduler does not know at all has no key space at all.
        let unknown = scheduler.park(2, 99, 0).unwrap_err();
        assert_eq!(unknown, ParkRefusal::Class { family: 99, key: 0 });
        assert_eq!(unknown.status(), EINVAL);
    }

    #[test]
    fn the_frame_family_has_exactly_one_slot() {
        let mut scheduler = Scheduler::new();
        assert_eq!(scheduler.park(5, CLASS_FRAME, 0), Ok(()));
        let refused = scheduler.park(6, CLASS_FRAME, 1).unwrap_err();
        assert_eq!(refused, ParkRefusal::Class { family: CLASS_FRAME, key: 1 });
    }

    #[test]
    fn the_high_water_tracks_the_peak() {
        let mut scheduler = Scheduler::new();
        for id in 0..5u64 {
            scheduler.park(id, CLASS_JOB_DONE, id as u32).unwrap();
        }
        assert_eq!(scheduler.high_water(), 5);
        scheduler.take(CLASS_JOB_DONE, 0).unwrap();
        assert_eq!(scheduler.parked(), 4);
        assert_eq!(scheduler.high_water(), 5, "the peak does not fall");
    }
}
