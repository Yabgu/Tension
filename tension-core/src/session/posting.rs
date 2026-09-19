//! The posting face: the host side of an adapter's `post_event`, and the queues
//! the epoch (A2b) will drain into the arena.
//!
//! This module is the *other* side of `subring.rs`. An adapter thread calls
//! `post_event` — any thread, per `tension_adapter.h`'s rule 7 — and the record
//! lands here, in one bounded queue per class, with a globally monotonic
//! sequence number attached. Nothing here touches guest memory: the arena is
//! only written when the guest thread drains a queue during the epoch
//! (`subring::flush_class_to_ring`). That split is the whole point of the
//! posting side existing as its own type: it is `Sync`, it is cheap, and it can
//! be called from a render thread without any of the session's machinery.
//!
//! Everything here is interior-mutability based — a `Mutex` per queue and atomics
//! for the counters — so `&PostingSide` is all a producer needs, and so is all
//! the epoch needs.

// The epoch (A2b) is the other caller of this module: it drains the queues
// and flips subscriptions. The shims that are live today are `post`,
// `class_capacity`, `is_subscribed` and `queue`; the rest is A2b's, so the
// unused-in-the-run lint is off here until then.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::arena::{self, CLASS_COUNT};

/// What a producer hands over: the payload of one event, before the arena gives
/// it a home. `seq` is assigned by [`PostingSide::post`]; `source_id` is the id
/// `register_source` returned and is kept as host-side provenance — the 32-byte
/// `EventRecord` has no room for it, and needs none, since it belongs to the
/// host's bookkeeping rather than to the guest's view.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct EventFields {
    pub seq: u64,
    pub source_id: u32,
    pub flags: u32,
    pub a: u32,
    pub b: u32,
    pub f0: f32,
    pub f1: f32,
}

/// A refusal from the posting face. The errno is the one the header documents
/// for `post_event`: `-ENOSPC` when a class queue is full (the producer may
/// throttle), `-EINVAL` for an unknown class or source.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PostError {
    /// The class's queue is full. Never blocks, never overwrites: the caller
    /// decides whether to retry.
    QueueFull { class: u32 },
    /// No such class in this chunk.
    UnknownClass { class: u32 },
    /// No such event source — the id was never returned by `register_source`.
    UnknownSource { source: u32 },
}

impl PostError {
    /// The errno this refusal crosses the ABI with.
    pub fn errno(&self) -> i32 {
        match self {
            PostError::QueueFull { .. } => ENOSPC,
            PostError::UnknownClass { .. } | PostError::UnknownSource { .. } => EINVAL,
        }
    }
}

impl std::fmt::Display for PostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PostError::QueueFull { class } => {
                write!(f, "class {class}'s queue is full: the event was not queued")
            }
            PostError::UnknownClass { class } => {
                write!(f, "class {class} does not exist: this chunk has 0-{}", CLASS_COUNT - 1)
            }
            PostError::UnknownSource { source } => {
                write!(f, "event source {source} was never registered")
            }
        }
    }
}

/// `-EINVAL` and `-ENOSPC` at this boundary; declared here rather than imported
/// from `session` so the posting face reads on its own. The values are the
/// header's (`tension_adapter.h` A.7).
const EINVAL: i32 = -22;
const ENOSPC: i32 = -28;

/// One class's queue: bounded, MPSC (a `Mutex<VecDeque>`), with the two counters
/// a producer and the epoch both want to see.
///
/// The counters are **host-side on purpose** and are the authoritative ones: the
/// sub-ring's 32-byte header has `dropped`/`delivered` fields, but the guest's
/// real answer is `FrameState.droppedEvents`, and the session writes that rollup
/// in the epoch's publish phase (A2b). Keeping the live counters here means the
/// sub-ring header is never a second home for a number the host is still
/// changing.
#[derive(Debug)]
pub struct ClassQueue {
    class: u32,
    capacity: u32,
    events: Mutex<VecDeque<EventFields>>,
    dropped: AtomicU64,
    delivered: AtomicU64,
}

impl ClassQueue {
    fn new(class: u32, capacity: u32) -> ClassQueue {
        ClassQueue {
            class,
            capacity: capacity.max(1),
            events: Mutex::new(VecDeque::new()),
            dropped: AtomicU64::new(0),
            delivered: AtomicU64::new(0),
        }
    }

    /// The class this queue serves.
    pub fn class(&self) -> u32 {
        self.class
    }

    /// How many events the queue holds before it stops accepting them.
    pub fn capacity(&self) -> u32 {
        self.capacity
    }

    /// How many events are waiting.
    pub fn len(&self) -> usize {
        self.events.lock().expect("the queue mutex is never poisoned").len()
    }

    /// Whether nothing is waiting. The epoch asks this before doing any work.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Append one event under the queue's own lock, taking its sequence number
    /// there too.
    ///
    /// **The sequence number is assigned inside the lock, and that is
    /// load-bearing.** Two producers can reach the counter in one order and the
    /// queue in the other — producer A takes seq 1, producer B takes seq 2, B
    /// gets the lock first — which would leave the queue holding `[2, 1]` and
    /// break the design's "within a class, `seq` ascending" (§3.3). Assigning
    /// the number while the queue is locked makes the lock the authority on
    /// order, which is the only thing that can order two racing threads.
    ///
    /// A full queue is refused *before* the counter is touched, so a refused
    /// post consumes no sequence number: `seq` has no gaps from refusals.
    pub fn push_sequenced(
        &self,
        next_seq: &AtomicU64,
        mut fields: EventFields,
    ) -> Result<u64, PostError> {
        let mut events = self.events.lock().expect("the queue mutex is never poisoned");
        if events.len() >= self.capacity as usize {
            drop(events);
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return Err(PostError::QueueFull { class: self.class });
        }
        // 1-based, like every other id in this repo: seq 0 is "unset", so a
        // record that never got one cannot be mistaken for the first event.
        let seq = next_seq.fetch_add(1, Ordering::Relaxed) + 1;
        fields.seq = seq;
        events.push_back(fields);
        Ok(seq)
    }

    /// Take everything waiting, in post order. The epoch's entry point.
    pub fn drain(&self) -> Vec<EventFields> {
        let mut events = self.events.lock().expect("the queue mutex is never poisoned");
        events.drain(..).collect()
    }

    /// Record what one flush did with what it drained.
    pub fn note_flushed(&self, delivered: u32, dropped: u32) {
        if delivered > 0 {
            self.delivered.fetch_add(delivered as u64, Ordering::Relaxed);
        }
        if dropped > 0 {
            self.dropped.fetch_add(dropped as u64, Ordering::Relaxed);
        }
    }

    /// Events this class refused because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Events this class handed to the arena.
    pub fn delivered(&self) -> u64 {
        self.delivered.load(Ordering::Relaxed)
    }
}

/// What wakes a blocked wait: the two states that are not "an event arrived".
///
/// A guest can block indefinitely in `session_wait` (a negative timeout), which
/// is only safe because *something* always wakes it: an event, a fault, or a
/// shutdown. The flags live beside the condvar so the check and the wait are
/// one critical section — a producer that signals between a waiter's check and
/// its block would otherwise lose the wakeup.
#[derive(Debug, Default)]
pub struct WaitState {
    /// A fault is waiting to be delivered (A2c's trap policy sets this).
    pub pending_faults: bool,
    /// The session is closing: stop waiting, deliver nothing.
    pub shutdown: bool,
}

/// Why a wait returned.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    /// At least one class queue has an event.
    Events,
    /// The timeout expired with nothing to publish.
    TimedOut,
    /// A fault or a shutdown was signalled.
    WokenWithNothing,
}

/// The session's posting face: ten class queues, the sequence counter they
/// share, and the signal a blocked `session_wait` sleeps on. `Sync`, cheap to
/// clone into an `Arc`, and the only thing an adapter thread needs to reach.
#[derive(Debug)]
pub struct PostingSide {
    queues: Vec<ClassQueue>,
    /// The next sequence number. Session-global, so a guest can order events
    /// across classes by `seq` (`DESIGN.md` §3.3).
    next_seq: AtomicU64,
    /// Whether a class has a subscriber: what `class_info` reports so a producer
    /// can skip generating events nobody asked for. `FRAME` starts off
    /// ("POLLED, off unless subscribed"); everything else starts on.
    subscribed: Vec<AtomicBool>,
    /// Each class's *live* delivery mode: its default until a guest's
    /// `session_subscribe` says otherwise, and back to the default when it
    /// unsubscribes.
    modes: Vec<AtomicU32>,
    /// The wait state and the condvar a blocked `session_wait` sleeps on.
    /// `Arc` so the wait verb can hold it while the store is borrowed elsewhere.
    wait: Arc<(Mutex<WaitState>, Condvar)>,
}

impl Default for PostingSide {
    fn default() -> PostingSide {
        PostingSide::new(arena::DEFAULT_RING_CAPACITIES)
    }
}

impl PostingSide {
    /// Build the posting face for a set of per-class capacities — normally
    /// `session_open`'s live capacities, so the queue and the ring it feeds
    /// agree on how much is enough.
    pub fn new(capacities: [u32; CLASS_COUNT]) -> PostingSide {
        let queues = capacities
            .iter()
            .enumerate()
            .map(|(class, capacity)| ClassQueue::new(class as u32, *capacity))
            .collect();
        let subscribed = (0..CLASS_COUNT)
            .map(|class| AtomicBool::new(arena::DEFAULT_CLASS_MODES[class] != arena::MODE_POLLED))
            .collect();
        let modes = arena::DEFAULT_CLASS_MODES.iter().map(|mode| AtomicU32::new(*mode)).collect();
        PostingSide {
            queues,
            next_seq: AtomicU64::new(0),
            subscribed,
            modes,
            wait: Arc::new((Mutex::new(WaitState::default()), Condvar::new())),
        }
    }

    // ── the wait side ─────────────────────────────────────────────────────

    /// Wake anyone blocked in [`PostingSide::wait_for_events`].
    ///
    /// The lock is taken *before* the notify, which is what closes the
    /// check-then-sleep race: a waiter holds this same lock while it looks at
    /// the queues, so a signal cannot slip in between its look and its sleep.
    pub fn signal_wake(&self) {
        let (state, condvar) = &*self.wait;
        let _guard = state.lock().expect("the wait mutex is never poisoned");
        condvar.notify_all();
    }

    /// Set the shutdown flag and wake anyone waiting: the session is closing,
    /// so a blocked `session_wait` must not be left holding the guest thread.
    pub fn set_shutdown(&self) {
        let (state, condvar) = &*self.wait;
        let mut state = state.lock().expect("the wait mutex is never poisoned");
        state.shutdown = true;
        condvar.notify_all();
    }

    /// Block until a class queue has an event, the timeout expires, or the wait
    /// state says to stop.
    ///
    /// `timeout_ms < 0` blocks indefinitely — safe because an event, a fault and
    /// a shutdown all signal; `0` never blocks.
    pub fn wait_for_events(&self, timeout_ms: i32) -> WaitOutcome {
        let (state, condvar) = &*self.wait;
        let deadline = match timeout_ms {
            ms if ms < 0 => None,
            ms => Some(Instant::now() + Duration::from_millis(ms as u64)),
        };
        let mut guard = state.lock().expect("the wait mutex is never poisoned");
        loop {
            if !self.pending_classes().is_empty() {
                return WaitOutcome::Events;
            }
            if guard.pending_faults || guard.shutdown {
                return WaitOutcome::WokenWithNothing;
            }
            match deadline {
                None => {
                    guard = condvar
                        .wait(guard)
                        .expect("the wait mutex is never poisoned");
                }
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return WaitOutcome::TimedOut;
                    }
                    let (next, _timeout) = condvar
                        .wait_timeout(guard, deadline - now)
                        .expect("the wait mutex is never poisoned");
                    guard = next;
                }
            }
        }
    }

    /// Set the fault flag and wake anyone waiting.
    ///
    /// This is what makes a blocking `session_wait` safe: a fault is one of the
    /// three things that bring it back (an event, a shutdown, a fault). No
    /// adapter triggers it in chunk 1 — the fatal-fault path is a stub — but the
    /// mechanism is here and tested.
    pub fn signal_fault(&self) {
        let (state, condvar) = &*self.wait;
        let mut state = state.lock().expect("the wait mutex is never poisoned");
        state.pending_faults = true;
        condvar.notify_all();
    }

    /// Clear it: an epoch that has delivered the fault resets it.
    pub fn clear_fault(&self) {
        let (state, _) = &*self.wait;
        state
            .lock()
            .expect("the wait mutex is never poisoned")
            .pending_faults = false;
    }

    /// Whether a fault is waiting to be delivered.
    pub fn has_pending_faults(&self) -> bool {
        let (state, _) = &*self.wait;
        state.lock().expect("the wait mutex is never poisoned").pending_faults
    }

    /// Clear the shutdown flag: a fresh `session_open` on a closed session.
    pub fn clear_shutdown(&self) {
        let (state, _) = &*self.wait;
        state.lock().expect("the wait mutex is never poisoned").shutdown = false;
    }

    /// Whether the session has been told to stop.
    pub fn is_shutdown(&self) -> bool {
        let (state, _) = &*self.wait;
        state.lock().expect("the wait mutex is never poisoned").shutdown
    }

    // ── modes and counters ────────────────────────────────────────────────

    /// A class's live delivery mode — its default, or what a subscription set.
    pub fn mode(&self, class_id: u32) -> Option<u32> {
        self.modes
            .get(class_id as usize)
            .map(|mode| mode.load(Ordering::Relaxed))
    }

    /// Set a class's mode and subscription in one step: what
    /// `session_subscribe` does, and what `session_unsubscribe` undoes.
    pub fn set_delivery(&self, class_id: u32, mode: u32, subscribed: bool) -> Result<(), PostError> {
        let Some(slot) = self.modes.get(class_id as usize) else {
            return Err(PostError::UnknownClass { class: class_id });
        };
        slot.store(mode, Ordering::Relaxed);
        self.subscribed[class_id as usize].store(subscribed, Ordering::Relaxed);
        Ok(())
    }

    /// The sum of every class's dropped counter: `FrameState.droppedEvents`.
    pub fn dropped_total(&self) -> u64 {
        self.queues.iter().map(|queue| queue.dropped()).sum()
    }

    /// Post one event: assign its sequence number, then queue it.
    ///
    /// Callable from any thread, never blocks on a full queue, and takes `&self`
    /// — interior mutability is what makes the render thread's call a plain
    /// function call rather than a scheduling decision.
    pub fn post(
        &self,
        source_id: u32,
        class_id: u32,
        flags: u32,
        a: u32,
        b: u32,
        f0: f32,
        f1: f32,
    ) -> Result<u64, PostError> {
        let Some(queue) = self.queues.get(class_id as usize) else {
            return Err(PostError::UnknownClass { class: class_id });
        };
        let seq = queue.push_sequenced(
            &self.next_seq,
            EventFields {
                seq: 0, // assigned under the queue's lock; see `push_sequenced`
                source_id,
                flags,
                a,
                b,
                f0,
                f1,
            },
        )?;
        // The push landed: wake a blocked wait. Signalling after the push means
        // a waiter that wakes either sees the event or blocks again — never the
        // reverse.
        self.signal_wake();
        Ok(seq)
    }

    /// The last sequence number handed out (0 before the first post).
    pub fn last_seq(&self) -> u64 {
        self.next_seq.load(Ordering::Relaxed)
    }

    /// A class's queue capacity, for `class_info`.
    pub fn class_capacity(&self, class_id: u32) -> Option<u32> {
        self.queues.get(class_id as usize).map(|queue| queue.capacity())
    }

    /// A class's queue, for the epoch's flush.
    pub fn queue(&self, class_id: u32) -> Option<&ClassQueue> {
        self.queues.get(class_id as usize)
    }

    /// Whether anyone wants this class's events, for `class_info`.
    pub fn is_subscribed(&self, class_id: u32) -> bool {
        self.subscribed
            .get(class_id as usize)
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    /// Subscribe or unsubscribe a class. There is no verb that reaches this yet
    /// — `session_subscribe` is A2b's — so today it exists for the tests and for
    /// that round.
    pub fn set_subscribed(&self, class_id: u32, on: bool) -> Result<(), PostError> {
        let Some(flag) = self.subscribed.get(class_id as usize) else {
            return Err(PostError::UnknownClass { class: class_id });
        };
        flag.store(on, Ordering::Relaxed);
        Ok(())
    }

    /// Every class with events waiting, ascending by class id — the order the
    /// epoch publishes in (§3.3).
    pub fn pending_classes(&self) -> Vec<u32> {
        self.queues
            .iter()
            .filter(|queue| !queue.is_empty())
            .map(|queue| queue.class())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A posting face whose classes all hold 4096 events: the multi-threaded test
    /// needs a queue big enough that nothing is refused by accident.
    fn wide() -> PostingSide {
        PostingSide::new([4096; CLASS_COUNT])
    }

    #[test]
    fn test_post_assigns_monotonic_seq() {
        let posting = wide();
        let first = posting.post(1, 8, 0, 1, 2, 0.0, 0.0).expect("queued");
        let second = posting.post(1, 8, 0, 3, 4, 0.0, 0.0).expect("queued");
        assert_eq!((first, second), (1, 2), "sequence numbers start at 1 and ascend");
        assert_eq!(posting.last_seq(), 2);

        let queue = posting.queue(8).expect("class 8");
        assert_eq!(queue.len(), 2);
        let drained = queue.drain();
        assert_eq!(drained[0].seq, 1);
        assert_eq!(drained[1].seq, 2);
        assert_eq!(drained[0].source_id, 1);
        assert_eq!((drained[1].a, drained[1].b), (3, 4));
    }

    #[test]
    fn test_post_from_multiple_threads() {
        let posting = Arc::new(wide());
        let mut threads = Vec::new();
        for _ in 0..4 {
            let posting = Arc::clone(&posting);
            threads.push(std::thread::spawn(move || {
                for i in 0..1000u32 {
                    posting
                        .post(1, 8, 0, i, 0, 0.0, 0.0)
                        .expect("the queue is wide enough");
                }
            }));
        }
        for thread in threads {
            thread.join().expect("no thread panics");
        }

        let queue = posting.queue(8).expect("class 8");
        assert_eq!(queue.len(), 4000, "every post landed");
        let mut seqs: Vec<u64> = queue.drain().iter().map(|fields| fields.seq).collect();
        assert_eq!(queue.dropped(), 0, "nothing was refused");
        seqs.sort_unstable();
        assert_eq!(seqs, (1..=4000).collect::<Vec<u64>>(), "1..=4000, each once");
    }

    #[test]
    fn test_post_full_queue_returns_err_and_counts_drop() {
        // Class 0's default capacity is 1: the smallest queue in the table, and
        // the one that makes "full" cheap to reach.
        let posting = PostingSide::default();
        assert!(posting.post(1, 0, 0, 0, 0, 0.0, 0.0).is_ok());
        let refused = posting.post(1, 0, 0, 0, 0, 0.0, 0.0).expect_err("full");
        assert_eq!(refused, PostError::QueueFull { class: 0 });
        assert_eq!(refused.errno(), ENOSPC);
        assert_eq!(posting.queue(0).expect("class 0").dropped(), 1);
        assert_eq!(posting.queue(0).expect("class 0").len(), 1, "nothing was overwritten");

        // A refused post consumes no sequence number: the ids that are handed
        // out are exactly the ids that were queued.
        assert_eq!(posting.last_seq(), 1);
    }

    #[test]
    fn test_post_unknown_class_refused() {
        let posting = PostingSide::default();
        let refused = posting.post(1, 15, 0, 0, 0, 0.0, 0.0).expect_err("no such class");
        assert_eq!(refused, PostError::UnknownClass { class: 15 });
        assert_eq!(refused.errno(), EINVAL);
        assert!(posting.class_capacity(15).is_none());
        assert!(posting.queue(15).is_none());
    }

    #[test]
    fn test_class_capacity_answers() {
        let posting = PostingSide::default();
        for (class, capacity) in arena::DEFAULT_RING_CAPACITIES.iter().enumerate() {
            assert_eq!(
                posting.class_capacity(class as u32),
                Some(*capacity),
                "class {class}"
            );
            assert_eq!(posting.queue(class as u32).expect("exists").capacity(), *capacity);
        }
        // A wide posting face reports its own numbers, not the table's.
        let wide = wide();
        assert_eq!(wide.class_capacity(0), Some(4096));
    }

    #[test]
    fn test_subscription_defaults_and_toggle() {
        let posting = PostingSide::default();
        // Everything is on except FRAME, which the design calls "off unless
        // subscribed".
        for class in 0..CLASS_COUNT as u32 {
            let expected = class != 9;
            assert_eq!(posting.is_subscribed(class), expected, "class {class}");
        }
        posting.set_subscribed(9, true).expect("FRAME can be subscribed");
        assert!(posting.is_subscribed(9));
        assert_eq!(
            posting.set_subscribed(99, true).expect_err("no such class"),
            PostError::UnknownClass { class: 99 }
        );
    }

    #[test]
    fn test_a_signalled_fault_wakes_a_blocked_wait() {
        // The fatal-fault path is a stub in chunk 1 — no adapter triggers it —
        // but the flag it sets is what makes a `session_wait` with a negative
        // timeout safe: an event, a shutdown and a fault all bring it back. This
        // is that mechanism, tested on its own.
        let posting = Arc::new(wide());
        let waiter = Arc::clone(&posting);
        let started = std::time::Instant::now();
        let handle = std::thread::spawn(move || {
            // Negative timeout: block until something says otherwise.
            waiter.wait_for_events(-1)
        });
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(posting.has_pending_faults() == false);
        posting.signal_fault();

        let outcome = handle.join().expect("the waiter finishes");
        assert_eq!(outcome, WaitOutcome::WokenWithNothing);
        assert!(posting.has_pending_faults());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "the fault woke the wait rather than letting it block forever"
        );
        posting.clear_fault();
        assert!(!posting.has_pending_faults());
    }

    #[test]
    fn test_pending_classes_are_ascending_and_only_non_empty() {
        let posting = wide();
        assert!(posting.pending_classes().is_empty());
        posting.post(1, 8, 0, 0, 0, 0.0, 0.0).expect("queued");
        posting.post(1, 4, 0, 0, 0, 0.0, 0.0).expect("queued");
        posting.post(1, 8, 0, 0, 0, 0.0, 0.0).expect("queued");
        assert_eq!(posting.pending_classes(), vec![4, 8]);
    }
}
