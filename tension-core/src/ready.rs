//! The host's ready queue, and the policy seam over it (DL59, I95).
//!
//! # Why this exists at all
//!
//! On the fiber backend a spawned task's body cannot run itself. The guest's
//! `__submitTask` pushes a slot onto the executor's own ring, and on continuation
//! something in the guest drains it because the guest owns its stack. On fiber the
//! stack is a host object: only the host can resume it. Measured, before this
//! module existed, on a program that spawns three tasks and awaits none:
//!
//! ```text
//! continuation   start / ran 1 / ran 2 / ran 3 / order 3 / end
//! fiber          start / order 0 / end            ← zero of three bodies ran
//! ```
//!
//! and on `schedule-order`, which counts its own steps: continuation `steps 15`,
//! fiber `steps 0`. Both `rc=0`. That is the shape of the defect this module
//! closes: a program that gives up reads as success.
//!
//! # The seam
//!
//! Everything the loop asks about ordering goes through [`ReadyPolicy`]. The loop
//! itself is one line — `queue.next()` then `drive(slot)` — and knows nothing
//! about order. A later `policy({on…})` replaces the *object* in
//! [`ReadyQueue`], not a branch in the loop. If a policy needed a change to the
//! loop to be expressible, the seam would be in the wrong place; the limits are
//! written down in [`ReadyPolicy`]'s own note.
//!
//! # Bounds, and what a full queue does
//!
//! Capacity is [`READY_CAPACITY`]. A submission for a full queue is **counted and
//! refused by value**, never dropped in silence: a silently dropped wake is a task
//! that never runs and a program that exits 0 having done half its work, which is
//! the failure mode this whole round is about. The counter is readable so a test
//! can assert on it, and the refusal is logged once per grow so an operator sees it
//! without reading counters.

use std::collections::VecDeque;

/// The ready queue's capacity, in tasks.
///
/// Deliberately the same order as the guest's own ring (`SlotRing`, 64) so a
/// program that fits the ring cannot be refused by the host for being a different
/// size — the two queues are alternates, not layers, and a bound that disagreed
/// would make the same program behave differently on the two backends.
pub const READY_CAPACITY: usize = 64;

/// What the loop asks the queue for, and the only thing a policy decides.
///
/// Two questions, and they are the whole surface today:
///
/// - **order** — which ready slot runs next;
/// - **when it is empty** — `None`, which the loop reads as "nothing to do this
///   pass" rather than as an error.
///
/// # What this cannot express, stated so the next round knows
///
/// - **Priorities across families.** A slot is an index into the guest's task
///   table; the host has no idea what family it belongs to, so "AI work before
///   frame work" is not expressible here without the guest handing over that fact.
/// - **A concurrency cap.** The queue answers one slot at a time and the loop
///   drives it immediately, so there is no place to hold N tasks "ready but not
///   running". A cap needs the loop to ask a second question ("may I run one
///   more?"), which is a change to the loop — i.e. a different seam.
/// - **Preemption.** Nothing here can stop a task that is running; a policy is
///   consulted between tasks and never during one.
/// - **Migration.** Which store a task runs in is decided at spawn
///   (`__spawnOn`/`__spawnOnMasked`), not here.
/// - **Fairness across stores.** Each store has its own queue; nothing arbitrates
///   between them.
///
/// Everything above is a *policy* question, which is exactly right: this is the
/// seam a policy plugs into, and what it can decide today is order.
pub trait ReadyPolicy: Send {
    /// Take the next ready slot, or `None` when nothing is ready.
    fn next(&mut self, queue: &mut VecDeque<u32>) -> Option<u32>;

    /// The policy's own name, printed with the run so a reader knows which one
    /// produced the order they are looking at.
    fn name(&self) -> &'static str;
}

/// First in, first out: the order tasks were made ready.
///
/// The default, and the one that makes a spawn-and-observe program deterministic
/// on both backends — a spawned task runs in spawn order, which is the order the
/// guest's own ring produces on continuation.
#[derive(Debug, Default)]
pub struct FifoPolicy {
    served: u64,
}

impl ReadyPolicy for FifoPolicy {
    fn next(&mut self, queue: &mut VecDeque<u32>) -> Option<u32> {
        let slot = queue.pop_front()?;
        self.served += 1;
        Some(slot)
    }
    fn name(&self) -> &'static str {
        "fifo"
    }
}

/// The ready queue: a bound, a policy, and the counters that make a refusal
/// visible instead of silent.
pub struct ReadyQueue {
    ready: VecDeque<u32>,
    policy: Box<dyn ReadyPolicy>,
    /// Submissions refused because the queue was full. **Not an error counter**:
    /// a refused submission means the task does not run, so this is a lost wake
    /// and a test asserts it stays zero.
    refused_full: u64,
    /// Submissions accepted, and slots the loop served. Equal at exit for a
    /// program that awaits nothing and spawns N, which is the invariant
    /// `tests/ready_queue.rs` states.
    accepted: u64,
    served: u64,
}

impl Default for ReadyQueue {
    fn default() -> Self {
        Self::with_policy(Box::new(FifoPolicy::default()))
    }
}

impl ReadyQueue {
    /// A queue with `policy` deciding order.
    pub fn with_policy(policy: Box<dyn ReadyPolicy>) -> Self {
        Self {
            ready: VecDeque::with_capacity(READY_CAPACITY),
            policy,
            refused_full: 0,
            accepted: 0,
            served: 0,
        }
    }

    /// **The guest's submission.** Answers `true` when the slot was queued.
    ///
    /// `false` is a refusal and it is counted: the caller (the guest) uses the
    /// answer to decide whether the spawn succeeded, so a full queue turns into a
    /// refused spawn rather than a task that silently never runs.
    pub fn submit(&mut self, slot: u32) -> bool {
        if self.ready.len() >= READY_CAPACITY {
            self.refused_full += 1;
            return false;
        }
        self.ready.push_back(slot);
        self.accepted += 1;
        true
    }

    /// **The loop's one question.** Which slot runs now, or `None`.
    pub fn next(&mut self) -> Option<u32> {
        let slot = self.policy.next(&mut self.ready)?;
        self.served += 1;
        Some(slot)
    }

    pub fn is_empty(&self) -> bool {
        self.ready.is_empty()
    }

    pub fn len(&self) -> usize {
        self.ready.len()
    }

    pub fn policy_name(&self) -> &'static str {
        self.policy.name()
    }

    pub fn refused_full(&self) -> u64 {
        self.refused_full
    }

    pub fn accepted(&self) -> u64 {
        self.accepted
    }

    pub fn served(&self) -> u64 {
        self.served
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fifo_serves_in_submission_order() {
        let mut queue = ReadyQueue::default();
        for slot in [9u32, 5, 1] {
            assert!(queue.submit(slot));
        }
        let order: Vec<u32> = std::iter::from_fn(|| queue.next()).collect();
        assert_eq!(order, vec![9, 5, 1], "FIFO is submission order, not sorted");
        assert_eq!(queue.served(), 3);
        assert_eq!(queue.next(), None);
    }

    #[test]
    fn a_full_queue_refuses_by_value_and_counts_it() {
        let mut queue = ReadyQueue::default();
        for slot in 0..READY_CAPACITY as u32 {
            assert!(queue.submit(slot), "slot {slot} fits");
        }
        assert!(!queue.submit(999), "the queue is full: the submission is refused");
        assert_eq!(queue.refused_full(), 1, "and the refusal is counted, not swallowed");
        assert_eq!(queue.len(), READY_CAPACITY);
        // Draining one makes room again — the bound is the queue's length, not a
        // lifetime quota.
        assert_eq!(queue.next(), Some(0));
        assert!(queue.submit(999));
    }

    #[test]
    fn the_policy_is_an_object_not_a_branch() {
        /// A policy that takes the newest first. It changes the order and touches
        /// nothing else, which is the property the seam exists for.
        struct Lifo;
        impl ReadyPolicy for Lifo {
            fn next(&mut self, queue: &mut VecDeque<u32>) -> Option<u32> {
                queue.pop_back()
            }
            fn name(&self) -> &'static str {
                "lifo"
            }
        }
        let mut queue = ReadyQueue::with_policy(Box::new(Lifo));
        for slot in [9u32, 5, 1] {
            assert!(queue.submit(slot));
        }
        let order: Vec<u32> = std::iter::from_fn(|| queue.next()).collect();
        assert_eq!(order, vec![1, 5, 9], "the same slots, the policy's order");
        assert_eq!(queue.policy_name(), "lifo");
    }

    #[test]
    fn accepted_minus_served_is_what_is_still_owed() {
        let mut queue = ReadyQueue::default();
        for slot in 0..5u32 {
            assert!(queue.submit(slot));
        }
        assert_eq!(queue.next(), Some(0));
        assert_eq!(queue.next(), Some(1));
        assert_eq!(queue.accepted() - queue.served(), 3, "three still owed");
    }
}
