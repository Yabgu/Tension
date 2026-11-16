//! The engine boundary, asserted **structurally**.
//!
//! # What this file is for
//!
//! `docs/plan/pass-2.md`'s "One engine, not two" put three options to the user.
//! Option (a) was chosen (2026-11-16): the process runs two engines, one per
//! capability world, and the process's own guest does not get stack switching.
//!
//! A decision like that is worth exactly as much as its enforcement. "The
//! process world does not have stack switching" could mean a flag nobody reads,
//! a policy a later commit forgets, or a comment. It means here that **a module
//! containing continuation types cannot be compiled by the process engine**, and
//! this file asserts that with wasmtime's own error rather than with an
//! intention.
//!
//! # Where the refusal happens, which is the question a reviewer will ask
//!
//! At `Module::new` — **compile time**, not instantiation:
//!
//! ```text
//! failed to parse WebAssembly module
//! Caused by:
//!     cannot define continuation types when stack switching is disabled (at offset 0xe)
//! ```
//!
//! so the boundary is stronger than "it would fail to run": the bytes never
//! become a module in that world. A guest that tries to suspend on the process
//! world does not need a runtime check to stop it, because there is nothing to
//! run.
//!
//! # The third test is the reason the module cache carries a world key
//!
//! A `Module` is bound to the engine that compiled it, and wasmtime says so when
//! asked to cross: `cross-`Engine` instantiation is not currently supported`.
//! One cache keyed only by file path would hand a process-world module to a
//! sandbox store, so the key is `(world, path)` (`host/module_cache.rs`).
//!
//! **Every test builds its engines through [`engine_config`]**, the same
//! function `main` uses. A test with a hand-built `Config` would prove something
//! about a runtime this tree does not ship (the gate audit's own rule).

use std::sync::Arc;

use tension_core::engines::{engine_config, WorldKind, Worlds};
use wasmtime::{Engine, Instance, Module, Store};

/// A continuation body, exercised through the three proposals a cooperative
/// thread needs: a continuation type, `cont.new`, `suspend`, and a `resume` that
/// returns the parked continuation to a label and then finishes it.
///
/// `park()` answers 1 when the body ran and was resumed, 0 when the first
/// `resume` found it complete — so the value distinguishes "the machinery
/// worked" from "the call returned".
const CONTINUATION: &str = r#"
(module
  (type $ft (func))
  (type $ct (cont $ft))
  (tag $yield (type $ft))

  (func $body (suspend $yield))
  (elem declare func $body)

  (func (export "park") (result i32)
    (block $parked (result (ref null $ct))
      (resume $ct (on $yield $parked) (cont.new $ct (ref.func $body)))
      (return (i32.const 0)))
    (resume $ct)
    (i32.const 1)))
"#;

/// The worlds, built the way the product builds them.
fn worlds() -> Worlds {
    Worlds::new(|kind| Ok(Engine::new(&engine_config(kind, false))?))
        .expect("the process world builds on this platform")
}

/// The process world's engine refuses a continuation **at compile time**.
#[test]
fn the_process_world_refuses_a_continuation() {
    let worlds = worlds();
    let error = Module::new(&worlds.process().engine(), CONTINUATION)
        .expect_err("the process engine must not compile a continuation");

    // The whole error, so a reader of a gate log sees wasmtime's words and not
    // this test's summary of them.
    let message = format!("{error:#}");
    println!("the process world refuses:\n{message}");
    assert!(
        message.contains("stack switching is disabled"),
        "the refusal must be the feature switch, not a syntax error or a missing \
         proposal: `{message}`"
    );
    // Compile time, not instantiation: the message names a *parse*, which is what
    // makes the boundary structural rather than a runtime check that could be
    // reached in a different order.
    assert!(
        message.contains("parse WebAssembly module"),
        "the refusal must happen at `Module::new`, which is the boundary a \
         reviewer will ask about: `{message}`"
    );
}

/// The sandbox world compiles it **and runs it**, so the test above is about the
/// feature switch rather than about a module that no engine accepts.
#[test]
fn the_sandbox_world_compiles_and_runs_a_continuation() {
    let worlds = worlds();
    let sandbox = worlds.sandbox().expect("stack switching is available here");
    let module = Module::new(&sandbox.engine(), CONTINUATION)
        .expect("the sandbox world compiles a continuation");

    let mut store = Store::new(&sandbox.engine(), ());
    // Required **here**, because this is the sandbox world and its engine has
    // `epoch_interruption` on: a store left at the default deadline of 0 traps
    // immediately with `interrupt` before it runs a single instruction. The
    // process world has no such requirement — it has no checks to trip — which is
    // what the polarity test below proves rather than asserts.
    store.set_epoch_deadline(u64::MAX);

    let instance = Instance::new(&mut store, &module, &[]).expect("instantiate");
    let park = instance
        .get_typed_func::<(), i32>(&mut store, "park")
        .expect("the export");
    assert_eq!(
        park.call(&mut store, ()).expect("the call"),
        1,
        "the body must run, suspend, and be resumed — not return immediately"
    );
}

/// Two worlds are two engines, so they cannot share a compiled-code cache.
#[test]
fn the_two_worlds_are_different_engines() {
    let worlds = worlds();
    let process = worlds.process().engine();
    let sandbox = worlds.sandbox().expect("stack switching is available here");
    assert!(
        !Engine::same(&process, &sandbox.engine()),
        "the sandbox engine must not be the process engine: sharing one would put \
         both worlds in the same capability world, which is what was just fixed"
    );
}

/// A module compiled in one world is not usable in the other — the reason
/// `host/module_cache` keys by world as well as by file.
#[test]
fn a_module_from_one_world_is_not_accepted_by_the_other() {
    let worlds = worlds();
    let sandbox = worlds.sandbox().expect("stack switching is available here");
    let module = Module::new(&sandbox.engine(), CONTINUATION)
        .expect("the sandbox world compiles a continuation");

    // No deadline is armed: this is the process engine, which has no epoch
    // interruption, so there is nothing to arm. Arming one would be the inert
    // call `host/guest.rs` deliberately no longer makes.
    let mut store = Store::new(&worlds.process().engine(), ());
    let error = Instance::new(&mut store, &module, &[])
        .expect_err("a module cannot cross engines");
    let message = format!("{error:#}");
    println!("crossing worlds:\n{message}");
    assert!(
        message.contains("cross-") && message.contains("Engine"),
        "the refusal must name the engine boundary: `{message}`"
    );
}

/// Depth picks the world, and the map lives in one place.
///
/// This is the selector `dev.run` uses: a guest at depth 0 is the process's own,
/// anything nested is sandboxed. Pinned because "which engine did this guest run
/// on" is a question about the guest's nesting and nothing else.
#[test]
fn depth_selects_the_world() {
    assert_eq!(WorldKind::for_depth(0), WorldKind::Process);
    for depth in 1..=4 {
        assert_eq!(
            WorldKind::for_depth(depth),
            WorldKind::Sandbox,
            "a guest at depth {depth} is nested and runs in the sandbox world"
        );
    }
}

// ── the epoch polarity ─────────────────────────────────────────────────────

/// A loop that runs exactly as many times as it is told, and counts.
///
/// **Bounded on purpose.** The polarity test must be able to complete even if the
/// premise it tests is wrong, so the guest cannot be `SPIN`: it takes an iteration
/// count and returns how many iterations it performed, which makes "the loop ran
/// to the end" an assertion rather than an absence of a trap.
///
/// `COUNT` is one million. Measured on this machine, that call takes **0.75 ms**
/// on the process world, so the test is instant; and it is six orders of magnitude
/// more iterations than a per-backedge deadline check needs to fire, since the
/// deadline is already reached before the call begins (the check is inserted at
/// function entry and loop backedges, so a single iteration would do). One value
/// satisfies both ends of the requirement, which is why it is not tuned further.
const COUNTED_LOOP: &str = r#"
(module
  (func (export "count") (param $n i32) (result i32)
    (local $i i32)
    (local $acc i32)
    (block $done
      (loop $again
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $acc (i32.add (local.get $acc) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $again)))
    (local.get $acc)))
"#;

const COUNT: i32 = 1_000_000;

/// The sandbox world has the checks, so a reached deadline traps.
///
/// Same module, same deadline, same `increment_epoch` as the test below — only the
/// world differs. This half is what makes the other half mean "no checks were
/// compiled in" rather than "the guest finished before anything noticed".
#[test]
fn the_sandbox_world_enforces_the_epoch() {
    let worlds = worlds();
    let sandbox = worlds.sandbox().expect("stack switching is available here");
    let module = Module::new(&sandbox.engine(), COUNTED_LOOP).expect("the module compiles");

    let mut store = Store::new(&sandbox.engine(), ());
    // Deadline 1, then advance the epoch past it: the bound is reached before the
    // call, so the first check to execute must fire.
    store.set_epoch_deadline(1);
    sandbox.engine().increment_epoch();

    let instance = Instance::new(&mut store, &module, &[]).expect("instantiate");
    let count = instance
        .get_typed_func::<i32, i32>(&mut store, "count")
        .expect("the export");
    let error = count
        .call(&mut store, COUNT)
        .expect_err("a reached deadline must trap in the sandbox world");
    let message = format!("{error:#}");
    println!("the sandbox world traps:\n{message}");
    assert!(
        message.contains("interrupt"),
        "the trap must be the epoch deadline: `{message}`"
    );
}

/// The process world has no checks, so the identical sequence completes.
///
/// **Behavioural, not a flag assertion.** Nothing here asks wasmtime whether
/// `epoch_interruption` is set; it asks the compiled guest to run a million
/// iterations with the deadline already reached and the epoch already advanced,
/// and requires the right answer back. A check anywhere in that loop — function
/// entry, backedge, either — would have trapped it.
#[test]
fn the_process_world_compiles_no_epoch_checks() {
    let worlds = worlds();
    let module = Module::new(&worlds.process().engine(), COUNTED_LOOP).expect("the module compiles");

    let mut store = Store::new(&worlds.process().engine(), ());
    // Inert on this engine — measured: it returns, warns about nothing, and never
    // fires. Called anyway, because the point is that the *same* sequence which
    // traps in the sandbox world completes here.
    store.set_epoch_deadline(1);
    worlds.process().engine().increment_epoch();

    let instance = Instance::new(&mut store, &module, &[]).expect("instantiate");
    let count = instance
        .get_typed_func::<i32, i32>(&mut store, "count")
        .expect("the export");
    assert_eq!(
        count.call(&mut store, COUNT).expect("the process world must not trap"),
        COUNT,
        "every iteration must have run: the return value is the iteration count"
    );
}

/// Only a world with an epoch owns a ticker, and the process world cannot hold
/// one at all.
#[test]
fn only_the_sandbox_world_has_a_ticker() {
    let worlds = worlds();
    assert!(
        worlds.process().ticker().is_none(),
        "the process world must have no ticker: it has no epoch to advance, and a \
         watchdog there would be a guarantee the code does not make"
    );

    let sandbox = worlds.sandbox().expect("stack switching is available here");
    let first = sandbox.ticker().expect("the sandbox world is bounded");
    let second = sandbox.ticker().expect("the sandbox world is bounded");
    assert!(
        Arc::ptr_eq(&first, &second),
        "one epoch counter, one ticker: two sandboxes in this world must share it"
    );
}
