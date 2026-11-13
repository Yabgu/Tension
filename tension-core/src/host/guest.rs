//! `GuestHost` — one guest's engine handle, module, store, linker and session.
//!
//! **The seam.** Before this type, `main()` built the engine, compiled the
//! module, assembled a 30-field `HostState`, created the session and started the
//! linker in one straight line, so there was no way to stand up a guest without
//! running the binary's whole startup. Now there is: [`GuestHost::new`] takes a
//! [`HostConfig`] and returns everything one guest needs.
//!
//! **What is in the bundle, and what is not.** In: the compiled `Module`, the
//! `Store` (holding this guest's `HostState`), the `Linker`, and the `Session`
//! while it is not yet installed into the store. Out: the `Engine` and the
//! posting face.
//!
//! *The engine lives in [`HostConfig`]* because it must be **shared** by every
//! guest the process runs. A per-guest engine would be a second compilation
//! cache, so a nested guest compiling the same module would compile it twice —
//! which is exactly the work `tension::dev.compile` is meant to avoid. Building
//! it once from the engine configuration and handing the same one to each
//! `GuestHost` is the shape nesting needs.
//!
//! *The posting face is not a field* because it is already in `HostState`
//! (`store.data().posting`), which is where every adapter reaches it; a second
//! handle on the struct would be a second name for one thing, and an unread
//! field besides.
//!
//! **`guest_bytes` is not kept.** It exists to compile the module and to run the
//! load-time check, both of which happen here; nothing in the driver reads the
//! bytes afterwards, and a retained-but-unread field is a `dead_code` warning.

use std::sync::Arc;

use wasmtime::{Linker, Module, Store};

/// The root store's epoch deadline: "never", but not `u64::MAX`.
///
/// wasmtime stores the deadline as `current_epoch + delta`
/// (`wasmtime-24.0.13/src/runtime/store.rs:2652`), so `u64::MAX` overflows —
/// and panics — once the engine's epoch has advanced at all. That is not
/// hypothetical: the moment a sandbox's watchdog ticks against the same engine,
/// the next `GuestHost` built on it would panic in its constructor. An unchanged
/// tree with two sandboxes in one test found it.
///
/// Half the range is 2^63 ticks. At the watchdog's tick that is longer than the
/// process will live, and reaching it would need 2^63 increments of a counter
/// only a running sandbox advances.
const NEVER_TRAPS: u64 = u64::MAX / 2;

/// Which kind of guest a bundle holds. See [`GuestHost::build`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    /// The process's own guest: real audio, real AI, a renderer that presents.
    Root,
    /// A sandboxed guest: none of the process singletons, captures its output,
    /// and runs under a budget and an epoch deadline.
    Nested,
}

use crate::host::{link_io, link_res, HostConfig};
use crate::session;
use crate::{check_guest_module, HostState};

/// One guest: its module, store, linker, and the session before it is installed.
pub(crate) struct GuestHost {
    /// The compiled guest. `instantiate` takes it after the caller has finished
    /// registering imports — adapters register last, and they are the caller's
    /// business because loading a DSO is not a property of the guest.
    pub(crate) module: Module,
    /// This guest's state. Every verb reaches it through `Caller::data()`.
    pub(crate) store: Store<HostState>,
    /// The import namespace, with the core services registered. `tension::io`,
    /// `tension::res` and (with `render2d-core`) `tension::2d` are registered
    /// here; `tension::platform`, `tension::session`, `tension::scheduler`,
    /// `tension::audio`, `tension::ai`, `tension::solver` and the capability
    /// adapters are still registered by `main`, because each needs either the
    /// loaded module or a capability DSO that `main` owns.
    pub(crate) linker: Linker<HostState>,
    /// The session, created from the module's memory import and not yet
    /// installed. `main` installs it (`Session::install` +
    /// `session::link_session`) at the point the arena must already be prepared
    /// and the capabilities' region requirements are known.
    ///
    /// `None` for a guest that imports nothing from `session` — the pre-session
    /// examples define their own memory and never call a session verb.
    pub(crate) session: Option<session::Session>,
}

impl GuestHost {
    /// Build one guest from the run's configuration.
    ///
    /// The order is the order the session's arena contract requires: engine,
    /// then the module (the session is created *from* it), then the store, then
    /// the session, then the linker — because the session's `install` needs a
    /// store and a linker that already exist.
    pub(crate) fn new(config: &HostConfig) -> anyhow::Result<Self> {
        Self::build(config, Kind::Root)
    }

    /// Build one guest of either kind.
    ///
    /// `Kind::Nested` is a **sandboxed** guest: silent audio, stub AI, a
    /// capture-mode renderer, a captured-output sink and a memory budget
    /// ([`crate::HostState::new_nested`]). The module comes from the same cache,
    /// so a second run of one guest compiles once; what differs is the store's
    /// contents and its bounds, not the compilation.
    pub(crate) fn build(config: &HostConfig, kind: Kind) -> anyhow::Result<Self> {
        // The module comes from the process's cache: one compile per file per
        // process, keyed by size and modification time so a rebuild is a miss.
        // A hit returns the module the load-time check already passed — same
        // fingerprint, same bytes — which is why the check runs only on a miss
        // and the bytes are only read there.
        //
        // `Module::new` takes the text format as well as the binary one, so a
        // hand-written `.wat` fixture loads the way a compiled `game.wasm` does
        // (§7 Appendix B's smoke path).
        let loaded = config.module_cache.load(&config.engine, &config.guest_path)?;
        if let Some(bytes) = &loaded.bytes {
            // A malformed guest is reported with the file's name in front of
            // wasmtime's own parse error: `Module::new` does not know where the
            // bytes came from, and "expected a module" with no path in it is a
            // bad diagnostic.
            check_guest_module(&loaded.module, bytes, &config.guest_path)?;
        }
        let module = loaded.module;

        // The posting face is built **before** the store because the AI backend
        // is a producer too: its worker posts AI completions through the same
        // any-thread path the adapters use, so it needs the `Arc` at construction
        // — not a borrow of the store it will wake.
        let posting = Arc::new(session::posting::PostingSide::default());
        let state = match kind {
            Kind::Root => HostState::new(config, Arc::clone(&posting)),
            Kind::Nested => HostState::new_nested(config, Arc::clone(&posting)),
        };
        let mut store = Store::new(&config.engine, state);
        // The limiter is installed for **every** store, with the budget being the
        // part that differs: unlimited for the process's own guest, a real ceiling
        // for a sandbox. Installing it only on sandboxes would leave the field
        // unread on the path that matters most, and a `ResourceLimiter` that says
        // "yes" costs one branch per growth.
        store.limiter(|state| &mut state.memory_budget);

        // **Required, not optional.** The engine enables epoch interruption
        // (`main`, where the engine is configured), and wasmtime traps a store
        // that runs code with no deadline set: "by default a store will trap
        // immediately with an epoch deadline of 0". This one never expires; a
        // sandbox installs a real deadline over it (`Sandbox::open`).
        store.set_epoch_deadline(NEVER_TRAPS);

        // tension::session ----------------------------------------------------
        // The session owns the arena memory, so it is created before anything is
        // linked and its arena is prepared before instantiation: the guest's data
        // segments land on a band the session already zeroed and canary-laid,
        // which is what makes `verify_post_instantiate` a complete check.
        //
        // **For a guest that imports nothing from `session`, there is no session
        // to create.** The arena is the session's, so a guest with no session
        // import has no arena — and the pre-session examples (io, audio, ai, res,
        // solver) are exactly that: they predate the session, define their own
        // memory, and reach the host ABI through `get_export("memory")` like
        // every other guest. The session's constructor requires a memory
        // *import*, which is a rule about owning an arena; applying it to a guest
        // with no session is the same scope error the start-section check had, so
        // it is scoped the same way. A session guest is unaffected: the import is
        // what identifies one.
        let guest_is_session_guest = module.imports().any(|import| import.module() == "session");
        let session = if guest_is_session_guest {
            let mut session = session::Session::create_from_module(&mut store, &module)?;
            session.prepare_arena(&mut store)?;
            Some(session)
        } else {
            None
        };

        let mut linker: Linker<HostState> = Linker::new(&config.engine);
        link_io(&mut linker)?;
        link_res(&mut linker)?;
        // `tension::2d`: in-core only when the feature is on. Off, the ten verbs
        // come from the capability DSO exactly as they did before, and this call
        // does not exist.
        //
        // Registered here rather than beside `tension::platform` in `main`, which
        // is where it used to sit. The two orders differ only in which namespace
        // was registered first: every namespace here is distinct, each is
        // registered exactly once, and nothing reads the linker's insertion order
        // — the only observable trace is the order of the `link:` debug lines,
        // and no suite runs at debug level.
        #[cfg(feature = "render2d-core")]
        crate::host::link_2d(&mut linker)?;
        // `tension::dev`: a guest that runs another guest. Registered for every
        // guest, the process's own included — the editor is the caller this
        // exists for — and for a nested guest too, which is why the depth cap is
        // in the verb rather than in this registration.
        crate::host::link_dev(&mut linker)?;

        Ok(Self {
            module,
            store,
            linker,
            session,
        })
    }
}
