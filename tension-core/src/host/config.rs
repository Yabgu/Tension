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
//! Two things that look like they belong and do not:
//!
//! * **`--debug`.** It configures the engine, which is built from it before this
//!   struct exists, and the debug *report* runs earlier still. A copy here would
//!   be a field nothing reads.
//! * **Logging.** It is process-wide state installed before this type is
//!   constructed; a field holding it would suggest it could differ per guest,
//!   which it cannot.

use std::sync::{Arc, Mutex};

use tension_core::res;
use wasmtime::Engine;

/// One run's fixed configuration.
pub struct HostConfig {
    /// The wasmtime engine, built once from the engine configuration.
    ///
    /// **Here rather than in `GuestHost`, and that is a nesting decision.** An
    /// engine owns the compiled-code cache; one engine per guest would compile a
    /// shared module twice, which is precisely the cost `tension::dev.compile`
    /// exists to avoid. Immutable, `Clone`, and identical for every guest the
    /// process runs — so it is configuration, not per-guest state.
    pub engine: Engine,
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
