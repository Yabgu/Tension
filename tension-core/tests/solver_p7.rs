//! P7 tests: the plugin SDK surface that landed before the Part D fork's
//! confirmation — the three accessors and the lifecycle guardrails.
//!
//! Scope note, deliberately: the phase brief's P1 (midpoint plugin), P4
//! (plugin wrapping a built-in) and P5 (wrapping rk45 end to end) all wait
//! on the state-pointer decision recorded in DESIGN.md §11 — a plugin's
//! `step` cannot yet reach the state vector, so a wrapping plugin cannot
//! exist. P2 and P3's *time* half need no state access and are here; P3's
//! state half (the plugin leaving a modified state behind) also waits on
//! the same decision and is noted where it would live.
//!
//! The shim has one process-global table, so the tests take turns through
//! `SERIAL`.

use std::ffi::{c_char, CString};
use std::sync::Mutex;

static SERIAL: Mutex<()> = Mutex::new(());

/// The RHS shape of the header's `tension_solver_derivative_fn`.
type DerivFn = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;
type ValidFn = unsafe extern "C" fn(*const f64, i32, *const f64, i32, f64, *mut u8, i32) -> i32;
type StepFn = unsafe extern "C" fn(i32, f64) -> i32;
type StateFn = unsafe extern "C" fn(i32, *mut f64, *mut f64, i32) -> i32;
type SetStateFn = unsafe extern "C" fn(i32, f64, *const f64, i32) -> i32;
type DestroyFn = unsafe extern "C" fn(i32);

/// The header's `tension_solver_backend_vtable`, field for field.
#[repr(C)]
struct Vtable {
    name: *const c_char,
    kind: *const c_char,
    deterministic: u32,
    derivative: Option<DerivFn>,
    validate: Option<ValidFn>,
    step: Option<StepFn>,
    state: Option<StateFn>,
    set_state: Option<SetStateFn>,
    destroy: Option<DestroyFn>,
}

extern "C" {
    fn tension_solver_create(config_json: *const c_char, config_len: usize) -> i32;
    fn tension_solver_bind_callbacks(
        id: i32,
        derivative: Option<DerivFn>,
        validate: Option<ValidFn>,
    ) -> i32;
    fn tension_solver_step(id: i32, dt: f64) -> i32;
    fn tension_solver_state(id: i32, t_out: *mut f64, y_out: *mut f64, y_cap: i32) -> i32;
    fn tension_solver_set_state(id: i32, t: f64, y: *const f64, y_len: i32) -> i32;
    fn tension_solver_destroy(id: i32);
    fn tension_solver_register_backend(name: *const c_char, vtable: *const Vtable) -> i32;
    fn tension_solver_get_dim(id: i32) -> i32;
    fn tension_solver_get_time(id: i32) -> f64;
    fn tension_solver_get_derivative(id: i32) -> Option<DerivFn>;
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn create(json: &str) -> i32 {
    let s = CString::new(json).unwrap();
    unsafe { tension_solver_create(s.as_ptr(), s.as_bytes().len()) }
}

/// Register a plugin whose vtable and strings outlive the process (the
/// shim stores the vtable pointer; the test process is the lifetime).
#[allow(clippy::too_many_arguments)]
fn register_plugin(
    name: &str,
    kind: &str,
    deterministic: u32,
    derivative: Option<DerivFn>,
    step: Option<StepFn>,
    state: Option<StateFn>,
    set_state: Option<SetStateFn>,
    destroy: Option<DestroyFn>,
) -> i32 {
    let vt = Box::leak(Box::new(Vtable {
        name: CString::new(name).unwrap().into_raw(),
        kind: CString::new(kind).unwrap().into_raw(),
        deterministic,
        derivative,
        validate: None,
        step,
        state,
        set_state,
        destroy,
    }));
    let name_c = CString::new(name).unwrap();
    unsafe { tension_solver_register_backend(name_c.as_ptr(), vt as *const Vtable) }
}

// ── plugin fixtures ───────────────────────────────────────────────────────

unsafe extern "C" fn rhs_decay(y: *const f64, len: i32, _t: f64, dy: *mut f64, cap: i32) -> i32 {
    if cap < len {
        return -22;
    }
    for i in 0..len as usize {
        *dy.add(i) = -*y.add(i);
    }
    0
}

/// The minimal successful plugin step (source: native carries its own f,
/// so the derivative above satisfies the pairing rule; this step does
/// nothing with it).
unsafe extern "C" fn step_ok(_id: i32, _dt: f64) -> i32 {
    0
}

/// The failing plugin step.
unsafe extern "C" fn step_fail(_id: i32, _dt: f64) -> i32 {
    -5
}

// ── the accessors ─────────────────────────────────────────────────────────

#[test]
fn p0_accessors_answer_for_a_bound_builtin() {
    let _g = lock();
    let id = create(r#"{"method":"euler","source":"wasm","dim":3}"#);
    assert!(id >= 1, "create returned {id}");

    assert_eq!(unsafe { tension_solver_get_dim(id) }, 3);
    assert_eq!(unsafe { tension_solver_get_time(id) }, 0.0);
    assert!(
        unsafe { tension_solver_get_derivative(id) }.is_none(),
        "a wasm solver has no derivative before bind_callbacks"
    );

    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    assert!(
        unsafe { tension_solver_get_derivative(id) }.is_some(),
        "the bound derivative is what the accessor must hand a wrapping plugin"
    );

    assert_eq!(unsafe { tension_solver_step(id, 0.25) }, 0);
    assert_eq!(unsafe { tension_solver_get_time(id) }, 0.25);

    unsafe { tension_solver_destroy(id) };
    // A dead id: the documented errno shapes, not a crash.
    assert_eq!(unsafe { tension_solver_get_dim(id) }, -9, "-EBADF");
    assert_eq!(unsafe { tension_solver_get_time(id) }, -9.0);
    assert!(unsafe { tension_solver_get_derivative(id) }.is_none());
}

// ── P2: NULL lifecycle slots are guardrailed ──────────────────────────────

#[test]
fn p2_null_state_slots_are_guardrailed() {
    let _g = lock();
    assert_eq!(
        register_plugin(
            "p7_nullslots",
            "custom",
            1,
            Some(rhs_decay),
            Some(step_ok),
            None,
            None,
            None
        ),
        0
    );
    let id = create(r#"{"method":"p7_nullslots","source":"native","dim":2}"#);
    assert!(id >= 1, "create returned {id}");

    // A stateless-but-legitimate plugin: step works, and the shim advances
    // its clock on success (the same convention as the built-ins).
    assert_eq!(unsafe { tension_solver_step(id, 0.25) }, 0);
    assert_eq!(unsafe { tension_solver_get_time(id) }, 0.25);

    // NULL state/set_state slots: -EINVAL, not a crash.
    let mut t_out = 0.0f64;
    let mut y_out = [0.0f64; 2];
    assert_eq!(
        unsafe { tension_solver_state(id, &mut t_out, y_out.as_mut_ptr(), 2) },
        -22
    );
    assert_eq!(
        unsafe { tension_solver_set_state(id, 0.0, y_out.as_ptr(), 2) },
        -22
    );

    // NULL destroy slot: a clean no-op.
    unsafe { tension_solver_destroy(id) };
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, -9, "the id is gone");
}

// ── P3: a failing step does not advance t ─────────────────────────────────

#[test]
fn p3_failing_plugin_step_does_not_advance_time() {
    let _g = lock();
    assert_eq!(
        register_plugin(
            "p7_failstep",
            "custom",
            1,
            Some(rhs_decay),
            Some(step_fail),
            None,
            None,
            None
        ),
        0
    );
    let id = create(r#"{"method":"p7_failstep","source":"native","dim":1}"#);
    assert!(id >= 1);

    assert_eq!(
        unsafe { tension_solver_step(id, 0.25) },
        -5,
        "the plugin's errno must propagate unchanged"
    );
    assert_eq!(
        unsafe { tension_solver_get_time(id) },
        0.0,
        "a failing step must not advance t"
    );
    // P3's other half — "state is whatever the plugin left it in" — waits
    // on the Part D fork: with no state accessor a plugin cannot leave the
    // state anywhere, which is exactly the gap the fork decides.

    unsafe { tension_solver_destroy(id) };
}
