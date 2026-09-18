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

use super::{config_source_is_wasm, link_solver, SolverHost};
use crate::ai::stub::StubAdapter;
use crate::audio::headless::HeadlessAdapter;
use crate::{ai, audio, HostState};
use std::sync::Mutex;
use wasmtime::{Config, Engine, Linker, Memory, Module, Store};

/// The C shim's solver table is process-global and carries no internal
/// locking — it is built for the runtime's one-guest, one-thread model
/// (DESIGN.md §9). Tests share one process, so they serialize here rather
/// than racing each other on the id table.
static SERIAL: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// `{"method":"euler","source":"wasm","dim":1}` — 42 bytes at 64.
const EULER_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func (export "_derivative")
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
  (func (export "deriv_buf_in") (result i32) (i32.const 1024))
  (func (export "deriv_buf_out") (result i32) (i32.const 66560))
  (func (export "_start_game")
    (local $id i32)
    (local.set $id (call $create (i32.const 64) (i32.const 42)))
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
  (import "tension::solver" "solver_create" (func $create (param i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (data (i32.const 64) "{\"method\":\"rk45\",\"source\":\"wasm\",\"dim\":1,\"parameters\":{\"relTol\":1e-8,\"absTol\":1e-10}}")
  (func (export "_derivative")
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
  (func (export "deriv_buf_in") (result i32) (i32.const 1024))
  (func (export "deriv_buf_out") (result i32) (i32.const 66560))
  (func (export "_start_game")
    (local $id i32)
    (local.set $id (call $create (i32.const 64) (i32.const 85)))
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

/// Imports `tension::solver` but exports none of the three convention
/// symbols; `create` must refuse it with -EINVAL.
const NO_EXPORTS_GUEST: &str = r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "{\"method\":\"euler\",\"source\":\"wasm\",\"dim\":1}")
  (func (export "_start_game")
    (local $id i32)
    (local.set $id (call $create (i32.const 64) (i32.const 42)))
    (i32.store (i32.const 400) (local.get $id))
    (call $destroy (local.get $id))))
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
    let engine = Engine::new(&Config::new()).unwrap();
    let module = Module::new(&engine, wat).unwrap();
    let mut store = Store::new(&engine, test_state());
    let mut linker: Linker<HostState> = Linker::new(&engine);
    link_solver(&mut linker).unwrap();
    let instance = linker.instantiate(&mut store, &module).unwrap();
    let memory = instance.get_memory(&mut store, "memory").unwrap();
    instance
        .get_typed_func::<(), ()>(&mut store, "_start_game")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    Guest { store, memory }
}

struct Guest {
    store: Store<HostState>,
    memory: Memory,
}

impl Guest {
    fn i32_at(&self, addr: usize) -> i32 {
        let mut buf = [0u8; 4];
        self.memory.read(&self.store, addr, &mut buf).unwrap();
        i32::from_le_bytes(buf)
    }

    fn f64_at(&self, addr: usize) -> f64 {
        let mut buf = [0u8; 8];
        self.memory.read(&self.store, addr, &mut buf).unwrap();
        f64::from_le_bytes(buf)
    }

    fn bytes_at(&self, addr: usize, len: usize) -> Vec<u8> {
        let mut buf = vec![0u8; len];
        self.memory.read(&self.store, addr, &mut buf).unwrap();
        buf
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
fn h5_missing_exports_refused_at_create() {
    let _g = lock();
    let g = start(NO_EXPORTS_GUEST);
    assert_eq!(
        g.i32_at(400),
        -22,
        "create with source: wasm and no exports must be -EINVAL"
    );
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
