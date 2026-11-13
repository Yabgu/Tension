//! The sandbox: a second guest in the same process, and the bounds on it.
//!
//! **What this is for.** Pass 2's destination is an editor that compiles the
//! user's game and runs it inside its own viewport. That needs a guest the
//! running guest did not create — a second `Store` on the same `Engine`, with its
//! own memory, its own session and its own limits, driven by the host. This
//! module is that guest: the thing `tension::dev.run` will point at, built and
//! tested here so slice 3 adds verbs to something that already boots.
//!
//! **What it does not do yet.** No `tension::dev` verb exists, so nothing but a
//! test can open a sandbox. There is no record forwarding, no frame copy, no
//! input ownership and no run registry — those are slices 3 to 5. A sandboxed
//! guest today can be instantiated, have its entrypoint called, and be observed.
//!
//! # `GuestState`, and where each field of the plan lives
//!
//! The plan lists `GuestState` as *arena, res+write, args+pending, session,
//! scheduler, posting, render2d: Option, input, depth*. Six of those are already
//! per-guest by construction, because every guest has its own `Store` and every
//! `Store` has its own `HostState`:
//!
//! | from the plan | where it lives | why not a second copy |
//! | --- | --- | --- |
//! | arena | `HostState::arena` (inside this guest's store) | it *is* the guest's memory; a copy would be a second handle to the same `Memory` |
//! | res + write root | `HostState::res`, `HostState::write_root` | shared by `Arc` with the outer guest on purpose — one mount table, two readers |
//! | args + pending | `HostState::args`, `HostState::pending` | per store already |
//! | session | [`GuestState::session`] | taken out of the store by every verb that runs one, so the host needs its own handle |
//! | scheduler + posting | `HostState::scheduler`, `HostState::posting` | per store already |
//! | render2d | `HostState::render2d`, in [`Mode::Capture`] | one `Render2dState` per guest; the host reads its records through `store.data()` rather than through a second owner |
//! | input | [`GuestState::input`] | the adapter is a process singleton, so what a guest owns is a *claim*, not the adapter |
//! | depth | [`GuestState::depth`] | host-side bookkeeping about nesting, which no verb writes |
//!
//! `render2d: Option` in the plan is the **canvas**, not the state:
//! `Render2dState::canvas()` is `None` until the guest opens one. Two owners of
//! one `Render2dState` would be a bug, and the field is where the verbs can reach
//! it.
//!
//! # The singleton constraint, made real
//!
//! `host/mod.rs` lists what may exist once per process. A sandboxed guest gets
//! **none** of them. Its `HostState` is built by `HostState::new_nested`, which
//! takes the headless audio adapter, the stub AI adapter and a capture-mode
//! renderer — so opening ten sandboxes opens zero audio devices, zero windows and
//! zero GPU devices. That is not an optimisation: a second cpal `Stream` on ALSA
//! and a second GPU device on one window are the two failures the list exists to
//! prevent.
//!
//! # The bounds
//!
//! Three, and each is enforced by a mechanism rather than by vigilance:
//!
//! * **Memory** — [`MemoryBudget`] as the store's `ResourceLimiter`. A guest that
//!   asks for more than its budget is refused at the allocation, not audited
//!   afterwards.
//! * **Time** — a [`Watchdog`] thread advances the engine's epoch every
//!   [`TICK`], and the sandboxed store's deadline is [`TICKS_BEFORE_TRAP`] ticks.
//!   wasmtime's own documentation says the deadline check cannot be avoided by
//!   malicious code, which is what makes this a bound rather than a hope.
//! * **Depth** — [`MAX_DEPTH`] nested guests, refused with `-ELOOP` beyond. A
//!   guest that can spawn a guest that can spawn a guest is a fork bomb with
//!   extra steps.
//!
//! **Provisional.** The tick, the depth cap and the budget are alpha decisions
//! with no measurement behind them yet; they are configuration-shaped so the
//! numbers can move without moving the mechanism.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{bail, Result};
use wasmtime::{Engine, Module, ResourceLimiter};

use crate::host::guest::Kind;
use crate::host::{GuestHost, HostConfig};

/// How often the watchdog advances the engine's epoch. **PROVISIONAL.**
pub(crate) const TICK: Duration = Duration::from_millis(20);

/// Epoch ticks a sandboxed guest may run before it traps, so a run may last
/// about `TICK * TICKS_BEFORE_TRAP`. **PROVISIONAL.**
pub(crate) const TICKS_BEFORE_TRAP: u64 = 8;

/// How deep nesting may go. Depth 1 is the editor's own game; 5 is refused.
pub(crate) const MAX_DEPTH: u32 = 4;

/// A sandboxed guest's linear-memory ceiling.
///
/// Implements [`ResourceLimiter`] so the refusal happens inside `memory.grow`
/// and at instantiation, where the allocation is actually made. `None` is
/// unlimited, which is what the outer guest gets: it is not sandboxed, and
/// imposing a budget on it would be a policy nobody asked for.
pub(crate) struct MemoryBudget {
    limit: Option<usize>,
}

impl MemoryBudget {
    /// A budget of `bytes`, rounded down to a whole page.
    pub(crate) fn of_bytes(bytes: usize) -> Self {
        const PAGE: usize = 65536;
        Self {
            limit: Some((bytes / PAGE) * PAGE),
        }
    }

    /// The limit, for a log line or a test.
    pub(crate) fn limit(&self) -> Option<usize> {
        self.limit
    }
}

impl Default for MemoryBudget {
    fn default() -> Self {
        Self { limit: None }
    }
}

impl ResourceLimiter for MemoryBudget {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> Result<bool> {
        Ok(self.limit.is_none_or(|limit| desired <= limit))
    }

    fn table_growing(&mut self, _current: u32, _desired: u32, _maximum: Option<u32>) -> Result<bool> {
        // Tables are bounded by the module's own declarations in this tree —
        // no guest grows one at run time (the session's function table is
        // fixed at instantiation). Refusing here would be a limit with no
        // measured reason, so it is deliberately absent rather than generous.
        Ok(true)
    }
}

/// A sandboxed guest's claim on the input adapter.
///
/// The adapter is a process singleton (`tension-input/src/adapter.cpp` keeps its
/// state in a function-local static and registers one event layer per process),
/// so a nested guest cannot own it: the outer guest does. What the nested guest
/// gets is this record of the fact, which slice 5 turns into the ownership flip
/// (`owner: Option<run_id>`) when Stop and Play move it.
///
/// **Provisional**, like the rest of the timing story: an input bridge that is
/// always "not mine" is honest for a slice in which nothing can move ownership.
pub(crate) struct InputBridge {
    /// Set by slice 5's ownership flip. Nothing writes it yet, and that is the
    /// point: a nested guest's claim exists and is false.
    #[allow(dead_code)]
    owns: bool,
}

impl InputBridge {
    /// A nested guest's bridge: attached to nothing, because the adapter belongs
    /// to the guest that owns the window.
    pub(crate) fn nested() -> Self {
        Self { owns: false }
    }

    /// Whether this guest currently receives input events.
    #[allow(dead_code)]
    pub(crate) fn owns_input(&self) -> bool {
        self.owns
    }
}

/// The thread that makes the epoch a bound rather than a suggestion.
///
/// It advances the shared `Engine`'s epoch on a fixed tick. Every store sharing
/// that engine sees the same counter, which is why the *stores* set deadlines
/// rather than the watchdog setting them: the outer guest's deadline is
/// `u64::MAX` (`GuestHost::new`) and never fires, while a sandboxed guest's is
/// [`TICKS_BEFORE_TRAP`] ticks away.
///
/// `Drop` stops and joins the thread. A watchdog that outlived its sandbox would
/// keep bumping a counter nobody watches, and the next sandbox's deadline would
/// arrive early — a bug that would look like flakiness.
pub(crate) struct Watchdog {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    fn start(engine: &Engine) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let engine = engine.clone();
        let thread = std::thread::Builder::new()
            .name("tension-watchdog".to_string())
            .spawn(move || {
                while !flag.load(Ordering::Relaxed) {
                    std::thread::sleep(TICK);
                    engine.increment_epoch();
                }
            })
            .expect("the watchdog thread must be spawnable");
        Self {
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            // A join that cannot fail: the loop checks `stop` between sleeps and
            // holds no lock. Ignoring the result keeps a panicking watchdog from
            // turning a teardown into a second panic.
            let _ = thread.join();
        }
    }
}

/// One sandboxed guest: its host bundle, its claim on input, and its depth.
///
/// # This shape is for SYNCHRONOUS execution
///
/// **`GuestState` is `!Send`, and so is `Sandbox`.** A nested guest runs on the
/// thread that called [`Sandbox::run_batch`] or [`Sandbox::call_entrypoint`] —
/// the main thread — inside the host's own call. Nothing here has been made
/// thread-safe and nothing here should be assumed to be.
///
/// That is not an accident of this wrapper: it is the type it wraps. `HostState`
/// is `!Send` for six independent reasons, which the compiler names if a
/// `Send` bound is applied to it:
///
/// * `Box<dyn AudioAdapter>` — the trait has no `Send` bound, so the *type* is
///   `!Send` even when the value is the silent adapter.
/// * `Box<dyn AiAdapter>` — same.
/// * `Render2dState` — through `sdl3`'s own no-Send marker
///   (`PhantomData<*mut ()>`, `sdl3-0.22.0/src/sdl3/sdl.rs:180`) reached by its
///   `VideoSubsystem` field, and through `*mut SDL_GPUTexture`. A **capture**
///   renderer holds no device, but the type is `!Send` regardless of the value.
/// * `HostWindow` — `*mut c_void` over `SDL_Window`.
/// * `Render2dState` again, through `AdapterCall`'s `*const TensionAdapter`.
///
/// There is no `unsafe impl Send` anywhere on that path. The five in the tree
/// (`FrozenApi`, `AdapterCtx`, `HostHandle`, `ResourceSet`, `NativeComparator`)
/// all cover narrower things and none of them covers `HostState`, the SDL
/// device, or a cpal stream.
///
/// **What changes when threading lands** — named here so it is designed rather
/// than discovered. A background guest needs its state to be `Send`, which means
/// either a `HostState` split (a device/singleton half that stays on the main
/// thread, and a data half that moves) or a nested-only state type that never
/// holds `Render2dState` at all — the capture records are plain bytes and could
/// live in a `Send` buffer beside it. Both are shape changes to this wrapper,
/// which is exactly why the wrapper is one type and not the plan's field list
/// spread through `HostState`.
///
/// **What slice 2 does not deliver:** a nested guest that does not block the
/// editor. The editor's frame is chrome + the nested frame, run in sequence. That
/// is acceptable for the demo — a 2D game's frame is small — but it is a
/// different user-facing property from "the UI stays responsive", and it should
/// be named as such rather than assumed.
pub(crate) struct GuestState {
    host: GuestHost,
    input: InputBridge,
}

impl GuestState {
    /// This guest's claim on the input adapter.
    ///
    /// Not read by anything but a test today: `dev.run` cannot move ownership
    /// until slice 5 introduces `owner: Option<run_id>`. Kept rather than
    /// deleted because the *claim* is what slice 5 flips, and a struct that
    /// appears from nowhere in the slice that needs it is a shape nobody
    /// reviewed.
    #[allow(dead_code)]
    pub(crate) fn input(&self) -> &InputBridge {
        &self.input
    }

    /// Everything the guest has printed, when the host asked for capture.
    pub(crate) fn out(&self) -> &[u8] {
        self.host
            .store
            .data()
            .captured_out
            .as_deref()
            .unwrap_or(&[])
    }

    /// The guest's store, for a slice that needs to reach it directly.
    ///
    /// Read by the sandbox's own tests, which assert on the store's `HostState`
    /// (`guest_depth`, the capture renderer, the budget). A verb reaches the same
    /// state through `Caller::data()`, so nothing in the host calls this yet.
    #[allow(dead_code)]
    pub(crate) fn store(&self) -> &wasmtime::Store<crate::HostState> {
        &self.host.store
    }

    /// The ceiling this guest runs under, or `None` for unlimited.
    pub(crate) fn budget_limit(&self) -> Option<usize> {
        self.host.store.data().memory_budget.limit()
    }

    /// Set the linear-memory ceiling this guest runs under.
    ///
    /// Separate from `Sandbox::open` because the caller knows the budget and the
    /// sandbox does not: `dev.run` applies one policy, a test applies another,
    /// and neither belongs baked into the constructor.
    pub(crate) fn budget(&mut self, bytes: usize) {
        // (`MemoryBudget::of_bytes` rounds down to a page; the run verb logs the
        // result, which is why `limit()` is read there rather than here.)
        self.host.store.data_mut().memory_budget = MemoryBudget::of_bytes(bytes);
    }
}

/// One entry in the host's run table: a sandboxed guest and what became of it.
///
/// **`HashMap<i32, GuestRun>`, not a single slot.** Two runs must be able to
/// coexist — the editor's Play Mode can restart a game before the previous one's
/// output has been read, and a registry with one slot would either refuse the
/// second or silently discard the first's output. The id is the guest's handle;
/// the table is the host's.
///
/// **A run stays in the table after it finishes**, because its output is the
/// thing the caller came for (`dev.out`) and the caller may read it more than
/// once — a probe, then a fill. Removing it at completion would make every read
/// a race against the guest's own exit.
pub(crate) struct GuestRun {
    /// The depth this run's guest executes at. `dev.run` from a guest at depth
    /// `d` produces a run at `d + 1`, which is what [`MAX_DEPTH`] bounds.
    pub(crate) depth: u32,
    pub(crate) sandbox: Sandbox,
}

/// What happened to a batch run.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BatchOutcome {
    /// Everything the guest printed, in order.
    pub(crate) out: Vec<u8>,
}

/// A guest the host runs in isolation: module, store, bounds, watchdog.
pub(crate) struct Sandbox {
    guest: GuestState,
    module: Module,
    /// The instantiated guest, once `call_entrypoint` has run.
    ///
    /// Kept for the same reason `HostState` keeps an arena handle: a test, and
    /// slice 4's record path, need to read the guest's memory *after* a call, and
    /// an `Instance` is only obtainable from `instantiate`.
    instance: Option<wasmtime::Instance>,
    /// Held for its `Drop`, which stops and joins the ticker. Never read.
    #[allow(dead_code)]
    watchdog: Watchdog,
}

impl Sandbox {
    /// Open a guest from `config`, one level deeper than `parent_depth`.
    ///
    /// The module comes from the process's cache, so opening the same guest twice
    /// compiles it once. The store gets the memory budget and the epoch deadline
    /// before it is instantiated — the only order that works, because instantiation
    /// is where the initial memory is allocated.
    pub(crate) fn open(config: &HostConfig, parent_depth: u32) -> Result<Self> {
        let depth = parent_depth + 1;
        if depth > MAX_DEPTH {
            bail!(
                "-ELOOP: nesting depth {depth} exceeds {MAX_DEPTH}; a guest may not open \
                 another guest that deep"
            );
        }

        let host = GuestHost::build(config, Kind::Nested)?;
        let module = host.module.clone();
        let mut host = host;

        // Ordered deliberately: the limiter and the deadline are properties of
        // the store, and both are read during instantiation.
        host.store.limiter(|state| &mut state.memory_budget);
        host.store.set_epoch_deadline(TICKS_BEFORE_TRAP);

        // The nested store's depth, so a verb it calls computes the right
        // grandchild depth without threading the number through every call.
        host.store.data_mut().guest_depth = depth;

        let watchdog = Watchdog::start(&config.engine);
        Ok(Self {
            guest: GuestState {
                host,
                input: InputBridge::nested(),
            },
            module,
            instance: None,
            watchdog,
        })
    }

    /// Instantiate the guest and call its `_start_game`, exactly as the host does
    /// for the process's own guest.
    ///
    /// Returns `-ELOOP`-class errors as `Err`; a trap (the watchdog's epoch, an
    /// `unreachable`, a bad call) comes back as `Err` too, with wasmtime's own
    /// message attached.
    pub(crate) fn call_entrypoint(&mut self) -> Result<()> {
        let Self {
            guest,
            module,
            instance,
            ..
        } = self;
        let created = guest.host.linker.instantiate(&mut guest.host.store, module)?;
        let entry = created.get_typed_func::<(), ()>(&mut guest.host.store, "_start_game")?;
        entry.call(&mut guest.host.store, ())?;
        *instance = Some(created);
        Ok(())
    }

    /// The guest's exported `memory`, after `call_entrypoint`.
    ///
    /// A test reads what a guest wrote here; slice 4's `read` will copy records
    /// through the same handle.
    #[allow(dead_code)]
    pub(crate) fn memory(&mut self) -> Option<wasmtime::Memory> {
        let instance = self.instance?;
        instance
            .get_export(&mut self.guest.host.store, "memory")
            .and_then(|export| export.into_memory())
    }

    /// One `i32` the guest left at `offset`, for a test's assertions.
    #[allow(dead_code)]
    pub(crate) fn read_i32(&mut self, offset: usize) -> Option<i32> {
        let memory = self.memory()?;
        let data = memory.data(&self.guest.host.store);
        (offset + 4 <= data.len()).then(|| {
            i32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ])
        })
    }

    /// Run a batch guest to completion and return what it printed.
    ///
    /// "Batch" is the whole shape of a Pass 2 nested guest: it runs, it prints,
    /// it returns. There is no frame loop and no record path yet — those need
    /// `dev.frame`, which is slice 4.
    pub(crate) fn run_batch(&mut self) -> Result<BatchOutcome> {
        self.call_entrypoint()?;
        Ok(BatchOutcome {
            out: self.guest.out().to_vec(),
        })
    }

    /// The guest this sandbox holds.
    pub(crate) fn guest(&self) -> &GuestState {
        &self.guest
    }

    /// The guest, mutably — for setting its budget before it runs.
    pub(crate) fn guest_mut(&mut self) -> &mut GuestState {
        &mut self.guest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;
    use wasmtime::Config;

    /// A unique scratch path per test, removed on drop.
    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let mut dir = std::env::temp_dir();
            dir.push(format!(
                "tension-sandbox-{name}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).expect("a scratch directory");
            Self { dir }
        }

        fn write(&self, name: &str, contents: &str) -> String {
            let path = self.dir.join(name);
            let mut file = std::fs::File::create(&path).expect("a scratch file");
            file.write_all(contents.as_bytes()).expect("written");
            path.to_string_lossy().to_string()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A configuration for one sandbox, with the engine the host builds.
    ///
    /// The engine configuration is the same one `main` uses, epoch interruption
    /// included: a test against a differently-configured engine would prove
    /// something about a runtime this tree does not ship.
    fn config(guest_path: String) -> HostConfig {
        let mut engine_config = Config::new();
        engine_config.epoch_interruption(true);
        let engine = Engine::new(&engine_config).expect("an engine");
        HostConfig {
            module_cache: Arc::new(crate::host::module_cache::ModuleCache::default()),
            engine,
            args: Vec::new(),
            guest_path,
            res: Arc::new(Mutex::new(tension_core::res::MountTable::new())),
            write_root: None,
            capabilities: Vec::new(),
            session_open: false,
            session_callbacks: None,
            post_test_events: false,
        }
    }

    /// Boots, calls `_start_game`, returns.
    const SIMPLE: &str = r#"
        (module
          (func (export "_start_game")))
    "#;

    /// Prints "hello" through `tension::io.print` and returns.
    const BATCH: &str = r#"
        (module
          (import "tension::io" "print" (func $print (param i32 i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "hello")
          (func (export "_start_game")
            (call $print (i32.const 0) (i32.const 5))))
    "#;

    /// Never returns, and never calls the host — the case a cooperative check
    /// inside a verb could not catch.
    const SPIN: &str = r#"
        (module
          (func (export "_start_game")
            (loop $forever
              br $forever)))
    "#;

    /// Calls `tension::dev.run` twice on the path baked in at byte 0, storing
    /// both returned ids at 64 and 68. Two runs from one guest, so the run table
    /// has to hold both at once.
    fn run_twice(path: &str) -> String {
        format!(
            r#"
        (module
          (import "tension::dev" "run" (func $run (param i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "{path}")
          (func (export "_start_game")
            (i32.store (i32.const 64) (call $run (i32.const 0) (i32.const {len})))
            (i32.store (i32.const 68) (call $run (i32.const 0) (i32.const {len})))))
        "#,
            len = path.len()
        )
    }

    /// Runs a guest, then asks `tension::dev.out` for its output twice — a probe
    /// (`cap = 0`) and then a fill — storing at 64 the run id, at 68 the probed
    /// length, at 72 the fill's return value, and at 100 the output bytes.
    fn run_then_read_out(path: &str) -> String {
        format!(
            r#"
        (module
          (import "tension::dev" "run" (func $run (param i32 i32) (result i32)))
          (import "tension::dev" "out" (func $out (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "{path}")
          (func (export "_start_game")
            (local $id i32)
            (local.set $id (call $run (i32.const 0) (i32.const {len})))
            (i32.store (i32.const 64) (local.get $id))
            (i32.store (i32.const 68) (call $out (local.get $id) (i32.const 0) (i32.const 0)))
            (i32.store (i32.const 72)
              (call $out (local.get $id) (i32.const 100) (i32.const 16)))))
        "#,
            len = path.len()
        )
    }

    /// Calls `tension::dev.run` once and stores the return value at 64 — the
    /// errno, when the call is refused.
    fn run_once(path: &str) -> String {
        format!(
            r#"
        (module
          (import "tension::dev" "run" (func $run (param i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "{path}")
          (func (export "_start_game")
            (i32.store (i32.const 64) (call $run (i32.const 0) (i32.const {len})))))
        "#,
            len = path.len()
        )
    }

    /// Four pages of linear memory, against a budget of two.
    const HUNGRY: &str = r#"
        (module
          (memory (export "memory") 4)
          (func (export "_start_game")))
    "#;

    #[test]
    fn nested_guest_boots_and_calls_entrypoint() {
        let scratch = Scratch::new("boots");
        let config = config(scratch.write("guest.wat", SIMPLE));
        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        sandbox.call_entrypoint().expect("the entrypoint returns");

        // Depth is the nesting level, and the claim on input is the outer
        // guest's, not this one's.
        // The depth that *governs* : the value `dev.run` reads when it computes
        // a grandchild's depth. It lives in the store's state, not in a struct
        // field, so this asserts the thing a verb would see.
        assert_eq!(sandbox.guest().store().data().guest_depth, 1);
        assert!(!sandbox.guest().input().owns_input());
        // A nested guest must not own a GPU device: the window and the device are
        // the outer guest's, and a second one is what the singleton list forbids.
        // The mode is the statement; this is the state.
        assert!(sandbox.guest().store().data().render2d.is_capture());
        assert!(!sandbox.guest().store().data().render2d.has_device());
    }

    #[test]
    fn batch_guest_finishes_and_returns_output() {
        let scratch = Scratch::new("batch");
        let config = config(scratch.write("guest.wat", BATCH));
        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        let outcome = sandbox.run_batch().expect("the guest runs to completion");
        assert_eq!(outcome.out, b"hello");
    }

    #[test]
    fn watchdog_stops_an_infinite_loop() {
        // The bound. The guest loops with no host call and no yield, so nothing
        // but the epoch can stop it; the deadline is TICKS_BEFORE_TRAP ticks of
        // TICK each, and the assertion is a wall clock well above that and far
        // below "hangs the suite".
        const BOUND: Duration = Duration::from_secs(5);

        let scratch = Scratch::new("spin");
        let config = config(scratch.write("guest.wat", SPIN));
        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");

        let started = std::time::Instant::now();
        let outcome = sandbox.call_entrypoint();
        let elapsed = started.elapsed();

        let error = outcome.expect_err("an infinite loop must trap, not return");
        let message = format!("{error:#}");
        // The trap *reason*, not the whole error: "interrupt" also appears in a
        // backtrace at some point, and an assertion satisfied by a symbol name
        // would be no assertion at all.
        let reason = message
            .lines()
            .find(|line| line.contains("wasm trap:"))
            .unwrap_or("")
            .trim()
            .to_string();
        // Printed, not only asserted: with `--nocapture` this is the measured
        // latency, which is the evidence that the bound is real rather than that
        // the loop happened to end.
        println!("watchdog: trapped after {elapsed:?} with `{reason}`");
        assert!(
            reason.contains("interrupt"),
            "the trap must be the epoch deadline, not something else: `{reason}`"
        );
        assert!(
            elapsed < BOUND,
            "the watchdog must stop the guest within {BOUND:?}, took {elapsed:?}"
        );
    }

    #[test]
    fn limiter_refuses_a_guest_over_budget() {
        let scratch = Scratch::new("hungry");
        let config = config(scratch.write("guest.wat", HUNGRY));
        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        // Two pages: the guest's own declaration asks for four, so the refusal
        // happens at instantiation, before any code runs.
        sandbox.guest.host.store.data_mut().memory_budget = MemoryBudget::of_bytes(2 * 65536);
        assert_eq!(
            sandbox.guest.host.store.data().memory_budget.limit(),
            Some(2 * 65536)
        );

        // Negative control: the *same module* with no budget boots. Without this
        // the refusal below could be the module's own fault — a typo in the WAT,
        // a missing export — and the test would still be green.
        let mut unbudgeted = Sandbox::open(&config, 0).expect("the control sandbox opens");
        unbudgeted
            .call_entrypoint()
            .expect("without a budget, the same guest boots");

        let error = sandbox
            .call_entrypoint()
            .expect_err("a guest over its memory budget must be refused");
        let message = format!("{error:#}").to_lowercase();
        println!("limiter: refused with: {message}");
        assert!(
            message.contains("memory") && message.contains("limit"),
            "the refusal must name the memory limit: {message}"
        );
        assert!(
            message.contains("4 pages"),
            "the refusal must be about the 4 pages the guest asked for: {message}"
        );
    }

    #[test]
    fn second_store_reuses_compiled_module() {
        let scratch = Scratch::new("reuse");
        let path = scratch.write("guest.wat", SIMPLE);
        let config = config(path.clone());
        let cache = Arc::clone(&config.module_cache);

        let mut first = Sandbox::open(&config, 0).expect("the first sandbox opens");
        first.call_entrypoint().expect("the first guest runs");
        assert_eq!(cache.compiles(), 1, "the first guest compiles the module once");

        let mut second = Sandbox::open(&config, 0).expect("the second sandbox opens");
        second.call_entrypoint().expect("the second guest runs");
        assert_eq!(
            cache.compiles(),
            1,
            "a second store must reuse the compiled module, not recompile it"
        );

        // Two stores, two instances: the reuse is of the *compiled module*, and
        // each store still has its own guest.
        assert!(!std::ptr::eq(
            first.guest().store().data() as *const _,
            second.guest().store().data() as *const _,
        ));

        // Negative control: the counter must be able to move, or the assertion
        // above is a statement about a counter that is stuck at one. A different
        // file at the same path is a miss — the file's size differs, so the
        // fingerprint does even when the modification time does not.
        let changed = format!("{SIMPLE}\n;; a longer file, so the fingerprint changes\n");
        scratch.write("guest.wat", &changed);
        let mut third = Sandbox::open(&config, 0).expect("the third sandbox opens");
        third.call_entrypoint().expect("the third guest runs");
        assert_eq!(
            cache.compiles(),
            2,
            "a changed file must recompile: the counter has to be live"
        );
    }

    #[test]
    fn restart_reinstantiates_from_cached_module() {
        let scratch = Scratch::new("restart");
        let target = scratch.write("game.wat", BATCH);
        let outer = scratch.write("outer.wat", &run_twice(&target));
        let config = config(outer);
        let cache = Arc::clone(&config.module_cache);

        // Measured from before the sandbox opens: `Sandbox::open` itself
        // compiles the outer guest, so a baseline taken after it would count one
        // module already and the arithmetic would be off by exactly that one.
        let before = cache.compiles();
        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        sandbox.run_batch().expect("the first pass runs");
        let after_first = cache.compiles();
        assert_eq!(
            after_first - before,
            2,
            "the first pass compiles two modules: the outer guest and the one it runs"
        );

        // Run the same outer guest again. It calls `dev.run` twice more, so the
        // target guest is instantiated twice more — and compiled zero more times.
        sandbox.run_batch().expect("the second pass runs");
        assert_eq!(
            cache.compiles(),
            after_first,
            "restarting must reuse the compiled module: neither guest recompiles"
        );

        // The two runs of the second pass are distinct entries: a restart is a
        // fresh store, not a reset of the previous one.
        let table = &sandbox.guest().store().data().runs;
        assert_eq!(table.len(), 4, "four runs in total, two per pass");

        // And the guests really did run: a run id is a handle to output.
        let outs: Vec<usize> = table
            .values()
            .map(|run| run.sandbox.guest().out().len())
            .collect();
        assert_eq!(outs, vec![5, 5, 5, 5], "each run printed `hello`");
    }

    #[test]
    fn two_runs_coexist_in_the_registry() {
        let scratch = Scratch::new("coexist");
        let target = scratch.write("game.wat", BATCH);
        let outer = scratch.write("outer.wat", &run_twice(&target));
        let config = config(outer);

        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        sandbox.run_batch().expect("the guest runs");

        let first = sandbox.read_i32(64).expect("the first id landed");
        let second = sandbox.read_i32(68).expect("the second id landed");
        assert!(first > 0 && second > 0, "both runs started: {first}, {second}");
        assert_ne!(first, second, "two runs are two handles, not one reused");

        let table = &sandbox.guest().store().data().runs;
        assert_eq!(table.len(), 2, "both runs are still in the registry");
        assert!(
            table.contains_key(&first) && table.contains_key(&second),
            "the registry is keyed by the ids the guest was given"
        );
        // Ids start at 1, so no valid handle is ever 0 — an uninitialised
        // variable cannot be mistaken for a run.
        assert_eq!(sandbox.guest().store().data().next_run_id, 3);
    }

    #[test]
    fn depth_five_is_refused_with_eloop() {
        let scratch = Scratch::new("depth");
        // The guest this test lets itself spawn is irrelevant: the refusal has to
        // happen before it is opened.
        let target = scratch.write("game.wat", SIMPLE);
        let outer = scratch.write("outer.wat", &run_once(&target));
        let config = config(outer);

        // Depth 4 is the last level that may exist, so this sandbox is legal...
        let mut sandbox = Sandbox::open(&config, MAX_DEPTH - 1).expect("depth 4 opens");
        sandbox.run_batch().expect("the guest runs");
        assert_eq!(sandbox.guest().store().data().guest_depth, MAX_DEPTH);

        // ...and the run it asks for would be the fifth.
        let refused = sandbox.read_i32(64).expect("the return value landed");
        assert_eq!(refused, -40, "-ELOOP, not -EINVAL or a generic failure");
        assert!(
            sandbox.guest().store().data().runs.is_empty(),
            "a refused run must not leave an entry behind"
        );

        // Negative control: the same guest one level up starts a run normally,
        // so the -ELOOP above is the depth rule and not a broken fixture.
        let mut shallower = Sandbox::open(&config, MAX_DEPTH - 2).expect("depth 3 opens");
        shallower.run_batch().expect("the guest runs");
        let started = shallower.read_i32(64).expect("the return value landed");
        assert!(
            started > 0,
            "the same fixture at depth 3 starts a run: {started}"
        );
    }

    #[test]
    fn dev_out_probes_then_fills() {
        let scratch = Scratch::new("out");
        let target = scratch.write("game.wat", BATCH);
        let outer = scratch.write("outer.wat", &run_then_read_out(&target));
        let config = config(outer);

        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        sandbox.run_batch().expect("the guest runs");

        let id = sandbox.read_i32(64).expect("the run id landed");
        assert!(id > 0, "the target guest started: {id}");

        // The probe: `cap = 0` asks how many bytes there are, without writing.
        let probed = sandbox.read_i32(68).expect("the probe returned");
        assert_eq!(probed, 5, "the probe answers the length of `hello`");

        // The fill: the same length, having actually written the bytes.
        let filled = sandbox.read_i32(72).expect("the fill returned");
        assert_eq!(filled, 5, "the fill writes and reports the same length");

        // And the bytes are the guest's own output, at the offset it asked for.
        let memory = sandbox.memory().expect("the guest exports a memory");
        let store = sandbox.guest().store();
        let bytes: Vec<u8> = memory.data(&store)[100..105].to_vec();
        assert_eq!(bytes, b"hello", "the fill wrote the guest's output");
    }

    #[test]
    fn dev_out_refuses_an_unknown_run_and_a_short_buffer() {
        let scratch = Scratch::new("out-err");
        let target = scratch.write("game.wat", BATCH);
        // Runs the target, then makes the two refusals `dev.out` can produce:
        // a buffer too small for the output, and an id that is not a run.
        let path = format!("{target}");
        let outer = scratch.write(
            "outer.wat",
            &format!(
                r#"
        (module
          (import "tension::dev" "run" (func $run (param i32 i32) (result i32)))
          (import "tension::dev" "out" (func $out (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "{path}")
          (func (export "_start_game")
            (local $id i32)
            (local.set $id (call $run (i32.const 0) (i32.const {len})))
            (i32.store (i32.const 64) (local.get $id))
            (i32.store (i32.const 68) (call $out (local.get $id) (i32.const 100) (i32.const 2)))
            (i32.store (i32.const 72) (call $out (i32.const 99) (i32.const 0) (i32.const 0)))))
        "#,
                len = path.len()
            ),
        );
        let config = config(outer);
        let mut sandbox = Sandbox::open(&config, 0).expect("the sandbox opens");
        sandbox.run_batch().expect("the guest runs");
        assert!(sandbox.read_i32(64).unwrap() > 0, "the target started");

        assert_eq!(
            sandbox.read_i32(68),
            Some(-28),
            "a 2-byte buffer for 5 bytes of output is -ENOSPC, not a truncation"
        );
        assert_eq!(
            sandbox.read_i32(72),
            Some(-9),
            "an unknown run id is -EBADF, not a length of zero"
        );
    }
}
