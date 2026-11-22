//! The thread ABI's host half: `env.__executorCount` and `env.__startThread`.
//!
//! TensionScript's `docs/thread-abi.md` is the contract; this module is the
//! Tension side of it. Both imports are emitted by a `--sharedMemory` build, and
//! nothing else in this tree answers them — Wasmtime 50 can create a
//! `SharedMemory` and instantiate the same module twice over it, but it has no
//! thread spawning at all. The spawn is ours, which is why the import exists.
//!
//! # What the guest publishes, and what the host may do
//!
//! Before `__startThread(id)` is called, the guest has already written that
//! executor's record — arena bounds, both rings, the spawn entry — into the
//! carved control block, and set its state word to `1`. So:
//!
//! * **the host writes no guest memory** here. Not the boot words, not the state
//!   word, not the arena bounds. `__spawnThread` is the only writer, and it is
//!   guest code (`std/assembly/thread.ts`);
//! * **the host reads the record only through the guest's own accessors** —
//!   `__workerArenaBase(id)` / `__workerArenaSize(id)` — so the layout stays the
//!   guest's to change;
//! * **`__start()` is never called on a worker**, and `main` never runs again.
//!   `__start` is main's boot body and shell; a second call on a worker's store
//!   would run `main` against the shared memory on a second thread.
//!
//! # Why a fresh `Store` and not the caller's
//!
//! A wasm reference — a continuation, an object — belongs to the store that made
//! it and cannot cross. The instance is therefore **the same module** (so
//! `$starts` indices mean the same functions everywhere) with **new globals,
//! tables and stack** (so each thread has its own continuation table and its own
//! heap), over **one memory** (the only thing they share).
//!
//! # Why this type is in the library
//!
//! `tests/threads.rs` is an integration test, so it links this crate's library
//! target rather than the binary. The pool is here for the same reason
//! `platform` and `render2d` are: it is core infrastructure that a test — and,
//! next, a nested guest — has to be able to stand up, and it needs nothing from
//! `main` to do it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use wasmtime::{Caller, Engine, ExternType, Linker, Module, SharedMemory, Store};

use crate::logging::{self, Level};

/// A store whose epoch never fires: half the range, for the reason
/// `host/guest.rs` records — `u64::MAX` overflows once the engine's epoch has
/// advanced.
const NEVER_TRAPS: u64 = u64::MAX / 2;

/// Refusals. The contract fixes only "0 is success"; these are the host's own
/// negatives, and `docs/threads.md` lists them for an operator reading a log.
pub const ERR_ID_OUT_OF_RANGE: i32 = -1;
pub const ERR_ALREADY_BORN: i32 = -2;
pub const ERR_INSTANTIATE: i32 = -3;
pub const ERR_EXPORT_MISSING: i32 = -4;
pub const ERR_WORKER_TRAPPED: i32 = -5;
pub const ERR_SPAWN_FAILED: i32 = -6;

/// The store data of a worker instance.
///
/// Deliberately tiny: a worker is an executor of the same program, not a second
/// guest. It reaches nothing but the pool, so the two imports a worker's own
/// module also imports (`__executorCount`, `__startThread`) can be answered from
/// inside a worker too.
///
/// **`parks` is a record, not a table.** A worker is a `Store` and therefore an
/// *owner thread* under `docs/scheduler-contract.md` §2.2, so `scheduler::park`
/// may legally be called here — but the contract's other half is that the guest
/// MUST be resumable from the park the moment the call returns, and nothing can
/// resume this store: no host loop runs on a worker, and `wake` may only be
/// called on this store's owner thread, which is inside `__workerMain`. So the
/// seam records the three integers the contract's call carries and nothing more.
/// `run_worker` logs the count, which is the difference between "reached the
/// seam" and "was resumed", kept as two facts on purpose.
///
/// Why the record is a plain tuple list rather than the binary's `Scheduler`:
/// that type is keyed by the session ABI's class ids and per-class key spaces
/// (`src/session/arena.rs`, 36 references in `scheduler.rs`), and `session` is a
/// module of the **binary**. This crate is the library, so a park that could be
/// resolved the way main's is would need that ABI moved into the library — which
/// no round is allowed to do casually. The record is the honest fraction that
/// fits on this side of the boundary, and its emptiness is a measurement.
pub struct WorkerState {
    pool: Arc<ExecutorPool>,
    parks: Mutex<Vec<WorkerPark>>,
}

/// One `scheduler::park` seen on a worker: the contract's three integers.
#[derive(Clone, Copy, Debug)]
pub struct WorkerPark {
    pub task_id: u64,
    pub class: u32,
    pub key: u32,
}

/// What a linked instance's store must be able to answer for the two imports.
///
/// Implemented by `HostState` in the binary (the process's own guest) and by
/// [`WorkerState`] here (a worker). `None` means "this instance has no pool",
/// which is the honest answer for a module that did not import a shared memory:
/// there is one executor, main.
pub trait ThreadImports: 'static {
    fn executor_pool(&self) -> Option<&Arc<ExecutorPool>>;
}

impl ThreadImports for WorkerState {
    fn executor_pool(&self) -> Option<&Arc<ExecutorPool>> {
        Some(&self.pool)
    }
}

/// The executors of one configured guest: main plus the pool.
///
/// **Named for what it is.** Not a "thread table": the ids belong to the guest's
/// carved control block (`docs/thread-abi.md` §3.2), the arenas belong to the
/// guest, and what the host owns is exactly one OS thread per successfully
/// started executor, plus the count it was configured for.
pub struct ExecutorPool {
    engine: Engine,
    module: Module,
    /// The one memory every instance of this module sees. Created from the
    /// module's own declared memory type, so the host mirrors the guest's build.
    memory: SharedMemory,
    /// Main **plus** the workers: the value `__executorCount` answers.
    count: i32,
    /// The threads that have been started. `BTreeMap` for deterministic teardown
    /// order, which is what a log line about a live worker should read like.
    workers: Mutex<BTreeMap<i32, JoinHandle<i32>>>,
}

impl ExecutorPool {
    /// Build a pool for a module whose memory import is shared.
    ///
    /// `count` is main plus the worker threads; it is what `__executorCount`
    /// answers, and the guest decides everything else from it (`__threadInit`
    /// carves `count` records).
    pub fn new(
        engine: Engine,
        module: Module,
        memory: SharedMemory,
        count: usize,
    ) -> anyhow::Result<Arc<Self>> {
        let count = i32::try_from(count.max(1))
            .map_err(|_| anyhow::anyhow!("the executor count does not fit in an i32"))?;
        Ok(Arc::new(ExecutorPool {
            engine,
            module,
            memory,
            count,
            workers: Mutex::new(BTreeMap::new()),
        }))
    }

    /// The value `__executorCount` answers.
    pub fn count(&self) -> i32 {
        self.count
    }

    /// The memory every instance shares, for the caller that has to define it
    /// under the import name the module used.
    pub fn memory(&self) -> &SharedMemory {
        &self.memory
    }

    /// `env.__startThread(execId)`: create the instance, then let the thread be
    /// the worker's whole body.
    ///
    /// Returns `0` once the thread is running. Every non-zero answer means the
    /// worker never started, which the guest treats as "unborn"
    /// (`__spawnThread` marks the executor exited and returns the code).
    pub fn start_thread(self: &Arc<Self>, id: i32) -> i32 {
        if id <= 0 || id >= self.count {
            return ERR_ID_OUT_OF_RANGE;
        }
        {
            let workers = self.lock_workers();
            if workers.contains_key(&id) {
                return ERR_ALREADY_BORN;
            }
        }

        let pool = Arc::clone(self);
        let handle = std::thread::Builder::new()
            .name(format!("executor-{id}"))
            .spawn(move || run_worker(pool, id));
        match handle {
            Ok(handle) => {
                self.lock_workers().insert(id, handle);
                0
            }
            Err(error) => {
                logging::log(
                    Level::Error,
                    "thread",
                    &format!("__startThread({id}): could not spawn the thread: {error}"),
                );
                ERR_SPAWN_FAILED
            }
        }
    }

    /// Join every worker thread that finishes within a short grace, and report
    /// the ones that do not.
    ///
    /// **The grace is for the gap between the guest's `__threadJoin` returning
    /// and this thread returning.** `__workerMain` writes the record's state word
    /// *before* it returns, and the Rust side then drops its `Store` — so a guest
    /// that joined correctly still has a live `JoinHandle` for a moment, and
    /// calling that "still running" was a warning on every well-behaved run
    /// (measured on `two-workers.ts`: both joins answered 0 and both workers were
    /// reported as detached).
    ///
    /// A worker that really was never joined is blocked in its idle
    /// `atomicWait`, so it does not finish in the grace; that one is named and
    /// detached rather than joined, because blocking here would turn "the guest
    /// forgot to join" into a hang with no explanation.
    pub fn join_finished(&self) {
        /// Long enough for a finishing worker's remaining host work, short
        /// enough that a forgotten join is reported rather than waited on.
        const GRACE: std::time::Duration = std::time::Duration::from_secs(2);

        let deadline = std::time::Instant::now() + GRACE;
        loop {
            let mut workers = self.lock_workers();
            let finished: Vec<i32> = workers
                .iter()
                .filter(|(_, handle)| handle.is_finished())
                .map(|(id, _)| *id)
                .collect();
            for id in finished {
                if let Some(handle) = workers.remove(&id) {
                    match handle.join() {
                        Ok(status) => logging::log(
                            Level::Debug,
                            "thread",
                            &format!("executor {id} joined (__workerMain answered {status})"),
                        ),
                        Err(_) => logging::log(
                            Level::Error,
                            "thread",
                            &format!("executor {id} panicked; the store is gone with it"),
                        ),
                    }
                }
            }
            if workers.is_empty() || std::time::Instant::now() >= deadline {
                for id in workers.keys() {
                    logging::log(
                        Level::Warn,
                        "thread",
                        &format!(
                            "executor {id} is still running after the guest returned: the guest \
                             did not call __threadJoin({id}), so the thread is detached (the \
                             process exit is its end)"
                        ),
                    );
                }
                return;
            }
            drop(workers);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// How many worker threads are live. For tests and for the log line.
    pub fn live_workers(&self) -> usize {
        self.lock_workers().len()
    }

    fn lock_workers(&self) -> std::sync::MutexGuard<'_, BTreeMap<i32, JoinHandle<i32>>> {
        self.workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register the two imports on a linker for any store the pool can answer
    /// for.
    ///
    /// `__executorCount` answers `1` for an instance with no pool: a module that
    /// did not import a shared memory has exactly one executor, and a guest that
    /// asks gets the truth rather than a refusal.
    ///
    /// Free-standing rather than an associated function taking `&Arc<Self>`,
    /// because the pool lives in the store's own data — the same place every
    /// other verb reaches its state (`Caller::data()`) — and a second handle
    /// passed to the linker would be a second owner for one thing.
    pub fn link<T: ThreadImports>(linker: &mut Linker<T>) -> anyhow::Result<()> {
        linker.func_wrap(
            "env",
            "__executorCount",
            |caller: Caller<'_, T>| -> i32 {
                caller
                    .data()
                    .executor_pool()
                    .map(|pool| pool.count)
                    .unwrap_or(1)
            },
        )?;
        linker.func_wrap(
            "env",
            "__startThread",
            |caller: Caller<'_, T>, id: i32| -> i32 {
                match caller.data().executor_pool() {
                    Some(pool) => {
                        let pool = Arc::clone(pool);
                        pool.start_thread(id)
                    }
                    // No pool means the module did not import a shared memory,
                    // so there is no second instance to make.
                    None => ERR_ID_OUT_OF_RANGE,
                }
            },
        )?;
        Ok(())
    }

    /// The imports a **worker** instance needs: the memory, `env.abort`, and the
    /// two thread imports.
    ///
    /// This is the narrowest set that lets the same module instantiate. It is
    /// narrower than main's on purpose: a capability's state is a process
    /// singleton (one window, one GPU device, one input layer — `host/mod.rs`
    /// lists them), so its verbs are only meaningful on the thread that owns
    /// it. A module that imports one therefore cannot be started as a worker
    /// yet; [`run_worker`] answers [`ERR_INSTANTIATE`] and logs the import that
    /// had no answer.
    fn link_worker(
        pool: &Arc<Self>,
        store: &mut Store<WorkerState>,
        linker: &mut Linker<WorkerState>,
    ) -> anyhow::Result<()> {
        define_memory(&pool.memory, store, linker)?;
        linker.func_wrap(
            "env",
            "abort",
            |mut caller: Caller<'_, WorkerState>, msg: i32, file: i32, line: i32, col: i32| -> wasmtime::Result<()> {
                let location = memory_string(&mut caller, file);
                let message = memory_string(&mut caller, msg);
                logging::log(
                    Level::Error,
                    "thread",
                    &format!(
                        "a worker aborted: {message} (in {location}, line {line}, col {col})"
                    ),
                );
                // A trap, not a return: the guest's `abort` expects control not
                // to come back, and a worker that returned from it would run on
                // with whatever the failing branch left in its locals.
                Err(wasmtime::Error::msg("a worker guest aborted"))
            },
        )?;
        ExecutorPool::link(linker)?;
        // **The park seam, for a worker's store.** A worker instantiates the same
        // module as main, so it imports the same names; every async program
        // imports `scheduler::park` whether or not it ever parks, because
        // `parkState` is reachable from `__taskPark` in any module that links
        // `~lib/task-rt`. Without a definition here the module fails at
        // instantiation — `unknown import: scheduler::park` — and no executor
        // could host a suspending task even in principle.
        //
        // What it does *not* do: **resume anything.** The park is recorded and
        // the call returns (contract §2.1: the call returns, the suspension is
        // the guest returning to its executor). There is no host loop on this
        // store and no channel to hand it ids, so the record is where a future
        // round's wake would start — not a wake that exists.
        linker.func_wrap(
            "scheduler",
            "park",
            |caller: Caller<'_, WorkerState>, task_id: i64, class: i32, key: i32| {
                let mut parks = caller
                    .data()
                    .parks
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                parks.push(WorkerPark {
                    task_id: task_id as u64,
                    class: class as u32,
                    key: key as u32,
                });
            },
        )?;
        // `tension::io` too, and for a reason that is not convenience: the
        // module is **the same module** as main's, so it imports exactly what
        // main's build imports. A worker instance that cannot resolve `print`
        // does not instantiate at all, which would make every guest that logs
        // unusable as a worker. The rest of `main`'s namespace stays out — see
        // the doc comment above and `docs/threads.md` §4.
        link_worker_io(linker)?;
        Ok(())
    }
}

/// The whole body of one worker OS thread.
///
/// Everything a worker needs is built **here**, on this thread: the `Store`, the
/// `Linker`, the instance. Nothing that is not `Send` ever crosses a thread
/// boundary, which is what makes `HostState`'s `!Send` irrelevant to this path.
fn run_worker(pool: Arc<ExecutorPool>, id: i32) -> i32 {
    let status = match worker_main(&pool, id) {
        Ok(status) => status,
        Err(error) => {
            logging::log(
                Level::Error,
                "thread",
                &format!("executor {id} could not run: {error}"),
            );
            ERR_INSTANTIATE
        }
    };
    logging::log(
        Level::Debug,
        "thread",
        &format!("executor {id} finished (__workerMain answered {status})"),
    );
    status
}

/// Instantiate the module over the shared memory, configure the worker's arena,
/// and call `__workerMain(id)`.
fn worker_main(pool: &Arc<ExecutorPool>, id: i32) -> anyhow::Result<i32> {
    let mut store = Store::new(
        &pool.engine,
        WorkerState {
            pool: Arc::clone(pool),
            parks: Mutex::new(Vec::new()),
        },
    );
    store.set_epoch_deadline(NEVER_TRAPS);

    let mut linker: Linker<WorkerState> = Linker::new(&pool.engine);
    ExecutorPool::link_worker(pool, &mut store, &mut linker)?;

    let instance = linker.instantiate(&mut store, &pool.module).map_err(|error| {
        anyhow::anyhow!(
            "the module did not instantiate as a worker — the worker's import set is \
             env::memory, env::abort, env::__executorCount, env::__startThread, \
             scheduler::park and tension::io, and a capability import has no answer on a \
             worker thread: {error}"
        )
    })?;

    // **No boot words, no `__start`.** The guest carved the control block on
    // main; a worker's globals are zero and its only state is what
    // `__workerMain` binds from the block.
    let arena_base = instance
        .get_typed_func::<i32, i32>(&mut store, "__workerArenaBase")
        .map_err(|_| anyhow::anyhow!("the module exports no `__workerArenaBase`"))?;
    let arena_size = instance
        .get_typed_func::<i32, i32>(&mut store, "__workerArenaSize")
        .map_err(|_| anyhow::anyhow!("the module exports no `__workerArenaSize`"))?;
    let base = arena_base.call(&mut store, id)?;
    let size = arena_size.call(&mut store, id)?;
    if base == 0 || size == 0 {
        // The guest answers 0 before `__threadInit` has carved, or for an id it
        // does not know. `__workerMain` refuses this itself (`-3`); refusing one
        // step earlier names the cause.
        anyhow::bail!("the record for executor {id} publishes no arena (base {base}, size {size})");
    }

    // `__arenaInit` moves `__stack_pointer`, so it must run with no live guest
    // frame — the reason the guest does not call it from `__threadInit`, and the
    // reason this is the host's job (`docs/thread-abi.md` §2.2).
    let arena_init = instance
        .get_typed_func::<(i32, i32), ()>(&mut store, "__arenaInit")
        .map_err(|_| anyhow::anyhow!("the module exports no `__arenaInit`"))?;
    arena_init.call(&mut store, (base, size))?;

    let worker_main = instance
        .get_typed_func::<i32, i32>(&mut store, "__workerMain")
        .map_err(|_| anyhow::anyhow!("the module exports no `__workerMain`"))?;
    let status = worker_main.call(&mut store, id).map_err(|error| {
        anyhow::anyhow!("the worker's `__workerMain({id})` failed: {error}")
    })?;

    // **What the park seam actually did on this executor.** The seam is
    // reachable, so `park` may have been called; whether anything can resume is
    // the other half, and this store has no host loop to do it. The count is
    // logged — including zero — because "the guest parked" and "the guest never
    // reached the seam" are different answers and a silent run cannot tell them
    // apart.
    let parks = {
        let parks = store
            .data()
            .parks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        parks.clone()
    };
    logging::log(
        Level::Info,
        "thread",
        &format!(
            "executor {id} left the park seam having recorded {} park(s){} — a worker runs \
             no host loop, so none of them can be resumed",
            parks.len(),
            match parks.first() {
                Some(first) => format!(
                    " (first: task {} on class {} key {})",
                    first.task_id, first.class, first.key
                ),
                None => String::new(),
            }
        ),
    );
    Ok(status)
}


/// The `tension::io` verbs, for a worker instance.
///
/// **Why a worker gets io at all.** A worker instantiates the *same module* as
/// main, so it imports the same names; a name with no definition is a failed
/// instantiation, not a verb the worker declines to call. `tension::io` is the
/// one namespace whose verbs are a pure function of the store (argv, stdin, a
/// line buffer) — no adapter, no device, no singleton — so it is the one that
/// can be answered on a worker thread honestly.
///
/// The answers differ from main's in the three places where a worker genuinely
/// has nothing:
///
/// * `print` goes to the terminal. A worker is never a sandboxed guest, so there
///   is no captured sink; two threads writing to stdout interleave, which is
///   what threads do.
/// * `arg`/`arg_count` answer `-1`/`0`: a worker has no argv.
/// * `read_line` answers `-1` (EOF): stdin belongs to the process's main thread.
fn link_worker_io(linker: &mut Linker<WorkerState>) -> anyhow::Result<()> {
    use std::io::Write;

    linker.func_wrap(
        "tension::io",
        "print",
        |mut caller: Caller<'_, WorkerState>, ptr: i32, len: i32| {
            let Some(memory) = GuestMemory::of(&mut caller) else {
                return;
            };
            let start = ptr as usize;
            let bytes = memory.copy(&caller, start, start.saturating_add(len.max(0) as usize));
            let text = String::from_utf8_lossy(&bytes);
            let mut out = std::io::stdout();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
        },
    )?;
    linker.func_wrap(
        "tension::io",
        "log",
        |mut caller: Caller<'_, WorkerState>, level: i32, name: i32, name_len: i32, msg: i32, msg_len: i32| {
            let Some(memory) = GuestMemory::of(&mut caller) else {
                return;
            };
            let name = memory.copy(&caller, name as usize, (name as usize).saturating_add(name_len.max(0) as usize));
            let msg = memory.copy(&caller, msg as usize, (msg as usize).saturating_add(msg_len.max(0) as usize));
            let level = match level {
                0 => Level::Trace,
                1 => Level::Debug,
                2 => Level::Info,
                3 => Level::Warn,
                4 => Level::Error,
                _ => Level::Fatal,
            };
            logging::log(
                level,
                &format!("worker:{}", String::from_utf8_lossy(&name)),
                &String::from_utf8_lossy(&msg),
            );
        },
    )?;
    linker.func_wrap("tension::io", "arg_count", |_caller: Caller<'_, WorkerState>| -> i32 { 0 })?;
    linker.func_wrap("tension::io", "arg", |_caller: Caller<'_, WorkerState>, _i: i32, _p: i32, _cap: i32| -> i32 {
        -1
    })?;
    linker.func_wrap("tension::io", "read_line", |_caller: Caller<'_, WorkerState>, _p: i32, _cap: i32| -> i32 {
        -1
    })?;
    Ok(())
}

/// A guest's linear memory — **either kind**.
///
/// `Extern::into_memory()` answers `None` for a `SharedMemory`, because the two
/// are different extern variants. That difference is invisible until a guest is
/// compiled with `--sharedMemory`: then every verb that reads guest bytes through
/// `into_memory()` finds nothing, and `print` — the one verb whose job is to say
/// what is happening — is where it surfaces first (measured: the export is
/// present, `is_some()` is true, and the `expect` fired anyway).
///
/// The verbs a thread guest actually calls read through this instead. The rest
/// still take the linear path; `docs/threads.md` records that as the open edge.
pub enum GuestMemory {
    Linear(wasmtime::Memory),
    Shared(SharedMemory),
}

impl GuestMemory {
    /// The caller's own `memory` export, whichever kind it is.
    pub fn of<T>(caller: &mut Caller<'_, T>) -> Option<Self> {
        match caller.get_export("memory")? {
            wasmtime::Extern::Memory(memory) => Some(GuestMemory::Linear(memory)),
            wasmtime::Extern::SharedMemory(memory) => Some(GuestMemory::Shared(memory)),
            _ => None,
        }
    }

    /// The number of bytes currently addressable.
    pub fn len<T>(&self, caller: &Caller<'_, T>) -> usize {
        match self {
            GuestMemory::Linear(memory) => memory.data(caller).len(),
            GuestMemory::Shared(memory) => memory.data().len(),
        }
    }

    /// Bytes `start..end`, clamped to the memory, copied out.
    ///
    /// A copy rather than a borrowed slice because a shared memory's bytes are
    /// `UnsafeCell<u8>`: another thread may be writing them, so a `&[u8]` view
    /// would be a promise the memory does not make. One read per byte is the
    /// honest cost of a verb that only ever reads a small record.
    pub fn copy<T>(&self, caller: &Caller<'_, T>, start: usize, end: usize) -> Vec<u8> {
        let len = self.len(caller);
        let start = start.min(len);
        let end = end.min(len);
        match self {
            GuestMemory::Linear(memory) => memory.data(caller)[start..end].to_vec(),
            GuestMemory::Shared(memory) => {
                let cells = &memory.data()[start..end];
                // Safety: each `get()` is one read of a `u8` cell; the values are
                // copied out immediately, and no reference to the cell escapes.
                cells
                    .iter()
                    .map(|cell| unsafe { *cell.get() })
                    .collect()
            }
        }
    }
}

/// Define one shared memory under both import names a guest may use.
///
/// Both, because the compiler emits `env::memory` and Tension documents
/// `session::memory`; the session registers both for the same reason. An unused
/// definition is harmless.
pub fn define_memory<T>(
    memory: &SharedMemory,
    store: &mut Store<T>,
    linker: &mut Linker<T>,
) -> anyhow::Result<()> {
    linker.define(&*store, "env", "memory", memory.clone())?;
    linker.define(&*store, "session", "memory", memory.clone())?;
    Ok(())
}

/// A TensionScript string (`rtSize` at `ptr - 4`, UTF-16LE at `ptr`), for the
/// worker's `abort` message. The binary has the same reader for `HostState`;
/// it is generic over the store data, which is the only difference.
fn memory_string<T>(caller: &mut Caller<'_, T>, ptr: i32) -> String {
    if ptr == 0 {
        return String::new();
    }
    let Some(memory) = GuestMemory::of(caller) else {
        return String::new();
    };
    let p = ptr as u32 as usize;
    let Some(head) = p.checked_sub(4) else {
        return String::new();
    };
    let header = memory.copy(caller, head, head + 4);
    if header.len() < 4 {
        return String::new();
    }
    let units = u32::from_le_bytes(header.try_into().unwrap_or([0; 4])) as usize / 2;
    let bytes = memory.copy(caller, p, p + units * 2);
    let mut text = String::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        text.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
    }
    text
}

/// Whether a module imports a **shared** linear memory, and its declared type.
///
/// This is the switch that decides whether a guest gets a thread pool at all: a
/// `--sharedMemory` build imports one, and the host must create the
/// `SharedMemory` itself (a module-defined shared memory is a fresh one per
/// instantiation, which is the opposite of sharing).
pub fn shared_memory_import(module: &Module) -> Option<wasmtime::MemoryType> {
    module.imports().find_map(|import| match import.ty() {
        ExternType::Memory(ty) if ty.is_shared() => Some(ty),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::Config;

    /// The engine the host builds, in the two lines that matter here.
    fn engine() -> Engine {
        let mut config = Config::new();
        config.wasm_threads(true);
        config.shared_memory(true);
        config.epoch_interruption(true);
        // Stack switching is negotiated by the same helper `main` uses; the
        // returned backend is ignored here because these fixtures use no
        // continuation types — shared memory is what is under test.
        let (engine, _) =
            crate::async_backend::build(&config).expect("an engine with shared memory");
        engine
    }

    /// A worker that writes one word and exits: enough to prove the spawn is a
    /// real thread over the same memory.
    const WORKER: &str = r#"
(module
  (import "env" "memory" (memory 1 64 shared))
  (import "env" "__executorCount" (func $count (result i32)))
  (import "env" "__startThread" (func $start (param i32) (result i32)))
  (func (export "__arenaInit") (param i32 i32))
  (func (export "__workerArenaBase") (param i32) (result i32)
    (i32.const 16))
  (func (export "__workerArenaSize") (param i32) (result i32)
    (i32.const 4096))
  (func (export "__workerMain") (param $id i32) (result i32)
    (i32.atomic.store (i32.const 0) (local.get $id))
    (i32.const 0))
  (func (export "spawn") (param i32) (result i32)
    (call $start (local.get 0)))
  (func (export "count") (result i32)
    (call $count)))
"#;

    /// One 32-bit word of a shared memory, read atomically.
    ///
    /// `SharedMemory::data` hands out `&[UnsafeCell<u8>]`, so a plain cast is
    /// not available; `AtomicI32` is the load the worker's `i32.atomic.store`
    /// pairs with.
    fn read_word(memory: &SharedMemory, offset: usize) -> i32 {
        use std::sync::atomic::{AtomicI32, Ordering};
        let cell = &memory.data()[offset] as *const std::cell::UnsafeCell<u8>;
        unsafe { (*(cell as *const AtomicI32)).load(Ordering::SeqCst) }
    }

    struct Plain(Arc<ExecutorPool>);

    impl ThreadImports for Plain {
        fn executor_pool(&self) -> Option<&Arc<ExecutorPool>> {
            Some(&self.0)
        }
    }

    #[test]
    fn a_pool_spawns_a_real_thread_over_the_shared_memory() {
        let engine = engine();
        let module = Module::new(&engine, WORKER).expect("the fixture compiles");
        let ty = shared_memory_import(&module).expect("the fixture imports a shared memory");
        let memory = SharedMemory::new(&engine, ty).expect("a shared memory");
        let pool = ExecutorPool::new(engine.clone(), module.clone(), memory.clone(), 2)
            .expect("a pool of two");

        let mut store = Store::new(&engine, Plain(Arc::clone(&pool)));
        store.set_epoch_deadline(NEVER_TRAPS);
        let mut linker: Linker<Plain> = Linker::new(&engine);
        define_memory(&memory, &mut store, &mut linker).expect("the memory defines");
        ExecutorPool::link(&mut linker).expect("the imports register");
        let instance = linker
            .instantiate(&mut store, &module)
            .expect("the fixture instantiates over the pool's memory");

        let count = instance
            .get_typed_func::<(), i32>(&mut store, "count")
            .expect("count")
            .call(&mut store, ())
            .expect("count runs");
        assert_eq!(count, 2, "__executorCount is main plus the pool");

        let spawn = instance
            .get_typed_func::<i32, i32>(&mut store, "spawn")
            .expect("spawn");
        assert_eq!(
            spawn.call(&mut store, 1).expect("spawn runs"),
            0,
            "the spawn is accepted"
        );
        assert_eq!(
            spawn.call(&mut store, 1).expect("spawn runs"),
            ERR_ALREADY_BORN,
            "a live id is refused rather than started twice"
        );
        assert_eq!(
            spawn.call(&mut store, 5).expect("spawn runs"),
            ERR_ID_OUT_OF_RANGE,
            "an id past the configured count is refused"
        );

        // The worker's write is the observation: it is in the memory this store
        // reads, and it is the id it was given.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut seen = 0;
        while std::time::Instant::now() < deadline {
            seen = read_word(&memory, 0);
            if seen != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(seen, 1, "the worker wrote its id into the shared memory");
        pool.join_finished();
        assert_eq!(pool.live_workers(), 0, "the finished worker was joined");
    }
}
