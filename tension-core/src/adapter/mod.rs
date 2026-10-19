//! The adapter registry: loading, the lifecycle, and the import table.
//!
//! Three jobs (`tension-ogre/DESIGN.md` §7, Appendix B steps 7–8):
//!
//! 1. **Load** a shared object, find `tension_adapter_v1`, and refuse it unless
//!    its ABI version is this build's. Refusal is at load, not a warning: an
//!    adapter from another ABI has a different vtable, and guessing is how
//!    corruption starts.
//! 2. **Drive the lifecycle**: `init` then `link`, in the order given, with the
//!    core API table in hand. A registration the header refuses — the reserved
//!    `session` module, a signature outside the closed set, a duplicate verb id —
//!    comes back to the adapter as `-EINVAL` from its own call.
//! 3. **Install** every collected import into the linker through `ffi`'s closure
//!    factory, refusing a duplicate `(module, name)` across adapters
//!    deterministically rather than first-wins.
//!
//! The registry also collects each adapter's **required region kinds**: an
//! adapter asking `region_lookup` about a kind during `link` is declaring that it
//! needs it, and the set is what `session_open` will check an `arena_size`
//! against. Round 4 wires that check; this round only collects.

mod ffi;
mod signatures;

/// The value slot type, re-exported where the session needs it: the deferred
/// path serializes the slots an import received, and that encoding is the
/// `tension_value` array this type mirrors.
pub(crate) use signatures::Slot;
/// The apply hook's type, for the tests that build a probe adapter: the apply
/// phase takes `AdapterCall`s, and observing the depth it calls at does not need
/// a shared object.
#[cfg(test)]
pub(crate) use ffi::ApplyFn;

/// A one-hook `AdapterCall` around a bare `apply`, for tests.
///
/// The vtable is leaked on purpose: an `AdapterCall` holds a raw pointer to it,
/// which is exactly what a real adapter's vtable is — a static that outlives
/// every epoch. `user` is the API table's back-pointer, so the hook's
/// `guest_write` (and anything else it asks for) reaches the host the test
/// built.
#[cfg(test)]
pub(crate) fn probe_adapter(name: &str, apply: ApplyFn, user: *mut c_void) -> AdapterCall {
    let mut api = ffi::core_api(user);
    api.user = user;
    let vtable = Box::leak(Box::new(TensionAdapter {
        abi_version: ffi::ADAPTER_ABI_VERSION,
        name: std::ptr::null(),
        flags: 0,
        init: None,
        link: None,
        publish: None,
        apply: Some(apply),
        shutdown: None,
        destroy: None,
        layout_hash: crate::session::arena::layout_hash(),
    }));
    AdapterCall {
        vtable,
        api,
        name: name.to_string(),
    }
}

use std::collections::BTreeSet;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use wasmtime::{Caller, Linker, Store};

use crate::session::posting::PostingSide;
use crate::HostState;
use ffi::{HostHandle, RegisteredImport, TensionAdapter, TensionCoreApi, EBADF, EBUSY};
use signatures::ValueType;

/// The one symbol the registry looks up in a loaded object.
const ENTRY_SYMBOL: &str = "tension_adapter_v1";

/// The wasm module name reserved to tension-core (`tension_adapter.h`, rule 9).
const RESERVED_MODULE: &str = "session";

/// Why an adapter was refused.
#[derive(Debug)]
pub enum AdapterError {
    /// The object could not be opened (`dlopen`'s own message).
    Open { path: PathBuf, why: String },
    /// The entry-point symbol is missing or unresolvable.
    EntryPoint { path: PathBuf, why: String },
    /// The entry point returned a null vtable.
    NullVtable { path: PathBuf },
    /// The adapter was built against a different ABI.
    AbiVersion {
        path: PathBuf,
        found: u32,
        expected: u32,
    },
    /// The adapter's vtable `layout_hash` does not match the arena layout this
    /// build requires: a vtable field added or reordered, or a region moved
    /// (C4.1c). Caught at load, before any slot is called.
    LayoutHash {
        path: PathBuf,
        found: u32,
        expected: u32,
    },
    /// The core API table does not belong to an [`AdapterHost`].
    NoHost,
    /// `init` returned a non-zero status.
    Init { name: String, status: i32 },
    /// The adapter has no `link` slot: registration is the one thing it cannot
    /// leave out.
    MissingLink { name: String },
    /// `link` returned a non-zero status.
    Link { name: String, status: i32 },
    /// A registration in the reserved `session` module.
    ReservedModule {
        adapter: String,
        module: String,
        import: String,
    },
    /// Two adapters claimed the same `(module, name)`.
    DuplicateImport {
        module: String,
        name: String,
        adapter: String,
    },
    /// An adapter declared a DEFERRABLE import but has no `apply` hook: nothing
    /// could ever apply what a callback deferred.
    DeferrableWithoutApply { adapter: String, import: String },
    /// A DEFERRABLE import must return `i32`: a full pending queue is reported
    /// to the wasm caller as `-ENOSPC`, which needs a return slot to travel in.
    DeferrableReturn { adapter: String, import: String },
    /// A signature the boundary does not carry.
    Register {
        module: String,
        name: String,
        why: String,
    },
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdapterError::Open { path, why } => {
                write!(f, "could not load adapter {}: {why}", path.display())
            }
            AdapterError::EntryPoint { path, why } => write!(
                f,
                "{} does not export `{ENTRY_SYMBOL}`: {why}",
                path.display()
            ),
            AdapterError::NullVtable { path } => {
                write!(f, "{} returned a null adapter vtable", path.display())
            }
            AdapterError::AbiVersion {
                path,
                found,
                expected,
            } => write!(
                f,
                "{} was built against adapter ABI {found}; this build is {expected}",
                path.display()
            ),
            AdapterError::LayoutHash {
                path,
                found,
                expected,
            } => write!(
                f,
                "{} was built against arena layout {found:#010x}; this build requires \
                 {expected:#010x} — a vtable field moved or an arena region changed shape. \
                 Rebuild the capability against this tension-core (`tension-core layout-hash` \
                 prints the value its header must carry)",
                path.display()
            ),
            AdapterError::NoHost => write!(
                f,
                "the core API table does not belong to an adapter host (its `user` is null)"
            ),
            AdapterError::Init { name, status } => {
                write!(f, "adapter `{name}` refused to initialise (status {status})")
            }
            AdapterError::MissingLink { name } => {
                write!(f, "adapter `{name}` has no `link` slot")
            }
            AdapterError::DeferrableWithoutApply { adapter, import } => write!(
                f,
                "adapter `{adapter}` registered `{import}` as deferrable but has no `apply` \
                 hook: a deferred submission would have nowhere to go"
            ),
            AdapterError::DeferrableReturn { adapter, import } => write!(
                f,
                "adapter `{adapter}` registered `{import}` as deferrable with a non-i32 return: \
                 a full pending queue is reported as -ENOSPC, which needs an i32"
            ),
            AdapterError::Link { name, status } => {
                write!(f, "adapter `{name}` failed to link (status {status})")
            }
            AdapterError::ReservedModule {
                adapter,
                module,
                import,
            } => write!(
                f,
                "adapter `{adapter}` tried to register `{module}`::`{import}`; the `{module}` \
                 module is reserved to tension-core"
            ),
            AdapterError::DuplicateImport {
                module,
                name,
                adapter,
            } => write!(
                f,
                "adapter `{adapter}` registered `{module}`::`{name}`, which another adapter \
                 already claimed"
            ),
            AdapterError::Register {
                module,
                name,
                why,
            } => write!(f, "the linker refused `{module}`::`{name}`: {why}"),
        }
    }
}

impl std::error::Error for AdapterError {}

/// The state `link` builds up: imports, verb ids, sources, required regions.
///
/// One struct behind one lock, because these are written together and read
/// together, and because the *type* has to be `Sync` — see [`AdapterHost`].
#[derive(Default)]
struct LinkState {
    imports: Vec<RegisteredImport>,
    verb_ids: Vec<u32>,
    sources: Vec<String>,
    required_regions: Vec<u32>,
}

/// The core's side of the adapter ABI: the API table every adapter is handed,
/// plus the per-run state the table's functions read and write.
///
/// The table's `user` field points back at this struct, so an adapter holding
/// only the table can reach the host. That is why this type is boxed: the
/// pointer must not move.
///
/// **Every field is behind a `Mutex` or an atomic, and that is load-bearing.**
/// `post_event` and `class_info` are documented as callable from any thread
/// (`tension_adapter.h`, rule 7), so their shims build a shared `&AdapterHost`
/// on a thread that is not the guest thread. Handing a `&T` across threads when
/// `T: !Sync` is undefined behaviour *however* little of it the other thread
/// touches — so the `RefCell`/`Cell` this struct used to hold are gone, and the
/// compile-time assertion below is what keeps them gone.
/// The core API table, frozen after construction.
///
/// It is `!Send`/`!Sync` only because an FFI struct carries raw pointers: the
/// `user` back-pointer and thirteen function pointers. None of them is written
/// after [`AdapterHost::new`], and a raw pointer is just a value — what
/// dereferences it is the adapter's own call, on whatever thread the header says
/// that slot may run on. Isolating the table in this newtype keeps the unsafe
/// claim to one field, so `AdapterHost`'s own `Sync` is *derived* rather than
/// asserted: a future field that is not thread-safe would fail to compile.
struct FrozenApi(TensionCoreApi);

// SAFETY: the table is written once, before the host is shared with anyone, and
// read-only afterwards; nothing in this crate dereferences its raw pointers on a
// thread other than the one the ABI allows for that slot.
unsafe impl Send for FrozenApi {}
unsafe impl Sync for FrozenApi {}

pub struct AdapterHost {
    api: FrozenApi,
    /// What `link` collected. Single-threaded in practice; `Sync` by
    /// construction.
    link: Mutex<LinkState>,
    /// The context of the adapter call in flight, for `guest_read` /
    /// `guest_write`: a tagged pointer, because there are two ways an adapter's
    /// code can be running against guest memory (see [`Ctx`]).
    ///
    /// Stored as an address with the kind in `ctx_kind`, not as an enum holding
    /// a pointer: `Mutex<Ctx>` would need `Ctx: Send`, and a raw pointer is not.
    /// The value is only ever read on the thread that installed it, inside the
    /// call that installed it.
    ctx: Mutex<usize>,
    /// Which variant `ctx` holds: 0 empty, 1 `Ctx::Caller`, 2 `Ctx::Store`.
    /// Written *after* the pointer and cleared *before* it, so a shim that sees
    /// a live kind also sees a matching pointer (`caller_thread`'s rule,
    /// extended).
    ctx_kind: AtomicU8,
    /// The id of the thread that installed `caller`, or 0 when the slot is
    /// empty (C4.1b). Set and cleared with `caller`, and compared by the
    /// guest-memory shims so a call from any other thread is refused rather
    /// than dereferenced. The ABI's any-thread slots (`post_event`,
    /// `class_info`) run on producer threads, which must never reach guest
    /// memory; this is what makes that rule mechanical instead of a comment.
    caller_thread: AtomicU64,
    /// The guest memory's size, refreshed whenever a caller is installed.
    memory_size: AtomicU32,
    /// The posting face (`session::posting`): what `post_event` reaches, and
    /// what the session's epoch will drain. Shared by `Arc`, because an adapter
    /// thread holds it with no borrow of the store at all.
    posting: Arc<PostingSide>,
    /// Whether a `publish` hook is running, and how much of its byte budget is
    /// left. `guest_write` charges against it while it is set.
    in_publish: std::sync::atomic::AtomicBool,
    publish_budget: AtomicU32,
}

/// How much one adapter's `publish` hook may write into guest memory in one
/// epoch.
///
/// The bound exists because `publish` is the only place an adapter writes guest
/// memory on its own initiative, and the session is the only thing that can stop
/// it. 1 MiB is deliberately generous — the largest host → guest region this
/// chunk defines is `RENDERABLE` at 128 KiB, so a hook that writes every region
/// it owns still uses a fraction of it — and it is enforced by refusing further
/// writes with `-ENOSPC` rather than by trusting the adapter. A hook that hits
/// the budget is logged; its regions are then partly written, which is the
/// adapter's signal that it is doing too much in one epoch.
pub(crate) const PUBLISH_BUDGET_BYTES: u32 = 1024 * 1024;

/// The promise the header makes, checked by the compiler: an `&AdapterHost` may
/// cross a thread boundary, because `post_event` says "any thread".
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AdapterHost>();
    assert_send_sync::<PostingSide>();
};

/// A process-unique, non-zero token per thread, for the C4.1b caller-thread
/// check. `std::thread::ThreadId` carries no stable numeric accessor, so a
/// token assigned on first use is how the id is made comparable; the exact value
/// is irrelevant, only that it distinguishes threads and that 0 means "none"
/// (the counter starts at 1).
static NEXT_THREAD_TOKEN: AtomicU64 = AtomicU64::new(1);
thread_local! {
    static THREAD_TOKEN: u64 = NEXT_THREAD_TOKEN.fetch_add(1, Ordering::Relaxed);
}

/// This thread's token.
pub(crate) fn current_thread_id() -> u64 {
    THREAD_TOKEN.with(|token| *token)
}

/// The context slot's tag. Zero is empty; the two live kinds name how the
/// adapter's code reached guest memory.
pub(crate) const CTX_EMPTY: u8 = 0;
pub(crate) const CTX_CALLER: u8 = 1;
pub(crate) const CTX_STORE: u8 = 2;

impl AdapterHost {
    /// A host whose API table points back at itself, carrying `posting`.
    pub fn new(posting: Arc<PostingSide>) -> Box<AdapterHost> {
        let mut host = Box::new(AdapterHost {
            api: FrozenApi(ffi::core_api(std::ptr::null_mut())),
            link: Mutex::new(LinkState::default()),
            ctx: Mutex::new(0),
            ctx_kind: AtomicU8::new(CTX_EMPTY),
            caller_thread: AtomicU64::new(0),
            memory_size: AtomicU32::new(0),
            posting,
            in_publish: std::sync::atomic::AtomicBool::new(false),
            publish_budget: AtomicU32::new(0),
        });
        let user = &mut *host as *mut AdapterHost as *mut c_void;
        host.api = FrozenApi(ffi::core_api(user));
        host
    }

    /// The table to hand to `init` and `link`.
    pub fn api(&self) -> &TensionCoreApi {
        &self.api.0
    }

    /// The posting face: what the posting shims answer with, and what the
    /// session drains.
    pub fn posting(&self) -> Arc<PostingSide> {
        Arc::clone(&self.posting)
    }

    /// The region kinds the adapters declared during `link`, in the order they
    /// were first asked about. `session_open` checks an `arena_size` against it.
#[cfg_attr(not(test), allow(dead_code))] // tests read these; the session's link path is the intended non-test caller but does not read them yet
    pub fn required_regions(&self) -> Vec<u32> {
        self.link
            .lock()
            .expect("the link mutex is never poisoned")
            .required_regions
            .clone()
    }

    /// The event sources the adapters registered, for the log and for A2b's
    /// scheduler.
#[cfg_attr(not(test), allow(dead_code))] // tests read it; the registry keeps the names, the run path never asks again
    pub fn sources(&self) -> Vec<String> {
        self.link
            .lock()
            .expect("the link mutex is never poisoned")
            .sources
            .clone()
    }

    /// How many sources have been registered. `post_event` validates its
    /// `source_id` against this: the ids are 1-based and dense, so a valid id
    /// is in `1..=count`.
    pub(crate) fn source_count(&self) -> u32 {
        self.link
            .lock()
            .expect("the link mutex is never poisoned")
            .sources
            .len() as u32
    }

    // ── the FFI side ──────────────────────────────────────────────────────

    /// The host an adapter's `user` pointer names, or `None` when it is null.
    ///
    /// SAFETY: `user` must be a pointer produced by [`AdapterHost::new`] (or the
    /// table's own `user`), and the host must still be alive. The returned
    /// reference may be shared across threads: `AdapterHost` is `Sync`, which is
    /// asserted above and is what makes the any-thread slots sound.
    pub(crate) unsafe fn from_user(user: *mut c_void) -> Option<&'static AdapterHost> {
        if user.is_null() {
            None
        } else {
            Some(unsafe { &*(user as *const AdapterHost) })
        }
    }

    /// The API table, by value (it is `Copy`).
#[cfg_attr(not(test), allow(dead_code))] // the linker tests build their shim table through it; the run path hands the table to `link` directly
    pub(crate) fn api_table(&self) -> TensionCoreApi {
        self.api.0
    }

    /// What kind of context the adapter call in flight has.
    ///
    /// Two shapes, because an adapter's code reaches guest memory two ways:
    ///
    /// - [`Ctx::Caller`] — a `session::*` verb or a callback is on the stack.
    ///   The guest's own stack is under this one, so a `Caller` exists.
    /// - [`Ctx::Store`] — the host-owned loop is driving the epoch (0.7.0a).
    ///   There is no guest call to borrow, so the `Store` itself is the way in.
    ///
    /// The contract's §3.4 rule is what makes the second safe: a manager never
    /// touches the Store, and the loop calls this only between wakes, on the
    /// store's owner thread.
    pub(crate) fn ctx_kind(&self) -> u8 {
        self.ctx_kind.load(Ordering::Relaxed)
    }

    /// Run `body` with the guest's arena bytes, from whichever context is
    /// installed.
    ///
    /// **One dispatch site.** `guest_read` and `guest_write` both go through
    /// here, so a third context kind would be one new arm rather than a hunt
    /// through the shims. `Err` carries the errno the shim returns: `-EBUSY`
    /// for a call from the wrong thread or with nothing installed (the header's
    /// rule 6), `-EBADF` when there is no arena.
    ///
    /// SAFETY: the caller has already passed `caller_is_this_thread`, so the
    /// pointer was installed by this thread and is cleared by the guard before
    /// the frame ends.
    pub(crate) fn with_arena<R>(
        &self,
        body: impl FnOnce(&[u8]) -> R,
    ) -> Result<R, i32> {
        if !self.caller_is_this_thread() {
            return Err(EBUSY);
        }
        let raw = *self.ctx.lock().expect("the ctx mutex is never poisoned");
        if raw == 0 {
            return Err(EBUSY); // outside a guest call: rule 6
        }
        match self.ctx_kind() {
            CTX_CALLER => {
                // SAFETY: installed by this thread's guard, checked above.
                let caller = unsafe { &mut *(raw as *mut Caller<'static, HostState>) };
                let Some(memory) = caller.data().arena else {
                    return Err(EBADF);
                };
                Ok(body(memory.data(&*caller)))
            }
            CTX_STORE => {
                // SAFETY: installed by this thread's guard, checked above.
                let store = unsafe { &mut *(raw as *mut Store<HostState>) };
                let Some(memory) = store.data().arena else {
                    return Err(EBADF);
                };
                Ok(body(memory.data(&*store)))
            }
            _ => Err(EBUSY),
        }
    }

    /// The writable half of [`AdapterHost::with_arena`]. Used by `guest_write`
    /// and by nothing else.
    pub(crate) fn with_arena_mut<R>(
        &self,
        body: impl FnOnce(&mut [u8]) -> R,
    ) -> Result<R, i32> {
        if !self.caller_is_this_thread() {
            return Err(EBUSY);
        }
        let raw = *self.ctx.lock().expect("the ctx mutex is never poisoned");
        if raw == 0 {
            return Err(EBUSY);
        }
        match self.ctx_kind() {
            CTX_CALLER => {
                // SAFETY: as in `with_arena`.
                let caller = unsafe { &mut *(raw as *mut Caller<'static, HostState>) };
                let Some(memory) = caller.data().arena else {
                    return Err(EBADF);
                };
                Ok(body(memory.data_mut(&mut *caller)))
            }
            CTX_STORE => {
                // SAFETY: as in `with_arena`.
                let store = unsafe { &mut *(raw as *mut Store<HostState>) };
                let Some(memory) = store.data().arena else {
                    return Err(EBADF);
                };
                Ok(body(memory.data_mut(&mut *store)))
            }
            _ => Err(EBUSY),
        }
    }

    /// The installed `Caller`, when the context is one.
    ///
    /// Kept for the test-only probe that reads `depth` through it
    /// (`epoch.rs:1370`); production code goes through [`AdapterHost::with_arena`]
    /// or [`AdapterHost::with_arena_mut`], which handle both kinds. Returns null
    /// for a store context, which has no `Caller` to hand out.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn caller(&self) -> *mut Caller<'static, HostState> {
        if self.ctx_kind() != CTX_CALLER {
            return std::ptr::null_mut();
        }
        let address = *self.ctx.lock().expect("the ctx mutex is never poisoned");
        address as *mut Caller<'static, HostState>
    }

    /// Whether the caller slot belongs to *this* thread (C4.1b). False when the
    /// slot is empty (tid 0) or was installed by another thread — either way, a
    /// guest-memory shim must refuse rather than trust the pointer.
    pub(crate) fn caller_is_this_thread(&self) -> bool {
        let tid = self.caller_thread.load(Ordering::Relaxed);
        tid != 0 && tid == current_thread_id()
    }

    pub(crate) fn memory_size(&self) -> u32 {
        self.memory_size.load(Ordering::Relaxed)
    }

    /// Install the `Caller` of the adapter call now in flight, refreshing the
    /// cached memory size while there is a caller to ask.
    pub(crate) fn enter_caller(&self, caller: &mut Caller<'static, HostState>) {
        // `HostState::arena`, not the session: the epoch runs while the session
        // is out of the store, and a publish hook still needs the size.
        let memory = caller.data().arena;
        if let Some(memory) = memory {
            self.memory_size
                .store(memory.data(&*caller).len() as u32, Ordering::Relaxed);
        }
        *self.ctx.lock().expect("the ctx mutex is never poisoned") =
            caller as *mut Caller<'static, HostState> as usize;
        // Kind, then thread id, *after* the pointer: a shim that sees either
        // also sees a matching address.
        self.ctx_kind.store(CTX_CALLER, Ordering::Relaxed);
        self.caller_thread.store(current_thread_id(), Ordering::Relaxed);
    }

    /// Install the `Store` of a host-owned epoch (0.7.0a). The same window, the
    /// same guard, the same thread rule — only the way into guest memory
    /// differs.
    pub(crate) fn enter_store(&self, store: &mut Store<HostState>) {
        let memory = store.data().arena;
        if let Some(memory) = memory {
            self.memory_size
                .store(memory.data(&*store).len() as u32, Ordering::Relaxed);
        }
        *self.ctx.lock().expect("the ctx mutex is never poisoned") =
            store as *mut Store<HostState> as usize;
        self.ctx_kind.store(CTX_STORE, Ordering::Relaxed);
        self.caller_thread.store(current_thread_id(), Ordering::Relaxed);
    }

    /// Clear the slot. The guard in `ffi` calls this however a call ends.
    pub(crate) fn leave(&self) {
        // Thread id first, then kind, then the pointer: a racing shim stops
        // trusting the slot in the same order the install published it.
        self.caller_thread.store(0, Ordering::Relaxed);
        self.ctx_kind.store(CTX_EMPTY, Ordering::Relaxed);
        *self.ctx.lock().expect("the ctx mutex is never poisoned") = 0;
    }

    /// Open a `publish` hook's byte budget. Only one hook runs at a time: the
    /// epoch is on the guest thread and `publish` is documented as synchronous.
    pub(crate) fn begin_publish(&self, budget: u32) {
        self.publish_budget.store(budget, Ordering::Relaxed);
        self.in_publish.store(true, Ordering::Relaxed);
    }

    /// Close it. The budget is zeroed rather than left standing, so a stray
    /// `guest_write` after the hook sees "not publishing" and not "no budget".
    pub(crate) fn end_publish(&self) {
        self.in_publish.store(false, Ordering::Relaxed);
        self.publish_budget.store(0, Ordering::Relaxed);
    }

    /// Charge `len` bytes against the publish budget. `true` when the write may
    /// proceed: everything outside publish, and everything that fits inside it.
    pub(crate) fn charge_publish(&self, len: u32) -> bool {
        if !self.in_publish.load(Ordering::Relaxed) {
            return true;
        }
        let mut left = self.publish_budget.load(Ordering::Relaxed);
        loop {
            if left < len {
                return false;
            }
            match self.publish_budget.compare_exchange_weak(
                left,
                left - len,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(actual) => left = actual,
            }
        }
    }

    pub(crate) fn has_verb_id(&self, verb_id: u32) -> bool {
        self.link
            .lock()
            .expect("the link mutex is never poisoned")
            .verb_ids
            .contains(&verb_id)
    }

    pub(crate) fn push_import(&self, import: RegisteredImport) {
        let mut link = self.link.lock().expect("the link mutex is never poisoned");
        link.verb_ids.push(import.verb_id);
        link.imports.push(import);
    }

    pub(crate) fn push_source(&self, name: String) -> u32 {
        let mut link = self.link.lock().expect("the link mutex is never poisoned");
        link.sources.push(name);
        link.sources.len() as u32 // 1-based, like every other id in this repo
    }

    pub(crate) fn note_region(&self, kind: u32) {
        let mut link = self.link.lock().expect("the link mutex is never poisoned");
        if !link.required_regions.contains(&kind) {
            link.required_regions.push(kind);
        }
    }

    /// Take what one adapter's `link` collected, and reset for the next one.
    pub(crate) fn take_link_results(&self) -> (Vec<RegisteredImport>, Vec<u32>) {
        let mut link = self.link.lock().expect("the link mutex is never poisoned");
        let imports = std::mem::take(&mut link.imports);
        let regions = std::mem::take(&mut link.required_regions);
        link.verb_ids.clear();
        (imports, regions)
    }
}
/// One adapter's `publish` hook, as the epoch holds it: the vtable to call, the
/// API table to hand it, and the name for a diagnostic.
///
/// The epoch lives in the session and reaches the adapters through `HostState`,
/// so this is the smallest thing that has to travel: a raw vtable pointer (the
/// library stays open in `main`'s frame, which outlives every epoch) and a copy
/// of the API table.
#[derive(Clone)]
pub(crate) struct AdapterCall {
    pub(crate) vtable: *const TensionAdapter,
    pub(crate) api: TensionCoreApi,
    pub(crate) name: String,
}

impl std::fmt::Debug for AdapterCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdapterCall").field("name", &self.name).finish()
    }
}

/// Describe the loaded adapters for the epoch, in registration order.
pub(crate) fn adapter_calls(adapters: &[LoadedAdapter], api: &TensionCoreApi) -> Vec<AdapterCall> {
    adapters
        .iter()
        .map(|adapter| AdapterCall {
            vtable: adapter.adapter,
            api: *api,
            name: adapter.name.clone(),
        })
        .collect()
}

/// Run one adapter call — a `publish` or `apply` hook — with guest memory
/// reachable through `guest_write` for its duration.
///
/// The caller slot is the same one an import call installs, so a hook that
/// writes a region uses exactly the path an import uses; it is cleared however
/// the body ends.
/// Run `body` with the adapter's own context installed, chosen by the caller:
/// the `Caller` variant for a guest call, the `Store` variant for the host loop.
pub(crate) fn with_hook_ctx<C, R, F>(cx: &mut C, api: &TensionCoreApi, body: F) -> R
where
    C: HookCtx,
    F: FnOnce() -> R,
{
    // SAFETY: the table's `user` is the host the registry built for this run.
    match unsafe { AdapterHost::from_user(api.user) } {
        Some(host) => {
            let handle = HostHandle(host as *const AdapterHost as *mut AdapterHost);
            cx.run_hook(handle, body)
        }
        None => body(),
    }
}

pub(crate) fn with_publish_caller<R>(
    caller: &mut Caller<'_, HostState>,
    api: &TensionCoreApi,
    body: impl FnOnce() -> R,
) -> R {
    // SAFETY: the table's `user` is the host the registry built for this run.
    match unsafe { AdapterHost::from_user(api.user) } {
        Some(host) => {
            let handle = HostHandle(host as *const AdapterHost as *mut AdapterHost);
            ffi::with_caller_installed(handle, caller, body)
        }
        None => body(),
    }
}

/// Run every loaded adapter's `publish` hook, in registration order, with guest
/// memory available through `guest_write` and a byte budget per call.
///
/// A hook that returns non-zero is logged and the epoch carries on: the records
/// it did not write are simply not there this epoch, and the adapter can try
/// again next time. Returns how many hooks ran.
/// The context an epoch hook runs against.
///
/// The epoch's body is one function serving two callers: a `session::*` verb,
/// whose `Caller` is on the stack, and the host-owned loop (0.7.0a), which has
/// only a `Store`. Everything mechanical is written once over
/// `AsContextMut<Data = HostState>`; this trait covers the one thing that is
/// *not* mechanical — installing the context the adapter's memory shims read.
///
/// A `Caller` cannot hand out a `&mut Store` (wasmtime exposes the store only as
/// a `StoreContextMut`, and `StoreContextMut` does not unwrap), so the two
/// implementations cannot be collapsed into one. Two impls of one method is the
/// smallest honest shape.
pub(crate) trait HookCtx {
    /// Run `body` with this context installed in the adapter host, so
    /// `guest_read`/`guest_write` reach guest memory for its duration.
    fn run_hook<R, F: FnOnce() -> R>(&mut self, handle: HostHandle, body: F) -> R;
}

impl HookCtx for Caller<'_, HostState> {
    fn run_hook<R, F: FnOnce() -> R>(&mut self, handle: HostHandle, body: F) -> R {
        ffi::with_caller_installed(handle, self, body)
    }
}

impl HookCtx for Store<HostState> {
    fn run_hook<R, F: FnOnce() -> R>(&mut self, handle: HostHandle, body: F) -> R {
        ffi::with_store_installed(handle, self, body)
    }
}

pub(crate) fn run_publish_hooks<C>(
    cx: &mut C,
    calls: &[AdapterCall],
) -> usize
where
    C: HookCtx,
{
    let mut ran = 0;
    let Some(first) = calls.first() else {
        return 0;
    };
    // SAFETY: every call carries the same table, whose `user` is the host the
    // registry built for this run.
    let host = unsafe { AdapterHost::from_user(first.api.user) };
    let handle = host.map(|host| HostHandle(host as *const AdapterHost as *mut AdapterHost));

    for call in calls {
        // SAFETY: the vtable pointer comes from a library `main` keeps open for
        // the whole run, and the epoch runs inside that run.
        let Some(publish) = (unsafe { (*call.vtable).publish }) else {
            continue;
        };
        ran += 1;
        match handle {
            Some(handle) => {
                let host = handle.get().expect("the handle is non-null");
                host.begin_publish(PUBLISH_BUDGET_BYTES);
                // The hook runs with the caller installed, so its own
                // `guest_write` calls reach the guest memory of the call the
                // epoch is inside.
                let status = cx.run_hook(handle, || unsafe {
                    publish(std::ptr::null_mut(), &call.api)
                });
                host.end_publish();
                if status != 0 {
                    log_line(&format!(
                        "adapter `{}`: publish returned {status}",
                        call.name
                    ));
                }
            }
            None => {
                let status = unsafe { publish(std::ptr::null_mut(), &call.api) };
                if status != 0 {
                    log_line(&format!(
                        "adapter `{}`: publish returned {status} (no host installed)",
                        call.name
                    ));
                }
            }
        }
    }
    ran
}

/// The session channel, named here because this module is where the publish
/// hook's failures are reported (`DESIGN.md` §7.2). Routed through the host
/// logger under the name `session`, so the line carries the configured layout —
/// the old fixed `[tension:session]` prefix is now the layout's logger column.
fn log_line(message: &str) {
    tension_core::logging::log(tension_core::logging::Level::Info, "session", message);
}

/// A loaded adapter and what its `link` registered.
///
/// The library stays open for the process's lifetime: the imports installed in
/// the linker hold function pointers into it, so dropping this before the
/// linker does would leave those pointers dangling.
pub struct LoadedAdapter {
    _library: ffi::Library,
    adapter: *const TensionAdapter,
    name: String,
    imports: Vec<RegisteredImport>,
    required_regions: Vec<u32>,
    /// Set once [`LoadedAdapter::teardown`] has run. `shutdown` is idempotent by
    /// contract, but `destroy` is "called once", and both the clean and the
    /// trapping exit paths can reach teardown.
    torn_down: bool,
}

impl LoadedAdapter {
    /// The capability's own name, from its vtable.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// What this adapter registered.
#[cfg_attr(not(test), allow(dead_code))] // tests read it; the session resolves imports as it links, so this accessor has no non-test caller
    pub fn imports(&self) -> &[RegisteredImport] {
        &self.imports
    }

    /// The region kinds it asked about during `link`.
    pub fn required_regions(&self) -> &[u32] {
        &self.required_regions
    }

    /// Tear this adapter down: `shutdown` then `destroy`, at most once.
    ///
    /// The vtable's contract (`tension_adapter.h`) is what makes the order and
    /// the call site safe. `shutdown` stops background threads and releases
    /// their resources, **is idempotent**, and **must not touch guest memory**;
    /// `destroy` frees the adapter's own storage and is "called once, after
    /// `shutdown`". Joining is inside `shutdown` ("a render thread tears down
    /// its own engine objects before exiting, on its own thread: that is what
    /// joining buys"), so when `destroy` runs nothing is still inside the
    /// adapter.
    ///
    /// Runs on the interpreter thread, outside any guest call — the only place
    /// the ABI permits `shutdown`/`destroy` (rule 4), and therefore a place
    /// where no `publish`/`apply` is in flight. `ctx` is null because the vtable
    /// has no context accessor and adapters keep their own state; `init` and
    /// `link` are called with null `ctx` the same way (`link_adapters`).
    fn teardown(&mut self) {
        if self.torn_down {
            return;
        }
        self.torn_down = true;
        // SAFETY: `self.adapter` points into this adapter's own library, which
        // `self._library` keeps open until after this runs; the two calls go
        // through the vtable the library published.
        unsafe {
            if let Some(shutdown) = (*self.adapter).shutdown {
                let rc = shutdown(std::ptr::null_mut());
                if rc != 0 {
                    crate::logging::log(
                        crate::logging::Level::Warn,
                        "core",
                        &format!("capability `{}`: shutdown returned {rc}", self.name),
                    );
                }
            }
            if let Some(destroy) = (*self.adapter).destroy {
                destroy(std::ptr::null_mut());
            }
        }
    }
}

/// Tear down every loaded adapter, in **reverse of link order**.
///
/// Reverse order mirrors `link`: the adapter linked last — the one built on top
/// of the imports the earlier ones established — comes apart first. Called on
/// every exit path from the run, so a clean return and a guest trap both reach
/// it (`main.rs`); a trapping guest cannot leave an adapter's threads running.
/// [`LoadedAdapter::teardown`] is idempotent, so a second call is a no-op.
pub fn teardown_adapters(adapters: &mut [LoadedAdapter]) {
    for adapter in adapters.iter_mut().rev() {
        adapter.teardown();
    }
}

/// Load one adapter: `dlopen`, find the entry point, and check the ABI version
/// before anything else touches the vtable.
pub fn load_adapter(path: &Path) -> Result<LoadedAdapter, AdapterError> {
    let library = ffi::Library::open(path).map_err(|why| AdapterError::Open {
        path: path.to_path_buf(),
        why,
    })?;
    let symbol = library
        .symbol(ENTRY_SYMBOL)
        .map_err(|why| AdapterError::EntryPoint {
            path: path.to_path_buf(),
            why,
        })?;

    // SAFETY: the symbol is the entry point the header declares; it returns a
    // pointer to a static vtable that lives as long as the library, which the
    // `LoadedAdapter` holds open.
    let entry: extern "C" fn() -> *const TensionAdapter = unsafe { std::mem::transmute(symbol) };
    let adapter = entry();
    if adapter.is_null() {
        return Err(AdapterError::NullVtable {
            path: path.to_path_buf(),
        });
    }

    // The ABI version is read first, and it is what makes the `layout_hash` read
    // below safe. A version-1 adapter has a 72-byte `tension_adapter` with no
    // `layout_hash`; reading offset 72 of it would be an out-of-bounds read of
    // the shorter object. This gate refuses a v1 adapter before that read is
    // reached, so the ordering here is load-bearing, not cosmetic.
    let abi_version = unsafe { (*adapter).abi_version };
    if abi_version != ffi::ADAPTER_ABI_VERSION {
        return Err(AdapterError::AbiVersion {
            path: path.to_path_buf(),
            found: abi_version,
            expected: ffi::ADAPTER_ABI_VERSION,
        });
    }

    // C4.1c: the layout hash, checked here — after the version gate above (which
    // guarantees this field exists) and before `init`, before `link`, before any
    // vtable slot is called. `abi_version` answers "is this the right shape of
    // contract"; this answers "is this the right build of it", catching a vtable
    // field appended or an arena region moved while the version stayed the same.
    let layout_hash = unsafe { (*adapter).layout_hash };
    if layout_hash != crate::session::arena::layout_hash() {
        return Err(AdapterError::LayoutHash {
            path: path.to_path_buf(),
            found: layout_hash,
            expected: crate::session::arena::layout_hash(),
        });
    }

    let name = unsafe { (*adapter).name };
    if name.is_null() {
        return Err(AdapterError::NullVtable {
            path: path.to_path_buf(),
        });
    }
    let name = unsafe { std::ffi::CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned();

    Ok(LoadedAdapter {
        _library: library,
        adapter,
        name,
        imports: Vec::new(),
        required_regions: Vec::new(),
        torn_down: false,
    })
}

/// Drive every adapter through `init` and `link`, then install what they
/// registered.
///
/// `api` must be an [`AdapterHost`]'s table: the registry reaches the host
/// through it, which is how the collected imports come back.
pub fn link_adapters(
    linker: &mut Linker<HostState>,
    adapters: &mut [LoadedAdapter],
    api: &TensionCoreApi,
) -> Result<(), AdapterError> {
    // SAFETY: the caller passes an `AdapterHost`'s own table, so `user` names a
    // live host.
    let host = unsafe { AdapterHost::from_user(api.user) }.ok_or(AdapterError::NoHost)?;
    let handle = HostHandle(host as *const AdapterHost as *mut AdapterHost);

    let mut claimed: BTreeSet<(String, String)> = BTreeSet::new();

    for (adapter_index, adapter) in adapters.iter_mut().enumerate() {
        // init: the adapter constructs itself from statics (the vtable has no
        // context accessor, so `ctx` is null and the adapter keeps its own state).
        if let Some(init) = unsafe { (*adapter.adapter).init } {
            let status = unsafe { init(std::ptr::null_mut(), api) };
            if status != 0 {
                return Err(AdapterError::Init {
                    name: adapter.name.clone(),
                    status,
                });
            }
        }

        let Some(link) = (unsafe { (*adapter.adapter).link }) else {
            return Err(AdapterError::MissingLink {
                name: adapter.name.clone(),
            });
        };
        let status = unsafe { link(std::ptr::null_mut(), api) };
        if status != 0 {
            return Err(AdapterError::Link {
                name: adapter.name.clone(),
                status,
            });
        }

        let (imports, regions) = host.take_link_results();
        adapter.imports = imports;
        adapter.required_regions = regions;

        // What one registration cannot know: the reserved module is refused by
        // the shim already, and this is the second pair of eyes; a duplicate is
        // only visible to the registry, and it is refused rather than
        // first-wins so a load order cannot silently decide an ABI.
        for import in adapter.imports.iter_mut() {
            // The registry stamps the index a deferred submission travels with:
            // the adapter knows its verb ids, not its position in the load order.
            import.adapter_index = adapter_index as u32;

            if import.module == RESERVED_MODULE {
                return Err(AdapterError::ReservedModule {
                    adapter: adapter.name.clone(),
                    module: import.module.clone(),
                    import: import.name.clone(),
                });
            }
            if !claimed.insert((import.module.clone(), import.name.clone())) {
                return Err(AdapterError::DuplicateImport {
                    module: import.module.clone(),
                    name: import.name.clone(),
                    adapter: adapter.name.clone(),
                });
            }
            // Two things a DEFERRABLE import must have for the deferred path to
            // exist at all: somewhere to apply it (this adapter's `apply`), and
            // an `i32` return, because `-ENOSPC` is what a guest hears when the
            // pending queue is full. Both are refused here rather than failing
            // silently later.
            if import.flags & ffi::TENSION_IMPORT_DEFERRABLE != 0 {
                let has_apply = unsafe { (*adapter.adapter).apply }.is_some();
                if !has_apply {
                    return Err(AdapterError::DeferrableWithoutApply {
                        adapter: adapter.name.clone(),
                        import: import.name.clone(),
                    });
                }
                if import.signature.ret() != ValueType::I32 {
                    return Err(AdapterError::DeferrableReturn {
                        adapter: adapter.name.clone(),
                        import: import.name.clone(),
                    });
                }
            }
        }
    }

    for adapter in adapters.iter() {
        for import in adapter.imports.iter().cloned() {
            let module = import.module.clone();
            let name = import.name.clone();
            let ty = ffi::import_func_type(linker.engine(), &import.signature);
            linker
                .func_new(&module, &name, ty, ffi::import_closure(handle, import))
                .map_err(|why| AdapterError::Register {
                    module,
                    name,
                    why: why.to_string(),
                })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A posting face for a test host: the default capacities, shared by `Arc`
    /// the way `main` shares one with the session.
    fn test_posting() -> Arc<PostingSide> {
        Arc::new(PostingSide::default())
    }
    use std::ffi::CString;
    use wasmtime::{Engine, Module, Store};

    /// The two objects `build.rs` compiles from the same source.
    const ECHO: &str = env!("TENSION_ECHO_ADAPTER");
    const ECHO_BAD_ABI: &str = env!("TENSION_ECHO_BADABI_ADAPTER");
    /// A third build of the same source, carrying a layout hash the host will
    /// not match (C4.1c).
    const ECHO_BAD_LAYOUT: &str = env!("TENSION_ECHO_BADLAYOUT_ADAPTER");
    /// A fourth: the pre-C4 ABI version 1 shape, 72 bytes and no `layout_hash`.
    const ECHO_V1: &str = env!("TENSION_ECHO_V1_ADAPTER");

    fn test_store(engine: &Engine) -> Store<HostState> {
        Store::new(
            engine,
            HostState {
                args: Vec::new(),
                pending_line: None,
                res: Vec::new(),
                audio: crate::audio::AudioSession::new(crate::default_adapter()),
                ai: crate::ai::AiSession::new(crate::default_ai_adapter(crate::ai::AiSink::detached_posting())),
                solver: crate::solver::SolverHost::default(),
                scheduler: crate::scheduler::Scheduler::new(),
                task_wake: None,
                game_running: None,
                posting: test_posting(),
                arena: None,
                depth: 0,
                pending: crate::session::apply::PendingQueue::new(),
                adapters: Vec::new(),
                session: None,
            },
        )
    }

    #[test]
    fn loading_the_echo_adapter_reports_its_name_and_version() {
        let adapter = load_adapter(Path::new(ECHO)).expect("the echo adapter loads");
        assert_eq!(adapter.name(), "echo");
        assert!(adapter.imports().is_empty(), "nothing is registered before link");
        assert!(adapter.required_regions().is_empty());
    }

    #[test]
    fn a_wrong_abi_version_is_refused_at_load() {
        let error = load_adapter(Path::new(ECHO_BAD_ABI))
            .err()
            .expect("the wrong-ABI build is refused");
        match error {
            AdapterError::AbiVersion {
                found,
                expected,
                ..
            } => {
                assert_eq!(found, 3, "the fixture declares a version this build does not load");
                assert_eq!(expected, ffi::ADAPTER_ABI_VERSION);
                assert_eq!(expected, 2);
            }
            other => panic!("expected an ABI refusal, got {other:?}"),
        }
        assert!(error.to_string().contains("ABI 3"));
    }

    #[test]
    fn a_version_1_adapter_is_refused_by_the_version_check_not_a_layout_read() {
        // The pre-C4 adapter: `sizeof(tension_adapter) == 72`, with no
        // `layout_hash`. If the loader read offset 72 to fetch a layout hash
        // before checking the version, that read would be out of bounds of the
        // object — an OOB read, not a refusal. The version gate runs first, so
        // the refusal is `AbiVersion` (found 1), and the layout read is never
        // reached. This is the C4c amendment: refine the earlier "fail-closed"
        // claim, which was wrong, into a gate that actually holds.
        let error = load_adapter(Path::new(ECHO_V1))
            .err()
            .expect("the v1 build is refused");
        match error {
            AdapterError::AbiVersion {
                found,
                expected,
                ..
            } => {
                assert_eq!(found, 1, "the fixture is a version-1 adapter");
                assert_eq!(expected, 2);
            }
            AdapterError::LayoutHash { .. } => panic!(
                "a v1 adapter was refused for its layout hash — that means the host read \
                 offset 72 of a 72-byte struct, an out-of-bounds read; the version check must \
                 run first"
            ),
            other => panic!("expected an ABI-version refusal, got {other:?}"),
        }
        assert!(error.to_string().contains("ABI 1"));
    }

    #[test]
    fn a_missing_file_is_refused_by_name() {
        let error = load_adapter(Path::new("/nonexistent/libtension_nope.so"))
            .err()
            .expect("a missing file is refused");
        assert!(matches!(error, AdapterError::Open { .. }));
        assert!(error.to_string().contains("libtension_nope.so"));
    }

    // ── C4.1c / C4.1d: the load-time preflight ────────────────────────────

    #[test]
    fn a_layout_hash_mismatch_is_refused_at_load() {
        // The same adapter at the *current* ABI version, built against a
        // different arena layout. `abi_version` matches, so this is exactly the
        // drift the version check alone cannot catch — it must be refused
        // before `init`/`link` run. (An *older*-version adapter is a different
        // case, refused earlier and by version: see
        // `a_version_1_adapter_is_refused_by_the_version_check_not_a_layout_read`.)
        let error = load_adapter(Path::new(ECHO_BAD_LAYOUT))
            .err()
            .expect("the wrong-layout build is refused");
        match error {
            AdapterError::LayoutHash {
                found, expected, ..
            } => {
                assert_ne!(found, expected);
                assert_eq!(
                    expected,
                    crate::session::arena::layout_hash(),
                    "the expected hash is this build's arena layout"
                );
            }
            other => panic!("expected a layout-hash refusal, got {other:?}"),
        }
        assert!(
            error.to_string().contains("arena layout"),
            "the message names the mismatch: {error}"
        );
    }

    #[test]
    fn a_file_that_is_not_a_shared_object_is_refused_by_name() {
        // The preflight's first gate: a file that is not a loadable object at
        // all. `dlopen` refuses it and the refusal names the path, rather than
        // the failure surfacing later as a null vtable.
        let dir = std::env::temp_dir().join(format!("tension-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        let path = dir.join("not-an-adapter.so");
        std::fs::write(&path, b"this is not an ELF shared object\n").expect("write the decoy");

        let error = load_adapter(&path).err().expect("a non-DSO is refused");
        assert!(matches!(error, AdapterError::Open { .. }), "{error:?}");
        assert!(
            error.to_string().contains("not-an-adapter.so"),
            "the refusal names the file: {error}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn linking_registers_the_adapters_imports_and_regions() {
        let engine = Engine::default();
        let mut store = test_store(&engine);
        let host = AdapterHost::new(test_posting());
        let mut adapters = vec![load_adapter(Path::new(ECHO)).expect("echo loads")];
        let mut linker: Linker<HostState> = Linker::new(&engine);

        link_adapters(&mut linker, &mut adapters, host.api()).expect("the adapter links");

        let imports = adapters[0].imports();
        assert_eq!(
            imports.len(),
            3,
            "the echo adapter registers three imports: add, roundtrip, and the \
             deferrable note_deferred"
        );
        assert_eq!(imports[0].module, "echo");
        assert_eq!(imports[0].name, "add");
        assert_eq!(imports[1].name, "roundtrip");
        assert_eq!(imports[0].signature.nparams(), 2);
        assert_eq!(imports[0].signature.ret(), signatures::ValueType::I32);
        // The echo adapter declares nothing deferrable: neither verb may be
        // called from inside a callback (A2's rule, declared here).
        assert!(!imports[0].is_deferrable());
        assert!(!imports[1].is_deferrable());
        // Asking about a region during link is the declaration of needing it,
        // and the source registration is the adapter naming where its events
        // will come from.
        assert_eq!(
            adapters[0].required_regions(),
            &[crate::session::arena::REGION_JOB]
        );
        assert_eq!(host.sources(), vec!["echo".to_string()]);

        // The imports are real ones: a guest that calls `echo::add` gets the
        // adapter's answer, all the way through dlopen, the closure factory, and
        // the C function.
        let wat = r#"
(module
  (import "echo" "add" (func $add (param i32 i32) (result i32)))
  (func (export "run") (result i32) (call $add (i32.const 2) (i32.const 3)))
)
"#;
        let module = Module::new(&engine, wat).expect("module");
        let instance = linker.instantiate(&mut store, &module).expect("instantiate");
        let run = instance
            .get_typed_func::<(), i32>(&mut store, "run")
            .expect("run");
        assert_eq!(run.call(&mut store, ()).expect("call"), 5);
    }

    #[test]
    fn two_adapters_claiming_the_same_import_are_refused() {
        let engine = Engine::default();
        let host = AdapterHost::new(test_posting());
        let mut adapters = vec![
            load_adapter(Path::new(ECHO)).expect("echo loads"),
            load_adapter(Path::new(ECHO)).expect("echo loads twice"),
        ];
        let mut linker: Linker<HostState> = Linker::new(&engine);

        let error = link_adapters(&mut linker, &mut adapters, host.api())
            .err()
            .expect("the second adapter's imports collide");
        match error {
            AdapterError::DuplicateImport { module, name, .. } => {
                assert_eq!(module, "echo");
                assert_eq!(name, "add");
            }
            other => panic!("expected a duplicate refusal, got {other:?}"),
        }
    }

    /// A minimal import, for the registration checks below.
    unsafe extern "C" fn fake_import(
        _ctx: *mut c_void,
        _args: *const ffi::TensionValue,
        _nargs: u32,
        _ret: *mut ffi::TensionValue,
    ) -> i32 {
        0
    }

    #[test]
    fn the_reserved_session_module_is_refused_at_registration() {
        let host = AdapterHost::new(test_posting());
        let module = CString::new("session").expect("no NUL");
        let name = CString::new("open").expect("no NUL");
        let status = unsafe {
            ffi::register_import(
                host.api().user,
                module.as_ptr(),
                name.as_ptr(),
                signatures::ValueType::I32 as u32,
                std::ptr::null(),
                0,
                Some(fake_import),
                std::ptr::null_mut(),
                1,
                0,
            )
        };
        assert_eq!(status, ffi::EINVAL, "`session` is tension-core's module");
        assert!(host.required_regions().is_empty());
    }

    #[test]
    fn a_signature_outside_the_closed_set_is_refused_at_registration() {
        let host = AdapterHost::new(test_posting());
        let module = CString::new("echo").expect("no NUL");
        let name = CString::new("vectorish").expect("no NUL");
        let params = [0x7Bu32]; // v128
        let status = unsafe {
            ffi::register_import(
                host.api().user,
                module.as_ptr(),
                name.as_ptr(),
                signatures::ValueType::I32 as u32,
                params.as_ptr(),
                1,
                Some(fake_import),
                std::ptr::null_mut(),
                1,
                0,
            )
        };
        assert_eq!(status, ffi::EINVAL);
    }

    #[test]
    fn a_duplicate_verb_id_is_refused_within_one_link() {
        let host = AdapterHost::new(test_posting());
        let module = CString::new("echo").expect("no NUL");
        for name in ["first", "second"] {
            let c_name = CString::new(name).expect("no NUL");
            let status = unsafe {
                ffi::register_import(
                    host.api().user,
                    module.as_ptr(),
                    c_name.as_ptr(),
                    signatures::ValueType::I32 as u32,
                    std::ptr::null(),
                    0,
                    Some(fake_import),
                    std::ptr::null_mut(),
                    9,
                    0,
                )
            };
            if name == "first" {
                assert_eq!(status, 0, "the first registration is accepted");
            } else {
                assert_eq!(status, ffi::EINVAL, "verb id 9 is taken");
            }
        }
    }

    #[test]
    fn region_lookup_answers_from_the_frozen_layout_without_a_session() {
        let host = AdapterHost::new(test_posting());
        let mut offset = 0u32;
        let mut size = 0u32;
        let status = unsafe {
            ffi::region_lookup(
                host.api().user,
                crate::session::arena::REGION_JOB,
                &mut offset,
                &mut size,
            )
        };
        assert_eq!(status, 0);
        assert_eq!(offset, crate::session::arena::JOB_OFFSET as u32);
        assert_eq!(size, crate::session::arena::JOB_SIZE as u32);
        assert_eq!(host.required_regions(), vec![crate::session::arena::REGION_JOB]);

        // A kind this chunk does not define is a named refusal, not a guess.
        let missing = unsafe { ffi::region_lookup(host.api().user, 99, &mut offset, &mut size) };
        assert_eq!(missing, ffi::ENOENT);
    }

    // ── C3: the adapter teardown ───────────────────────────────────────────

    /// Markers the recording vtables below push. A `Mutex`, not an atomic, so
    /// the *order* is asserted, not just the counts.
    static TEARDOWN_LOG: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());

    /// Serialises the teardown tests. They share `TEARDOWN_LOG`, and cargo runs
    /// tests in parallel, so without this the `is_empty` assertion in one can
    /// observe a `push` from the other — a flake, not a real failure.
    static TEARDOWN_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    unsafe extern "C" fn sh_a(_: *mut c_void) -> i32 {
        TEARDOWN_LOG.lock().expect("not poisoned").push("shutdown:a");
        0
    }
    unsafe extern "C" fn dt_a(_: *mut c_void) {
        TEARDOWN_LOG.lock().expect("not poisoned").push("destroy:a");
    }
    unsafe extern "C" fn sh_b(_: *mut c_void) -> i32 {
        TEARDOWN_LOG.lock().expect("not poisoned").push("shutdown:b");
        0
    }
    unsafe extern "C" fn dt_b(_: *mut c_void) {
        TEARDOWN_LOG.lock().expect("not poisoned").push("destroy:b");
    }

    /// A leaked vtable carrying the given teardown slots.
    fn vtable(shutdown: Option<ffi::ShutdownFn>, destroy: Option<ffi::DestroyFn>) -> *const TensionAdapter {
        Box::leak(Box::new(TensionAdapter {
            abi_version: ffi::ADAPTER_ABI_VERSION,
            name: std::ptr::null(),
            flags: 0,
            init: None,
            link: None,
            publish: None,
            apply: None,
            shutdown,
            destroy,
            layout_hash: crate::session::arena::layout_hash(),
        }))
    }

    /// A `LoadedAdapter` around a vtable the test owns. The `_library` is a real
    /// object (the echo fixture `build.rs` compiles) only so the field is
    /// satisfied; the vtable is the test's, so its `shutdown`/`destroy` are what
    /// run.
    fn loaded(name: &str, adapter: *const TensionAdapter) -> LoadedAdapter {
        let library = ffi::Library::open(std::path::Path::new(env!("TENSION_ECHO_ADAPTER")))
            .expect("the echo fixture opens");
        LoadedAdapter {
            _library: library,
            adapter,
            name: name.to_string(),
            imports: Vec::new(),
            required_regions: Vec::new(),
            torn_down: false,
        }
    }

    #[test]
    fn teardown_runs_reverse_order_once_each() {
        let _serial = TEARDOWN_TEST_LOCK.lock().expect("not poisoned");
        TEARDOWN_LOG.lock().expect("not poisoned").clear();
        let mut adapters = vec![
            loaded("a", vtable(Some(sh_a), Some(dt_a))),
            loaded("b", vtable(Some(sh_b), Some(dt_b))),
        ];

        teardown_adapters(&mut adapters);
        assert_eq!(
            *TEARDOWN_LOG.lock().expect("not poisoned"),
            vec!["shutdown:b", "destroy:b", "shutdown:a", "destroy:a"],
            "reverse of link order, and shutdown before destroy within each adapter"
        );

        // A second call changes nothing: `destroy` is "called once".
        teardown_adapters(&mut adapters);
        assert_eq!(
            TEARDOWN_LOG.lock().expect("not poisoned").len(),
            4,
            "teardown is idempotent — a second pass calls nothing"
        );
    }

    #[test]
    fn teardown_tolerates_slots_that_are_null() {
        let _serial = TEARDOWN_TEST_LOCK.lock().expect("not poisoned");
        // The ABI says `shutdown`/`destroy` must be present, but the loader does
        // not enforce it, so a NULL slot must be a no-op rather than a crash.
        TEARDOWN_LOG.lock().expect("not poisoned").clear();
        let mut adapters = vec![loaded("nullish", vtable(None, None))];
        teardown_adapters(&mut adapters);
        assert!(TEARDOWN_LOG.lock().expect("not poisoned").is_empty());
        assert!(adapters[0].torn_down, "the once-guard is still set");
    }
}
