//! TensionCore interpreter
//!
//! `tension-core` is a command-line *interpreter*: it loads a guest `game.wasm`
//! and supplies the `tension::io` host ABI. The guest owns the game logic;
//! the host owns the terminal. That split is what makes it a language runtime
//! rather than a linker: the game compiles *against* the ABI, tension-core
//! *implements* it.
//!
//! Host ABI (module `tension::io`):
//!   print(ptr, len)          write exactly `len` UTF-8 bytes at `ptr` to
//!                            stdout (no newline appended — the SDK owns the
//!                            line terminator)
//!   read_line(ptr, cap)      read one line (terminator stripped):
//!                            cap <= 0 probes the next line's byte length
//!                            without consuming it; cap > 0 consumes the
//!                            line, writes min(cap, len) bytes, and returns
//!                            len. -1 on EOF, 0 for an empty line.
//!   arg_count() -> i32       number of extra CLI args passed to the game
//!   arg(i, ptr, cap) -> i32  write arg i as UTF-8 into buffer, return byte
//!                            count (or -1 if out of range). cap==0 probes size.
//!   log(level, name_ptr, name_len, msg_ptr, msg_len)
//!                            hand one record to the host logger: `level` is a
//!                            tension_log_level_t (0 trace .. 5 fatal), the
//!                            name and message are UTF-8 byte ranges.
//!   log_structured(level, name_ptr, name_len, json_ptr, json_len)
//!                            the same, with a JSON payload in place of the
//!                            message — the layout splices it.
//!
//! The host owns the logger (level, filter, layout, sink); `log` and
//! `log_structured` carry only what the guest knows — a level, a logger name,
//! and a message — and the host applies the one layout, so a guest line is
//! byte-identical to the same record from C or from Rust.
//!
//! Host ABI (module `tension::res`, `tension-res/DESIGN.md` §7):
//!   res_open(path_ptr, path_len) -> fd | -errno
//!   res_close(fd) -> 0 | -errno
//!   res_read(fd, ptr, len) -> n | 0 | -errno
//!   res_seek(fd, off, whence) -> pos | -errno      (whence 0=SET 1=CUR 2=END)
//!   res_tell(fd) -> pos | -errno
//!   res_stat(path_ptr, path_len, out_ptr) -> 0 | -errno
//!   res_stat_fd(fd, out_ptr) -> 0 | -errno
//!   res_readdir(path_ptr, path_len, index, name_ptr, name_cap, out_ptr)
//!       -> name_len | 0 (end) | -errno
//!
//! Paths cross as UTF-8 (ptr, len); `out_ptr` receives the 12-byte
//! {kind, size, flags} record; errors are negative POSIX errno values. Guest
//! fds pack the owning pak's index (each pak has its own fd table, but the
//! guest sees one namespace), so an fd is `(set << 16) | local`.
//!
//! `read_line` is the ABI's first stateful call: a probe parks the pending
//! line in `HostState::pending_line`. Probes are idempotent until the line
//! is consumed (repeated probes return the same length and never advance
//! stdin), and a probed-but-never-consumed line stays buffered for the
//! store's lifetime — there is no discard API. Future host designs
//! (multi-guest, VM resume) must account for per-guest pending-line state.
//!
//! Command line:
//!   tension-core [options] <game.wasm> [game args...]
//!
//! `--debug` turns on guest debug info (`Config::debug_info`) and reports what
//! a debugger can see of the loaded guest; `--symbol-path <PATH>` (repeatable)
//! says where the debugger should look for the guest's symbols and sources.
//! See the `debug` module for why a TensionScript guest carries no source
//! lines even with both.

use std::path::PathBuf;
use tension_core::logging::{self, Config as LogConfig, ConfigError, Level};
use tension_core::platform;
use tension_core::render2d;
use tension_core::res::{self, ResourceSet, Stat};
use wasmtime::{Caller, Config, Engine, ExternType, Memory, Module, Store};

/// The adapter ABI: loading a capability adapter, driving its lifecycle, and
/// installing the imports it registers (`docs/architecture.md` §6). The run
/// path below loads, links, and hands the session what the adapters declared.
mod adapter;
mod ai;
mod audio;
mod scheduler;
mod debug;
mod dwarf;
/// The guest-facing imports, one module per namespace (`host::link_io`,
/// `host::link_res`, and the namespaces still inline in `main` until they
/// move). A sandboxed store links through these instead of through `main`.
mod host;
mod sandbox;
pub(crate) mod leb;
/// The session component: it owns the arena memory the guest imports and the
/// two verbs that open and close a session (`docs/session.md` §2–§7).
mod session;
mod solver;

/// The AI adapter the CLI uses. Feature `ai` selects the real in-process
/// llama.cpp adapter; otherwise the deterministic headless stub (the
/// contract reference and the test adapter).
#[cfg(feature = "ai")]
fn default_ai_adapter(posting: std::sync::Arc<session::posting::PostingSide>) -> Box<dyn ai::AiAdapter> {
    Box::new(ai::llama::LlamaAdapter::new(ai::AiSink::new(posting)))
}

#[cfg(not(feature = "ai"))]
fn default_ai_adapter(posting: std::sync::Arc<session::posting::PostingSide>) -> Box<dyn ai::AiAdapter> {
    Box::new(ai::stub::StubAdapter::new(ai::AiSink::new(posting)))
}

/// The adapter the CLI uses. The default build (feature `audio`) plays
/// through the system device; `--no-default-features` falls back to the
/// headless WAV adapter (the contract reference and test adapter).
#[cfg(feature = "audio")]
fn default_adapter() -> Box<dyn audio::AudioAdapter> {
    Box::new(audio::real::RealAdapter::new())
}

#[cfg(not(feature = "audio"))]
fn default_adapter() -> Box<dyn audio::AudioAdapter> {
    Box::new(audio::headless::HeadlessAdapter::new())
}

/// State stored alongside the Wasm store: the game's CLI arguments, plus the
/// line parked by a `read_line` probe (`cap <= 0`) and not yet consumed.
/// `read_line` is the ABI's only stateful call; see the doc header.
///
/// **`pub(crate)`, fields included**, because the `host` module builds it
/// (`HostState::new`) and every verb moved into `host::*` reads it through
/// `Caller::data()`. It was private to this file while every verb was here; the
/// visibility change is a consequence of the move, not a redesign.
pub(crate) struct HostState {
    pub(crate) args: Vec<String>,
    pub(crate) pending_line: Option<Vec<u8>>,
    /// The mount table: `--res` paks (flat) followed by whatever a guest
    /// mounted, in load order. Each owns its bytes (1x memory) and the guest's
    /// fd space indexes it, so an fd's high bits are a mount index whichever
    /// kind of mount produced it.
    ///
    /// `Arc<Mutex<_>>` because it has two readers: this store (the
    /// `tension::res` verbs) and the adapter host (`res_volume_bytes`, for a
    /// capability that parses the image on a worker thread). The same
    /// arrangement `control` uses, for the same reason — one table, two
    /// consumers, and neither owns it.
    pub(crate) res: std::sync::Arc<std::sync::Mutex<res::MountTable>>,
    /// The one directory a guest may write into, or `None` when the root the
    /// host tried to take could not be resolved (a `--write-root` that does not
    /// exist). `None` makes `res_write` answer `-EROFS` for every path rather
    /// than falling back to something writable: a save that landed somewhere
    /// unexpected is worse than a save that failed and said so.
    pub(crate) write_root: Option<res::WriteRoot>,
    /// The open files a guest holds on the write root, keyed by a local handle.
    ///
    /// Separate from `res` for one reason: a pak's reader is the library's
    /// (a table of contents over mapped bytes) and a real file's is
    /// `std::fs::File`, which owns a cursor. The guest's fd says which table it
    /// belongs to in its high bits (`FD_WRITE_TAG`).
    pub(crate) write_files: std::sync::Arc<std::sync::Mutex<res::WriteFiles>>,
    pub(crate) audio: audio::AudioSession,
    pub(crate) ai: ai::AiSession,
    /// The `tension::solver` host side: wasm-source bindings keyed by the
    /// shim's solver id (solver/mod.rs). Per store, like everything here.
    pub(crate) solver: solver::SolverHost,
    /// The posting face: the queues an adapter thread writes into through
    /// `post_event`, and the source of what the epoch publishes (`docs/session.md`
    /// §3–§5). Shared with the adapter host by `Arc`, and separate from
    /// `session` on purpose: the verbs take the session out of the store for
    /// the duration of a call, and the epoch will need this while they have it.
    /// The arena memory, reachable without the session. The epoch runs *inside*
    /// a verb, and the verbs take the session out of the store — so `guest_write`
    /// and the epoch's own arena writes look here, not through `session`.
    pub(crate) arena: Option<Memory>,
    /// How deep the session is inside callback invocations. Host-side, not in
    /// the arena: it is the re-entrancy guard a callback's `session_wait` hits
    /// (`docs/session.md` §7), and a guest that writes the arena cannot clear it.
    pub(crate) depth: u32,
    /// Deferred submissions: what a `queue_*` verb copied out of a callback, and
    /// what the next epoch's apply phase drains. Host-side, never in the arena,
    /// and never cleared by a trap (R7) — a fault leaves the work where it is.
    pub(crate) pending: session::apply::PendingQueue,
    /// The window-control queue: what a layer posts through `post_control`,
    /// what the guest posts through `tension::platform.control`, and what the
    /// host loop drains once per frame. Shared with `AdapterHost` by `Arc`.
    pub(crate) control: std::sync::Arc<platform::ControlBus>,
    /// The event dispatcher and the published window record (ABI v7). Shared
    /// with `AdapterHost` by `Arc`, and with the window, which dispatches from
    /// inside `pump` — the one place events are drained, reached from both the
    /// host loop and the 2D renderer's present.
    ///
    /// Built before anything can register a layer, because a capability's
    /// `link` is where registration happens and `link` runs before the guest
    /// can create a window.
    pub(crate) shared: std::sync::Arc<platform::HostShared>,
    /// The in-core 2D renderer: GPU device, the one canvas, and who holds the
    /// swapchain.
    ///
    /// Here rather than beside the store because every 2D verb is a `func_wrap`
    /// that reaches `caller.data_mut()`, and because the window it claims is the
    /// field below — the two have to be borrowable together, which is what one
    /// struct gives and two do not.
    ///
    /// **Declared before `host_window` on purpose: field order is drop order.**
    /// The GPU device holds a claim on that window, so the device must be gone
    /// before the `SDL_Window` is. `main`'s teardown takes the window out first,
    /// and this ordering is what makes a path that skips teardown — a panic, a
    /// future early return — still correct rather than a use-after-free.
    pub(crate) render2d: render2d::Render2dState,
    /// The host-owned window, when the guest asked for one (`create_window`).
    ///
    /// Lives in the store rather than beside it because `host_loop` needs to
    /// pump it once per iteration and has no other way to reach it. Dropped
    /// after `teardown_adapters`, so no adapter can hold a handle into a dead
    /// instance.
    ///
    /// Created **on demand and only on demand**: by the guest's
    /// `tension::platform.create_window`, or by a 2D canvas opening windowed
    /// (`render2d::device::Render2dState::open_windowed`, which goes through the
    /// same call). There is no startup window and no flag that makes one, so a
    /// run with no windowed renderer and no `create_window` never opens SDL's
    /// video subsystem at all.
    pub(crate) host_window: Option<platform::HostWindow>,
    /// The cell `host_surface` serves from, shared with `AdapterHost` by `Arc`.
    ///
    /// **Why it is here and not only in `AdapterHost`.** Before the programmatic
    /// window API, `main` created the window before any adapter loaded and
    /// published the surface once, so the cell could live in the adapter host
    /// alone. Now the window is created by a *guest call*, halfway through the
    /// run, and the guest thread is the one that must publish — so the store
    /// holds a handle to the same cell the adapters read. `None` until the
    /// adapter host is built (a run with no capability never needs it).
    pub(crate) host_surface: Option<std::sync::Arc<std::sync::Mutex<Option<adapter::PublishedSurface>>>>,
    /// Set by the pump when the user closes the window. The loop breaks on it,
    /// the same way it breaks when the guest closes its session.
    pub(crate) window_closed: bool,
    /// The loaded adapters, in registration order: what the epoch's publish
    /// phase calls, and in what order (`docs/session.md` §3).
    pub(crate) adapters: Vec<adapter::AdapterCall>,
    pub(crate) posting: std::sync::Arc<session::posting::PostingSide>,
    /// The scheduler's host half (0.7.0a-pre0): the park tables `scheduler::park`
    /// writes and the epoch's completion path will read. Bounded, per family,
    /// and — at pre0 — recorded but unread.
    pub(crate) scheduler: scheduler::Scheduler,
    /// The guest's `__taskWake(idsPtr, count)`, resolved after instantiation
    /// when the module exports it (std 0.6.0 and later). `None` for a guest
    /// that has no push path — the pull path still delivers those.
    ///
    /// **Resolved eagerly, called never (at pre0).** Resolving costs one table
    /// lookup after instantiation; resolving lazily at the first wake would put
    /// a lookup on the completion path and make a missing export a runtime
    /// surprise rather than a startup fact.
    pub(crate) task_wake: Option<wasmtime::TypedFunc<(i32, i32), ()>>,
    /// The guest's `__taskFail(idsPtr, statusesPtr, count)`: resume a task with
    /// a status and no payload — §4.4's lost completion and §5.1's refused park.
    /// `None` for a guest built before std 0.6.1, which has no such export; the
    /// host then has no way to fail a task, and says so rather than parking it.
    pub(crate) task_fail: Option<wasmtime::TypedFunc<(i32, i32, i32), ()>>,
    /// Per-class drop totals already attributed (0.7.0c). The posting queues'
    /// counters are cumulative, so the host keeps its own baseline: a drop is
    /// the *delta* since the last iteration, and without this every iteration
    /// after the first would re-wake the same victims.
    pub(crate) drop_seen: [u64; session::arena::CLASS_COUNT],
    /// Tasks the epoch matched, or the park found already completed, waiting to
    /// be resumed. Drained by the host loop; empty for every pre-adoption
    /// guest, because nothing parked.
    pub(crate) wake_batch: Vec<scheduler::Wake>,
    /// The guest's `__taskResume(idsPtr, classesPtr, payloadsPtr, count)`: resume
    /// with the delivered class and payload (std 0.6.1). Preferred over
    /// `__taskWake`, which resumes with whatever the record already holds.
    pub(crate) task_resume: Option<wasmtime::TypedFunc<(i32, i32, i32, i32), ()>>,
    /// The guest's `_game_running()`: 1 while the guest still wants frames.
    /// `None` means the guest has not adopted the host-owned loop, which is
    /// every example until 0.7.0b — so the loop must not start for it.
    pub(crate) game_running: Option<wasmtime::TypedFunc<(), i32>>,
    /// The session: it owns the arena memory and the open/close verbs.
    ///
    /// `Option` because the memory can only be created *from* a store, and this
    /// struct is what that store is built with — the session is created right
    /// after the store and installed before instantiation, once. A verb that
    /// finds it `None` returns `-EBADF` rather than panicking.
    pub(crate) session: Option<session::Session>,
    /// Where a sandboxed guest's `tension::io.print` goes, or `None` to write to
    /// the terminal as every non-sandboxed run does.
    ///
    /// **Capture rather than a callback** because the host has to read the
    /// output synchronously, right after the guest's entrypoint returns, and
    /// because Pass 3's `tension::dev.out` is exactly this buffer handed to the
    /// outer guest. A sandboxed guest that printed to the terminal would
    /// interleave with the editor's own output, which is the one thing a
    /// nested run must not do.
    pub(crate) captured_out: Option<Vec<u8>>,
    /// The linear-memory ceiling a sandboxed guest runs under, as the store's
    /// `ResourceLimiter`. Unlimited for the process's own guest: it is not
    /// sandboxed, and a budget nobody asked for would be a policy, not a bound.
    pub(crate) memory_budget: sandbox::MemoryBudget,
    /// How deep this guest sits: 0 for the process's own, `d + 1` for a guest it
    /// started. Distinct from `depth`, which counts session callback re-entry
    /// inside one guest — two different nesting stories that happen to share a
    /// word.
    pub(crate) guest_depth: u32,
    /// The rectangle a **nested** guest may draw into, as `dev.run` was told it:
    /// the outer guest's viewport, origin (0,0).
    ///
    /// `None` for the process's own guest, which draws into the window and asks
    /// the window for its size. This is what `tension::platform.surface_width`
    /// and `window_info` answer with for a nested guest — the viewport, not the
    /// window, because the record's one `w`/`h` is both the dest rect and the
    /// source texel rect, so the size has to be the one the records are drawn at.
    pub(crate) nested_viewport: Option<(u32, u32)>,
    /// The runs this guest has started, keyed by the id `dev.run` returned.
    ///
    /// **A map rather than one slot**, because two runs must coexist: the editor
    /// can restart a game before the previous run's output has been read, and a
    /// single slot would either refuse the second or throw the first away.
    ///
    /// The table lives here rather than beside the sandbox module because its
    /// owner is the *guest* that called `dev.run` — a nested guest that starts
    /// its own runs gets its own table, one level down.
    pub(crate) runs: std::collections::HashMap<i32, sandbox::GuestRun>,
    /// The next run id. Starts at 1 so that 0 is never a valid handle and an
    /// uninitialised variable cannot look like one.
    pub(crate) next_run_id: i32,
    /// The engine, for a verb that has to stand a guest up.
    ///
    /// A `Clone` handle to the same engine the config holds — not a second
    /// engine, which would be a second compiled-code cache. `dev.run` needs it
    /// because a verb's only context is `Caller::data()`.
    pub(crate) engine: wasmtime::Engine,
    /// The process's compiled-module cache, same reason and same `Arc`.
    pub(crate) module_cache: std::sync::Arc<host::module_cache::ModuleCache>,
}

impl HostState {
    /// The per-guest state payload, built from the run's configuration.
    ///
    /// **Everything here is either this guest's or a singleton.** The fields
    /// taken from `config` are per guest (argv, the mount table handle, the
    /// write root); the ones built inline are the singletons `host/mod.rs`
    /// lists — the audio device, the AI backend, the window event bus. They are
    /// constructed here because `HostState` is where the verbs reach them, and
    /// that is the F1 constraint rather than an endorsement: a second guest must
    /// share them, and today it would build a second.
    ///
    /// `render2d` defaults to "no device, no canvas" whether or not the feature
    /// is on: with it off nothing reads the field, and leaving it out behind a
    /// `cfg` would make the struct two shapes for no benefit.
    pub(crate) fn new(
        config: &crate::host::HostConfig,
        posting: std::sync::Arc<session::posting::PostingSide>,
    ) -> Self {
        Self::build(config, posting, false)
    }

    /// The same state, built for a **sandboxed** guest.
    ///
    /// Three differences, and each is the singleton list in `host/mod.rs` rather
    /// than a preference:
    ///
    /// * **No audio device.** A cpal `Stream` is `!Send` on ALSA and the session
    ///   is first-wins for its format. A nested guest gets the silent adapter:
    ///   the guest's audio verbs succeed, nothing is heard, and no file is
    ///   written. Refusing `audio_init` instead would make Play Mode unable to
    ///   run a game that uses sound.
    /// * **No AI backend.** The stub adapter answers with the contract's
    ///   refusals; a second real backend would re-load the model weights.
    /// * **A capture-mode renderer.** `Render2dState::capture()` opens no GPU
    ///   device; the device and the window belong to the outer guest.
    ///
    /// Plus the two things a sandbox needs: a captured-output sink and a default
    /// (unlimited) budget, which `Sandbox::open` then sets.
    pub(crate) fn new_nested(
        config: &crate::host::HostConfig,
        posting: std::sync::Arc<session::posting::PostingSide>,
    ) -> Self {
        Self::build(config, posting, true)
    }

    fn build(
        config: &crate::host::HostConfig,
        posting: std::sync::Arc<session::posting::PostingSide>,
        nested: bool,
    ) -> Self {
        let audio = if nested {
            audio::AudioSession::new(Box::new(audio::silent::SilentAdapter::new()))
        } else {
            audio::AudioSession::new(default_adapter())
        };
        let ai = if nested {
            ai::AiSession::new(Box::new(ai::stub::StubAdapter::new(ai::AiSink::new(
                std::sync::Arc::clone(&posting),
            ))))
        } else {
            ai::AiSession::new(default_ai_adapter(std::sync::Arc::clone(&posting)))
        };
        HostState {
            args: config.args.clone(),
            pending_line: None,
            res: std::sync::Arc::clone(&config.res),
            write_root: config.write_root.clone(),
            write_files: std::sync::Arc::new(std::sync::Mutex::new(res::WriteFiles::new())),
            audio,
            ai,
            solver: solver::SolverHost::default(),
            posting,
            scheduler: scheduler::Scheduler::new(),
            wake_batch: Vec::new(),
            task_wake: None,
            task_resume: None,
            task_fail: None,
            drop_seen: [0; session::arena::CLASS_COUNT],
            game_running: None,
            arena: None,
            depth: 0,
            pending: session::apply::PendingQueue::new(),
            control: std::sync::Arc::new(tension_core::platform::ControlBus::new()),
            shared: tension_core::platform::HostShared::new(),
            host_window: None,
            host_surface: None,
            render2d: if nested {
                render2d::Render2dState::capture()
            } else {
                Default::default()
            },
            window_closed: false,
            adapters: Vec::new(),
            session: None,
            captured_out: if nested { Some(Vec::new()) } else { None },
            memory_budget: sandbox::MemoryBudget::default(),
            // A nested guest's depth is set by whoever opened it; the value here
            // is the root's, and `Sandbox::open` overwrites it for a sandbox.
            guest_depth: 0,
            nested_viewport: None,
            runs: std::collections::HashMap::new(),
            next_run_id: 1,
            engine: config.engine.clone(),
            module_cache: std::sync::Arc::clone(&config.module_cache),
        }
    }
}

/// Guest fds are `(pak index << 16) | that pak's fd`, so a guest handle stays
/// unambiguous even though every `ResourceSet` numbers its own handles from 1.
const FD_SET_SHIFT: i32 = 16;
const FD_LOCAL_MASK: i32 = 0xFFFF;
/// The mount-index value that means "this fd is a **write-root file**".
///
/// The high half of a guest fd is a 16-bit mount index, and `--res` paks are
/// numbered from zero, so the top value is free: no table can hold 32,767
/// mounts, and `MountTable::get` would answer `None` for it anyway. Reserving it
/// is what lets one fd space hold both kinds, which is what makes the fallback
/// in `res_open` invisible to a guest.
const FD_WRITE_TAG: i32 = 0x7FFF;

const ENOENT: i32 = -2;
const EBADF: i32 = -9;
const EINVAL: i32 = -22;

/// Read a TensionScript `String` (UTF-16LE data at `ptr`, `rtSize` at `ptr-4`)
/// out of the guest memory and decode it to a Rust `String`.
fn read_as_string(caller: &mut Caller<'_, HostState>, ptr: i32) -> String {
    if ptr == 0 {
        return String::new();
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return String::new();
    };
    let data = mem.data(&*caller);
    let p = (ptr as u32) as usize;
    let rt_size = match p.checked_sub(4) {
        Some(h) if h.saturating_add(4) <= data.len() => {
            u32::from_le_bytes(data[h..h + 4].try_into().unwrap_or([0; 4]))
        }
        _ => 0,
    };
    let chars = (rt_size as usize) / 2;
    let u16_iter = (0..chars).filter_map(|i| {
        let off = p.saturating_add(i * 2);
        if off.saturating_add(2) <= data.len() {
            Some(u16::from_le_bytes([data[off], data[off + 1]]))
        } else {
            None
        }
    });
    char::decode_utf16(u16_iter)
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

const PACK_USAGE: &str = r#"usage: tension-core pack <source-dir> [-o output.pak]

Pack a directory tree into an ECMA-208 (SIDF) resource pak. The default output
path is <source-dir>.pak. The layout is documented in tension-res/DESIGN.md
§8.2; packing the same tree twice produces byte-identical output."#;

const USAGE: &str = r#"usage: tension-core [options] <game.wasm> [game args...]
       tension-core pack <source-dir> [-o output.pak]

options:
  --debug                turn on guest debug info (`Config::debug_info`) and report
                         what a debugger can see of the loaded guest
  --symbol-path <PATH>   where the debugger should look for the guest's symbols
                         and sources; repeatable
  --res <PAK>            load an ECMA-208 resource pak; repeatable, and every
                         pak merges into one namespace rooted at "/"
  --write-root <DIR>     the one directory `tension::res.res_write` may write
                         into; the guest's paths resolve inside it and anything
                         that would leave is -EROFS. Defaults to the working
                         directory. Reads never see this root: paks stay the
                         read side, and a save lands on the real filesystem.
  --capability <CAP>     load a capability adapter; repeatable. A value that
                         names an existing file is that file; anything else is
                         a name resolved as <dir>/libtension_<name>.so through
                         TENSION_CAPABILITY_PATH (colon-separated directories)
  --log-level <SPEC>     the log threshold: a bare LEVEL sets the default, and
                         NAME:LEVEL sets one logger (repeatable; a later flag
                         wins). LEVEL is trace|debug|info|warn|error|fatal|off.
                         e.g. --log-level=ai:debug,ogre:warn. Env fallback:
                         TENSION_LOG_LEVEL
  --log-format <FORMAT>  text (default, human-readable) or json (one jq-parsable
                         object per line). Env fallback: TENSION_LOG_FORMAT
  --log-file <PATH>      append log lines to PATH instead of stderr. Env
                         fallback: TENSION_LOG_FILE
  --session-open         A1 test-only: open the session from the host before
                         `_start_game`, for a guest that does not call
                         `session_open` itself. Real guests open their own
                         session; this flag exists so an A1 fixture needs no
                         config blob, and it will go when the guest SDK lands
  --session-callbacks <BATCH>[,<EVENT>]
                         A2 test-only: like --session-open, and also register
                         the guest function table's slot BATCH as `onBatch` (and
                         EVENT as `onEvent`). 0 or an absent value means "no
                         callback for that slot"
  --post-test-events     A2 test-only: post three JOB_DONE events before
                         `_start_game`, so an epoch fixture has something to
                         deliver
  -h, --help             print this help
  -V, --version          print the version
  --                     end options: the next argument is <game.wasm>

Options must precede <game.wasm>; everything after it is passed to the game
verbatim (that is what the guest's `tension::io arg()` hands back)."#;

/// The parsed `pack` subcommand.
#[derive(Debug, PartialEq, Eq)]
struct PackCli {
    source: PathBuf,
    out: PathBuf,
}

/// Parse the arguments of `tension-core pack` (everything after `pack`).
fn parse_pack_cli(argv: Vec<String>) -> Result<PackCli, String> {
    let mut source = None;
    let mut out = None;
    let mut rest = argv.into_iter();
    while let Some(arg) = rest.next() {
        if let Some(value) = arg.strip_prefix("--out=").or_else(|| arg.strip_prefix("-o=")) {
            out = Some(PathBuf::from(value));
            continue;
        }
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{PACK_USAGE}");
                std::process::exit(0);
            }
            "-o" | "--out" => {
                out = Some(PathBuf::from(rest.next().ok_or("`-o` needs a path")?));
            }
            other if other.len() > 1 && other.starts_with('-') => {
                return Err(format!("unknown option `{other}`"));
            }
            other => {
                if source.is_some() {
                    return Err("only one source directory is packed at a time".to_string());
                }
                source = Some(PathBuf::from(other));
            }
        }
    }
    let source: PathBuf = source.ok_or("missing <source-dir>")?;
    let out = out.unwrap_or_else(|| PathBuf::from(format!("{}.tns", source.display())));
    Ok(PackCli { source, out })
}

/// The `pack` subcommand. Routes through the C ABI, never around it.
fn run_pack(cli: PackCli) -> anyhow::Result<()> {
    match tension_core::res::pack(&cli.source, &cli.out) {
        Ok(message) => {
            let detail = if message.is_empty() {
                String::new()
            } else {
                format!(" ({message})")
            };
            println!("packed {} -> {}{detail}", cli.source.display(), cli.out.display());
            Ok(())
        }
        Err(e) => {
            eprintln!("tension-core pack: {e}");
            std::process::exit(1);
        }
    }
}

/// The parsed command line. See `USAGE` for the contract.
#[derive(Debug)]
struct Cli {
    debug: bool,
    symbol_paths: Vec<PathBuf>,
    res_paths: Vec<PathBuf>,
    /// Capability adapters to load: a path, or a bare name resolved through
    /// `TENSION_CAPABILITY_PATH` (the CLI's `--capability` help states the rule).
    capability_paths: Vec<String>,
    /// The directory `res_write` may write into; `None` means the working
    /// directory, resolved once at startup.
    write_root: Option<PathBuf>,
    /// `--log-level` values, in order. A later flag overrides an earlier one.
    log_levels: Vec<String>,
    /// `--log-format`.
    log_format: Option<String>,
    /// `--log-file`.
    log_file: Option<PathBuf>,
    /// A1 test-only: open the session from the host before `_start_game`.
    session_open: bool,
    /// A2 test-only: open with these table slots registered as callbacks.
    /// `Some` implies the host open, because a host-registered callback has no
    /// other way to reach the session.
    session_callbacks: Option<(u32, u32)>,
    /// A2 test-only: post three JOB_DONE events before `_start_game`.
    post_test_events: bool,
    wasm_path: String,
    args: Vec<String>,
}

/// Parse the arguments that follow the program name.
///
/// The first non-option argument is the guest; everything from there on belongs
/// to the game, so a game argument that happens to read `--debug` is still the
/// game's. Options are only recognised ahead of the guest path.
fn parse_cli(argv: Vec<String>) -> Result<Cli, String> {
    let mut debug = false;
    let mut symbol_paths = Vec::new();
    let mut res_paths = Vec::new();
    let mut capability_paths = Vec::new();
    let mut write_root: Option<PathBuf> = None;
    let mut log_levels = Vec::new();
    let mut log_format: Option<String> = None;
    let mut log_file: Option<PathBuf> = None;
    let mut session_open = false;
    let mut session_callbacks: Option<(u32, u32)> = None;
    let mut post_test_events = false;
    let mut wasm_path = None;
    let mut rest = argv.into_iter();
    while wasm_path.is_none() {
        let Some(arg) = rest.next() else { break };
        if let Some(value) = arg.strip_prefix("--symbol-path=") {
            symbol_paths.push(PathBuf::from(value));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--res=") {
            res_paths.push(PathBuf::from(value));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--capability=") {
            capability_paths.push(value.to_string());
            continue;
        }
        if let Some(value) = arg.strip_prefix("--log-level=") {
            log_levels.push(value.to_string());
            continue;
        }
        if let Some(value) = arg.strip_prefix("--log-format=") {
            log_format = Some(value.to_string());
            continue;
        }
        if let Some(value) = arg.strip_prefix("--log-file=") {
            log_file = Some(PathBuf::from(value));
            continue;
        }
        if let Some(value) = arg.strip_prefix("--session-callbacks=") {
            session_callbacks = Some(parse_callback_slots(value)?);
            continue;
        }
        match arg.as_str() {
            "--debug" => debug = true,
            "--session-open" => session_open = true,
            "--post-test-events" => post_test_events = true,
            "--session-callbacks" => {
                let value = rest
                    .next()
                    .ok_or("`--session-callbacks` needs a table slot (or two)")?;
                session_callbacks = Some(parse_callback_slots(&value)?);
            }
            "--symbol-path" => {
                let value = rest.next().ok_or("`--symbol-path` needs a path")?;
                symbol_paths.push(PathBuf::from(value));
            }
            "--res" => {
                let value = rest.next().ok_or("`--res` needs a pak path")?;
                res_paths.push(PathBuf::from(value));
            }
            "--write-root" => {
                let value = rest.next().ok_or("`--write-root` needs a directory")?;
                write_root = Some(PathBuf::from(value));
            }
            "--capability" => {
                let value = rest.next().ok_or("`--capability` needs a path or a name")?;
                capability_paths.push(value);
            }
            "--log-level" => {
                let value = rest.next().ok_or("`--log-level` needs a spec")?;
                log_levels.push(value);
            }
            "--log-format" => {
                let value = rest.next().ok_or("`--log-format` needs `text` or `json`")?;
                log_format = Some(value);
            }
            "--log-file" => {
                let value = rest.next().ok_or("`--log-file` needs a path")?;
                log_file = Some(PathBuf::from(value));
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "-V" | "--version" => {
                println!("tension-core {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--" => wasm_path = rest.next(),
            // A lone `-` is taken as a path; anything longer that starts with a
            // dash is a typo, and must not be handed to the loader as a file.
            other if other.len() > 1 && other.starts_with('-') => {
                return Err(format!("unknown option `{other}`"));
            }
            other => wasm_path = Some(other.to_string()),
        }
    }
    let wasm_path = wasm_path.ok_or("missing <game.wasm>")?;
    Ok(Cli {
        debug,
        symbol_paths,
        res_paths,
        capability_paths,
        write_root,
        log_levels,
        log_format,
        log_file,
        session_open,
        session_callbacks,
        post_test_events,
        wasm_path,
        args: rest.collect(),
    })
}

/// Build the logger's config: environment first, then the CLI on top, so
/// **CLI beats the environment beats the defaults** (`info`, `text`, stderr).
///
/// The flags are merged rather than replaced: a `--log-level` naming one logger
/// does not discard an environment variable that named another.
fn build_log_config(cli: &Cli) -> Result<LogConfig, ConfigError> {
    let mut config = LogConfig::default();

    if let Ok(value) = std::env::var("TENSION_LOG_LEVEL") {
        config.set_level_spec(&value)?;
    }
    if let Ok(value) = std::env::var("TENSION_LOG_FORMAT") {
        config.set_format(&value)?;
    }
    if let Ok(value) = std::env::var("TENSION_LOG_FILE") {
        config.set_file(PathBuf::from(value));
    }

    for spec in &cli.log_levels {
        config.set_level_spec(spec)?;
    }
    if let Some(format) = &cli.log_format {
        config.set_format(format)?;
    }
    if let Some(path) = &cli.log_file {
        config.set_file(path.clone());
    }

    Ok(config)
}

/// The `graph` subcommand.
///
/// One action today: `emit-default --out <dir>` writes the `default_2d` blob,
/// the GLSL both lowerings produce for it, and the comparator's key table. The
/// build script (`scripts/build-2d.mjs`) runs this, compiles the GLSL, and
/// embeds the result — so the adapter carries a compiled graph rather than a
/// second hand-written copy of one.
///
/// It is also the inspection tool: `tension-core graph emit-default --out /tmp`
/// is how a reviewer reads what the graph actually says.
const GRAPH_USAGE: &str = "\
usage: tension-core graph emit-default --out <dir>

  compile <blob> --out <dir>  compiles one blob to vs.spv/fs.spv
  Writes default_2d.t2dg (the wire blob), default_2d.graph.vert and
  default_2d.graph.frag (the GLSL both lowerings produce), and
  default_2d.keys.txt (the comparator's key table).";

fn run_graph(argv: Vec<String>) -> anyhow::Result<()> {
    if argv.first().map(|a| a == "emit-default").unwrap_or(false) {
        let mut out = std::path::PathBuf::from(".");
        let mut i = 1;
        while i < argv.len() {
            match argv[i].as_str() {
                "--out" => {
                    i += 1;
                    let Some(value) = argv.get(i) else {
                        anyhow::bail!("--out needs a directory\n\n{GRAPH_USAGE}");
                    };
                    out = std::path::PathBuf::from(value);
                }
                other => anyhow::bail!("unknown argument `{other}`\n\n{GRAPH_USAGE}"),
            }
            i += 1;
        }
        std::fs::create_dir_all(&out)?;

        // Both graphs, through the same path: parse, validate, lower. Emitting
        // them from one loop is what makes the built-in preset and the second
        // pipeline the same kind of thing to the build.
        for (name, blob) in [
            ("default_2d", tension_core::pipeline_default::serialize_default_2d()),
            ("default_2d_scaled", tension_core::pipeline_default::serialize_default_2d_scaled()),
        ] {
            let graph = tension_core::pipeline::parser::parse(&blob)
                .map_err(|e| anyhow::anyhow!("{name}: the serializer's own output failed to parse: {e}"))?;
            tension_core::pipeline::validate::validate(&graph).map_err(|e| anyhow::anyhow!("{name}: {e}"))?;

            let stage = &graph.stages[0];
            let lowered = tension_core::pipeline::glsl_backend::lower(&graph, stage)
                .map_err(|e| anyhow::anyhow!("{name}: {e}"))?;
            let keys = tension_core::pipeline::glsl_backend::sort_keys(&graph, stage)
                .map_err(|e| anyhow::anyhow!("{name}: {e}"))?;

            std::fs::write(out.join(format!("{name}.t2dg")), &blob)?;
            std::fs::write(out.join(format!("{name}.graph.vert")), &lowered.vertex)?;
            std::fs::write(out.join(format!("{name}.graph.frag")), &lowered.fragment)?;

            let mut table = String::new();
            for key in &keys {
                // `offset dtype scale`: the scale is what a `mul` key adds, and
                // 1.0 for every key a plain `load_field` produces.
                table.push_str(&format!("{} {} {}\n", key.offset, key.dtype.to_wire(), key.scale.unwrap_or(1.0)));
            }
            std::fs::write(out.join(format!("{name}.keys.txt")), table)?;

            println!("{name}: {} bytes, hash 0x{:016x}", blob.len(), tension_core::pipeline::Graph::hash(&blob));
        }
        return Ok(());
    }
    if argv.first().map(|a| a == "emit-scaled").unwrap_or(false) {
        // `graph emit-scaled --factor F --out FILE`: the scaled graph at any
        // factor. The runtime-compilation test needs 1.5, which is not a
        // shipped pipeline and therefore has to be compiled at run time.
        let mut factor = 2.0f32;
        let mut out = std::path::PathBuf::from("default_2d_scaled_custom.t2dg");
        let mut i = 1;
        while i < argv.len() {
            match argv[i].as_str() {
                "--factor" => {
                    i += 1;
                    factor = argv.get(i).and_then(|v| v.parse().ok()).unwrap_or(2.0);
                }
                "--out" => {
                    i += 1;
                    out = std::path::PathBuf::from(argv.get(i).cloned().unwrap_or_default());
                }
                _ => {}
            }
            i += 1;
        }
        let blob = tension_core::pipeline_default::serialize(
            &tension_core::pipeline_default::scaled_graph_with(factor),
        );
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&out, &blob)?;
        println!("{} bytes  hash 0x{:016x}", blob.len(), tension_core::pipeline::Graph::hash(&blob));
        return Ok(());
    }
    if argv.first().map(|a| a == "compile").unwrap_or(false) {
        // `graph compile <blob> --out <dir>`: the runtime compiler as a tool.
        // The 2D stub core calls this to stand in for the host's
        // `compile_graph` slot, and a human uses it to see what a blob turns
        // into without a GPU.
        let mut blob_path = None;
        let mut out = std::path::PathBuf::from(".");
        let mut i = 1;
        while i < argv.len() {
            match argv[i].as_str() {
                "--out" => {
                    i += 1;
                    out = std::path::PathBuf::from(argv.get(i).cloned().unwrap_or_default());
                }
                other => blob_path = Some(std::path::PathBuf::from(other)),
            }
            i += 1;
        }
        let Some(blob_path) = blob_path else {
            anyhow::bail!("graph compile needs a blob path\n\n{GRAPH_USAGE}");
        };
        let blob = std::fs::read(&blob_path)?;
        let started = std::time::Instant::now();
        // Distinct exit codes, because the 2D stub core maps them back to
        // errnos and a flattened "something failed" would make the adapter's
        // -EINVAL/-ENOSYS distinction untestable.
        //   2 -> the blob is malformed or invalid  (-EINVAL)
        //   3 -> the graph is valid but unsupported (-ENOSYS)
        let compiled = match tension_core::pipeline::naga_backend::compile(&blob) {
            Ok(compiled) => compiled,
            Err(error) => {
                eprintln!("graph compile: {error}");
                let code = match error {
                    tension_core::pipeline::GraphError::Malformed(_)
                    | tension_core::pipeline::GraphError::Invalid(_) => 2,
                    tension_core::pipeline::GraphError::Unsupported(_) => 3,
                };
                std::process::exit(code);
            }
        };
        let elapsed = started.elapsed();
        std::fs::create_dir_all(&out)?;
        std::fs::write(out.join("vs.spv"), compiled.vertex_bytes())?;
        std::fs::write(out.join("fs.spv"), compiled.fragment_bytes())?;
        eprintln!(
            "compiled {} in {:.3} ms (vs {} B, fs {} B)",
            blob_path.display(),
            elapsed.as_secs_f64() * 1e3,
            compiled.vertex.len() * 4,
            compiled.fragment.len() * 4
        );
        return Ok(());
    }
    anyhow::bail!("{GRAPH_USAGE}")
}

fn main() -> anyhow::Result<()> {
    // Install the process-wide services the C ABI exposes. Registered before
    // any adapter can load, so `shader_generate` answers with the default
    // generator rather than `-ENOSYS` for a preset it should serve.
    tension_core::init();
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(|a| a == "pack").unwrap_or(false) {
        argv.remove(0);
        let cli = match parse_pack_cli(argv) {
            Ok(cli) => cli,
            Err(err) => {
                eprintln!("tension-core: {err}\n\n{PACK_USAGE}");
                std::process::exit(2);
            }
        };
        return run_pack(cli);
    }
    if argv.first().map(|a| a == "graph").unwrap_or(false) {
        argv.remove(0);
        return run_graph(argv);
    }
    if argv.first().map(|a| a == "layout-hash").unwrap_or(false) {
        // The arena's shape hash, for the AS build pipeline: `session.json` and
        // the generated `layout.ts` carry it, and this is where it comes from
        // (`tension-framework/build.sh --hash`, which refuses a disagreement).
        println!("{}", session::arena::layout_hash());
        return Ok(());
    }
    let cli = match parse_cli(argv) {
        Ok(cli) => cli,
        Err(err) => {
            eprintln!("tension-core: {err}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    // A path that does not exist is a typo the debugger would otherwise report
    // only as a breakpoint that never resolves, so it fails here instead.
    for path in &cli.symbol_paths {
        if !path.exists() {
            eprintln!(
                "tension-core: --symbol-path {} does not exist\n\n{USAGE}",
                path.display()
            );
            std::process::exit(2);
        }
    }
    if !std::path::Path::new(&cli.wasm_path).exists() {
        eprintln!(
            "tension-core: {} does not exist\n\n{USAGE}",
            cli.wasm_path
        );
        std::process::exit(2);
    }

    // Logging is installed first — before the debug report, the session, the
    // linker, and every adapter — so a line the host or an adapter emits from
    // here on goes through one layout. A bad `--log-file` or a malformed
    // `--log-level` is a usage error and exits like the other flag refusals.
    let log_config = match build_log_config(&cli) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("tension-core: {err}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(err) = tension_core::logging::init(log_config) {
        eprintln!("tension-core: {err}\n\n{USAGE}");
        std::process::exit(2);
    }

    // `--debug` is the whole host-side switch; see `debug` for what it can and
    // cannot buy. The report runs before the load so a guest that fails to load
    // still shows what was being asked of it.
    //
    // The host does not augment the guest. It asks whether the compiler already
    // emitted DWARF and, if not, says so; the bytes handed to wasmtime are the
    // bytes on disk. Anything else would be the host guessing at a debuggee
    // that its own producer describes better.
    if cli.debug {
        let guest = std::path::Path::new(&cli.wasm_path);
        let info = debug::probe(guest);
        debug::report(guest, &info, &cli.symbol_paths);
        // The report above already says whether the guest carries DWARF, and
        // says what to do when it does not. This adds the one thing the report
        // cannot: a log record for the pass-through, since "the host did
        // nothing" is exactly the case a reader of the log would wonder about.
        if info.dwarf {
            logging::log(Level::Info, "core", "debug: guest already carries DWARF; leaving it alone");
        }
    }

    // With this on, wasmtime keeps the guest's DWARF and registers the JIT'd
    // code with the platform debugger through the GDB JIT interface — which is
    // what lldb's `plugin.jit-loader.gdb.enable on` picks up. Registration
    // happens as the module is compiled, before `_start_game` runs, so a
    // debugger that launches this process can have breakpoints in place first.
    // The engine is built once, from the engine configuration, and moves into
    // the config: it owns the compiled-code cache, and every guest this process
    // runs shares it (see `host::HostConfig`).
    let mut engine_config = Config::new();
    engine_config.debug_info(cli.debug);
    // **Epoch interruption, for the sandbox's watchdog.** It is an engine-level
    // switch: wasm compiled by this engine carries deadline checks that a
    // watchdog thread's `increment_epoch` can reach, which is what makes an
    // infinite nested guest stoppable at all. A store that does not set a
    // deadline traps immediately, so every store built here sets one —
    // `GuestHost::new` gives the process's own guest `u64::MAX` (never fires) and
    // `Sandbox::open` gives a nested guest a real one.
    //
    // A few instructions per loop iteration is the cost, paid by every guest.
    // That is the price of being able to stop one, and it is the only mechanism
    // wasmtime offers that a guest cannot opt out of.
    engine_config.epoch_interruption(true);
    let engine = Engine::new(&engine_config)?;

    // Resource paks: loaded and validated before the guest runs, so a bad path
    // or a malformed volume is reported here rather than as a mysterious miss
    // at runtime. `load_file` keeps one copy of each pak
    // (`tension-res/DESIGN.md` §9.2).
    let mut resource_sets = res::MountTable::new();
    for path in &cli.res_paths {
        let set = ResourceSet::load_file(path)
            .map_err(|e| anyhow::anyhow!("--res {}: {e}", path.display()))?;
        resource_sets.push_flat(set);
    }
    // The writable root: a guest's only way to change anything on disk. Taken
    // here so a bad `--write-root` is a startup error rather than a save that
    // fails an hour later, and defaulted to the working directory so a run with
    // no flag behaves the way `tension dev` already does.
    //
    // A failure is **not** fatal: the run still starts, and `res_write` answers
    // -EROFS for every path. A game that never writes is unaffected, and a tool
    // that does gets a refusal it can print rather than a process that would not
    // boot.
    let write_root: Option<res::WriteRoot> = {
        let root = cli
            .write_root
            .clone()
            .or_else(|| std::env::current_dir().ok());
        match root {
            Some(path) => match res::WriteRoot::new(&path) {
                Ok(root) => {
                    crate::logging::log(
                        crate::logging::Level::Info,
                        "core",
                        &format!("res: writing under {}", root.root().display()),
                    );
                    Some(root)
                }
                Err(error) => {
                    crate::logging::log(
                        crate::logging::Level::Warn,
                        "core",
                        &format!("res: no writable root at {} ({error}); writes will be -EROFS", path.display()),
                    );
                    None
                }
            },
            None => None,
        }
    };

    // Everything the run is configured with, named once. Nothing here changes
    // after this point, and a second guest is given the same one.
    let config = host::HostConfig {
        // One compile cache per process, shared by every guest: the editor's
        // Play Mode runs the same compiled module on every press of a button.
        module_cache: std::sync::Arc::new(host::module_cache::ModuleCache::default()),
        engine,
        args: cli.args,
        guest_path: cli.wasm_path,
        res: std::sync::Arc::new(std::sync::Mutex::new(resource_sets)),
        write_root,
        capabilities: cli.capability_paths,
        session_open: cli.session_open,
        session_callbacks: cli.session_callbacks,
        post_test_events: cli.post_test_events,
    };

    // §7.2: the paks merge into one namespace, so two of them providing the
    // same path is a load-time error rather than a silent first-match. The
    // check costs one enumeration per pak, and nothing at lookup time.
    {
        let mounts = config
            .res
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(err) = check_pak_conflicts(&mounts.sets()) {
            eprintln!("tension-core: {err}");
            std::process::exit(2);
        }
    }

    // One guest: engine handle, module, store, linker, session. The session is
    // created but not installed — the capabilities' region requirements have to
    // be known first, and they are not loaded until below.
    let guest = host::GuestHost::new(&config)?;
    let host::GuestHost {
        module,
        mut store,
        mut linker,
        mut session,
    } = guest;

    // tension::platform ABI -----------------------------------------------
    //
    // Registered for both kinds of guest by one function; the nested answers
    // are the viewport rect, not the window record (`host/platform_abi.rs`).
    host::platform_abi::link_platform(&mut linker, host::guest::Kind::Root)?;

    // tension::audio ABI --------------------------------------------------
    audio::link_audio(&mut linker)?;

    // tension::ai ABI -----------------------------------------------------
    ai::link_ai(&mut linker)?;

    // tension::solver ABI -------------------------------------------------
    // The five guest imports (GUEST_ABI.md), plus the wasm-source binding
    // path: the host resolves the guest's `_derivative` / `deriv_buf_in` /
    // `deriv_buf_out` exports at create and performs the bind itself.
    solver::link_solver(&mut linker)?;

    // tension::session ABI -------------------------------------------------
    // The memory is defined under both import names (the TensionScript
    // toolchain emits `env::memory`; Tension documents `session::memory`), the
    // two verbs are registered, and the session is installed into the store —
    // the verbs reach it through `caller.data()`, so it must be there before the
    // guest can run. A guest with no session has none of that: it defines its own
    // memory, imports neither name, and calls none of the verbs — and the verbs
    // refuse cleanly if one does call them (`no session is installed`).
    if let Some(session) = session.as_mut() {
        session.install(&mut store, &mut linker)?;
        // The verbs take the session out of the store, so the arena is also kept
        // where it can be reached without it: `guest_write` during a publish
        // hook, and the epoch's own writes, all need it while a verb holds the
        // session.
        store.data_mut().arena = Some(session.memory());
    }
    session::link_session(&mut linker)?;
    store.data_mut().session = session;

    // The scheduler's guest-facing half (0.7.0a-pre0). Registered unconditionally
    // and inert: Wasmtime resolves a definition only when a guest imports it, so
    // a guest built against std 0.5.1 sees nothing new. The registration is what
    // lets the *next* std release (0.6.0, which calls `scheduler::park`) run on
    // this host instead of failing at instantiation with "unknown import".
    scheduler::link_scheduler(&mut linker)?;

        // The window ----------------------------------------------------------
    //
    // **There is none at startup, and there is no flag that makes one.** The
    // runtime runs a guest; a window is application configuration, so it is
    // created by `tension::platform.create_window` when the guest asks. This is
    // the whole of the `--window` removal: no flag, no startup creation, and no
    // second way in.

    // Capability adapters --------------------------------------------------
    // Loaded before instantiation because `link` is what registers the imports
    // the guest may call, and because `region_lookup` answers from the
    // layout — safe with no arena in sight (§7.2). Nothing loads unless
    // `--capability` (or `TENSION_CAPABILITY_PATH`) asks for it, so a plain run
    // is byte-for-byte the run it always was.
    let capability_paths = resolve_capability_paths(&config.capabilities)?;
    let mut adapters: Vec<adapter::LoadedAdapter> = Vec::with_capacity(capability_paths.len());
    for path in &capability_paths {
        // With the in-core backend compiled in, a 2D DSO on the command line is
        // skipped rather than loaded: `link_2d` already defined every
        // `tension::2d` import, and a second registration would be the one a
        // guest silently got. The log line is what stops this looking like the
        // adapter failed to load.
        #[cfg(feature = "render2d-core")]
        if is_2d_capability(path) {
            logging::log(
                Level::Info,
                "core",
                &format!(
                    "--capability {}: skipped — the 2D renderer is in core",
                    path.display()
                ),
            );
            continue;
        }
        match adapter::load_adapter(path) {
            Ok(loaded) => {
                logging::log(
                    Level::Info,
                    "core",
                    &format!(
                        "capability `{}` loaded from {}",
                        loaded.name(),
                        path.display()
                    ),
                );
                adapters.push(loaded);
            }
            Err(error) => anyhow::bail!("--capability {}: {error}", path.display()),
        }
    }
    // The host must outlive every call the imports make, so it lives here, in
    // `main`'s frame, for as long as the linker does. It carries a clone of the
    // posting face, which is what an adapter thread reaches through
    // `post_event` with no borrow of the store at all.
    // The mount table is the store's, and the adapter host adopts it before any
    // capability loads: `res_volume_bytes` and the guest's `tension::res` verbs
    // then answer from one table, which is the point of this pass.
    let adapter_host = adapter::AdapterHost::with_control(
        std::sync::Arc::clone(&store.data().posting),
        std::sync::Arc::clone(&store.data().control),
        std::sync::Arc::clone(&store.data().shared),
    )
    .adopt_mounts(std::sync::Arc::clone(&store.data().res));
    // Hand the surface cell to the store, so `create_window` can publish into
    // it later.
    //
    // **This is the inversion.** The surface used to be published here, once,
    // before any adapter loaded. It cannot be any more: the window does not
    // exist until a guest asks for one, and the guest thread is the thread that
    // creates it. So the cell is shared now and written mid-run, and the
    // consumer — a renderer's `ogre::init` — reads it when it is called, which
    // is after the guest's `createWindow` if the guest got the order right. A
    // renderer that inits first gets `-ENOSYS` from `host_surface`, and the
    // adapter turns that into `-ENODEV`: no window yet, not a broken host.
    store.data_mut().host_surface = Some(adapter_host.host_surface_cell());
    if !adapters.is_empty() {
        adapter::link_adapters(&mut linker, &mut adapters, adapter_host.api())?;
    }
    // What the epoch's publish phase calls, in registration order. The vtables
    // stay valid because `adapters` (and the libraries it holds open) lives in
    // this frame, which outlives every epoch.
    store.data_mut().adapters = adapter::adapter_calls(&adapters, adapter_host.api());
    // What each adapter asked about at `link` is what it requires of the arena
    // (§7.2): the query *is* the declaration, and `session_open` is where it is
    // enforced. Handing the set over before instantiation is what makes the
    // guest's own `session_open` the check point.
    let required: Vec<session::RegionNeed> = adapters
        .iter()
        .flat_map(|loaded| {
            let name = loaded.name().to_string();
            loaded.required_regions().iter().map(move |kind| session::RegionNeed {
                kind: *kind,
                adapter: name.clone(),
            })
        })
        .collect();
    if let Some(session) = store.data_mut().session.as_mut() {
        session.set_required_regions(required);
    }

    let instance = linker.instantiate(&mut store, &module)?;

    // The scheduler's two guest exports (0.7.0a-pre0). Both are optional and
    // both are resolved once, right here, so a guest's capabilities are a
    // startup fact rather than a surprise on the completion path:
    //
    //   __taskWake     std 0.6.0+'s push handler; absent in an older guest,
    //                  which keeps the pull path and needs no wake call.
    //   _game_running  the guest's "still want frames" answer; absent until a
    //                  guest adopts the host-owned loop (0.7.0b), which is
    //                  exactly why the loop below cannot start without it.
    //
    // Neither is called in this phase.
    store.data_mut().task_wake = instance
        .get_typed_func::<(i32, i32), ()>(&mut store, "__taskWake")
        .ok();
    store.data_mut().task_resume = instance
        .get_typed_func::<(i32, i32, i32, i32), ()>(&mut store, "__taskResume")
        .ok();
    store.data_mut().task_fail = instance
        .get_typed_func::<(i32, i32, i32), ()>(&mut store, "__taskFail")
        .ok();
    store.data_mut().game_running = instance
        .get_typed_func::<(), i32>(&mut store, "_game_running")
        .ok();

    // The coexistence rule, refused here rather than discovered later
    // (`docs/step2-shape-report.md` §3.1). A guest either opts into the
    // host-owned loop — exporting both — or keeps its own, exporting neither.
    //
    // Half an adoption is not a degenerate case to tolerate: a guest with
    // `__taskWake` and no `_game_running` returns from `_start_game`, never gets
    // a wake (the host has no reason to loop), and exits 0 having done nothing —
    // a failure that reads as success. A guest with `_game_running` and no
    // `__taskWake` asks the host to loop and gives it no way to dispatch. Both
    // are static properties of the binary, so both are refused before the first
    // guest instruction runs.
    match (
        store.data().task_wake.is_some(),
        store.data().game_running.is_some(),
    ) {
        (true, true) | (false, false) => {}
        (true, false) => anyhow::bail!(
            "the guest exports `__taskWake` but not `_game_running`: a host-driven \
             guest must export both (it cannot report when to stop), so this is \
             refused rather than run as a guest that silently does nothing"
        ),
        (false, true) => anyhow::bail!(
            "the guest exports `_game_running` but not `__taskWake`: a host-driven \
             guest must export both (the loop would have no way to resume a task), \
             so this is refused rather than spun on"
        ),
    }

    // The arena as the session left it, before the guest's first instruction:
    // the control block's triple, the region band's zeros, and the gap's canary
    // lattice (`docs/session.md` §8, step 2).
    if let Some(session) = store.data().session.as_ref() {
        session.verify_post_instantiate(&store)?;
    }

    // TensionScript's runtime initializer, when the guest exports one.
    //
    // The SDK builds with `--exportStart __start` so this is an export rather
    // than a `start` section: a start section would run guest code at
    // instantiation, before the arena had been verified, which is why the
    // load-time check refuses one. Calling it here is the order the design asks
    // for — verify the arena, initialize the runtime, then run the game.
    if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "__start") {
        init.call(&mut store, ())?;
    }

    // `--session-open`: A1's convenience, and *only* a flag. A1 has no guest SDK
    // yet, so a fixture cannot carry the config blob a real session guest sends;
    // with this on, the host performs the same open the verb performs — the
    // arena is READY before `_start_game`, and a guest that then called
    // `session_open` itself would be refused with `-EBUSY`, which is exactly why
    // the real path does not do this.
    if config.session_open || config.session_callbacks.is_some() {
        let (on_batch, on_event) = config.session_callbacks.unwrap_or((0, 0));
        // The record the guest would have written, built here because the host
        // is doing the opening; its slots are resolved against the guest's own
        // exported table, which is what makes them callable.
        let record = session::arena::CallbacksRecord {
            abi_version: session::arena::ABI_VERSION,
            slot_count: session::arena::CALLBACKS_SLOTS,
            flags: 0,
            on_batch,
            on_event,
        };
        let resolved = if on_batch == 0 && on_event == 0 {
            session::ResolvedCallbacks::default()
        } else {
            let table = instance.get_table(&mut store, "table");
            if table.is_none() {
                anyhow::bail!(
                    "--session-callbacks: the guest exports no `table`, so a slot index \
                     has nothing to resolve against"
                );
            }
            match session::Session::resolve_callbacks(&mut store, table.as_ref(), &record) {
                Ok(resolved) => resolved,
                Err(error) => anyhow::bail!("--session-callbacks: {error}"),
            }
        };

        let Some(mut session) = store.data_mut().session.take() else {
            anyhow::bail!("--session-open: no session is installed");
        };
        let memory = session.memory();
        // The smallest legal arena inside the default ceiling: the two numbers
        // the config tests use, and the shape that exercises `arena_size <
        // max_arena_size` rather than the degenerate equality.
        let arena_size = session::arena::LAYOUT_FLOOR as u32;
        let max_arena_size = session.max_arena_size();
        let outcome = {
            let arena_bytes = memory.data_mut(&mut store);
            session.open_from_host_with_callbacks(
                arena_bytes,
                arena_size,
                max_arena_size,
                &record,
                resolved,
            )
        };
        match outcome {
            Ok(()) => logging::log(
                Level::Info,
                "core",
                &format!(
                    "host open: arena {arena_size}, ceiling {max_arena_size}, \
                     callbacks onBatch={on_batch} onEvent={on_event}"
                ),
            ),
            Err(error) => {
                store.data_mut().session = Some(session);
                anyhow::bail!("--session-open: {error}");
            }
        }
        let capacities = *session.ring_capacities();
        store.data_mut().session = Some(session);
        store.data_mut().scheduler.set_capacities(&capacities);
    }

    // `--post-test-events`: three JOB_DONE events, so an epoch fixture has
    // something to deliver when it waits. Posted through the posting face
    // directly — this is the host, not an adapter — and before the guest runs,
    // so the wait finds them queued rather than having to race a producer.
    if config.post_test_events {
        let posting = store.data().posting.clone();
        for index in 0..3u32 {
            match posting.post(
                1,
                session::arena::CLASS_JOB_DONE,
                0,
                1 + index * 2,
                2 + index * 2,
                1.5,
                0.25,
            ) {
                Ok(seq) => logging::log(
                    Level::Info,
                    "core",
                    &format!(
                        "--post-test-events: JOB_DONE a={} b={} seq={seq}",
                        1 + index * 2,
                        2 + index * 2
                    ),
                ),
                Err(error) => anyhow::bail!("--post-test-events: {error}"),
            }
        }
    }

    // Entrypoint: prefer the Tension-specific `_start_game`, else WASI `_start`.
    // The result is held, not propagated with `?`: a guest trap must still reach
    // the adapter teardown below (C3). With `?` here, a trap returned before it
    // and left the adapters — and any thread they own — to the DSO's own static
    // destructor, which is the only teardown they got.
    let guest_result = if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start_game") {
        func.call(&mut store, ())
    } else if let Ok(func) = instance.get_typed_func::<(), ()>(&mut store, "_start") {
        func.call(&mut store, ())
    } else {
        Err(anyhow::anyhow!(
            "game.wasm did not export `_start_game` or `_start`"
        ))
    };

    // Tear the adapters down on the trapping path *before* the error propagates.
    // `shutdown` (stop and join threads) then `destroy` (free), reverse of link
    // order; `shutdown` must not touch guest memory, so running it with the
    // session still open is the contract. The clean path tears down at the very
    // end of this function instead, after the host's own session close.
    if let Err(error) = guest_result {
        adapter::teardown_adapters(&mut adapters);
        // The window goes after the last adapter, on both paths: an adapter
        // holding a VkSurfaceKHR into an instance this drop destroys would be
        // a use-after-free that only shows up on a trap path.
        drop_host_window(&mut store);
        return Err(error);
    }

    // ── the host-owned loop (0.7.0a) ─────────────────────────────────────
    //
    // Only for a guest that opted in: both exports present, checked at load.
    // A pre-adoption guest's `_start_game` blocks on its own frame loop and
    // returns at exit, so it never reaches here with anything to drive.
    //
    // The wake rides the epoch: each iteration blocks on the session's own
    // condition variable (a real wait, `posting.rs:320-350`), publishes and
    // matches whatever arrived, then hands the matched ids to `__taskWake`.
    if let Some(wake) = store.data().task_wake.clone() {
        let fail = store.data().task_fail.clone();
        host_loop(&mut store, &wake, fail.as_ref())?;
        let (buffered, evicted) = store.data().scheduler.recent_counters();
        if buffered > 0 || evicted > 0 {
            logging::log(
                Level::Info,
                "core",
                &format!(
                    "host loop: recent completions buffered={buffered} evicted={evicted} \
                     held={}",
                    store.data().scheduler.recent_len()
                ),
            );
        }
    }

    // What a trapping epoch left behind: a deferred submission belongs to the
    // session, not to the callback that queued it (R7), so the host reports what
    // is still pending rather than quietly dropping it.
    let pending_left = store.data().pending.len();
    if pending_left > 0 {
        logging::log(
            Level::Info,
            "core",
            &format!(
                "pending after the guest: {pending_left} submission(s) (R7: the \
                 queue survives a trap and is applied at the guest's next epoch)"
            ),
        );
    }

    // The guest owns the session, but a guest that returns without closing it
    // leaves the arena reporting READY. Close what the guest did not, so the
    // process never exits with a session that looks live: `session_close` is
    // idempotent, so a guest that closed properly sees a no-op.
    if let Some(mut session) = store.data_mut().session.take() {
        if session.state() == session::SessionState::Ready {
            let memory = session.memory();
            let arena_bytes = memory.data_mut(&mut store);
            if let Err(error) = session.close(arena_bytes) {
                logging::log(
                    Level::Warn,
                    "core",
                    &format!("session_close after the guest returned: {error}"),
                );
            }
        }
        store.data_mut().session = Some(session);
    }

    // The adapters are done: `shutdown` then `destroy`, reverse of link order,
    // once. This runs after the host's own session close above, so the guest's
    // session ends before its capabilities are torn down. (A guest that closed
    // the session itself, or that never opened one, reaches the same place.)
    adapter::teardown_adapters(&mut adapters);

    // Same ordering as the trapping path: adapters first, then the surface and
    // instance they were handed.
    drop_host_window(&mut store);

    Ok(())
}

/// Destroy the host's surface and instance, if there is one.
///
/// A named function rather than an assignment at two call sites, because the
/// ordering requirement — after `teardown_adapters`, before the store drops —
/// applies to both and is the kind of thing a third exit path would forget.
fn drop_host_window(store: &mut Store<HostState>) {
    // The event layers go first, and only ever here. Both exit paths call this
    // after `teardown_adapters`, so a layer's `shutdown` is a call into code
    // that is still loaded; clearing before the window drops also means no
    // pump can dispatch into a layer whose adapter has already been destroyed.
    // Idempotent: a second call finds no layers.
    store.data().shared.clear();
    // The 2D canvas goes first. Its GPU device holds a claim on the window
    // below, and destroying a claimed window under a live device is the ordering
    // that faults — so this mirrors the field order in `HostState` (where
    // `render2d` is declared before `host_window` for the same reason), for the
    // paths that reach teardown without a `close`.
    if store.data().render2d.canvas().is_some() {
        if let Err(error) = store.data_mut().render2d.close(1) {
            logging::log(
                Level::Warn,
                "core",
                &format!("teardown: the 2D canvas did not close cleanly ({error})"),
            );
        } else {
            logging::log(
                Level::Debug,
                "core",
                "teardown: the 2D canvas closed before the window",
            );
        }
    }
    if let Some(window) = store.data_mut().host_window.take() {
        let (width, height) = window.published_size();
        logging::log(
            Level::Debug,
            "core",
            &format!("window: closing {width}x{height} on '{}'", window.driver()),
        );
        drop(window);
    }
}

// ---------------------------------------------------------------------------
// tension::2d — the in-core renderer (feature `render2d-core`)
// ---------------------------------------------------------------------------

/// Copy a span out of guest memory.
///
/// The in-core equivalent of the DSO's `read_guest` (`adapter.cpp:98`), with the
/// same refusals in the same order: no exported memory is `-EBADF`, a span that
/// runs past the end is `-ENOSPC` (which every caller maps to `-EINVAL`, because
/// "your span is wrong" is an argument error at the verb), and a pointer
/// arithmetic overflow is `-EINVAL`.
///
/// Read a span out of guest memory, or `None` when there is no memory or the
/// span runs past its end.
///
/// The window API's version of the copy rule: a guest pointer is used only
/// inside the call that carried it, and what is kept afterwards is an owned
/// copy. Not feature-gated, unlike `guest_bytes`, because the window API exists
/// in both builds.
fn read_guest_span(caller: &mut Caller<'_, HostState>, ptr: u32, len: u32) -> Option<Vec<u8>> {
    let mem = caller.get_export("memory").and_then(|e| e.into_memory())?;
    let data = mem.data(&*caller);
    let start = ptr as usize;
    let end = start.checked_add(len as usize)?;
    if end > data.len() {
        return None;
    }
    Some(data[start..end].to_vec())
}

/// Whether a `--capability` path names the 2D adapter.
///
/// Only used when the in-core backend is compiled in: loading both would define
/// every `tension::2d` import twice, and the second registration is what a
/// guest would silently get. Matching on the file stem keeps the check honest
/// for `libtension_2d.so`, `libtension_2d.dylib` and `tension_2d.dll` without a
/// platform `cfg`.
#[cfg(feature = "render2d-core")]
fn is_2d_capability(path: &std::path::Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem == "libtension_2d" || stem == "tension_2d")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// guest load-time checks
// ---------------------------------------------------------------------------

/// The checks that must pass on the guest's own structure before anything is
/// instantiated (`docs/session.md` §2, §8).
///
/// There were three in the round's list; two are here, because the third is
/// already enforced: a module that imports `session::*` but declares no memory
/// import is refused by [`session::Session::create_from_module`], whose whole
/// rule is that the memory import is *mandatory* — so that case never reaches a
/// second check with a different message, and the message it does get names the
/// fix (`every session guest must import it as env::memory or session::memory`).
///
/// The remaining two are the ones nothing else can see:
///
/// - a module that imports a memory but does not re-export it as `memory`. The
///   host ABI reaches guest memory through `Instance::get_export("memory")`, so
///   without the re-export the first `tension::io` call panics on an `expect`
///   and the process aborts — a load-time bail with the fix in it is strictly
///   better than that.
/// - a module with a `start` section **that imports the session**. The session
///   verifies the arena between `instantiate` and `_start_game`; a start section
///   would run guest code *before* that verification, which is exactly the window
///   the check exists to protect. The scope is the rationale: a guest with no
///   session import has no arena to verify, and the pre-session examples build
///   with plain `asc`, which emits a start section by default (`docs/session.md` §7).
/// Drive a host-owned guest: wait, publish, match, wake.
///
/// The primitive is the session's condition variable (`PostingSide::wait_for_events`,
/// a `Condvar::wait`/`wait_timeout`) — the same one a blocking `session.wait`
/// uses. An event returns it early; nothing polls.
///
/// **FRAME is not driven here yet, and that is deliberate.** A FRAME tick needs a
/// frame period, and the only frame period in the tree lives inside the OGRE
/// adapter's own config (`tension-ogre/src/config.h:48`), parsed from the guest's
/// `ogre.init` argmap — it is not in the core ABI and not reachable from here.
/// No example awaits `rt.frame()` yet (that is 0.7.0b), so a loop driven by real
/// completions is the complete 0.7.0a behaviour; the frame clock is reported as
/// the one open decision rather than invented as a constant.
/// The tasks a lost signal must fail, host-side (0.7.0c).
///
/// The guest-side path (`rt.reportDrops` → `__taskReportDrops`) reads the same
/// counters and wakes up to N tasks with `-EIO`, but it is called from
/// `rt.runReady()` — which a host-loop guest never calls. So the rule moves
/// here: the host already owns the per-family parked tables, and the wake is
/// direct rather than a guest-side scan of `waitingByKey`.
///
/// Attribution is per **family**, exactly as the guest side has it: a drop is
/// counted per class by the producer, and the count cannot say which stream
/// lost the record, so the family's parked tasks are what gets failed. That
/// imprecision is the contract's (§4.4), not a shortcut here.
///
/// The counters are cumulative, so `drop_seen` is the baseline: without it every
/// iteration after the first would re-fail the same victims.
fn take_drop_victims(store: &mut Store<HostState>) -> Vec<(u64, i32)> {
    let posting = store.data().posting.clone();
    let data = store.data_mut();
    let mut per_family: Vec<(u32, usize)> = Vec::new();
    for class in 0..session::arena::CLASS_COUNT as u32 {
        let Some(queue) = posting.queue(class) else {
            continue;
        };
        let total = queue.dropped();
        let seen = data.drop_seen[class as usize];
        if total <= seen {
            continue;
        }
        data.drop_seen[class as usize] = total;
        let delta = (total - seen) as usize;
        let family = scheduler::family_of(class);
        match per_family.iter_mut().find(|(known, _)| *known == family) {
            Some((_, count)) => *count += delta,
            None => per_family.push((family, delta)),
        }
    }

    let mut victims = Vec::new();
    for (family, count) in per_family {
        for task_id in data.scheduler.take_from_family(family, count) {
            victims.push((task_id, -5)); // -EIO: §4.4's lost completion
        }
    }
    victims
}

/// Drain the host's event queue and dispatch the batch to the registered
/// layers, if a window exists.
///
/// **Main thread only.** This is the same thread that ran `HostWindow::new`,
/// which is the only thread SDL allows to touch a window's events.
///
/// Two callers, and both of them are "the host has nothing else to do":
///
///   * `host_loop`, once per iteration, before the epoch — a 0.7.0a guest that
///     exports an executor is driven from here;
///   * `session::wait` / `session::drain`, before the epoch blocks — a guest
///     that drives its own loop only ever yields to the host inside those two
///     verbs, and if the pump were not here a renderer-less guest would never
///     see an event at all. That is the case the input capability *is*: a text
///     game with no renderer and no host loop.
///
/// The 2D renderer's present is the third pump site and it calls
/// `HostWindow::pump` directly, because it already holds the window. Pumping
/// twice in one frame is harmless: a drain is a drain, and a layer is handed a
/// batch only for the events that were actually there.
pub(crate) fn pump_host_window(data: &mut HostState) {
    let pumped = data.host_window.as_mut().map(|window| window.pump());
    let Some(events) = pumped else {
        return;
    };
    if let Some((width, height)) = events.resized {
        logging::log(
            Level::Debug,
            "core",
            &format!("window: resized to {width}x{height}"),
        );
    }
    if events.overflow > 0 {
        // Said out loud rather than silently truncated: the layer (or layers)
        // missed exactly this many events, and a burst this large is a frame
        // that stalled, not a device misbehaving.
        logging::log(
            Level::Warn,
            "core",
            &format!(
                "window: {} event(s) did not fit this pump's batch of {} and were dropped",
                events.overflow,
                platform::EVENT_BATCH_CAPACITY
            ),
        );
    }
    if events.close_requested {
        // The same effect as the guest closing its session: stop driving it and
        // let `main` tear down in order. Not an error, and not a teardown here —
        // the adapters still need `shutdown` on their own threads, which `main`
        // arranges.
        data.window_closed = true;
    }
}

/// Execute every queued window control, if a window exists.
///
/// One drain, one thread, one place that calls `SDL_SetWindow*`. The swap inside
/// `drain` is what makes this safe against a producer on another thread: the
/// queue is replaced, so a layer posting while this runs never blocks and is
/// never blocked, and this holds no lock while it touches the window.
///
/// Reserving part of the queue for CORE is what stops a guest spamming
/// `control()` from starving the host's own timers, DPI and focus traffic. A
/// core message that finds the queue genuinely full comes back as `ApplyNow`
/// rather than being dropped: it is the one source whose loss would be
/// undetectable.
///
/// **Two callers, for the same reason `pump_host_window` has two**: the host
/// loop, and the blocking `session::wait`/`drain` path. Without the second, a
/// guest that drives its own loop would have its control messages queued and
/// never executed — measured: `input.set_relative(true)` posted
/// `TENSION_CTRL_RELATIVE_MOUSE`, the request sat in the queue, and the pointer
/// was never grabbed.
pub(crate) fn apply_pending_controls(data: &mut HostState) {
    let pending = {
        let bus = std::sync::Arc::clone(&data.control);
        bus.drain()
    };
    if pending.is_empty() {
        return;
    }
    let mut applied = 0u32;
    let mut failed = 0u32;
    if let Some(window) = data.host_window.as_mut() {
        for msg in &pending {
            match window.apply_control(msg) {
                Ok(()) => applied += 1,
                Err(error) => {
                    failed += 1;
                    logging::log(
                        Level::Warn,
                        "core",
                        &format!(
                            "window: control kind {} from source {} refused: {error}",
                            msg.kind, msg.source
                        ),
                    );
                }
            }
        }
    } else {
        // No window: nothing to apply to. Not an error — a guest may post
        // control without having created a window, and the queue is drained so
        // it cannot grow. Said once at debug, not per message.
        logging::log(
            Level::Debug,
            "core",
            &format!("window: {} control message(s) with no host window", pending.len()),
        );
        applied = pending.len() as u32;
    }
    if applied > 0 {
        logging::log(
            Level::Trace,
            "core",
            &format!("window: applied {applied} control message(s), {failed} failed"),
        );
    }
}

fn host_loop(
    store: &mut Store<HostState>,
    wake: &wasmtime::TypedFunc<(i32, i32), ()>,
    fail: Option<&wasmtime::TypedFunc<(i32, i32, i32), ()>>,
) -> anyhow::Result<()> {
    loop {
        // Exit condition, in the order that cannot lose the last completion:
        // the guest's say-so first, then whether anything is still outstanding.
        let running = match store.data().game_running.clone() {
            Some(game_running) => game_running.call(&mut *store, ())? != 0,
            None => false,
        };
        let outstanding = store.data().scheduler.parked() > 0;
        if !running && !outstanding && store.data().wake_batch.is_empty() {
            break;
        }

        // Drain SDL before blocking, then block for at most one slice.
        //
        // **Why a bounded timeout rather than an event watch.** SDL events only
        // reach the queue during a pump, so a watch callback cannot fire while
        // this thread is parked in `wait_for_events` — it would wake the loop
        // only after something else had already pumped, which is the case that
        // needs no waking. The 16 ms slice already exists as the loop's safety
        // net, and pumping once per slice bounds window-event latency to one
        // frame at 60 Hz while leaving the wait fully interruptible by a guest
        // wake. See `HOST_LOOP_SLICE_MS`.
        //
        // Thread rule: this is the same thread that ran `HostWindow::new`, which
        // is the only thread SDL allows to touch a window's events.
        pump_host_window(store.data_mut());
        if store.data().window_closed {
            logging::log(Level::Info, "core", "window: closed; stopping the host loop");
            break;
        }

        apply_pending_controls(store.data_mut());

        // Block on the session's condition variable. A completion, a fault or a
        // shutdown returns it early; the timeout is the loop's safety net for a
        // guest that says it is running while nothing can arrive.
        let _ = store.data().posting.wait_for_events(HOST_LOOP_SLICE_MS);

        // **A closed session ends the loop** (0.7.0). A guest that closes its
        // session has finished, whatever is still parked: a test fixture can
        // legitimately leave a control task waiting forever (the drop case's
        // "a key that never completes"), and an epoch over a closed session is
        // an error rather than a wake. Measured: `ASYNC PASS drop` printed, then
        // "host loop: the epoch failed: this verb needs a READY session".
        let session_ready = store
            .data()
            .session
            .as_ref()
            .map(|session| session.state() == session::SessionState::Ready)
            .unwrap_or(false);
        if !session_ready {
            break;
        }

        // Publish + match. The epoch appends matched ids to `wake_batch`.
        let taken = store.data_mut().session.take();
        let Some(mut session) = taken else {
            break;
        };
        let outcome = crate::session::epoch::run_epoch_with_store(
            &mut session,
            &mut *store,
            crate::session::epoch::EpochMode::DrainAll,
        );
        store.data_mut().session = Some(session);
        if let Err(error) = outcome {
            anyhow::bail!("host loop: the epoch failed: {error}");
        }

        // The frame add: a guest awaiting `rt.frame()` has a task parked on
        // `(FRAME, 0)`, and this is the only thing that ever resolves it.
        //
        // **Not gated on `_game_running()`** (0.7.0). It was, and that
        // deadlocked the one shape a guest legitimately has at the end: a final
        // task — a report, a teardown step — parked on the frame clock *after*
        // the game loop cleared `running`. The exit condition wants
        // `parked() == 0`, the frame add was refused because `running` was 0, and
        // nothing could reach either. Measured with `guest-ai-stream`, whose
        // verdict task parks on FRAME after the stream finishes.
        //
        // A per-key lookup is the whole guard: nothing parked costs one empty
        // table read, and a guest that has stopped being driven leaves through
        // the exit condition below.
        if let Some(frame_task) = store.data_mut().scheduler.take_frame() {
            store.data_mut().wake_batch.push(scheduler::Wake {
                task_id: frame_task,
                class: session::arena::CLASS_FRAME,
                payload: 0,
            });
        }

        // §4.4 and §5.1, host-side: a task whose record will never arrive is
        // resumed with a status rather than left parked. Two sources, one call —
        // a lost completion (-EIO) and a refused park (its own -ENOSPC), which
        // `scheduler::park` queued because a `void` import has nowhere to return
        // a refusal.
        let mut failed: Vec<(u64, i32)> = store.data_mut().scheduler.take_refusals();
        failed.extend(take_drop_victims(store));
        if !failed.is_empty() {
            match fail {
                Some(fail) => {
                    for chunk in failed.chunks(HOST_FAIL_CHUNK) {
                        let Some(memory) = store.data().arena else {
                            anyhow::bail!("host loop: no arena to write fail ids into");
                        };
                        {
                            let data = memory.data_mut(&mut *store);
                            if HOST_FAIL_STATUS + chunk.len() * 4 > data.len() {
                                anyhow::bail!("host loop: the fail scratch does not fit the arena");
                            }
                            for (index, (id, status)) in chunk.iter().enumerate() {
                                let at = HOST_WAKE_SCRATCH + index * 8;
                                data[at..at + 8].copy_from_slice(&id.to_le_bytes());
                                let sat = HOST_FAIL_STATUS + index * 4;
                                data[sat..sat + 4].copy_from_slice(&status.to_le_bytes());
                            }
                        }
                        fail.call(
                            &mut *store,
                            (
                                HOST_WAKE_SCRATCH as i32,
                                HOST_FAIL_STATUS as i32,
                                chunk.len() as i32,
                            ),
                        )?;
                    }
                }
                // A guest built before std 0.6.1 has no `__taskFail`. Said out
                // loud rather than swallowed: the task stays parked, and that is
                // the failure mode this path exists to remove.
                None => logging::log(
                    Level::Warn,
                    "core",
                    &format!(
                        "host loop: {} task(s) to fail but the guest exports no                          `__taskFail`; they stay parked (rebuild the guest against                          std 0.6.1)",
                        failed.len()
                    ),
                ),
            }
        }

        // Hand the batch to the guest. One call for the whole epoch's matches,
        // which is the contract's batching (§2.2): the host names the tasks.
        let batch = std::mem::take(&mut store.data_mut().wake_batch);
        if batch.is_empty() {
            continue;
        }
        // Chunked: the control block's tail holds a few ids, and a batch can be
        // larger (a job flood plus the frame). Each chunk is one call, so the
        // guest still sees a batched wake — just across several.
        if let Some(resume) = store.data().task_resume.clone() {
            // The richer export (std 0.6.1): ids, classes and payloads, so the
            // record the guest awaited holds what was delivered. `__taskWake`
            // alone resumes with whatever the record happens to contain, which
            // under the push path is nothing.
            for chunk in batch.chunks(HOST_RESUME_CHUNK) {
                let Some(memory) = store.data().arena else {
                    anyhow::bail!("host loop: no arena to write wake ids into");
                };
                {
                    let data = memory.data_mut(&mut *store);
                    for (index, wake) in chunk.iter().enumerate() {
                        let at = HOST_WAKE_SCRATCH + index * 8;
                        data[at..at + 8].copy_from_slice(&wake.task_id.to_le_bytes());
                        let cat = HOST_RESUME_CLASSES + index * 4;
                        data[cat..cat + 4].copy_from_slice(&wake.class.to_le_bytes());
                        let pat = HOST_RESUME_PAYLOADS + index * 4;
                        data[pat..pat + 4].copy_from_slice(&wake.payload.to_le_bytes());
                    }
                }
                resume.call(
                    &mut *store,
                    (
                        HOST_WAKE_SCRATCH as i32,
                        HOST_RESUME_CLASSES as i32,
                        HOST_RESUME_PAYLOADS as i32,
                        chunk.len() as i32,
                    ),
                )?;
            }
        } else {
            for chunk in batch.chunks(HOST_WAKE_CHUNK) {
                let Some(memory) = store.data().arena else {
                    anyhow::bail!("host loop: no arena to write wake ids into");
                };
                {
                    let data = memory.data_mut(&mut *store);
                    if HOST_WAKE_SCRATCH + chunk.len() * 8 > data.len() {
                        anyhow::bail!("host loop: the wake scratch does not fit the arena");
                    }
                    for (index, wake) in chunk.iter().enumerate() {
                        let at = HOST_WAKE_SCRATCH + index * 8;
                        data[at..at + 8].copy_from_slice(&wake.task_id.to_le_bytes());
                    }
                }
                wake.call(&mut *store, (HOST_WAKE_SCRATCH as i32, chunk.len() as i32))?;
            }
        }
    }
    Ok(())
}

/// Where the loop stages the ids it hands `__taskWake`, as an arena offset.
///
/// **The control block's unused tail**, not the header page's canary gap. The
/// first cut wrote at `0x800`, which lies between the manifest (ends `0x368`)
/// and `HEADER_PAGE_SIZE` (`0x1000`) — the gap the canary lattice fills. The
/// write did not trap, because the lattice is verified in tests rather than at
/// runtime, so it silently corrupted the one region whose whole purpose is to
/// prove nothing wrote there. The control block is session-owned, already
/// host-writable, and its last field ends at 184 of 256 bytes.
const HOST_WAKE_SCRATCH: usize = session::arena::CONTROL_OFFSET + 184;
/// Ids that fit in the control block's tail: (256 - 184) / 8.
const HOST_WAKE_CHUNK: usize = 9;
/// Where a fail call's statuses start: after five ids (5 * 8 = 40 bytes), so
/// five statuses (20 bytes) end at 184 + 40 + 20 = 244 of the 256-byte block.
const HOST_FAIL_STATUS: usize = HOST_WAKE_SCRATCH + 5 * 8;
/// Tasks per `__taskFail` call: ids and statuses both fit in the tail.
const HOST_FAIL_CHUNK: usize = 5;
/// Where a resume's classes start: after three ids (24 bytes), five classes
/// (20) end at 184+24+20 = 228, and five payloads (20) at 248 of 256.
const HOST_RESUME_CLASSES: usize = HOST_WAKE_SCRATCH + 3 * 8;
/// Where a resume's payloads start: after the classes.
const HOST_RESUME_PAYLOADS: usize = HOST_RESUME_CLASSES + 5 * 4;
/// Tasks per `__taskResume` call: three ids, five classes, five payloads.
const HOST_RESUME_CHUNK: usize = 3;
/// The loop's wait slice, in ms: a bounded condvar wait, not a poll. It exists
/// so a guest that reports "running" with nothing outstanding cannot hang the
/// process; a healthy loop returns on an event long before it expires.
const HOST_LOOP_SLICE_MS: i32 = 16;

pub(crate) fn check_guest_module(module: &Module, bytes: &[u8], path: &str) -> anyhow::Result<()> {
    let mut imports_session = false;
    let mut imports_memory = false;
    for import in module.imports() {
        if import.module() == "session" {
            imports_session = true;
        }
        if matches!(import.ty(), ExternType::Memory(_)) {
            imports_memory = true;
        }
    }

    // The ninth verb a session guest needs is the memory itself: a module that
    // speaks the session's protocol but brought no arena is refused here, in
    // those words, rather than by the page-count machinery. (The rule that
    // *every* guest here must import a memory is `Session::create_from_module`'s
    // — this check is the more specific message for the case where the guest
    // clearly meant to be a session guest.)
    if imports_session && !imports_memory {
        anyhow::bail!(
            "{path} imports `session::*` but declares no memory import; the session owns the \
             arena, so it must be imported as env::memory or session::memory"
        );
    }

    if imports_memory {
        // The export must be a *memory*: an export named `memory` of another
        // kind would still make `into_memory()` return `None` and the expect
        // panic, so the kind is part of the check rather than the name alone.
        let exports_memory = module
            .exports()
            .any(|export| export.name() == "memory" && matches!(export.ty(), ExternType::Memory(_)));
        if !exports_memory {
            anyhow::bail!(
                "{path} imports a memory but does not re-export it as `memory`: the host \
                 reaches guest memory through `get_export(\"memory\")`, so the module needs \
                 `(export \"memory\" (memory 0))`"
            );
        }
    }

    // The start-section check is **scoped to session guests**, and the scope is
    // the rationale: the session verifies the arena between `instantiate` and
    // `_start_game`, so a start section would run guest code inside the window
    // that verification exists to protect. A guest with no session import has no
    // arena and no verification — the pre-session examples (io, audio, ai, res,
    // solver) predate the session entirely and build with plain `asc`, which
    // emits a start section by default. Refusing them was the check reaching
    // past its own reason: `imports_session` is already in hand two checks up.
    if imports_session && declares_start_section(bytes) {
        anyhow::bail!(
            "{path} declares a `start` section, which runs guest code at instantiation — \
             before the session verifies the arena. Put that work at the top of `_start_game` \
             instead (the session verifies between instantiation and that call)"
        );
    }
    Ok(())
}

/// The wasm section id of the `start` section.
const WASM_SECTION_START: u8 = 8;

/// Whether the module declares a `start` section.
///
/// `wasmtime::Module` exposes imports, exports and custom sections but no
/// accessor for `start`, so the binary is walked here: the magic and version,
/// then `(id, size)` pairs through the repo's own LEB reader. A malformed module
/// answers `false` and is left to `Module::new`, which reports it with a better
/// message than this walk could.
///
/// **The walk reads the binary format only.** A guest handed over as `.wat` text
/// — a development path, which is what the fixtures are — has no section table
/// to walk and answers `false` here, so a text-format module with `(start $f)`
/// would run that function at instantiation. The arena is still verified
/// afterwards (the band-zero sweep and the canary lattice are what catch
/// damage), but the *ordering* guarantee this check exists for would be lost.
/// A shipping guest is a compiled `game.wasm`, so this is a gap in the
/// development path rather than in the ABI; closing it properly means parsing
/// the text format, which no chunk-1 code does. See the A1 report.
fn declares_start_section(bytes: &[u8]) -> bool {
    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
        return false;
    }
    let mut at = 8usize;
    while at < bytes.len() {
        let id = bytes[at];
        at += 1;
        let Some(size) = leb::read_uleb(bytes, &mut at) else {
            return false;
        };
        if id == WASM_SECTION_START {
            return true;
        }
        match at.checked_add(size) {
            Some(next) => at = next,
            None => return false,
        }
    }
    false
}

/// Parse `--session-callbacks`'s value: `BATCH` or `BATCH,EVENT`, each a guest
/// function-table index (`0` = that slot is absent).
fn parse_callback_slots(value: &str) -> Result<(u32, u32), String> {
    let mut parts = value.split(',');
    let batch = parts
        .next()
        .ok_or("`--session-callbacks` needs a slot")?
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("`--session-callbacks {value}`: `{value}` is not a table index"))?;
    let event = match parts.next() {
        Some(text) => text
            .trim()
            .parse::<u32>()
            .map_err(|_| format!("`--session-callbacks {value}`: `{text}` is not a table index"))?,
        None => 0,
    };
    if parts.next().is_some() {
        return Err(format!("`--session-callbacks {value}`: expected BATCH or BATCH,EVENT"));
    }
    Ok((batch, event))
}

/// Turn `--capability` values into library paths (round-2 decision 3): a value
/// that names an existing file is that file; anything else is a capability
/// *name*, looked up as `<dir>/libtension_<name>.so` in the directories
/// `TENSION_CAPABILITY_PATH` lists, colon-separated. The explicit form is
/// checked first, so an operator pointing at a specific file is never overridden
/// by the environment.
fn resolve_capability_paths(values: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    let mut resolved = Vec::with_capacity(values.len());
    for value in values {
        let direct = PathBuf::from(value);
        if direct.is_file() {
            resolved.push(direct);
            continue;
        }
        let mut found = None;
        if let Some(dirs) = std::env::var_os("TENSION_CAPABILITY_PATH") {
            for dir in std::env::split_paths(&dirs) {
                let candidate = dir.join(format!("libtension_{value}.so"));
                if candidate.is_file() {
                    found = Some(candidate);
                    break;
                }
            }
        }
        match found {
            Some(path) => resolved.push(path),
            None => anyhow::bail!(
                "--capability {value}: no such file, and no libtension_{value}.so in \
                 TENSION_CAPABILITY_PATH — pass the library's path, or set that variable to a \
                 colon-separated list of directories holding it"
            ),
        }
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// tension::res helpers
// ---------------------------------------------------------------------------

/// Every NS1 path a pak provides, walked once. `--res` merges paks into one
/// namespace, so a path served by two of them is a load-time error (§7.2).
fn check_pak_conflicts(sets: &[&ResourceSet<'static>]) -> Result<(), String> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (index, set) in sets.iter().enumerate() {
        let mut stack: Vec<String> = vec!["/".to_string()];
        while let Some(dir) = stack.pop() {
            let entries = set
                .read_dir(&dir)
                .map_err(|e| format!("--res pak {index}: listing `{dir}` failed: {e}"))?;
            for entry in entries {
                let path = if dir == "/" {
                    format!("/{}", entry.name)
                } else {
                    format!("{dir}/{}", entry.name)
                };
                if !seen.insert(path.clone()) {
                    return Err(format!(
                        "duplicate path `{path}`: it is provided by --res pak {index} and an earlier pak"
                    ));
                }
                if entry.is_dir() {
                    stack.push(path);
                }
            }
        }
    }
    Ok(())
}

/// Read a UTF-8 path out of guest memory. `None` means the guest's own bounds
/// (or its bytes) do not describe a path: the ABI answers -EINVAL.
fn guest_path(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> Option<String> {
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
    std::str::from_utf8(&data[start..end]).ok().map(str::to_owned)
}

/// Read a UTF-8 span out of guest memory, **lossily**: an invalid byte is
/// replaced rather than refused, because a log call must not drop a record for
/// its encoding. `None` only when the range does not fit the guest's memory, in
/// which case the caller drops the record (`tension::io::log` never traps).
fn guest_text(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> Option<String> {
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
    Some(String::from_utf8_lossy(&data[start..end]).into_owned())
}

/// Write bytes into guest memory; false when the range does not fit.
fn write_guest(caller: &mut Caller<'_, HostState>, ptr: i32, bytes: &[u8]) -> bool {
    if ptr < 0 {
        return false;
    }
    let Some(mem) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return false;
    };
    let data = mem.data_mut(caller);
    let start = ptr as usize;
    let Some(end) = start.checked_add(bytes.len()) else {
        return false;
    };
    if end > data.len() {
        return false;
    }
    data[start..end].copy_from_slice(bytes);
    true
}

/// The 12-byte `{kind, size, flags}` record (§7.4), little-endian.
fn write_stat(caller: &mut Caller<'_, HostState>, ptr: i32, stat: &Stat) -> bool {
    let mut rec = [0u8; 12];
    rec[0..4].copy_from_slice(&stat.kind.to_le_bytes());
    rec[4..8].copy_from_slice(&stat.size.to_le_bytes());
    rec[8..12].copy_from_slice(&stat.flags.to_le_bytes());
    write_guest(caller, ptr, &rec)
}

/// Whether an fd names a file on the write root rather than a pak's handle.
fn is_write_fd(fd: i32) -> bool {
    fd > 0 && (fd >> FD_SET_SHIFT) == FD_WRITE_TAG
}

/// The store's write-root file table, cloned out of `caller` for the same
/// borrow reason `mount_table` is.
fn write_files(
    caller: &Caller<'_, HostState>,
) -> std::sync::Arc<std::sync::Mutex<res::WriteFiles>> {
    std::sync::Arc::clone(&caller.data().write_files)
}

/// Guest fd for a pak's handle.
fn pack_fd(set: usize, fd: i32) -> i32 {
    ((set as i32) << FD_SET_SHIFT) | (fd & FD_LOCAL_MASK)
}

/// The store's mount table, cloned out of `caller` so the borrow ends before the
/// lock is taken.
///
/// `Caller::data` holds an immutable borrow of the store; a `MutexGuard` that
/// outlived it would make the next verb's `data_mut` a borrow error rather than
/// the clean compile it is. Cloning the `Arc` (not the table) is one refcount
/// bump.
fn mount_table(caller: &Caller<'_, HostState>) -> std::sync::Arc<std::sync::Mutex<res::MountTable>> {
    std::sync::Arc::clone(&caller.data().res)
}

/// Split a guest fd back into (pak index, that pak's handle).
fn fd_index(fd: i32) -> Option<(usize, i32)> {
    if fd <= 0 {
        return None;
    }
    let local = fd & FD_LOCAL_MASK;
    if local == 0 {
        return None;
    }
    Some(((fd >> FD_SET_SHIFT) as usize, local))
}

#[cfg(test)]
mod res_cli_tests {
    use super::*;

    #[test]
    fn res_flags_are_collected_in_order() {
        let cli = parse_cli(vec![
            "--res".into(),
            "a.tns".into(),
            "--res=b.tns".into(),
            "--debug".into(),
            "game.wasm".into(),
            "--res".into(), // after the guest path: this one is the game's
        ])
        .expect("parses");
        assert_eq!(
            cli.res_paths,
            vec![PathBuf::from("a.tns"), PathBuf::from("b.tns")]
        );
        assert!(cli.debug);
        assert_eq!(cli.wasm_path, "game.wasm");
        assert_eq!(cli.args, vec!["--res".to_string()]);
    }

    #[test]
    fn a_res_without_a_value_is_an_error() {
        // A trailing `--res` has nothing to consume.
        let err = parse_cli(vec!["--res".into()]).unwrap_err();
        assert!(err.contains("--res"), "unexpected error: {err}");
        // `--res` takes the next token unconditionally (like `--symbol-path`),
        // so a guest path written there is consumed as a pak and the guest is
        // then missing — reported, never guessed at.
        let err = parse_cli(vec!["--res".into(), "game.wasm".into()]).unwrap_err();
        assert!(err.contains("<game.wasm>"), "unexpected error: {err}");
    }

    #[test]
    fn without_res_the_set_is_empty() {
        let cli = parse_cli(vec!["game.wasm".into()]).expect("parses");
        assert!(cli.res_paths.is_empty());
    }

    #[test]
    fn guest_fds_pack_the_pak_index() {
        assert_eq!(fd_index(pack_fd(0, 1)), Some((0, 1)));
        assert_eq!(fd_index(pack_fd(3, 64)), Some((3, 64)));
        assert_eq!(fd_index(pack_fd(1, 9)), Some((1, 9)));
        assert_eq!(fd_index(0), None);
        assert_eq!(fd_index(-2), None);
        // A packed fd never collides with a bare local fd.
        assert_ne!(pack_fd(1, 1), 1);
    }
}

#[cfg(test)]
mod adapter_cli_tests {
    use super::*;

    #[test]
    fn capability_values_are_collected_in_order() {
        let cli = parse_cli(vec![
            "--capability".into(),
            "echo".into(),
            "--capability=other.so".into(),
            "game.wasm".into(),
            "--capability".into(), // after the guest path: this one is the game's
        ])
        .expect("parses");
        assert_eq!(
            cli.capability_paths,
            vec!["echo".to_string(), "other.so".to_string()]
        );
        assert_eq!(cli.wasm_path, "game.wasm");
        assert_eq!(cli.args, vec!["--capability".to_string()]);

        let err = parse_cli(vec!["--capability".into()]).unwrap_err();
        assert!(err.contains("--capability"), "unexpected error: {err}");
    }

    #[test]
    fn without_capabilities_nothing_is_loaded() {
        let cli = parse_cli(vec!["game.wasm".into()]).expect("parses");
        assert!(cli.capability_paths.is_empty());
        assert!(
            resolve_capability_paths(&cli.capability_paths)
                .expect("resolves")
                .is_empty()
        );
    }

    #[test]
    fn the_host_open_is_a_flag_and_off_by_default() {
        let cli = parse_cli(vec!["game.wasm".into()]).expect("parses");
        assert!(
            !cli.session_open,
            "the run path must not open a session unless asked"
        );
        let cli = parse_cli(vec!["--session-open".into(), "game.wasm".into()]).expect("parses");
        assert!(cli.session_open);
        assert_eq!(cli.wasm_path, "game.wasm");
    }

    // ── the load-time checks on the guest's own structure ──────────────────

    fn module(wat: &str) -> Module {
        Module::new(&Engine::default(), wat).expect("the test module compiles")
    }

    /// F2 check 1, in its own words: a guest that speaks the session protocol
    /// but brought no arena. (`Session::create_from_module` refuses *any* guest
    /// without a memory import; this is the specific message for the case where
    /// the guest clearly meant to be a session guest.)
    #[test]
    fn a_session_guest_without_a_memory_import_is_refused() {
        let module = module(
            r#"(module
                 (import "session" "open" (func $open (param i32 i32) (result i32)))
                 (func (export "_start_game")))
               "#,
        );
        let error = check_guest_module(&module, b"", "guest.wat").expect_err("refused");
        let text = error.to_string();
        assert!(
            text.contains("imports `session::*` but declares no memory import")
                && text.contains("env::memory or session::memory"),
            "unexpected diagnostic: {text}"
        );
    }

    /// F2 check 2: the memory is imported and re-exported, which is what the
    /// host ABI needs to reach it.
    #[test]
    fn a_guest_that_re_exports_its_memory_passes() {
        let module = module(
            r#"(module
                 (import "session" "memory" (memory 4 256))
                 (export "memory" (memory 0))
                 (func (export "_start_game")))
               "#,
        );
        check_guest_module(&module, b"", "guest.wat").expect("the checks pass");
    }

    #[test]
    fn a_guest_that_hides_its_memory_is_refused() {
        let module = module(
            r#"(module
                 (import "env" "memory" (memory 4 256))
                 (func (export "_start_game")))
               "#,
        );
        let error = check_guest_module(&module, b"", "guest.wat").expect_err("refused");
        let text = error.to_string();
        assert!(
            text.contains("does not re-export it as `memory`")
                && text.contains("(export \"memory\" (memory 0))"),
            "unexpected diagnostic: {text}"
        );
    }

    /// A minimal *binary* module with a `start` section.
    ///
    /// The section walk in `declares_start_section` reads the binary format, so a
    /// `.wat` fixture cannot exercise it — the walk answers `false` for text, as
    /// its own comment says. These bytes are therefore assembled here: the magic
    /// and version, a type, a `() -> ()` function, and a start section naming it.
    /// `session_import` adds an import from the `session` module plus the memory
    /// import and re-export the neighbouring checks require, so each test trips
    /// exactly the check it is about and nothing else.
    fn module_with_start_section(session_import: bool) -> (Module, Vec<u8>) {
        fn uleb(mut n: u32, out: &mut Vec<u8>) {
            loop {
                let byte = (n & 0x7f) as u8;
                n >>= 7;
                if n == 0 {
                    out.push(byte);
                    return;
                }
                out.push(byte | 0x80);
            }
        }
        fn section(id: u8, payload: &[u8], out: &mut Vec<u8>) {
            out.push(id);
            uleb(payload.len() as u32, out);
            out.extend_from_slice(payload);
        }
        fn name(text: &str, out: &mut Vec<u8>) {
            uleb(text.len() as u32, out);
            out.extend_from_slice(text.as_bytes());
        }

        let mut bytes = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

        // type 0: () -> ()
        let mut types = vec![0x01];
        types.extend_from_slice(&[0x60, 0x00, 0x00]);
        section(1, &types, &mut bytes);

        if session_import {
            // env::memory (min 1), then session::open — a func, so the defined
            // function's index is 1 and the start section names that.
            let mut imports = vec![0x02];
            name("env", &mut imports);
            name("memory", &mut imports);
            imports.extend_from_slice(&[0x02, 0x00, 0x01]);
            name("session", &mut imports);
            name("open", &mut imports);
            imports.extend_from_slice(&[0x00, 0x00]);
            section(2, &imports, &mut bytes);
        }

        // one defined function of type 0
        section(3, &[0x01, 0x00], &mut bytes);

        if session_import {
            // the memory must be re-exported as `memory`, or the check above this
            // one bails first with a different message
            let mut exports = vec![0x01];
            name("memory", &mut exports);
            exports.extend_from_slice(&[0x02, 0x00]);
            section(7, &exports, &mut bytes);
        }

        // start section: the defined function's index
        let start_index: u32 = if session_import { 1 } else { 0 };
        let mut start = Vec::new();
        uleb(start_index, &mut start);
        section(8, &start, &mut bytes);

        // code: one empty body
        section(10, &[0x01, 0x02, 0x00, 0x0b], &mut bytes);

        let module = Module::new(&Engine::default(), &bytes).expect("the test module compiles");
        (module, bytes)
    }

    /// The scope of the start-section check: a guest with no session import has
    /// no arena for the session to verify, so a start section is its own business
    /// — and it is the only shape the pre-session examples can build, because
    /// plain `asc` emits one.
    #[test]
    fn test_start_section_allowed_for_non_session_guest() {
        let (module, bytes) = module_with_start_section(false);
        check_guest_module(&module, &bytes, "guest.wasm").expect(
            "a non-session guest with a start section is not this check's case: there is no \
             arena to verify between instantiation and `_start_game`",
        );
    }

    /// And the case the check exists for, unchanged: a session guest that would
    /// run guest code inside the arena-verification window is refused, in the
    /// words the message has always used.
    #[test]
    fn test_start_section_refused_for_session_guest() {
        let (module, bytes) = module_with_start_section(true);
        let error = check_guest_module(&module, &bytes, "guest.wasm").expect_err("refused");
        let text = error.to_string();
        assert!(
            text.contains("declares a `start` section")
                && text.contains("before the session verifies the arena")
                && text.contains("`_start_game`"),
            "unexpected diagnostic: {text}"
        );
    }

    #[test]
    fn a_guest_without_a_memory_import_at_all_passes_this_check() {
        // The mandatory-import rule is `Session::create_from_module`'s, one line
        // later: it refuses *every* guest without a memory import, so this check
        // stays quiet for a module that never mentions the session — and the
        // diagnostic the operator sees is the general one with the same fix.
        let module = module(r#"(module (func (export "_start_game")))"#);
        check_guest_module(&module, b"", "guest.wat").expect("not this check's case");
    }

    #[test]
    fn a_capability_name_resolves_through_the_path_variable() {
        let dir = std::env::temp_dir().join("tension-capability-path-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let library = dir.join("libtension_probe.so");
        std::fs::write(&library, b"not a library, only a file to find").expect("write");

        std::env::set_var("TENSION_CAPABILITY_PATH", &dir);
        let resolved = resolve_capability_paths(&["probe".to_string()]).expect("resolves");
        assert_eq!(resolved, vec![library.clone()]);

        // The explicit form is checked first and wins: an operator pointing at a
        // file is never overridden by the environment.
        let explicit =
            resolve_capability_paths(&[library.display().to_string()]).expect("resolves");
        assert_eq!(explicit, vec![library.clone()]);

        // A name that resolves nowhere is a refusal that says what it looked
        // for, not a run with one adapter quietly missing.
        let error = resolve_capability_paths(&["absent".to_string()]).expect_err("refused");
        assert!(
            error.to_string().contains("libtension_absent.so"),
            "unexpected error: {error}"
        );
        std::env::remove_var("TENSION_CAPABILITY_PATH");
        let _ = std::fs::remove_file(&library);
    }

    /// The wasm header every module starts with: the magic and the version.
    const HEADER: [u8; 8] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    /// A binary module built from `(section id, payload)` pairs, sizes in LEB.
    fn module_with(sections: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = HEADER.to_vec();
        for (id, payload) in sections {
            bytes.push(*id);
            leb::write_uleb(&mut bytes, payload.len() as u64);
            bytes.extend_from_slice(payload);
        }
        bytes
    }

    #[test]
    fn a_start_section_is_found_behind_the_other_sections() {
        // Section 8 is `start`; 1 and 3 are types and functions, there so the
        // walk has to skip them by their declared sizes rather than guessing.
        let with_start = module_with(&[(1, vec![0x00]), (3, vec![0x00]), (8, vec![0x00])]);
        assert!(declares_start_section(&with_start));

        let without = module_with(&[(1, vec![0x00]), (10, vec![0x00, 0x00])]);
        assert!(!declares_start_section(&without));
        assert!(!declares_start_section(&HEADER));
    }

    #[test]
    fn the_start_walk_gives_up_on_a_malformed_module() {
        // The text format: no magic, and `Module::new` parses it — the walk has
        // nothing to say about it.
        assert!(!declares_start_section(b"(module)"));
        // A section whose size runs past the end of the module.
        let mut truncated = module_with(&[(1, vec![0x00])]);
        truncated[9] = 0x40;
        assert!(!declares_start_section(&truncated));
        // A stream that ends before the magic does.
        assert!(!declares_start_section(&HEADER[..6]));
        assert!(!declares_start_section(&[]));
    }
}

#[cfg(test)]
mod log_cli_tests {
    use super::*;
    use std::sync::Mutex;
    use tension_core::logging::{Format, Level, Threshold};

    // Two tests touch the process environment; the lock keeps them from reading
    // each other's variables while the harness runs the module in parallel.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn cli(args: &[&str]) -> Cli {
        parse_cli(args.iter().map(|s| s.to_string()).collect()).expect("parses")
    }

    #[test]
    fn log_flags_parse_in_both_spellings() {
        let parsed = cli(&[
            "--log-level",
            "info",
            "--log-level=ai:debug,ogre:warn",
            "--log-format=json",
            "--log-file",
            "run.log",
            "game.wasm",
        ]);
        assert_eq!(
            parsed.log_levels,
            vec!["info".to_string(), "ai:debug,ogre:warn".to_string()]
        );
        assert_eq!(parsed.log_format.as_deref(), Some("json"));
        assert_eq!(parsed.log_file, Some(PathBuf::from("run.log")));
        assert_eq!(parsed.wasm_path, "game.wasm");
    }

    #[test]
    fn log_flags_after_the_guest_belong_to_the_game() {
        let parsed = cli(&["game.wasm", "--log-level=debug"]);
        assert!(parsed.log_levels.is_empty());
        assert_eq!(parsed.args, vec!["--log-level=debug".to_string()]);
    }

    #[test]
    fn a_log_flag_without_a_value_is_refused() {
        for flag in ["--log-level", "--log-format", "--log-file"] {
            let error = parse_cli(vec![flag.to_string()]).unwrap_err();
            assert!(error.contains(flag), "{flag}: unexpected error: {error}");
        }
    }

    #[test]
    fn without_log_flags_the_config_is_the_default() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var("TENSION_LOG_LEVEL");
        std::env::remove_var("TENSION_LOG_FORMAT");
        std::env::remove_var("TENSION_LOG_FILE");
        let config = build_log_config(&cli(&["game.wasm"])).expect("builds");
        assert_eq!(config, LogConfig::default());
    }

    #[test]
    fn cli_and_env_merge_with_cli_winning() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("TENSION_LOG_LEVEL", "warn,ai:error");
        std::env::set_var("TENSION_LOG_FORMAT", "json");
        let config = build_log_config(&cli(&[
            "--log-level",
            "ai:debug",
            "--log-format=text",
            "game.wasm",
        ]))
        .expect("builds");
        std::env::remove_var("TENSION_LOG_LEVEL");
        std::env::remove_var("TENSION_LOG_FORMAT");

        // The environment set the global; no CLI bare level overrode it.
        assert_eq!(config.global, Threshold::At(Level::Warn));
        // The CLI named `ai`, which replaces the environment's `ai:error`.
        assert_eq!(
            config.overrides,
            vec![("ai".to_string(), Threshold::At(Level::Debug))]
        );
        // The CLI format beats the environment's.
        assert_eq!(config.format, Format::Text);
    }

    #[test]
    fn a_malformed_level_spec_is_a_usage_error() {
        let error = build_log_config(&cli(&["--log-level=verbose", "game.wasm"])).unwrap_err();
        assert!(error.to_string().contains("is not a level"), "{error}");
    }

    #[test]
    fn a_bad_format_is_a_usage_error() {
        let error = build_log_config(&cli(&["--log-format=yaml", "game.wasm"])).unwrap_err();
        assert!(
            error.to_string().contains("expected `text` or `json`"),
            "{error}"
        );
    }
}

#[cfg(test)]
mod pack_cli_tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pack_defaults_the_output_path() {
        let cli = parse_pack_cli(strings(&["assets"])).expect("parses");
        assert_eq!(cli.source, PathBuf::from("assets"));
        assert_eq!(cli.out, PathBuf::from("assets.tns"));
    }

    #[test]
    fn pack_takes_o_and_out_in_both_spellings() {
        for args in [
            vec!["assets", "-o", "out.tns"],
            vec!["assets", "--out", "out.tns"],
            vec!["assets", "-o=out.tns"],
            vec!["assets", "--out=out.tns"],
            vec!["-o", "out.tns", "assets"],
        ] {
            let cli = parse_pack_cli(strings(&args)).expect("parses");
            assert_eq!(cli.out, PathBuf::from("out.tns"), "args: {args:?}");
            assert_eq!(cli.source, PathBuf::from("assets"), "args: {args:?}");
        }
    }

    #[test]
    fn pack_rejects_bad_usage() {
        assert!(parse_pack_cli(strings(&[])).unwrap_err().contains("<source-dir>"));
        assert!(parse_pack_cli(strings(&["-o"])).unwrap_err().contains("-o"));
        assert!(parse_pack_cli(strings(&["a", "b"]))
            .unwrap_err()
            .contains("one source"));
        assert!(parse_pack_cli(strings(&["--nope", "a"]))
            .unwrap_err()
            .contains("unknown option"));
    }

    #[test]
    fn a_missing_source_is_an_error_from_the_abi() {
        let tmp = std::env::temp_dir().join("tension-pack-cli-test");
        let cli = PackCli {
            source: tmp.join("does-not-exist"),
            out: tmp.join("out.tns"),
        };
        let err = tension_core::res::pack(&cli.source, &cli.out).unwrap_err();
        assert_eq!(err.to_string().contains("ENOENT"), true, "{err}");
    }

    #[test]
    fn duplicate_paths_across_paks_are_rejected() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tension-res")
            .join("test")
            .join("fixtures")
            .join("minimal.sidf");
        let a = ResourceSet::load_file(&fixture).expect("a loads");
        let b = ResourceSet::load_file(&fixture).expect("b loads");
        assert!(check_pak_conflicts(&[&a]).is_ok());
        let err = check_pak_conflicts(&[&a, &b]).unwrap_err();
        assert!(err.contains("duplicate path `/hello.txt`"), "{err}");
    }
}
