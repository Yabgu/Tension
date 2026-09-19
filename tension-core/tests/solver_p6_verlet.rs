//! P6 integration tests for the symplectic family (verlet).
//!
//! Direct `bind(C)` calls, like the phase-1 and phase-3 direct layers; the
//! shim is exercised separately (`solver_p6_shim.rs`). The conventions
//! under test are the module's documented ABI agreement (DESIGN.md §10):
//! state = [q, v], `_derivative` returns [q', v'] = [v, a].

use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

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
    fn tension_solver_verlet_workspace_size(dim: i32) -> i32;
    fn tension_solver_verlet_step(
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

/// Harmonic oscillator, componentwise: q'' = -q (any even dim).
/// state = [q0.., v0..]; dy = [v, a], a_i = -q_i.
unsafe extern "C" fn rhs_harmonic(y: *const f64, len: i32, _t: f64, dy: *mut f64, cap: i32) -> i32 {
    if cap < len || len % 2 != 0 {
        return -22;
    }
    let half = (len / 2) as usize;
    for i in 0..half {
        *dy.add(i) = *y.add(half + i);
        *dy.add(half + i) = -*y.add(i);
    }
    0
}

/// Zero RHS. Under the [v, a] convention this is zero velocity and zero
/// force — an equilibrium — so it leaves an equilibrium state (v = 0)
/// exactly as it was.
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

static CALL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Harmonic on the first call, -EIO afterwards (to reach the second
/// evaluation's failure path — see the module header's failure semantics).
unsafe extern "C" fn rhs_fail_second(
    y: *const f64,
    len: i32,
    t: f64,
    dy: *mut f64,
    cap: i32,
) -> i32 {
    if CALL_COUNT.fetch_add(1, Ordering::SeqCst) == 0 {
        rhs_harmonic(y, len, t, dy, cap)
    } else {
        -5
    }
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
        tension_solver_verlet_step(
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

/// `steps` verlet steps of `dt` from `y0`; returns the final state and the
/// last step's status.
fn run(steps: usize, dt: f64, y0: &[f64], params: &Params, rhs: Rhs) -> (Vec<f64>, i32) {
    let mut y = y0.to_vec();
    let mut ws = vec![0.0f64; 2 * y.len()];
    let mut t = 0.0f64;
    let mut status = 0i32;
    for _ in 0..steps {
        let (rc, st) = step_raw(&mut y, &mut ws, t, dt, params, rhs);
        assert_eq!(rc, 0, "verlet step failed");
        status = st;
        t += dt;
    }
    (y, status)
}

fn bits(v: &[f64]) -> Vec<u64> {
    v.iter().map(|x| x.to_bits()).collect()
}

// ── V1: linkage and workspace size ────────────────────────────────────────

#[test]
fn v1_linkage_and_workspace_size() {
    unsafe {
        assert_eq!(tension_solver_verlet_workspace_size(4), 8);
        assert_eq!(tension_solver_verlet_workspace_size(2), 4);
        assert_eq!(tension_solver_verlet_workspace_size(1), 0);
        assert_eq!(tension_solver_verlet_workspace_size(0), 0);
        assert_eq!(tension_solver_verlet_workspace_size(-3), 0);
    }
    // One step runs and reports its two evaluations.
    let params = default_params();
    let mut y = [1.0f64, 0.0, 0.0, 1.0]; // dim 4: q = [1, 0], v = [0, 1]
    let mut ws = [0.0f64; 8];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_harmonic);
    assert_eq!(rc, 0);
    assert_eq!(status, 2);
    println!("V1 workspace_size(4) = 8; one step ran, status = {status}");
}

// ── V2: second-order accuracy ─────────────────────────────────────────────

#[test]
fn v2_second_order_accuracy() {
    let params = default_params();
    // Measure at t = π/2, where the analytic position is 0 and sin ≠ 0, so
    // the method's O(h²) phase error shows up at first order. (At t = 2π
    // the cosine's extremum hides it: |cos(ω̃·2π) − cos(2π)| is O(h⁴),
    // a coincidence of the endpoint, not the method's order — measured
    // before this test moved.)
    let target = std::f64::consts::FRAC_PI_2;
    let err = |n: usize| -> f64 {
        let dt = target / n as f64;
        let (y, _) = run(n, dt, &[1.0, 0.0], &params, rhs_harmonic);
        y[0].abs() // q(π/2) = 0
    };
    let (e1, e2) = (err(64), err(128));
    let order = (e1 / e2).log2();
    println!(
        "V2 verlet order: e(64) = {e1:e}, e(128) = {e2:e}, observed order = {order:.3}"
    );
    assert!(
        (order - 2.0).abs() <= 0.15,
        "observed order {order:.3} (e64 = {e1:e}, e128 = {e2:e})"
    );
}

// ── V3: energy conservation over 100 periods ──────────────────────────────

#[test]
fn v3_energy_conservation() {
    let params = default_params();
    let dt = 0.01;
    let total = 2.0 * std::f64::consts::PI * 100.0; // 100 periods
    let steps = (total / dt).round() as usize;
    let mut y = [1.0f64, 0.0];
    let mut ws = [0.0f64; 4];
    let mut t = 0.0f64;
    let e0 = 0.5 * (y[0] * y[0] + y[1] * y[1]);
    let mut max_dev = f64::NEG_INFINITY;
    let mut min_dev = f64::INFINITY;
    for _ in 0..steps {
        let (rc, _) = step_raw(&mut y, &mut ws, t, dt, &params, rhs_harmonic);
        assert_eq!(rc, 0);
        t += dt;
        let e = 0.5 * (y[0] * y[0] + y[1] * y[1]);
        let rel = (e - e0) / e0;
        max_dev = max_dev.max(rel);
        min_dev = min_dev.min(rel);
    }
    let e_end = 0.5 * (y[0] * y[0] + y[1] * y[1]);
    println!(
        "V3 energy over 100 periods at dt=0.01: E0 = {e0}, E_end = {e_end:e}, \
         (E-E0)/E0 max = {max_dev:e}, min = {min_dev:e}"
    );
    assert!(
        max_dev.abs() < 1.0e-3 && min_dev.abs() < 1.0e-3,
        "energy left the bounded band: {min_dev:e} .. {max_dev:e}"
    );
}

// ── V4: determinism ───────────────────────────────────────────────────────

#[test]
fn v4_determinism() {
    let params = default_params();
    let (a, sa) = run(1000, 0.01, &[1.0, 0.0], &params, rhs_harmonic);
    let (b, sb) = run(1000, 0.01, &[1.0, 0.0], &params, rhs_harmonic);
    assert_eq!(bits(&a), bits(&b), "two runs must be bit-identical");
    assert_eq!(sa, sb);
}

// ── V5: no hidden state (interleaving) ────────────────────────────────────

#[test]
fn v5_no_hidden_state() {
    let params = default_params();
    let y0a = [1.0f64, 0.0];
    let y0b = [0.0f64, 2.0, 0.5, -1.0]; // dim 4

    // Isolated runs: A 500 steps of 0.01, B 300 steps of 0.007.
    let (a_iso, _) = run(500, 0.01, &y0a, &params, rhs_harmonic);
    let (b_iso, _) = run(300, 0.007, &y0b, &params, rhs_harmonic);

    // Interleaved: A and B alternate, each with its own t and dt sequence.
    let mut a = y0a.to_vec();
    let mut ws_a = vec![0.0f64; 4];
    let mut ta = 0.0f64;
    let mut b = y0b.to_vec();
    let mut ws_b = vec![0.0f64; 8];
    let mut tb = 0.0f64;
    for k in 0..500 {
        let (rc, _) = step_raw(&mut a, &mut ws_a, ta, 0.01, &params, rhs_harmonic);
        assert_eq!(rc, 0);
        ta += 0.01;
        if k < 300 {
            let (rc, _) = step_raw(&mut b, &mut ws_b, tb, 0.007, &params, rhs_harmonic);
            assert_eq!(rc, 0);
            tb += 0.007;
        }
    }
    assert_eq!(bits(&a), bits(&a_iso), "A must match its isolated run");
    assert_eq!(bits(&b), bits(&b_iso), "B must match its isolated run");
}

// ── V6: odd dim rejected ──────────────────────────────────────────────────

#[test]
fn v6_odd_dim_rejected() {
    let params = default_params();
    for dim in [1usize, 3, 5] {
        let mut y = vec![1.0f64; dim];
        let mut ws = vec![0.0f64; 2 * dim + 2];
        let mut status = 0i32;
        let rc = unsafe {
            tension_solver_verlet_step(
                y.as_mut_ptr(),
                dim as i32,
                0.0,
                0.1,
                ws.as_mut_ptr(),
                Some(rhs_harmonic),
                std::ptr::null_mut(),
                &params,
                &mut status,
            )
        };
        assert_eq!(rc, -22, "dim {dim} must be -EINVAL");
        assert_eq!(status, 0);
    }
}

// ── V7: edges ─────────────────────────────────────────────────────────────

#[test]
fn v7_edges() {
    let params = default_params();

    // dt = 0: a no-op — nothing evaluated, state bit for bit unchanged.
    let y0 = [1.0f64, 0.5, 0.25, -0.75];
    let mut y = y0;
    let mut ws = [0.0f64; 8];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.0, &params, rhs_harmonic);
    assert_eq!(rc, 0);
    assert_eq!(status, 0, "a zero step evaluates nothing");
    assert_eq!(bits(&y), bits(&y0));

    // Zero RHS at equilibrium (v = 0): nothing changes.
    let mut y = [1.0f64, 0.0];
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_zero);
    assert_eq!(rc, 0);
    assert_eq!(status, 2);
    assert_eq!(bits(&y), bits(&[1.0, 0.0]));

    // A failing first evaluation: errno propagates, state untouched.
    let mut y = [1.0f64, 0.25];
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_fail);
    assert_eq!(rc, -5);
    assert_eq!(status, 0);
    assert_eq!(bits(&y), bits(&[1.0, 0.25]));

    // A failing second evaluation: errno propagates; positions are
    // advanced and velocities unchanged — the documented partial step
    // (module header; not rolled back).
    CALL_COUNT.store(0, Ordering::SeqCst);
    let mut y = [1.0f64, 0.0];
    let mut ws = [0.0f64; 4];
    let (rc, status) = step_raw(&mut y, &mut ws, 0.0, 0.1, &params, rhs_fail_second);
    assert_eq!(rc, -5);
    assert_eq!(status, 0);
    let expected_q = 1.0 + 0.1 * 0.0 + 0.5 * 0.01 * (-1.0);
    assert!((y[0] - expected_q).abs() < 1.0e-15, "q = {}", y[0]);
    assert_eq!(y[1].to_bits(), 0.0f64.to_bits(), "velocity must be the old one");
}

// ── V8: fixed_step read, relTol ignored ───────────────────────────────────

#[test]
fn v8_fixed_step_read_relative_tolerance_ignored() {
    // relTol differs; results must not.
    let mut loose = default_params();
    loose.rel_tol = 1.0e-3;
    let mut tight = default_params();
    tight.rel_tol = 1.0e-12;
    let (a, _) = run(100, 0.01, &[1.0, 0.0], &loose, rhs_harmonic);
    let (b, _) = run(100, 0.01, &[1.0, 0.0], &tight, rhs_harmonic);
    assert_eq!(bits(&a), bits(&b), "relTol must not affect verlet");

    // fixed_step is read: a negative value is refused by a direct caller...
    let mut bad = default_params();
    bad.fixed_step = -1.0;
    let mut y = [1.0f64, 0.0];
    let mut ws = [0.0f64; 4];
    let (rc, _) = step_raw(&mut y, &mut ws, 0.0, 0.1, &bad, rhs_harmonic);
    assert_eq!(rc, -22);

    // ...and a different non-negative fixed_step does not retime the step:
    // the advance is the call's dt (module header).
    let mut big = default_params();
    big.fixed_step = 1.0;
    let (c, _) = run(100, 0.01, &[1.0, 0.0], &big, rhs_harmonic);
    assert_eq!(bits(&a), bits(&c), "fixed_step must not retime the step");
}
