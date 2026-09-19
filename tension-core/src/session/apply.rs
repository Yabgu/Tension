//! Deferred submission: the pending list a callback writes into, and the apply
//! phase that drains it (`DESIGN.md` §3.5, §9).
//!
//! A `queue_*` verb called from *inside* a callback cannot do its work there —
//! the callback is running in the middle of an epoch, the store is mid-borrow,
//! and a verb that wrote guest memory at that moment would be mutating state the
//! guest is still reading. So the session **copies** the arguments at the moment
//! of the call (the load-bearing detail: a `(verb, guest_ptr)` pair would be
//! re-read after arbitrary guest code had run) and applies them in the next
//! epoch's apply phase, which runs after every callback has returned.
//!
//! Two consequences the design leans on:
//!
//! - **A full queue is `-ENOSPC` to the wasm caller, synchronously, inside the
//!   callback** — a guest learns immediately that its submission did not land.
//! - **A trap does not clear the queue** (R7): the entries were copied before
//!   the callback ran, so they belong to the session; they survive the fault and
//!   are applied at the guest's next epoch.
//!
//! Nothing here is in the arena. The guest never reads the pending list; what it
//! sees is the effect of an apply, or a `SUBMISSION_REJECTED` delivery when one
//! fails.

use std::collections::VecDeque;

use wasmtime::Caller;

use super::arena;
use super::Session;
use crate::adapter::Slot;
use crate::HostState;

/// One submission the session will apply later: which adapter's verb, the
/// arguments exactly as the import received them, and how many there were.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSubmission {
    /// Which loaded adapter registered the verb — the index into the run's
    /// registration order, which is also the order `apply` hooks are called in.
    pub adapter_index: u32,
    /// The adapter's own verb id, which is what its `apply` switches on.
    pub verb_id: u32,
    /// The arguments, in the encoding [`encode_slots`] writes.
    pub bytes: Vec<u8>,
    /// How many argument slots `bytes` holds.
    pub nargs: u32,
}

/// The pending list. Bounded, FIFO, and deliberately not configurable in chunk 1.
#[derive(Debug)]
pub struct PendingQueue {
    entries: VecDeque<PendingSubmission>,
    capacity: u32,
}

impl Default for PendingQueue {
    fn default() -> PendingQueue {
        PendingQueue::new()
    }
}

impl PendingQueue {
    /// The bound a session starts with. It is per-session, not per-callback: a
    /// callback that queues more than this is told `-ENOSPC` and can decide what
    /// to drop. 256 is generous for the verbs chunk 1 has (a `queue_*` verb is
    /// one submission, not a batch) and small enough that a runaway callback
    /// cannot grow the host's heap without bound.
    pub const DEFAULT_CAPACITY: u32 = 256;

    pub fn new() -> PendingQueue {
        PendingQueue::with_capacity(PendingQueue::DEFAULT_CAPACITY)
    }

    pub fn with_capacity(capacity: u32) -> PendingQueue {
        PendingQueue {
            entries: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    /// Append one submission, or refuse because the queue is full.
    ///
    /// `Err(())` is the `-ENOSPC` the shim hands back to the wasm caller: the
    /// submission did not land, and nothing about it is remembered.
    pub fn push(&mut self, submission: PendingSubmission) -> Result<(), ()> {
        if self.entries.len() >= self.capacity as usize {
            return Err(());
        }
        self.entries.push_back(submission);
        Ok(())
    }

    /// Take everything pending, oldest first. The apply phase's entry point.
    pub fn drain(&mut self) -> std::collections::vec_deque::Drain<'_, PendingSubmission> {
        self.entries.drain(..)
    }

    /// How many submissions are waiting. What `session_pending` reports.
    pub fn len(&self) -> u32 {
        self.entries.len() as u32
    }

#[cfg_attr(not(test), allow(dead_code))] // tests assert emptiness; the apply phase itself only asks for `len()`
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn capacity(&self) -> u32 {
        self.capacity
    }
}

/// Serialize one import's arguments into the bytes an adapter's `apply` reads.
///
/// **The encoding is the `tension_value` array itself**: eight bytes per slot,
/// little-endian, in the order the import received them, with the payload in the
/// bytes that slot type uses and the rest zero. That is the same representation
/// `tension_import_fn` is handed, so an adapter's `apply` can cast the pointer to
/// `const tension_value *` and read it with the code its import already has —
/// one representation rather than two, and no type tags to keep in step with the
/// registration. An `i32` slot's upper four bytes are zero rather than
/// sign-extended, because the union's `i32` field is what the C reads.
pub fn encode_slots(slots: &[Slot]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(slots.len() * 8);
    for slot in slots {
        let word: u64 = match slot {
            Slot::I32(value) => u64::from(*value as u32),
            Slot::I64(value) => *value as u64,
            Slot::F32(bits) => u64::from(*bits),
            Slot::F64(bits) => *bits,
        };
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    bytes
}

/// What one apply phase did.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct ApplyReport {
    /// Submissions the adapter accepted (its `apply` returned 0).
    pub applied: u32,
    /// Submissions the adapter refused; each became a `SUBMISSION_REJECTED`.
    pub rejected: u32,
    /// Submissions dropped without being handed to an adapter (no such adapter,
    /// or an adapter with no `apply`).
    pub dropped: u32,
}

/// Apply everything the pending queue holds.
///
/// Called from the epoch, after the invoke phase. Each entry goes to the adapter
/// that registered its verb, through that adapter's `apply` hook, with the call
/// depth at 0 — so the hook may call the session's own accessors, and a verb's
/// normal implementation can be reused.
///
/// A refusal (a non-zero status) is not an error the guest sees synchronously:
/// the guest is not inside the call that would receive one. It becomes a
/// `SUBMISSION_REJECTED` event, posted now and delivered in the next epoch — the
/// class exists for exactly this second failure mode.
///
/// `apply` is a plain C function pointer, so "the hook panicked" is not
/// observable at this boundary: a Rust panic unwinds into `extern "C"` and
/// aborts, which no ABI can catch. What *is* observable is the status, and that
/// is what the rejection path handles.
pub fn apply_pending(
    session: &mut Session,
    caller: &mut Caller<'_, HostState>,
    adapters: &[crate::adapter::AdapterCall],
) -> ApplyReport {
    let entries: Vec<PendingSubmission> = caller.data_mut().pending.drain().collect();
    if entries.is_empty() {
        return ApplyReport::default();
    }

    let mut report = ApplyReport::default();
    for entry in entries {
        let Some(call) = adapters.get(entry.adapter_index as usize) else {
            super::log(&format!(
                "apply: submission for adapter {} dropped: no such adapter (verb {})",
                entry.adapter_index, entry.verb_id
            ));
            report.dropped += 1;
            continue;
        };
        // SAFETY: the vtable pointer comes from a library `main` keeps open for
        // the whole run, and the epoch runs inside that run.
        let apply = unsafe { (*call.vtable).apply };
        let Some(apply) = apply else {
            super::log(&format!(
                "apply: adapter `{}` has no apply hook, so verb {} was dropped",
                call.name, entry.verb_id
            ));
            report.dropped += 1;
            continue;
        };

        // Depth is 0 for the duration: the hook is not inside a callback, and a
        // verb it calls must behave as it does at the top level.
        let previous_depth = caller.data().depth;
        caller.data_mut().depth = 0;
        let status = {
            // The hook may write guest memory, so it runs with the caller
            // installed — the same mechanism an import call uses.
            let host = caller.data().posting.clone();
            let _ = &host;
            crate::adapter::with_publish_caller(caller, &call.api, || {
                // SAFETY: as above; the bytes are ours and outlive the call.
                unsafe {
                    apply(
                        std::ptr::null_mut(),
                        entry.verb_id,
                        entry.bytes.as_ptr() as *const std::ffi::c_void,
                        entry.bytes.len() as u32,
                    )
                }
            })
        };
        caller.data_mut().depth = previous_depth;

        if status == 0 {
            report.applied += 1;
            continue;
        }

        report.rejected += 1;
        session.note_rejection();
        super::log(&format!(
            "apply: adapter `{}` refused verb {} with {status}; a {} delivery follows",
            call.name,
            entry.verb_id,
            arena::class_name(arena::CLASS_SUBMISSION_REJECTED)
        ));
        let posting = caller.data().posting.clone();
        // The session posts as source 0: there is no adapter to attribute this
        // to — the session is reporting its own failure to apply, and the
        // adapter's own name is in the log line above.
        if let Err(error) = posting.post(
            0,
            arena::CLASS_SUBMISSION_REJECTED,
            0,
            entry.verb_id,
            status as u32,
            0.0,
            0.0,
        ) {
            super::log(&format!(
                "apply: SUBMISSION_REJECTED could not be posted: {error}"
            ));
        }
    }

    report
}

/// Sweep every in-flight job to `FAILED` with `-EIO`, in a fatal fault's publish
/// phase.
///
/// **A stub, and honest about it.** Chunk 1 has no job records: the capability
/// catalogue that defines them is deferred until the OGRE version pin
/// (`DESIGN.md` §5.1), so the job region holds nothing this function could
/// sweep. It exists where the fatal-fault path will call it, logs when it is
/// called with a fault, and reports zero jobs. Only the callback-trap path is
/// exercised in chunk 1; no adapter triggers a fatal fault yet.
pub fn sweep_jobs_to_failed(_arena_bytes: &mut [u8], reason: i32) -> u32 {
    super::log(&format!(
        "fatal fault ({reason}): sweeping in-flight jobs (chunk 1 has no job records, so \
         there is nothing to sweep)"
    ));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submission(verb_id: u32) -> PendingSubmission {
        PendingSubmission {
            adapter_index: 0,
            verb_id,
            bytes: vec![1, 0, 0, 0, 0, 0, 0, 0],
            nargs: 1,
        }
    }

    #[test]
    fn the_queue_is_fifo_and_bounded() {
        let mut queue = PendingQueue::with_capacity(2);
        assert!(queue.is_empty());
        assert_eq!(queue.capacity(), 2);
        queue.push(submission(1)).expect("room");
        queue.push(submission(2)).expect("room");
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.push(submission(3)), Err(()), "full");

        let drained: Vec<u32> = queue.drain().map(|entry| entry.verb_id).collect();
        assert_eq!(drained, vec![1, 2], "oldest first");
        assert!(queue.is_empty(), "draining empties it");
        queue.push(submission(4)).expect("room again");
    }

    #[test]
    fn the_default_capacity_is_256() {
        assert_eq!(PendingQueue::new().capacity(), PendingQueue::DEFAULT_CAPACITY);
        assert_eq!(PendingQueue::DEFAULT_CAPACITY, 256);
    }

    #[test]
    fn a_slot_encodes_as_the_union_the_adapter_reads() {
        // Eight bytes a slot, little-endian, payload in the bytes its type uses:
        // the same thing `tension_import_fn` is handed.
        let slots = [
            Slot::I32(-1),
            Slot::I64(-2),
            Slot::F32(1.5f32.to_bits()),
            Slot::F64((-2.25f64).to_bits()),
        ];
        let bytes = encode_slots(&slots);
        assert_eq!(bytes.len(), 32);

        let word = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().expect("eight"));
        assert_eq!(word(0), 0x0000_0000_FFFF_FFFF, "an i32 is its four bytes, rest zero");
        assert_eq!(word(8), (-2i64) as u64);
        assert_eq!(word(16), u64::from(1.5f32.to_bits()));
        assert_eq!(word(24), (-2.25f64).to_bits());
    }

    #[test]
    fn an_empty_slot_list_encodes_to_nothing() {
        assert!(encode_slots(&[]).is_empty());
    }
}
