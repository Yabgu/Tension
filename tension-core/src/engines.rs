//! The engine worlds: one process, one sandbox, and the rule that keeps them
//! apart.
//!
//! # Why there are exactly two
//!
//! An `Engine` is a **frozen `Config` plus a compiled-code cache**, and a
//! `Module` is bound to the engine that compiled it. So the number of engines a
//! process needs is the number of *distinct capability worlds* it runs guests
//! in — not the number of guests. One engine per guest is the anti-pattern
//! `host/config.rs` argues against: it would compile a shared module once per
//! guest, which is precisely the cost `tension::dev.compile` exists to avoid.
//!
//! The two worlds differ in what they can compile:
//!
//! | world | exceptions | function references | stack switching | epoch |
//! | --- | --- | --- | --- | --- |
//! | [`WorldKind::Process`] | default | default | **no** | **no** |
//! | [`WorldKind::Sandbox`] | on | on | **on** ([`crate::threads::enable`]) | **on** |
//!
//! **Both columns are decisions the user made** (2026-11-16): option (a) of
//! `docs/plan/pass-2.md`'s "One engine, not two" for the engines, and then the
//! epoch polarity — the sandbox world is bounded, the process world is not.
//!
//! # "Can't", not "probably won't"
//!
//! The boundary is enforced by the compiler, not by a policy: a module that
//! contains `cont.new`/`suspend` **fails to compile** on the process world,
//! because the feature is off in the `Config` that built it. Whatever the guest
//! later does, it cannot suspend there. `tests/engine_worlds.rs` asserts the
//! refusal and quotes wasmtime's own error, which is why the test is a
//! structural one rather than a declaration of intent.
//!
//! # The epoch belongs to the sandbox world alone
//!
//! **`epoch_interruption` is off in the process world and on in the sandbox
//! world**, and the asymmetry is one match arm each (`engine_config`) rather than
//! a shared preamble. Two consequences, and both are wanted:
//!
//! * **The process's own guest carries no deadline checks.** They are absent from
//!   the compiled code, not present-and-ignored. That is what the north star says
//!   — the guest owns the world and determines time, the host owns the machine —
//!   and it retires a capability the tree never used while paying for it in every
//!   loop iteration.
//! * **A root guest that loops forever freezes the process, with no recovery.**
//!   SIGINT is the only exit. Stated rather than softened: it is the price of the
//!   sentence above, and it is a real price. A root guest that wants a bound
//!   implements one itself, which is what "the guest owns its loop" means.
//!
//! The sandbox world keeps the epoch because a bound on a guest the *host* started
//! is a different claim from a bound on the guest the process *is*: `dev.run`
//! starts a guest from a button press, and a run that hangs must be stoppable by
//! the thing that pressed it.
//!
//! `set_epoch_deadline` on a store whose engine has no epoch interruption is
//! **silently inert** — measured, not assumed: no panic, no warning, the call
//! returns and the guest runs (100,000 iterations complete on such a store even
//! after an `increment_epoch`). That is why `host/guest.rs` no longer arms the
//! process store at all: a call that reads as a guarantee and does nothing is
//! worse than absent code, which is the same rule the env-var audit applies to a
//! release binary.
//!
//! # Tickers are per world, and that is a fix rather than a detail
//!
//! A watchdog ticks **its world's** epoch, and one epoch counter is shared by
//! every store in that world. So there must be at most one ticker per world:
//! with one ticker per *sandbox*, two live sandboxes advanced one counter twice
//! per [`TICK`] and each guest's budget arrived in half the wall time it was
//! promised. Measured before the fix, on this tree: a guest that should have
//! trapped after 160 ms trapped after 81 ms once a second sandbox existed.
//! [`World::ticker`] is reference-counted for exactly this reason — the ticker
//! starts with the first sandbox in the world and stops when the last one drops.
//! The process world has **no ticker field at all** ([`World::ticker`] answers
//! `None`), because there is no epoch there to advance.
//!
//! # Adding a third world
//!
//! It is a reviewed code change: a variant on [`WorldKind`], a field on
//! [`Worlds`], an arm in [`WorldKind::for_depth`] and in [`engine_config`]. There
//! is no count to update and no index arithmetic — which is deliberate, because
//! `2` in a source line is a number a reader cannot check against anything.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use wasmtime::{Config, Engine};

/// How often a [`Watchdog`] advances its world's epoch. **PROVISIONAL.**
///
/// Lives here rather than in `sandbox` because it is the ticker's period, and the
/// ticker belongs to the world.
pub const TICK: Duration = Duration::from_millis(20);

/// Which capability world a guest runs in.
///
/// Chosen by **depth**, and only by depth: the process's own guest is at 0 and
/// every nested guest is below it. A config file or an environment variable
/// choosing a world would make "which engine did this guest run on" a question
/// about the machine rather than about the guest's own nesting.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum WorldKind {
    /// The process's own guest: the one the window, the device and the input
    /// adapter belong to.
    Process,
    /// A guest the host stands up inside its own: `Sandbox::open`, `dev.run`.
    /// Gets the three proposals a cooperative thread needs, and nothing that is
    /// a process singleton.
    Sandbox,
}

impl WorldKind {
    /// The world a guest at `depth` runs in. The one place the mapping lives.
    ///
    /// Depth 0 is the process's guest; anything nested is sandboxed. A third
    /// world would be a third arm here, which is why this function exists instead
    /// of `if depth == 0` at each call site.
    pub const fn for_depth(depth: u32) -> Self {
        match depth {
            0 => WorldKind::Process,
            _ => WorldKind::Sandbox,
        }
    }

    /// The name used in messages and logs.
    pub const fn name(self) -> &'static str {
        match self {
            WorldKind::Process => "process",
            WorldKind::Sandbox => "sandbox",
        }
    }
}

/// The `Config` a world is built from.
///
/// **One function, so the product and the tests cannot disagree about what a
/// world is.** `main` builds both engines through this and so does
/// `tests/engine_worlds.rs`; a test that configured its own engine would prove
/// something about a runtime this tree does not ship.
///
/// **The polarity lives in the arms, not in a preamble.** Adding a third world is
/// a reviewed code change: a variant, a field on [`Worlds`], and a third arm here
/// and in [`WorldKind::for_depth`]. A shared `config.epoch_interruption(true)`
/// above the match would give a new world the epoch without anyone saying so,
/// which is the one thing this function exists to prevent.
///
/// `debug` is the CLI's `--debug`: DWARF retention and GDB JIT registration. It
/// is the only difference between two processes rather than two worlds.
pub fn engine_config(kind: WorldKind, debug: bool) -> Config {
    let mut config = Config::new();
    config.debug_info(debug);

    match kind {
        // The process's own guest gets no proposal it does not use, and **no
        // epoch**: `epoch_interruption` is deliberately absent here, and the
        // absence is the decision rather than an omission. A reader who knows
        // wasmtime will otherwise assume a bug, so it is written down twice —
        // here and in this module's doc.
        //
        // What follows from it: the compiled guest carries no deadline checks at
        // all, and no host capability can interrupt it. A root guest that loops
        // forever freezes this process until SIGINT. That is the trade the north
        // star asks for — the guest owns its loop and determines time — and it is
        // named here so it cannot be read as an oversight.
        WorldKind::Process => {}
        // **Both**, and both are needed: `threads::enable` sets the three
        // proposals and deliberately does not touch the epoch, while a bound on a
        // guest the host started needs the epoch *and* the proposals. The epoch is
        // what a [`Watchdog`] advances and what `sandbox::arm` arms a deadline
        // against; without it the arm would be inert (measured: `set_epoch_deadline`
        // on a non-epoch engine returns normally and does nothing).
        WorldKind::Sandbox => {
            config.epoch_interruption(true);
            // Exceptions -> function references -> stack switching, in that order.
            crate::threads::enable(&mut config);
        }
    }
    config
}

/// Advances one world's epoch every [`TICK`] while it is alive.
///
/// **Only a bounded world can have one.** `start` is private to this module, the
/// only caller is [`World::ticker`], and the only world whose `ticker` field is
/// `Some` is the sandbox world — so a ticker on the process engine is not a rule
/// anyone has to remember, it is a construction this module cannot perform.
///
/// **Refcounted by whoever holds it** ([`World::ticker`] hands out the same one
/// to every sandbox in the world). Dropping the last handle stops and joins the
/// thread, so a ticker cannot outlive the guests it bounds — a leftover ticker
/// would keep bumping a counter nobody watches, and the next guest's deadline
/// would arrive early: a bug that reads as flakiness.
pub struct Watchdog {
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

/// One capability world: its engine, and — for a world that is bounded — the
/// single ticker that advances its epoch.
///
/// **The process world cannot hold a ticker**, and that is a type rather than a
/// convention: the field is `Option<TickerSlot>`, `None` for a world built without
/// an epoch, and there is no setter. A `Watchdog` needs an engine to tick; giving
/// the process world one would be giving it a guarantee it does not have.
pub struct World {
    kind: WorldKind,
    engine: Engine,
    /// `Some` only when this world's epoch is a bound.
    ticker: Option<TickerSlot>,
}

/// The one ticker for a world's epoch, or a dead handle to the last one.
///
/// `Weak` because the lifetime is the sandboxes': the ticker lives exactly as long
/// as there is a guest in this world that needs bounding, and no longer. `Mutex`
/// because `.ticker()` is reachable from `dev.run` and the type has to be `Sync`
/// even though the stores are not.
struct TickerSlot {
    live: Mutex<Weak<Watchdog>>,
}

impl World {
    fn new(kind: WorldKind, engine: Engine) -> Self {
        // The one place the presence of a ticker is decided, and it is the same
        // axis as the epoch itself: a world that compiled in no deadline checks
        // has nothing to advance.
        let ticker = match kind {
            WorldKind::Process => None,
            WorldKind::Sandbox => Some(TickerSlot {
                live: Mutex::new(Weak::new()),
            }),
        };
        Self {
            kind,
            engine,
            ticker,
        }
    }

    /// Which world this is.
    pub fn kind(&self) -> WorldKind {
        self.kind
    }

    /// A handle to the engine. `Clone` shares the engine and its code cache.
    pub fn engine(&self) -> Engine {
        self.engine.clone()
    }

    /// The ticker for this world's epoch, started on the first call — or `None`
    /// for the process world, which has no epoch and therefore nothing to tick.
    ///
    /// **One per world, shared by reference count.** Two sandboxes holding this
    /// advance one counter once per [`TICK`], which is what makes
    /// `sandbox::TICKS_BEFORE_TRAP` a wall-time budget rather than a budget that
    /// halves with every extra live guest.
    ///
    /// `None` is not a degraded case to work around: `Sandbox::open` refuses a
    /// config from any world but the sandbox's, so its caller never sees it — and
    /// if it did, a sandbox in an unbounded world is exactly what must not run.
    ///
    /// A poisoned lock is recovered rather than propagated: the critical section
    /// holds no data that a panic could have left half-written, and a guest that
    /// cannot be bounded is a worse outcome than a recovered mutex.
    pub fn ticker(&self) -> Option<Arc<Watchdog>> {
        let slot = self.ticker.as_ref()?;
        let mut live = slot
            .live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(running) = live.upgrade() {
            return Some(running);
        }
        let dog = Arc::new(Watchdog::start(&self.engine));
        *live = Arc::downgrade(&dog);
        Some(dog)
    }
}

/// The worlds this process can run guests in.
///
/// The process world is built **eagerly**: the process's own guest runs in it, so
/// there is no configuration in which it is unused. The sandbox world is built
/// **lazily**, on the first `Sandbox::open` / `dev.run`: an example that never
/// nests would otherwise pay a second `Engine::new` and hold a second
/// compiled-code cache for nothing.
///
/// Laziness is thread-safe because [`OnceLock`] performs the initialisation once
/// under its own synchronisation, and because a failed initialisation is
/// *memoised* as a value (`Result` rather than a panic), so a machine that cannot
/// compile stack switching reports the same refusal to every caller instead of
/// retrying a failed engine construction.
pub struct Worlds {
    process: Arc<World>,
    sandbox: OnceLock<Result<Arc<World>, String>>,
    /// How a world's engine is built. Supplied by `main`, which is the only place
    /// that knows the CLI (`--debug`) and where the refusal belongs.
    make: Box<dyn Fn(WorldKind) -> Result<Engine> + Send + Sync>,
}

impl Worlds {
    /// Build the process world now, and remember how to build the others.
    pub fn new(make: impl Fn(WorldKind) -> Result<Engine> + Send + Sync + 'static) -> Result<Self> {
        let engine = make(WorldKind::Process)?;
        Ok(Self {
            process: Arc::new(World::new(WorldKind::Process, engine)),
            sandbox: OnceLock::new(),
            make: Box::new(make),
        })
    }

    /// The process's world.
    pub fn process(&self) -> &Arc<World> {
        &self.process
    }

    /// Worlds whose engines are built from [`engine_config`] with `debug` off.
    ///
    /// For a caller with no CLI — a test that builds a `HostState` directly and
    /// never calls `dev.run`, and an embedder that has its own switches. The
    /// shipped binary uses [`Worlds::new`] so `--debug` reaches **every** world;
    /// this constructor exists so that a test which does not care about engine
    /// configuration does not have to restate it, and so the restatement cannot
    /// drift from the product's.
    ///
    /// Infallible at construction: only the process world is built here, and
    /// epoch interruption (its one non-default switch) is accepted on every
    /// platform. A platform that cannot compile stack switching reports that at
    /// [`.sandbox()`](Self::sandbox) instead of taking the caller's construction
    /// down.
    pub fn default_engines() -> Self {
        Self::new(|kind| Ok(Engine::new(&engine_config(kind, false))?))
            .expect("a default process engine builds on every supported platform")
    }

    /// The sandbox world, built on first use.
    ///
    /// The error is a `String` because it is reported to a *guest* (`dev.run`
    /// turns it into `-EINVAL` and a log line); reconstructing a typed error
    /// there would add a type nothing else reads.
    pub fn sandbox(&self) -> Result<Arc<World>> {
        match self.sandbox.get_or_init(|| {
            (self.make)(WorldKind::Sandbox)
                .map(|engine| Arc::new(World::new(WorldKind::Sandbox, engine)))
                .map_err(|error| format!("{error:#}"))
        }) {
            Ok(world) => Ok(Arc::clone(world)),
            Err(message) => Err(anyhow!(
                "the sandbox engine could not be built: {message}. A machine that cannot \
                 compile the WebAssembly stack-switching proposals cannot nest a guest."
            )),
        }
    }
}
