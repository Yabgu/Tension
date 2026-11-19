//! A shared memory must be accepted by the host's engine, and two `Store`s over
//! one `SharedMemory` must genuinely see each other's writes.
//!
//! The engine `main` builds sets `wasm_threads(true)` and `shared_memory(true)`
//! (see the comment on that line in `src/main.rs` — `shared_memory` also carries
//! the tier-2 risk note). Wasmtime 50 gates the *threads proposal* per engine
//! and the *creation* of a shared memory per engine, separately; the default
//! `Config::new()` has the proposal on and creation off, which is exactly the
//! combination that refuses a module the compiler can emit.
//!
//! The module is hand-written WAT rather than compiler output, so the property
//! under test is the engine's: `(import "env" "memory" (memory 1 4096 shared))`
//! is the injected form TensionScript emits with `--importMemory`, and it is the
//! only form a host-supplied `SharedMemory` can satisfy.

use std::thread;

use wasmtime::{Config, Engine, Instance, MemoryType, Module, SharedMemory, Store};

/// One imported shared memory, plus the four exports the test needs: a plain
/// `store`/`load` pair for the two-store visibility check, and `bump`/`count`
/// over `i32.atomic.rmw.add` at address 0 for the concurrent one.
const SHARED_MODULE: &str = r#"
(module
  (import "env" "memory" (memory 1 4096 shared))
  (func (export "store") (param i32 i32)
    (i32.store (local.get 0) (local.get 1)))
  (func (export "load") (param i32) (result i32)
    (i32.load (local.get 0)))
  (func (export "bump") (param $n i32)
    (local $i i32)
    (block $done
      (loop $again
        (br_if $done (i32.eq (local.get $i) (local.get $n)))
        (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $again))))
  (func (export "count") (result i32)
    (i32.atomic.load (i32.const 0))))
"#;

/// The same memory declared rather than imported, as TensionScript emits by
/// default: the shape a default engine must refuse.
const DEFINED_SHARED_MODULE: &str = r#"
(module
  (memory 1 4096 shared)
  (func (export "nop")))
"#;

/// The engine the host builds, for the two reasons recorded in `src/main.rs`.
fn host_engine() -> Engine {
    let mut config = Config::new();
    config.wasm_threads(true);
    config.shared_memory(true);
    Engine::new(&config).expect("an engine with shared memory")
}

fn host_memory(engine: &Engine) -> SharedMemory {
    // Both arguments are in 64 KiB pages and both are required: a shared memory
    // cannot grow its reservation, so wasmtime needs the maximum up front.
    SharedMemory::new(engine, MemoryType::shared(1, 4096)).expect("a shared memory")
}

/// Instantiates the module in a fresh `Store` over the given memory.
fn instance(engine: &Engine, module: &Module, memory: &SharedMemory) -> (Store<()>, Instance) {
    let mut store = Store::new(engine, ());
    let instance = Instance::new(&mut store, module, &[memory.clone().into()])
        .expect("the module instantiates over the shared memory");
    (store, instance)
}

#[test]
fn shared_memory_is_refused_without_the_knob() {
    let engine = Engine::new(&Config::new()).expect("a default engine");
    // Wasmtime refuses at compile time when it can: the memory type is refused
    // before the module is made runnable. The instance step is kept so the test
    // still holds if that refusal ever moves later in the pipeline.
    let error = Module::new(&engine, DEFINED_SHARED_MODULE)
        .and_then(|module| {
            let mut store = Store::new(&engine, ());
            Instance::new(&mut store, &module, &[]).map(|_| module)
        })
        .expect_err("a default engine must refuse a shared memory");
    // `Display` is the outermost context only; the cause chain carries the
    // reason, and `Debug` is what renders it.
    let message = format!("{error:?}");
    assert!(
        message.contains("shared memory"),
        "the refusal should name shared memory, got: {message}"
    );
}

#[test]
fn two_stores_share_one_memory() {
    let engine = host_engine();
    let module = Module::new(&engine, SHARED_MODULE).expect("the module compiles");
    let memory = host_memory(&engine);

    let (mut store_a, instance_a) = instance(&engine, &module, &memory);
    let (mut store_b, instance_b) = instance(&engine, &module, &memory);

    let store_fn = instance_a
        .get_typed_func::<(i32, i32), ()>(&mut store_a, "store")
        .expect("`store` is exported with the declared signature");
    let load_fn = instance_b
        .get_typed_func::<i32, i32>(&mut store_b, "load")
        .expect("`load` is exported with the declared signature");

    store_fn
        .call(&mut store_a, (16, 0x1234_5678))
        .expect("instance A writes");
    let seen = load_fn
        .call(&mut store_b, 16)
        .expect("instance B reads");
    assert_eq!(
        seen, 0x1234_5678,
        "instance B must observe instance A's write through the shared memory"
    );
}

#[test]
fn concurrent_atomic_increments_lose_nothing() {
    const THREADS: usize = 2;
    const PER_THREAD: i32 = 50_000;
    // A single run can pass by luck on a two-core machine; the whole thing is
    // cheap enough (10M atomic ops total) to repeat.
    const ROUNDS: usize = 100;

    let engine = host_engine();
    let module = Module::new(&engine, SHARED_MODULE).expect("the module compiles");
    let memory = host_memory(&engine);

    // One instance outside the workers, used to reset and to read the total.
    let (mut store_main, instance_main) = instance(&engine, &module, &memory);
    let store_fn = instance_main
        .get_typed_func::<(i32, i32), ()>(&mut store_main, "store")
        .expect("`store` is exported");
    let count_fn = instance_main
        .get_typed_func::<(), i32>(&mut store_main, "count")
        .expect("`count` is exported");

    for round in 0..ROUNDS {
        store_fn
            .call(&mut store_main, (0, 0))
            .expect("the counter resets");

        let workers: Vec<_> = (0..THREADS)
            .map(|_| {
                let engine = engine.clone();
                let module = module.clone();
                let memory = memory.clone();
                thread::spawn(move || {
                    let (mut store, instance) = instance(&engine, &module, &memory);
                    let bump = instance
                        .get_typed_func::<i32, ()>(&mut store, "bump")
                        .expect("`bump` is exported");
                    bump.call(&mut store, PER_THREAD).expect("the worker bumps");
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("the worker thread finishes");
        }

        let total = count_fn
            .call(&mut store_main, ())
            .expect("the total is readable");
        assert_eq!(
            total,
            THREADS as i32 * PER_THREAD,
            "round {round}: lost updates across {THREADS} threads"
        );
    }
}
