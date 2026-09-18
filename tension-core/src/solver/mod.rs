//! `tension::solver` — the numerical solver coprocessor's guest surface.
//!
//! The guest ABI is five imports (GUEST_ABI.md §2): create, step, state,
//! set_state, destroy. Each is a thin adapter over the C shim
//! (`tension-solver/src/tension_solver.c`), which owns the handle table, the
//! config parser, the compiled validation rules, and the dispatch into the
//! Fortran core — none of which is repeated here. What this module adds is
//! the one thing the shim cannot do itself: the wasm side of
//! `source: "wasm"`.
//!
//! # The reentrancy bridge
//!
//! Under `source: "wasm"` the derivative lives in the guest module. At
//! `solver_create` this module resolves the guest's `_derivative`,
//! `deriv_buf_in` and `deriv_buf_out` exports, stores them keyed by the
//! shim's solver id, and binds a [`derivative_trampoline`] through
//! `tension_solver_bind_callbacks`. The Fortran step loop then calls the
//! trampoline per stage, believing it is any other C function; the
//! trampoline performs P4's copy-in / call / copy-out dance against the
//! guest's linear memory (DESIGN.md §8).
//!
//! The trampoline is a plain `extern "C"` fn and cannot carry a context
//! argument — the ABI's derivative typedef has no user-data slot (a purity
//! decision at fd8e4bd) — so it reaches its context through a thread-local
//! that `solver_step` installs around the synchronous shim call: the guest's
//! `Caller` and the bound exports for the id being stepped. `step` is
//! synchronous and runs on one thread, so the window cannot interleave;
//! nested installs (a derivative that steps another solver) are saved and
//! restored.
//!
//! # The one-guest assumption
//!
//! The shim's solver table is process-global while the bound-export records
//! here live per store. A second guest in the same process would share the
//! id table but not the records — and any guest could destroy any handle by
//! guessing its id. The interpreter runs one guest per process today;
//! DESIGN.md §9 records this as a known limitation, not a hidden one.

use std::cell::Cell;
use std::collections::HashMap;
use std::ffi::c_char;

use wasmtime::{Caller, Linker, Memory, TypedFunc};

use crate::HostState;

/// The errno table's `-EINVAL` / `-EIO` (tension_solver.h).
const EINVAL: i32 = -22;
const EIO: i32 = -5;

/// The shim's `TS_MAX_DIM`; used here only to bound a host-side allocation.
const MAX_DIM: usize = 10_000_000;

// The C shim's entry points (tension-solver/include/tension_solver.h).
extern "C" {
    fn tension_solver_create(config_json: *const c_char, config_len: usize) -> i32;
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

/// A guest's bound exports for one wasm-source solver, resolved once at
/// create. The typed handles pin the signatures the convention declares, so
/// a mis-shaped export fails create rather than the first stage.
#[derive(Clone)]
struct GuestExports {
    derivative: TypedFunc<(i32, i32, f64, i32, i32), i32>,
    buf_in: TypedFunc<(), i32>,
    buf_out: TypedFunc<(), i32>,
    memory: Memory,
}

/// `tension::solver` host state: the wasm-source bindings, keyed by the
/// shim's solver id.
#[derive(Default)]
pub struct SolverHost {
    bound: HashMap<i32, GuestExports>,
}

/// The trampoline's context for one synchronous `solver_step` call. The
/// `'static` lifetime is erased deliberately: [`with_bridge`] installs the
/// value on its stack frame and clears the thread-local before returning, so
/// it never outlives the call whose guest frame keeps it valid.
struct Bridge {
    caller: Caller<'static, HostState>,
    exports: Option<GuestExports>,
}

thread_local! {
    /// The bridge [`derivative_trampoline`] reads; null outside
    /// [`with_bridge`]. A raw pointer, not a reference, because the
    /// trampoline is reached through a C function pointer and has no
    /// lifetime to borrow with.
    static BRIDGE: Cell<*mut Bridge> = const { Cell::new(std::ptr::null_mut()) };
}

/// Run `f` with the trampoline bridge installed. Nested installs are saved
/// and restored: a guest derivative that calls back into `solver_step` nests,
/// and the outer bridge comes back when the inner call returns.
fn with_bridge<T>(
    caller: Caller<'_, HostState>,
    exports: Option<GuestExports>,
    f: impl FnOnce() -> T,
) -> T {
    // SAFETY: the erased lifetime is only a name. `bridge` lives on this
    // stack frame; the thread-local is cleared before the frame ends, and
    // the trampoline only ever runs inside `f` (the shim is synchronous and
    // calls the derivative on this thread).
    let caller: Caller<'static, HostState> =
        unsafe { std::mem::transmute::<Caller<'_, HostState>, Caller<'static, HostState>>(caller) };
    let mut bridge = Bridge { caller, exports };
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
    let Bridge { caller, exports } = bridge;
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

/// Resolve the three exports the `source: "wasm"` convention names, with the
/// signatures the convention declares. Any missing or mis-shaped export is
/// `None` — create refuses it.
fn resolve_exports(caller: &mut Caller<'_, HostState>) -> Option<GuestExports> {
    let derivative = caller.get_export("_derivative")?.into_func()?;
    let buf_in = caller.get_export("deriv_buf_in")?.into_func()?;
    let buf_out = caller.get_export("deriv_buf_out")?.into_func()?;
    let memory = caller.get_export("memory")?.into_memory()?;
    Some(GuestExports {
        derivative: derivative.typed::<(i32, i32, f64, i32, i32), i32>(&*caller).ok()?,
        buf_in: buf_in.typed::<(), i32>(&*caller).ok()?,
        buf_out: buf_out.typed::<(), i32>(&*caller).ok()?,
        memory,
    })
}

/// Does a shim-validated config declare `"source": "wasm"`?
///
/// A targeted probe, not a validator: the shim parsed and validated the
/// config before this runs, so the input here is one flat JSON object in the
/// documented subset (string and number values, the single nested
/// `parameters` object, short escapes in strings). The probe walks the
/// top-level members and compares the `source` member's value. Anything it
/// cannot classify answers `false`, which only skips the wasm binding — that
/// surfaces as the shim's own `-EINVAL` on the first step, never as a wrong
/// result.
fn config_source_is_wasm(bytes: &[u8]) -> bool {
    let mut p = Probe { b: bytes, i: 0 };
    p.ws();
    if !p.eat(b'{') {
        return false;
    }
    loop {
        p.ws();
        let Some(key) = p.string() else { return false };
        p.ws();
        if !p.eat(b':') {
            return false;
        }
        p.ws();
        if key == b"source" {
            return p.string().as_deref() == Some(b"wasm".as_slice());
        }
        if p.skip_value().is_none() {
            return false;
        }
        p.ws();
        if p.eat(b',') {
            continue;
        }
        return false; // '}' (or anything else): no `source` member seen
    }
}

/// A cursor over a shim-validated config, for the one question above.
struct Probe<'a> {
    b: &'a [u8],
    i: usize,
}

impl Probe<'_> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    /// Consume a quoted string; returns its decoded bytes (the short escapes
    /// the shim accepts; `\uXXXX` is outside its subset).
    fn string(&mut self) -> Option<Vec<u8>> {
        if !self.eat(b'"') {
            return None;
        }
        let mut out = Vec::new();
        loop {
            match *self.b.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let c = match *self.b.get(self.i)? {
                        b'"' => b'"',
                        b'\\' => b'\\',
                        b'/' => b'/',
                        b'b' => 0x08,
                        b'f' => 0x0C,
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        _ => return None,
                    };
                    out.push(c);
                    self.i += 1;
                }
                c => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }

    /// Skip one value: a string, a number, or the nested `parameters`
    /// object.
    fn skip_value(&mut self) -> Option<()> {
        match *self.b.get(self.i)? {
            b'"' => self.string().map(drop),
            b'{' => {
                self.i += 1;
                self.ws();
                if self.eat(b'}') {
                    return Some(());
                }
                loop {
                    self.ws();
                    self.string()?;
                    self.ws();
                    if !self.eat(b':') {
                        return None;
                    }
                    self.ws();
                    self.skip_value()?;
                    self.ws();
                    if self.eat(b',') {
                        continue;
                    }
                    if self.eat(b'}') {
                        return Some(());
                    }
                    return None;
                }
            }
            _ => {
                let start = self.i;
                while matches!(self.b.get(self.i), Some(c) if !matches!(c, b',' | b'}' | b' ' | b'\t' | b'\n' | b'\r'))
                {
                    self.i += 1;
                }
                (self.i > start).then_some(())
            }
        }
    }
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
        |mut caller: Caller<'_, HostState>, config_ptr: i32, config_len: i32| -> i32 {
            let Some(config) = read_guest_bytes(&mut caller, config_ptr, config_len) else {
                return EINVAL;
            };
            let id = unsafe { tension_solver_create(config.as_ptr().cast(), config.len()) };
            if id < 1 {
                return id; // negative errno, unchanged
            }
            if !config_source_is_wasm(&config) {
                return id;
            }
            // `source: "wasm"`: the host resolves the guest's exports and
            // performs the bind on the guest's behalf (GUEST_ABI.md §3.6);
            // the guest never calls bind_callbacks.
            let Some(exports) = resolve_exports(&mut caller) else {
                // The config asked for the wasm source; the module does not
                // provide the three exports the convention requires. Refuse
                // with -EINVAL — the same errno the shim uses when a wasm
                // bind carries no callbacks at all — and take the id back
                // out of the table first (it is 64 slots, process-wide).
                // No binding exists yet — the map insert happens only once
                // resolution has succeeded — so none is left behind.
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
        },
    )?;

    linker.func_wrap(
        "tension::solver",
        "solver_step",
        |caller: Caller<'_, HostState>, id: i32, dt: f64| -> i32 {
            let exports = caller.data().solver.bound.get(&id).cloned();
            with_bridge(caller, exports, || unsafe { tension_solver_step(id, dt) })
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
            // The binding goes with the handle: the shim reuses ids after
            // destroy (it hands out the first free slot), so an entry left
            // here would outlive the store its function handles point into.
            caller.data_mut().solver.bound.remove(&id);
            unsafe { tension_solver_destroy(id) };
        },
    )?;

    Ok(())
}

#[cfg(test)]
mod p5_tests;
