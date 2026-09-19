//! P4 integration tests: the wasm source bridge.
//!
//! The bridge lives here, in Rust, not in the shim or the Fortran core —
//! both are source-agnostic and P4 confirms that by construction. This
//! file loads a wasm fixture, wraps its `_derivative` export in a plain
//! `extern "C"` trampoline, and hands that trampoline's function pointer
//! to `tension_solver_bind_callbacks`. The Fortran step loop calls it per
//! stage, believing it is any other C function; the trampoline copies the
//! state through the module's linear memory and calls into wasm.
//!
//! The ABI's `_derivative` typedef has no user-data slot (a purity
//! decision at fd8e4bd), so the trampoline reaches its wasm context
//! through a thread-local that each step call sets and clears. `step` is
//! synchronous, so that is safe; the interleaving test (T6) is the proof
//! that the swap does not leak across solvers.
//!
//! The wasm fixture (tests/fixtures/simple_deriv.wat) exports three
//! things: `_derivative` (f(t, y) = -y), and the two buffer-address
//! functions `deriv_buf_in` / `deriv_buf_out` (the copy-in / copy-out
//! convention, 64 KiB buffers, documented in the fixture itself).

use std::cell::RefCell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[path = "support/config.rs"]
mod support;

use support::Config;

use wasmtime::{Engine, Instance, Memory, Module, Store, TypedFunc};

static SERIAL: Mutex<()> = Mutex::new(());
static TRAMPOLINE_CALLS: AtomicUsize = AtomicUsize::new(0);

type DerivFn = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;
type ValidateFn = unsafe extern "C" fn(*const f64, i32, *const f64, i32, f64, *mut u8, i32) -> i32;

extern "C" {
    fn tension_solver_bind_callbacks(
        id: i32,
        derivative: Option<DerivFn>,
        validate: Option<ValidateFn>,
    ) -> i32;
    fn tension_solver_step(id: i32, dt: f64) -> i32;
    fn tension_solver_state(id: i32, t_out: *mut f64, y_out: *mut f64, y_cap: i32) -> i32;
    fn tension_solver_set_state(id: i32, t: f64, y: *const f64, y_len: i32) -> i32;
    fn tension_solver_destroy(id: i32);
}

const WAT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/simple_deriv.wat"
));

// ── the wasm context and the trampoline ──────────────────────────────────

/// The wasm side of the bridge: one store, the memory, and the three
/// typed exports the convention names.
struct WasmCtx {
    store: Store<()>,
    memory: Memory,
    derivative: TypedFunc<(i32, i32, f64, i32, i32), i32>,
    buf_in: TypedFunc<(), i32>,
    buf_out: TypedFunc<(), i32>,
}

thread_local! {
    /// The context the trampoline reads. Set by `with_wasm` around one
    /// (or a series of) synchronous `step` calls; unset otherwise, which
    /// is exactly the -EINVAL state T2 pins.
    static CTX: RefCell<Option<WasmCtx>> = const { RefCell::new(None) };
}

/// Load and instantiate the fixture, extract the three exports.
fn load_wasm() -> WasmCtx {
    let engine = Engine::default();
    let module = Module::new(&engine, WAT).expect("fixture compiles from wat text");
    let mut store = Store::new(&engine, ());
    let instance = Instance::new(&mut store, &module, &[]).expect("fixture instantiates");
    let memory = instance
        .get_memory(&mut store, "memory")
        .expect("memory export");
    let derivative = instance
        .get_typed_func::<(i32, i32, f64, i32, i32), i32>(&mut store, "_derivative")
        .expect("_derivative export");
    let buf_in = instance
        .get_typed_func::<(), i32>(&mut store, "deriv_buf_in")
        .expect("deriv_buf_in export");
    let buf_out = instance
        .get_typed_func::<(), i32>(&mut store, "deriv_buf_out")
        .expect("deriv_buf_out export");
    WasmCtx {
        store,
        memory,
        derivative,
        buf_in,
        buf_out,
    }
}

/// Run `f` with `ctx` installed in the thread-local; hand the context
/// back afterwards so the caller can keep stepping. Clearing in a
/// separate statement (not a Drop guard) keeps the "unset is -EINVAL"
/// state observable, which is what T2 checks.
fn with_wasm<T>(ctx: &mut Option<WasmCtx>, f: impl FnOnce() -> T) -> T {
    CTX.with(|cell| *cell.borrow_mut() = ctx.take());
    let out = f();
    CTX.with(|cell| *ctx = cell.borrow_mut().take());
    out
}

/// The `extern "C"` face the solver library sees: copy y in, call the
/// wasm export, copy the derivative back out. No knowledge of wasm
/// crosses this boundary beyond the addresses the fixture hands us.
unsafe extern "C" fn derivative_trampoline(
    y: *const f64,
    len: i32,
    t: f64,
    dy: *mut f64,
    dy_cap: i32,
) -> i32 {
    if y.is_null() || dy.is_null() || len < 0 {
        return -22;
    }
    CTX.with(|cell| {
        let mut borrowed = cell.borrow_mut();
        let Some(ctx) = borrowed.as_mut() else {
            return -22; // no context installed: nothing to call
        };
        let bin = match ctx.buf_in.call(&mut ctx.store, ()) {
            Ok(v) => v as usize,
            Err(_) => return -5,
        };
        let bout = match ctx.buf_out.call(&mut ctx.store, ()) {
            Ok(v) => v as usize,
            Err(_) => return -5,
        };
        let in_bytes = std::slice::from_raw_parts(y as *const u8, len as usize * 8);
        if ctx.memory.write(&mut ctx.store, bin, in_bytes).is_err() {
            return -5;
        }
        let rc = match ctx
            .derivative
            .call(&mut ctx.store, (bin as i32, len, t, bout as i32, dy_cap))
        {
            Ok(rc) => rc,
            Err(_) => return -5,
        };
        let out_bytes = std::slice::from_raw_parts_mut(dy as *mut u8, len as usize * 8);
        if ctx.memory.read(&mut ctx.store, bout, out_bytes).is_err() {
            return -5;
        }
        TRAMPOLINE_CALLS.fetch_add(1, Ordering::SeqCst);
        rc
    })
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn create(cfg: &Config) -> i32 {
    cfg.create()
}

fn as_bytes(s: &[f64]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(s.as_ptr() as *const u8, s.len() * 8) }
}

fn as_bytes_mut(s: &mut [f64]) -> &mut [u8] {
    unsafe { std::slice::from_raw_parts_mut(s.as_mut_ptr() as *mut u8, s.len() * 8) }
}

/// The plain-Rust RHS the direct (no-wasm) comparison solves use.
unsafe extern "C" fn rhs_decay(y: *const f64, len: i32, _t: f64, dy: *mut f64, _cap: i32) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = -*y.add(i);
    }
    0
}

fn read_state(id: i32, y: &mut [f64]) -> (f64, i32) {
    let mut t = 0.0f64;
    let rc = unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), y.len() as i32) };
    (t, rc)
}

// ── T1: fixture loads; the three exports work ────────────────────────────

#[test]
fn t1_fixture_exports() {
    let mut ctx = load_wasm();
    let bin = ctx.buf_in.call(&mut ctx.store, ()).unwrap();
    let bout = ctx.buf_out.call(&mut ctx.store, ()).unwrap();
    assert_eq!(bin, 1024);
    assert_eq!(bout, 66560);
    assert_ne!(bin, bout);

    // Direct use of the export, outside any solver: -y, bit for bit.
    let y = [1.0f64, -2.5, 0.0];
    ctx.memory
        .write(&mut ctx.store, bin as usize, as_bytes(&y))
        .unwrap();
    let rc = ctx
        .derivative
        .call(&mut ctx.store, (bin, 3, 0.0, bout, 3))
        .unwrap();
    assert_eq!(rc, 0);
    let mut out = [0.0f64; 3];
    ctx.memory
        .read(&mut ctx.store, bout as usize, as_bytes_mut(&mut out))
        .unwrap();
    assert_eq!(out.map(f64::to_bits), [-1.0f64, 2.5, -0.0].map(f64::to_bits));
}

// ── T2: thread-local discipline ──────────────────────────────────────────

#[test]
fn t2_thread_local_discipline() {
    let y = [1.0f64];
    let mut dy = [0.0f64];

    // Unset: -EINVAL, and nothing touched.
    let rc = unsafe { derivative_trampoline(y.as_ptr(), 1, 0.0, dy.as_mut_ptr(), 1) };
    assert_eq!(rc, -22);
    assert_eq!(dy[0], 0.0);

    // Set: the trampoline runs and the derivative appears.
    let mut ctx = Some(load_wasm());
    with_wasm(&mut ctx, || {
        let rc = unsafe { derivative_trampoline(y.as_ptr(), 1, 0.0, dy.as_mut_ptr(), 1) };
        assert_eq!(rc, 0);
        assert_eq!(dy[0], -1.0);
    });

    // Cleared again: back to -EINVAL.
    let rc = unsafe { derivative_trampoline(y.as_ptr(), 1, 0.0, dy.as_mut_ptr(), 1) };
    assert_eq!(rc, -22);
}

// ── T3: one euler step through shim + wasm ───────────────────────────────

#[test]
fn t3_euler_step_through_wasm() {
    let _g = lock();
    let mut ctx = Some(load_wasm());

    let id = create(&Config::new("euler", "wasm").dim(2));
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(derivative_trampoline), None) },
        0
    );
    let y0 = [2.0f64, 3.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);

    let rc = with_wasm(&mut ctx, || unsafe { tension_solver_step(id, 0.1) });
    assert_eq!(rc, 0);

    let mut y = [0.0f64; 2];
    let (t, n) = read_state(id, &mut y);
    assert_eq!(n, 2);
    assert_eq!(t, 0.1);
    // y' = -y, one euler step: y1 = y0 * 0.9, within 1e-12.
    assert!((y[0] - 1.8).abs() <= 1.0e-12, "y[0] = {}", y[0]);
    assert!((y[1] - 2.7).abs() <= 1.0e-12, "y[1] = {}", y[1]);
    unsafe { tension_solver_destroy(id) };
}

// ── T4: rk45 through wasm matches the direct solve ───────────────────────

fn rk45_cfg() -> Config {
    Config::new("rk45", "wasm").dim(2).rel_tol(1e-8).abs_tol(1e-10)
}

/// Solve y' = -y, y0 = [1, 2], one dt = 1.0 step through the shim, using
/// either the wasm trampoline or a plain Rust RHS.
fn rk45_solve(
    ctx: &mut Option<WasmCtx>,
    use_wasm: bool,
    calls_out: &mut usize,
) -> ([f64; 2], f64, i32) {
    let id = create(&rk45_cfg());
    assert!(id >= 1);
    // Annotated so both fn items coerce to the same pointer type.
    let rhs: Option<DerivFn> = if use_wasm {
        Some(derivative_trampoline)
    } else {
        Some(rhs_decay)
    };
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, rhs, None) },
        0
    );
    let y0 = [1.0f64, 2.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);

    TRAMPOLINE_CALLS.store(0, Ordering::SeqCst);
    let rc = with_wasm(ctx, || unsafe { tension_solver_step(id, 1.0) });
    *calls_out = TRAMPOLINE_CALLS.load(Ordering::SeqCst);

    let mut y = [0.0f64; 2];
    let (t, n) = read_state(id, &mut y);
    assert_eq!(n, 2);
    unsafe { tension_solver_destroy(id) };
    (y, t, rc)
}

#[test]
fn t4_rk45_through_wasm_matches_direct() {
    let _g = lock();
    let mut ctx = Some(load_wasm());

    let mut calls_wasm = 0;
    let (y_wasm, t_wasm, rc_wasm) = rk45_solve(&mut ctx, true, &mut calls_wasm);
    assert_eq!(rc_wasm, 0);
    assert_eq!(t_wasm, 1.0);

    let mut calls_direct = 0;
    let (y_direct, _, rc_direct) = rk45_solve(&mut None, false, &mut calls_direct);
    assert_eq!(rc_direct, 0);
    assert_eq!(calls_direct, 0, "no wasm on the direct path");

    let exact = [(-1.0f64).exp(), 2.0 * (-1.0f64).exp()];
    for i in 0..2 {
        assert!(
            (y_wasm[i] - exact[i]).abs() <= 1.0e-5,
            "component {i}: {} vs exact {}",
            y_wasm[i],
            exact[i]
        );
        assert!(
            (y_wasm[i] - y_direct[i]).abs() <= 1.0e-12,
            "component {i}: wasm {} vs direct {}",
            y_wasm[i],
            y_direct[i]
        );
    }
    let bit_identical = (0..2).all(|i| y_wasm[i].to_bits() == y_direct[i].to_bits());
    println!(
        "T4 rk45 dt=1.0: wasm={:?} direct={:?} bit-identical={bit_identical} trampoline calls={calls_wasm}",
        y_wasm, y_direct
    );
    assert!(calls_wasm > 0, "the wasm path must have called the trampoline");
}

// ── T5: determinism of the wasm path ─────────────────────────────────────

#[test]
fn t5_wasm_determinism() {
    let _g = lock();
    let mut ctx = Some(load_wasm());

    let mut calls_a = 0;
    let (a, _, rca) = rk45_solve(&mut ctx, true, &mut calls_a);
    assert_eq!(rca, 0);
    let mut calls_b = 0;
    let (b, _, rcb) = rk45_solve(&mut ctx, true, &mut calls_b);
    assert_eq!(rcb, 0);

    for i in 0..2 {
        assert_eq!(a[i].to_bits(), b[i].to_bits(), "element {i} differed");
    }
    assert_eq!(calls_a, calls_b, "eval counts differed");
    println!("T5 two wasm runs: identical bits, {calls_a} trampoline calls each");
}

// ── T6: interleaved solvers share the swap without leaking ───────────────

#[test]
fn t6_interleaved_no_leak() {
    let _g = lock();
    let mut ctx = Some(load_wasm());

    let cfg_a = Config::new("rk45", "wasm").dim(2).rel_tol(1e-7).abs_tol(1e-10);
    let cfg_b = Config::new("rk45", "wasm").dim(3).rel_tol(1e-5).abs_tol(1e-8);

    let mk = |cfg: &Config, y0: &[f64]| -> i32 {
        let id = create(cfg);
        assert!(id >= 1);
        assert_eq!(
            unsafe { tension_solver_bind_callbacks(id, Some(derivative_trampoline), None) },
            0
        );
        assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), y0.len() as i32) }, 0);
        id
    };

    // Isolated runs.
    let y0a = [1.0f64, -2.5];
    let y0b = [0.5f64, 1.0, -0.25];
    let ida = mk(&cfg_a, &y0a);
    for k in 0..3 {
        let rc = with_wasm(&mut ctx, || unsafe { tension_solver_step(ida, 0.25 * k as f64 + 0.25) });
        assert_eq!(rc, 0);
    }
    let mut a_iso = [0.0f64; 2];
    let (_, n) = read_state(ida, &mut a_iso);
    assert_eq!(n, 2);
    unsafe { tension_solver_destroy(ida) };

    let idb = mk(&cfg_b, &y0b);
    for k in 0..2 {
        let rc = with_wasm(&mut ctx, || unsafe { tension_solver_step(idb, 0.5 + 0.5 * k as f64) });
        assert_eq!(rc, 0);
    }
    let mut b_iso = [0.0f64; 3];
    let (_, n) = read_state(idb, &mut b_iso);
    assert_eq!(n, 3);
    unsafe { tension_solver_destroy(idb) };

    // Interleaved: A step, B step, A step, ...
    let ida = mk(&cfg_a, &y0a);
    let idb = mk(&cfg_b, &y0b);
    for k in 0..3 {
        let rc = with_wasm(&mut ctx, || unsafe { tension_solver_step(ida, 0.25 * k as f64 + 0.25) });
        assert_eq!(rc, 0);
        if k < 2 {
            let rc =
                with_wasm(&mut ctx, || unsafe { tension_solver_step(idb, 0.5 + 0.5 * k as f64) });
            assert_eq!(rc, 0);
        }
    }
    let mut a = [0.0f64; 2];
    read_state(ida, &mut a);
    let mut b = [0.0f64; 3];
    read_state(idb, &mut b);
    unsafe {
        tension_solver_destroy(ida);
        tension_solver_destroy(idb);
    }

    for i in 0..2 {
        assert_eq!(a[i].to_bits(), a_iso[i].to_bits(), "A element {i} changed");
    }
    for i in 0..3 {
        assert_eq!(b[i].to_bits(), b_iso[i].to_bits(), "B element {i} changed");
    }
}

// ── T7: P2's wasm bind rule survives P4 ──────────────────────────────────

#[test]
fn t7_wasm_null_bind_still_einval() {
    let _g = lock();
    let id = create(&Config::new("euler", "wasm").dim(1));
    assert!(id >= 1);
    assert_eq!(unsafe { tension_solver_bind_callbacks(id, None, None) }, -22);
    unsafe { tension_solver_destroy(id) };
}
