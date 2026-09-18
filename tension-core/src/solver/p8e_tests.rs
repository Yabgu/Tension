//! P8e tests: `source: "world"` end-to-end through the `tension::solver`
//! host imports — the config's embedded YAML compiled host-side to bytes,
//! `dim` synthesized from the compiled header, and the P8d evaluator bound
//! as the shim's derivative.
//!
//! These live beside the P5 tests, and for the same reason: they exercise
//! the bin's host imports through real wasmtime instantiations, which the
//! integration tests under `tests/` cannot reach. The fixture guests are
//! hand-written WAT; the worlds are real YAML compiled by the real P8c
//! compiler, and the state vectors are hand-computed.
//!
//! Fixture convention: each guest writes its observations into fixed guest
//! memory addresses — 400 id, 408+ rcs, 424+ `t`, 432+ `y`, 512 `y0`
//! input, 1024/1536 the config wire (the §12 layout, built by
//! `test_support::Wire`). No function table is exported: the world path must
//! not need one.

use super::test_support::Wire;
use super::{link_solver, SolverHost};
use crate::ai::stub::StubAdapter;
use crate::audio::headless::HeadlessAdapter;
use crate::{ai, audio, HostState};
use wasmtime::{Config, Engine, Instance, Linker, Memory, Module, Store};

/// The P5 and P8e tests share the shim's process-global solver table, so
/// they serialize on the one lock in `mod.rs`.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    super::TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

// ── config construction ────────────────────────────────────────────────

/// A world-source wire: `method` plus the YAML in the `world` entry. `dim`
/// is never stated — the host derives it (§12), and the decoder refuses a
/// wire that states one.
fn world_wire(method: &str, yaml: &str) -> Wire {
    Wire::new(method, "world").world(yaml)
}

// ── fixture guests ─────────────────────────────────────────────────────

/// One solver: create from `config` at 1024, seed `y0` at 512, take
/// `steps` steps of `dt`, read the state back, destroy.
///
/// Observations: 400 id, 408 set_state rc, 412 last step rc, 416 state rc,
/// 424 `t`, 432 `y` (dim slots).
fn world_guest(wire: &Wire, y0: &[f64], steps: i32, dt: f64) -> String {
    let stores: String = y0
        .iter()
        .enumerate()
        .map(|(i, v)| format!("    (f64.store (i32.const {}) (f64.const {v}))\n", 512 + i * 8))
        .collect();
    let dim = y0.len();
    format!(
        r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (data (i32.const 1024) "{wire_hex}")
  (func (export "_start_game")
    (local $id i32)
    (local $n i32)
    ;; the three callback indices are ignored for source: world
    (local.set $id (call $create
      (i32.const 1024) (i32.const {wire_len}) (i32.const 0) (i32.const 0) (i32.const 0)))
    (i32.store (i32.const 400) (local.get $id))
{stores}    (i32.store (i32.const 408)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const {dim})))
    (local.set $n (i32.const {steps}))
    (block $done
      (loop $again
        (br_if $done (i32.eqz (local.get $n)))
        (i32.store (i32.const 412)
          (call $step (local.get $id) (f64.const {dt})))
        (local.set $n (i32.sub (local.get $n) (i32.const 1)))
        (br $again)))
    (i32.store (i32.const 416)
      (call $state (local.get $id) (i32.const 424) (i32.const 432) (i32.const {dim})))
    (call $destroy (local.get $id))))
"#,
        wire_hex = wire.wat(),
        wire_len = wire.len(),
        stores = stores,
        dim = dim,
        steps = steps,
        dt = dt,
    )
}

/// Two solvers in one module, each with its own world: `make_a`/`make_b`
/// create and seed (y0 at 512), `step_a`/`step_b` take one 0.1 step and
/// read the state back, `kill_a`/`kill_b` destroy.
///
/// Observations: 400/404 ids, 408/412 set_state rcs, 416/420 step rcs,
/// 424/428 state rcs, 432/440 `t`/`y` (A, y through 471), 472/480 `t`/`y`
/// (B, y through 511; the seed input at 512 abuts it).
fn two_solver_guest(wire_a: &Wire, wire_b: &Wire) -> String {
    format!(
        r#"
(module
  (import "tension::solver" "solver_create" (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_step" (func $step (param i32 f64) (result i32)))
  (import "tension::solver" "solver_state" (func $state (param i32 i32 i32 i32) (result i32)))
  (import "tension::solver" "solver_set_state" (func $set_state (param i32 f64 i32 i32) (result i32)))
  (import "tension::solver" "solver_destroy" (func $destroy (param i32)))
  (memory (export "memory") 3)
  (data (i32.const 1024) "{a_hex}")
  (data (i32.const 1536) "{b_hex}")
  (func $seed (param $id i32)
    (f64.store (i32.const 512) (f64.const 0.0))
    (f64.store (i32.const 520) (f64.const 0.0))
    (f64.store (i32.const 528) (f64.const 1.0))
    (f64.store (i32.const 536) (f64.const 0.0)))
  (func (export "make_a")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 1024) (i32.const {alen}) (i32.const 0) (i32.const 0) (i32.const 0)))
    (i32.store (i32.const 400) (local.get $id))
    (call $seed (local.get $id))
    (i32.store (i32.const 408)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 4))))
  (func (export "make_b")
    (local $id i32)
    (local.set $id (call $create
      (i32.const 1536) (i32.const {blen}) (i32.const 0) (i32.const 0) (i32.const 0)))
    (i32.store (i32.const 404) (local.get $id))
    (call $seed (local.get $id))
    (i32.store (i32.const 412)
      (call $set_state (local.get $id) (f64.const 0.0) (i32.const 512) (i32.const 4))))
  (func (export "step_a")
    (i32.store (i32.const 416)
      (call $step (i32.load (i32.const 400)) (f64.const 0.1)))
    (i32.store (i32.const 424)
      (call $state (i32.load (i32.const 400)) (i32.const 432) (i32.const 440) (i32.const 4))))
  (func (export "step_b")
    (i32.store (i32.const 420)
      (call $step (i32.load (i32.const 404)) (f64.const 0.1)))
    (i32.store (i32.const 428)
      (call $state (i32.load (i32.const 404)) (i32.const 472) (i32.const 480) (i32.const 4))))
  (func (export "kill_a")
    (call $destroy (i32.load (i32.const 400))))
  (func (export "kill_b")
    (call $destroy (i32.load (i32.const 404)))))
"#,
        a_hex = wire_a.wat(),
        alen = wire_a.len(),
        b_hex = wire_b.wat(),
        blen = wire_b.len(),
    )
}

/// Instantiate `wat` and run `_start_game` to completion.
fn start(wat: &str) -> Guest {
    let (mut store, mut linker) = new_guest_store();
    let (instance, memory) = instantiate(&mut store, &mut linker, wat);
    call_export(&mut store, &instance, "_start_game");
    Guest { store, memory }
}

fn new_guest_store() -> (Store<HostState>, Linker<HostState>) {
    let engine = Engine::new(&Config::new()).unwrap();
    let store = Store::new(&engine, test_state());
    let mut linker: Linker<HostState> = Linker::new(&engine);
    link_solver(&mut linker).unwrap();
    (store, linker)
}

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

    /// The state vector at 432 plus `offset` slots.
    fn y_at(&self, base: usize, dim: usize) -> Vec<f64> {
        (0..dim).map(|i| self.f64_at(base + 8 * i)).collect()
    }
}

#[track_caller]
fn assert_close(got: &[f64], want: &[f64], tol: f64) {
    assert_eq!(got.len(), want.len(), "slot counts");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((g - w).abs() <= tol, "slot {i}: got {g}, want {w}");
    }
}

// ── the worlds the tests compile ───────────────────────────────────────

/// One point_mass, no connections: f = [velocity, 0].
const FREE_PARTICLE: &str = r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: p
    mass: 1.0
connections: []
"#;

/// The free particle with gravity: f = [velocity, [0, -10]].
const UNDER_GRAVITY: &str = r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: p
    mass: 1.0
connections:
  - type: gravity
    acceleration: [0.0, -10.0]
"#;

/// Anchor + bob on a unit spring: q = x - 1 obeys q'' = -q.
const OSCILLATOR: &str = r#"version: 1
dimensions: 2
components:
  - type: anchor
    name: pivot
    position: [0.0, 0.0]
  - type: point_mass
    name: bob
    mass: 1.0
connections:
  - type: spring
    name: rod
    from: pivot
    to: bob
    stiffness: 1.0
    rest_length: 1.0
"#;

// ═══ W1 ═════════════════════════════════════════════════════════════════
// A world-source solver is created, stepped, and read back: euler on the
// free particle moves the position by dt·velocity and leaves the rest
// alone. y0 = [0,0, 1,0] -> y = [0.1,0, 1,0] after one 0.1 step.

#[test]
fn w1_world_source_creates_steps_and_reads_back() {
    let _g = lock();
    let g = start(&world_guest(
        &world_wire("euler", FREE_PARTICLE),
        &[0.0, 0.0, 1.0, 0.0],
        1,
        0.1,
    ));
    let id = g.i32_at(400);
    assert!(id >= 1, "create returned {id}");
    assert_eq!(g.i32_at(408), 0, "set_state rc");
    assert_eq!(g.i32_at(412), 0, "step rc");
    assert_eq!(g.i32_at(416), 4, "state wrote dim slots");
    assert_eq!(g.f64_at(424), 0.1, "t after one step");
    assert_eq!(g.y_at(432, 4), vec![0.1, 0.0, 1.0, 0.0]);
}

// ═══ W2 ═════════════════════════════════════════════════════════════════
// The oscillator through rk45, hand-computed: with q = x - 1, q'' = -q,
// q(0) = 1, q'(0) = 0, so x(t) = 1 + cos t, v(t) = -sin t. One step of
// 1.0 at tight tolerances (which also proves the `parameters` member
// survives the config rewrite):

#[test]
fn w2_rk45_oscillator_matches_analytic() {
    let _g = lock();
    let wire = world_wire("rk45", OSCILLATOR)
        .param("relTol", 1e-10)
        .param("absTol", 1e-12);
    let g = start(&world_guest(&wire, &[2.0, 0.0, 0.0, 0.0], 1, 1.0));
    let id = g.i32_at(400);
    assert!(id >= 1, "create returned {id}");
    assert_eq!(g.i32_at(412), 0, "step rc");
    assert_eq!(g.f64_at(424), 1.0, "t after one 1.0 step");
    let want = [1.0 + 1.0f64.cos(), 0.0, -1.0f64.sin(), 0.0];
    let got = g.y_at(432, 4);
    assert_close(&got, &want, 1e-8);
    println!(
        "W2 rk45 world: x = {}, |err| = {:e}; v = {}, |err| = {:e}",
        got[0],
        (got[0] - want[0]).abs(),
        got[2],
        (got[2] - want[2]).abs()
    );
}

// ═══ W3 ═════════════════════════════════════════════════════════════════
// A world that does not compile: the host refuses with -EINVAL. The
// compiler's line/column message goes to stderr (the wasm boundary has no
// err channel — solver/DESIGN.md §9); run with --nocapture to see it.

#[test]
fn w3_compile_error_is_einval() {
    let _g = lock();
    let bad = "version: 1\ndimensions: 2\ncomponents:\n  - type: foo\n    name: c\nconnections: []\n";
    let g = start(&world_guest(&world_wire("euler", bad), &[], 0, 0.0));
    assert_eq!(g.i32_at(400), -22, "a world that does not compile is -EINVAL");
}

// ═══ W4 ═════════════════════════════════════════════════════════════════
// A world-source config must not state dim — the host derives it. The
// refusal is the host's, before any compilation.

#[test]
fn w4_stated_dim_is_einval() {
    let _g = lock();
    let wire = world_wire("euler", FREE_PARTICLE).dim(2);
    let g = start(&world_guest(&wire, &[], 0, 0.0));
    assert_eq!(g.i32_at(400), -22, "dim on a world-source config is -EINVAL");
}

// ═══ W5 ═════════════════════════════════════════════════════════════════
// A world-source config without a `world` member has no world to compile.

#[test]
fn w5_missing_world_is_einval() {
    let _g = lock();
    let g = start(&world_guest(&world_wire("euler", ""), &[], 0, 0.0));
    assert_eq!(g.i32_at(400), -22, "no `world` field is -EINVAL");
}

// ═══ W6 ═════════════════════════════════════════════════════════════════
// Two solvers, two worlds, in one module: each keeps its own compiled
// bytes, so their dynamics differ. Free particle: position advances,
// velocity holds. Under gravity: velocity falls by g·dt too. A keyed-wrong
// map would swap the two answers.

#[test]
fn w6_two_solvers_two_worlds_are_independent() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();
    let wire_a = world_wire("euler", FREE_PARTICLE);
    let wire_b = world_wire("euler", UNDER_GRAVITY);
    let (instance, mem) = instantiate(&mut store, &mut linker, &two_solver_guest(&wire_a, &wire_b));

    call_export(&mut store, &instance, "make_a");
    call_export(&mut store, &instance, "make_b");
    let id_a = read_i32(&store, &mem, 400);
    let id_b = read_i32(&store, &mem, 404);
    assert!(id_a >= 1 && id_b >= 1, "ids: {id_a}, {id_b}");
    assert_eq!(
        store.data().solver.worlds.len(),
        2,
        "one compiled world per solver"
    );

    call_export(&mut store, &instance, "step_a");
    let y_a = [read_f64(&store, &mem, 440), read_f64(&store, &mem, 448), read_f64(&store, &mem, 456), read_f64(&store, &mem, 464)];
    call_export(&mut store, &instance, "step_b");
    let y_b = [read_f64(&store, &mem, 480), read_f64(&store, &mem, 488), read_f64(&store, &mem, 496), read_f64(&store, &mem, 504)];

    assert_eq!(y_a, [0.1, 0.0, 1.0, 0.0], "free particle");
    assert_close(&y_b, &[0.1, 0.0, 1.0, -1.0], 1e-12);

    call_export(&mut store, &instance, "kill_a");
    call_export(&mut store, &instance, "kill_b");
    assert_eq!(store.data().solver.worlds.len(), 0);
}

// ═══ W7 ═════════════════════════════════════════════════════════════════
// Destroy clears the world map, and the shim reuses the id for the next
// create — which must run on the new solver's world, not the old bytes.

#[test]
fn w7_destroy_clears_and_reuse_binds_the_new_world() {
    let _g = lock();
    let (mut store, mut linker) = new_guest_store();
    let wire_a = world_wire("euler", FREE_PARTICLE);
    let wire_b = world_wire("euler", UNDER_GRAVITY);
    let (instance, mem) = instantiate(&mut store, &mut linker, &two_solver_guest(&wire_a, &wire_b));

    call_export(&mut store, &instance, "make_a");
    let id_a = read_i32(&store, &mem, 400);
    assert_eq!(store.data().solver.worlds.len(), 1);
    call_export(&mut store, &instance, "kill_a");
    assert_eq!(
        store.data().solver.worlds.len(),
        0,
        "destroy takes the bytes with the handle"
    );

    call_export(&mut store, &instance, "make_b");
    let id_b = read_i32(&store, &mem, 404);
    assert_eq!(id_b, id_a, "the shim reuses the destroyed slot");
    assert_eq!(store.data().solver.worlds.len(), 1);

    call_export(&mut store, &instance, "step_b");
    let y_b = [read_f64(&store, &mem, 480), read_f64(&store, &mem, 488), read_f64(&store, &mem, 496), read_f64(&store, &mem, 504)];
    assert_close(&y_b, &[0.1, 0.0, 1.0, -1.0], 1e-12);

    call_export(&mut store, &instance, "kill_b");
    assert_eq!(store.data().solver.worlds.len(), 0);
}

// ═══ W8 ═════════════════════════════════════════════════════════════════
// Determinism: the same YAML, the same steps, bit-identical state.

#[test]
fn w8_world_source_is_deterministic() {
    let _g = lock();
    let wire = world_wire("rk45", OSCILLATOR);
    let a = start(&world_guest(&wire, &[2.0, 0.0, 0.0, 0.0], 5, 0.1));
    let b = start(&world_guest(&wire, &[2.0, 0.0, 0.0, 0.0], 5, 0.1));
    let (ta, tb) = (a.f64_at(424), b.f64_at(424));
    assert_eq!(ta, tb, "t must match exactly");
    assert_eq!(a.y_at(432, 4), b.y_at(432, 4), "state must be bit-identical");
    println!("W8 five 0.1 rk45 steps: t = {ta}, y = {:?}", a.y_at(432, 4));
}

// ═══ W9 ═════════════════════════════════════════════════════════════════
// Interleaving: stepping A and B alternately gives each solver exactly
// what isolated stepping gives it — the bridge swap is per step and does
// not leak across solvers.

#[test]
fn w9_interleaved_solvers_match_isolated_runs() {
    let _g = lock();
    let wire_a = world_wire("euler", FREE_PARTICLE);
    let wire_b = world_wire("euler", UNDER_GRAVITY);

    // Interleaved: A, B, A, B, ...
    let (mut store, mut linker) = new_guest_store();
    let (instance, mem) = instantiate(&mut store, &mut linker, &two_solver_guest(&wire_a, &wire_b));
    call_export(&mut store, &instance, "make_a");
    call_export(&mut store, &instance, "make_b");
    for _ in 0..10 {
        call_export(&mut store, &instance, "step_a");
        call_export(&mut store, &instance, "step_b");
    }
    let inter_a = (read_f64(&store, &mem, 432), read_f64(&store, &mem, 440));
    let inter_b = (read_f64(&store, &mem, 472), read_f64(&store, &mem, 480));
    call_export(&mut store, &instance, "kill_a");
    call_export(&mut store, &instance, "kill_b");

    // Isolated: ten steps of A, then ten of B.
    let (mut store, mut linker) = new_guest_store();
    let (instance, mem) = instantiate(&mut store, &mut linker, &two_solver_guest(&wire_a, &wire_b));
    call_export(&mut store, &instance, "make_a");
    call_export(&mut store, &instance, "make_b");
    for _ in 0..10 {
        call_export(&mut store, &instance, "step_a");
    }
    for _ in 0..10 {
        call_export(&mut store, &instance, "step_b");
    }
    let solo_a = (read_f64(&store, &mem, 432), read_f64(&store, &mem, 440));
    let solo_b = (read_f64(&store, &mem, 472), read_f64(&store, &mem, 480));
    call_export(&mut store, &instance, "kill_a");
    call_export(&mut store, &instance, "kill_b");

    assert_eq!(inter_a, solo_a, "A: interleaved vs isolated");
    assert_eq!(inter_b, solo_b, "B: interleaved vs isolated");
    println!("W9 interleaved == isolated: A = {inter_a:?}, B = {inter_b:?}");
}

// ═══ W10 ════════════════════════════════════════════════════════════════
// The compiled bytes live across many steps: 100 euler steps of the free
// particle on 0.1 accumulate to t = Σ and x = Σ exactly as the same
// additions do in Rust (a dangling-bytes bug would corrupt or crash long
// before step 100; the map's ownership is what prevents it).

#[test]
fn w10_bytes_stay_alive_across_many_steps() {
    let _g = lock();
    let g = start(&world_guest(
        &world_wire("euler", FREE_PARTICLE),
        &[0.0, 0.0, 1.0, 0.0],
        100,
        0.1,
    ));
    assert_eq!(g.i32_at(412), 0, "step rc");
    let want_t: f64 = (0..100).fold(0.0, |acc, _| acc + 0.1);
    let want_x: f64 = (0..100).fold(0.0, |acc, _| acc + 0.1);
    assert_eq!(g.f64_at(424), want_t, "t accumulates exactly as the adds do");
    assert_eq!(g.y_at(432, 4), vec![want_x, 0.0, 1.0, 0.0]);
}

// ═══ W-OPT ══════════════════════════════════════════════════════════════
// The optional-callbacks TS surface (`Solver.create(configJson)`) passes
// 0/0/0 for the three indices, and the host ignores them for non-wasm
// sources (P8e) — so a complete create/step/state cycle runs with no
// callbacks at all. `examples/solver/world/` relies on exactly this.

#[test]
fn w_opt_world_source_ignores_callback_indices() {
    let _g = lock();
    let g = start(&world_guest(
        &world_wire("euler", FREE_PARTICLE),
        &[0.0, 0.0, 1.0, 0.0],
        1,
        0.1,
    ));
    let id = g.i32_at(400);
    assert!(id >= 1, "create with 0/0/0 indices returned {id}");
    assert_eq!(g.i32_at(412), 0, "step rc");
    assert_eq!(g.i32_at(416), 4, "state wrote dim slots");
    assert_eq!(g.y_at(432, 4), vec![0.1, 0.0, 1.0, 0.0]);
}

// ═══ W-REQ ══════════════════════════════════════════════════════════════
// 0/0/0 is only legal for sources that have no callbacks: a wasm-source
// config still resolves the three indices, so the same shape refuses here
// (this fixture exports no `table` at all; P5b's H5/N2 cover a bad index
// inside a real table).

#[test]
fn w_req_wasm_source_still_requires_real_indices() {
    let _g = lock();
    let g = start(&world_guest(
        &Wire::new("euler", "wasm").dim(4),
        &[],
        0,
        0.0,
    ));
    assert_eq!(g.i32_at(400), -22, "wasm-source create with 0/0/0 is refused");
}
