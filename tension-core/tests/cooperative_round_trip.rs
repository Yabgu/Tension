//! The round trip a cooperative scheduler is made of: **create, suspend,
//! complete**, across three separate host calls into one living store.
//!
//! # What this is
//!
//! The first slice of the cooperative scheduler, and deliberately nothing more:
//! no scheduler loop, no dispatcher, no cancellation policy, no `join`
//! semantics. `tests/stack_switching.rs` proves the *proposal* works; this proves
//! the **shape a scheduler will use** — a context that outlives the call which
//! created it, is driven one step at a time, and is gone once it finishes.
//!
//! Three host calls, one `Store`:
//!
//! 1. `spawn` — creates the continuation (`cont.new`) and parks it in a **table
//!    the guest owns**. The body has not run: `resumes == 0`.
//! 2. `step` — resumes it. The body runs to `suspend`, control returns to the
//!    host, the suspended continuation is stored back. `resumes == 1`,
//!    `done == 0`.
//! 3. `step` — resumes the *new* continuation. The body runs past the suspension
//!    point and returns. `done == 1`, and the slot is empty, so a fourth `step`
//!    answers `-1`.
//!
//! # Why the continuation lives in a wasm table, and not in the host
//!
//! This is the measured constraint that decides the scheduler's shape in
//! wasmtime 50.1, so it is worth stating precisely rather than assuming:
//!
//! * `wasmtime::ContRef` is `pub struct ContRef;` — an **empty stub**, with the
//!   doc comment "A placeholder until continuation objects are fully integrated
//!   with the GC system (see #10248)".
//! * `Val::ContRef(Option<ContRef>)` exists as a variant, but `Val::ref_()`
//!   returns `None` for it (`// TODO(#10248): Return proper Ref::Cont when
//!   available`), and `Ref` has no `Cont` variant at all.
//! * There is **no `WasmTy` implementation** for `ContRef` or
//!   `Option<ContRef>`, so a host function cannot even *declare* a parameter or
//!   return of continuation type — `func_wrap` refuses to type-check.
//!
//! So a continuation cannot cross to the host. It has to live in guest storage
//! (a table slot, as here), and the host's role is to call in and read back an
//! `i32`. That is not a design preference being imposed on the guest: it is what
//! the engine permits today. It also happens to be exactly the contract's
//! decision — *the scheduler is guest-scheduled; the guest owns the
//! interleaving* — and the second test below is a tripwire for the day #10248
//! lands and the constraint changes.
//!
//! # Mutation check
//!
//! With `threads::enable()` off, the module does not compile and both tests fail.
//! The round trip therefore cannot pass for a reason other than the mechanism
//! being present.

use tension_core::threads::enable;
use wasmtime::{Config, Engine, Instance, Module, Store, Val};

/// The engine under test: the three proposal flags and nothing else.
fn engine() -> Engine {
    let mut config = Config::new();
    enable(&mut config);
    match Engine::new(&config) {
        Ok(engine) => engine,
        Err(why) => panic!(
            "this platform ({} {}) cannot compile stack switching: {why}. \
             The cooperative contract is x86_64-Linux only in wasmtime 50; \
             a machine that refuses this config cannot exercise it.",
            std::env::consts::ARCH,
            std::env::consts::OS
        ),
    }
}

/// A guest that keeps its own context table, so a context survives the call that
/// created it.
///
/// `step`'s three answers are the scheduler's vocabulary in miniature: `1` still
/// runnable, `0` finished, `-1` nothing to run. Nothing is a policy yet — the
/// host decides what to do with each, and this file has no opinion.
const ROUND_TRIP: &str = r#"
(module
  (type $ft (func))
  (type $ct (cont $ft))
  (tag $yield (type $ft))

  ;; Two counters, so "the body ran" and "the body finished" are separate facts.
  (global $resumes (mut i32) (i32.const 0))
  (global $done    (mut i32) (i32.const 0))

  ;; The guest's context storage. One slot is all a round trip needs; a
  ;; scheduler would key this by CtxHandle.
  (table $live 1 (ref null $ct))
  (elem declare func $body)

  ;; A body with exactly one suspension point, which is the minimum that can
  ;; distinguish "created" from "suspended" from "completed".
  (func $body
    (global.set $resumes (i32.add (global.get $resumes) (i32.const 1)))
    (suspend $yield)
    (global.set $done (i32.add (global.get $done) (i32.const 1))))

  ;; spawn() -> 1. `cont.new` captures the body **without running it**.
  (func (export "spawn") (result i32)
    (table.set $live (i32.const 0) (cont.new $ct (ref.func $body)))
    (i32.const 1))

  ;; step() -> 1 suspended | 0 completed | -1 nothing left.
  (func (export "step") (result i32)
    (local $c (ref null $ct))
    (local.set $c (table.get $live (i32.const 0)))
    (if (ref.is_null (local.get $c)) (then (return (i32.const -1))))
    (block $parked (result (ref null $ct))
      ;; Completed: control fell out of the body, so this context is spent and
      ;; its slot is cleared. A scheduler cannot confuse "finished" with
      ;; "parked" if the finished one is not in the table any more.
      (resume $ct (on $yield $parked) (local.get $c))
      (table.set $live (i32.const 0) (ref.null $ct))
      (return (i32.const 0)))
    ;; Parked: `resume` consumed the old handle and the label was handed the
    ;; **new** one. Store it; the next `step` needs it.
    (local.set $c)
    (table.set $live (i32.const 0) (local.get $c))
    (i32.const 1))

  (func (export "resumes") (result i32) (global.get $resumes))
  (func (export "done")    (result i32) (global.get $done)))
"#;

#[test]
fn a_spawned_context_suspends_and_completes_across_three_host_calls() {
    let engine = engine();
    // **One store for all three calls.** That is the property under test: the
    // context outlives the call that created it.
    let mut store = Store::new(&engine, ());
    let module = Module::new(&engine, ROUND_TRIP).expect("the round-trip module compiles");
    let instance = Instance::new(&mut store, &module, &[]).expect("instantiate");

    let spawn = instance
        .get_typed_func::<(), i32>(&mut store, "spawn")
        .expect("spawn is exported");
    let step = instance
        .get_typed_func::<(), i32>(&mut store, "step")
        .expect("step is exported");
    let resumes = instance
        .get_typed_func::<(), i32>(&mut store, "resumes")
        .expect("resumes is exported");
    let done = instance
        .get_typed_func::<(), i32>(&mut store, "done")
        .expect("done is exported");

    // 1. Created, not started.
    assert_eq!(spawn.call(&mut store, ()).expect("spawn"), 1);
    assert_eq!(
        resumes.call(&mut store, ()).expect("resumes"),
        0,
        "`cont.new` captures the body without running it"
    );

    // 2. Runs to the suspension point and hands control back to the host.
    assert_eq!(
        step.call(&mut store, ()).expect("the first step"),
        1,
        "the first step parks, it does not finish"
    );
    assert_eq!(
        resumes.call(&mut store, ()).expect("resumes"),
        1,
        "the body ran up to its suspension point"
    );
    assert_eq!(
        done.call(&mut store, ()).expect("done"),
        0,
        "and no further: the code after `suspend` had not run"
    );

    // 3. Runs past the suspension point and returns.
    assert_eq!(
        step.call(&mut store, ()).expect("the second step"),
        0,
        "the second step completes the context"
    );
    assert_eq!(
        done.call(&mut store, ()).expect("done"),
        1,
        "the body ran to its end exactly once"
    );
    assert_eq!(
        resumes.call(&mut store, ()).expect("resumes"),
        1,
        "and was not restarted from the top"
    );

    // 4. A spent context is out of the table: nothing left to run. This is what
    //    stops a scheduler from looping on a finished context forever.
    assert_eq!(
        step.call(&mut store, ()).expect("a step with nothing to run"),
        -1,
        "a completed context leaves the table"
    );

    // 5. The shape above is **forced, not chosen**. A continuation cannot cross
    //    to the host in wasmtime 50.1: `Val::ContRef` is a variant that holds
    //    nothing usable and `ref_()` answers `None` for it (`TODO(#10248)` in the
    //    engine's source), and no `WasmTy` implementation exists, so a host
    //    function cannot even declare a continuation parameter. That is why the
    //    context lives in a table the guest owns and the host's whole view of it
    //    is an `i32`.
    //
    //    This assertion is a tripwire, not a law: the day #10248 lands and it
    //    starts answering `Some(..)`, it fails — and that is the day a host-side
    //    context table becomes possible, so the storage decision should be
    //    revisited deliberately rather than inherited.
    assert!(
        Val::ContRef(None).ref_().is_none(),
        "wasmtime 50.1 cannot hand a continuation to the host (#10248); if this \
         fails, continuations gained host-side values and the scheduler's \
         guest-owned context table is no longer forced"
    );
}
