//! P1 integration tests for the tension-solver numerical core.
//!
//! The core is a Fortran archive (`tension-solver/build/libtension_solver.a`),
//! built and linked by `tension-core/build.rs`. These tests call the two
//! bind(C) symbols phase 1 exports — the euler primitive — with plain
//! `extern "C"` Rust functions as the RHS: no wasm, no public ABI, and no
//! state in the library.
//!
//! What they prove, in order: T1 the archive links and one step runs; T2 the
//! integrator is first-order accurate; T3 two runs are bit-identical;
//! T4 interleaved solvers do not interfere (no hidden module state); T5 the
//! edge semantics (dt = 0, zero RHS, callback error propagation).

use std::ffi::c_void;

/// The RHS shape of the header's `tension_solver_derivative_fn`:
/// `int32_t (*)(const double *y, int32_t len, double t, double *dy, int32_t dy_cap)`.
type Rhs = unsafe extern "C" fn(y: *const f64, len: i32, t: f64, dy: *mut f64, dy_cap: i32) -> i32;

extern "C" {
    fn tension_solver_euler_workspace_size(dim: i32) -> i32;
    fn tension_solver_euler_step(
        state: *mut f64,
        dim: i32,
        t: f64,
        dt: f64,
        workspace: *mut f64,
        rhs_fn: Option<Rhs>,
        rhs_ctx: *mut c_void,
        params: *mut c_void,
        status: *mut i32,
    ) -> i32;
}

// ── RHS fixtures: pure functions of (y, t), as the header requires ────────

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

/// A diagonal linear field for dim 3: dy = [1, -2, 0.5] * y.
unsafe extern "C" fn rhs_diagonal(y: *const f64, len: i32, _t: f64, dy: *mut f64, dy_cap: i32) -> i32 {
    if dy_cap < len {
        return -22;
    }
    let c = [1.0f64, -2.0, 0.5];
    for i in 0..len as usize {
        *dy.add(i) = c[i] * *y.add(i);
    }
    0
}

/// f(t, y) = 0: the state must not move.
unsafe extern "C" fn rhs_zero(_y: *const f64, len: i32, _t: f64, dy: *mut f64, _dy_cap: i32) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = 0.0;
    }
    0
}

/// Always fails with -EIO.
unsafe extern "C" fn rhs_fails(_y: *const f64, _len: i32, _t: f64, _dy: *mut f64, _dy_cap: i32) -> i32 {
    -5
}

// ── drivers ───────────────────────────────────────────────────────────────

/// One euler step through the bind(C) surface. Returns (rc, status).
fn euler_step(state: &mut [f64], t: f64, dt: f64, rhs: Rhs) -> (i32, i32) {
    let dim = state.len() as i32;
    let slots = unsafe { tension_solver_euler_workspace_size(dim) };
    assert!(slots > 0, "workspace_size({dim}) = {slots}");
    let mut workspace = vec![0.0f64; slots as usize];
    let mut status = -77i32;
    let rc = unsafe {
        tension_solver_euler_step(
            state.as_mut_ptr(),
            dim,
            t,
            dt,
            workspace.as_mut_ptr(),
            Some(rhs),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut status,
        )
    };
    (rc, status)
}

/// Integrate y' = -y for `n` steps of `dt`, once, from y0 = 1. Returns y(T).
fn integrate_decay(n: u32, dt: f64) -> f64 {
    let mut y = [1.0f64];
    let mut t = 0.0;
    for _ in 0..n {
        let (rc, status) = euler_step(&mut y, t, dt, rhs_decay);
        assert_eq!(rc, 0);
        assert_eq!(status, 1, "euler is one RHS evaluation per step");
        t += dt;
    }
    y[0]
}

// ── T1: linkage smoke ─────────────────────────────────────────────────────

#[test]
fn t1_linkage_smoke() {
    // Sizes: one stage vector of `dim` slots; dim < 1 needs none.
    assert_eq!(unsafe { tension_solver_euler_workspace_size(1) }, 1);
    assert_eq!(unsafe { tension_solver_euler_workspace_size(3) }, 3);
    assert_eq!(unsafe { tension_solver_euler_workspace_size(0) }, 0);
    assert_eq!(unsafe { tension_solver_euler_workspace_size(-4) }, 0);

    // One step: y0 = 1, y' = -y, dt = 0.1  →  y1 = 0.9, one evaluation.
    let mut y = [1.0f64];
    let (rc, status) = euler_step(&mut y, 0.0, 0.1, rhs_decay);
    assert_eq!(rc, 0);
    assert_eq!(status, 1, "euler is one RHS evaluation per step");
    assert_eq!(y[0], 0.9);

    // dim = 0 is -EINVAL, before the state is touched.
    let mut none: [f64; 0] = [];
    let mut status = -77i32;
    let rc = unsafe {
        tension_solver_euler_step(
            none.as_mut_ptr(),
            0,
            0.0,
            0.1,
            none.as_mut_ptr(),
            Some(rhs_decay),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut status,
        )
    };
    assert_eq!(rc, -22);
}

// ── T2: accuracy — first order, and the halve-dt relation ─────────────────

#[test]
fn t2_accuracy_first_order() {
    let exact = (-1.0f64).exp();

    let h64 = 1.0 / 64.0;
    let h128 = 1.0 / 128.0;
    let err64 = (exact - integrate_decay(64, h64)).abs();
    let err128 = (exact - integrate_decay(128, h128)).abs();

    // Envelope: euler's global error is O(dt); a generous constant checks
    // order, not the exact prefactor.
    assert!(err64 <= 0.3 * h64, "err(1/64) = {err64} exceeds 0.3*dt");
    // ...and not accidentally exact (a wrong-but-lucky implementation).
    assert!(err64 > 0.0, "euler should not be exact on a nonlinear comparison");

    // Halving dt halves the error, within tolerance.
    let ratio = err64 / err128;
    assert!(
        (1.7..=2.3).contains(&ratio),
        "error ratio {ratio} is not ~2 (first order)"
    );
}

// ── T3: determinism — two runs, bit for bit ───────────────────────────────

#[test]
fn t3_determinism_bit_identical() {
    let run = || -> Vec<f64> {
        let mut y = vec![1.0f64, 2.0, 3.0];
        let mut t = 0.0;
        for _ in 0..100 {
            let (rc, status) = euler_step(&mut y, t, 0.01, rhs_diagonal);
            assert_eq!(rc, 0);
            assert_eq!(status, 1);
            t += 0.01;
        }
        y
    };

    let a = run();
    let b = run();
    assert_eq!(a.len(), b.len());
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        assert_eq!(
            x.to_bits(),
            y.to_bits(),
            "element {i}: {x:?} vs {y:?} — not bit-identical"
        );
    }
}

// ── T4: no hidden state — interleaved solvers match isolated runs ─────────

#[test]
fn t4_no_hidden_state_interleaved() {
    // A: dim 2, four steps with y' = -y.
    let mut a_iso = vec![1.0f64, 2.0];
    for k in 0..4u32 {
        let (rc, _) = euler_step(&mut a_iso, 0.01 * k as f64, 0.01, rhs_decay);
        assert_eq!(rc, 0);
    }

    // B: dim 3, seven steps on a different field, clock, and step size.
    let mut b_iso = vec![0.5f64, -1.0, 4.0];
    for k in 0..7u32 {
        let (rc, _) = euler_step(&mut b_iso, 0.5 + 0.005 * k as f64, 0.005, rhs_diagonal);
        assert_eq!(rc, 0);
    }

    // The same two sequences, interleaved into fresh states.
    let mut a = vec![1.0f64, 2.0];
    let mut b = vec![0.5f64, -1.0, 4.0];
    for k in 0..7u32 {
        if k < 4 {
            let (rc, _) = euler_step(&mut a, 0.01 * k as f64, 0.01, rhs_decay);
            assert_eq!(rc, 0);
        }
        let (rc, _) = euler_step(&mut b, 0.5 + 0.005 * k as f64, 0.005, rhs_diagonal);
        assert_eq!(rc, 0);
    }

    for i in 0..2 {
        assert_eq!(
            a[i].to_bits(),
            a_iso[i].to_bits(),
            "interleaving changed solver A, element {i}"
        );
    }
    for i in 0..3 {
        assert_eq!(
            b[i].to_bits(),
            b_iso[i].to_bits(),
            "interleaving changed solver B, element {i}"
        );
    }
}

// ── T5: edges ─────────────────────────────────────────────────────────────

#[test]
fn t5_edges() {
    // dt = 0 changes nothing — bit for bit — and evaluates nothing.
    let mut y = [1.5f64, -2.25];
    let before = y;
    let (rc, status) = euler_step(&mut y, 3.0, 0.0, rhs_decay);
    assert_eq!(rc, 0);
    assert_eq!(status, 0, "a zero step evaluates nothing");
    for i in 0..y.len() {
        assert_eq!(y[i].to_bits(), before[i].to_bits());
    }

    // A zero RHS changes nothing; the step still runs and evaluates once.
    let mut y = [1.5f64, -2.25];
    let (rc, status) = euler_step(&mut y, 0.0, 0.1, rhs_zero);
    assert_eq!(rc, 0);
    assert_eq!(status, 1);
    assert_eq!(y, [1.5, -2.25]);

    // A failing RHS propagates its errno unchanged. Euler's first stage
    // fails before any state is written, so the state survives the step.
    let mut y = [1.5f64, -2.25];
    let before = y;
    let (rc, status) = euler_step(&mut y, 0.0, 0.1, rhs_fails);
    assert_eq!(rc, -5);
    assert_eq!(status, 0);
    for i in 0..y.len() {
        assert_eq!(y[i].to_bits(), before[i].to_bits());
    }
}
