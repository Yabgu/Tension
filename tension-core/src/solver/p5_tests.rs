//! P5 host-side tests: the `tension::solver` imports, exercised through real
//! wasmtime instantiations with the real linker wiring.
//!
//! These live in the binary crate because that is where the host imports
//! live: `link_solver` registers over `Linker<HostState>`, and integration
//! tests under `tests/` link only the library crate. The fixtures are
//! hand-written WAT — the AssemblyScript end-to-end guest, which also
//! exercises this same path, is `examples/solver/`.
//!
//! Fixture convention: each guest writes its observations into fixed guest
//! memory addresses and the test reads them back, so the assertions live on
//! the Rust side where the values can be printed. Addresses used below:
//! 64 = config JSON, 400..416 = i32 results, 424 = `t`, 432 = `y`,
//! 512 = `set_state` input, 1024 / 66560 = the `deriv_buf_*` regions.
//!
//! Callback convention: each guest exports its function table as `table`
//! and passes the three callbacks' table indices to `solver_create`
//! (GUEST_ABI.md §3.1, §3.6). The callback functions are plain module
//! functions; only the table and the `_start_game` entry are exports,
//! unless a fixture deliberately exports a decoy (N1).

use super::{config_source_is_wasm, link_solver, SolverHost};
use crate::ai::stub::StubAdapter;
use crate::audio::headless::HeadlessAdapter;
use crate::{ai, audio, HostState};
use wasmtime::{Config, Engine, Instance, Linker, Memory, Module, Store};

/// The C shim's solver table is process-global and carries no internal
/// locking — it is built for the runtime's one-guest, one-thread model
/// (DESIGN.md §9). Tests share one process, so they serialize — across
/// test modules too, on the one lock in `mod.rs`.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    super::TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// `{"method":"euler","source":"wasm","dim":1}` — 42 bytes at 64.
const EULER_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (table (export "table") 4 funcref)
  (elem (i32.const 1) $derivative $buf_in $buf_out)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func $derivative
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store
          (i32.add (local.get $dy) (i32.mul (local.get $i) (i32.const 8)))
          (f64.neg
            (f64.load
              (i32.add (local.get $y) (i32.mul (local.get $i) (i32.const 8))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func (export "_start_game")
    (local $id i32)
    ;; create(config, derivative = index 1, buf_in = 2, buf_out = 3)
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 1) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (f64.store (i32.const 512) (f64.const 2.0))
    (i32.store (i32.const 404)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 1)))
    (i32.store (i32.const 408)
      (call $step (local.get $id) (f64.const 0.1)))
    (i32.store (i32.const 412)
      (call $state (local.get $id) (i32.const 424) (i32.const 432) (i32.const 1)))
    (call $destroy (local.get $id))))
"#;

/// `{"method":"rk45","source":"wasm","dim":1,"parameters":{"relTol":1e-8,"absTol":1e-10}}`
/// — 85 bytes at 64.
const RK45_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (table (export "table") 4 funcref)
  (elem (i32.const 1) $derivative $buf_in $buf_out)
  (data (i32.const 64) "{\"method\":\"rk45\",\"source\":\"wasm\",\"dim\":1,\"parameters\":{\"relTol\":1e-8,\"absTol\":1e-10}}")
  (func $derivative
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store
          (i32.add (local.get $dy) (i32.mul (local.get $i) (i32.const 8)))
          (f64.neg
            (f64.load
              (i32.add (local.get $y) (i32.mul (local.get $i) (i32.const 8))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func (export "_start_game")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 64) (i32.const 85) (i32.const 1) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (f64.store (i32.const 512) (f64.const 1.0))
    (i32.store (i32.const 404)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 1)))
    (i32.store (i32.const 408)
      (call $step (local.get $id) (f64.const 1.0)))
    (i32.store (i32.const 412)
      (call $state (local.get $id) (i32.const 424) (i32.const 432) (i32.const 1)))
    (call $destroy (local.get $id))))
"#;

/// Imports `tension::solver` but exports no function table; a
/// `source: "wasm"` create has nothing to resolve its indices through and
/// must refuse with -EINVAL.
const NO_TABLE_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func (export "_start_game")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 1) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (call $destroy (local.get $id))))
"#;

/// A valid table, but the create attempts pass indices that do not name a
/// function: 0 (the table's null slot) and 99 (past the table's end).
const BAD_INDEX_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 1)
  (table (export "table") 4 funcref)
  (elem (i32.const 1) $derivative $buf_in $buf_out)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func $derivative (param i32 i32 f64 i32 i32) (result i32) (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func (export "_start_game")
    (local $id i32)
    ;; the derivative index is the null slot
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 0) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (call $destroy (local.get $id))
    ;; the derivative index is past the table's end
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 99) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 404) (local.get $id))
    (call $destroy (local.get $id))))
"#;

/// A valid table whose entries are individually well-formed but wrong for
/// the slots they are passed in: a zero-argument function as the derivative,
/// and the derivative-shaped function as `buf_in`.
const WRONG_SIGNATURE_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 1)
  (table (export "table") 6 funcref)
  (elem (i32.const 1) $deriv $buf_in $buf_out $no_args)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func $deriv (param i32 i32 f64 i32 i32) (result i32) (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func $no_args (result i32) (i32.const 7))
  (func (export "_start_game")
    (local $id i32)
    ;; the derivative slot holds a zero-argument function
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 4) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (call $destroy (local.get $id))
    ;; the buf_in slot holds the derivative-shaped function
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 1) (i32.const 1) (i32.const 3)))
    (i32.store (i32.const 404) (local.get $id))
    (call $destroy (local.get $id))))
"#;

/// `EULER_GUEST`'s shape, but with the lifecycle split into explicit
/// exports so a test can observe the bound map between phases: `make`
/// creates and seeds the state, `run` takes one step and reads it back,
/// `kill` destroys. Same euler config (42 bytes at 64); f(t, y) = -y.
const EULER_KEEP_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (table (export "table") 4 funcref)
  (elem (i32.const 1) $derivative $buf_in $buf_out)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func $derivative
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store
          (i32.add (local.get $dy) (i32.mul (local.get $i) (i32.const 8)))
          (f64.neg
            (f64.load
              (i32.add (local.get $y) (i32.mul (local.get $i) (i32.const 8))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func (export "make")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 1) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (f64.store (i32.const 512) (f64.const 2.0))
    (i32.store (i32.const 404)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 1))))
  (func (export "run")
    (i32.store (i32.const 408)
      (call $step (i32.load (i32.const 400)) (f64.const 0.1)))
    (i32.store (i32.const 412)
      (call $state (i32.load (i32.const 400)) (i32.const 424) (i32.const 432) (i32.const 1))))
  (func (export "kill")
    (call $destroy (i32.load (i32.const 400)))))
"#;

/// `EULER_KEEP_GUEST` with a deliberately different derivative: f(t, y) = +y.
/// One euler step of 0.1 from y0 = 2.0 gives 2.2, not 1.8 — so a reused shim
/// id that consulted stale callbacks would be caught by the answer.
const GROW_KEEP_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (table (export "table") 4 funcref)
  (elem (i32.const 1) $derivative $buf_in $buf_out)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func $derivative
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store
          (i32.add (local.get $dy) (i32.mul (local.get $i) (i32.const 8)))
          (f64.load
            (i32.add (local.get $y) (i32.mul (local.get $i) (i32.const 8)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func (export "make")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 1) (i32.const 2) (i32.const 3)))
    (i32.store (i32.const 400) (local.get $id))
    (f64.store (i32.const 512) (f64.const 2.0))
    (i32.store (i32.const 404)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 1))))
  (func (export "run")
    (i32.store (i32.const 408)
      (call $step (i32.load (i32.const 400)) (f64.const 0.1)))
    (i32.store (i32.const 412)
      (call $state (i32.load (i32.const 400)) (i32.const 424) (i32.const 432) (i32.const 1))))
  (func (export "kill")
    (call $destroy (i32.load (i32.const 400)))))
"#;

/// N1's fixture: one module, one table, two derivatives — `$deriv_neg`
/// (f = -y) and `$deriv_double` (f = -2y) — plus a decoy function exported
/// under the old convention's name `_derivative` that is deliberately NOT in
/// the table. A host that still resolved callbacks by export name would call
/// the decoy and land nowhere near the assertions in N1.
///
/// Addresses: 400 id_a, 404 id_b, 408/412 set_state rcs, 420/428 step_a rc
/// and state rc, 424/432 t_a/y_a, 440/448 b's, 456/464 b's t/y, 512 input.
const TWO_DERIVS_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (table (export "table") 6 funcref)
  (elem (i32.const 1) $deriv_neg $deriv_double $buf_in $buf_out)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  ;; the decoy: named like the old convention, never in the table
  (func (export "_derivative")
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (f64.store (local.get $dy)
      (f64.mul (f64.const -1000.0) (f64.load (local.get $y))))
    (i32.const 0))
  (func $deriv_neg
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store
          (i32.add (local.get $dy) (i32.mul (local.get $i) (i32.const 8)))
          (f64.neg
            (f64.load
              (i32.add (local.get $y) (i32.mul (local.get $i) (i32.const 8))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))
  (func $deriv_double
        (param $y i32) (param $len i32) (param $t f64) (param $dy i32) (param $cap i32)
        (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store
          (i32.add (local.get $dy) (i32.mul (local.get $i) (i32.const 8)))
          (f64.mul (f64.const -2.0)
            (f64.load
              (i32.add (local.get $y) (i32.mul (local.get $i) (i32.const 8))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))
  (func $buf_in (result i32) (i32.const 1024))
  (func $buf_out (result i32) (i32.const 66560))
  (func (export "make_a")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 1) (i32.const 3) (i32.const 4)))
    (i32.store (i32.const 400) (local.get $id))
    (f64.store (i32.const 512) (f64.const 1.0))
    (i32.store (i32.const 408)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 1))))
  (func (export "make_b")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 64) (i32.const 42) (i32.const 2) (i32.const 3) (i32.const 4)))
    (i32.store (i32.const 404) (local.get $id))
    (f64.store (i32.const 512) (f64.const 1.0))
    (i32.store (i32.const 412)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 1))))
  (func (export "step_a")
    (i32.store (i32.const 420)
      (call $step (i32.load (i32.const 400)) (f64.const 0.1)))
    (i32.store (i32.const 428)
      (call $state (i32.load (i32.const 400)) (i32.const 424) (i32.const 432) (i32.const 1))))
  (func (export "step_b")
    (i32.store (i32.const 440)
      (call $step (i32.load (i32.const 404)) (f64.const 0.1)))
    (i32.store (i32.const 448)
      (call $state (i32.load (i32.const 404)) (i32.const 456) (i32.const 464) (i32.const 1))))
  (func (export "kill_a")
    (call $destroy (i32.load (i32.const 400))))
  (func (export "kill_b")
    (call $destroy (i32.load (i32.const 404)))))
"#;

/// A fresh store state: no CLI args, no paks, headless audio, stub AI.
fn test_state() -> HostState {
    HostState {
        args: Vec::new(),
        pending_line: None,
        res: Vec::new(),
        audio: audio::AudioSession::new(Box::new(HeadlessAdapter::new())),
        ai: ai::AiSession::new(Box::new(StubAdapter::new())),
        solver: SolverHost::default(),
    }
}

/// Instantiate `wat` against the real `tension::solver` imports and run
/// `_start_game` to completion.
fn start(wat: &str) -> Guest {
    let (mut store, mut linker) = new_guest_store();
    let (instance, memory) = instantiate(&mut store, &mut linker, wat);
    call_export(&mut store, &instance, "_start_game");
    Guest { store, memory }
}

/// A fresh store and a linker with the real solver imports registered.
fn new_guest_store() -> (Store<HostState>, Linker<HostState>) {
    let engine = Engine::new(&Config::new()).unwrap();
    let store = Store::new(&engine, test_state());
    let mut linker: Linker<HostState> = Linker::new(&engine);
    link_solver(&mut linker).unwrap();
    (store, linker)
}

/// Compile `wat` and instantiate it into `store`.
fn instantiate(
    store: &mut Store<HostState>,
    linker: &mut Linker<HostState>,
    wat: &str,
) -> (Instance, Memory) {
    let module = Module::new(store.engine(), wat).unwrap();
    let instance = linker.instantiate(&mut *store, &module).unwrap();
    let memory = instance.get_memory(&mut *store, "memory").unwrap();
    (instance, memory)
}

/// Call a `() -> ()` export to completion.
fn call_export(store: &mut Store<HostState>, instance: &Instance, name: &str) {
    instance
        .get_typed_func::<(), ()>(&mut *store, name)
        .unwrap()
        .call(&mut *store, ())
        .unwrap();
}

fn read_i32(store: &Store<HostState>, memory: &Memory, addr: usize) -> i32 {
    let mut buf = [0u8; 4];
    memory.read(store, addr, &mut buf).unwrap();
    i32::from_le_bytes(buf)
}

fn read_f64(store: &Store<HostState>, memory: &Memory, addr: usize) -> f64 {
    let mut buf = [0u8; 8];
    memory.read(store, addr, &mut buf).unwrap();
    f64::from_le_bytes(buf)
}

fn read_bytes(store: &Store<HostState>, memory: &Memory, addr: usize, len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    memory.read(store, addr, &mut buf).unwrap();
    buf
}

struct Guest {
    store: Store<HostState>,
    memory: Memory,
}

impl Guest {
    fn i32_at(&self, addr: usize) -> i32 {
        read_i32(&self.store, &self.memory, addr)
    }

    fn f64_at(&self, addr: usize) -> f64 {
        read_f64(&self.store, &self.memory, addr)
    }

    fn bytes_at(&self, addr: usize, len: usize) -> Vec<u8> {
        read_bytes(&self.store, &self.memory, addr, len)
    }
}

// ── H1–H5 ─────────────────────────────────────────────────────────────

#[test]
fn h1_guest_imports_link_and_run() {
    let _g = lock();
    let g = start(EULER_GUEST);
    let id = g.i32_at(400);
    assert!(id >= 1, "create returned {id}");
    assert_eq!(g.i32_at(404), 0, "set_state rc");
    assert_eq!(g.i32_at(408), 0, "step rc");
    assert_eq!(g.i32_at(412), 1, "state rc");
    println!("H1 create id = {id}, set_state/step/state all succeeded");
}

#[test]
fn h2_euler_one_step_matches_analytic() {
    let _g = lock();
    let g = start(EULER_GUEST);
    let t = g.f64_at(424);
    let y = g.f64_at(432);
    assert_eq!(t, 0.1, "t after one step");
    let expected = 1.8; // y0 = 2.0, y' = -y, one euler step of 0.1
    let err = (y - expected).abs();
    assert!(err <= 1e-12, "y = {y}, |y - 1.8| = {err:e}");
    println!("H2 euler dt=0.1 through the guest: y = {y}, |y - 1.8| = {err:e}");
}

#[test]
fn h3_rk45_one_step_matches_analytic() {
    let _g = lock();
    let g = start(RK45_GUEST);
    let t = g.f64_at(424);
    let y = g.f64_at(432);
    assert_eq!(t, 1.0, "t after one step");
    let exact = (-1.0f64).exp();
    let err = (y - exact).abs();
    assert!(err <= 1e-8, "y = {y}, exact e^-1 = {exact}, |err| = {err:e}");
    println!("H3 rk45 dt=1.0 through the guest: y = {y}, |y - e^-1| = {err:e}");
}

#[test]
fn h4_determinism_two_runs_bit_identical() {
    let _g = lock();
    let a = start(RK45_GUEST);
    let b = start(RK45_GUEST);
    let (ta, tb) = (a.bytes_at(424, 16), b.bytes_at(424, 16));
    assert_eq!(ta, tb, "t and y must be bit-identical across runs");
    println!("H4 two runs bit-identical over t,y = {ta:02x?}");
}

#[test]
fn h5_bad_indices_refused_at_create() {
    let _g = lock();

    // Indices that do not name a function: 0 (the table's null slot) and 99
    // (past the table's end). Both refuse with -EINVAL.
    let (mut store, mut linker) = new_guest_store();
    let (instance, mem) = instantiate(&mut store, &mut linker, BAD_INDEX_GUEST);
    call_export(&mut store, &instance, "_start_game");
    assert_eq!(read_i32(&store, &mem, 400), -22, "index 0 is the null slot");
    assert_eq!(read_i32(&store, &mem, 404), -22, "index 99 is past the table");
    assert_eq!(
        store.data().solver.bound.len(),
        0,
        "no binding survives a refusal"
    );

    // A module that exports no table has nothing to resolve indices through.
    let (mut store, mut linker) = new_guest_store();
    let (instance, mem) = instantiate(&mut store, &mut linker, NO_TABLE_GUEST);
    call_export(&mut store, &instance, "_start_game");
    assert_eq!(
        read_i32(&store, &mem, 400),
        -22,
        "create with source: wasm and no table export must be -EINVAL"
    );
    assert_eq!(store.data().solver.bound.len(), 0);
}

// ── L1–L3: the bound-map lifecycle ────────────────────────────────────

#[test]
fn l1_destroy_clears_the_bound_map() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();
    let (instance, _mem) = instantiate(&mut store, &mut linker, EULER_KEEP_GUEST);

    call_export(&mut store, &instance, "make");
    assert_eq!(
        store.data().solver.bound.len(),
        1,
        "create inserts one wasm-source binding"
    );

    call_export(&mut store, &instance, "kill");
    assert_eq!(
        store.data().solver.bound.len(),
        0,
        "destroy must remove the binding (it must not outlive the handle)"
    );
}

#[test]
fn l2_reused_id_rebinds_to_the_current_guest() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();

    // Generation A: f(t, y) = -y. One euler step of 0.1 from 2.0 -> 1.8.
    let (a, a_mem) = instantiate(&mut store, &mut linker, EULER_KEEP_GUEST);
    call_export(&mut store, &a, "make");
    assert_eq!(store.data().solver.bound.len(), 1);
    call_export(&mut store, &a, "run");
    let a_id = read_i32(&store, &a_mem, 400);
    let a_y = read_f64(&store, &a_mem, 432);
    call_export(&mut store, &a, "kill");
    assert_eq!(
        store.data().solver.bound.len(),
        0,
        "A's binding went away with its destroy"
    );

    // Generation B: f(t, y) = +y, same config. Destroy freed the slot, so
    // the shim hands the next create the same id (its scan takes the first
    // free slot; P2's T7 premise).
    let (b, b_mem) = instantiate(&mut store, &mut linker, GROW_KEEP_GUEST);
    call_export(&mut store, &b, "make");
    let b_id = read_i32(&store, &b_mem, 400);
    assert_eq!(b_id, a_id, "the shim reuses the destroyed id");
    assert_eq!(
        store.data().solver.bound.len(),
        1,
        "B has exactly its own binding"
    );
    call_export(&mut store, &b, "run");
    let b_y = read_f64(&store, &b_mem, 432);
    call_export(&mut store, &b, "kill");
    assert_eq!(store.data().solver.bound.len(), 0);

    // The answers must be each guest's own: A integrated -y, B integrated +y.
    assert!((a_y - 1.8).abs() <= 1e-12, "A: y = {a_y}");
    assert!((b_y - 2.2).abs() <= 1e-12, "B: y = {b_y} (must be +y's answer)");
    println!("L2 id {a_id} reused for B: A y = {a_y} (f = -y), B y = {b_y} (f = +y)");
}

#[test]
fn l3_refused_create_leaves_no_binding() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();

    // Baseline: a normal create/destroy cycle (the fixture destroys at the
    // end), so the table is clean and the refused create below takes the
    // same slot.
    let (base, base_mem) = instantiate(&mut store, &mut linker, EULER_GUEST);
    call_export(&mut store, &base, "_start_game");
    let base_id = read_i32(&store, &base_mem, 400);
    assert_eq!(store.data().solver.bound.len(), 0);

    // A refused create: the module exports no table, so the three indices
    // cannot resolve. The import refuses at create (-EINVAL) and destroys
    // the shim handle it had just made.
    let (bad, bad_mem) = instantiate(&mut store, &mut linker, NO_TABLE_GUEST);
    call_export(&mut store, &bad, "_start_game");
    assert_eq!(read_i32(&store, &bad_mem, 400), -22, "refused with -EINVAL");
    assert_eq!(
        store.data().solver.bound.len(),
        0,
        "no binding survives the refusal (none was created)"
    );

    // The refused handle's slot was released: the next create lands on the
    // baseline's id again.
    let (ok, ok_mem) = instantiate(&mut store, &mut linker, EULER_GUEST);
    call_export(&mut store, &ok, "_start_game");
    let id = read_i32(&store, &ok_mem, 400);
    assert_eq!(id, base_id, "the refused create's slot came back for reuse");
    assert_eq!(store.data().solver.bound.len(), 0, "the fixture destroys at the end");
}

// ── N1–N2: the callbacks are per-solver ───────────────────────────────

#[test]
fn n1_two_solvers_two_derivatives() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();
    let (instance, mem) = instantiate(&mut store, &mut linker, TWO_DERIVS_GUEST);

    call_export(&mut store, &instance, "make_a");
    call_export(&mut store, &instance, "make_b");
    let id_a = read_i32(&store, &mem, 400);
    let id_b = read_i32(&store, &mem, 404);
    assert!(id_a >= 1 && id_b >= 1, "both solvers exist: {id_a}, {id_b}");
    assert_ne!(id_a, id_b, "two handles, not one");
    assert_eq!(store.data().solver.bound.len(), 2, "one binding per solver");

    // A integrates y' = -y, B integrates y' = -2y; both from y0 = 1.
    call_export(&mut store, &instance, "step_a");
    assert_eq!(read_i32(&store, &mem, 420), 0, "A step rc");
    let y_a = read_f64(&store, &mem, 432);
    assert!((y_a - 0.9).abs() <= 1e-12, "A: y = {y_a}, expected 0.9");

    call_export(&mut store, &instance, "step_b");
    assert_eq!(read_i32(&store, &mem, 440), 0, "B step rc");
    let y_b = read_f64(&store, &mem, 464);
    assert!((y_b - 0.8).abs() <= 1e-12, "B: y = {y_b}, expected 0.8");

    // A steps again, after B's step in between: its binding persisted.
    call_export(&mut store, &instance, "step_a");
    let y_a2 = read_f64(&store, &mem, 432);
    assert!((y_a2 - 0.81).abs() <= 1e-12, "A: y = {y_a2}, expected 0.81");

    // Independent handles: destroying A leaves B stepping on its own RHS.
    call_export(&mut store, &instance, "kill_a");
    assert_eq!(store.data().solver.bound.len(), 1, "B's binding outlives A");
    call_export(&mut store, &instance, "step_b");
    let y_b2 = read_f64(&store, &mem, 464);
    assert!((y_b2 - 0.64).abs() <= 1e-12, "B: y = {y_b2}, expected 0.64");
    call_export(&mut store, &instance, "kill_b");
    assert_eq!(store.data().solver.bound.len(), 0);

    println!("N1 A y = {y_a} then {y_a2} (f = -y); B y = {y_b} then {y_b2} (f = -2y)");
}

#[test]
fn n2_wrong_signature_index_refused() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();
    let (instance, mem) = instantiate(&mut store, &mut linker, WRONG_SIGNATURE_GUEST);
    call_export(&mut store, &instance, "_start_game");
    assert_eq!(
        read_i32(&store, &mem, 400),
        -22,
        "a zero-argument function as the derivative is -EINVAL"
    );
    assert_eq!(
        read_i32(&store, &mem, 404),
        -22,
        "the derivative-shaped function as buf_in is -EINVAL"
    );
    assert_eq!(store.data().solver.bound.len(), 0, "refusals bind nothing");
}

// ── the config probe (the source-membership decision) ─────────────────

#[test]
fn probe_reads_the_source_member() {
    // accepts
    assert!(config_source_is_wasm(
        br#"{"method":"euler","source":"wasm","dim":1}"#
    ));
    assert!(config_source_is_wasm(br#"{ "source" : "wasm" }"#));
    assert!(config_source_is_wasm(
        br#"{"parameters":{"relTol":1e-6},"method":"rk45","source":"wasm","dim":3}"#
    ));
    assert!(config_source_is_wasm(
        br#"{"description":"source: wasm","method":"euler","source":"wasm","dim":2,"dt":0.016}"#
    ));
    // refuses
    assert!(!config_source_is_wasm(br#"{"source":"native","dim":1}"#));
    assert!(!config_source_is_wasm(br#"{"method":"euler","dim":1}"#));
    assert!(!config_source_is_wasm(br#"{"source":"wasmish"}"#));
    assert!(!config_source_is_wasm(br#"{}"#));
    assert!(!config_source_is_wasm(br#"not json at all"#));
    // a decoy inside a free-text member must not fool it
    assert!(!config_source_is_wasm(
        br#"{"method":"euler","source":"native","dim":1,"description":"use \"source\":\"wasm\" here"}"#
    ));
    // \uXXXX is outside the shim's escape subset, so the probe refuses it
    // too — a config the shim would reject anyway.
    assert!(!config_source_is_wasm(br#"{"source":"wa\u0073m"}"#));
}
