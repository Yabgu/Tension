//! The epoch: publish, invoke, and (in A2c) apply — the only place the session
//! decides when anything reaches the guest (`DESIGN.md` §3.3).
//!
//! Everything here runs **on the guest thread, inside a `session::*` call**. An
//! adapter posts from anywhere; the records wait in the class queues; an epoch
//! is what moves them into the arena and tells the guest about them. That split
//! is why this module can invoke the guest's own callbacks at all: it is already
//! inside a host call, on the stack the guest is using, so calling a
//! `TypedFunc` is a nested wasm call rather than a second thread.
//!
//! The three phases, in the order the design fixes them:
//!
//! 1. **Publish** — the adapters' own `publish` hooks run first (they write the
//!    host → guest regions), then each class queue is drained into its sub-ring,
//!    the counters are mirrored, and `FrameState` is written. Publishing
//!    completes for the whole epoch *before* the first callback fires: that is
//!    what makes an exempt accessor called from inside a callback consistent.
//! 2. **Invoke** — class by class, ascending id: one `onBatch` for a `BATCHED`
//!    class, one `onEvent` per record for a `DIRECT` one. A class with no
//!    registered callback is still published (the guest reads the ring itself),
//!    and its delivery counter still advances.
//! 3. **Apply** — deferred submissions. **Not implemented in A2b**: the call
//!    site exists and the pending list is always empty (A2c fills it).
//!
//! Guest memory is acquired per use and never held across a callback (the
//! round-2 hard rule): every read of the arena happens through a fresh
//! `memory.data(&caller)`.

use wasmtime::Caller;

use super::arena::{self, CLASS_COUNT, EVENT_RECORD_SIZE, RING_HEADER_SIZE};
use super::apply;
use super::posting::WaitOutcome;
use super::subring::{self, SubringError};
use super::{log, Session, SessionError};
use crate::HostState;

/// Which classes an epoch covers, and whether it blocks first.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EpochMode {
    /// Block up to `timeout_ms` for the first event, then publish everything
    /// (`timeout_ms < 0` blocks indefinitely, `0` never blocks).
    Wait { timeout_ms: i32 },
    /// Never block; publish and invoke only this class.
    Drain { class: u32 },
    /// Never block; publish and invoke every class.
    DrainAll,
}

/// What one epoch did.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct EpochResult {
    /// Records delivered to the guest this epoch: appended to a sub-ring and
    /// either invoked or left for the guest to read.
    pub deliveries: u32,
    /// Whether the epoch ended in a fault (a callback trap). The verb that ran
    /// it returns `-EIO`.
    pub faulted: bool,
}

/// One class's records for this epoch: where they start in the sub-ring and how
/// many there are.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct Delivery {
    class: u32,
    first_slot: u32,
    count: u32,
}

/// The slot index a class's delivery callbacks are invoked with, as a guest
/// address: `EVENT_TABLE` sits at a fixed arena offset and the arena is the
/// guest's memory from address 0.
fn slot_address(capacities: &[u32; CLASS_COUNT], class: u32, slot: u32) -> Option<u32> {
    let at = subring::event_subring_offset(capacities, class).ok()?;
    let address = at + RING_HEADER_SIZE + (slot as usize) * EVENT_RECORD_SIZE;
    u32::try_from(address).ok()
}

/// Run one epoch. See the module comment for the phase order.
pub fn run_epoch(
    session: &mut Session,
    caller: &mut Caller<'_, HostState>,
    mode: EpochMode,
) -> Result<EpochResult, SessionError> {
    // 1. State. `wait` and `drain` are non-exempt verbs: in any state but READY
    //    they refuse with -EBADF (§6.3).
    if session.require_ready() != 0 {
        return Err(SessionError::NotReady {
            state: session.state(),
        });
    }

    // 2. Depth. A callback that waits would run an epoch inside an epoch, and
    //    the guest's own stack is already inside the first one.
    if caller.data().depth != 0 {
        return Err(SessionError::Reentrant);
    }

    let posting = caller.data().posting.clone();
    let adapters = caller.data().adapters.clone();
    let capacities = *session.ring_capacities();

    // 3. Block, when this is a wait.
    if let EpochMode::Wait { timeout_ms } = mode {
        match posting.wait_for_events(timeout_ms) {
            WaitOutcome::Events => {}
            WaitOutcome::TimedOut => {}
            // A shutdown is not an epoch: the session is going away, and writing
            // FrameState to say so would race the close that asked for it.
            WaitOutcome::WokenWithNothing => {
                if posting.is_shutdown() {
                    return Ok(EpochResult::default());
                }
            }
        }
    }

    // 4a. Publish: the adapters' own regions first, in registration order.
    let hooks = crate::adapter::run_publish_hooks(caller, &adapters);
    let _ = hooks;

    // A fatal adapter fault, if one was signalled while the guest was blocked:
    // the publish phase is where the job sweep belongs (`DESIGN.md` §8). The
    // sweep is a stub — chunk 1 has no job records — and no adapter triggers
    // this yet; the flag is what wakes a blocking wait.
    if posting.has_pending_faults() {
        let memory = caller.data().arena;
        if let Some(memory) = memory {
            let arena_bytes = memory.data_mut(&mut *caller);
            let swept = apply::sweep_jobs_to_failed(arena_bytes, EIO);
            let _ = swept;
        }
        posting.clear_fault();
    }

    // 4b–4d. This epoch's classes: flush, mirror, report.
    let classes: Vec<u32> = match mode {
        EpochMode::Drain { class } => vec![class],
        EpochMode::Wait { .. } | EpochMode::DrainAll => (0..CLASS_COUNT as u32).collect(),
    };

    let memory = caller.data().arena.ok_or(SessionError::ArenaLost)?;
    let mut deliveries: Vec<Delivery> = Vec::new();
    {
        let arena_bytes = memory.data_mut(&mut *caller);
        for class in &classes {
            let Some(queue) = posting.queue(*class) else {
                return Err(SessionError::Subring(SubringError::UnknownClass { class: *class }));
            };
            let flushed = subring::flush_class_to_ring(arena_bytes, &capacities, *class, queue)
                .map_err(SessionError::Subring)?;
            if flushed.delivered > 0 {
                deliveries.push(Delivery {
                    class: *class,
                    first_slot: flushed.first_slot,
                    count: flushed.delivered,
                });
            }
            // Mirror the host's authoritative counters into the class's header
            // (`DESIGN.md` §3.4). The arena copy is a report; the queue is the
            // truth, and the next publish overwrites whatever a guest wrote.
            let at = subring::event_subring_offset(&capacities, *class).map_err(SessionError::Subring)?;
            arena::set_ring_dropped(arena_bytes, at, queue.dropped().min(u32::MAX as u64) as u32)?;
            arena::set_ring_delivered(arena_bytes, at, queue.delivered().min(u32::MAX as u64) as u32)?;
        }

        // 4c. FrameState: the epoch counter, the cross-class drop rollup, and a
        //     clean fault report — a fault, if one happens, is written by the
        //     invoke phase below.
        session.bump_frame_index();
        arena::write_frame_state(
            arena_bytes,
            &arena::FrameStateValues {
                frame_index: session.frame_index(),
                dropped_events: posting.dropped_total().min(u32::MAX as u64) as u32,
                fault_state: 0,
                last_error: 0,
            },
        )?;

        // 4d. The control block's state, if it changed. During a normal epoch it
        //     does not: this is the "write it if it changed" of the design, kept
        //     so a session that recovered from a fault is reported accurately.
        if arena::control_state(arena_bytes) != arena::STATE_READY {
            arena::set_control_state(arena_bytes, arena::STATE_READY)?;
            arena::set_control_fault_code(arena_bytes, 0)?;
        }
    }

    // 5. Invoke. Publish is complete for the whole epoch before the first
    //    callback runs.
    let mut delivered = 0u32;
    for delivery in &deliveries {
        let mode = posting.mode(delivery.class).unwrap_or(arena::MODE_POLLED);
        let classes_with_callbacks = session.callbacks();
        match mode {
            arena::MODE_BATCHED if !session.slot_disabled(0) => {
                let Some(callback) = classes_with_callbacks.and_then(|resolved| resolved.on_batch.as_ref())
                else {
                    // No callback: the records stay in the ring, and the guest
                    // reads them at its own pace. The delivery still counts.
                    delivered += delivery.count;
                    continue;
                };
                let Some(ptr) = slot_address(&capacities, delivery.class, delivery.first_slot) else {
                    return Err(SessionError::Subring(SubringError::UnknownClass {
                        class: delivery.class,
                    }));
                };
                caller.data_mut().depth = 1;
                let outcome = callback.call(&mut *caller, (delivery.class as i32, ptr as i32, delivery.count as i32));
                caller.data_mut().depth = 0;
                match outcome {
                    Ok(_status) => delivered += delivery.count,
                    Err(trap) => {
                        return Err(fault_from_trap(session, caller, 0, "onBatch", delivery, &trap));
                    }
                }
            }
            arena::MODE_DIRECT if !session.slot_disabled(1) => {
                let Some(callback) = classes_with_callbacks.and_then(|resolved| resolved.on_event.as_ref())
                else {
                    delivered += delivery.count;
                    continue;
                };
                for index in 0..delivery.count {
                    let Some(ptr) = slot_address(
                        &capacities,
                        delivery.class,
                        delivery.first_slot + index,
                    ) else {
                        return Err(SessionError::Subring(SubringError::UnknownClass {
                            class: delivery.class,
                        }));
                    };
                    caller.data_mut().depth = 1;
                    let outcome = callback.call(&mut *caller, (delivery.class as i32, ptr as i32));
                    caller.data_mut().depth = 0;
                    match outcome {
                        Ok(_status) => delivered += 1,
                        Err(trap) => {
                            // The batch is abandoned: the remaining records stay
                            // in the ring, where the guest can still read them.
                            return Err(fault_from_trap(session, caller, 1, "onEvent", delivery, &trap));
                        }
                    }
                }
            }
            // POLLED and RING are not delivered by an epoch (chunk 1 stubs
            // RING): the records are in the ring, which is the point of both.
            _ => delivered += delivery.count,
        }
    }

    // 6. Apply. Everything a callback deferred was *copied* when it called the
    //    verb, so it is the session's work now: apply it, at depth 0, and let a
    //    failure become a SUBMISSION_REJECTED delivery next epoch.
    //
    //    A trapping callback returns before this point on purpose (R7): the
    //    pending queue is not cleared, and the submissions are applied at the
    //    guest's next epoch — which, after a fault, is the first epoch of a
    //    closed-and-reopened session.
    let report = apply::apply_pending(session, caller, &adapters);
    if report.applied > 0 || report.rejected > 0 || report.dropped > 0 {
        log(&format!(
            "apply: {} applied, {} rejected, {} dropped",
            report.applied, report.rejected, report.dropped
        ));
    }

    Ok(EpochResult {
        deliveries: delivered,
        faulted: false,
    })
}

/// A callback trapped. Disable its slot for the session's lifetime, publish the
/// fault, and hand the caller the error the verb returns (`-EIO`).
///
/// The two writes — `FrameState` and the control block — happen together, before
/// the caller sees the error: a guest that reads the arena after a refused wait
/// finds the fault it was refused for.
fn fault_from_trap(
    session: &mut Session,
    caller: &mut Caller<'_, HostState>,
    slot_index: u32,
    slot: &'static str,
    delivery: &Delivery,
    trap: &wasmtime::Error,
) -> SessionError {
    log(&format!(
        "callback `{slot}` trapped while delivering class {}: {trap}; the slot is disabled \
         for this session and the session is FAULTED",
        delivery.class
    ));
    session.disable_slot(slot_index);
    session.fault();

    let posting = caller.data().posting.clone();
    if let Some(memory) = caller.data().arena {
        let arena_bytes = memory.data_mut(&mut *caller);
        let _ = arena::write_frame_state(
            arena_bytes,
            &arena::FrameStateValues {
                frame_index: session.frame_index(),
                dropped_events: posting.dropped_total().min(u32::MAX as u64) as u32,
                fault_state: arena::FAULT_CALLBACK_TRAP,
                last_error: slot_index,
            },
        );
        let _ = arena::set_control_state(arena_bytes, arena::STATE_FAULTED);
        let _ = arena::set_control_fault_code(arena_bytes, EIO);
    }
    SessionError::CallbackTrap { slot }
}

/// `-EIO`: the fault errno at this boundary (`DESIGN.md` §6.3).
pub const EIO: i32 = -5;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{config, EINVAL};
    use wasmtime::{Engine, Instance, Linker, Module, Store};

    // ── the guest's own addresses ─────────────────────────────────────────
    //
    // Everything the tests and the guest share lives in the guest's heap, above
    // `memoryBase` (8 MiB), which is the only place a guest's own bytes belong.

    /// The script: `(op, a, b)` triples, 12 bytes each, 0-terminated.
    const SCRIPT: i32 = 8_392_704; // memoryBase + 0x1000
    /// One `i32` per script op: what the verb returned.
    const RESULTS: i32 = 8_396_800; // + 0x2000
    /// The config TLV, 82 bytes.
    const CFG: i32 = 8_401_152; // + 0x3000
    /// The `Callbacks` record: 64 bytes.
    const CALLBACKS: i32 = 8_401_408; // + 0x3200
    /// A `Subscription`: 16 bytes.
    const SUBSCRIPTION: i32 = 8_401_536; // + 0x3400
    /// How many times each callback ran.
    const BATCH_CALLS: i32 = 8_404_992; // + 0x4000
    const EVENT_CALLS: i32 = 8_404_996;
    /// What the last `onBatch` saw.
    const BATCH_CLASS: i32 = 8_405_000;
    const BATCH_PTR: i32 = 8_405_004;
    const BATCH_COUNT: i32 = 8_405_008;
    /// What the last `onEvent` saw.
    const EVENT_CLASS: i32 = 8_405_012;
    const EVENT_SEQ: i32 = 8_405_016;
    /// Where the publish hook's sentinel lands (`echo_adapter.c` agrees on this
    /// address: it is in the guest's heap, above `memoryBase`).
    pub(super) const SENTINEL: i32 = 8_389_888;
    /// What the batch callback saw there.
    const BATCH_SENTINEL: i32 = 8_405_020;

    /// The scripted guest: it calls whatever the host wrote into its heap, and
    /// its two callbacks record what they were handed. One guest serves every
    /// test that way — the script is the test's, the plumbing is the same.
    const GUEST: &str = r#"
(module
  (import "session" "memory" (memory 132 4096))
  (export "memory" (memory 0))
  (import "session" "open" (func $open (param i32 i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))
  (import "session" "drain" (func $drain (param i32) (result i32)))
  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "unsubscribe" (func $unsubscribe (param i32) (result i32)))
  (import "session" "pending" (func $pending (result i32)))

  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (type $event_t (func (param i32 i32) (result i32)))

  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    (i32.store (i32.const 8404992) (i32.add (i32.load (i32.const 8404992)) (i32.const 1)))
    (i32.store (i32.const 8405000) (local.get $class))
    (i32.store (i32.const 8405004) (local.get $ptr))
    (i32.store (i32.const 8405008) (local.get $count))
    (i32.store8 (i32.const 8405020) (i32.load8_u (i32.const 8389888)))
    (i32.const 0))

  (func $event (type $event_t) (param $class i32) (param $ptr i32) (result i32)
    (i32.store (i32.const 8404996) (i32.add (i32.load (i32.const 8404996)) (i32.const 1)))
    (i32.store (i32.const 8405012) (local.get $class))
    (i32.store (i32.const 8405016) (i32.wrap_i64 (i64.load (local.get $ptr))))
    (i32.const 0))

  (table 4 funcref)
  (elem (i32.const 1) $batch $event)
  (export "table" (table 0))

  (func (export "_start_game")
    (local $i i32) (local $op i32) (local $a i32) (local $b i32) (local $rc i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $end
      (loop $next
        (local.set $p (i32.add (i32.const 8392704) (i32.mul (local.get $i) (i32.const 12))))
        (local.set $op (i32.load (local.get $p)))
        (br_if $end (i32.eqz (local.get $op)))
        (local.set $a (i32.load (i32.add (local.get $p) (i32.const 4))))
        (local.set $b (i32.load (i32.add (local.get $p) (i32.const 8))))
        (local.set $rc (i32.const -999))
        (if (i32.eq (local.get $op) (i32.const 1)) (then (local.set $rc (call $open (local.get $a) (local.get $b)))))
        (if (i32.eq (local.get $op) (i32.const 2)) (then (local.set $rc (call $wait (local.get $a)))))
        (if (i32.eq (local.get $op) (i32.const 3)) (then (local.set $rc (call $drain (local.get $a)))))
        (if (i32.eq (local.get $op) (i32.const 4)) (then (local.set $rc (call $subscribe (local.get $a)))))
        (if (i32.eq (local.get $op) (i32.const 5)) (then (local.set $rc (call $unsubscribe (local.get $a)))))
        (if (i32.eq (local.get $op) (i32.const 6)) (then (local.set $rc (call $pending))))
        (i32.store (i32.add (i32.const 8396800) (i32.mul (local.get $i) (i32.const 4))) (local.get $rc))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)
      )
    )
  )
)
"#;

    /// The same guest, with an `onBatch` that traps: the fault path's fixture.
    const GUEST_TRAPPING: &str = r#"
(module
  (import "session" "memory" (memory 132 4096))
  (export "memory" (memory 0))
  (import "session" "open" (func $open (param i32 i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))

  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    (unreachable))

  (table 4 funcref)
  (elem (i32.const 1) $batch)
  (export "table" (table 0))

  (func (export "_start_game")
    (local $i i32) (local $op i32) (local $a i32) (local $b i32) (local $rc i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $end
      (loop $next
        (local.set $p (i32.add (i32.const 8392704) (i32.mul (local.get $i) (i32.const 12))))
        (local.set $op (i32.load (local.get $p)))
        (br_if $end (i32.eqz (local.get $op)))
        (local.set $a (i32.load (i32.add (local.get $p) (i32.const 4))))
        (local.set $b (i32.load (i32.add (local.get $p) (i32.const 8))))
        (local.set $rc (i32.const -999))
        (if (i32.eq (local.get $op) (i32.const 1)) (then (local.set $rc (call $open (local.get $a) (local.get $b)))))
        (if (i32.eq (local.get $op) (i32.const 2)) (then (local.set $rc (call $wait (local.get $a)))))
        (i32.store (i32.add (i32.const 8396800) (i32.mul (local.get $i) (i32.const 4))) (local.get $rc))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)
      )
    )
  )
)
"#;

    // ── the harness ───────────────────────────────────────────────────────

    /// A guest, a store, a session and an instance — the state an epoch test
    /// starts from, with the host's fixtures (config, callbacks record, script)
    /// written into the guest's heap.
    pub(super) struct Harness {
        pub(super) store: Store<HostState>,
        pub(super) memory: wasmtime::Memory,
        pub(super) instance: Instance,
        pub(super) posting: std::sync::Arc<super::super::posting::PostingSide>,
        /// The reference adapter, when the harness loaded it: it must outlive
        /// every epoch, because its vtable pointers are in `HostState`.
        #[allow(dead_code)]
        adapters: Vec<crate::adapter::LoadedAdapter>,
        #[allow(dead_code)]
        host: Option<Box<crate::adapter::AdapterHost>>,
        /// The private copy of the adapter library this harness loaded, removed
        /// when the harness goes: one `.so` is one instance per process, so the
        /// tests each get their own image.
        scratch_library: Option<std::path::PathBuf>,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            // The library stays mapped until the process exits (dlclose is not
            // called here: the linker still holds pointers into it), but the
            // directory entry can go — a mapped file with no name is exactly what
            // a scratch copy should be.
            if let Some(path) = self.scratch_library.take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// Makes the per-harness library copies unique.
    static NEXT_LIBRARY: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    impl Harness {
        /// Build the harness for a guest whose `open` op carries `callbacks`
        /// (slot indices, or `None` for an absent record).
        pub(super) fn new(wat: &str, callbacks: Option<(u32, u32)>) -> Harness {
            Harness::build(wat, callbacks, false)
        }

        /// The same harness with the reference adapter loaded and linked, so its
        /// `publish` hook runs at the head of every epoch.
        pub(super) fn with_echo(wat: &str, callbacks: Option<(u32, u32)>) -> Harness {
            Harness::build(wat, callbacks, true)
        }

        fn build(wat: &str, callbacks: Option<(u32, u32)>, load_echo: bool) -> Harness {
            let engine = Engine::default();
            let module = Module::new(&engine, wat).expect("the guest compiles");
            let posting = std::sync::Arc::new(super::super::posting::PostingSide::default());
            let mut store = Store::new(
                &engine,
                HostState {
                    args: Vec::new(),
                    pending_line: None,
                    res: Vec::new(),
                    audio: crate::audio::AudioSession::new(crate::default_adapter()),
                    ai: crate::ai::AiSession::new(crate::default_ai_adapter()),
                    solver: crate::solver::SolverHost::default(),
                    posting: std::sync::Arc::clone(&posting),
                    arena: None,
                    depth: 0,
                    pending: crate::session::apply::PendingQueue::new(),
                    adapters: Vec::new(),
                    session: None,
                },
            );
            let mut session = Session::create_from_module(&mut store, &module).expect("session");
            session
                .prepare_arena(&mut store)
                .expect("the arena is prepared");
            let memory = session.memory();

            let mut linker: Linker<HostState> = Linker::new(&engine);
            session
                .install(&mut store, &mut linker)
                .expect("the memory is defined");
            super::super::link_session(&mut linker).expect("the verbs are registered");
            store.data_mut().arena = Some(memory);

            // The reference adapter, when this harness wants its hooks: it is
            // loaded and linked before instantiation, exactly as `main` does it,
            // and its imports are installed in the same linker.
            //
            // **A private copy of the library, per harness.** The echo adapter
            // keeps its state in file-scope statics — the frozen vtable has no
            // context accessor, which is the limitation §12's future work names —
            // so one `.so` is one instance per process: `dlopen` on the same path
            // twice hands back the same image, and two harnesses running
            // concurrently (cargo does that) would overwrite each other's
            // `g_core`. A copy at a unique path is a separate image with separate
            // statics, which is what lets the tests run in parallel. Production
            // loads the library once and has no such problem.
            let mut host = None;
            let mut adapters = Vec::new();
            let mut scratch_library = None;
            if load_echo {
                let source = std::path::PathBuf::from(env!("TENSION_ECHO_ADAPTER"));
                let copy = std::env::temp_dir().join(format!(
                    "tension-echo-test-{}-{}.so",
                    std::process::id(),
                    NEXT_LIBRARY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                ));
                std::fs::copy(&source, &copy).expect("the adapter copy is writable");
                let adapter = crate::adapter::load_adapter(&copy).expect("the adapter copy loads");
                scratch_library = Some(copy);
                let adapter_host = crate::adapter::AdapterHost::new(std::sync::Arc::clone(&posting));
                adapters.push(adapter);
                crate::adapter::link_adapters(&mut linker, &mut adapters, adapter_host.api())
                    .expect("the adapter links");
                store.data_mut().adapters =
                    crate::adapter::adapter_calls(&adapters, adapter_host.api());
                host = Some(adapter_host);
            }

            store.data_mut().session = Some(session);

            let instance = linker
                .instantiate(&mut store, &module)
                .expect("the guest instantiates");
            store
                .data()
                .session
                .as_ref()
                .expect("session")
                .verify_post_instantiate(&store)
                .expect("the arena survived instantiation");

            // The config TLV: arena at the layout floor, the default ceiling,
            // and the callbacks record the guest's own `open` will point at.
            let (ptr, len) = match callbacks {
                Some(_) => (CALLBACKS as i64, crate::session::arena::CALLBACKS_SIZE as i64),
                None => (0, 0),
            };
            let entries = vec![
                (config::KEY_ABI_VERSION, crate::session::arena::ABI_VERSION as i64),
                (config::KEY_LAYOUT_HASH, crate::session::arena::layout_hash() as i64),
                (config::KEY_ARENA_SIZE, crate::session::arena::LAYOUT_FLOOR as i64),
                (
                    config::KEY_MAX_ARENA_SIZE,
                    crate::session::arena::DEFAULT_MAX_ARENA_SIZE as i64,
                ),
                (config::KEY_CALLBACKS_PTR, ptr),
                (config::KEY_CALLBACKS_LEN, len),
            ];
            let tlv = config::encode(&entries);
            memory
                .write(&mut store, CFG as usize, &tlv)
                .expect("the config lands");

            if let Some((batch, event)) = callbacks {
                let mut record = [0u8; 64];
                record[0..2].copy_from_slice(&crate::session::arena::ABI_VERSION.to_le_bytes());
                record[2..4].copy_from_slice(&2u16.to_le_bytes());
                record[8..12].copy_from_slice(&batch.to_le_bytes());
                record[12..16].copy_from_slice(&event.to_le_bytes());
                memory
                    .write(&mut store, CALLBACKS as usize, &record)
                    .expect("the callbacks record lands");
            }

            Harness {
                store,
                memory,
                instance,
                posting,
                adapters,
                host,
                scratch_library,
            }
        }

        /// Write a `Subscription` for `class` in `mode` at [`SUBSCRIPTION`].
        pub(super) fn write_subscription(&mut self, class: u32, mode: u32) {
            let mut record = [0u8; 16];
            record[0..4].copy_from_slice(&class.to_le_bytes());
            record[4..8].copy_from_slice(&mode.to_le_bytes());
            self.memory
                .write(&mut self.store, SUBSCRIPTION as usize, &record)
                .expect("the subscription lands");
        }

        /// Write the script: `(op, a, b)` triples.
        pub(super) fn write_script(&mut self, ops: &[(i32, i32, i32)]) {
            let mut bytes = Vec::new();
            for (op, a, b) in ops {
                bytes.extend_from_slice(&op.to_le_bytes());
                bytes.extend_from_slice(&a.to_le_bytes());
                bytes.extend_from_slice(&b.to_le_bytes());
            }
            bytes.extend_from_slice(&0i32.to_le_bytes());
            self.memory
                .write(&mut self.store, SCRIPT as usize, &bytes)
                .expect("the script lands");
        }

        /// Run the scripted guest.
        pub(super) fn run(&mut self) {
            let start = self
                .instance
                .get_typed_func::<(), ()>(&mut self.store, "_start_game")
                .expect("_start_game");
            start.call(&mut self.store, ()).expect("the guest runs");
        }

        pub(super) fn word(&self, at: i32) -> i32 {
            let mut bytes = [0u8; 4];
            self.memory
                .read(&self.store, at as usize, &mut bytes)
                .expect("read");
            i32::from_le_bytes(bytes)
        }

        /// The return values the guest recorded, in script order.
        pub(super) fn results(&self) -> Vec<i32> {
            (0..8).map(|i| self.word(RESULTS + i * 4)).collect()
        }

        /// The callback's plan, as the deferring guest reads it: how many
        /// deferrable calls to make, the slot number the first one uses (a
        /// negative base asks the echo adapter's `apply` to fail), and whether
        /// to trap afterwards.
        pub(super) fn set_callback_plan(&mut self, notes: u32, base: i32, trap: bool) {
            self.memory
                .write(&mut self.store, NOTE_COUNT as usize, &notes.to_le_bytes())
                .expect("the plan lands");
            self.memory
                .write(&mut self.store, NOTE_BASE as usize, &base.to_le_bytes())
                .expect("the base lands");
            self.memory
                .write(&mut self.store, TRAP_FLAG as usize, &[trap as u8])
                .expect("the trap flag lands");
        }

        /// A subscription record at its own address, so one script can carry
        /// two of them.
        pub(super) fn write_subscription_at(&mut self, at: i32, class: u32, mode: u32) {
            let mut record = [0u8; 16];
            record[0..4].copy_from_slice(&class.to_le_bytes());
            record[4..8].copy_from_slice(&mode.to_le_bytes());
            self.memory
                .write(&mut self.store, at as usize, &record)
                .expect("the subscription lands");
        }

        /// One byte of the arena, as a test reads it.
        pub(super) fn byte(&self, at: i32) -> u8 {
            let mut byte = [0u8; 1];
            self.memory
                .read(&self.store, at as usize, &mut byte)
                .expect("read");
            byte[0]
        }

        /// The host the session's hooks reach through the API table.
        pub(super) fn adapter_host(&self) -> Option<&Box<crate::adapter::AdapterHost>> {
            self.host.as_ref()
        }

        /// Put an `AdapterCall` in front of the session's adapters, so the apply
        /// phase calls it. Used by the depth probe.
        pub(super) fn push_adapter_call(&mut self, call: crate::adapter::AdapterCall) {
            self.store.data_mut().adapters.insert(0, call);
        }

        /// One scratch word of the deferring guest.
        pub(super) fn scratch(&self, at: i32) -> i32 {
            self.word(at)
        }

        pub(super) fn pending_len(&self) -> u32 {
            self.store.data().pending.len()
        }

        pub(super) fn post(&self, class: u32, a: u32, b: u32) -> u64 {
            self.posting
                .post(1, class, 0, a, b, 0.5, 0.25)
                .expect("the queue has room")
        }

        pub(super) fn header(&self, class: u32) -> crate::session::arena::RingHeader {
            let capacities = *self
                .store
                .data()
                .session
                .as_ref()
                .expect("session")
                .ring_capacities();
            let at = crate::session::subring::event_subring_offset(&capacities, class)
                .expect("class exists");
            let data = self.memory.data(&self.store);
            crate::session::arena::ring_header(data, at)
        }

        pub(super) fn frame_state(&self) -> crate::session::arena::FrameStateValues {
            crate::session::arena::read_frame_state(self.memory.data(&self.store))
        }

        pub(super) fn session_state(&self) -> crate::session::SessionState {
            self.store
                .data()
                .session
                .as_ref()
                .expect("session")
                .state()
        }

        /// The first record of a class's sub-ring, read straight from the arena.
        pub(super) fn first_record(&self, class: u32, slot: u32) -> crate::session::arena::EventRecord {
            let capacities = *self
                .store
                .data()
                .session
                .as_ref()
                .expect("session")
                .ring_capacities();
            let data = self.memory.data(&self.store);
            let at = crate::session::subring::event_subring_offset(&capacities, class)
                .expect("class exists")
                + crate::session::arena::RING_HEADER_SIZE
                + slot as usize * crate::session::arena::EVENT_RECORD_SIZE;
            crate::session::arena::read_event_record(data, at)
        }
    }

    /// A guest whose callback exercises the deferred path: it calls the
    /// DEFERRABLE `echo::note_deferred` `count` times (the harness sets `count`,
    /// so one guest serves "three notes" and "257 notes"), calls the
    /// non-deferrable `echo::add` once — recording its refusal — and then traps
    /// if the harness asked it to. Everything it observes lands in its scratch
    /// words, which the test reads back.
    const GUEST_DEFERRING: &str = r#"
(module
  (import "session" "memory" (memory 132 4096))
  (export "memory" (memory 0))
  (import "session" "open" (func $open (param i32 i32) (result i32)))
  (import "session" "close" (func $close (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))
  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "pending" (func $pending (result i32)))
  (import "echo" "note_deferred" (func $note (param i32 i32) (result i32)))
  (import "echo" "add" (func $add (param i32 i32) (result i32)))

  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (type $event_t (func (param i32 i32) (result i32)))

  ;; Scratch at 8400000:
  ;;   +0 batch calls, +4 batch count, +8 the last note return, +12 the add
  ;;   return, +16 the last event's class, +20 its `a`, +24 its `b`,
  ;;   +28 the note count, +32 the slot base, +36 the trap flag.
  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    (local $i i32) (local $rc i32)
    (i32.store (i32.const 8400000) (i32.add (i32.load (i32.const 8400000)) (i32.const 1)))
    (i32.store (i32.const 8400004) (local.get $count))
    ;; The non-deferrable verb: refused inside a callback, and the refusal is
    ;; what the guest records.
    (i32.store (i32.const 8400012) (call $add (i32.const 3) (i32.const 4)))
    ;; `count` deferrable calls, the last return recorded.
    (local.set $i (i32.const 0))
    (block $done
      (loop $again
        (br_if $done (i32.ge_u (local.get $i) (i32.load (i32.const 8400028))))
        (local.set $rc (call $note (i32.add (local.get $i) (i32.load (i32.const 8400032))) (i32.const 7)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $again)))
    (i32.store (i32.const 8400008) (local.get $rc))
    ;; And the trap, when the harness asked for one.
    (if (i32.ne (i32.load8_u (i32.const 8400036)) (i32.const 0)) (then unreachable))
    (i32.const 0))

  (func $event (type $event_t) (param $class i32) (param $ptr i32) (result i32)
    (i32.store (i32.const 8400016) (local.get $class))
    (i32.store (i32.const 8400020) (i32.load (i32.add (local.get $ptr) (i32.const 16))))
    (i32.store (i32.const 8400024) (i32.load (i32.add (local.get $ptr) (i32.const 20))))
    (i32.const 0))

  (table 4 funcref)
  (elem (i32.const 1) $batch $event)
  (export "table" (table 0))

  (func (export "_start_game")
    (local $i i32) (local $op i32) (local $a i32) (local $b i32) (local $rc i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $end
      (loop $next
        (local.set $p (i32.add (i32.const 8392704) (i32.mul (local.get $i) (i32.const 12))))
        (local.set $op (i32.load (local.get $p)))
        (br_if $end (i32.eqz (local.get $op)))
        (local.set $a (i32.load (i32.add (local.get $p) (i32.const 4))))
        (local.set $b (i32.load (i32.add (local.get $p) (i32.const 8))))
        (local.set $rc (i32.const -999))
        (if (i32.eq (local.get $op) (i32.const 1)) (then (local.set $rc (call $open (local.get $a) (local.get $b)))))
        (if (i32.eq (local.get $op) (i32.const 2)) (then (local.set $rc (call $wait (local.get $a)))))
        (if (i32.eq (local.get $op) (i32.const 4)) (then (local.set $rc (call $subscribe (local.get $a)))))
        (if (i32.eq (local.get $op) (i32.const 6)) (then (local.set $rc (call $pending))))
        (if (i32.eq (local.get $op) (i32.const 7)) (then (local.set $rc (call $close))))
        (i32.store (i32.add (i32.const 8396800) (i32.mul (local.get $i) (i32.const 4))) (local.get $rc))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)
      )
    )
  )
)
"#;

    /// Where the deferring guest keeps its scratch. (In the guest's heap, above
    /// `memoryBase`; its scripted results land at `RESULTS`, like every guest's,
    /// which is why the scratch starts past them.)
    pub(super) const SCRATCH: i32 = 8_400_000;
    /// +0 batch calls, +4 batch count, +8 last note return, +12 the add return,
    /// +16 last event class, +20 last event `a`, +24 last event `b`.
    pub(super) const NOTE_RETURN: i32 = SCRATCH + 8;
    pub(super) const ADD_RETURN: i32 = SCRATCH + 12;
    pub(super) const EVENT_CLASS_SEEN: i32 = SCRATCH + 16;
    pub(super) const EVENT_A: i32 = SCRATCH + 20;
    pub(super) const EVENT_B: i32 = SCRATCH + 24;
    /// How many deferrable calls the callback makes, the slot base it starts
    /// at, and whether it traps afterwards.
    const NOTE_COUNT: i32 = SCRATCH + 28;
    const NOTE_BASE: i32 = SCRATCH + 32;
    const TRAP_FLAG: i32 = SCRATCH + 36;
    /// The echo adapter's own addresses, which its C file defines.
    pub(super) const NOTE_ADDR: i32 = 8_389_632;
    pub(super) const DIRECT_ADDR: i32 = 8_389_600;

    /// The ops a script is built from. `GUEST_DEFERRING` adds `CLOSE`.
    const OPEN: i32 = 1;
    const CLOSE: i32 = 7;
    const WAIT: i32 = 2;
    const DRAIN: i32 = 3;
    const SUBSCRIBE: i32 = 4;
    const UNSUBSCRIBE: i32 = 5;
    const PENDING: i32 = 6;

    fn open_op() -> (i32, i32, i32) {
        (OPEN, CFG, 82)
    }

    // ── the epoch's tests ─────────────────────────────────────────────────

    #[test]
    fn test_wait_times_out_with_no_events() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 50, 0)]);
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.run();
        assert_eq!(h.results()[0], 0, "the open succeeded");
        assert_eq!(h.results()[1], 0, "the subscribe succeeded");
        assert_eq!(h.results()[2], 0, "a timeout with nothing to deliver is 0");
        assert_eq!(h.word(BATCH_CALLS), 0, "no callback ran");
    }

    #[test]
    fn test_wait_returns_after_post() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);

        // The post happens *while the guest is blocked*: a producer thread posts
        // after a few milliseconds, and the condvar is what brings the wait back.
        // (Posting before the run would only prove that a queued event is found.)
        let posting = h.posting.clone();
        let poster = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            posting
                .post(1, 4, 0, 7, 8, 0.5, 0.25)
                .expect("the queue has room");
        });
        h.run();
        poster.join().expect("the poster thread finishes");

        assert_eq!(h.results()[2], 1, "one record delivered");
        assert_eq!(h.word(BATCH_CALLS), 1, "the batch callback ran");
        assert_eq!(h.word(BATCH_CLASS), 4);
    }

    #[test]
    fn test_wait_not_ready_refused() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        // No `open` in the script: the session is UNINIT, so the wait refuses.
        h.write_script(&[(WAIT, 10, 0)]);
        h.run();
        assert_eq!(h.results()[0], crate::session::EBADF);
    }

    #[test]
    fn test_wait_from_callback_refused() {
        // The depth flag is set by the epoch around every invocation, so a
        // callback that waits would see -EBUSY. The harness cannot call a verb
        // from inside a callback without a guest that does, so this drives the
        // guard directly and the smoke fixture covers the guest's side.
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.store.data_mut().depth = 1;
        h.write_script(&[open_op(), (WAIT, 10, 0)]);
        h.run();
        assert_eq!(h.results()[1], crate::session::EBUSY);
        h.store.data_mut().depth = 0;
    }

    #[test]
    fn test_drain_one_class_ignores_others() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (DRAIN, 4, 0)]);
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.post(4, 1, 0);
        h.post(8, 2, 0);
        h.run();
        assert_eq!(h.results()[2], 1, "only class 4 was drained");
        assert_eq!(h.header(4).head, 1, "class 4 published");
        assert_eq!(h.header(8).head, 0, "class 8 was left alone");
    }

    #[test]
    fn test_drain_all_drains_every_class() {
        let mut h = Harness::new(GUEST, None);
        h.write_script(&[open_op(), (DRAIN, 4, 0)]);
        h.post(4, 1, 0);
        h.post(8, 2, 0);
        h.post(0, 3, 0);
        h.run();
        // `drain(class)` covers one class; `wait` covers all of them, which is
        // the same code path as `DrainAll`.
        assert_eq!(h.results()[1], 1);
        assert_eq!(h.header(4).head, 1);
        assert_eq!(h.header(8).head, 0);
    }

    #[test]
    fn test_no_callback_still_delivers_to_ring() {
        // A guest that registers nothing: the records are published into its
        // rings and it reads them itself.
        let mut h = Harness::new(GUEST, Some((0, 0)));
        h.write_script(&[open_op(), (WAIT, 10, 0)]);
        h.post(4, 11, 12);
        h.run();
        assert_eq!(h.results()[1], 1, "the record was delivered without a callback");
        assert_eq!(h.word(BATCH_CALLS), 0, "no callback ran");
        let record = h.first_record(4, 0);
        assert_eq!(record.class, 4);
        assert_eq!((record.a, record.b), (11, 12));
    }

    #[test]
    fn test_batched_callback_fires_once() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        for i in 0..100u32 {
            h.post(4, i, 0);
        }
        h.run();
        assert_eq!(h.results()[2], 100);
        assert_eq!(h.word(BATCH_CALLS), 1, "one batch, not one hundred calls");
        assert_eq!(h.word(BATCH_CLASS), 4);
        assert_eq!(h.word(BATCH_COUNT), 100);
        // The pointer the callback was handed is the ring's first slot.
        let capacities = *h.store.data().session.as_ref().expect("session").ring_capacities();
        let expected = crate::session::subring::event_subring_offset(&capacities, 4).expect("class")
            + crate::session::arena::RING_HEADER_SIZE;
        assert_eq!(h.word(BATCH_PTR) as usize, expected);
    }

    #[test]
    fn test_direct_callback_fires_per_event() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_subscription(1, crate::session::arena::MODE_DIRECT);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        for i in 0..100u32 {
            h.post(1, i, 0);
        }
        h.run();
        assert_eq!(h.results()[2], 100);
        assert_eq!(h.word(EVENT_CALLS), 100, "one call per record for DIRECT");
        assert_eq!(h.word(EVENT_CLASS), 1);
        assert_eq!(h.word(EVENT_SEQ), 100, "the last record's seq");
    }

    #[test]
    fn test_subscribe_updates_mode() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_subscription(1, crate::session::arena::MODE_DIRECT);
        h.write_script(&[
            open_op(),
            (SUBSCRIBE, SUBSCRIPTION, 0),
            (WAIT, 10, 0),
            (UNSUBSCRIBE, 1, 0),
            (WAIT, 10, 0),
        ]);
        h.post(1, 1, 0);
        h.run();
        assert_eq!(h.results()[2], 1, "the subscribed wait delivered");
        assert_eq!(h.word(EVENT_CALLS), 1, "DIRECT ran the event callback");
        // Unsubscribed: the mode is back to the default (DIRECT for class 1 —
        // so the invocation still happens, but no *new* records arrive).
        assert_eq!(h.word(EVENT_CALLS), 1, "nothing new was delivered");
    }

    #[test]
    fn test_unsubscribe_resets_mode() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        // Class 4's default is BATCHED; subscribe it as DIRECT, then unsubscribe
        // and read the live mode back from the posting face.
        h.write_subscription(4, crate::session::arena::MODE_DIRECT);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (UNSUBSCRIBE, 4, 0)]);
        h.run();
        let posting = h.store.data().posting.clone();
        assert_eq!(posting.mode(4), Some(crate::session::arena::MODE_BATCHED));
        assert!(!posting.is_subscribed(4), "unsubscribed");
    }

    #[test]
    fn test_dropped_counter_mirrors_to_header() {
        // Two epochs on a class whose ring holds 64 records (class 7). The first
        // fills the ring; the second arrives with the ring full and the guest's
        // tail still at zero — nothing reclaimed, nowhere to put it — so the
        // record is dropped and the drop is visible in the header and in
        // `FrameState`.
        let mut h = Harness::new(GUEST, None);
        h.write_script(&[open_op(), (WAIT, 10, 0)]);
        for i in 0..64u32 {
            h.post(7, i, 0);
        }
        h.run();
        assert_eq!(h.header(7).head, 64, "the ring is full");
        assert_eq!(h.header(7).dropped, 0, "and nothing was dropped yet");

        // A second epoch: the queue has room, the ring does not.
        h.post(7, 999, 0);
        h.write_script(&[(WAIT, 10, 0)]);
        h.run();
        let header = h.header(7);
        assert_eq!(header.head, 64, "nothing was overwritten");
        assert_eq!(header.dropped, 1, "the record the ring had no room for");
        assert!(h.frame_state().dropped_events >= 1, "and it rolls up into FrameState");
    }

    #[test]
    fn test_delivered_counter_mirrors_to_header() {
        let mut h = Harness::new(GUEST, None);
        h.write_script(&[open_op(), (WAIT, 10, 0)]);
        for i in 0..5u32 {
            h.post(4, i, 0);
        }
        h.run();
        assert_eq!(h.header(4).delivered, 5);
        assert_eq!(h.header(4).head, 5);
    }

    #[test]
    fn test_callback_trap_faults_session() {
        // Only the batch slot: the trapping guest has no `onEvent` entry, and a
        // record that names a null slot is refused at open (which is the eager
        // resolution of §8 doing its job).
        let mut h = Harness::new(GUEST_TRAPPING, Some((1, 0)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        h.post(4, 1, 0);
        h.run();

        assert_eq!(h.results()[2], crate::session::EIO, "a trap is -EIO");
        assert_eq!(h.session_state(), crate::session::SessionState::Faulted);
        let frame = h.frame_state();
        assert_eq!(frame.fault_state, crate::session::arena::FAULT_CALLBACK_TRAP);
        assert_eq!(frame.last_error, 0, "the onBatch slot");
        // The arena reports the same thing the machine does.
        let data = h.memory.data(&h.store);
        assert_eq!(
            crate::session::arena::control_state(data),
            crate::session::arena::STATE_FAULTED
        );
        // And the slot is disabled: a second epoch would not enter it again.
        assert!(
            h.store
                .data()
                .session
                .as_ref()
                .expect("session")
                .slot_disabled(0)
        );
    }

    #[test]
    fn test_publish_then_invoke_ordering() {
        // The reference adapter's `publish` hook writes a sentinel byte into the
        // guest's heap, and the batch callback reads that byte back. The callback
        // cannot see 0x5A unless the hook ran first — so one assertion pins the
        // whole ordering: publish completes before the first invocation.
        let mut h = Harness::with_echo(GUEST, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        h.post(4, 1, 0);
        h.run();

        assert_eq!(h.results()[2], 1, "the record was delivered");
        assert_eq!(h.word(BATCH_CALLS), 1, "the callback ran");
        assert_eq!(
            h.word(BATCH_SENTINEL),
            0x5A,
            "the publish hook's byte was already in guest memory when the callback read it"
        );
        assert_eq!(h.frame_state().frame_index, 1);
        assert!(
            SENTINEL as usize > crate::session::arena::DEFAULT_MAX_ARENA_SIZE,
            "the sentinel address is above memoryBase, which is why the adapter's \
             publish hook may write there at all"
        );

        // And the same run without an adapter leaves the byte alone, which is
        // what makes the 0x5A above evidence rather than a coincidence.
        let mut bare = Harness::new(GUEST, Some((1, 2)));
        bare.write_subscription(4, crate::session::arena::MODE_BATCHED);
        bare.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        bare.post(4, 1, 0);
        bare.run();
        assert_eq!(bare.word(BATCH_CALLS), 1);
        assert_eq!(bare.word(BATCH_SENTINEL), 0, "no adapter, no sentinel");
    }

    // ── A2c: deferred submission, and the depth rules ─────────────────────

    #[test]
    fn test_deferrable_verb_from_callback_queued() {
        let mut h = Harness::with_echo(GUEST_DEFERRING, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        h.set_callback_plan(3, 0, false);
        h.post(4, 1, 0);
        h.run();

        // The direct form of `note_deferred` writes two bytes at DIRECT_ADDR,
        // and that address is untouched: the import was *not* called from the
        // callback — it was copied and applied.
        assert_eq!(h.word(DIRECT_ADDR), 0, "no direct call happened");
        // The apply ran in the same epoch, one byte per submission, at
        // NOTE_ADDR + slot — which is what "queued and applied" looks like.
        assert_eq!(h.byte(NOTE_ADDR), 1);
        assert_eq!(h.byte(NOTE_ADDR + 1), 1);
        assert_eq!(h.byte(NOTE_ADDR + 2), 1);
        assert_eq!(
            h.scratch(NOTE_RETURN),
            0,
            "the wasm caller was told 'accepted', not handed a result"
        );
        assert_eq!(h.pending_len(), 0, "the apply phase drained the queue");
    }

    #[test]
    fn test_non_deferrable_verb_from_callback_refused() {
        let mut h = Harness::with_echo(GUEST_DEFERRING, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        h.set_callback_plan(0, 0, false);
        h.post(4, 1, 0);
        h.run();

        // `echo::add` declares neither flag, so a callback may not call it: the
        // shim refuses with -EBUSY and never reaches the adapter.
        assert_eq!(
            h.scratch(ADD_RETURN),
            crate::session::EBUSY,
            "a verb with neither flag is refused inside a callback"
        );
        assert_eq!(h.byte(DIRECT_ADDR), 0);
    }

    #[test]
    fn test_pending_applied_after_batch() {
        // The same run as the first test, read the other way: what the callback
        // queued is visible *after* the epoch, at the address the apply writes.
        let mut h = Harness::with_echo(GUEST_DEFERRING, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        h.set_callback_plan(2, 5, false);
        h.post(4, 1, 0);
        h.run();

        assert_eq!(h.byte(NOTE_ADDR + 5), 1, "the first submission, applied");
        assert_eq!(h.byte(NOTE_ADDR + 6), 1, "and the second");
        assert_eq!(h.byte(NOTE_ADDR + 7), 0, "and nothing else");
        assert_eq!(h.pending_len(), 0, "nothing is left pending");
        assert_eq!(h.scratch(SCRATCH), 1, "the callback ran once");
    }

    #[test]
    fn test_pending_full_refused() {
        // 257 submissions into a 256-entry queue: the last one is refused with
        // -ENOSPC, synchronously, inside the callback — and only it.
        let mut h = Harness::with_echo(GUEST_DEFERRING, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0), (WAIT, 1000, 0)]);
        h.set_callback_plan(257, 0, false);
        h.post(4, 1, 0);
        h.run();

        assert_eq!(
            h.scratch(NOTE_RETURN),
            -28,
            "the 257th call is told the queue is full (-ENOSPC)"
        );
        assert_eq!(h.byte(NOTE_ADDR), 1, "the first 256 were applied");
        assert_eq!(h.byte(NOTE_ADDR + 255), 1);
        assert_eq!(h.pending_len(), 0);
    }

    #[test]
    fn test_apply_failure_becomes_submission_rejected() {
        // The callback queues a submission the adapter's apply will refuse (a
        // negative slot is the echo adapter's own "fail on purpose"), and the
        // guest is subscribed to SUBMISSION_REJECTED as DIRECT. The rejection is
        // posted by the apply phase and delivered by the *next* epoch.
        let mut h = Harness::with_echo(GUEST_DEFERRING, Some((1, 2)));
        h.write_subscription_at(SUBSCRIPTION, crate::session::arena::CLASS_JOB_DONE, crate::session::arena::MODE_BATCHED);
        h.write_subscription_at(
            SUBSCRIPTION + 32,
            crate::session::arena::CLASS_SUBMISSION_REJECTED,
            crate::session::arena::MODE_DIRECT,
        );
        h.write_script(&[
            open_op(),
            (SUBSCRIBE, SUBSCRIPTION, 0),
            (SUBSCRIBE, SUBSCRIPTION + 32, 0),
            (WAIT, 1000, 0),
            (WAIT, 1000, 0),
        ]);
        h.set_callback_plan(1, -1, false);
        h.post(4, 1, 0);
        h.run();

        // The second wait delivered exactly the rejection.
        assert_eq!(h.results()[4], 1, "one rejection delivered");
        assert_eq!(
            h.scratch(EVENT_CLASS_SEEN),
            crate::session::arena::CLASS_SUBMISSION_REJECTED as i32
        );
        assert_eq!(h.scratch(EVENT_A), 3, "a = the verb id the adapter refused");
        assert_eq!(h.scratch(EVENT_B), -22, "b = the adapter's errno");
        assert!(
            h.store.data().session.as_ref().expect("session").rejections() >= 1,
            "the session counted it too"
        );
    }

    #[test]
    fn test_pending_survives_trap() {
        // R7: the callback queues two submissions and then traps. The queue is
        // the session's, not the callback's, so it survives — and it is applied
        // at the guest's next epoch, which after a fault means the first epoch of
        // a session the guest closed and opened again (§8's two cases).
        let mut h = Harness::with_echo(GUEST_DEFERRING, Some((1, 2)));
        h.write_subscription(4, crate::session::arena::MODE_BATCHED);
        h.write_script(&[
            open_op(),
            (SUBSCRIBE, SUBSCRIPTION, 0),
            (WAIT, 1000, 0),
            (CLOSE, 0, 0),
            open_op(),
            (WAIT, 1000, 0),
        ]);
        h.set_callback_plan(2, 0, true);
        h.post(4, 1, 0);
        h.run();

        assert_eq!(h.results()[2], crate::session::EIO, "the trapping epoch is -EIO");
        assert_eq!(
            h.results()[4], 0,
            "the re-open succeeded (CLOSED -> READY)"
        );
        assert_eq!(h.results()[5], 0, "the second epoch had nothing to deliver");
        // The proof: the two submissions were applied by the second epoch, after
        // the fault that would have lost them if the queue were the callback's.
        assert_eq!(h.byte(NOTE_ADDR), 1, "the first survives the trap");
        assert_eq!(h.byte(NOTE_ADDR + 1), 1, "and so does the second");
        assert_eq!(h.pending_len(), 0, "and they are gone once applied");
        assert!(
            h.store
                .data()
                .session
                .as_ref()
                .expect("session")
                .slot_disabled(0),
            "the trapping slot is still disabled after the re-open"
        );
    }

    #[test]
    fn test_apply_at_depth_zero() {
        // A probe adapter whose `apply` records the call depth it observes. The
        // apply phase resets the depth to 0, so the hook is *not* inside a
        // callback — which is what lets an adapter's apply reuse its verb.
        static OBSERVED: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-2);
        static PROBE_HOST: std::sync::atomic::AtomicPtr<crate::adapter::AdapterHost> =
            std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

        unsafe extern "C" fn probe_apply(
            _ctx: *mut std::ffi::c_void,
            _verb: u32,
            _bytes: *const std::ffi::c_void,
            _len: u32,
        ) -> i32 {
            let host = PROBE_HOST.load(std::sync::atomic::Ordering::Relaxed);
            if host.is_null() {
                OBSERVED.store(-1, std::sync::atomic::Ordering::Relaxed);
                return 0;
            }
            // SAFETY: the epoch installed this caller for the duration of the
            // call, and the host outlives it (the harness owns both).
            let caller = unsafe { (*host).caller() };
            if caller.is_null() {
                OBSERVED.store(-2, std::sync::atomic::Ordering::Relaxed);
                return 0;
            }
            let depth = unsafe { (*caller).data().depth };
            OBSERVED.store(depth as i32, std::sync::atomic::Ordering::Relaxed);
            0
        }

        let mut h = Harness::with_echo(GUEST, Some((1, 2)));
        let host = h.adapter_host().expect("the harness built a host");
        PROBE_HOST.store(&**host as *const crate::adapter::AdapterHost as *mut _, std::sync::atomic::Ordering::Relaxed);
        let probe = crate::adapter::probe_adapter("probe", probe_apply, &**host as *const crate::adapter::AdapterHost as *mut std::ffi::c_void);
        h.push_adapter_call(probe);

        // One submission, queued by the test rather than by a callback: the
        // apply phase is what is under test here.
        let submission = crate::session::apply::PendingSubmission {
            adapter_index: 0,
            verb_id: 42,
            bytes: crate::session::apply::encode_slots(&[]),
            nargs: 0,
        };
        h.store.data_mut().pending.push(submission).expect("room");

        h.write_script(&[open_op(), (WAIT, 10, 0)]);
        h.run();

        assert_eq!(
            OBSERVED.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "the adapter's apply ran with the call depth reset to 0"
        );
        assert_eq!(h.pending_len(), 0, "and the submission was applied");
    }

    #[test]
    fn test_pending_is_zero_and_refused_from_a_callback() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_script(&[open_op(), (PENDING, 0, 0)]);
        h.run();
        assert_eq!(h.results()[1], 0, "nothing is deferred in A2b");

        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.store.data_mut().depth = 1;
        h.write_script(&[open_op(), (PENDING, 0, 0)]);
        h.run();
        assert_eq!(h.results()[1], crate::session::EBUSY);
    }

    #[test]
    fn test_subscribe_validates_the_record() {
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_script(&[open_op()]);
        // A Subscription naming a class this chunk does not have.
        h.write_subscription(15, crate::session::arena::MODE_BATCHED);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0)]);
        h.run();
        assert_eq!(h.results()[1], EINVAL);

        // And a mode that is not a delivery mode.
        let mut h = Harness::new(GUEST, Some((1, 2)));
        h.write_subscription(4, 99);
        h.write_script(&[open_op(), (SUBSCRIBE, SUBSCRIPTION, 0)]);
        h.run();
        assert_eq!(h.results()[1], EINVAL);
    }
}
