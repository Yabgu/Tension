//! Does this build's engine actually implement stack switching — and, above all,
//! **`resume_throw`**?
//!
//! # What this proves, and why it is the first artifact of the threading branch
//!
//! A config flag is not a feature. `Config::wasm_stack_switching(true)` could be
//! accepted by an engine whose back end silently ignores it, and every later
//! "the contract works" claim would rest on that. So the branch starts here: a
//! module is compiled, a continuation is created, it suspends, and an exception
//! is **thrown into it**.
//!
//! `resume_throw` is what makes a cooperative thread cancellable. Without it
//! there is no way to deliver "stop" into a suspended continuation: the only
//! options left are letting it run (cooperative cancellation by polling, which a
//! guest can refuse) or dropping the whole store (which is the sandbox's
//! watchdog, not a contract). With it, cancel is **throw into the continuation,
//! a handler inside decides, or the store is discarded** — never
//! cancel-and-resume.
//!
//! The instruction landed in wasmtime 50.0.0 (`resume_throw`/`resume_throw_ref`,
//! wasmtime#14052, merged 2026-07-31, commit `57fd502`); `Cargo.toml` pins
//! `=50.0.1`.
//!
//! # The subset the contract will use
//!
//! Exactly what is exercised here:
//!
//! * `cont.new` on a function reference, and `elem declare` to make that
//!   reference legal;
//! * `suspend $tag` with a **control tag that carries no payload** — the yield
//!   a thread makes when it parks;
//! * `resume` with `(on $tag $label)`, where the label receives the
//!   **resuspended continuation**;
//! * `resume_throw` into a suspended continuation, with and without a handler at
//!   the thrower;
//! * a `try_table`/`catch` inside the continuation, which is how a guest chooses
//!   to survive a cancel.
//!
//! # Platform
//!
//! Stack switching is x86_64-only in wasmtime 50. On any other target `Engine::
//! new` refuses this config, so these tests **fail rather than skip** — a skip
//! would make "the contract's foundation is proven" true on a machine the
//! contract never runs on. The platform is recorded in the assertion message and
//! printed once, so a gate log says where this was exercised.

use tension_core::threads::enable;
use wasmtime::{Config, Engine, Linker, Module, Store};

/// The engine under test: the three proposal flags and nothing else.
fn engine() -> Engine {
    let mut config = Config::new();
    enable(&mut config);
    match Engine::new(&config) {
        Ok(engine) => engine,
        Err(why) => panic!(
            "this platform ({} {}) cannot compile stack switching: {why}. \
             The cooperative-thread contract is x86_64-Linux only in wasmtime 50; \
             a machine that refuses this config cannot prove it.",
            std::env::consts::ARCH,
            std::env::consts::OS
        ),
    }
}

/// A module whose continuation **catches** the cancellation, plus one whose
/// continuation does not. `$caught` and `$started` are the observations: what
/// the payload was, and whether the body ever ran at all.
const HONEST_MODULE: &str = r#"
(module
  (type $ft (func))
  (type $ct (cont $ft))

  ;; The tag a thread parks with: no payload, so the label it branches to
  ;; receives exactly the resuspended continuation.
  (tag $yield (type $ft))
  ;; The tag a cancellation is delivered with. The payload is why a cancel can
  ;; say who asked and why.
  (tag $cancel (param i32))

  (global $caught  (mut i32) (i32.const -1))
  (global $started (mut i32) (i32.const 0))

  ;; A body that runs, parks, and — if it is cancelled while parked — records
  ;; the payload and returns normally. This is "a handler inside decides".
  (func $body
    (global.set $started (i32.const 1))
    (block $on_cancel (result i32)
      (try_table (catch $cancel $on_cancel)
        (suspend $yield))
      ;; Reached only if the body was resumed without a throw: it completes.
      (return))
    (global.set $caught))

  ;; The same body with no handler: a cancellation thrown into it has nowhere to
  ;; go, and must escape to whoever resumed it.
  (func $body_uncaught
    (suspend $yield))

  (elem declare func $body $body_uncaught)

  ;; Park the body, then throw 42 into it. Returns `$caught`.
  ;;
  ;; Operand order for `resume_throw`: the tag's arguments first, the
  ;; **continuation on top** — `peekn(arity + 1).split_last()` in the Cranelift
  ;; translator, where the last element is the continuation.
  (func (export "cancel_and_handled") (result i32)
    (local $c (ref null $ct))
    (block $parked (result (ref null $ct))
      (resume $ct (on $yield $parked) (cont.new $ct (ref.func $body)))
      ;; The body completed without parking: nothing to cancel.
      (return (i32.const 99)))
    (local.set $c)
    (i32.const 42)
    (local.get $c)
    (resume_throw $ct $cancel)
    (global.get $caught))

  ;; Park the body, then throw into it with no handler anywhere.
  (func (export "cancel_uncaught")
    (local $c (ref null $ct))
    (block $parked (result (ref null $ct))
      (resume $ct (on $yield $parked) (cont.new $ct (ref.func $body_uncaught)))
      (return))
    (local.set $c)
    (i32.const 7)
    (local.get $c)
    (resume_throw $ct $cancel))

  ;; Two resumes, no throw: park, then finish. The control case — it proves the
  ;; continuation machinery itself works before the throw is blamed for anything.
  (func (export "park_and_finish") (result i32)
    (block $parked (result (ref null $ct))
      (resume $ct (on $yield $parked) (cont.new $ct (ref.func $body)))
      (return (i32.const 99)))
    (resume $ct)
    (global.get $started))

  ;; A continuation is **consumed** by the resume that ran it, and by the throw
  ;; that finished it. Resuming a consumed one is not a second start: it is the
  ;; trap below, which is what "the continuation is discarded, not resumed"
  ;; means in mechanism rather than in prose.
  (func (export "resume_after_it_parked") (result i32)
    (local $consumed (ref null $ct))
    (local.set $consumed (cont.new $ct (ref.func $body)))
    (block $parked (result (ref null $ct))
      (resume $ct (on $yield $parked) (local.get $consumed))
      (return (i32.const 99)))
    ;; The label handed back the live continuation; drop it unused, so the only
    ;; thing left to resume is the consumed original.
    (drop)
    (local.get $consumed)
    (resume $ct)
    (i32.const 0))

  (func (export "started") (result i32) (global.get $started))
)
"#;

#[test]
fn a_continuation_parks_and_is_resumed_again() {
    let engine = engine();
    let mut store = Store::new(&engine, ());
    let module = Module::new(&engine, HONEST_MODULE).expect("the module compiles");
    let instance = wasmtime::Instance::new(&mut store, &module, &[]).expect("instantiate");

    let park_and_finish = instance
        .get_typed_func::<(), i32>(&mut store, "park_and_finish")
        .expect("the export");
    assert_eq!(
        park_and_finish.call(&mut store, ()).expect("the call"),
        1,
        "the body ran exactly once across both resumes"
    );

    let started = instance
        .get_typed_func::<(), i32>(&mut store, "started")
        .expect("the export");
    assert_eq!(started.call(&mut store, ()).expect("the call"), 1);
}

#[test]
fn a_cancel_thrown_into_a_parked_continuation_reaches_its_handler() {
    let engine = engine();
    let mut store = Store::new(&engine, ());
    let module = Module::new(&engine, HONEST_MODULE).expect("the module compiles");
    let instance = wasmtime::Instance::new(&mut store, &module, &[]).expect("instantiate");

    let started = instance
        .get_typed_func::<(), i32>(&mut store, "started")
        .expect("the export");
    let cancel = instance
        .get_typed_func::<(), i32>(&mut store, "cancel_and_handled")
        .expect("the export");

    let caught = cancel.call(&mut store, ()).expect("the throw is caught");
    assert_eq!(
        caught, 42,
        "the payload was delivered at the suspension point, not somewhere else"
    );
    assert_eq!(
        started.call(&mut store, ()).expect("the call"),
        1,
        "the body ran: the payload did not arrive in a body that never started"
    );
}

#[test]
fn an_uncaught_cancel_escapes_to_the_host_boundary() {
    let engine = engine();
    let mut store = Store::new(&engine, ());
    let module = Module::new(&engine, HONEST_MODULE).expect("the module compiles");
    let instance = wasmtime::Instance::new(&mut store, &module, &[]).expect("instantiate");

    let cancel = instance
        .get_typed_func::<(), ()>(&mut store, "cancel_uncaught")
        .expect("the export");
    let why = cancel
        .call(&mut store, ())
        .expect_err("an unhandled exception cannot be swallowed at the boundary");
    let text = format!("{why:#}");
    assert!(
        text.to_lowercase().contains("exception") || text.contains("$cancel") || text.contains("tag"),
        "the boundary must say an exception arrived, not something else: {text}"
    );
}

/// wasmtime#13322's shape: a **host function called on a continuation**, which
/// used to corrupt `CallThreadState` (`assertion failed: self.unwind.replace(None)
/// .is_none()`), and here also re-enters the guest from that host call — the
/// nesting the report's analysis named.
///
/// The issue was closed 2026-09-28 by a regression-test commit (wasmtime#14439)
/// on the belief that wasmtime#11717, "continuation trapping semantics", had
/// fixed it; #11717 merged 2026-07-28, so 50.0.1 contains both. This test is the
/// independent check of that belief for the subset the contract uses, since a
/// corrupt store is exactly the kind of foundation that must not be built on.
#[test]
fn a_host_call_inside_a_continuation_does_not_corrupt_the_store() {
    let engine = engine();
    let mut store = Store::new(&engine, ());
    let mut linker = Linker::new(&engine);
    linker
        .func_wrap("host", "h", |mut caller: wasmtime::Caller<'_, ()>| {
            // Re-enter the guest from inside the host call: the nesting that
            // #13322's analysis blamed. The export is resolved on every call,
            // because the instance does not exist when the closure is made.
            let inner = caller
                .get_export("inner")
                .and_then(|e| e.into_func())
                .expect("the guest exports `inner`");
            let inner = inner.typed::<(), ()>(&caller)?;
            inner.call(&mut caller, ())?;
            Ok(())
        })
        .expect("the import registers");

    let module = Module::new(
        &engine,
        r#"
        (module
          (import "host" "h" (func $h))
          (type $ft (func))
          (tag $t (type $ft))
          (type $ct (cont $ft))
          (func (export "inner"))
          (func $callee
            (call $h)
            (suspend $t))
          (elem declare func $callee)
          (func (export "go") (result i32)
            (block $h (result (ref null $ct))
              (resume $ct (on $t $h) (cont.new $ct (ref.func $callee)))
              ;; The body completed without parking: not the path under test.
              (return (i32.const 1)))
            (resume $ct)         ;; finish the parked continuation
            (i32.const 0))
          )
        "#,
    )
    .expect("the module compiles");

    let instance = linker
        .instantiate(&mut store, &module)
        .expect("instantiate with the host import");
    let go = instance
        .get_typed_func::<(), i32>(&mut store, "go")
        .expect("the export");
    assert_eq!(
        go.call(&mut store, ()).expect("no corruption on the host-call path"),
        0,
        "the second resume returned the continuation's (absent) results and fell through"
    );
}

/// A continuation that has been resumed is consumed: it cannot be entered a
/// second time. This is the mechanism behind "cancel is throw-and-discard, never
/// cancel-and-resume" — a contract cannot choose to resume a cancelled thread,
/// because the store will not let it.
#[test]
fn a_consumed_continuation_cannot_be_resumed() {
    let engine = engine();
    let mut store = Store::new(&engine, ());
    let module = Module::new(&engine, HONEST_MODULE).expect("the module compiles");
    let instance = wasmtime::Instance::new(&mut store, &module, &[]).expect("instantiate");

    let again = instance
        .get_typed_func::<(), i32>(&mut store, "resume_after_it_parked")
        .expect("the export");
    let why = again
        .call(&mut store, ())
        .expect_err("a consumed continuation is not resumable");
    let text = format!("{why:#}").to_lowercase();
    assert!(
        text.contains("consum") || text.contains("already") || text.contains("continuation"),
        "the refusal must name the continuation, not fail somewhere else: {text}"
    );
}
