//! P10: the collision demo's physics as a plain Rust RHS.
//!
//! `examples/collision/` runs these same equations inside a wasm guest; this
//! test runs them through the shim directly, with no wasm in the loop, as a
//! smoke check on the *physics* rather than on the bridge (the bridge is P4's
//! and P5's business). It is not a trajectory check — the exact path is the
//! GIF's business — it asserts the three things a broken model would fail:
//!
//!   - every state value stays finite for all 80 steps (a NaN would mean a
//!     division by a zero mass, a destabilised spring, or an integrator
//!     blow-up);
//!   - nothing leaves the wall by more than the soft contact's own
//!     penetration allowance (WALL + radius + 0.5 m of slack);
//!   - the two spheres actually *collide* (they swap sides at 8 m/s closing
//!     speed) and then settle: the last second of vertical motion is small
//!     and both end up below y = 0, on the floor, where the wall spring
//!     carries their weight.
//!
//! `collision_rhs` mirrors `examples/collision/game.ts` line for line; the
//! constants are that file's constants.

use std::sync::Mutex;

#[path = "support/config.rs"]
mod support;

use support::Config;

type DerivFn = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;
type ValidFn = unsafe extern "C" fn(*const f64, i32, *const f64, i32, f64, *mut u8, i32) -> i32;

extern "C" {
    fn tension_solver_bind_callbacks(
        id: i32,
        derivative: Option<DerivFn>,
        validate: Option<ValidFn>,
    ) -> i32;
    fn tension_solver_step(id: i32, dt: f64) -> i32;
    fn tension_solver_state(id: i32, t_out: *mut f64, y_out: *mut f64, y_cap: i32) -> i32;
    fn tension_solver_set_state(id: i32, t: f64, y: *const f64, y_len: i32) -> i32;
    fn tension_solver_destroy(id: i32);
}

/// The shim's solver table is process-global, so tests in this binary
/// serialize (the convention every solver test file follows).
static SERIAL: Mutex<()> = Mutex::new(());

// ── the model (examples/collision/game.ts) ────────────────────────────────

const GRAVITY: f64 = -9.81;
const K_WALL: f64 = 200.0;
const K_CC: f64 = 800.0;
const DAMPING: f64 = 2.0;
const WALL: f64 = 5.0;
const EPSILON: f64 = 1e-10;
const RADII: [f64; 2] = [0.5, 0.5];
const MASSES: [f64; 2] = [1.0, 1.0];

/// f(t, y) for two soft spheres in a square, exactly as the guest writes it:
/// gravity, four wall springs, one circle-circle spring per pair, and damping
/// along each contact normal.
unsafe extern "C" fn collision_rhs(
    y: *const f64,
    len: i32,
    _t: f64,
    dy: *mut f64,
    dy_cap: i32,
) -> i32 {
    if len < 8 || dy_cap < len {
        return -22;
    }
    let bodies = (len / 4) as usize;
    for i in 0..bodies {
        let at = i * 4;
        let x = *y.add(at);
        let yy = *y.add(at + 1);
        let vx = *y.add(at + 2);
        let vy = *y.add(at + 3);
        let r = RADII[i];
        let m = MASSES[i];

        let mut ax = 0.0;
        let mut ay = GRAVITY;

        let right = (x + r) - WALL;
        if right > 0.0 {
            ax -= K_WALL * right / m;
            ax -= DAMPING * vx / m;
        }
        let left = (-x + r) - WALL;
        if left > 0.0 {
            ax += K_WALL * left / m;
            ax -= DAMPING * vx / m;
        }
        let top = (yy + r) - WALL;
        if top > 0.0 {
            ay -= K_WALL * top / m;
            ay -= DAMPING * vy / m;
        }
        let bottom = (-yy + r) - WALL;
        if bottom > 0.0 {
            ay += K_WALL * bottom / m;
            ay -= DAMPING * vy / m;
        }

        for j in 0..bodies {
            if j == i {
                continue;
            }
            let bt = j * 4;
            let dx = x - *y.add(bt);
            let dyy = yy - *y.add(bt + 1);
            let dist2 = dx * dx + dyy * dyy;
            let min_dist = r + RADII[j];
            if dist2 < min_dist * min_dist {
                let dist = dist2.sqrt() + EPSILON;
                let penetration = min_dist - dist;
                let nx = dx / dist;
                let ny = dyy / dist;
                ax += K_CC * penetration * nx / m;
                ay += K_CC * penetration * ny / m;
                let vrel = (vx - *y.add(bt + 2)) * nx + (vy - *y.add(bt + 3)) * ny;
                ax -= DAMPING * vrel * nx / m;
                ay -= DAMPING * vrel * ny / m;
            }
        }

        *dy.add(at) = vx;
        *dy.add(at + 1) = vy;
        *dy.add(at + 2) = ax;
        *dy.add(at + 3) = ay;
    }
    0
}

// ── the test ──────────────────────────────────────────────────────────────

#[test]
fn collision_physics_stays_finite_inside_the_wall_and_settles() {
    let _g = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());

    let id = Config::new("rk45", "wasm")
        .dim(8)
        .rel_tol(1e-6)
        .abs_tol(1e-8)
        .create();
    assert!(id >= 1, "create rk45/dim 8 returned {id}");
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(collision_rhs), None) },
        0
    );

    // The demo's initial conditions: apart, falling, converging at 8 m/s.
    let y0 = [-3.0f64, 3.0, 4.0, 0.0, 3.0, 1.0, -4.0, 0.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 8) }, 0);

    let limit = WALL + 0.5; // the contact's own penetration allowance
    let mut t = 0.0f64;
    let mut state = [0.0f64; 8];
    let mut crossed = false; // did sphere 0 get past sphere 1?
    let mut samples = Vec::new();

    for step in 0..80 {
        let rc = unsafe { tension_solver_step(id, 0.1) };
        assert_eq!(rc, 0, "step {step} returned {rc}");
        let n = unsafe { tension_solver_state(id, &mut t, state.as_mut_ptr(), 8) };
        assert_eq!(n, 8, "state returned {n}");
        for (slot, v) in state.iter().enumerate() {
            assert!(v.is_finite(), "step {step}: slot {slot} is {v}");
        }
        // Positions, with the contact model's slack. Velocities are bounded
        // by the energy the drop can deliver; nothing should be running away.
        assert!(
            state[0].abs() <= limit && state[1].abs() <= limit,
            "step {step}: sphere 0 at ({}, {})",
            state[0],
            state[1]
        );
        assert!(
            state[4].abs() <= limit && state[5].abs() <= limit,
            "step {step}: sphere 1 at ({}, {})",
            state[4],
            state[5]
        );
        if state[0] > 1.0 && state[4] < -1.0 {
            crossed = true;
        }
        samples.push(state);
    }

    assert!(crossed, "the spheres never swapped sides — no collision happened");

    // Settled: the last second of vertical motion is small, and both are on
    // the floor (below y = 0), resting on the wall spring.
    let last = samples[samples.len() - 1];
    let ten_back = samples[samples.len() - 11];
    let dy0 = (last[1] - ten_back[1]).abs();
    let dy1 = (last[5] - ten_back[5]).abs();
    assert!(dy0 < 0.5, "sphere 0 still bouncing: |dy| = {dy0}");
    assert!(dy1 < 0.5, "sphere 1 still bouncing: |dy| = {dy1}");
    assert!(last[1] < 0.0 && last[5] < 0.0, "not on the floor: {last:?}");

    println!(
        "P10 two-sphere collision, rk45: final t = {t}, \
         y0 = {} (|dy| over the last second: {dy0:.4}), \
         y1 = {} (|dy|: {dy1:.4})",
        last[1], last[5]
    );
    println!("P10 final x: {} and {} — they swapped sides and settled", last[0], last[4]);

    unsafe { tension_solver_destroy(id) };
}
