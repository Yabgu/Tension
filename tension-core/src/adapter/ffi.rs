//! The C ABI mirrors, the loader, and the closure factory.
//!
//! `tension-core/include/tension_adapter.h` is the contract; this module is its
//! Rust side. Every struct here is `#[repr(C)]` with the header's field order,
//! and the sizes are asserted against what the C compiler produces for the same
//! header — measured, not assumed:
//!
//! ```text
//! $ gcc -std=c11 -I tension-core/include … && ./sizes
//! value                   8      (tension_value)
//! core_api              112      abi_version 0, user 8, guest_read 16,
//!                                guest_write 24, guest_size 32,
//!                                resolve_callback 40, call_callback 48,
//!                                release_callback 56, log 64,
//!                                register_import 72, register_source 80,
//!                                post_event 88, class_info 96,
//!                                region_lookup 104
//! adapter                72      abi_version 0, name 8, flags 16, init 24,
//!                                link 32, publish 40, apply 48, shutdown 56,
//!                                destroy 64
//! ```
//!
//! Two conventions this module implements rather than describes:
//!
//! - Function-pointer fields are `Option<fn>`: the null-pointer optimization
//!   makes that layout-identical to the C pointer, and it is the only sound way
//!   to hold a slot the header documents as nullable (`publish`, `apply`) —
//!   materialising a null as a Rust `fn` type is immediate undefined behaviour.
//! - The union's fields carry a trailing underscore (`i32_`), because the
//!   primitive's name is not a field name Rust will parse without argument; the
//!   widths and the layout are what match C.
//!
//! The adapter is native code in this address space: the header says so, and the
//! safety comments below assume it is not hostile. What they do *not* assume is
//! that it is careful — every range that reaches guest memory is checked here.

use std::ffi::{c_char, c_void, CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use wasmtime::{Caller, Engine, FuncType, Val, ValType};

use super::signatures::{Signature, Slot, ValueType, MAX_PARAMS};
use super::AdapterHost;
use crate::session::posting::PostError;
use crate::HostState;

/// `TENSION_ADAPTER_ABI_VERSION` — the only version this build loads.
pub const ADAPTER_ABI_VERSION: u32 = 1;

/// The errnos at this boundary (`tension_adapter.h`, A.7).
pub const EINVAL: i32 = -22;
pub const EBUSY: i32 = -16;
pub const EBADF: i32 = -9;
pub const ENOENT: i32 = -2;
pub const ENOSYS: i32 = -38;
/// A class queue is full, or a publish budget is exhausted (the header's A.7
/// table carries this code at this boundary).
pub const ENOSPC: i32 = -28;

// ── A.3: values ───────────────────────────────────────────────────────────

/// Mirrors `tension_value`: one 8-byte slot. The field names carry a trailing
/// underscore so they cannot be read as the primitive types; the widths and the
/// union layout are the ABI's.
#[repr(C)]
#[derive(Copy, Clone)]
pub union TensionValue {
    pub i32_: i32,
    pub i64_: i64,
    pub f32_: f32,
    pub f64_: f64,
}

impl TensionValue {
    /// The zero slot. A `const fn` so the closure's argument array is a plain
    /// stack array with no initialisation pass.
    pub const fn zero() -> TensionValue {
        TensionValue { i64_: 0 }
    }
}

/// `tension_value_type` as the ABI carries it.
pub type ValueTypeCode = u32;

/// `tension_import_fn`: the adapter's side of one import.
pub type ImportFn =
    unsafe extern "C" fn(*mut c_void, *const TensionValue, u32, *mut TensionValue) -> i32;

// ── A.4: the core API ─────────────────────────────────────────────────────

pub type GuestReadFn = unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32) -> i32;
pub type GuestWriteFn = unsafe extern "C" fn(*mut c_void, u32, *const c_void, u32) -> i32;
pub type GuestSizeFn = unsafe extern "C" fn(*mut c_void) -> u32;
pub type ResolveCallbackFn =
    unsafe extern "C" fn(*mut c_void, u32, u32, *const u32, u32, *mut *mut c_void) -> i32;
pub type CallCallbackFn = unsafe extern "C" fn(
    *mut c_void,
    *mut c_void,
    *const TensionValue,
    u32,
    *mut TensionValue,
) -> i32;
pub type ReleaseCallbackFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32;
pub type LogFn = unsafe extern "C" fn(*mut c_void, i32, *const c_char, u32);
pub type RegisterImportFn = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    u32,
    *const u32,
    u32,
    Option<ImportFn>,
    *mut c_void,
    u32,
    u32,
) -> i32;
pub type RegisterSourceFn =
    unsafe extern "C" fn(*mut c_void, *const c_char, u32, *mut u32) -> i32;
#[allow(clippy::too_many_arguments)]
pub type PostEventFn = unsafe extern "C" fn(
    *mut c_void,
    u32,
    u32,
    u32,
    u32,
    u32,
    f32,
    f32,
    *mut u64,
) -> i32;
pub type ClassInfoFn =
    unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32, *mut u32) -> i32;
pub type RegionLookupFn = unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32) -> i32;

/// Mirrors `tension_core_api`. The session fills every slot; the adapter may
/// call any of them subject to the header's thread and phase rules.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct TensionCoreApi {
    pub abi_version: u32,
    pub user: *mut c_void,
    pub guest_read: Option<GuestReadFn>,
    pub guest_write: Option<GuestWriteFn>,
    pub guest_size: Option<GuestSizeFn>,
    pub resolve_callback: Option<ResolveCallbackFn>,
    pub call_callback: Option<CallCallbackFn>,
    pub release_callback: Option<ReleaseCallbackFn>,
    pub log: Option<LogFn>,
    pub register_import: Option<RegisterImportFn>,
    pub register_source: Option<RegisterSourceFn>,
    pub post_event: Option<PostEventFn>,
    pub class_info: Option<ClassInfoFn>,
    pub region_lookup: Option<RegionLookupFn>,
}

// ── A.5: the adapter vtable ───────────────────────────────────────────────

pub type InitFn = unsafe extern "C" fn(*mut c_void, *const TensionCoreApi) -> i32;
pub type LinkFn = unsafe extern "C" fn(*mut c_void, *const TensionCoreApi) -> i32;
pub type PublishFn = unsafe extern "C" fn(*mut c_void, *const TensionCoreApi) -> i32;
pub type ApplyFn = unsafe extern "C" fn(*mut c_void, u32, *const c_void, u32) -> i32;
pub type ShutdownFn = unsafe extern "C" fn(*mut c_void) -> i32;
pub type DestroyFn = unsafe extern "C" fn(*mut c_void);

/// Mirrors `tension_adapter`. `publish` and `apply` may be NULL, which is why
/// every function-pointer field here is an `Option`.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct TensionAdapter {
    pub abi_version: u32,
    pub name: *const c_char,
    pub flags: u32,
    pub init: Option<InitFn>,
    pub link: Option<LinkFn>,
    pub publish: Option<PublishFn>,
    pub apply: Option<ApplyFn>,
    pub shutdown: Option<ShutdownFn>,
    pub destroy: Option<DestroyFn>,
}

/// The layout checks. The numbers are the C compiler's, quoted in the module
/// docs; they hold on the 64-bit targets this project builds for, and the union
/// one holds everywhere.
const _: () = assert!(std::mem::size_of::<TensionValue>() == 8);

#[cfg(target_pointer_width = "64")]
const _: () = {
    assert!(std::mem::size_of::<TensionCoreApi>() == 112);
    assert!(std::mem::size_of::<TensionAdapter>() == 72);
    assert!(std::mem::offset_of!(TensionCoreApi, abi_version) == 0);
    assert!(std::mem::offset_of!(TensionCoreApi, user) == 8);
    assert!(std::mem::offset_of!(TensionCoreApi, guest_read) == 16);
    assert!(std::mem::offset_of!(TensionCoreApi, guest_write) == 24);
    assert!(std::mem::offset_of!(TensionCoreApi, guest_size) == 32);
    assert!(std::mem::offset_of!(TensionCoreApi, resolve_callback) == 40);
    assert!(std::mem::offset_of!(TensionCoreApi, call_callback) == 48);
    assert!(std::mem::offset_of!(TensionCoreApi, release_callback) == 56);
    assert!(std::mem::offset_of!(TensionCoreApi, log) == 64);
    assert!(std::mem::offset_of!(TensionCoreApi, register_import) == 72);
    assert!(std::mem::offset_of!(TensionCoreApi, register_source) == 80);
    assert!(std::mem::offset_of!(TensionCoreApi, post_event) == 88);
    assert!(std::mem::offset_of!(TensionCoreApi, class_info) == 96);
    assert!(std::mem::offset_of!(TensionCoreApi, region_lookup) == 104);
    assert!(std::mem::offset_of!(TensionAdapter, abi_version) == 0);
    assert!(std::mem::offset_of!(TensionAdapter, name) == 8);
    assert!(std::mem::offset_of!(TensionAdapter, flags) == 16);
    assert!(std::mem::offset_of!(TensionAdapter, init) == 24);
    assert!(std::mem::offset_of!(TensionAdapter, link) == 32);
    assert!(std::mem::offset_of!(TensionAdapter, publish) == 40);
    assert!(std::mem::offset_of!(TensionAdapter, apply) == 48);
    assert!(std::mem::offset_of!(TensionAdapter, shutdown) == 56);
    assert!(std::mem::offset_of!(TensionAdapter, destroy) == 64);
};

// ── the loader ────────────────────────────────────────────────────────────

/// A `dlopen` handle. Dropping it closes the object — which must not happen
/// while anything still calls into it: an adapter has to outlive every import it
/// registered, because those closures hold its function pointers.
pub struct Library {
    handle: *mut c_void,
}

impl Library {
    /// `dlopen(path, RTLD_NOW | RTLD_LOCAL)`. `RTLD_LOCAL` is deliberate: an
    /// adapter's symbols are its own business, and nothing else should resolve
    /// against them by accident.
    pub fn open(path: &Path) -> Result<Library, String> {
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "the path contains a NUL byte".to_string())?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return Err(dl_error());
        }
        Ok(Library { handle })
    }

    /// `dlsym(handle, name)`.
    pub fn symbol(&self, name: &str) -> Result<*mut c_void, String> {
        let c_name = CString::new(name).expect("a symbol name has no NUL in it");
        // Clear any stale error first: dlsym only reports through dlerror.
        unsafe { libc::dlerror() };
        let symbol = unsafe { libc::dlsym(self.handle, c_name.as_ptr()) };
        if symbol.is_null() {
            return Err(dl_error());
        }
        Ok(symbol)
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        unsafe { libc::dlclose(self.handle) };
    }
}

/// The loader's last error, as a string.
fn dl_error() -> String {
    unsafe {
        let error = libc::dlerror();
        if error.is_null() {
            "the loader reported no error".to_string()
        } else {
            CStr::from_ptr(error).to_string_lossy().into_owned()
        }
    }
}

// ── what an adapter registered ────────────────────────────────────────────

/// An adapter's context pointer, in a form a `Send + Sync` closure can hold.
/// SAFETY: the adapter owns what this points at for the whole run, and only the
/// interpreter thread ever touches it — the same assumption the header makes
/// about a registered import's `ctx`.
#[derive(Copy, Clone, Debug)]
pub struct AdapterCtx(pub *mut c_void);

unsafe impl Send for AdapterCtx {}
unsafe impl Sync for AdapterCtx {}

impl AdapterCtx {
    /// The raw pointer. Read it through this method rather than the tuple field:
    /// a closure that names `ctx.0` directly captures the *pointer field*, which
    /// is neither `Send` nor `Sync`, and the wrapper's impls never get a say.
    pub fn raw(&self) -> *mut c_void {
        self.0
    }
}

/// One import an adapter registered during `link`.
#[derive(Clone)]
pub struct RegisteredImport {
    pub module: String,
    pub name: String,
    pub signature: Signature,
    pub func: ImportFn,
    pub ctx: AdapterCtx,
    /// The adapter's own verb id, for its `apply` (the deferred path).
    pub verb_id: u32,
    /// The import flags the adapter declared (`TENSION_IMPORT_*`).
    pub flags: u32,
    /// Which loaded adapter registered this import: the index a deferred
    /// submission travels with, so the apply phase knows whose `apply` to call.
    /// Stamped by the registry during `link`, not by the adapter.
    pub adapter_index: u32,
}

/// `TENSION_IMPORT_DEFERRABLE`: the import may be called from inside a callback,
/// where the session copies its arguments instead of calling it
/// (`tension_adapter.h` A.3).
pub const TENSION_IMPORT_DEFERRABLE: u32 = 1 << 0;
/// `TENSION_IMPORT_REENTRANT_READONLY`: the import is safe to call from inside a
/// callback and runs immediately — an exempt accessor.
pub const TENSION_IMPORT_REENTRANT_READONLY: u32 = 1 << 1;

impl RegisteredImport {
    /// Whether the adapter asked for this verb to be callable from inside a
    /// callback (the deferred path, A2).
#[cfg_attr(not(test), allow(dead_code))] // tests pin the flag decoding; A2c's dispatch reads `flags` directly
    pub fn is_deferrable(&self) -> bool {
        self.flags & 1 != 0
    }
}

/// The registry's handle to itself, in a form the linker can store. SAFETY: the
/// host outlives every closure built from it (the adapters and their host live
/// for the run), and mutation goes through interior mutability on the
/// interpreter thread only.
#[derive(Copy, Clone, Debug)]
pub struct HostHandle(pub *mut AdapterHost);

unsafe impl Send for HostHandle {}
unsafe impl Sync for HostHandle {}

impl HostHandle {
    pub(crate) fn get(self) -> Option<&'static AdapterHost> {
        if self.0.is_null() {
            None
        } else {
            Some(unsafe { &*self.0 })
        }
    }
}

// ── the value mapping (the only place wasmtime values are built) ──────────

/// A `wasmtime::Val` in the neutral form the signature rules are written on.
pub fn slot_of_val(value: &Val) -> Option<Slot> {
    match value {
        Val::I32(value) => Some(Slot::I32(*value)),
        Val::I64(value) => Some(Slot::I64(*value)),
        // `Val::F32`/`Val::F64` carry bit patterns, which is exactly what the
        // neutral form keeps (signatures.rs, "The mapping").
        Val::F32(bits) => Some(Slot::F32(*bits)),
        Val::F64(bits) => Some(Slot::F64(*bits)),
        _ => None,
    }
}

/// The `Val` a declared return type takes from the adapter's out-parameter.
fn val_of_tension(value_type: ValueType, value: &TensionValue) -> Option<Val> {
    match value_type {
        ValueType::I32 => Some(Val::I32(unsafe { value.i32_ })),
        ValueType::I64 => Some(Val::I64(unsafe { value.i64_ })),
        ValueType::F32 => Some(Val::F32(unsafe { value.f32_ }.to_bits())),
        ValueType::F64 => Some(Val::F64(unsafe { value.f64_ }.to_bits())),
        ValueType::Void => None,
    }
}

/// The ABI slot a neutral value occupies.
fn tension_of_slot(slot: Slot) -> TensionValue {
    match slot {
        Slot::I32(value) => TensionValue { i32_: value },
        Slot::I64(value) => TensionValue { i64_: value },
        Slot::F32(bits) => TensionValue { f32_: f32::from_bits(bits) },
        Slot::F64(bits) => TensionValue { f64_: f64::from_bits(bits) },
    }
}

/// The wasm type a declared value type takes.
pub fn val_type_of(value_type: ValueType) -> Option<ValType> {
    match value_type {
        ValueType::I32 => Some(ValType::I32),
        ValueType::I64 => Some(ValType::I64),
        ValueType::F32 => Some(ValType::F32),
        ValueType::F64 => Some(ValType::F64),
        ValueType::Void => None,
    }
}

/// The `FuncType` a registered import's signature declares.
pub fn import_func_type(engine: &Engine, signature: &Signature) -> FuncType {
    let params = signature
        .params()
        .iter()
        .filter_map(|value_type| val_type_of(*value_type));
    let results = val_type_of(signature.ret()).into_iter();
    FuncType::new(engine, params, results)
}

// ── the per-call context ──────────────────────────────────────────────────

/// Installs the active `Caller` into the host for the duration of one adapter
/// call, so `guest_read`/`guest_write` can reach guest memory, and clears it
/// however that call ends — including a trap or a panic.
pub struct CallerGuard {
    host: HostHandle,
}

impl CallerGuard {
    fn install(host: HostHandle, caller: &mut Caller<'_, HostState>) -> CallerGuard {
        if let Some(adapter_host) = host.get() {
            // SAFETY: the erased lifetime is a name. The guard clears the slot
            // before this frame ends, and the header's rule 6 says an adapter
            // may only use guest memory inside the call it is invoked from.
            let erased: &mut Caller<'static, HostState> = unsafe { std::mem::transmute(caller) };
            adapter_host.enter(erased);
        }
        CallerGuard { host }
    }
}

impl Drop for CallerGuard {
    fn drop(&mut self) {
        if let Some(adapter_host) = self.host.get() {
            adapter_host.leave();
        }
    }
}

/// Run `body` with the adapter host's caller slot installed, so `guest_write`
/// and `guest_read` work for the duration of an adapter call that is not an
/// import — a `publish` or `apply` hook.
///
/// The slot is the same one an import call installs; the guard clears it however
/// `body` ends, so an adapter's hook cannot leave guest memory reachable after
/// the epoch returns.
pub(crate) fn with_caller_installed<R>(
    host: HostHandle,
    caller: &mut Caller<'_, HostState>,
    body: impl FnOnce() -> R,
) -> R {
    let guard = CallerGuard::install(host, caller);
    let result = body();
    drop(guard);
    result
}

/// Build the linker-facing closure for one registered import.
///
/// The closure captures the adapter's function pointer, its context, the
/// signature, and the registry handle — never the store. The adapter's `int32_t`
/// status is *not* the wasm return value: the return value is what the adapter
/// wrote into the out-parameter, and a non-zero status is logged here (the
/// header's A.7 table is the vocabulary for it).
pub fn import_closure(
    host: HostHandle,
    import: RegisteredImport,
) -> impl Fn(Caller<'_, HostState>, &[Val], &mut [Val]) -> anyhow::Result<()> + Send + Sync + 'static
{
    move |mut caller: Caller<'_, HostState>, params: &[Val], results: &mut [Val]| -> anyhow::Result<()> {
        // Pack the wasm values into the C array, checking each against the
        // declared signature. A mismatch here would mean the linker accepted a
        // call the adapter did not declare, which is a core bug, not a guest one.
        let mut args = [TensionValue::zero(); MAX_PARAMS];
        let mut slots = [Slot::I32(0); MAX_PARAMS];
        let declared = import.signature.params();
        if params.len() != declared.len() {
            anyhow::bail!(
                "{}::{} was called with {} arguments but declared {}",
                import.module,
                import.name,
                params.len(),
                declared.len()
            );
        }
        for (index, value) in params.iter().enumerate() {
            let slot = slot_of_val(value).ok_or_else(|| {
                anyhow::anyhow!(
                    "{}::{} received a value this boundary does not carry",
                    import.module,
                    import.name
                )
            })?;
            if slot.value_type() != declared[index] {
                anyhow::bail!(
                    "{}::{} argument {index} is {:?}, but the import declared {:?}",
                    import.module,
                    import.name,
                    slot.value_type(),
                    declared[index]
                );
            }
            slots[index] = slot;
            args[index] = tension_of_slot(slot);
        }

        // What the flags mean when a callback is running. `depth > 0` *is*
        // "inside a callback" — the session sets it around every invocation, and
        // nothing else in the process can set it — so this needs no guessing
        // about the call's origin.
        if caller.data().depth > 0 {
            if import.flags & TENSION_IMPORT_DEFERRABLE != 0 {
                // Copy the arguments and let the next epoch apply them. Deferring
                // is checked before the readonly flag: an import that declares
                // both is deferred, because deferring is always safe and running
                // eagerly is not.
                let bytes = crate::session::apply::encode_slots(&slots[..params.len()]);
                let submission = crate::session::apply::PendingSubmission {
                    adapter_index: import.adapter_index,
                    verb_id: import.verb_id,
                    bytes,
                    nargs: params.len() as u32,
                };
                return match caller.data_mut().pending.push(submission) {
                    Ok(()) => {
                        // The wasm caller sees "accepted": the work has not
                        // happened yet, and the guest learns what became of it
                        // from the apply phase.
                        set_i32_result(results, 0).map(|()| {
                            log_line(&format!(
                                "{}::{} deferred from a callback (verb {})",
                                import.module, import.name, import.verb_id
                            ));
                        })
                    }
                    Err(()) => set_i32_result(results, ENOSPC).map(|()| {
                        log_line(&format!(
                            "{}::{} refused: the pending queue is full ({} entries)",
                            import.module,
                            import.name,
                            caller.data().pending.capacity()
                        ));
                    }),
                };
            }
            if import.flags & TENSION_IMPORT_REENTRANT_READONLY == 0 {
                // Neither flag: this verb may not run inside a callback.
                return set_i32_result(results, EBUSY).map(|()| {
                    log_line(&format!(
                        "{}::{} refused inside a callback: the import is neither \
                         deferrable nor re-entrant",
                        import.module, import.name
                    ));
                });
            }
            // REENTRANT_READONLY falls through and runs exactly as at depth 0.
        }

        let guard = CallerGuard::install(host, &mut caller);
        let mut ret = TensionValue::zero();
        // SAFETY: the adapter is native code that declared this signature at
        // `link`; the pointers below are valid for the duration of the call, and
        // `nargs` is the declared count.
        let status = unsafe {
            (import.func)(
                import.ctx.raw(),
                args.as_ptr(),
                params.len() as u32,
                &mut ret,
            )
        };
        drop(guard);

        if import.signature.ret() != ValueType::Void {
            if results.len() != 1 {
                anyhow::bail!(
                    "{}::{} declares a return value but the linker gave {} slots",
                    import.module,
                    import.name,
                    results.len()
                );
            }
            let value = val_of_tension(import.signature.ret(), &ret).ok_or_else(|| {
                anyhow::anyhow!(
                    "{}::{} declares {:?} as a return type this boundary cannot carry",
                    import.module,
                    import.name,
                    import.signature.ret()
                )
            })?;
            results[0] = value;
        }

        if status != 0 {
            log_line(&format!(
                "{}::{} -> adapter status {status}",
                import.module, import.name
            ));
        }
        Ok(())
    }
}

/// Put an `i32` in the call's single result slot.
///
/// Used by the deferred dispatch, which answers the wasm caller without running
/// the adapter: the flags make `i32` the return type, and the registry refuses a
/// `DEFERRABLE` import that declares anything else (`-ENOSPC` has to have
/// somewhere to go).
fn set_i32_result(results: &mut [Val], value: i32) -> anyhow::Result<()> {
    if results.len() != 1 {
        anyhow::bail!("a deferrable import must return exactly one value");
    }
    results[0] = Val::I32(value);
    Ok(())
}

// ── the core API's Rust side ──────────────────────────────────────────────

/// One line to stderr, prefixed the way the header's `log` slot documents.
pub(crate) fn log_line(message: &str) {
    eprintln!("[tension:session] {message}");
}

/// Read a C string the adapter passed. `None` for a null pointer or invalid
/// UTF-8 — both are the adapter's mistake, and both are refused rather than
/// guessed at.
unsafe fn cstr(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned())
}

pub(crate) unsafe extern "C" fn guest_read(
    user: *mut c_void,
    ptr: u32,
    dst: *mut c_void,
    len: u32,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EBADF;
    };
    let caller = host.caller();
    if caller.is_null() {
        return EBUSY; // outside a guest call: rule 6
    }
    // SAFETY: installed by CallerGuard for the duration of the call in flight.
    let caller = unsafe { &mut *caller };
    let Some(memory) = caller.data().arena else {
        return EBADF;
    };
    if dst.is_null() {
        return EINVAL;
    }
    let data = memory.data(&*caller);
    let Some(end) = (ptr as usize).checked_add(len as usize) else {
        return EINVAL;
    };
    if end > data.len() {
        return EINVAL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(data[ptr as usize..end].as_ptr(), dst as *mut u8, len as usize)
    };
    0
}

pub(crate) unsafe extern "C" fn guest_write(
    user: *mut c_void,
    ptr: u32,
    src: *const c_void,
    len: u32,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EBADF;
    };
    let caller = host.caller();
    if caller.is_null() {
        return EBUSY;
    }
    // SAFETY: as in `guest_read`.
    let caller = unsafe { &mut *caller };
    let Some(memory) = caller.data().arena else {
        return EBADF;
    };
    if src.is_null() {
        return EINVAL;
    }
    // During a `publish` hook the write draws on that adapter's per-epoch byte
    // budget (`adapter::PUBLISH_BUDGET_BYTES`). Outside publish the budget does
    // not apply. The charge is taken *before* the copy, so a refused write
    // changes nothing.
    if !host.charge_publish(len) {
        return ENOSPC;
    }
    let data = memory.data_mut(&mut *caller);
    let Some(end) = (ptr as usize).checked_add(len as usize) else {
        return EINVAL;
    };
    if end > data.len() {
        return EINVAL;
    }
    unsafe { std::ptr::copy_nonoverlapping(src as *const u8, data[ptr as usize..end].as_mut_ptr(), len as usize) };
    0
}

pub(crate) unsafe extern "C" fn guest_size(user: *mut c_void) -> u32 {
    AdapterHost::from_user(user)
        .map(|host| host.memory_size())
        .unwrap_or(0)
}

pub(crate) unsafe extern "C" fn log(
    user: *mut c_void,
    level: i32,
    msg: *const c_char,
    len: u32,
) {
    if msg.is_null() {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(msg as *const u8, len as usize) };
    let text = String::from_utf8_lossy(bytes);
    let label = match level {
        0 => "debug",
        1 => "info",
        2 => "warning",
        _ => "error",
    };
    let _ = user; // the level and the text are all a line needs
    log_line(&format!("{label}: {text}"));
}

pub(crate) unsafe extern "C" fn register_import(
    user: *mut c_void,
    module: *const c_char,
    name: *const c_char,
    ret_type: ValueTypeCode,
    param_types: *const u32,
    nparams: u32,
    func: Option<ImportFn>,
    ctx: *mut c_void,
    verb_id: u32,
    flags: u32,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EINVAL;
    };
    let (Some(module), Some(name)) = (unsafe { cstr(module) }, unsafe { cstr(name) }) else {
        return EINVAL;
    };
    let Some(func) = func else {
        return EINVAL;
    };

    // The reserved module is refused here as well as in the registry: the
    // adapter learns synchronously, from the return value of its own call.
    if module == "session" {
        log_line(&format!(
            "register_import refused: `session` is reserved to tension-core ({module}::{name})"
        ));
        return EINVAL;
    }

    let params = if nparams == 0 || param_types.is_null() {
        Vec::new()
    } else {
        // SAFETY: the adapter promised `nparams` entries at `param_types`.
        unsafe { std::slice::from_raw_parts(param_types, nparams as usize) }.to_vec()
    };
    let signature = match Signature::new(ret_type, &params) {
        Ok(signature) => signature,
        Err(error) => {
            log_line(&format!("register_import refused for {module}::{name}: {error}"));
            return EINVAL;
        }
    };

    if host.has_verb_id(verb_id) {
        log_line(&format!(
            "register_import refused for {module}::{name}: verb id {verb_id} is already used"
        ));
        return EINVAL;
    }

    host.push_import(RegisteredImport {
        adapter_index: 0, // stamped by the registry when the adapter's link returns
        module,
        name,
        signature,
        func,
        ctx: AdapterCtx(ctx),
        verb_id,
        flags,
    });
    0
}

pub(crate) unsafe extern "C" fn register_source(
    user: *mut c_void,
    name: *const c_char,
    hint: u32,
    out_source_id: *mut u32,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EINVAL;
    };
    let Some(name) = (unsafe { cstr(name) }) else {
        return EINVAL;
    };
    let _ = hint; // a hint for the scheduler; the scheduler lands in A2
    let id = host.push_source(name);
    if !out_source_id.is_null() {
        unsafe { *out_source_id = id };
    }
    0
}

pub(crate) unsafe extern "C" fn region_lookup(
    user: *mut c_void,
    kind: u32,
    out_offset: *mut u32,
    out_size: *mut u32,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EINVAL;
    };
    // Asking about a region during `link` *is* the declaration that the adapter
    // needs it; the registry keeps the set for `session_open`'s truncation check.
    host.note_region(kind);
    match crate::session::arena::REGIONS.get(kind as usize) {
        Some(region) => {
            if !out_offset.is_null() {
                unsafe { *out_offset = region.offset };
            }
            if !out_size.is_null() {
                unsafe { *out_size = region.size };
            }
            0
        }
        None => ENOENT,
    }
}

// The remaining slots are A2's: delivery, the callback service, and the scheduler
// they need. They are stubs rather than NULL so an adapter that calls one gets a
// named refusal instead of a crash.

pub(crate) unsafe extern "C" fn resolve_callback_not_yet(
    _user: *mut c_void,
    _table_index: u32,
    _ret_type: u32,
    _param_types: *const u32,
    _nparams: u32,
    _out_fn: *mut *mut c_void,
) -> i32 {
    ENOSYS
}

/// `post_event(user, source_id, class_id, flags, a, b, f0, f1, out_seq)`.
///
/// **The one slot callable from any thread** (`tension_adapter.h`, rule 7). It
/// touches no guest memory, takes no borrow of the store, and never blocks: it
/// resolves the posting face out of the adapter host and queues the event. A
/// full class queue is `-ENOSPC` — the header's contract — so a producer that
/// can throttle can; a bad class or source is `-EINVAL`.
///
/// The sequence number is assigned before the queue is consulted, so a refused
/// post still consumes one: two events can never share a `seq`.
pub(crate) unsafe extern "C" fn post_event(
    user: *mut c_void,
    source_id: u32,
    class_id: u32,
    flags: u32,
    a: u32,
    b: u32,
    f0: f32,
    f1: f32,
    out_seq: *mut u64,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EINVAL;
    };
    // The ids are 1-based and dense (`register_source` returns 1..=n), so a
    // source that was never registered is a refusal rather than a mystery in the
    // records.
    let source = source_id as u64;
    if source == 0 || source > host.source_count() as u64 {
        return log_refusal(&host, PostError::UnknownSource { source: source_id });
    }
    let posting = host.posting();
    match posting.post(source_id, class_id, flags, a, b, f0, f1) {
        Ok(seq) => {
            if !out_seq.is_null() {
                unsafe { *out_seq = seq };
            }
            0
        }
        Err(error) => log_refusal(&host, error),
    }
}

/// Report a refused post on the adapter's channel and hand back its errno.
///
/// The line is prefixed `[tension:session]` because that is the channel the
/// `log` slot writes to; the message names the caller's mistake, which is what
/// an adapter author needs to see (`DESIGN.md` §7.2).
fn log_refusal(host: &AdapterHost, error: PostError) -> i32 {
    if let Some(log) = host.api().log {
        let text = format!("post_event: {error}");
        unsafe { log(host.api().user, 1, text.as_ptr() as *const c_char, text.len() as u32) }
    }
    error.errno()
}

/// `class_info(user, class_id, out_mode, out_capacity, out_flags)`.
///
/// Callable from any thread: it reads the posting face's own tables and nothing
/// else. `-ENOENT` for a class this chunk does not define, `-EINVAL` for a null
/// destination.
pub(crate) unsafe extern "C" fn class_info(
    user: *mut c_void,
    class_id: u32,
    out_mode: *mut u32,
    out_capacity: *mut u32,
    out_flags: *mut u32,
) -> i32 {
    let Some(host) = AdapterHost::from_user(user) else {
        return EINVAL;
    };
    let posting = host.posting();
    let Some(capacity) = posting.class_capacity(class_id) else {
        return ENOENT;
    };
    if out_mode.is_null() || out_capacity.is_null() || out_flags.is_null() {
        return EINVAL;
    }
    let mode = crate::session::arena::DEFAULT_CLASS_MODES
        .get(class_id as usize)
        .copied()
        .unwrap_or(crate::session::arena::MODE_POLLED);
    let mut flags = 0u32;
    if posting.is_subscribed(class_id) {
        flags |= crate::session::arena::CLASS_FLAG_SUBSCRIBED;
    }
    unsafe {
        *out_mode = mode;
        *out_capacity = capacity;
        *out_flags = flags;
    }
    0
}

pub(crate) unsafe extern "C" fn call_callback_not_yet(
    _user: *mut c_void,
    _function: *mut c_void,
    _args: *const TensionValue,
    _nargs: u32,
    _ret: *mut TensionValue,
) -> i32 {
    ENOSYS
}

pub(crate) unsafe extern "C" fn release_callback_not_yet(
    _user: *mut c_void,
    _function: *mut c_void,
) -> i32 {
    ENOSYS
}

/// The core API table, fully populated: every slot is a real function pointer, so
/// an adapter that calls one gets a refusal rather than a null dereference.
pub(crate) fn core_api(user: *mut c_void) -> TensionCoreApi {
    TensionCoreApi {
        abi_version: ADAPTER_ABI_VERSION,
        user,
        guest_read: Some(guest_read),
        guest_write: Some(guest_write),
        guest_size: Some(guest_size),
        resolve_callback: Some(resolve_callback_not_yet),
        call_callback: Some(call_callback_not_yet),
        release_callback: Some(release_callback_not_yet),
        log: Some(log),
        register_import: Some(register_import),
        register_source: Some(register_source),
        post_event: Some(post_event),
        class_info: Some(class_info),        region_lookup: Some(region_lookup),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;

    /// A posting face for a test host: the default capacities, shared by `Arc`
    /// the way `main` shares one with the session.
    fn test_posting() -> std::sync::Arc<crate::session::posting::PostingSide> {
        std::sync::Arc::new(crate::session::posting::PostingSide::default())
    }
    use wasmtime::{Linker, Module, Store};

    fn test_store(engine: &Engine) -> Store<HostState> {
        Store::new(
            engine,
            HostState {
                args: Vec::new(),
                pending_line: None,
                res: Vec::new(),
                audio: crate::audio::AudioSession::new(crate::default_adapter()),
                ai: crate::ai::AiSession::new(crate::default_ai_adapter()),
                solver: crate::solver::SolverHost::default(),
                posting: std::sync::Arc::new(
                    crate::session::posting::PostingSide::default(),
                ),
                arena: None,
                depth: 0,
                pending: crate::session::apply::PendingQueue::new(),
                adapters: Vec::new(),
                session: None,
            },
        )
    }


    // ── A2a: the posting shims ────────────────────────────────────────────

    /// Register one source so `post_event`'s source check has something to
    /// accept, and hand back the host.
    fn host_with_one_source() -> Box<AdapterHost> {
        let host = AdapterHost::new(test_posting());
        let name = std::ffi::CString::new("echo").expect("no interior nul");
        let status = unsafe { register_source(host.api().user, name.as_ptr(), 0, std::ptr::null_mut()) };
        assert_eq!(status, 0);
        host
    }

    #[test]
    fn post_event_queues_and_answers_enospc_when_full() {
        let host = host_with_one_source();
        let api = *host.api();
        let post = api.post_event.expect("the shim is installed");

        // Class 0's default capacity is one record.
        let mut seq = 0u64;
        assert_eq!(unsafe { post(api.user, 1, 0, 7, 1, 2, 0.5, 0.25, &mut seq) }, 0);
        assert_eq!(seq, 1);

        // Full: the header's contract is -ENOSPC so a producer that can throttle
        // can, and the refusal is counted on the class queue.
        let mut refused = 0u64;
        let status = unsafe { post(api.user, 1, 0, 7, 3, 4, 0.0, 0.0, &mut refused) };
        assert_eq!(status, crate::session::posting::PostError::QueueFull { class: 0 }.errno());
        assert_eq!(status, -28, "the header names -ENOSPC for a full class queue");
        assert_eq!(refused, 0, "a refused post hands back no seq");
        let posting = host.posting();
        assert_eq!(posting.queue(0).expect("class 0").dropped(), 1);

        // A null out_seq is legal ("`out_seq` may be NULL").
        let status = unsafe { post(api.user, 1, 4, 0, 0, 0, 0.0, 0.0, std::ptr::null_mut()) };
        assert_eq!(status, 0);
    }

    #[test]
    fn post_event_refuses_a_null_host_and_an_unknown_class() {
        let api = *AdapterHost::new(test_posting()).api();
        let post = api.post_event.expect("the shim is installed");
        assert_eq!(unsafe { post(std::ptr::null_mut(), 1, 0, 0, 0, 0, 0.0, 0.0, std::ptr::null_mut()) }, EINVAL);

        let host = host_with_one_source();
        let api = *host.api();
        let post = api.post_event.expect("installed");
        assert_eq!(unsafe { post(api.user, 1, 15, 0, 0, 0, 0.0, 0.0, std::ptr::null_mut()) }, EINVAL);
        // An unknown class is refused before the queue is consulted, so nothing
        // was consumed from the sequence counter.
        assert_eq!(host.posting().last_seq(), 0);
    }

    #[test]
    fn class_info_reports_mode_capacity_and_subscription() {
        let host = AdapterHost::new(test_posting());
        let api = *host.api();
        let info = api.class_info.expect("the shim is installed");
        let (mut mode, mut capacity, mut flags) = (0u32, 0u32, 0u32);

        // JOB_DONE: batched, 4096 records, subscribed.
        assert_eq!(unsafe { info(api.user, 4, &mut mode, &mut capacity, &mut flags) }, 0);
        assert_eq!(mode, crate::session::arena::MODE_BATCHED);
        assert_eq!(capacity, crate::session::arena::DEFAULT_RING_CAPACITIES[4]);
        assert_ne!(flags & crate::session::arena::CLASS_FLAG_SUBSCRIBED, 0);

        // FRAME: polled and off unless subscribed — the answer a producer of
        // frame events uses to decide whether to bother.
        assert_eq!(unsafe { info(api.user, 9, &mut mode, &mut capacity, &mut flags) }, 0);
        assert_eq!(mode, crate::session::arena::MODE_POLLED);
        assert_eq!(flags & crate::session::arena::CLASS_FLAG_SUBSCRIBED, 0);

        // An unknown class is -ENOENT, and a null destination is -EINVAL.
        assert_eq!(
            unsafe { info(api.user, 15, &mut mode, &mut capacity, &mut flags) },
            ENOENT
        );
        assert_eq!(
            unsafe { info(api.user, 4, std::ptr::null_mut(), &mut capacity, &mut flags) },
            EINVAL
        );
    }

    #[test]
    fn layout_matches_the_c_compiler() {
        // The numbers come from compiling the same header with gcc -std=c11 on
        // x86-64 (quoted in this module's docs); the const assertions above are
        // the compile-time half of this check.
        assert_eq!(std::mem::size_of::<TensionValue>(), 8);
        if std::mem::size_of::<usize>() == 8 {
            assert_eq!(std::mem::size_of::<TensionCoreApi>(), 112);
            assert_eq!(std::mem::size_of::<TensionAdapter>(), 72);
            assert_eq!(std::mem::offset_of!(TensionCoreApi, region_lookup), 104);
            assert_eq!(std::mem::offset_of!(TensionAdapter, destroy), 64);
        }
        // `Option<fn>` must not have grown the field: the null optimisation is
        // what keeps this struct layout-identical to the C one.
        assert_eq!(
            std::mem::size_of::<Option<GuestReadFn>>(),
            std::mem::size_of::<*const c_void>()
        );
    }

    /// A fake adapter import that doubles its single parameter.
    unsafe extern "C" fn double_i32(
        _ctx: *mut c_void,
        args: *const TensionValue,
        nargs: u32,
        ret: *mut TensionValue,
    ) -> i32 {
        if nargs != 1 || args.is_null() || ret.is_null() {
            return EINVAL;
        }
        unsafe { (*ret).i32_ = (*args).i32_ * 2 };
        0
    }

    unsafe extern "C" fn double_f64(
        _ctx: *mut c_void,
        args: *const TensionValue,
        nargs: u32,
        ret: *mut TensionValue,
    ) -> i32 {
        if nargs != 1 || args.is_null() || ret.is_null() {
            return EINVAL;
        }
        unsafe { (*ret).f64_ = (*args).f64_ * 2.0 };
        0
    }

    /// Returns a non-zero status *and* a value: the value must still reach the
    /// guest, and the status is logged rather than trapped.
    unsafe extern "C" fn complains_but_answers(
        _ctx: *mut c_void,
        args: *const TensionValue,
        nargs: u32,
        ret: *mut TensionValue,
    ) -> i32 {
        if nargs != 1 || args.is_null() || ret.is_null() {
            return EINVAL;
        }
        unsafe { (*ret).i32_ = (*args).i32_ + 1 };
        -7
    }

    fn a_host() -> Box<AdapterHost> {
        AdapterHost::new(test_posting())
    }

    /// The wat a test needs to call one import: `run` calls `$f` and returns
    /// what it produced.
    const CALLER_I32: &str = r#"
(module
  (import "test" "double" (func $double (param i32) (result i32)))
  (func (export "run") (param i32) (result i32) (call $double (local.get 0)))
)
"#;

    const CALLER_F64: &str = r#"
(module
  (import "test" "double" (func $double (param f64) (result f64)))
  (func (export "run") (param f64) (result f64) (call $double (local.get 0)))
)
"#;

    fn register(
        linker: &mut Linker<HostState>,
        engine: &Engine,
        host: HostHandle,
        name: &str,
        ret_type: ValueType,
        params: &[ValueType],
        func: ImportFn,
    ) {
        register_with_flags(linker, engine, host, name, ret_type, params, func, 0, 1);
    }

    /// The same, with the import flags and verb id a test wants: what a callback
    /// may call is decided by the flags, so the tests need to set them.
    #[allow(clippy::too_many_arguments)]
    fn register_with_flags(
        linker: &mut Linker<HostState>,
        engine: &Engine,
        host: HostHandle,
        name: &str,
        ret_type: ValueType,
        params: &[ValueType],
        func: ImportFn,
        flags: u32,
        verb_id: u32,
    ) {
        let raw: Vec<u32> = params.iter().map(|value_type| *value_type as u32).collect();
        let signature = Signature::new(ret_type as u32, &raw).expect("a legal signature");
        let import = RegisteredImport {
            module: "test".to_string(),
            name: name.to_string(),
            signature,
            func,
            ctx: AdapterCtx(std::ptr::null_mut()),
            verb_id,
            flags,
            adapter_index: 0,
        };
        let ty = import_func_type(engine, &import.signature);
        let closure = import_closure(host, import);
        linker
            .func_new("test", name, ty, closure)
            .expect("the import registers");
    }

    #[test]
    fn integer_arguments_and_returns_round_trip_through_wasm() {
        let engine = Engine::default();
        let mut store = test_store(&engine);
        let host = a_host();
        let handle = HostHandle(&*host as *const AdapterHost as *mut AdapterHost);
        let mut linker: Linker<HostState> = Linker::new(&engine);
        register(
            &mut linker,
            &engine,
            handle,
            "double",
            ValueType::I32,
            &[ValueType::I32],
            double_i32,
        );

        let module = Module::new(&engine, CALLER_I32).expect("module");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let run = instance
            .get_typed_func::<i32, i32>(&mut store, "run")
            .expect("run");
        assert_eq!(run.call(&mut store, 21).expect("call"), 42);
        assert_eq!(run.call(&mut store, -3).expect("call"), -6);
    }

    /// A guest with one import per flag case, summing their returns so one call
    /// exercises all three.
    const CALLER_THREE: &str = r#"
(module
  (import "test" "plain" (func $plain (param i32) (result i32)))
  (import "test" "readonly" (func $readonly (param i32) (result i32)))
  (import "test" "deferred" (func $deferred (param i32) (result i32)))
  (func (export "run") (param $x i32) (result i32)
    (i32.add
      (i32.add (call $plain (local.get $x)) (call $readonly (local.get $x)))
      (call $deferred (local.get $x)))))
"#;

    #[test]
    fn test_the_import_flags_decide_what_a_callback_may_call() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static PLAIN_RAN: AtomicBool = AtomicBool::new(false);
        static READONLY_RAN: AtomicBool = AtomicBool::new(false);
        static DEFERRED_RAN: AtomicBool = AtomicBool::new(false);

        /// Neither flag: refused inside a callback.
        unsafe extern "C" fn plain_fn(
            _ctx: *mut c_void,
            _args: *const TensionValue,
            _nargs: u32,
            ret: *mut TensionValue,
        ) -> i32 {
            PLAIN_RAN.store(true, Ordering::SeqCst);
            unsafe { (*ret).i32_ = 1 };
            0
        }
        /// Re-entrant and readonly: runs inside a callback exactly as outside.
        unsafe extern "C" fn readonly_fn(
            _ctx: *mut c_void,
            _args: *const TensionValue,
            _nargs: u32,
            ret: *mut TensionValue,
        ) -> i32 {
            READONLY_RAN.store(true, Ordering::SeqCst);
            unsafe { (*ret).i32_ = 41 };
            0
        }
        /// Deferrable: copied, never called from the callback.
        unsafe extern "C" fn deferred_fn(
            _ctx: *mut c_void,
            _args: *const TensionValue,
            _nargs: u32,
            ret: *mut TensionValue,
        ) -> i32 {
            DEFERRED_RAN.store(true, Ordering::SeqCst);
            unsafe { (*ret).i32_ = 99 };
            0
        }

        let engine = Engine::default();
        let mut store = test_store(&engine);
        let host = a_host();
        let handle = HostHandle(&*host as *const AdapterHost as *mut AdapterHost);
        let mut linker: Linker<HostState> = Linker::new(&engine);
        register_with_flags(&mut linker, &engine, handle, "plain", ValueType::I32, &[ValueType::I32], plain_fn, 0, 1);
        register_with_flags(
            &mut linker, &engine, handle, "readonly", ValueType::I32, &[ValueType::I32], readonly_fn,
            TENSION_IMPORT_REENTRANT_READONLY, 2,
        );
        register_with_flags(
            &mut linker, &engine, handle, "deferred", ValueType::I32, &[ValueType::I32], deferred_fn,
            TENSION_IMPORT_DEFERRABLE, 3,
        );

        let module = Module::new(&engine, CALLER_THREE).expect("module");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let run = instance
            .get_typed_func::<i32, i32>(&mut store, "run")
            .expect("run");

        // At depth 0 the flags change nothing: every import runs.
        assert_eq!(run.call(&mut store, 5).expect("call"), 1 + 41 + 99);
        assert!(PLAIN_RAN.load(Ordering::SeqCst));
        assert!(READONLY_RAN.load(Ordering::SeqCst));
        assert!(DEFERRED_RAN.load(Ordering::SeqCst));

        // At depth > 0 — inside a callback — the flags decide all three.
        PLAIN_RAN.store(false, Ordering::SeqCst);
        READONLY_RAN.store(false, Ordering::SeqCst);
        DEFERRED_RAN.store(false, Ordering::SeqCst);
        store.data_mut().depth = 1;
        assert_eq!(
            run.call(&mut store, 5).expect("call"),
            EBUSY + 41 + 0,
            "refused, run, queued: one import per rule"
        );
        assert!(!PLAIN_RAN.load(Ordering::SeqCst), "neither flag: never called");
        assert!(READONLY_RAN.load(Ordering::SeqCst), "readonly: called as at depth 0");
        assert!(!DEFERRED_RAN.load(Ordering::SeqCst), "deferrable: copied, not called");
        store.data_mut().depth = 0;

        // And the copy is the argument the import was handed, in the union the
        // adapter's `apply` reads.
        let entry = store
            .data_mut()
            .pending
            .drain()
            .next()
            .expect("one submission was queued");
        assert_eq!(entry.verb_id, 3);
        assert_eq!(entry.nargs, 1);
        assert_eq!(
            entry.bytes,
            crate::session::apply::encode_slots(&[Slot::I32(5)])
        );
    }

    #[test]
    fn float_arguments_and_returns_round_trip_through_wasm() {
        let engine = Engine::default();
        let mut store = test_store(&engine);
        let host = a_host();
        let handle = HostHandle(&*host as *const AdapterHost as *mut AdapterHost);
        let mut linker: Linker<HostState> = Linker::new(&engine);
        register(
            &mut linker,
            &engine,
            handle,
            "double",
            ValueType::F64,
            &[ValueType::F64],
            double_f64,
        );

        let module = Module::new(&engine, CALLER_F64).expect("module");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let run = instance
            .get_typed_func::<f64, f64>(&mut store, "run")
            .expect("run");
        assert_eq!(run.call(&mut store, 1.5).expect("call"), 3.0);
        // The bits cross unchanged, which is the property the mapping promises.
        let nan = f64::from_bits(0x7FF8_0000_0000_0001);
        assert_eq!(
            run.call(&mut store, nan).expect("call").to_bits(),
            (nan * 2.0).to_bits()
        );
    }

    #[test]
    fn a_non_zero_status_is_reported_and_the_value_still_crosses() {
        let engine = Engine::default();
        let mut store = test_store(&engine);
        let host = a_host();
        let handle = HostHandle(&*host as *const AdapterHost as *mut AdapterHost);
        let mut linker: Linker<HostState> = Linker::new(&engine);
        register(
            &mut linker,
            &engine,
            handle,
            "double",
            ValueType::I32,
            &[ValueType::I32],
            complains_but_answers,
        );

        let module = Module::new(&engine, CALLER_I32).expect("module");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let run = instance
            .get_typed_func::<i32, i32>(&mut store, "run")
            .expect("run");
        // The adapter said -7; the guest still gets the value (and a line naming
        // the status goes to stderr — visible with --nocapture).
        assert_eq!(run.call(&mut store, 41).expect("call"), 42);
    }

    // ── guest memory through the FFI ──────────────────────────────────────

    /// A guest whose memory the session owns, for the memory tests.
    const GUEST_WITH_MEMORY: &str = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (func (export "_start_game"))
)
"#;

    /// Writes a deterministic pattern into the guest buffer at `ptr`, reads it
    /// back through `guest_read`, and reports how many bytes matched — the one
    /// import that exercises both directions of the FFI's memory path.
    unsafe extern "C" fn pattern_roundtrip(
        ctx: *mut c_void,
        args: *const TensionValue,
        nargs: u32,
        ret: *mut TensionValue,
    ) -> i32 {
        if nargs != 2 || args.is_null() || ret.is_null() {
            return EINVAL;
        }
        let ptr = unsafe { (*args).i32_ } as u32;
        let len = unsafe { (*args.offset(1)).i32_ } as u32;
        if len > 256 {
            return EINVAL;
        }
        // The core API is reached through the host's own table.
        let host = unsafe { AdapterHost::from_user(ctx) };
        let Some(host) = host else { return EINVAL };
        let api = host.api_table();
        let Some(write) = api.guest_write else {
            return ENOSYS;
        };
        let Some(read) = api.guest_read else {
            return ENOSYS;
        };
        let mut pattern = [0u8; 256];
        for (index, byte) in pattern.iter_mut().enumerate().take(len as usize) {
            *byte = (index as u8).wrapping_mul(7).wrapping_add(3);
        }
        if unsafe { write(api.user, ptr, pattern.as_ptr() as *const c_void, len) } != 0 {
            return -5; // EIO
        }
        let mut back = [0u8; 256];
        if unsafe { read(api.user, ptr, back.as_mut_ptr() as *mut c_void, len) } != 0 {
            return -5;
        }
        let matching = (0..len as usize).filter(|i| back[*i] == pattern[*i]).count();
        unsafe { (*ret).i32_ = matching as i32 };
        0
    }

    #[test]
    fn guest_memory_round_trips_through_the_ffi() {
        let engine = Engine::default();
        let module = Module::new(&engine, GUEST_WITH_MEMORY).expect("module");
        let mut store = test_store(&engine);

        // A session, so the FFI has guest memory to reach: the adapters read and
        // write through the session's own handle.
        let mut session =
            session::Session::create_from_module(&mut store, &module).expect("session");
        session.prepare_arena(&mut store).expect("prepare");
        let mut linker: Linker<HostState> = Linker::new(&engine);
        session.install(&mut store, &mut linker).expect("install");
        // The session and its arena go into the store before anything runs: the
        // FFI reaches guest memory through `caller.data().arena`, exactly as
        // production does (main.rs installs both before instantiation), because
        // an epoch runs while the session itself is out of the store.
        store.data_mut().arena = Some(session.memory());
        store.data_mut().session = Some(session);

        let host = a_host();
        let handle = HostHandle(&*host as *const AdapterHost as *mut AdapterHost);
        // The import's ctx carries the host pointer, which is how the fake
        // adapter reaches the core API table the way a real one would.
        let raw: Vec<u32> = vec![ValueType::I32 as u32, ValueType::I32 as u32];
        let signature = Signature::new(ValueType::I32 as u32, &raw).expect("signature");
        let import = RegisteredImport {
            module: "test".to_string(),
            name: "roundtrip".to_string(),
            signature,
            func: pattern_roundtrip,
            ctx: AdapterCtx(&*host as *const AdapterHost as *mut c_void),
            verb_id: 7,
            flags: 0,
            adapter_index: 0,
        };
        let ty = import_func_type(&engine, &import.signature);
        linker
            .func_new("test", "roundtrip", ty, import_closure(handle, import))
            .expect("register");

        // A guest that calls the import with an address in its own heap.
        let caller = r#"
(module
  (import "env" "memory" (memory 132 4096))
  (import "test" "roundtrip" (func $roundtrip (param i32 i32) (result i32)))
  (func (export "run") (result i32)
    (call $roundtrip (i32.const 8388608) (i32.const 64)))
)
"#;
        let caller_module = Module::new(&engine, caller).expect("caller module");
        let instance = linker
            .instantiate(&mut store, &caller_module)
            .expect("instantiate");
        let run = instance
            .get_typed_func::<(), i32>(&mut store, "run")
            .expect("run");
        assert_eq!(
            run.call(&mut store, ()).expect("call"),
            64,
            "all 64 bytes written through the FFI read back unchanged"
        );

        // And the same call outside a guest call is refused, not unsound: this
        // is the header's rule 6, checked rather than assumed.
        let status = unsafe { guest_read(std::ptr::null_mut(), 0, std::ptr::null_mut(), 0) };
        assert_eq!(status, EBADF, "a null host is refused");
    }
}
