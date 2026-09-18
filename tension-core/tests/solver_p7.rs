//! P7 tests: the plugin SDK, complete — accessors, lifecycle, and the
//! `rk45_native` wrapping pattern proven bit-for-bit.
//!
//! The sample plugin (`examples/plugins/midpoint/midpoint.c`) is compiled
//! into this test binary by `tension-core/build.rs` (the shim has no
//! load-from-disk; DESIGN.md §11), so P1/P6 exercise the example source
//! itself. P4/P5's wrapping plugins are Rust fixtures here — they only
//! call the public ABI, which is the point.
//!
//! The shim has one process-global table, so the tests take turns through
//! `SERIAL`.

use std::ffi::{c_char, c_void, CString};
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

    // ── the accessors ──
    fn tension_solver_get_dim(id: i32) -> i32;
    fn tension_solver_get_time(id: i32) -> f64;
    fn tension_solver_get_derivative(id: i32) -> Option<DerivFn>;
    fn tension_solver_get_state_ptr(id: i32) -> *mut f64;
    fn tension_solver_get_params(id: i32) -> *const c_void;

    // ── the built-ins a wrapping plugin calls ──
    fn tension_solver_euler_step(
        state: *mut f64,
        dim: i32,
        t: f64,
        dt: f64,
        ws: *mut f64,
        rhs: Option<DerivFn>,
        rhs_ctx: *mut c_void,
        params: *const c_void,
        status: *mut i32,
    ) -> i32;
    fn tension_solver_rk45_step(
        state: *mut f64,
        dim: i32,
        t: f64,
        dt: f64,
        ws: *mut f64,
        rhs: Option<DerivFn>,
        rhs_ctx: *mut c_void,
        params: *const c_void,
        status: *mut i32,
    ) -> i32;

    // ── the sample plugin's init (compiled into this test link) ──
    fn tension_plugin_register_midpoint() -> i32;
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The sample plugin's init, exactly once per process: re-registering a
/// name already claimed is -EINVAL by design (the header's rules), and
/// P1 and P6 both need the plugin.
static MIDPOINT_ONCE: std::sync::Once = std::sync::Once::new();

fn ensure_midpoint() {
    MIDPOINT_ONCE.call_once(|| {
        assert_eq!(
            unsafe { tension_plugin_register_midpoint() },
            0,
            "the example plugin's init"
        );
    });
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

// ── fixtures ──────────────────────────────────────────────────────────────

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

/// The failing plugin step (P7).
unsafe extern "C" fn step_fail(_id: i32, _dt: f64) -> i32 {
    -5
}

/// A plugin wrapping the built-in euler: fetch everything through the
/// accessors, allocate the plugin's own workspace, call the built-in.
unsafe extern "C" fn euler_wrap_step(id: i32, dt: f64) -> i32 {
    let dim = tension_solver_get_dim(id);
    if dim < 1 {
        return -22;
    }
    let t = tension_solver_get_time(id);
    let y = tension_solver_get_state_ptr(id);
    let f = tension_solver_get_derivative(id);
    let params = tension_solver_get_params(id);
    if y.is_null() || f.is_none() || params.is_null() {
        return -22;
    }
    let mut ws = vec![0.0f64; dim as usize]; // euler: 1·dim slots
    let mut status = 0i32;
    tension_solver_euler_step(
        y,
        dim,
        t,
        dt,
        ws.as_mut_ptr(),
        f,
        std::ptr::null_mut(),
        params,
        &mut status,
    )
}

/// A plugin wrapping the built-in rk45 — the header's `rk45_native`
/// pattern, literally.
unsafe extern "C" fn rk45_wrap_step(id: i32, dt: f64) -> i32 {
    let dim = tension_solver_get_dim(id);
    if dim < 1 {
        return -22;
    }
    let t = tension_solver_get_time(id);
    let y = tension_solver_get_state_ptr(id);
    let f = tension_solver_get_derivative(id);
    let params = tension_solver_get_params(id);
    if y.is_null() || f.is_none() || params.is_null() {
        return -22;
    }
    let mut ws = vec![0.0f64; (8 * dim) as usize]; // rk45: 8·dim (§7)
    let mut status = 0i32;
    tension_solver_rk45_step(
        y,
        dim,
        t,
        dt,
        ws.as_mut_ptr(),
        f,
        std::ptr::null_mut(),
        params,
        &mut status,
    )
}

// ── P0: the accessors ─────────────────────────────────────────────────────

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
    assert!(!unsafe { tension_solver_get_state_ptr(id) }.is_null());
    assert!(!unsafe { tension_solver_get_params(id) }.is_null());

    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    assert!(unsafe { tension_solver_get_derivative(id) }.is_some());

    assert_eq!(unsafe { tension_solver_step(id, 0.25) }, 0);
    assert_eq!(unsafe { tension_solver_get_time(id) }, 0.25);

    unsafe { tension_solver_destroy(id) };
    // A dead id: the documented shapes, not a crash.
    assert_eq!(unsafe { tension_solver_get_dim(id) }, -9, "-EBADF");
    assert_eq!(unsafe { tension_solver_get_time(id) }, -9.0);
    assert!(unsafe { tension_solver_get_derivative(id) }.is_none());
    assert!(unsafe { tension_solver_get_state_ptr(id) }.is_null());
    assert!(unsafe { tension_solver_get_params(id) }.is_null());
}

// ── P1: the sample plugin, end to end ─────────────────────────────────────

#[test]
fn p1_midpoint_plugin_end_to_end() {
    let _g = lock();
    ensure_midpoint();

    let id = create(r#"{"method":"midpoint","source":"wasm","dim":2}"#);
    assert!(id >= 1, "create returned {id}");
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    let y0 = [1.0f64, 2.0];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, 0);

    let mut t = 0.0f64;
    let mut y = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 2) }, 2);
    assert_eq!(t, 0.1);
    // Midpoint on y' = -y: k1 = -y; stage = y(1 − h/2); k2 = −stage;
    // y_new = y(1 − h + h²/2) = 0.905·y.
    for (i, expected) in [0.905f64, 1.81].iter().enumerate() {
        assert!(
            (y[i] - expected).abs() <= 1.0e-12,
            "component {i}: {} vs {}",
            y[i],
            expected
        );
    }
    println!("P1 midpoint through the plugin: t = {t}, y = {y:?}");
    unsafe { tension_solver_destroy(id) };
}

// ── P4: wrapping the built-in euler, bit-for-bit ──────────────────────────

#[test]
fn p4_euler_wrapper_matches_direct() {
    let _g = lock();
    assert_eq!(
        register_plugin(
            "euler_wrap",
            "explicit_rk",
            1,
            None,
            Some(euler_wrap_step),
            None,
            None,
            None
        ),
        0
    );

    let y0 = [1.0f64, 2.0];
    // Through the wrapper.
    let id = create(r#"{"method":"euler_wrap","source":"wasm","dim":2}"#);
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, 0);
    let mut tw = 0.0f64;
    let mut yw = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id, &mut tw, yw.as_mut_ptr(), 2) }, 2);

    // The same thing directly.
    let id2 = create(r#"{"method":"euler","source":"wasm","dim":2}"#);
    assert!(id2 >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id2, Some(rhs_decay), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_set_state(id2, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id2, 0.1) }, 0);
    let mut td = 0.0f64;
    let mut yd = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id2, &mut td, yd.as_mut_ptr(), 2) }, 2);

    assert_eq!(tw.to_bits(), td.to_bits(), "t must match bit-for-bit");
    for i in 0..2 {
        assert_eq!(
            yw[i].to_bits(),
            yd[i].to_bits(),
            "component {i}: wrapper {} vs direct {}",
            yw[i],
            yd[i]
        );
    }
    println!("P4 euler wrapper bit-identical to direct: t = {tw}, y = {yw:?}");
    unsafe {
        tension_solver_destroy(id);
        tension_solver_destroy(id2);
    }
}

// ── P5: wrapping rk45 — the header's rk45_native, proven ──────────────────

#[test]
fn p5_rk45_wrapper_matches_direct() {
    let _g = lock();
    assert_eq!(
        register_plugin(
            "rk45_wrap",
            "explicit_rk",
            1,
            None,
            Some(rk45_wrap_step),
            None,
            None,
            None
        ),
        0
    );

    let cfg_params = r#","parameters":{"relTol":1e-8,"absTol":1e-10}"#;
    let y0 = [1.0f64, 2.0];
    let id = create(&format!(
        r#"{{"method":"rk45_wrap","source":"wasm","dim":2{cfg_params}}}"#
    ));
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 1.0) }, 0);
    let mut tw = 0.0f64;
    let mut yw = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id, &mut tw, yw.as_mut_ptr(), 2) }, 2);

    let id2 = create(&format!(
        r#"{{"method":"rk45","source":"wasm","dim":2{cfg_params}}}"#
    ));
    assert!(id2 >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id2, Some(rhs_decay), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_set_state(id2, 0.0, y0.as_ptr(), 2) }, 0);
    assert_eq!(unsafe { tension_solver_step(id2, 1.0) }, 0);
    let mut td = 0.0f64;
    let mut yd = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id2, &mut td, yd.as_mut_ptr(), 2) }, 2);

    assert_eq!(tw.to_bits(), td.to_bits(), "t must match bit-for-bit");
    for i in 0..2 {
        assert_eq!(
            yw[i].to_bits(),
            yd[i].to_bits(),
            "component {i}: wrapper {} vs direct {}",
            yw[i],
            yd[i]
        );
    }
    // And it is the right answer, not merely the same one.
    let exact = [(-1.0f64).exp(), 2.0 * (-1.0f64).exp()];
    for i in 0..2 {
        assert!((yw[i] - exact[i]).abs() <= 1.0e-8);
    }
    println!("P5 rk45 wrapper bit-identical to direct: t = {tw}, y = {yw:?}");
    unsafe {
        tension_solver_destroy(id);
        tension_solver_destroy(id2);
    }
}

// ── P6: NULL lifecycle slots use the shim's defaults ──────────────────────

#[test]
fn p6_null_state_slots_use_shim_default() {
    let _g = lock();
    ensure_midpoint();

    // The sample plugin leaves state/set_state/destroy NULL: the public
    // entry points must fall back to the shim's own y/t, not refuse.
    let id = create(r#"{"method":"midpoint","source":"wasm","dim":1}"#);
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    let y0 = [1.0f64];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 1) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, 0);

    let mut t = 0.0f64;
    let mut y = [0.0f64; 1];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 1) }, 1);
    assert_eq!(t, 0.1);
    assert!(
        (y[0] - 0.905).abs() <= 1.0e-12,
        "the plugin's in-place write must be what state reads back: {}",
        y[0]
    );
    unsafe { tension_solver_destroy(id) };
}

// ── P7: a failing step does not advance t ─────────────────────────────────

#[test]
fn p7_failing_plugin_step_does_not_advance_time() {
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
    unsafe { tension_solver_destroy(id) };
}
