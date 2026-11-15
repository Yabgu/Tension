//! The first scheduler: a run queue, a FIFO drain, and two contexts in one
//! store that alternate deterministically.
//!
//! # What is proven here
//!
//! `tests/cooperative_round_trip.rs` proved one context across three host calls.
//! This proves the **queue**: several contexts, one step each per frame, in
//! insertion order, with completion and failure removing a context and nothing
//! else reordering the rest.
//!
//! The guest owns the mechanism (a table of continuations, advanced by its own
//! `__thread_step`); the host owns the order. That split is forced by wasmtime
//! 50.1 — a continuation cannot cross to the host (`ContRef` is a stub, #10248) —
//! and it is the contract's own decision: *the scheduler is guest-scheduled; the
//! guest owns the interleaving.* The host can be deterministic about order, which
//! is exactly what the cooperative variant buys.
//!
//! # The traces
//!
//! Two, deliberately:
//!
//! * the **queue trace** (`ThreadQueue::trace_text`) — which handle was stepped,
//!   in which frame, and what it answered;
//! * the **guest log** — bytes the guest writes when a body actually runs, read
//!   back out of its memory.
//!
//! The second is what makes the first mean something: an `alive` in the host's
//! trace is a claim about the guest's execution, and the guest's own log is the
//! evidence. Both are compared byte-for-byte across two independent runs of the
//! same scenario, which is the determinism the cooperative variant promises.
//!
//! # Mutation checks
//!
//! * reverse the drain (LIFO) -> the guest log reads `BABA…` instead of `ABAB…`;
//! * let a completed context stay in the queue -> the next step of it traps with
//!   "continuation already consumed" and the trace shows `trapped(-22)` where it
//!   should show nothing.

use tension_core::threads::queue::{Step, ThreadQueue};
use tension_core::threads::{enable, CtxHandle};
use wasmtime::{Config, Engine, Instance, Memory, Module, Store, TypedFunc};

/// The engine under test: the three proposal flags and nothing else.
fn engine() -> Engine {
    let mut config = Config::new();
    enable(&mut config);
    match Engine::new(&config) {
        Ok(engine) => engine,
        Err(why) => panic!(
            "this platform ({} {}) cannot compile stack switching: {why}. \
             The cooperative scheduler is x86_64-Linux only in wasmtime 50.",
            std::env::consts::ARCH,
            std::env::consts::OS
        ),
    }
}

/// A guest with four context slots, four bodies, and a byte log of what ran.
///
/// * `$a` suspends twice then completes (three steps);
/// * `$b` suspends once then completes (two steps);
/// * `$c` completes immediately (one step) — the newcomer that must start at the
///   tail;
/// * `$t` suspends once then traps (two steps, the second fatal).
///
/// Each body appends its letter to the log **when it runs**, so the log is the
/// guest's own account of the interleaving rather than the host's opinion of it.
const GUEST: &str = r#"
(module
  (type $ft (func))
  (type $ct (cont $ft))
  (tag $yield (type $ft))

  (memory (export "memory") 1)
  (global $log_len (mut i32) (i32.const 0))
  (global $done_a (mut i32) (i32.const 0))
  (global $done_b (mut i32) (i32.const 0))

  (table $ctx 4 (ref null $ct))
  (elem declare func $a $b $c $t)

  ;; append one byte to the log at offset 64
  (func $log (param $id i32)
    (i32.store8
      (i32.add (i32.const 64) (global.get $log_len))
      (local.get $id))
    (global.set $log_len (i32.add (global.get $log_len) (i32.const 1))))

  (func (export "log_len") (result i32) (global.get $log_len))
  (func (export "done_a") (result i32) (global.get $done_a))
  (func (export "done_b") (result i32) (global.get $done_b))

  (func $a
    (call $log (i32.const 65))
    (suspend $yield)
    (call $log (i32.const 65))
    (suspend $yield)
    (call $log (i32.const 65))
    (global.set $done_a (i32.const 1)))

  (func $b
    (call $log (i32.const 66))
    (suspend $yield)
    (call $log (i32.const 66))
    (global.set $done_b (i32.const 1)))

  (func $c
    (call $log (i32.const 67)))

  (func $t
    (call $log (i32.const 84))
    (suspend $yield)
    (unreachable))

  ;; Find a free slot, put the chosen body in it, return the slot (the context
  ;; handle), or -28 (ENOSPC) when the table is full.
  (func (export "spawn") (param $kind i32) (result i32)
    (local $slot i32)
    (local $c (ref null $ct))
    (local.set $c
      (if (result (ref null $ct)) (i32.eq (local.get $kind) (i32.const 0))
        (then (cont.new $ct (ref.func $a)))
        (else (if (result (ref null $ct)) (i32.eq (local.get $kind) (i32.const 1))
          (then (cont.new $ct (ref.func $b)))
          (else (if (result (ref null $ct)) (i32.eq (local.get $kind) (i32.const 2))
            (then (cont.new $ct (ref.func $c)))
            (else (cont.new $ct (ref.func $t)))))))))
    (block $found
      (loop $scan
        (br_if $found (i32.ge_u (local.get $slot) (i32.const 4)))
        (if (ref.is_null (table.get $ctx (local.get $slot)))
          (then (br $found)))
        (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
        (br $scan)))
    (if (i32.ge_u (local.get $slot) (i32.const 4))
      (then (return (i32.const -28))))
    (table.set $ctx (local.get $slot) (local.get $c))
    (local.get $slot))

  ;; One step of one context: 1 alive, 0 complete, -1 nothing in the slot.
  (func (export "__thread_step") (param $idx i32) (result i32)
    (local $c (ref null $ct))
    (if (i32.ge_u (local.get $idx) (i32.const 4))
      (then (return (i32.const -1))))
    (local.set $c (table.get $ctx (local.get $idx)))
    (if (ref.is_null (local.get $c)) (then (return (i32.const -1))))
    (block $parked (result (ref null $ct))
      (resume $ct (on $yield $parked) (local.get $c))
      (table.set $ctx (local.get $idx) (ref.null $ct))
      (return (i32.const 0)))
    (local.set $c)
    (table.set $ctx (local.get $idx) (local.get $c))
    (i32.const 1)))
"#;

/// One instantiated guest, with the exports the harness drives.
struct Fixture {
    store: Store<()>,
    spawn: TypedFunc<i32, i32>,
    step: TypedFunc<i32, i32>,
    log_len: TypedFunc<(), i32>,
    done_a: TypedFunc<(), i32>,
    done_b: TypedFunc<(), i32>,
    memory: Memory,
}

impl Fixture {
    fn new(engine: &Engine) -> Self {
        let module = Module::new(engine, GUEST).expect("the scheduler guest compiles");
        let mut store = Store::new(engine, ());
        let instance = Instance::new(&mut store, &module, &[]).expect("instantiate");
        Self {
            spawn: instance
                .get_typed_func(&mut store, "spawn")
                .expect("spawn is exported"),
            step: instance
                .get_typed_func(&mut store, "__thread_step")
                .expect("__thread_step is exported"),
            log_len: instance
                .get_typed_func(&mut store, "log_len")
                .expect("log_len is exported"),
            done_a: instance
                .get_typed_func(&mut store, "done_a")
                .expect("done_a is exported"),
            done_b: instance
                .get_typed_func(&mut store, "done_b")
                .expect("done_b is exported"),
            memory: instance
                .get_export(&mut store, "memory")
                .and_then(|e| e.into_memory())
                .expect("memory is exported"),
            store,
        }
    }

    /// Add a context, returning its handle.
    fn add(&mut self, kind: i32) -> CtxHandle {
        let slot = self.spawn.call(&mut self.store, kind).expect("spawn");
        assert!(slot >= 0, "spawn answered {slot} (the table is full)");
        CtxHandle::from_bits(slot)
    }

    /// One step of one context, as the queue sees it.
    fn step(&mut self, ctx: CtxHandle) -> Step {
        match self.step.call(&mut self.store, ctx.bits()) {
            Ok(answer) => Step::of_guest(answer),
            // A trap is a trap: the queue drops the context. The errno is the
            // host's own, because wasmtime answers an error, not a number.
            Err(_) => Step::Trapped(-22),
        }
    }

    /// The guest's own account of what ran, in order.
    fn log(&mut self) -> String {
        let len = self.log_len.call(&mut self.store, ()).expect("log_len") as usize;
        let data = self.memory.data(&self.store);
        String::from_utf8_lossy(&data[64..64 + len]).into_owned()
    }
}

/// The scenario both determinism runs perform, so the two are comparable by
/// construction rather than by two copies of the same code.
///
/// Two contexts start; the queue drains until it is empty; a third is added
/// part-way through to prove the tail rule.
fn scenario(mut f: Fixture) -> (String, String, i32, i32) {
    let mut queue = ThreadQueue::new();
    let a = f.add(0);
    let b = f.add(1);
    queue.push(a);
    queue.push(b);

    // Frame 0: both alive, alternating.
    queue.drain(|ctx| f.step(ctx));

    // A newcomer joins at the tail while both originals are still live, so its
    // handle is a fresh slot rather than a reused one. (Slot reuse is a real
    // hazard and has its own test: the handle here is a table index, which is
    // not what a scheduler's `CtxHandle` may be.)
    let c = f.add(2);
    queue.push(c);

    // Frames 1..: let everything run out. **Bounded**, because a scheduler whose
    // queue never empties must fail the test rather than hang the gate — which is
    // exactly what a "completion does not remove" mutation does if this loops
    // while the queue is non-empty (measured: it ran past 60 s).
    for _ in 0..8 {
        if queue.is_empty() {
            break;
        }
        queue.drain(|ctx| f.step(ctx));
    }
    assert!(
        queue.is_empty(),
        "the queue must drain: still live after 9 frames: {:?}",
        queue.order().iter().map(|c| c.bits()).collect::<Vec<_>>()
    );

    let done_a = f.done_a.call(&mut f.store, ()).expect("done_a");
    let done_b = f.done_b.call(&mut f.store, ()).expect("done_b");
    (queue.trace_text(), f.log(), done_a, done_b)
}

/// Two contexts alternate FIFO across frames, each body runs exactly once per
/// step, and the whole scenario produces the same trace and the same guest log
/// on two independent runs.
#[test]
fn two_contexts_alternate_fifo_and_the_run_is_reproducible() {
    let engine = engine();
    let (trace_1, log_1, done_a, done_b) = scenario(Fixture::new(&engine));
    let (trace_2, log_2, done_a_2, done_b_2) = scenario(Fixture::new(&engine));

    assert_eq!(trace_1, trace_2, "the queue trace is byte-identical across runs");
    assert_eq!(log_1, log_2, "the guest's log is byte-identical across runs");

    // Handles are slot indices, so run 1's `a` is 0 and `b` is 1 in both runs.
    assert_eq!(
        trace_1,
        "f0 0 alive\n\
         f0 1 alive\n\
         f1 0 alive\n\
         f1 1 complete\n\
         f1 2 complete\n\
         f2 0 complete\n",
        "FIFO, one step each per frame, and a newcomer only after frame 1"
    );

    // The guest's own account: A ran three times, B twice, C once, and the
    // interleaving is the frames above rather than one body running to the end.
    assert_eq!(
        log_1, "ABABCA",
        "the bodies' own order: A and B alternated, C ran in frame 1, A finished alone"
    );

    assert_eq!(done_a, 1, "A ran to its end exactly once");
    assert_eq!(done_b, 1, "B ran to its end exactly once");
    assert_eq!((done_a_2, done_b_2), (1, 1));
}

/// A completed context is out of the queue *and* out of the table: stepping it
/// again answers `-1`, which the queue would call a trap. The point is that the
/// queue never asks.
#[test]
fn a_completed_context_is_stepped_no_more() {
    let engine = engine();
    let mut f = Fixture::new(&engine);
    let mut queue = ThreadQueue::new();
    let b = f.add(1); // one suspension: alive, then complete
    queue.push(b);

    queue.drain(|ctx| f.step(ctx));
    assert_eq!(queue.len(), 1, "still alive after one step");

    queue.drain(|ctx| f.step(ctx));
    assert!(queue.is_empty(), "completed, so it left");

    // The context is gone from both sides: the host queue has nothing, and the
    // guest's slot answers "nothing here" rather than resurrecting a spent
    // continuation.
    assert_eq!(f.step(b), Step::Trapped(-1));
}

/// A trapped context leaves the queue and the drain continues with the others.
#[test]
fn a_trapped_context_leaves_and_the_others_carry_on() {
    let engine = engine();
    let mut f = Fixture::new(&engine);
    let mut queue = ThreadQueue::new();
    let a = f.add(0);
    let t = f.add(3); // suspends, then `unreachable`
    let b = f.add(1);
    queue.push(a);
    queue.push(t);
    queue.push(b);

    // Frame 0: all three step and all three suspend.
    queue.drain(|ctx| f.step(ctx));
    assert_eq!(queue.len(), 3);

    // Frame 1: A parks, T traps, B completes. The trap must not cut the frame
    // short: B is after T in the queue and still ran.
    let frame = queue.drain(|ctx| f.step(ctx));
    assert_eq!(
        frame.iter().map(|t| (t.ctx.bits(), t.step)).collect::<Vec<_>>(),
        vec![(0, Step::Alive), (1, Step::Trapped(-22)), (2, Step::Complete)],
        "the context after the failure was stepped in the same frame"
    );
    assert_eq!(
        queue.order().iter().map(|c| c.bits()).collect::<Vec<_>>(),
        vec![0],
        "only A remains"
    );
    assert_eq!(
        f.log(),
        "ATBAB",
        "frame 0 ran A, T, B; frame 1 ran A, T (which trapped), B"
    );
}

/// The queue's ordering is what makes the trace a function of the schedule: two
/// contexts that each log on every run produce a log that alternates, not one
/// that runs a body to completion.
/// A handle here is a **table slot**, and slots are reused once freed — so the
/// handle of a finished context can name a new one. That is fine for this test
/// and **not** fine for a scheduler, which needs a monotonic `CtxHandle` and a
/// separate slot map; the aliasing is asserted rather than left as a comment so
/// the next slice inherits a measurement instead of a suspicion.
#[test]
fn a_freed_slot_is_reused_so_a_slot_index_is_not_a_stable_handle() {
    let engine = engine();
    let mut f = Fixture::new(&engine);
    let first = f.add(1);
    assert_eq!(first.bits(), 0, "an empty table hands out slot 0");

    let mut queue = ThreadQueue::new();
    queue.push(first);
    queue.drain(|ctx| f.step(ctx));
    queue.drain(|ctx| f.step(ctx));
    assert!(queue.is_empty(), "it completed and left");

    let second = f.add(1);
    assert_eq!(
        second.bits(),
        first.bits(),
        "the freed slot came back with the same number: a slot index is not \
         unique across time, so `CtxHandle` cannot be one"
    );
}

#[test]
fn the_interleaving_is_per_frame_not_per_body() {
    let engine = engine();
    let mut f = Fixture::new(&engine);
    let mut queue = ThreadQueue::new();
    let a = f.add(0);
    let b = f.add(1);
    queue.push(a);
    queue.push(b);

    queue.drain(|ctx| f.step(ctx));
    assert_eq!(f.log(), "AB", "one step each, not A to exhaustion");

    queue.drain(|ctx| f.step(ctx));
    assert_eq!(f.log(), "ABAB", "and again");

    queue.drain(|ctx| f.step(ctx));
    assert_eq!(f.log(), "ABABA", "A's last step, with B already done and gone");
}
