//! P3 integration tests for the explicit-RK family (heun, rk23, rk45).
//!
//! Two layers, deliberately: T1–T8 drive the Fortran `bind(C)` wrappers
//! directly (raw symbols, like the phase-1 tests), so order and
//! controller behavior are measured without the shim in the way; T9–T12
//! go through the C shim end-to-end (create -> bind_callbacks -> step ->
//! state), which after this phase supports rk45 and friends for real.
//!
//! The shim has one process-global table, so the shim tests take turns
//! through `SERIAL`; the direct tests touch no global state at all.

use std::ffi::{c_char, c_void, CString};
use std::sync::Mutex;

static SERIAL: Mutex<()> = Mutex::new(());

/// The RHS shape of the header's `tension_solver_derivative_fn`.
type Rhs = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;
type ValidateFn = unsafe extern "C" fn(*const f64, i32, *const f64, i32, f64, *mut u8, i32) -> i32;

/// The Fortran `tension_solver_params` (bind(C), 72 bytes), mirrored by
/// `tension-solver/src/solver_params.h`. Field order and width are the ABI.
#[repr(C)]
#[derive(Clone, Copy)]
struct Params {
    rel_tol: f64,
    abs_tol: f64,
    min_step: f64,
    max_step: f64,
    fixed_step: f64,
    iterations: i32,
    convergence_tol: f64,
    compliance: f64,
    relaxation: f64,
}

fn default_params() -> Params {
    Params {
        rel_tol: 1.0e-6,
        abs_tol: 1.0e-9,
        min_step: 1.0e-12,
        max_step: f64::INFINITY,
        fixed_step: 1.0e-2,
        iterations: 10,
        convergence_tol: 1.0e-8,
        compliance: 0.0,
        relaxation: 1.0,
    }
}

/// The step-wrapper shape shared by every method (euler included).
type StepFn = unsafe extern "C" fn(
    state: *mut f64,
    dim: i32,
    t: f64,
    dt: f64,
    ws: *mut f64,
    rhs: Option<Rhs>,
    rhs_ctx: *mut c_void,
    params: *const Params,
    status: *mut i32,
) -> i32;

type WsFn = unsafe extern "C" fn(i32) -> i32;

extern "C" {
    // ── the Fortran core, direct ──
    fn tension_solver_euler_workspace_size(dim: i32) -> i32;
    fn tension_solver_euler_step(
        state: *mut f64, dim: i32, t: f64, dt: f64, ws: *mut f64,
        rhs: Option<Rhs>, rhs_ctx: *mut c_void, params: *const Params,
        status: *mut i32,
    ) -> i32;
    fn tension_solver_heun_workspace_size(dim: i32) -> i32;
    fn tension_solver_heun_step(
        state: *mut f64, dim: i32, t: f64, dt: f64, ws: *mut f64,
        rhs: Option<Rhs>, rhs_ctx: *mut c_void, params: *const Params,
        status: *mut i32,
    ) -> i32;
    fn tension_solver_rk23_workspace_size(dim: i32) -> i32;
    fn tension_solver_rk23_step(
        state: *mut f64, dim: i32, t: f64, dt: f64, ws: *mut f64,
        rhs: Option<Rhs>, rhs_ctx: *mut c_void, params: *const Params,
        status: *mut i32,
    ) -> i32;
    fn tension_solver_rk45_workspace_size(dim: i32) -> i32;
    fn tension_solver_rk45_step(
        state: *mut f64, dim: i32, t: f64, dt: f64, ws: *mut f64,
        rhs: Option<Rhs>, rhs_ctx: *mut c_void, params: *const Params,
        status: *mut i32,
    ) -> i32;

    // ── the C shim (as in P2) ──
    fn tension_solver_create(config_json: *const c_char, config_len: usize) -> i32;
    fn tension_solver_bind_callbacks(
        id: i32,
        derivative: Option<Rhs>,
        validate: Option<ValidateFn>,
    ) -> i32;
    fn tension_solver_step(id: i32, dt: f64) -> i32;
    fn tension_solver_state(id: i32, t_out: *mut f64, y_out: *mut f64, y_cap: i32) -> i32;
    fn tension_solver_set_state(id: i32, t: f64, y: *const f64, y_len: i32) -> i32;
    fn tension_solver_destroy(id: i32);
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn create(json: &str) -> i32 {
    let s = CString::new(json).unwrap();
    unsafe { tension_solver_create(s.as_ptr(), s.as_bytes().len()) }
}

// ── RHS fixtures ──────────────────────────────────────────────────────────

/// y' = -y, elementwise (any dim).
unsafe extern "C" fn rhs_decay(y: *const f64, len: i32, _t: f64, dy: *mut f64, dy_cap: i32) -> i32 {
    if dy_cap < len {
        return -22;
    }
    for i in 0..len as usize {
        *dy.add(i) = -*y.add(i);
    }
    0
}

/// f(t, y) = 0.
unsafe extern "C" fn rhs_zero(_y: *const f64, len: i32, _t: f64, dy: *mut f64, _cap: i32) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = 0.0;
    }
    0
}

/// y' = -1e5·y: stiff enough that the tolerance demands steps below a
/// 1e-6 minStep (see T6).
unsafe extern "C" fn rhs_stiff(y: *const f64, len: i32, _t: f64, dy: *mut f64, _cap: i32) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = -1.0e5 * *y.add(i);
    }
    0
}

/// Always fails with -EIO.
unsafe extern "C" fn rhs_fails(_y: *const f64, _len: i32, _t: f64, _dy: *mut f64, _cap: i32) -> i32 {
    -5
}

// ── direct-step helpers ───────────────────────────────────────────────────

/// One direct step through a method's bind(C) wrapper. Returns (rc, evals).
fn direct_step(
    step: StepFn,
    ws_size: WsFn,
    state: &mut [f64],
    t: f64,
    dt: f64,
    rhs: Rhs,
    p: &Params,
) -> (i32, i32) {
    let dim = state.len() as i32;
    let slots = unsafe { ws_size(dim) };
    assert!(slots >= 1, "workspace_size({dim}) = {slots}");
    let mut ws = vec![0.0f64; slots as usize];
    let mut status = -77i32;
    let rc = unsafe {
        step(
            state.as_mut_ptr(),
            dim,
            t,
            dt,
            ws.as_mut_ptr(),
            Some(rhs),
            std::ptr::null_mut(),
            p as *const Params,
            &mut status,
        )
    };
    (rc, status)
}

/// Integrate y' = -y from y0 = 1 over [0, 1] with `n` steps of 1/n.
/// Returns (result, total evals).
fn integrate_decay(step: StepFn, ws_size: WsFn, n: u32, p: &Params) -> (f64, i32) {
    let mut y = [1.0f64];
    let mut t = 0.0;
    let dt = 1.0 / n as f64;
    let mut evals = 0;
    for _ in 0..n {
        let (rc, status) = direct_step(step, ws_size, &mut y, t, dt, rhs_decay, p);
        assert_eq!(rc, 0, "step failed");
        evals += status;
        t += dt;
    }
    (y[0], evals)
}

// ── T1: linkage and workspace arithmetic ──────────────────────────────────

#[test]
fn t1_linkage_and_workspace() {
    // The generic formula s·dim (+ dim scratch when s > 1): euler 1·dim,
    // heun 3·dim, rk23 5·dim, rk45 8·dim.
    assert_eq!(unsafe { tension_solver_euler_workspace_size(3) }, 3);
    assert_eq!(unsafe { tension_solver_heun_workspace_size(3) }, 9);
    assert_eq!(unsafe { tension_solver_rk23_workspace_size(3) }, 15);
    assert_eq!(unsafe { tension_solver_rk45_workspace_size(3) }, 24);
    assert_eq!(unsafe { tension_solver_heun_workspace_size(0) }, 0);
    assert_eq!(unsafe { tension_solver_rk23_workspace_size(-2) }, 0);
    assert_eq!(unsafe { tension_solver_rk45_workspace_size(1) }, 8);

    // One step of each runs and reports its evaluations.
    let p = default_params();
    let mut y = [1.0f64];
    let (rc, evals) = direct_step(
        tension_solver_heun_step,
        tension_solver_heun_workspace_size,
        &mut y,
        0.0,
        0.1,
        rhs_decay,
        &p,
    );
    assert_eq!(rc, 0);
    assert_eq!(evals, 2, "heun is two evaluations per step");
    // heun on y' = -y, dt = 0.1: y·(1 - h + h²/2) = 0.905.
    assert!((y[0] - 0.905).abs() < 1.0e-12, "heun y = {}", y[0]);

    let mut y = [1.0f64];
    let (rc, evals) = direct_step(
        tension_solver_rk23_step,
        tension_solver_rk23_workspace_size,
        &mut y,
        0.0,
        0.1,
        rhs_decay,
        &p,
    );
    assert_eq!(rc, 0);
    assert!(evals >= 4, "rk23 evaluates at least its four stages");
    assert!((y[0] - (-0.1f64).exp()).abs() < 1e-4);

    let mut y = [1.0f64];
    let (rc, evals) = direct_step(
        tension_solver_rk45_step,
        tension_solver_rk45_workspace_size,
        &mut y,
        0.0,
        0.1,
        rhs_decay,
        &p,
    );
    assert_eq!(rc, 0);
    assert!(evals >= 7, "rk45 evaluates at least its seven stages");
    assert!((y[0] - (-0.1f64).exp()).abs() < 1e-9);
}

// ── T2: order verification per method ─────────────────────────────────────

#[test]
fn t2_order_verification() {
    // Tolerances loose enough that the adaptive pair never sub-steps:
    // one requested dt is one trial, so the method's own order shows.
    let loose = Params {
        rel_tol: 1.0e30,
        abs_tol: 1.0e30,
        ..default_params()
    };
    let exact = (-1.0f64).exp();

    let euler = |n: u32| (exact - integrate_decay(tension_solver_euler_step, tension_solver_euler_workspace_size, n, &loose).0).abs();
    let heun = |n: u32| (exact - integrate_decay(tension_solver_heun_step, tension_solver_heun_workspace_size, n, &loose).0).abs();
    let rk23 = |n: u32| (exact - integrate_decay(tension_solver_rk23_step, tension_solver_rk23_workspace_size, n, &loose).0).abs();
    let rk45 = |n: u32| (exact - integrate_decay(tension_solver_rk45_step, tension_solver_rk45_workspace_size, n, &loose).0).abs();

    let cases: [(&str, f64, f64, f64); 4] = [
        ("euler", euler(32), euler(64), 1.0),
        ("heun", heun(16), heun(32), 2.0),
        ("rk23", rk23(8), rk23(16), 3.0),
        ("rk45", rk45(8), rk45(16), 5.0),
    ];
    for (name, e_coarse, e_fine, nominal) in cases {
        let observed = (e_coarse / e_fine).log2();
        println!(
            "T2 {name}: err(n)={e_coarse:.3e} err(2n)={e_fine:.3e} ratio={:.2} observed order={observed:.2} (nominal {nominal})",
            e_coarse / e_fine
        );
        assert!(
            (observed - nominal).abs() <= 0.5,
            "{name}: observed order {observed} not within 0.5 of {nominal}"
        );
    }
}

// ── T3: adaptive substep count grows with tighter tolerance ───────────────

#[test]
fn t3_adaptive_substep_counts() {
    let loose = Params {
        rel_tol: 1.0e-3,
        abs_tol: 0.0,
        ..default_params()
    };
    let tight = Params {
        rel_tol: 1.0e-10,
        abs_tol: 0.0,
        ..default_params()
    };
    let exact = (-1.0f64).exp();

    let mut y_loose = [1.0f64];
    let (rc, evals_loose) = direct_step(
        tension_solver_rk45_step,
        tension_solver_rk45_workspace_size,
        &mut y_loose,
        0.0,
        1.0,
        rhs_decay,
        &loose,
    );
    assert_eq!(rc, 0);
    let err_loose = (y_loose[0] - exact).abs();

    let mut y_tight = [1.0f64];
    let (rc, evals_tight) = direct_step(
        tension_solver_rk45_step,
        tension_solver_rk45_workspace_size,
        &mut y_tight,
        0.0,
        1.0,
        rhs_decay,
        &tight,
    );
    assert_eq!(rc, 0);
    let err_tight = (y_tight[0] - exact).abs();

    println!(
        "T3 rk45 dt=1.0: relTol=1e-3 -> {evals_loose} evals, error {err_loose:.3e}; \
         relTol=1e-10 -> {evals_tight} evals, error {err_tight:.3e}"
    );
    assert!(
        evals_tight > evals_loose,
        "tighter tolerance must cost more evaluations ({evals_tight} vs {evals_loose})"
    );
    assert!(err_loose <= 1.0e-2, "loose-tolerance error {err_loose}");
    assert!(err_tight <= 1.0e-7, "tight-tolerance error {err_tight}");
}

// ── T4: determinism, bit for bit, including eval counts ───────────────────

#[test]
fn t4_determinism() {
    let p = default_params();
    let run = || -> ([f64; 2], i32) {
        let mut y = [1.0f64, -2.5];
        let (rc, evals) = direct_step(
            tension_solver_rk45_step,
            tension_solver_rk45_workspace_size,
            &mut y,
            0.0,
            0.75,
            rhs_decay,
            &p,
        );
        assert_eq!(rc, 0);
        (y, evals)
    };
    let (a, ea) = run();
    let (b, eb) = run();
    for i in 0..2 {
        assert_eq!(a[i].to_bits(), b[i].to_bits(), "element {i} differed");
    }
    assert_eq!(ea, eb, "eval counts differed");
}

// ── T5: no hidden state — interleaving matches isolated runs ──────────────

#[test]
fn t5_no_hidden_state_interleaved() {
    let pa = Params {
        rel_tol: 1.0e-7,
        abs_tol: 1.0e-10,
        ..default_params()
    };
    let pb = Params {
        rel_tol: 1.0e-5,
        abs_tol: 1.0e-8,
        ..default_params()
    };

    // A: dim 2, three steps of 0.25. B: dim 3, two steps of 0.5.
    let mut a_iso = [1.0f64, -2.5];
    for k in 0..3 {
        let (rc, _) = direct_step(
            tension_solver_rk45_step,
            tension_solver_rk45_workspace_size,
            &mut a_iso,
            0.25 * k as f64,
            0.25,
            rhs_decay,
            &pa,
        );
        assert_eq!(rc, 0);
    }
    let mut b_iso = [0.5f64, 1.0, -0.25];
    for k in 0..2 {
        let (rc, _) = direct_step(
            tension_solver_rk45_step,
            tension_solver_rk45_workspace_size,
            &mut b_iso,
            0.5 + 0.5 * k as f64,
            0.5,
            rhs_decay,
            &pb,
        );
        assert_eq!(rc, 0);
    }

    let mut a = [1.0f64, -2.5];
    let mut b = [0.5f64, 1.0, -0.25];
    for k in 0..3 {
        let (rc, _) = direct_step(
            tension_solver_rk45_step,
            tension_solver_rk45_workspace_size,
            &mut a,
            0.25 * k as f64,
            0.25,
            rhs_decay,
            &pa,
        );
        assert_eq!(rc, 0);
        if k < 2 {
            let (rc, _) = direct_step(
                tension_solver_rk45_step,
                tension_solver_rk45_workspace_size,
                &mut b,
                0.5 + 0.5 * k as f64,
                0.5,
                rhs_decay,
                &pb,
            );
            assert_eq!(rc, 0);
        }
    }

    for i in 0..2 {
        assert_eq!(a[i].to_bits(), a_iso[i].to_bits(), "A element {i} changed");
    }
    for i in 0..3 {
        assert_eq!(b[i].to_bits(), b_iso[i].to_bits(), "B element {i} changed");
    }
}

// ── T6: minStep exhaustion is -EIO, state untouched ───────────────────────

#[test]
fn t6_minstep_exhaustion() {
    // y' = -1e5·y at relTol=absTol=1e-15 wants internal steps near
    // 9.4e-8 (the DP5(4) local-error balance (λh)^6/720 ≈ 1e-15), well
    // below the 1e-6 minStep; the first requested dt = 1.0 therefore
    // exhausts before any substep is accepted.
    let p = Params {
        rel_tol: 1.0e-15,
        abs_tol: 1.0e-15,
        min_step: 1.0e-6,
        ..default_params()
    };
    let mut y = [1.0f64];
    let before = y;
    let (rc, _) = direct_step(
        tension_solver_rk45_step,
        tension_solver_rk45_workspace_size,
        &mut y,
        0.0,
        1.0,
        rhs_stiff,
        &p,
    );
    assert_eq!(rc, -5, "minStep exhaustion is -EIO");
    assert_eq!(y[0].to_bits(), before[0].to_bits(), "state must be untouched");
}

// ── T7: edges, per method ─────────────────────────────────────────────────

#[test]
fn t7_edges_per_method() {
    let p = default_params();
    let methods: [(&str, StepFn, WsFn); 4] = [
        ("euler", tension_solver_euler_step, tension_solver_euler_workspace_size),
        ("heun", tension_solver_heun_step, tension_solver_heun_workspace_size),
        ("rk23", tension_solver_rk23_step, tension_solver_rk23_workspace_size),
        ("rk45", tension_solver_rk45_step, tension_solver_rk45_workspace_size),
    ];
    for (name, step, ws) in methods {
        // dt = 0: no-op, nothing evaluated.
        let mut y = [1.5f64, -2.25];
        let before = y;
        let (rc, evals) = direct_step(step, ws, &mut y, 3.0, 0.0, rhs_decay, &p);
        assert_eq!(rc, 0, "{name}: dt=0 rc");
        assert_eq!(evals, 0, "{name}: dt=0 evaluates nothing");
        for i in 0..2 {
            assert_eq!(y[i].to_bits(), before[i].to_bits(), "{name}: dt=0 state");
        }

        // A zero RHS changes nothing; the step still runs.
        let mut y = [1.5f64, -2.25];
        let (rc, evals) = direct_step(step, ws, &mut y, 0.0, 0.1, rhs_zero, &p);
        assert_eq!(rc, 0, "{name}: zero rhs rc");
        assert!(evals >= 1, "{name}: zero rhs runs");
        assert_eq!(y, [1.5, -2.25], "{name}: zero rhs state");

        // A failing RHS propagates its errno unchanged; nothing committed.
        let mut y = [1.5f64, -2.25];
        let before = y;
        let (rc, evals) = direct_step(step, ws, &mut y, 0.0, 0.1, rhs_fails, &p);
        assert_eq!(rc, -5, "{name}: rhs failure propagates");
        assert_eq!(evals, 0, "{name}: failed step reports no evaluations");
        for i in 0..2 {
            assert_eq!(y[i].to_bits(), before[i].to_bits(), "{name}: failure state");
        }
    }
}

// ── T8: heun ignores params (fixed-step) ──────────────────────────────────

#[test]
fn t8_heun_ignores_params() {
    let p_tight = Params {
        rel_tol: 1.0e-12,
        abs_tol: 1.0e-12,
        ..default_params()
    };
    let p_loose = Params {
        rel_tol: 1.0e-3,
        abs_tol: 1.0e-3,
        ..default_params()
    };
    let run = |p: &Params| {
        let mut y = [1.0f64, 0.5];
        let (rc, evals) = direct_step(
            tension_solver_heun_step,
            tension_solver_heun_workspace_size,
            &mut y,
            0.0,
            0.2,
            rhs_decay,
            p,
        );
        assert_eq!(rc, 0);
        (y, evals)
    };
    let (a, ea) = run(&p_tight);
    let (b, eb) = run(&p_loose);
    assert_eq!(ea, eb, "heun eval count must not depend on tolerances");
    assert_eq!(ea, 2);
    for i in 0..2 {
        assert_eq!(a[i].to_bits(), b[i].to_bits(), "heun result depended on params");
    }
}

// ── T9: rk45 through the shim, end to end ─────────────────────────────────

#[test]
fn t9_shim_rk45_end_to_end() {
    let _g = lock();
    let id = create(
        r#"{"method":"rk45","source":"wasm","dim":2,"parameters":{"relTol":1e-8,"absTol":1e-10}}"#,
    );
    assert!(id >= 1, "create rk45 returned {id}");
    assert_eq!(unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) }, 0);

    let y0 = [1.0f64, 2.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, 0);

    let mut t = 0.0f64;
    let mut y = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 2) }, 2);
    assert_eq!(t, 0.5);
    let exact0 = (-0.5f64).exp();
    let exact1 = 2.0 * (-0.5f64).exp();
    println!(
        "T9 rk45 via shim: y=[{:.12}, {:.12}] exact=[{:.12}, {:.12}] errors {:.3e}/{:.3e}",
        y[0], y[1], exact0, exact1, (y[0] - exact0).abs(), (y[1] - exact1).abs()
    );
    assert!((y[0] - exact0).abs() <= 1.0e-5);
    assert!((y[1] - exact1).abs() <= 1.0e-5);
    unsafe { tension_solver_destroy(id) };
}

// ── T10: heun and rk23 through the shim ───────────────────────────────────

#[test]
fn t10_shim_heun_and_rk23_end_to_end() {
    let _g = lock();

    // heun: fixed-step trapezoid on y' = -y, y0 = 1, dt = 0.5:
    // y1 = y0·(1 - h + h²/2) = 0.625 exactly (hand-computed).
    let id = create(r#"{"method":"heun","source":"wasm","dim":1}"#);
    assert!(id >= 1, "create heun returned {id}");
    assert_eq!(unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) }, 0);
    let y0 = [1.0f64];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 1) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, 0);
    let mut t = 0.0f64;
    let mut y = [0.0f64; 1];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 1) }, 1);
    assert_eq!(t, 0.5);
    assert!((y[0] - 0.625).abs() <= 1.0e-12, "heun y = {}", y[0]);
    unsafe { tension_solver_destroy(id) };

    // rk23: adaptive 3(2), dt = 0.5, loose-ish tolerance.
    let id = create(
        r#"{"method":"rk23","source":"wasm","dim":1,"parameters":{"relTol":1e-6,"absTol":1e-9}}"#,
    );
    assert!(id >= 1, "create rk23 returned {id}");
    assert_eq!(unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) }, 0);
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 1) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, 0);
    let mut t = 0.0f64;
    let mut y = [0.0f64; 1];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 1) }, 1);
    assert_eq!(t, 0.5);
    let exact = (-0.5f64).exp();
    println!(
        "T10 rk23 via shim: y={:.12} exact={:.12} error {:.3e}",
        y[0], exact, (y[0] - exact).abs()
    );
    assert!((y[0] - exact).abs() <= 1.0e-4, "rk23 y = {}", y[0]);
    unsafe { tension_solver_destroy(id) };
}

// ── T11: out-of-range parameter is -EINVAL ────────────────────────────────

#[test]
fn t11_out_of_range_parameter() {
    let _g = lock();
    assert_eq!(
        create(r#"{"method":"rk45","source":"wasm","dim":1,"parameters":{"relTol":-1.0}}"#),
        -22
    );
    // And a max_step below min_step (an empty window) is the same shape.
    assert_eq!(
        create(
            r#"{"method":"rk45","source":"wasm","dim":1,"parameters":{"minStep":0.5,"maxStep":0.25}}"#
        ),
        -22
    );
}

// ── T12: unimplemented methods still say so ───────────────────────────────

#[test]
fn t12_verlet_still_enosys() {
    let _g = lock();
    assert_eq!(create(r#"{"method":"verlet","source":"wasm","dim":1}"#), -38);
    assert_eq!(create(r#"{"method":"implicit_euler","source":"wasm","dim":1}"#), -38);
    assert_eq!(create(r#"{"method":"spook","source":"wasm","dim":1}"#), -38);
}
