//! The host's guest-facing surface, one module per import namespace, plus the
//! per-run and per-guest state those namespaces operate on.
//!
//! `main()` used to register every verb inline — 26 `func_wrap` calls in a
//! 1661-line function — and build the store's state in the same straight line,
//! which made it impossible to stand a second guest up without running the
//! binary's whole setup. This module is that surface, moved out one namespace at
//! a time.
//!
//! **Each `link_*` is a move, not a redesign.** The bodies are byte-identical to
//! what `main()` held; the only change is the signature, which takes the linker
//! and nothing else, because the verbs already read their state through
//! `Caller::data()`.
//!
//! # The three-way split
//!
//! * [`HostConfig`] — values fixed per process **before any store exists**:
//!   argv, the guest path, the engine, the resource paks, the write root, the
//!   capability paths, the test-only session switches. Immutable once
//!   constructed; shared by every guest the process runs.
//! * [`GuestHost`] — the per-guest bundle: the compiled `Module`, the `Store`
//!   (with its `HostState`), the `Linker`, and the `Session` until it is
//!   installed. **Constructible more than once** — that is the whole point, and
//!   it is what nesting needs.
//! * **Singleton** — anything that can only exist once per process. Listed
//!   below, exhaustively, because a per-process resource that `GuestHost::new`
//!   silently duplicates is the failure mode of the next pass rather than this
//!   one.
//!
//! # The singletons, exhaustively
//!
//! Everything on this list is one per process by construction or by contract. A
//! second `GuestHost` must share it, not build another.
//!
//! 1. **The input adapter** — `tension-input/src/adapter.cpp` keeps its state in
//!    a function-local static (`adapter_state()`), capacity one, and registers
//!    **one event layer per process**: a second registration would double every
//!    edge the capability posts, because both layers see the same events
//!    (`adapter.cpp`, the `layer_user` field's comment). It also *consumes* the
//!    motion delta on each `state()` read, so two readers split one delta.
//! 2. **The audio session** — `AudioSession` wraps a cpal `Stream`, which is
//!    `!Send` on ALSA, so it cannot leave its creating thread, let alone be
//!    duplicated; and the session is first-wins for its sample rate and channel
//!    count, with one 32-voice pool.
//! 3. **The host window and its GPU device** — `HostState::host_window` and
//!    `HostState::render2d`. SDL refuses a second GPU claim on one window, and
//!    `Render2dState::claim_swapchain` is an exclusive claim tagged with a
//!    `RendererId`. One window, one device, one swapchain.
//! 4. **The window event bus** — `HostState::control` and `HostState::shared`
//!    (`ControlBus`, `HostShared`). They *are* the one window's queue and
//!    published record, so they are per process even though they currently live
//!    in `HostState`.
//! 5. **The process-wide C ABI services** — `tension_core::init()`, called once
//!    in `main` before anything can load a capability (`shader_generate` answers
//!    from it).
//! 6. **The logger** — `logging::init`, installed once, process-wide. A second
//!    install is refused, not merged.
//! 7. **The AI backend** — `HostState::ai`. Per store today; a second backend
//!    would re-load the model weights. **Whether it is `!Send` was not checked
//!    in this slice**; either way it belongs on this list and Pass 2 decides how
//!    it is shared.
//!
//! Not on the list: the mount table and the write root (in [`HostConfig`], and
//! deliberately *shared* rather than duplicated — two guests reading the same
//! paks is the intent, not a leak), the posting face and the scheduler (genuinely
//! per guest, in `HostState`), and the solver host (wasm-source bindings keyed
//! per store, no process state).
//!
//! # What is still in `main`
//!
//! `tension::platform`, `tension::session`, `tension::scheduler`,
//! `tension::audio`, `tension::ai`, `tension::solver` and the capability
//! adapters. Each needs the loaded module, a DSO that `main` owns, or a singleton
//! above; none is a candidate for a `link_*` that takes only a linker.

pub mod config;
pub mod dev;
pub mod module_cache;
pub mod guest;
pub mod io;
pub mod platform_abi;
pub mod res;
/// `tension::2d`. Named `two_d` because a module cannot be named `2d`; gated
/// because without the in-core renderer the verbs come from the DSO.
#[cfg(feature = "render2d-core")]
pub mod two_d;

pub(crate) use config::HostConfig;
pub(crate) use guest::GuestHost;
pub use dev::link_dev;
pub use io::link_io;
pub use res::link_res;
#[cfg(feature = "render2d-core")]
pub use two_d::link_2d;
