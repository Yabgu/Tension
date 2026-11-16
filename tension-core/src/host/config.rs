//! `HostConfig` — everything a run is configured with, fixed before any store
//! exists.
//!
//! **Why this type exists.** `main()` used to interleave reading the CLI,
//! opening the resource paks, taking the write root and building the store, so
//! "what this run was configured with" was not a nameable thing — and a second
//! guest could not be given the same configuration without repeating the setup
//! around it. This is that name.
//!
//! **Immutable once constructed.** Every field is set at startup and never
//! reassigned. The `Arc`s inside are *shared* with the store and the adapter
//! host, so what they point at can change at run time — a guest's `res_mount`
//! adds a volume to the table — but the configuration that named them does not
//! change, and a second `GuestHost` gets the same one.
//!
//! **What is deliberately not here.** The loaded `Module`, the `Store`, the
//! `Linker` and the session: those are per guest ([`super::GuestHost`]).
//!
//! **What is here now that was not: which world the guest runs in.** The process
//! runs two engines (`tension_core::engines`), and a config that named a bare
//! `Engine` could be paired with a watchdog ticking a different one. The field is
//! a [`World`], so the engine, the world's module-cache key and the world's epoch
//! are one fact and cannot drift apart.
//!
//! Two things that look like they belong and do not:
//!
//! * **`--debug`.** It configures every world's engine (`engines::engine_config`),
//!   which is built from it before this struct exists, and the debug *report* runs
//!   earlier still. A copy here would be a field nothing reads.
//! * **Logging.** It is process-wide state installed before this type is
//!   constructed; a field holding it would suggest it could differ per guest,
//!   which it cannot.

use std::sync::{Arc, Mutex};

use tension_core::engines::{World, Worlds};
use tension_core::res;
use wasmtime::Engine;

/// One run's fixed configuration.
pub struct HostConfig {
    /// **Which world this guest runs in**, and the engine that world owns.
    ///
    /// A handle to the world rather than a bare `Engine`, because the two facts a
    /// guest's compilation needs cannot be allowed to disagree: the engine that
    /// compiles it, the world the module cache keys it by, and the epoch a
    /// watchdog ticks are the same world's. Before the split this was one
    /// `Engine` field and the process's own engine was also the sandbox's, so a
    /// nested guest ran in a capability world nobody had stated.
    ///
    /// **Here rather than in `GuestHost`, and that is a nesting decision.** An
    /// engine owns the compiled-code cache; one engine per guest would compile a
    /// shared module twice, which is precisely the cost `tension::dev.compile`
    /// exists to avoid. Immutable, `Clone`, and identical for every guest a world
    /// runs — so it is configuration, not per-guest state.
    pub world: Arc<World>,
    /// The worlds this process has, so a guest can open another one.
    ///
    /// `dev.run` needs it because a verb's only context is `Caller::data()`, and
    /// the world a nested guest must run in is *not* this config's world.
    pub worlds: Arc<Worlds>,
    /// The process's compiled-module cache.
    ///
    /// **Shared, not per guest**, for the same reason the engine is: the second
    /// guest is usually the same module, and compiling it again per run would put
    /// a Cranelift pass behind every press of a button. One cache, keyed by
    /// `(world, path)` — see [`super::module_cache`] for why the world is in the
    /// key and what a second world's compile costs.
    pub module_cache: std::sync::Arc<super::module_cache::ModuleCache>,
    /// The argv the guest reads through `tension::io arg()` / `arg_count()`.
    pub args: Vec<String>,
    /// The guest module on disk. Read once by `GuestHost::new`.
    pub guest_path: String,
    /// The `--res` paks, merged into one namespace (§7.2). `Arc<Mutex<_>>`
    /// because it has two readers — this store's `tension::res` verbs and the
    /// adapter host (`res_volume_bytes`, from a worker thread) — and because a
    /// second guest must see the same volumes rather than its own copy.
    pub res: Arc<Mutex<res::MountTable>>,
    /// The one directory a guest may write into, or `None` when `--write-root`
    /// did not resolve. `None` makes `res_write` answer `-EROFS` for every path.
    pub write_root: Option<res::WriteRoot>,
    /// `--capability` arguments, **unresolved**: `resolve_capability_paths`
    /// reads `TENSION_CAPABILITY_PATH`, and `main` is where the environment is
    /// read. Kept as given so the resolution rule stays in one place.
    pub capabilities: Vec<String>,
    /// A1 test-only: open the session from the host before `_start_game`.
    pub session_open: bool,
    /// A2 test-only: open with these table slots registered as callbacks.
    /// `Some` implies the host open.
    pub session_callbacks: Option<(u32, u32)>,
    /// A2 test-only: post three `JOB_DONE` events before `_start_game`.
    pub post_test_events: bool,
}

impl HostConfig {
    /// A handle to the engine of this config's world.
    ///
    /// A method rather than a field so there is no second place an engine can be
    /// stored and then disagree with `world`. Two `Clone`s of one `World` share
    /// the engine and its compiled-code cache; two worlds do not share anything.
    pub fn engine(&self) -> Engine {
        self.world.engine()
    }
}
