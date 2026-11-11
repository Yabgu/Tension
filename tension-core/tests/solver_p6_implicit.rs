//! P6 integration tests for the implicit family (implicit_euler and bdf2).
//!
//! Direct `bind(C)` calls. For implicit Euler the algorithm under test is
//! the module's documented fixed-point iteration (tension-solver/DESIGN.md
//! §10), including its convergence window: h·L < 1. For bdf2 it is the
//! Newton-Raphson solve, which has no such window — `i8` exercises it at
//! h·λ = 10 in one dimension and `i9` on a coupled 2×2 stiff system, where
//! the Gaussian elimination has a genuine off-diagonal to eliminate.

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
    fn tension_solver_bdf2_workspace_size(dim: i32) -> i32;
    fn tension_solver_bdf2_step(
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
    // the module header and tension-solver/DESIGN.md §10 record it.)
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

// ── I8: BDF2 workspace, stiff stability, and convergence ─────────────────

#[test]
fn i8_bdf2_stiff_and_order() {
    unsafe {
        assert_eq!(tension_solver_bdf2_workspace_size(3), 7 * 3 + 1 + 9);
        assert_eq!(tension_solver_bdf2_workspace_size(1), 7 * 1 + 1 + 1);
        assert_eq!(tension_solver_bdf2_workspace_size(0), 0);
        assert_eq!(tension_solver_bdf2_workspace_size(-1), 0);
        // The dim² term outgrows a 32-bit slot count past dim ≈ 46340. A
        // wrapped size would under-allocate the Newton matrix and the step
        // would then write dim² doubles past it, so the size is refused
        // (0, which the shim turns into -EINVAL) rather than truncated.
        assert_eq!(tension_solver_bdf2_workspace_size(65536), 0);
        assert_eq!(tension_solver_bdf2_workspace_size(46341), 0);
        assert_eq!(tension_solver_bdf2_workspace_size(1024), 7 * 1024 + 1 + 1024 * 1024);
    }

    let params = default_params();
    let dim = 1;
    let ws_size = unsafe { tension_solver_bdf2_workspace_size(dim) } as usize;

    // Stiff problem: y' = -100 * y with dt = 0.1 (h * L = 10 >> 1).
    // Implicit Euler fixed-point diverges here, but BDF2 with Newton solve succeeds!
    let mut y = [1.0f64];
    let mut ws = vec![0.0f64; ws_size];
    let mut status = 0i32;
    let rc = unsafe {
        tension_solver_bdf2_step(
            y.as_mut_ptr(),
            dim,
            0.0,
            0.1,
            ws.as_mut_ptr(),
            Some(rhs_stiff),
            std::ptr::null_mut(),
            &params,
            &mut status,
        )
    };
    assert_eq!(rc, 0, "BDF2 must succeed on stiff problem where fixed-point fails");
    println!("I8 BDF2 stiff step (dt=0.1, rate=100): y = {}, status = {status} evals", y[0]);
    // Exact implicit Euler first step for y' = -k y is y_1 = y_0 / (1 + k*dt) = 1 / (1 + 10) = 1/11 ~ 0.0909
    assert!((y[0] - (1.0 / 11.0)).abs() < 1.0e-5);

    // Second step takes true BDF2:
    let rc2 = unsafe {
        tension_solver_bdf2_step(
            y.as_mut_ptr(),
            dim,
            0.1,
            0.1,
            ws.as_mut_ptr(),
            Some(rhs_stiff),
            std::ptr::null_mut(),
            &params,
            &mut status,
        )
    };
    assert_eq!(rc2, 0, "BDF2 second step must succeed");
    println!("I8 BDF2 stiff step 2: y = {}, status = {status} evals", y[0]);
    // Exact BDF2 step 2 for y' = -k y is y_2 = (4*y_1 - y_0) / (3 + 2*k*dt) = (4/11 - 1) / (3 + 20) = -7/253 ~ -0.027668
    let exact_y2 = -7.0 / 253.0;
    assert!((y[0] - exact_y2).abs() < 1.0e-5, "BDF2 matches exact algebraic solution");
}

// ── I9: BDF2 on a coupled 2×2 stiff system ───────────────────────────────

/// Overdamped oscillator q'' + c·q' + k·q = 0 in state form [q, v]:
/// q' = v, v' = −k·q − c·v. Chosen so the two eigenvalues are real and both
/// strongly damped (≈ −90.5 and ≈ −110.5), i.e. h·λ ≈ −9…−11 at dt = 0.1 —
/// far outside explicit Euler's bound (2) and the fixed-point implicit
/// window (1).
const OSC_K: f64 = 1.0e4;
const OSC_C: f64 = 201.0;

/// The system matrix A = [[0, 1], [−k, −c]]. Non-symmetric, with real
/// off-diagonal entries, so the Newton matrix keeps a genuine 2×2 coupling
/// and the elimination cannot collapse to two independent 1×1 solves.
const OSC_A: [[f64; 2]; 2] = [[0.0, 1.0], [-OSC_K, -OSC_C]];

/// y' = A·y for the oscillator.
unsafe extern "C" fn rhs_oscillator(
    y: *const f64,
    len: i32,
    _t: f64,
    dy: *mut f64,
    cap: i32,
) -> i32 {
    if len != 2 || cap < 2 {
        return -22;
    }
    let (q, v) = (*y, *y.add(1));
    let a = &OSC_A;
    *dy = a[0][0] * q + a[0][1] * v;
    *dy.add(1) = a[1][0] * q + a[1][1] * v;
    0
}

fn bdf2_step_raw(
    y: &mut [f64],
    ws: &mut [f64],
    t: f64,
    dt: f64,
    params: &Params,
    rhs: Rhs,
) -> (i32, i32) {
    let mut status = 0i32;
    let rc = unsafe {
        tension_solver_bdf2_step(
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

/// Solve a 2×2 system by Cramer's rule — an oracle independent of the
/// Fortran Gaussian elimination under test.
fn solve2(m: [[f64; 2]; 2], rhs: [f64; 2]) -> [f64; 2] {
    let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    assert!(det.abs() > 1.0e-12, "oracle system is singular");
    [
        (rhs[0] * m[1][1] - m[0][1] * rhs[1]) / det,
        (m[0][0] * rhs[1] - rhs[0] * m[1][0]) / det,
    ]
}

/// The exact update BDF2 must produce for a *linear* ODE, where Newton
/// converges to the algebraic solution (I − alpha·A)·y_next = y_star.
fn bdf2_oracle(alpha: f64, y_star: [f64; 2], a: &[[f64; 2]; 2]) -> [f64; 2] {
    solve2(
        [
            [1.0 - alpha * a[0][0], -alpha * a[0][1]],
            [-alpha * a[1][0], 1.0 - alpha * a[1][1]],
        ],
        y_star,
    )
}

fn close2(got: &[f64], want: &[f64; 2], what: &str) {
    for i in 0..2 {
        let tol = 1.0e-6 * want[i].abs().max(1.0);
        assert!(
            (got[i] - want[i]).abs() <= tol,
            "{what}: component {i}: got {:e}, want {:e} (tol {tol:e})",
            got[i],
            want[i]
        );
    }
}

#[test]
fn i9_bdf2_2d_coupled_stiff() {
    let params = default_params();
    let dim = 2usize;
    let dt = 0.1;
    let y0 = [1.0f64, 0.0];

    let disc = (OSC_C * OSC_C - 4.0 * OSC_K).sqrt();
    let eig_lo = (-OSC_C - disc) / 2.0;
    let eig_hi = (-OSC_C + disc) / 2.0;
    println!(
        "I9 oscillator eigenvalues: {eig_lo:.3}, {eig_hi:.3}; h·λ = {:.3}, {:.3}",
        dt * eig_lo,
        dt * eig_hi
    );
    assert!(
        (dt * eig_lo).abs() > 2.0 && (dt * eig_hi).abs() > 2.0,
        "the system must be stiff beyond explicit Euler's stability bound"
    );

    let n = unsafe { tension_solver_bdf2_workspace_size(dim as i32) } as usize;
    let mut ws = vec![0.0f64; n];

    // Step 1 — backward Euler, (I − h·A)·y₁ = y₀.
    let mut y = y0;
    let (rc1, st1) = bdf2_step_raw(&mut y, &mut ws, 0.0, dt, &params, rhs_oscillator);
    assert_eq!(rc1, 0, "first (backward-Euler) step must converge");
    assert!(st1 > 0, "a successful step reports its evaluations");
    let want1 = bdf2_oracle(dt, y0, &OSC_A);
    close2(&y, &want1, "backward-Euler step");
    println!("I9 step 1 (backward Euler): y = [{:e}, {:e}] ({st1} evals)", y[0], y[1]);

    // Step 2 — true BDF2, (I − 2h/3·A)·y₂ = (4·y₁ − y₀)/3.
    let y1 = y;
    let (rc2, st2) = bdf2_step_raw(&mut y, &mut ws, dt, dt, &params, rhs_oscillator);
    assert_eq!(rc2, 0, "second (BDF2) step must converge");
    let y_star = [
        (4.0 * y1[0] - y0[0]) / 3.0,
        (4.0 * y1[1] - y0[1]) / 3.0,
    ];
    let want2 = bdf2_oracle(2.0 * dt / 3.0, y_star, &OSC_A);
    close2(&y, &want2, "BDF2 step");
    println!("I9 step 2 (BDF2): y = [{:e}, {:e}] ({st2} evals)", y[0], y[1]);

    // A long stiff horizon: h·λ ≈ −10 throughout, so the iterate must stay
    // bounded and decay to rest. Fixed-point implicit Euler diverges here,
    // which is what the Newton solve buys.
    let mut y = y0;
    let mut ws = vec![0.0f64; n];
    let mut t = 0.0;
    for k in 0..200 {
        let (rc, _) = bdf2_step_raw(&mut y, &mut ws, t, dt, &params, rhs_oscillator);
        assert_eq!(rc, 0, "step {k} at h·λ ≈ −10 must converge");
        t += dt;
        assert!(y[0].is_finite() && y[1].is_finite(), "step {k}: must not diverge");
        assert!(y[0].abs() <= 1.0, "step {k}: position stays bounded");
        assert!(y[1].abs() <= 1.0e3, "step {k}: velocity stays bounded");
    }
    println!("I9 after 200 coupled stiff steps: y = [{:e}, {:e}]", y[0], y[1]);
    assert!(
        y[0].abs() < 1.0e-9 && y[1].abs() < 1.0e-9,
        "the oscillator comes to rest: got y = {y:?}"
    );
}
