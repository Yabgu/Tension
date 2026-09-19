//! P6 integration tests for the implicit family (implicit_euler).
//!
//! Direct `bind(C)` calls. The algorithm under test is the module's
//! documented fixed-point iteration (DESIGN.md §10), including its
//! convergence window: h·L < 1.

use std::ffi::c_void;

/// The RHS shape of the header's `tension_solver_derivative_fn`.
type Rhs = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;

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

extern "C" {
    fn tension_solver_implicit_euler_workspace_size(dim: i32) -> i32;
    fn tension_solver_implicit_euler_step(
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
}

// ── RHS fixtures ──────────────────────────────────────────────────────────

/// y' = -y, elementwise (any dim).
unsafe extern "C" fn rhs_decay(y: *const f64, len: i32, _t: f64, dy: *mut f64, cap: i32) -> i32 {
    if cap < len {
        return -22;
    }
    for i in 0..len as usize {
        *dy.add(i) = -*y.add(i);
    }
    0
}

/// y' = -rate·y, elementwise: the stiffness knob.
unsafe fn decay_rate(y: *const f64, len: i32, dy: *mut f64, rate: f64) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = -rate * *y.add(i);
    }
    0
}

/// y' = -100·y.
unsafe extern "C" fn rhs_stiff(y: *const f64, len: i32, _t: f64, dy: *mut f64, cap: i32) -> i32 {
    if cap < len {
        return -22;
    }
    decay_rate(y, len, dy, 100.0)
}

/// y' = 0.
unsafe extern "C" fn rhs_zero(_y: *const f64, len: i32, _t: f64, dy: *mut f64, _cap: i32) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = 0.0;
    }
    0
}

/// Always fails with -EIO.
unsafe extern "C" fn rhs_fail(_y: *const f64, _len: i32, _t: f64, _dy: *mut f64, _cap: i32) -> i32 {
    -5
}

// ── helpers ───────────────────────────────────────────────────────────────

fn step_raw(
    y: &mut [f64],
    ws: &mut [f64],
    t: f64,
    dt: f64,
    params: &Params,
    rhs: Rhs,
) -> (i32, i32) {
    let mut status = 0i32;
    let rc = unsafe {
        tension_solver_implicit_euler_step(
            y.as_mut_ptr(),
            y.len() as i32,
            t,
            dt,
            ws.as_mut_ptr(),
            Some(rhs),
            std::ptr::null_mut(),
            params,
            &mut status,
        )
    };
    (rc, status)
}

/// `steps` implicit-Euler steps of `dt`; `Err(rc)` on the first failure.
fn run(
    steps: usize,
    dt: f64,
    y0: &[f64],
    params: &Params,
    rhs: Rhs,
) -> Result<(Vec<f64>, i32), (Vec<f64>, i32)> {
    let mut y = y0.to_vec();
    let mut ws = vec![0.0f64; 2 * y.len()];
    let mut t = 0.0f64;
    let mut status = 0i32;
    for _ in 0..steps {
        let (rc, st) = step_raw(&mut y, &mut ws, t, dt, params, rhs);
        if rc != 0 {
            return Err((y, st));
        }
        status = st;
        t += dt;
    }
    Ok((y, status))
}

fn bits(v: &[f64]) -> Vec<u64> {
    v.iter().map(|x| x.to_bits()).collect()
}

// ── I1: linkage and workspace size ────────────────────────────────────────

#[test]
fn i1_linkage_and_workspace_size() {
    unsafe {
        assert_eq!(tension_solver_implicit_euler_workspace_size(3), 6);
        assert_eq!(tension_solver_implicit_euler_workspace_size(1), 2);
        assert_eq!(tension_solver_implicit_euler_workspace_size(0), 0);
        assert_eq!(tension_solver_implicit_euler_workspace_size(-1), 0);
    }
    let params = default_params();
    let mut y = [1.0f64, 2.0];
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_decay);
    assert_eq!(rc, 0);
    assert!(status > 0);
    println!("I1 one step through the direct wrapper: status (evals) = {status}");
}

// ── I2: first-order accuracy ──────────────────────────────────────────────

#[test]
fn i2_first_order_accuracy() {
    let params = default_params();
    let exact = (-1.0f64).exp();
    let err = |n: usize| -> f64 {
        let dt = 1.0 / n as f64;
        let (y, _) = run(n, dt, &[1.0], &params, rhs_decay).unwrap();
        (y[0] - exact).abs()
    };
    let (e1, e2) = (err(64), err(128));
    let order = (e1 / e2).log2();
    println!(
        "I2 implicit Euler order: e(64) = {e1:e}, e(128) = {e2:e}, observed order = {order:.3}"
    );
    assert!(
        (order - 1.0).abs() <= 0.15,
        "observed order {order:.3} (e64 = {e1:e}, e128 = {e2:e})"
    );
}

// ── I3: the stiffness story, told honestly ────────────────────────────────

#[test]
fn i3_stiffness_window() {
    // h·L = 10: the fixed-point iteration diverges, so the method reports
    // -EIO with the state untouched rather than diverging silently. (This
    // is the specified honest failure: implicit Euler's A-stability would
    // need a Newton solve, which the derivative-only ABI cannot express —
    // the module header and DESIGN.md §10 record it.)
    let params = default_params(); // iterations 10, tol 1e-8
    let mut y = [1.0f64];
    let mut ws = [0.0f64; 2];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_stiff);
    assert_eq!(rc, -5, "h·L = 10 must be -EIO");
    assert_eq!(status, 0);
    assert_eq!(bits(&y), bits(&[1.0]), "state untouched on -EIO");

    // Inside the window (h·L = 0.5), the method is stable over a long
    // horizon: the correct asymptote, monotonically approached.
    let mut stiff = default_params();
    stiff.iterations = 64;
    let mut y = [1.0f64];
    let mut ws = [0.0f64; 2];
    let mut t = 0.0f64;
    let mut first_status = 0i32;
    let mut monotone = true;
    let mut prev = y[0].abs();
    for k in 0..200 {
        let (rc, status) = step_raw(&mut y, &mut ws, t, 0.005, &stiff, rhs_stiff);
        assert_eq!(rc, 0, "step {k} at h·L = 0.5 must converge");
        t += 0.005;
        if k == 0 {
            first_status = status;
        }
        assert!(y[0].abs() <= 1.0, "bounded");
        if y[0].abs() > prev + 1.0e-15 {
            monotone = false;
        }
        prev = y[0].abs();
    }
    println!(
        "I3 h·L=10 → -EIO, untouched; h·L=0.5, 200 steps: |y(1.0)| = {:e}, \
         first-step evals = {first_status}, monotone decay = {monotone}",
        y[0].abs()
    );
    assert!(y[0].abs() < 1.0e-10, "decays toward the correct asymptote");
    assert!(monotone, "decay must be monotone");
}

// ── I4: non-convergence is -EIO, state untouched ──────────────────────────

#[test]
fn i4_non_convergence_is_eio() {
    let mut params = default_params();
    params.iterations = 2;
    params.convergence_tol = 1.0e-12;
    let mut y = [1.0f64];
    let mut ws = [0.0f64; 2];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_stiff);
    assert_eq!(rc, -5);
    assert_eq!(status, 0);
    assert_eq!(bits(&y), bits(&[1.0]));
}

// ── I5: determinism ───────────────────────────────────────────────────────

#[test]
fn i5_determinism() {
    let params = default_params();
    let (a, sa) = run(200, 0.01, &[1.0], &params, rhs_decay).unwrap();
    let (b, sb) = run(200, 0.01, &[1.0], &params, rhs_decay).unwrap();
    assert_eq!(bits(&a), bits(&b));
    assert_eq!(sa, sb, "the two runs must use the same number of evaluations");
}

// ── I6: edges ─────────────────────────────────────────────────────────────

#[test]
fn i6_edges() {
    let params = default_params();

    // dt = 0: nothing evaluated, state bit for bit unchanged.
    let y0 = [1.0f64, 2.0];
    let mut y = y0;
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.0, &params, rhs_decay);
    assert_eq!(rc, 0);
    assert_eq!(status, 0);
    assert_eq!(bits(&y), bits(&y0));

    // y' = 0: the first guess is already the fixed point; one iteration
    // confirms it (two evaluations), nothing changes.
    let mut y = [1.0f64, 2.0];
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_zero);
    assert_eq!(rc, 0);
    assert_eq!(status, 2);
    assert_eq!(bits(&y), bits(&[1.0, 2.0]));

    // A failing RHS: errno propagates unchanged, state untouched.
    let mut y = [1.0f64, 2.0];
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_fail);
    assert_eq!(rc, -5);
    assert_eq!(status, 0);
    assert_eq!(bits(&y), bits(&[1.0, 2.0]));
}

// ── I7: iterations and convergenceTol are read ────────────────────────────

#[test]
fn i7_iterations_and_tolerance_are_read() {
    // Same RHS and dt, two tolerances: the tighter one iterates more.
    let mut loose = default_params();
    loose.convergence_tol = 1.0e-6;
    let mut tight = default_params();
    tight.convergence_tol = 1.0e-9;
    let (ya, sa) = run(1, 0.1, &[1.0], &loose, rhs_decay).unwrap();
    let (yb, sb) = run(1, 0.1, &[1.0], &tight, rhs_decay).unwrap();
    println!(
        "I7 tol 1e-6 → {sa} evals (y = {}), tol 1e-9 → {sb} evals (y = {})",
        ya[0], yb[0]
    );
    assert!(sb > sa, "tighter tolerance must take more evaluations");
    let solution = 1.0 / 1.1;
    assert!((ya[0] - solution).abs() < 1.0e-6);
    assert!((yb[0] - solution).abs() < 1.0e-6);

    // Same tolerance, two iteration caps: below what the problem needs,
    // the cap fails the step (-EIO, 0 evaluations reported); above it,
    // the step succeeds with however many iterations it took.
    let mut short = default_params();
    short.iterations = 2;
    short.convergence_tol = 1.0e-12;
    let mut long = default_params();
    long.iterations = 32;
    long.convergence_tol = 1.0e-12;
    let mut y = [1.0f64];
    let mut ws = [0.0f64; 2];
    let (rc_short, st_short) = step_raw(&mut y, &mut ws, 0.0, 0.1, &short, rhs_decay);
    let mut y = [1.0f64];
    let (rc_long, st_long) = step_raw(&mut y, &mut ws, 0.0, 0.1, &long, rhs_decay);
    println!("I7 iterations=2 → rc {rc_short} ({st_short} evals); iterations=32 → rc {rc_long} ({st_long} evals)");
    assert_eq!(rc_short, -5);
    assert_eq!(st_short, 0);
    assert_eq!(rc_long, 0);
    assert!(st_long > 2, "more than the short cap's iterations happened");
}
