//! P6 shim tests: the new families through the C ABI end to end
//! (create -> bind_callbacks -> step -> state), the same shape as the
//! phase-3 through-shim tests. `bdf2` rides the same dispatch, plus the
//! one thing it adds: `set_state` must clear the step history.
//!
//! S4 of the phase brief is the T20 cross-check, which already lives in
//! `solver_p2.rs` and runs in this suite; nothing new is needed for it.
//!
//! The shim has one process-global table, so the tests take turns
//! through `SERIAL`.

use std::sync::Mutex;

#[path = "support/config.rs"]
mod support;

use support::Config;

static SERIAL: Mutex<()> = Mutex::new(());

/// The RHS shape of the header's `tension_solver_derivative_fn`.
type Rhs = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;
type ValidateFn = unsafe extern "C" fn(*const f64, i32, *const f64, i32, f64, *mut u8, i32) -> i32;

extern "C" {
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

fn create(cfg: &Config) -> i32 {
    cfg.create()
}

/// Harmonic oscillator for the verlet convention: dy = [v, a], a = -q.
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

/// y' = -y, elementwise.
unsafe extern "C" fn rhs_decay(y: *const f64, len: i32, _t: f64, dy: *mut f64, cap: i32) -> i32 {
    if cap < len {
        return -22;
    }
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

// ── S1: verlet through the shim ───────────────────────────────────────────

#[test]
fn s1_verlet_through_shim() {
    let _g = lock();
    let id = create(&Config::new("verlet", "wasm").dim(4));
    assert!(id >= 1, "create returned {id}");
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_harmonic), None) },
        0
    );

    // q = [1, 0], v = [0, 1]; one step of 0.1 of q'' = -q.
    let y0 = [1.0f64, 0.0, 0.0, 1.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 4) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, 0);

    let mut y = [0.0f64; 4];
    let (t, n) = read_state(id, &mut y);
    assert_eq!(n, 4);
    assert_eq!(t, 0.1);
    let expected = [0.995f64, 0.1, -0.09975, 0.995];
    for i in 0..4 {
        assert!(
            (y[i] - expected[i]).abs() <= 1.0e-12,
            "component {i}: {} vs {}",
            y[i],
            expected[i]
        );
    }
    println!("S1 verlet dim=4 through the shim: y = {y:?}");
    unsafe { tension_solver_destroy(id) };
}

#[test]
fn s1b_verlet_odd_dim_refused_at_step() {
    let _g = lock();
    // create does not pre-validate evenness (the compiled rules are
    // method-agnostic); the step is where the method's convention bites.
    let id = create(&Config::new("verlet", "wasm").dim(3));
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_harmonic), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, -22);
    unsafe { tension_solver_destroy(id) };
}

// ── S2: implicit_euler through the shim ───────────────────────────────────

#[test]
fn s2_implicit_euler_through_shim() {
    let _g = lock();
    let id = create(&Config::new("implicit_euler", "wasm").dim(2));
    assert!(id >= 1, "create returned {id}");
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );

    let y0 = [1.0f64, 2.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, 0);

    let mut y = [0.0f64; 2];
    let (t, n) = read_state(id, &mut y);
    assert_eq!(n, 2);
    assert_eq!(t, 0.1);
    // y_{n+1} = y_n / (1 + 0.1) for y' = -y.
    let expected = [1.0 / 1.1, 2.0 / 1.1];
    for i in 0..2 {
        assert!(
            (y[i] - expected[i]).abs() <= 1.0e-6,
            "component {i}: {} vs {}",
            y[i],
            expected[i]
        );
    }
    println!("S2 implicit_euler dim=2 through the shim: y = {y:?}");
    unsafe { tension_solver_destroy(id) };
}

// ── S2b: bdf2 through the shim, and the set_state history reset ───────────

#[test]
fn s2b_bdf2_through_shim_resets_history_on_set_state() {
    let _g = lock();
    let dt = 0.1f64;
    let id = create(&Config::new("bdf2", "wasm").dim(2));
    assert!(id >= 1, "create returned {id}");
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );

    let y0 = [1.0f64, 2.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);

    // Step 1 is backward Euler: y1 = y0 / (1 + dt).
    assert_eq!(unsafe { tension_solver_step(id, dt) }, 0);
    let mut y1 = [0.0f64; 2];
    let (t, n) = read_state(id, &mut y1);
    assert_eq!((t, n), (dt, 2));
    for i in 0..2 {
        let expected = y0[i] / (1.0 + dt);
        assert!(
            (y1[i] - expected).abs() <= 1.0e-6,
            "step 1 component {i}: {} vs {expected}",
            y1[i]
        );
    }

    // Step 2 is BDF2: with y_star = (4·y1 − y0)/3 and alpha = 2·dt/3,
    // y2 = y_star / (1 + alpha) for y' = −y.
    assert_eq!(unsafe { tension_solver_step(id, dt) }, 0);
    let mut y2 = [0.0f64; 2];
    let (t, _) = read_state(id, &mut y2);
    assert!((t - 2.0 * dt).abs() < 1.0e-12, "t = {t}");
    let alpha = 2.0 * dt / 3.0;
    for i in 0..2 {
        let y_star = (4.0 * y1[i] - y0[i]) / 3.0;
        let expected = y_star / (1.0 + alpha);
        assert!(
            (y2[i] - expected).abs() <= 1.0e-6,
            "step 2 component {i}: {} vs {expected}",
            y2[i]
        );
    }
    println!("S2b bdf2 dim=2 through the shim: y1 = {y1:?}, y2 = {y2:?}");

    // A restored state must not inherit the previous run's history: after
    // set_state the next step has to be backward Euler again, not BDF2 over
    // a y_prev that belongs to a different trajectory.
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, dt) }, 0);
    let mut fresh = [0.0f64; 2];
    let _ = read_state(id, &mut fresh);
    for i in 0..2 {
        let expected = y0[i] / (1.0 + dt);
        assert!(
            (fresh[i] - expected).abs() <= 1.0e-6,
            "after set_state, component {i}: {} vs {expected} (stale history)",
            fresh[i]
        );
    }
    unsafe { tension_solver_destroy(id) };
}

// ── S3: spook stays -ENOSYS ───────────────────────────────────────────────

#[test]
fn s3_spook_is_still_enosys() {
    let _g = lock();
    let id = create(&Config::new("spook", "wasm").dim(2));
    assert_eq!(id, -38, "spook must remain -ENOSYS (tension-solver/DESIGN.md §10)");
}
