//! The run queue a cooperative scheduler drains, one step per context per frame.
//!
//! # What this owns, and what it does not
//!
//! It owns **order**: a `Vec<CtxHandle>` in insertion order, a frame counter, and
//! a trace of what was stepped when. It does not own the mechanism: a step is a
//! closure, because *how* a context advances is the caller's business. In this
//! tree that closure calls the guest's own `__thread_step` export — the host
//! cannot resume a continuation itself (see `tests/cooperative_round_trip.rs`:
//! `ContRef` is a stub in wasmtime 50.1, so a context is a number and its
//! mechanism is guest-side).
//!
//! The split is deliberate and it is the contract's: **the host owns the order,
//! the guest owns the interleaving.** Order is what a scheduler can be
//! deterministic about, and determinism is the whole reason to choose the
//! cooperative variant.
//!
//! # No policy
//!
//! One step per live context per drain, in insertion order. No priority, no
//! starvation rule, no per-context budget, no reordering. A context that
//! completes or traps leaves the queue; nothing else changes the order. Anything
//! more is a decision this module has no business making before the mechanism is
//! proven.
//!
//! # Frames
//!
//! A *drain* is one frame's worth of scheduling. A context pushed **during** a
//! drain does not run in that drain: it starts at the tail and is first stepped
//! in the next frame. That is the rule that keeps a spawning context from
//! starving its siblings for a frame, and it is checked by a test rather than
//! left to the reader.

use super::CtxHandle;

/// What one step of one context reported.
///
/// The three cases a scheduler has to tell apart. `Alive` and `Complete` are the
/// guest's `1` and `0`; `Trapped` carries the errno the host answered, because
/// "it died" and "it suspended" must not be conflated by a `bool`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Step {
    /// It suspended; it can be stepped again next frame.
    Alive,
    /// It finished. It leaves the queue.
    Complete,
    /// It failed. It leaves the queue, and the errno is kept for the caller.
    Trapped(i32),
}

impl Step {
    /// The step a guest's `__thread_step` answer means.
    ///
    /// `1` alive, `0` complete, anything else a trap carrying that errno. The
    /// mapping is one function so a caller cannot invent a second reading of the
    /// same three numbers — and so the `-1` a spent context answers (there is
    /// nothing in its slot) arrives as `Trapped(-1)` rather than being mistaken
    /// for `Complete`.
    pub fn of_guest(answer: i32) -> Self {
        match answer {
            1 => Step::Alive,
            0 => Step::Complete,
            other => Step::Trapped(other),
        }
    }
}

/// One line of the trace: which context, in which frame, and what it answered.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Traced {
    /// The frame this step happened in, counting from 0 at the first drain.
    pub frame: u32,
    /// The context that was stepped.
    pub ctx: CtxHandle,
    /// What it answered.
    pub step: Step,
}

/// A run queue: insertion order in, one step each per drain, removal on exit.
#[derive(Default)]
pub struct ThreadQueue {
    order: Vec<CtxHandle>,
    frame: u32,
    trace: Vec<Traced>,
    /// Steps taken in total, across every frame. Counted rather than derived
    /// because a trace can be cleared and the count must not reset with it.
    steps: u64,
}

impl ThreadQueue {
    /// An empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a context to the **tail**.
    ///
    /// Appending is the whole of the policy: a context starts when it was
    /// created and never before. Pushing during a drain is safe and does not
    /// affect the drain in progress.
    pub fn push(&mut self, ctx: CtxHandle) {
        self.order.push(ctx);
    }

    /// The live contexts, in the order they will be stepped.
    pub fn order(&self) -> &[CtxHandle] {
        &self.order
    }

    /// How many contexts are still live.
    pub fn len(&self) -> usize {
        self.order.len()
    }

    /// Whether the queue has nothing left to run.
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// The frame number the next drain will use.
    pub fn frame(&self) -> u32 {
        self.frame
    }

    /// Total steps taken, over every frame.
    pub fn steps(&self) -> u64 {
        self.steps
    }

    /// The trace so far, in step order.
    pub fn trace(&self) -> &[Traced] {
        &self.trace
    }

    /// The trace as text, one line per step: `f<frame> <ctx> <what>`.
    ///
    /// Byte-comparable across runs by construction — frame numbers, handles and
    /// step names, nothing else. This is what a determinism check compares, so it
    /// must not acquire a timestamp, a duration, or a hash of anything.
    pub fn trace_text(&self) -> String {
        let mut out = String::new();
        for entry in &self.trace {
            let what = match entry.step {
                Step::Alive => "alive",
                Step::Complete => "complete",
                Step::Trapped(errno) => {
                    out.push_str(&format!(
                        "f{} {} trapped({errno})\n",
                        entry.frame, entry.ctx.bits()
                    ));
                    continue;
                }
            };
            out.push_str(&format!("f{} {} {what}\n", entry.frame, entry.ctx.bits()));
        }
        out
    }

    /// Step every live context **once**, in insertion order, and drop the ones
    /// that finished or failed.
    ///
    /// `step` is called once per live context, in order.
    ///
    /// **A context cannot be pushed during a drain, and that is a type-level
    /// guarantee rather than a rule.** The closure receives a `CtxHandle` and a
    /// `&mut` to nothing: `drain` holds the queue for the whole call, so a step
    /// has no handle to spawn through. A guest's `spawn` therefore lands between
    /// drains — the frame's membership is fixed when the frame begins, which is
    /// what makes the trace a function of the queue and not of the guest's
    /// eagerness. (The alternative, a `Cell`-shared queue, would make the
    /// ordering rule a thing reviewers have to notice; this makes it a thing
    /// they cannot miss.)
    /// Returns what happened, in order, for a caller that wants to act on it
    /// (the next slice's `Dispatcher` does; the tests do).
    pub fn drain<F>(&mut self, mut step: F) -> Vec<Traced>
    where
        F: FnMut(CtxHandle) -> Step,
    {
        let frame = self.frame;
        self.frame += 1;

        let live = self.order.len();
        let mut this_frame = Vec::with_capacity(live);
        // Survivors keep their relative order; a context that finishes frees its
        // place without disturbing anyone else's.
        let mut survivors = Vec::with_capacity(live);

        for index in 0..live {
            let ctx = self.order[index];
            let outcome = step(ctx);
            this_frame.push(Traced {
                frame,
                ctx,
                step: outcome,
            });
            self.steps += 1;
            if outcome == Step::Alive {
                survivors.push(ctx);
            }
        }

        self.order = survivors;
        self.trace.extend_from_slice(&this_frame);
        this_frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(bits: i32) -> CtxHandle {
        CtxHandle::from_bits(bits)
    }

    /// Insertion order is the whole policy: three contexts step in the order they
    /// arrived, and nothing reorders them.
    #[test]
    fn a_drain_steps_in_insertion_order() {
        let mut queue = ThreadQueue::new();
        queue.push(handle(1));
        queue.push(handle(2));
        queue.push(handle(3));

        let mut seen = Vec::new();
        queue.drain(|ctx| {
            seen.push(ctx.bits());
            Step::Alive
        });

        assert_eq!(seen, vec![1, 2, 3]);
        assert_eq!(queue.len(), 3, "all three are still alive");
    }

    /// A context that finishes leaves, and the rest keep their order.
    #[test]
    fn a_completed_context_leaves_and_the_rest_keep_their_places() {
        let mut queue = ThreadQueue::new();
        queue.push(handle(1));
        queue.push(handle(2));
        queue.push(handle(3));

        queue.drain(|ctx| {
            if ctx.bits() == 2 {
                Step::Complete
            } else {
                Step::Alive
            }
        });

        assert_eq!(
            queue.order().iter().map(|c| c.bits()).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(queue.frame(), 1);
    }

    /// A context added between frames starts at the tail, and nothing jumps it.
    #[test]
    fn a_context_added_between_frames_starts_at_the_tail() {
        let mut queue = ThreadQueue::new();
        queue.push(handle(1));
        queue.push(handle(2));

        queue.drain(|_| Step::Alive);

        queue.push(handle(3));
        let mut seen = Vec::new();
        queue.drain(|ctx| {
            seen.push(ctx.bits());
            Step::Alive
        });
        assert_eq!(seen, vec![1, 2, 3], "the newcomer ran last");
    }

    /// A trap removes the context exactly like completion does, and the rest of
    /// the frame still runs — one guest's failure does not stop the queue.
    #[test]
    fn a_trapped_context_leaves_and_the_drain_continues() {
        let mut queue = ThreadQueue::new();
        queue.push(handle(1));
        queue.push(handle(2));
        queue.push(handle(3));

        let stepped = queue.drain(|ctx| {
            if ctx.bits() == 2 {
                Step::Trapped(-22)
            } else {
                Step::Alive
            }
        });

        assert_eq!(
            stepped.iter().map(|t| t.ctx.bits()).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "the context after the failure was still stepped this frame"
        );
        assert_eq!(
            queue.order().iter().map(|c| c.bits()).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert!(queue.trace_text().contains("trapped(-22)"));
    }

    /// A queue that has emptied stops costing anything: a drain over nothing
    /// records nothing and does not advance a step count.
    #[test]
    fn an_empty_queue_drains_to_nothing() {
        let mut queue = ThreadQueue::new();
        assert!(queue.drain(|_| panic!("nothing should be stepped")).is_empty());
        assert_eq!(queue.steps(), 0);
        assert_eq!(queue.frame(), 1, "the frame still happened");
    }

    /// The trace is text a determinism check can compare: same events, same
    /// bytes, no time in it.
    #[test]
    fn the_trace_is_stable_text() {
        let run = || {
            let mut queue = ThreadQueue::new();
            queue.push(handle(4));
            queue.push(handle(9));
            queue.drain(|ctx| if ctx.bits() == 9 { Step::Complete } else { Step::Alive });
            queue.drain(|_| Step::Complete);
            queue.trace_text()
        };
        assert_eq!(run(), run());
        assert_eq!(
            run(),
            "f0 4 alive\nf0 9 complete\nf1 4 complete\n",
            "frame, handle, outcome - nothing else"
        );
    }

    /// The guest's three answers map one way, in one place. `-1` is a trap, not a
    /// completion: a spent context answering "nothing here" must never read as
    /// "finished cleanly".
    #[test]
    fn the_guest_answer_maps_one_way() {
        assert_eq!(Step::of_guest(1), Step::Alive);
        assert_eq!(Step::of_guest(0), Step::Complete);
        assert_eq!(Step::of_guest(-1), Step::Trapped(-1));
        assert_eq!(Step::of_guest(-22), Step::Trapped(-22));
    }
}
