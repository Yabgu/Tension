//! P2 integration tests for the tension-solver C ABI shim.
//!
//! The shim (`tension-solver/src/tension_solver.c`) owns the handle table,
//! the config struct, the compiled validation rules and the method
//! registry; the numerical core stays the P1 Fortran archive, linked through
//! `tension-core/build.rs`. These tests drive the seven entry points
//! directly — raw FFI, no Rust wrapper (that is P5).
//!
//! The config is a `tension_solver_config` (the header's struct, which P9b
//! made `create`'s argument); `tests/support/config.rs` builds one from Rust
//! values and owns the strings its pointers borrow.
//!
//! The "wasm source" here is exactly what it is at the shim level: plain
//! `extern "C"` function pointers handed in through `bind_callbacks`. The
//! wasm-to-C bridge that produces such pointers from guest exports is P4.
//!
//! The shim has one process-global table and registry, so the tests take
//! turns through `SERIAL`, and every test cleans up what it creates.

use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[path = "support/config.rs"]
mod support;

use support::{tension_solver_create, Config};

static SERIAL: Mutex<()> = Mutex::new(());
static PLUGIN_CALLS: AtomicUsize = AtomicUsize::new(0);

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
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Build a config, call `tension_solver_create`, drop the config.
fn create(cfg: &Config) -> i32 {
    cfg.create()
}

/// The degenerate call: a NULL config pointer.
fn create_null() -> i32 {
    unsafe { tension_solver_create(std::ptr::null()) }
}

/// Register a plugin. The vtable and its strings must outlive the
/// registration (the shim stores the pointer), so both are leaked — the
/// test process is the lifetime.
fn register_plugin(
    name: &str,
    kind: &str,
    deterministic: u32,
    derivative: Option<DerivFn>,
    step: Option<StepFn>,
) -> i32 {
    register_plugin_full(name, kind, deterministic, derivative, step, None, None, None)
}

/// As `register_plugin`, with the lifecycle slots spelled out. (P7 made
/// the slots load-bearing: a plugin handle's public state/set_state now
/// dispatch through them, so a plugin with visible state must present
/// it — see T18's rework.)
#[allow(clippy::too_many_arguments)]
fn register_plugin_full(
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

// ── callback fixtures ─────────────────────────────────────────────────────

/// y' = -y, elementwise — the RHS the P1 tests use.
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
unsafe extern "C" fn rhs_zero(_y: *const f64, len: i32, _t: f64, dy: *mut f64, _dy_cap: i32) -> i32 {
    for i in 0..len as usize {
        *dy.add(i) = 0.0;
    }
    0
}

/// A plugin "integrator" that only counts its invocations.
unsafe extern "C" fn step_count(_id: i32, _dt: f64) -> i32 {
    PLUGIN_CALLS.fetch_add(1, Ordering::SeqCst);
    0
}

/// T18's plugin: an integrator that owns its state (the Part D fork's
/// option (ii) shape, which the P7 lifecycle dispatch requires of a
/// plugin with visible state) and advances it by `dt` per component and
/// its clock by `dt`, through the public state/set_state surface — which
/// for a plugin handle dispatches back into the two slots below.
static T18_STATE: Mutex<(f64, [f64; 2])> = Mutex::new((0.0, [0.0, 0.0]));

unsafe extern "C" fn t18_state(_id: i32, t_out: *mut f64, y_out: *mut f64, y_cap: i32) -> i32 {
    if t_out.is_null() || y_out.is_null() || y_cap < 2 {
        return -22;
    }
    let s = T18_STATE.lock().unwrap_or_else(|p| p.into_inner());
    *t_out = s.0;
    std::ptr::copy_nonoverlapping(s.1.as_ptr(), y_out, 2);
    2
}

unsafe extern "C" fn t18_set_state(_id: i32, t: f64, y: *const f64, y_len: i32) -> i32 {
    if y.is_null() || y_len != 2 {
        return -22;
    }
    let mut s = T18_STATE.lock().unwrap_or_else(|p| p.into_inner());
    s.0 = t;
    std::ptr::copy_nonoverlapping(y, s.1.as_mut_ptr(), 2);
    0
}

unsafe extern "C" fn step_slope1(id: i32, dt: f64) -> i32 {
    let mut t = 0.0f64;
    let mut y = [0.0f64; 2];
    let rc = tension_solver_state(id, &mut t, y.as_mut_ptr(), 2);
    if rc != 2 {
        return -5;
    }
    for v in y.iter_mut() {
        *v += dt;
    }
    tension_solver_set_state(id, t + dt, y.as_ptr(), 2)
}

// ── T1: create/destroy lifecycle ──────────────────────────────────────────

#[test]
fn t1_create_destroy_lifecycle() {
    let _g = lock();
    assert_eq!(
        register_plugin("p_t1", "custom", 0, Some(rhs_zero), Some(step_count)),
        0
    );
    let id = create(&Config::new("p_t1", "native").dim(2));
    assert!(id >= 1, "create returned {id}");
    unsafe { tension_solver_destroy(id) };
    unsafe { tension_solver_destroy(id) }; // idempotent, in-range
}

// ── T2: unknown method ────────────────────────────────────────────────────

#[test]
fn t2_unknown_method() {
    let _g = lock();
    assert_eq!(create(&Config::new("nope", "wasm").dim(1)), -2);
}

// ── T3: malformed structs ─────────────────────────────────────────────────
//
// The JSON era's malformed-text cases are structural now (P9b): the shim
// reads a `tension_solver_config`, so "malformed" means a missing pointer, a
// zero length, a reserved bitmap bit, or an out-of-range stated value — the
// wire-level refusals belong to the host's decoder (the P5 tests).

#[test]
fn t3_malformed_struct() {
    let _g = lock();
    // A NULL config pointer.
    assert_eq!(create_null(), -22);
    // A NULL method pointer, and a non-NULL one with method_len == 0.
    assert_eq!(create(&Config::new("euler", "wasm").dim(1).method_none()), -22);
    assert_eq!(create(&Config::new("euler", "wasm").dim(1).method_empty()), -22);
    // The same two shapes for the source.
    assert_eq!(create(&Config::new("euler", "wasm").dim(1).source_none()), -22);
    assert_eq!(create(&Config::new("euler", "wasm").dim(1).source_empty()), -22);
    // The bitmap's reserved bits (9-31 must be zero) are refused in any
    // combination with the nine named ones.
    assert_eq!(create(&Config::new("euler", "wasm").dim(1).bits(1 << 9)), -22);
    assert_eq!(create(&Config::new("euler", "wasm").dim(1).bits(1 << 31)), -22);
    assert_eq!(
        create(&Config::new("euler", "wasm").dim(1).rel_tol(1e-6).bits(1 << 20)),
        -22
    );
    // Stated values keep the JSON era's range floor, now on the struct's
    // fields: non-negative, finite, a non-empty step window, and an
    // `iterations` that fits the core's int32_t.
    assert_eq!(create(&Config::new("rk45", "wasm").dim(1).rel_tol(-1.0)), -22);
    assert_eq!(create(&Config::new("rk45", "wasm").dim(1).rel_tol(f64::NAN)), -22);
    assert_eq!(
        create(&Config::new("rk45", "wasm").dim(1).max_step(f64::INFINITY)),
        -22
    );
    assert_eq!(
        create(&Config::new("rk45", "wasm").dim(1).min_step(1.0).max_step(0.5)),
        -22
    );
    assert_eq!(create(&Config::new("rk45", "wasm").dim(1).iterations(-1)), -22);
    // `dim` keeps the resource bound the JSON era's parser enforced.
    assert_eq!(create(&Config::new("euler", "wasm").dim(10_000_001)), -22);
}

// ── T4: source requires ───────────────────────────────────────────────────

#[test]
fn t4_wasm_requires_dim() {
    let _g = lock();
    assert_eq!(create(&Config::new("euler", "wasm")), -22);
}

// ── T5: pairing rule ──────────────────────────────────────────────────────

#[test]
fn t5_builtin_native_pairing() {
    let _g = lock();
    assert_eq!(create(&Config::new("rk45", "native").dim(1)), -22);
    // euler too: the rule is about built-ins, not about implementation.
    assert_eq!(create(&Config::new("euler", "native").dim(1)), -22);
}

// ── T6: world is wired (P8e) ──────────────────────────────────────────────

#[test]
fn t6_world_is_accepted_with_dim() {
    let _g = lock();
    // World declares no `requires` (schema.yaml), but no handle can be
    // allocated without a dim: the host compiles the embedded world and
    // synthesizes it (P8e), and a config that arrives without one is
    // refused.
    assert_eq!(create(&Config::new("euler", "world")), -22);

    let id = create(&Config::new("euler", "world").dim(2));
    assert!(id >= 1, "world+dim creates a handle: {id}");
    // No f is bound yet: the step refuses, exactly as for source: wasm.
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, -22);
    unsafe { tension_solver_destroy(id) };
}

// ── T7: id-table exhaustion ───────────────────────────────────────────────

#[test]
fn t7_id_table_exhaustion() {
    let _g = lock();
    let mut ids = Vec::new();
    let mut last = 0;
    for _ in 0..1000 {
        last = create(&Config::new("euler", "wasm").dim(1));
        if last == -24 {
            break;
        }
        assert!(last >= 1, "create returned {last}");
        ids.push(last);
    }
    assert_eq!(last, -24, "expected -EMFILE once the table fills");
    assert!(ids.len() >= 2, "table should hold more than a couple");
    for id in ids {
        unsafe { tension_solver_destroy(id) };
    }
    // Destroyed slots are reusable.
    let id = create(&Config::new("euler", "wasm").dim(1));
    assert!(id >= 1);
    unsafe { tension_solver_destroy(id) };
}

// ── T8: destroyed id is dead ──────────────────────────────────────────────

#[test]
fn t8_step_on_destroyed_id() {
    let _g = lock();
    let id = create(&Config::new("euler", "wasm").dim(1));
    assert!(id >= 1);
    unsafe { tension_solver_destroy(id) };
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, -9);
    let mut t = 0.0;
    let mut y = [0.0f64; 1];
    assert_eq!(
        unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 1) },
        -9
    );
}

// ── T9: plugin registration + step dispatch ───────────────────────────────

#[test]
fn t9_plugin_step_dispatch() {
    let _g = lock();
    assert_eq!(
        register_plugin("p_t9", "custom", 1, Some(rhs_zero), Some(step_count)),
        0
    );
    PLUGIN_CALLS.store(0, Ordering::SeqCst);
    let id = create(&Config::new("p_t9", "native").dim(1));
    assert!(id >= 1);
    assert_eq!(unsafe { tension_solver_step(id, 0.1) }, 0);
    assert_eq!(PLUGIN_CALLS.load(Ordering::SeqCst), 1, "plugin step ran");
    unsafe { tension_solver_destroy(id) };
}

// ── T10: shadowing a built-in ─────────────────────────────────────────────

#[test]
fn t10_shadow_builtin_refused() {
    let _g = lock();
    assert_eq!(
        register_plugin("euler", "custom", 1, None, Some(step_count)),
        -22
    );
}

// ── T11: kind/deterministic mismatch ──────────────────────────────────────

#[test]
fn t11_stochastic_must_be_nondeterministic() {
    let _g = lock();
    assert_eq!(
        register_plugin("p_t11", "stochastic", 1, None, Some(step_count)),
        -22
    );
    // ...and the agreeing declaration is accepted.
    assert_eq!(
        register_plugin("p_t11b", "stochastic", 0, None, Some(step_count)),
        0
    );
}

// ── T12: custom accepts both deterministic values ─────────────────────────

#[test]
fn t12_custom_determinism_free() {
    let _g = lock();
    assert_eq!(register_plugin("p_t12a", "custom", 1, None, Some(step_count)), 0);
    assert_eq!(register_plugin("p_t12b", "custom", 0, None, Some(step_count)), 0);
}

// ── T13: a plugin without an integrator ───────────────────────────────────

#[test]
fn t13_step_required() {
    let _g = lock();
    assert_eq!(register_plugin("p_t13", "custom", 0, None, None), -22);
}

// ── T14: native bind is a no-op ───────────────────────────────────────────

#[test]
fn t14_bind_native_null_noop() {
    let _g = lock();
    assert_eq!(
        register_plugin("p_t14", "custom", 0, Some(rhs_zero), Some(step_count)),
        0
    );
    let id = create(&Config::new("p_t14", "native").dim(1));
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, None, None) },
        0
    );
    unsafe { tension_solver_destroy(id) };
}

// ── T15: the world bind rule (reachable since P8e) ────────────────────────
//
// P8e wired `source: "world"`: the host compiles the embedded world and
// binds its evaluator as the derivative, so world and wasm bind identically
// — the shim never learns which source a function pointer came from.

#[test]
fn t15_world_binds_like_wasm() {
    let _g = lock();
    let id = create(&Config::new("euler", "world").dim(1));
    assert!(id >= 1, "world+dim creates: {id}");

    // Nothing bound: the step refuses (there is no f to call).
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, -22);
    // An empty bind is refused.
    assert_eq!(unsafe { tension_solver_bind_callbacks(id, None, None) }, -22);
    // A derivative binds, and the step then reaches it.
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, 0);
    unsafe { tension_solver_destroy(id) };
}

// ── T16: step/bind call order ─────────────────────────────────────────────

#[test]
fn t16_bind_call_order() {
    let _g = lock();

    // step before bind, source: wasm -> -EINVAL; bind then step -> fine.
    let id = create(&Config::new("euler", "wasm").dim(1));
    assert!(id >= 1);
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, -22);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, 0);
    // bind after the first step -> -EINVAL.
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        -22
    );
    unsafe { tension_solver_destroy(id) };

    // bind with both NULL, source: wasm -> -EINVAL.
    let id = create(&Config::new("euler", "wasm").dim(1));
    assert!(id >= 1);
    assert_eq!(unsafe { tension_solver_bind_callbacks(id, None, None) }, -22);
    unsafe { tension_solver_destroy(id) };
}

// ── T17: state/set_state carry both t and y ───────────────────────────────

#[test]
fn t17_state_round_trip() {
    let _g = lock();
    let id = create(&Config::new("euler", "wasm").dim(2));
    assert!(id >= 1);

    let y0 = [7.0f64, -1.5];
    assert_eq!(unsafe { tension_solver_set_state(id, 3.5, y0.as_ptr(), 2) }, 0);

    let mut t = 0.0f64;
    let mut y = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 2) }, 2);
    assert_eq!(t, 3.5);
    assert_eq!(y, y0);

    // Wrong capacities / lengths are -EINVAL, not partial writes.
    let mut short = [0.0f64; 1];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, short.as_mut_ptr(), 1) }, -22);
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 1) }, -22);

    unsafe { tension_solver_destroy(id) };
}

// ── T18: a plugin's step advances y and t ─────────────────────────────────
//
// P7 reworked this test's fixture. Until P7, a plugin handle's public
// state/set_state used the shim's own y/t, so a plugin could advance the
// visible state without owning it. Since P7 (DESIGN.md §11) those entry
// points dispatch through the vtable for plugin handles — a plugin with
// visible state must present it, as this fixture now does.

#[test]
fn t18_plugin_step_advances() {
    let _g = lock();
    assert_eq!(
        register_plugin_full(
            "p_t18",
            "custom",
            0,
            Some(rhs_zero),
            Some(step_slope1),
            Some(t18_state),
            Some(t18_set_state),
            None
        ),
        0
    );
    let id = create(&Config::new("p_t18", "native").dim(2));
    assert!(id >= 1);
    assert_eq!(unsafe { tension_solver_step(id, 0.25) }, 0);
    assert_eq!(unsafe { tension_solver_step(id, 0.25) }, 0);

    let mut t = 0.0f64;
    let mut y = [0.0f64; 2];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 2) }, 2);
    assert_eq!(t, 0.5);
    assert_eq!(y, [0.5, 0.5]);
    unsafe { tension_solver_destroy(id) };
}

// ── T19: built-in euler through the bound-callback path ───────────────────

#[test]
fn t19_euler_with_bound_derivative() {
    let _g = lock();
    let id = create(&Config::new("euler", "wasm").dim(1));
    assert!(id >= 1);
    assert_eq!(
        unsafe { tension_solver_bind_callbacks(id, Some(rhs_decay), None) },
        0
    );
    let y0 = [1.0f64];
    assert_eq!(unsafe { tension_solver_set_state(id, 0.0, y0.as_ptr(), 1) }, 0);

    // One euler step of dt = 0.5 on y' = -y: y -> y + 0.5*(-y) = 0.5, t -> 0.5.
    assert_eq!(unsafe { tension_solver_step(id, 0.5) }, 0);
    let mut t = 0.0f64;
    let mut y = [0.0f64; 1];
    assert_eq!(unsafe { tension_solver_state(id, &mut t, y.as_mut_ptr(), 1) }, 1);
    assert_eq!(t, 0.5);
    assert_eq!(y[0], 0.5);
    unsafe { tension_solver_destroy(id) };
}

// ── T20: the compiled rules vs schema.yaml (drift fails the test) ─────────

fn schema_text() -> String {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-solver")
        .join("schema.yaml");
    std::fs::read_to_string(path).expect("schema.yaml readable")
}

/// The `backends:` block: (name, declared `bundles_rhs: false`).
fn schema_backends(text: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut inside = false;
    let mut cur: Option<(String, bool)> = None;
    for line in text.lines() {
        if !inside {
            if line.starts_with("backends:") {
                inside = true;
            }
            continue;
        }
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("  - name:") {
            if let Some(b) = cur.take() {
                out.push(b);
            }
            cur = Some((rest.trim().to_string(), false));
        } else if line.starts_with("    ") {
            if line.trim() == "bundles_rhs: false" {
                if let Some(b) = cur.as_mut() {
                    b.1 = true;
                }
            }
        } else {
            // back to column zero: the next top-level section
            if let Some(b) = cur.take() {
                out.push(b);
            }
            inside = false;
        }
    }
    if let Some(b) = cur.take() {
        out.push(b);
    }
    out
}

/// The `sources:` block: (name, requires).
fn schema_sources(text: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut inside = false;
    let mut cur: Option<(String, Vec<String>)> = None;
    for line in text.lines() {
        if !inside {
            if line.starts_with("sources:") {
                inside = true;
            }
            continue;
        }
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("  ") {
            if !rest.starts_with(' ') && rest.ends_with(':') {
                if let Some(s) = cur.take() {
                    out.push(s);
                }
                cur = Some((rest.trim_end_matches(':').to_string(), Vec::new()));
            } else if let Some(list) = rest.trim().strip_prefix("requires:") {
                let inner = list
                    .trim()
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .trim();
                let requires: Vec<String> = if inner.is_empty() {
                    Vec::new()
                } else {
                    inner.split(',').map(|s| s.trim().to_string()).collect()
                };
                if let Some(s) = cur.as_mut() {
                    s.1 = requires;
                }
            }
        } else {
            if let Some(s) = cur.take() {
                out.push(s);
            }
            inside = false;
        }
    }
    if let Some(s) = cur.take() {
        out.push(s);
    }
    out
}

#[test]
fn t20_compiled_rules_match_schema() {
    let _g = lock();
    let text = schema_text();

    // ── backends: names and bundles_rhs ──
    let backends = schema_backends(&text);
    assert_eq!(backends.len(), 7, "schema declares seven backends");
    for (name, declares_false) in &backends {
        assert!(
            *declares_false,
            "{name}: schema does not declare bundles_rhs: false"
        );

        // Every declared name is registered. All six compiled methods
        // create a handle (verlet and implicit_euler since P6); spook is
        // registered but not compiled and answers -ENOSYS (DESIGN.md
        // §10). Never -ENOENT, never -EINVAL. The probe uses dim 2 — a
        // dimension every method accepts (verlet requires even, dim >= 2;
        // its dim-1 floor is the method's own rule, pinned in V1/S1b).
        let rc = create(&Config::new(name, "wasm").dim(2));
        assert!(rc != -2, "{name}: not registered (ENOENT)");
        assert!(rc != -22, "{name}: rejected as malformed");
        if rc >= 1 {
            unsafe { tension_solver_destroy(rc) };
        } else {
            assert_eq!(rc, -38, "{name}: expected -ENOSYS");
        }

        // bundles_rhs: false + the pairing rule => native is refused.
        assert_eq!(
            create(&Config::new(name, "native").dim(1)),
            -22,
            "{name}: pairing rule"
        );
    }

    // ── sources: names and requires ──
    let sources = schema_sources(&text);
    assert_eq!(sources.len(), 3, "schema declares three sources");
    for (name, requires) in &sources {
        match name.as_str() {
            "world" => assert!(requires.is_empty(), "world requires []"),
            "wasm" | "native" => assert_eq!(requires, &["dim".to_string()], "{name} requires [dim]"),
            other => panic!("unexpected source {other}"),
        }
    }

    // Behavior matches the parsed requires.
    assert_eq!(create(&Config::new("euler", "wasm")), -22);
    assert_eq!(register_plugin("p_t20", "custom", 0, Some(rhs_zero), Some(step_count)), 0);
    assert_eq!(create(&Config::new("p_t20", "native")), -22);
    let id = create(&Config::new("p_t20", "native").dim(1));
    assert!(id >= 1);
    unsafe { tension_solver_destroy(id) };
    // world declares no `requires`, but the shim cannot allocate without a
    // dim: the host synthesizes one (P8e), and a config that states no dim
    // is refused. With one, the source is accepted — no longer -ENOSYS.
    assert_eq!(create(&Config::new("euler", "world")), -22);
    let world_id = create(&Config::new("euler", "world").dim(1));
    assert!(world_id >= 1, "world+dim is accepted: {world_id}");
    unsafe { tension_solver_destroy(world_id) };
    // A source outside the schema's three is refused.
    assert_eq!(create(&Config::new("euler", "gpu").dim(1)), -22);

    // ── preset_format.allowed: the struct's vocabulary ──
    //
    // Everything the JSON era's `allowed` list named is a struct field now
    // (`dim`, `description`, and `parameters` as the bitmap plus values), so
    // there is no text left to put an unknown key into: the fields *are* the
    // vocabulary, and the wire's decoder refuses a blob that does not match
    // it (the P5 tests). What survives as behavior is the discipline: unused
    // knobs are warned about, not rejected, and a stated parameter keeps its
    // range floor.
    let id = create(&Config::new("euler", "wasm").dim(1).description("x").rel_tol(1e-6));
    assert!(id >= 1, "description and a stated parameter are accepted");
    unsafe { tension_solver_destroy(id) };
    // euler reads relTol and absTol only; relaxation is ignored, with a
    // warning on stderr (schema.yaml: "warned, not errored").
    let id = create(&Config::new("euler", "wasm").dim(1).relaxation(0.5));
    assert!(id >= 1, "a parameter euler does not read is ignored, not refused");
    unsafe { tension_solver_destroy(id) };
}
