//! `tension::solver` — the numerical solver coprocessor's guest surface.
//!
//! The guest ABI is five imports (GUEST_ABI.md §2): create, step, state,
//! set_state, destroy. Each is a thin adapter over the C shim
//! (`tension-solver/src/tension_solver.c`), which owns the handle table, the
//! config struct, the compiled validation rules, and the dispatch into the
//! Fortran core — none of which is repeated here. What this module adds is
//! the two things the shim cannot do itself: the wasm side of
//! `source: "wasm"` and the host side of `source: "world"`.
//!
//! # The configuration
//!
//! `solver_create`'s bytes are the binary config layout of
//! tension-solver/DESIGN.md §12 — not JSON, and not anything this module
//! invented: the framework writes it, [`config::decode_wire`] reads it
//! strictly, and the shim receives the decoded `tension_solver_config` and
//! never sees the wire. A blob that does not match §12 is refused with
//! `-EINVAL`, the reason on the debug channel (the wasm boundary has no err
//! channel; the resource loader's `tension_res_load` err buffer has no
//! counterpart here).
//!
//! # The reentrancy bridge
//!
//! Under `source: "wasm"` the derivative lives in the guest module. The
//! guest passes `solver_create` three function-table indices — derivative,
//! `buf_in`, `buf_out`; this module resolves them from the module's exported
//! `table`, stores the typed functions keyed by the shim's solver id, and
//! binds a [`derivative_trampoline`] through `tension_solver_bind_callbacks`.
//! The Fortran step loop then calls the
//! trampoline per stage, believing it is any other C function; the
//! trampoline performs P4's copy-in / call / copy-out dance against the
//! guest's linear memory (DESIGN.md §8).
//!
//! The trampoline is a plain `extern "C"` fn and cannot carry a context
//! argument — the ABI's derivative typedef has no user-data slot (a purity
//! decision at fd8e4bd) — so it reaches its context through a thread-local
//! that `solver_step` installs around the synchronous shim call: the guest's
//! `Caller` and the bound callbacks for the id being stepped. `step` is
//! synchronous and runs on one thread, so the window cannot interleave;
//! nested installs (a derivative that steps another solver) are saved and
//! restored.
//!
//! # `source: "world"`
//!
//! The config carries the world's YAML in the wire's `world` entry (and must
//! not state `dim` — schema.yaml puts that on the host). This module compiles
//! it, derives `dim` from the compiled header, fills the struct's `dim` with
//! it, keeps the bytes in a per-id map, and binds a [`world_trampoline`] that
//! runs the P8d evaluator. From the shim's side that is indistinguishable
//! from `source: "wasm"`: a function pointer arrived, and step calls it per
//! stage.
//!
//! # The one-guest assumption
//!
//! The shim's solver table is process-global while the bound-callback records
//! here live per store. A second guest in the same process would share the
//! id table but not the records — and any guest could destroy any handle by
//! guessing its id. The interpreter runs one guest per process today;
//! DESIGN.md §9 records this as a known limitation, not a hidden one.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Arc;

use tension_core::world::{self, World};
use wasmtime::{Caller, Func, Linker, Memory, Ref, Table, TypedFunc};

use crate::HostState;

mod config;

use config::{decode_wire, DecodedConfig, TensionSolverConfig};

/// The errno table's `-EINVAL` / `-EIO` (tension_solver.h).
const EINVAL: i32 = -22;
const EIO: i32 = -5;

/// The shim's `TS_MAX_DIM`; used here only to bound a host-side allocation.
const MAX_DIM: usize = 10_000_000;

// The C shim's entry points (tension-solver/include/tension_solver.h).
extern "C" {
    fn tension_solver_create(config: *const TensionSolverConfig) -> i32;
    fn tension_solver_step(id: i32, dt: f64) -> i32;
    fn tension_solver_state(id: i32, t_out: *mut f64, y_out: *mut f64, y_cap: i32) -> i32;
    fn tension_solver_set_state(id: i32, t: f64, y: *const f64, y_len: i32) -> i32;
    fn tension_solver_destroy(id: i32);
    fn tension_solver_bind_callbacks(
        id: i32,
        derivative: Option<DerivFn>,
        validate: Option<ValidateFn>,
    ) -> i32;
}

/// The derivative the shim stores (P4's signature, unchanged).
type DerivFn = unsafe extern "C" fn(*const f64, i32, f64, *mut f64, i32) -> i32;
/// The validate callback (unused by classical backends; NULL here).
type ValidateFn =
    unsafe extern "C" fn(*const f64, i32, *const f64, i32, f64, *mut u8, i32) -> i32;

/// A guest's bound callbacks for one wasm-source solver, resolved once at
/// create from the three table indices the guest passed. The typed handles
/// pin the signatures the convention declares, so a mis-shaped table entry
/// fails create rather than the first stage.
#[derive(Clone)]
struct GuestExports {
    derivative: TypedFunc<(i32, i32, f64, i32, i32), i32>,
    buf_in: TypedFunc<(), i32>,
    buf_out: TypedFunc<(), i32>,
    memory: Memory,
}

/// `tension::solver` host state, keyed by the shim's solver id: the
/// wasm-source bindings and the world-source bytes.
#[derive(Default)]
pub struct SolverHost {
    bound: HashMap<i32, GuestExports>,
    /// Compiled world bytes for `source: "world"` handles. An `Arc` so a
    /// step can hold them across the trampoline without copying — the map
    /// owns one reference, the bridge a clone for the duration of the step.
    /// Lives exactly as long as the handle: create inserts, destroy removes.
    worlds: HashMap<i32, Arc<[u8]>>,
}

/// The trampoline's context for one synchronous `solver_step` call. The
/// `'static` lifetime is erased deliberately: [`with_bridge`] installs the
/// value on its stack frame and clears the thread-local before returning, so
/// it never outlives the call whose guest frame keeps it valid.
struct Bridge {
    caller: Caller<'static, HostState>,
    exports: Option<GuestExports>,
    world: Option<Arc<[u8]>>,
}

thread_local! {
    /// The bridge [`derivative_trampoline`] reads; null outside
    /// [`with_bridge`]. A raw pointer, not a reference, because the
    /// trampoline is reached through a C function pointer and has no
    /// lifetime to borrow with.
    static BRIDGE: Cell<*mut Bridge> = const { Cell::new(std::ptr::null_mut()) };
}

/// Run `f` with the trampoline bridge installed — the wasm callbacks
/// and/or the world bytes for the solver being stepped. Nested installs are
/// saved and restored: a guest derivative that calls back into `solver_step`
/// nests, and the outer bridge comes back when the inner call returns.
fn with_bridge<T>(
    caller: Caller<'_, HostState>,
    exports: Option<GuestExports>,
    world: Option<Arc<[u8]>>,
    f: impl FnOnce() -> T,
) -> T {
    // SAFETY: the erased lifetime is only a name. `bridge` lives on this
    // stack frame; the thread-local is cleared before the frame ends, and
    // the trampoline only ever runs inside `f` (the shim is synchronous and
    // calls the derivative on this thread).
    let caller: Caller<'static, HostState> =
        unsafe { std::mem::transmute::<Caller<'_, HostState>, Caller<'static, HostState>>(caller) };
    let mut bridge = Bridge { caller, exports, world };
    let prev = BRIDGE.with(|slot| slot.replace(std::ptr::addr_of_mut!(bridge)));
    let out = f();
    BRIDGE.with(|slot| slot.set(prev));
    out
}

/// The derivative the shim stores for a wasm-source solver. Called from the
/// Fortran step loop per stage; copies the state into the guest's input
/// buffer, calls `_derivative`, copies the result back out (P4's dance, with
/// the context reached through the bridge).
unsafe extern "C" fn derivative_trampoline(
    y: *const f64,
    len: i32,
    t: f64,
    dy: *mut f64,
    dy_cap: i32,
) -> i32 {
    if y.is_null() || dy.is_null() || len < 0 || dy_cap < 0 {
        return EINVAL;
    }
    let ptr = BRIDGE.with(|slot| slot.get());
    if ptr.is_null() {
        return EINVAL; // no step in flight on this thread
    }
    // SAFETY: `ptr` was installed by `with_bridge` on this thread and is
    // cleared before that call returns; the Fortran loop only runs the
    // trampoline inside that window.
    let bridge = unsafe { &mut *ptr };
    // Split the borrows: the exports come from the bridge, the caller is
    // reborrowed for the guest calls — two disjoint fields.
    let Bridge { caller, exports, .. } = bridge;
    let Some(exports) = exports.as_ref() else {
        return EINVAL;
    };
    let bin = match exports.buf_in.call(&mut *caller, ()) {
        Ok(v) => v,
        Err(_) => return EIO,
    };
    let bout = match exports.buf_out.call(&mut *caller, ()) {
        Ok(v) => v,
        Err(_) => return EIO,
    };
    if bin < 0 || bout < 0 {
        return EIO; // a negative address is guest nonsense
    }
    let bytes = (len as usize) * 8;
    // SAFETY: the shim passes `y`/`dy` as guest-visible f64 buffers of `len`
    // slots (`len == dim`); viewing them as bytes is a plain
    // reinterpretation.
    let input = unsafe { std::slice::from_raw_parts(y as *const u8, bytes) };
    if exports.memory.write(&mut *caller, bin as usize, input).is_err() {
        return EIO;
    }
    let rc = match exports
        .derivative
        .call(&mut *caller, (bin, len, t, bout, dy_cap))
    {
        Ok(v) => v,
        Err(_) => return EIO,
    };
    // SAFETY: as above, for the output buffer.
    let output = unsafe { std::slice::from_raw_parts_mut(dy as *mut u8, bytes) };
    if exports.memory.read(&mut *caller, bout as usize, output).is_err() {
        return EIO;
    }
    rc
}

/// The derivative the shim stores for a `source: "world"` solver: the P8d
/// evaluator behind the ABI's callback signature. Reached through the same
/// thread-local bridge as [`derivative_trampoline`]; the bridge carries the
/// compiled bytes (not the evaluator, which borrows them), so each stage
/// loads a fresh view — a bounds-checked walk over tens of entries.
unsafe extern "C" fn world_trampoline(
    y: *const f64,
    len: i32,
    t: f64,
    dy: *mut f64,
    dy_cap: i32,
) -> i32 {
    if y.is_null() || dy.is_null() || len < 0 || dy_cap < len {
        return EINVAL;
    }
    let ptr = BRIDGE.with(|slot| slot.get());
    if ptr.is_null() {
        return EINVAL; // no step in flight on this thread
    }
    // SAFETY: as in `derivative_trampoline` — installed by `with_bridge` on
    // this thread for the duration of one synchronous shim call.
    let bridge = unsafe { &mut *ptr };
    let Some(bytes) = bridge.world.as_ref() else {
        return EINVAL;
    };
    let Ok(world) = World::load(bytes) else {
        return EIO; // the bytes loaded at create; defence, not a live path
    };
    let n = len as usize;
    // SAFETY: the shim passes `y`/`dy` as guest-visible f64 buffers with
    // `len == dy_cap == dim` (the header's derivative contract).
    let y_slice = unsafe { std::slice::from_raw_parts(y, n) };
    let dy_slice = unsafe { std::slice::from_raw_parts_mut(dy, n) };
    match world.eval(t, y_slice, dy_slice) {
        Ok(()) => 0,
        Err(_) => EIO,
    }
}

/// Resolve the three callbacks the guest passed — table indices into the
/// module's exported `table` — with the signatures the convention declares.
/// Any entry that is missing, out of range, null, or mis-shaped is `None`:
/// create refuses it. The module must export its function table as `table`
/// (AssemblyScript produces that with `asc --exportTable`); without the
/// export there is no way to reach an indirect function, and create refuses
/// as it does for any other bad index.
fn resolve_callbacks(
    caller: &mut Caller<'_, HostState>,
    derivative_idx: i32,
    buf_in_idx: i32,
    buf_out_idx: i32,
) -> Option<GuestExports> {
    let table = caller.get_export("table")?.into_table()?;
    let memory = caller.get_export("memory")?.into_memory()?;
    let derivative = table_func(&table, caller, derivative_idx)?;
    let buf_in = table_func(&table, caller, buf_in_idx)?;
    let buf_out = table_func(&table, caller, buf_out_idx)?;
    Some(GuestExports {
        derivative: derivative.typed::<(i32, i32, f64, i32, i32), i32>(&*caller).ok()?,
        buf_in: buf_in.typed::<(), i32>(&*caller).ok()?,
        buf_out: buf_out.typed::<(), i32>(&*caller).ok()?,
        memory,
    })
}

/// The function at `index` in the guest's exported table: `None` for a
/// negative or out-of-range index, or for a null table entry.
fn table_func(table: &Table, caller: &mut Caller<'_, HostState>, index: i32) -> Option<Func> {
    if index < 0 {
        return None;
    }
    match table.get(&mut *caller, index as u32)? {
        Ref::Func(Some(func)) => Some(func),
        _ => None,
    }
}

// ── source: "world" ───────────────────────────────────────────────────────
//
// A world-source config carries the YAML itself, in the wire's `world` entry
// (DESIGN.md §12). `dim` is *not* stated by the caller (schema.yaml: world-
// sourced configs never state it) and the decoder refuses one that does; the
// host compiles the YAML, derives dim from the compiled header, fills the
// struct's `dim` with it, and keeps the bytes alive per id. The shim never
// sees YAML.

/// Create a `source: "world"` solver: compile the embedded world, derive its
/// dim, fill the struct's `dim`, create through the shim, and bind the
/// evaluator. Every failure is `-EINVAL`, with the reason on the debug
/// channel (the wasm boundary has no err channel; solver/DESIGN.md §9).
fn create_world_solver(caller: &mut Caller<'_, HostState>, decoded: &DecodedConfig) -> i32 {
    let Some(yaml) = decoded.world.as_deref() else {
        // The decoder refuses this shape; the arm is defence, not a live path.
        eprintln!("[tension-core] world-source config carries no world text");
        return EINVAL;
    };
    let compiled = match world::compile(yaml) {
        Ok(bytes) => bytes,
        Err(e) => {
            // Line and column ride in the Display form; the log is where
            // they surface.
            eprintln!("[tension-core] world compile failed: {e}");
            return EINVAL;
        }
    };
    let dim = match World::load(&compiled) {
        Ok(world) => world.dim(),
        Err(e) => {
            // Unreachable for bytes the compiler just produced; logged
            // rather than swallowed if it ever is not.
            eprintln!("[tension-core] compiled world failed to load: {e}");
            return EINVAL;
        }
    };
    if dim == 0 {
        // schema.yaml: a world that contributes no state is legal data, and
        // the source refuses to build a solver over it.
        eprintln!("[tension-core] world derives dim 0; the solver builds over dim >= 1");
        return EINVAL;
    }
    // The host synthesizes `dim` into the struct; the wire stated none (§12:
    // the host derives it, and refuses a config that states one).
    let mut ffi = decoded.to_c_config();
    ffi.dim = dim;
    let id = unsafe { tension_solver_create(&ffi) };
    if id < 1 {
        return id;
    }
    // Keep the bytes alive for the solver's lifetime; the trampoline borrows
    // them through the bridge per step.
    caller
        .data_mut()
        .solver
        .worlds
        .insert(id, Arc::from(compiled.into_boxed_slice()));
    let rc = unsafe { tension_solver_bind_callbacks(id, Some(world_trampoline), None) };
    if rc != 0 {
        caller.data_mut().solver.worlds.remove(&id);
        unsafe { tension_solver_destroy(id) };
        return rc;
    }
    id
}


/// Read `len` bytes at `ptr` out of guest memory; `None` when the range is
/// out of bounds (or the module exports no memory).
fn read_guest_bytes(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> Option<Vec<u8>> {
    if ptr < 0 || len < 0 {
        return None;
    }
    let mem = caller.get_export("memory").and_then(|e| e.into_memory())?;
    let data = mem.data(&*caller);
    let start = ptr as usize;
    let end = start.checked_add(len as usize)?;
    if end > data.len() {
        return None;
    }
    Some(data[start..end].to_vec())
}

/// Read `count` little-endian f64 slots from guest memory.
fn read_guest_f64s(caller: &mut Caller<'_, HostState>, ptr: i32, count: i32) -> Option<Vec<f64>> {
    let bytes = read_guest_bytes(caller, ptr, count.checked_mul(8)?)?;
    let mut out = Vec::with_capacity(bytes.len() / 8);
    for chunk in bytes.chunks_exact(8) {
        out.push(f64::from_le_bytes(chunk.try_into().ok()?));
    }
    Some(out)
}

/// Whether `len` bytes at `ptr` are inside guest memory.
fn guest_range_ok(caller: &mut Caller<'_, HostState>, ptr: i32, len: usize) -> bool {
    if ptr < 0 {
        return false;
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return false;
    };
    let data = mem.data(&*caller);
    match (ptr as usize).checked_add(len) {
        Some(end) => end <= data.len(),
        None => false,
    }
}

/// Write `values` as little-endian f64 slots into guest memory; false when
/// the range is out of bounds.
fn write_guest_f64s(caller: &mut Caller<'_, HostState>, ptr: i32, values: &[f64]) -> bool {
    if ptr < 0 {
        return false;
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return false;
    };
    // SAFETY: `values` is a valid f64 slice; viewing it as bytes is a plain
    // reinterpretation, and alignment 1 covers any f64 layout.
    let raw =
        unsafe { std::slice::from_raw_parts(values.as_ptr() as *const u8, values.len() * 8) };
    mem.write(&mut *caller, ptr as usize, raw).is_ok()
}

/// Register the five `tension::solver` imports. `tension::io`, `tension::res`,
/// `tension::audio` and `tension::ai` are untouched.
pub fn link_solver(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    linker.func_wrap(
        "tension::solver",
        "solver_create",
        |mut caller: Caller<'_, HostState>,
         wire_ptr: i32,
         wire_len: i32,
         derivative_idx: i32,
         buf_in_idx: i32,
         buf_out_idx: i32|
         -> i32 {
            let Some(wire) = read_guest_bytes(&mut caller, wire_ptr, wire_len) else {
                return EINVAL;
            };
            // The wire is the §12 layout; the host is its strict reader. A
            // refusal is `-EINVAL` with the reason on the debug channel.
            let decoded = match decode_wire(&wire) {
                Ok(decoded) => decoded,
                Err(e) => {
                    eprintln!("[tension-core] config refused: {e}");
                    return EINVAL;
                }
            };
            match decoded.source.as_str() {
                // `source: "world"`: the host compiles the YAML, derives
                // `dim`, and binds the evaluator the trampoline runs (P8e).
                "world" => create_world_solver(&mut caller, &decoded),
                // `source: "wasm"`: the guest passed the three callbacks'
                // table indices; the host resolves them from the module's
                // exported table and performs the bind on the guest's behalf
                // (GUEST_ABI.md §3.6); the guest never calls bind_callbacks.
                "wasm" => {
                    let id = unsafe { tension_solver_create(&decoded.to_c_config()) };
                    if id < 1 {
                        return id; // negative errno, unchanged
                    }
                    let Some(exports) =
                        resolve_callbacks(&mut caller, derivative_idx, buf_in_idx, buf_out_idx)
                    else {
                        // The config asked for the wasm source and one of the
                        // three indices does not name a function of the
                        // declared signature — or the module exports no table
                        // to resolve through. Refuse with -EINVAL — the same
                        // errno the shim uses when a wasm bind carries no
                        // callbacks at all — and take the id back out of the
                        // table first (it is 64 slots, process-wide). No
                        // binding exists yet — the map insert happens only
                        // once resolution has succeeded — so none is left
                        // behind.
                        unsafe { tension_solver_destroy(id) };
                        return EINVAL;
                    };
                    caller.data_mut().solver.bound.insert(id, exports);
                    let rc = unsafe {
                        tension_solver_bind_callbacks(id, Some(derivative_trampoline), None)
                    };
                    if rc != 0 {
                        caller.data_mut().solver.bound.remove(&id);
                        unsafe { tension_solver_destroy(id) };
                        return rc;
                    }
                    id
                }
                // `source: "native"`: no callbacks cross the boundary (the
                // plugin's vtable carries them) — the three indices are
                // ignored (GUEST_ABI.md §3.1).
                _ => unsafe { tension_solver_create(&decoded.to_c_config()) },
            }
        },
    )?;

    linker.func_wrap(
        "tension::solver",
        "solver_step",
        |caller: Caller<'_, HostState>, id: i32, dt: f64| -> i32 {
            let exports = caller.data().solver.bound.get(&id).cloned();
            let world = caller.data().solver.worlds.get(&id).cloned();
            with_bridge(caller, exports, world, || unsafe { tension_solver_step(id, dt) })
        },
    )?;

    linker.func_wrap(
        "tension::solver",
        "solver_state",
        |mut caller: Caller<'_, HostState>, id: i32, t_ptr: i32, y_ptr: i32, y_cap: i32| -> i32 {
            if y_cap < 0 {
                return EINVAL;
            }
            // The shim checks `y_cap < dim` before writing, and dim is
            // bounded by the shim's TS_MAX_DIM — so a host buffer of
            // min(y_cap, MAX_DIM) is always large enough, and a guest cannot
            // make this allocate without bound.
            let cap = (y_cap as usize).min(MAX_DIM);
            let mut t_out = 0.0f64;
            let mut y_out = vec![0.0f64; cap];
            let rc = unsafe { tension_solver_state(id, &mut t_out, y_out.as_mut_ptr(), y_cap) };
            if rc < 0 {
                return rc;
            }
            let n = rc as usize;
            // Validate both destination ranges before writing either, so a
            // failure hands back an untouched buffer.
            if n > cap
                || !guest_range_ok(&mut caller, t_ptr, 8)
                || !guest_range_ok(&mut caller, y_ptr, n * 8)
            {
                return EINVAL;
            }
            if !write_guest_f64s(&mut caller, t_ptr, &[t_out])
                || !write_guest_f64s(&mut caller, y_ptr, &y_out[..n])
            {
                return EINVAL; // cannot happen after the checks above
            }
            rc
        },
    )?;

    linker.func_wrap(
        "tension::solver",
        "solver_set_state",
        |mut caller: Caller<'_, HostState>, id: i32, t: f64, y_ptr: i32, y_len: i32| -> i32 {
            let Some(y) = read_guest_f64s(&mut caller, y_ptr, y_len) else {
                return EINVAL;
            };
            unsafe { tension_solver_set_state(id, t, y.as_ptr(), y_len) }
        },
    )?;

    linker.func_wrap(
        "tension::solver",
        "solver_destroy",
        |mut caller: Caller<'_, HostState>, id: i32| {
            // Both bindings go with the handle: the shim reuses ids after
            // destroy (it hands out the first free slot), so an entry left
            // here would outlive the store its function handles point into —
            // or feed the next solver a stale world.
            caller.data_mut().solver.bound.remove(&id);
            caller.data_mut().solver.worlds.remove(&id);
            unsafe { tension_solver_destroy(id) };
        },
    )?;

    Ok(())
}

/// The shim's solver table is process-global and carries no internal
/// locking; every test that touches it — whichever test module — serializes
/// on this one lock (the P5 tests and the P8e tests share the table).
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod p5_tests;
#[cfg(test)]
mod p8e_tests;
