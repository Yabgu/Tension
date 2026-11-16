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
    // Required on any engine built with `epoch_interruption`, which both worlds
    // are: a store whose deadline is left at 0 traps immediately with `interrupt`.
    // The process's own guest is armed the same way (`host/guest.rs`).
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

    let mut store = Store::new(&worlds.process().engine(), ());
    store.set_epoch_deadline(u64::MAX);
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
