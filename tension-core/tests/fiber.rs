//! DL24 — the fiber spike: can the host suspend a guest call and resume it later?
//!
//! # What this file is
//!
//! A measurement, not a feature. Four questions, each answered by a log line or a
//! quoted API fact:
//!
//! - **Q1** can a host import, called *from wasm*, suspend the calling fiber and
//!   return control to the host loop?
//! - **Q2** can the host resume it later, and does the guest's frame survive — a
//!   local set before the suspension reading the same value after the resume?
//! - **Q3** two suspensions in **one store**: refused (H1, one parked fiber per
//!   store) or allowed (H2)?
//! - **Q4** thread affinity: can a suspended fiber resume on another OS thread?
//!
//! # Crate, and why this one
//!
//! `wasmtime-internal-fiber = "=50.0.2"`, **not** the public
//! `wasmtime-fiber-24.0.13`. Three reasons, in order of weight:
//!
//! 1. It is version-locked to the engine in use (`wasmtime = "=50.0.2"`), so what
//!    is measured here is the machinery the engine itself runs on. A spike whose
//!    answer does not transfer is a wasted round.
//! 2. It is already in `Cargo.lock` as a transitive dependency at exactly this
//!    version, so the dev-dependency adds no crate to the graph.
//! 3. If a host fiber path ever ships, it must be this crate. Measuring a
//!    twenty-six-major-version-old public crate would answer a question about code
//!    the project will never call.
//!
//! The crate's own header warns it is internal and "not intended for general use".
//! That is what a spike is for. **Nothing outside this file may depend on it.**
//!
//! # No engine change
//!
//! Nothing here touches `tension-core/src`. The module is inline WAT, the store is
//! ordinary, and the only new import is a host function this test defines.
//!
//! # The scoped suspend handle
//!
//! `Suspend` is obtainable only as `&mut Suspend` **inside** the fiber's closure.
//! There is no ambient "current fiber" lookup: `Fiber` is a zero-sized handle and
//! `Suspend` is a per-resume struct built on the fiber's own stack. So the host
//! function that wasm calls needs the handle *published* to it.
//!
//! **Which implementation is active matters for the citations below.** With no
//! features enabled, `cfg_select!`'s first arm matches — `not(feature = "std")` —
//! so the code in use is `src/nostd.rs` over `src/stackswitch.rs` (per-arch inline
//! assembly), **not** `src/unix.rs` (mmap + guard pages). That is also how
//! `wasmtime` itself depends on this crate: no features. `nostd.rs:125` is the
//! `Suspend` this probe reads a `*mut u8` out of.
//!
//! For a same-thread suspension the sound publication is a thread-local, set for
//! exactly the duration of one wasm call and cleared after it returns. Q4 needs the
//! same handle on a *different* thread, where a thread-local cannot reach: it is
//! carried as a bare address and re-installed there, and that unsafe step is one of
//! the findings — a pool would have to own it, because `Suspend` is `!Send`.

use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use wasmtime::{Caller, Engine, Linker, Module, Store};
use wasmtime_internal_fiber::{Fiber, FiberStack, Suspend};

/// The yield payload: why the fiber suspended.
type Yield = &'static str;
/// What a resume hands back. `()` — this spike resumes unconditionally; the point
/// is to prove the frame survives, not to choose a value.
type Resume = ();

thread_local! {
    /// The scoped handle for a suspension on **this** thread.
    static SUSPEND: Cell<*mut ()> = const { Cell::new(ptr::null_mut()) };
}

fn install(handle: *mut ()) {
    SUSPEND.with(|slot| slot.set(handle));
}

fn current() -> *mut () {
    SUSPEND.with(|slot| slot.get())
}

/// A WAT guest whose `run` sets a local, asks the host to suspend, and prints the
/// local afterwards.
///
/// `keep` is the contract's own proof point: written before the host call, read
/// after the resume. A frame that was not preserved would show it changed, zeroed,
/// or unreadable — not merely "something printed".
const GUEST: &str = r#"
(module
  (import "env" "__yield" (func $yield))
  (import "env" "__print32" (func $print32 (param i32 i32)))
  (func (export "run") (result i32)
    (local $keep i32)
    (local.set $keep (i32.const 42))
    ;; tag 1 = BEFORE. The value printed here must still be readable after the
    ;; resume — that is the contract's "locals unchanged".
    (call $print32 (i32.const 1) (local.get $keep))
    (call $yield)
    ;; tag 2 = AFTER. Reached only if execution continued at the instruction after
    ;; the host call.
    (call $print32 (i32.const 2) (local.get $keep))
    (local.get $keep)))
"#;

/// The probe's log. `Arc<Mutex<..>>` rather than `Rc<RefCell<..>>` because Q4's
/// fiber is resumed from another thread that also writes to it.
type Log = Arc<Mutex<Vec<String>>>;

fn note(log: &Log, line: impl Into<String>) {
    log.lock().unwrap().push(line.into());
}

fn lines(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn dump(title: &str, log: &Log) {
    eprintln!("--- {title} ---");
    for line in lines(log) {
        eprintln!("{line}");
    }
}

/// The linker every test shares: two imports, both backed by the fiber above.
fn linker(engine: &Engine, log: &Log) -> Linker<()> {
    let mut linker = Linker::new(engine);

    // **Q1's entry point.** Called from wasm, on the fiber's stack; it does not
    // return until the fiber is resumed.
    let yield_log = Arc::clone(log);
    linker
        .func_wrap(
            "env",
            "__yield",
            move |_caller: Caller<'_, ()>| -> Result<(), wasmtime::Error> {
                note(&yield_log, "guest: inside __yield — about to suspend the fiber");
                let handle = current();
                if handle.is_null() {
                    return Err(wasmtime::Error::msg(
                        "no suspend handle was published for this thread",
                    ));
                }
                // SAFETY: `handle` was published by the fiber closure immediately
                // before the wasm call that is running right now, and the `Suspend`
                // it names lives on this fiber's stack for the whole of that call.
                let suspend: &mut Suspend<Resume, Yield, i32> =
                    unsafe { &mut *(handle as *mut Suspend<Resume, Yield, i32>) };
                let _resumed_with: Resume = suspend.suspend("guest parked in __yield");
                note(&yield_log,
                    "guest: __yield returned — the fiber was resumed, back into wasm",
                );
                Ok(())
            },
        )
        .expect("the yield import");

    let print_log = Arc::clone(log);
    linker
        .func_wrap(
            "env",
            "__print32",
            move |_caller: Caller<'_, ()>, tag: i32, value: i32| {
                let which = match tag {
                    1 => "BEFORE (set before the suspension)",
                    2 => "AFTER  (after the resume)",
                    _ => "unknown",
                };
                note(&print_log, format!("guest: {which} keep={value}"));
            },
        )
        .expect("the print import");

    linker
}

/// Build a fiber that runs `GUEST` inside its own store.
///
/// The store is **created inside the closure** and never leaves it. That is Q3's
/// question in one sentence: a `Store` is moved into the fiber, so while the fiber
/// is suspended the store is owned by a stack frame that is not running.
fn guest_fiber<'a>(
    engine: &Engine,
    module: &Module,
    log: &Log,
    stack_bytes: usize,
) -> Fiber<'a, Resume, Yield, i32> {
    let stack = FiberStack::new(stack_bytes, true)
        .map_err(|_| "FiberStack::new refused")
        .expect("a fiber stack");
    let engine = engine.clone();
    let module = module.clone();
    let log = Arc::clone(log);

    Fiber::new(stack, move |(), suspend| {
        let handle = suspend as *mut _ as *mut ();
        let previous = current();
        install(handle);

        let mut store = Store::new(&engine, ());
        let linker = linker(&engine, &log);
        let instance = linker
            .instantiate(&mut store, &module)
            .expect("the guest instantiates");
        let run = instance
            .get_typed_func::<(), i32>(&mut store, "run")
            .expect("the guest exports `run`");
        let result = run.call(&mut store, ()).expect("the guest runs");

        install(previous);
        result
    })
    .map_err(|_| "Fiber::new refused")
    .expect("a fiber")
}

fn engine_and_module() -> (Engine, Module) {
    let engine = Engine::default();
    let module = Module::new(&engine, GUEST).expect("the WAT compiles");
    (engine, module)
}

// ---------------------------------------------------------------------------
// Q1 / Q2 — suspend from a host import, resume later, frame survives.
// ---------------------------------------------------------------------------

/// **Q1 and Q2 in one run.** The guest's `__yield` import suspends the fiber and
/// returns control to the host loop; the host loop reports that it has control
/// while the guest is mid-call; then it resumes, and the guest prints the local it
/// set before the suspension.
///
/// The assertions are the contract's three clauses — *suspension* (the host loop
/// runs while the guest is inside a call), *frames preserved* (execution continues
/// after the host call), and *locals unchanged* (`keep` is 42 on both sides).
#[test]
fn q1_q2_a_host_import_suspends_the_calling_fiber_and_the_local_survives() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let fiber = guest_fiber(&engine, &module, &log, 512 * 1024);

    let started = Instant::now();

    // -- first resume: runs to the suspend and comes back to us --------------
    let first = fiber.resume(());
    assert!(
        first.is_err(),
        "the fiber must suspend rather than finish: {first:?}"
    );
    assert_eq!(first.err().as_deref(), Some("guest parked in __yield"));

    // **The host loop has control while the guest is suspended mid-call.** Written
    // by the resuming side, after `resume` returned `Err(Yield)`, with the guest's
    // `__yield` frame still on the fiber.
    note(&log,
        "host loop: resume returned Err(yield); the guest is suspended inside __yield",
    );
    assert!(!fiber.done(), "a suspended fiber is not a finished fiber");

    // -- second resume: continues inside __yield and finishes ---------------
    let second = fiber.resume(());
    assert!(second.is_ok(), "the resumed fiber must finish: {second:?}");
    assert_eq!(second.ok(), Some(42), "the guest's `run` must return 42");
    assert!(fiber.done());
    assert!(started.elapsed() < Duration::from_secs(5));

    let observed = lines(&log);
    let text = observed.join("\n");

    let before = observed
        .iter()
        .position(|l| l.contains("BEFORE") && l.contains("keep=42"))
        .unwrap_or_else(|| panic!("no BEFORE line with keep=42:\n{text}"));
    let suspended = observed
        .iter()
        .position(|l| l.contains("about to suspend"))
        .unwrap_or_else(|| panic!("no suspend line:\n{text}"));
    let host = observed
        .iter()
        .position(|l| l.starts_with("host loop:"))
        .unwrap_or_else(|| panic!("no host-loop line:\n{text}"));
    let resumed = observed
        .iter()
        .position(|l| l.contains("__yield returned"))
        .unwrap_or_else(|| panic!("no resumed line:\n{text}"));
    let after = observed
        .iter()
        .position(|l| l.contains("AFTER") && l.contains("keep=42"))
        .unwrap_or_else(|| {
            panic!("no AFTER line, or the local did not survive the resume:\n{text}")
        });

    assert!(
        before < suspended && suspended < host && host < resumed && resumed < after,
        "the order must be BEFORE, suspend, host loop, resume, AFTER:\n{text}"
    );

    dump("Q1/Q2, verbatim", &log);
}

/// **The negative control.** The same guest and the same imports, but only **one**
/// resume: the guest stays suspended and the host loop reports it.
///
/// *What was changed to break it:* `fiber.resume(())` is called once instead of
/// twice. Module, imports, store, stack size and every guest-side assertion are
/// identical, so the resume count is the only difference.
///
/// A second consequence is recorded rather than papered over: `Drop for Fiber`
/// carries `debug_assert!(self.done.get(), "fiber dropped without finishing")`
/// (`wasmtime-internal-fiber-50.0.2/src/lib.rs`), so a suspended fiber cannot be
/// dropped. It is leaked here, and that is a real property of the mechanism.
#[test]
fn negative_control_without_the_second_resume_the_guest_stays_suspended() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let fiber = guest_fiber(&engine, &module, &log, 512 * 1024);

    let first = fiber.resume(());
    assert!(first.is_err(), "the fiber must suspend on the first resume");

    let observed = lines(&log);
    let text = observed.join("\n");
    assert!(text.contains("BEFORE"), "the guest must have started:\n{text}");
    assert!(
        text.contains("about to suspend"),
        "the guest must have reached the suspend:\n{text}"
    );
    assert!(
        !text.contains("AFTER"),
        "with no second resume the guest must never reach AFTER:\n{text}"
    );
    assert!(
        !fiber.done(),
        "a suspended fiber is not done — that is what the host loop reports"
    );

    note(&log, "host loop: the guest is still suspended; nothing resumed it");

    // Leaked on purpose: a suspended fiber cannot be dropped (see the doc comment).
    std::mem::forget(fiber);

    dump("negative control, verbatim", &log);
}

// ---------------------------------------------------------------------------
// Q3 — two suspensions in one store.
// ---------------------------------------------------------------------------

/// What a fiber does with a shared store: take it, and hold it across a suspension.
fn run_in(store: &Arc<Mutex<Store<()>>>, engine: &Engine, module: &Module, log: &Log) -> (bool, i32) {
    let mut guard = store.lock().expect("the store lock");
    let instance = {
        let mut linker = linker(engine, log);
        linker
            .instantiate(&mut *guard, module)
            .expect("the guest instantiates")
    };
    let run = instance
        .get_typed_func::<(), i32>(&mut *guard, "run")
        .expect("the guest exports `run`");
    let value = run.call(&mut *guard, ()).expect("the guest runs");
    (true, value)
}

/// **Q3, the refusal.** Two fibers resumed from one host loop, both wanting the
/// same store at once.
///
/// `Store` is exclusive by construction, so the question is not "may two fibers
/// exist" (they may) but "may two of them be inside one store". The store is put
/// behind an `Arc<Mutex<_>>` — which is what `&mut Store` means, expressed so a
/// *run* can observe the exclusion instead of a compile error refusing to build the
/// question — and each fiber holds it for the duration of its call.
///
/// The measurement: while A is suspended **inside** its call it still holds the
/// lock, so B's `try_lock` fails. After A finishes and releases, B proceeds
/// normally. The exclusion is temporal, not permanent: **H1 — one parked stackful
/// task per store** — with the cost "a parked task holds its store".
#[test]
fn q3_two_fibers_cannot_both_be_inside_one_store() {
    let engine = Engine::default();
    let module = Module::new(&engine, GUEST).expect("the WAT compiles");
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let store: Arc<Mutex<Store<()>>> = Arc::new(Mutex::new(Store::new(&engine, ())));

    let stack = || {
        FiberStack::new(512 * 1024, true)
            .map_err(|_| "stack")
            .expect("a fiber stack")
    };

    let a = {
        let (log, store, engine, module) = (
            Arc::clone(&log),
            Arc::clone(&store),
            engine.clone(),
            module.clone(),
        );
        Fiber::<'_, Resume, Yield, (bool, i32)>::new(stack(), move |(), suspend| {
            let handle = suspend as *mut _ as *mut ();
            let previous = current();
            install(handle);
            let result = run_in(&store, &engine, &module, &log);
            install(previous);
            result
        })
        .map_err(|_| "new")
        .expect("fiber A")
    };

    let b = {
        let (log, store, engine, module) = (
            Arc::clone(&log),
            Arc::clone(&store),
            engine.clone(),
            module.clone(),
        );
        Fiber::<'_, Resume, Yield, (bool, i32)>::new(stack(), move |(), suspend| {
            let handle = suspend as *mut _ as *mut ();
            let previous = current();
            install(handle);
            let result = run_in(&store, &engine, &module, &log);
            install(previous);
            result
        })
        .map_err(|_| "new")
        .expect("fiber B")
    };

    // A runs to its suspension, holding the store.
    assert!(a.resume(()).is_err(), "A suspends mid-call");
    note(&log,
        "host loop: A is suspended inside its call, still holding the store",
    );

    // **The Q3 measurement.**
    let blocked = match store.try_lock() {
        Ok(_) => false,
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Poisoned(_)) => panic!("the store lock is poisoned"),
    };
    assert!(
        blocked,
        "while A is suspended inside its call the store must not be available to B; \
         if this fails the answer is H2, N fibers per store"
    );
    note(&log,
        "host loop: B's try_lock on the store -> WouldBlock (H1: one parked task per store)",
    );

    // A finishes and releases.
    assert_eq!(a.resume(()).ok(), Some((true, 42)), "A completes");

    // Now B can take it — the exclusion was temporal, not permanent.
    assert!(b.resume(()).is_err(), "B suspends mid-call, holding the store");
    note(&log, "host loop: A released the store; B holds it and suspends");
    assert_eq!(b.resume(()).ok(), Some((true, 42)), "B completes");

    let observed = lines(&log);
    let text = observed.join("\n");
    assert!(
        text.contains("A is suspended inside its call, still holding the store"),
        "{text}"
    );
    assert!(text.contains("WouldBlock"), "{text}");

    dump("Q3, verbatim", &log);
}

/// **Q3's constructive half — the cost model, corrected by the measurement.**
///
/// The first version of this test claimed that two parked tasks work "when each has
/// its own store". **That is false**, and the test failed with wasmtime's trap-handler
/// assertion: with one store each and one *thread*, the second fiber still breaks the
/// per-thread LIFO activation list.
///
/// The correct row is *stackful task = store + fiber + thread*. Two parked tasks do
/// work when each owns a thread, which is what this test measures: both fibers are
/// inside wasm at the same time, on two OS threads, and both complete.
///
/// The price is real and it belongs in the capability table: concurrency for stackful
/// tasks costs an OS thread per concurrently-parked task, not a slot in a pool.
#[test]
fn q3_two_parked_tasks_work_when_each_has_its_own_thread() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    // Both threads park before either resumes, which is the whole point.
    let both_parked = Arc::new(std::sync::Barrier::new(2));

    let results: Vec<i32> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for id in 1..=2 {
            let log = Arc::clone(&log);
            let barrier = Arc::clone(&both_parked);
            let engine = &engine;
            let module = &module;
            handles.push(scope.spawn(move || {
                let fiber = guest_fiber(engine, module, &log, 512 * 1024);
                assert!(fiber.resume(()).is_err(), "thread {id}: suspends inside wasm");
                note(&log, format!("thread {id}: parked inside wasm"));
                // Wait until the other thread is parked too, so the two suspensions
                // genuinely overlap.
                barrier.wait();
                note(&log, format!("thread {id}: both parked, resuming"));
                let value = fiber.resume(()).ok().expect("thread {id}: completes");
                std::mem::forget(fiber);
                value
            }));
        }
        handles
            .into_iter()
            .map(|h| h.join().expect("the thread does not panic"))
            .collect()
    });

    assert_eq!(results, vec![42, 42], "both fibers must complete");

    let observed = lines(&log);
    let text = observed.join("\n");
    let parked = observed.iter().filter(|l| l.contains("parked inside wasm")).count();
    assert_eq!(parked, 2, "both threads must have parked:\n{text}");
    assert_eq!(
        observed.iter().filter(|l| l.contains("AFTER")).count(),
        2,
        "each fiber must print its own AFTER:\n{text}"
    );

    dump("Q3 constructive (one thread each), verbatim", &log);
}

// ---------------------------------------------------------------------------
// Q3, the sharper refusal: two parked fibers on one *thread*.
// ---------------------------------------------------------------------------

/// Catch a panic and answer its message, so a refusal can be reported rather than
/// only survived.
fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else {
        "<panic with a non-string payload>".to_string()
    }
}

fn caught_message<T>(result: &std::thread::Result<T>) -> String {
    match result {
        Ok(_) => "<no panic>".to_string(),
        Err(payload) => payload_text(&**payload),
    }
}

/// **Q3's real ceiling, and it is not the store.** Two fibers, **one store each**,
/// both parked inside wasm at the same time on **one OS thread**.
///
/// The brief anticipated "one parked fiber per *store*". The measurement is
/// narrower and more useful: wasmtime keeps a per-thread LIFO linked list of
/// `CallThreadState` activations, and `CallThreadState::pop` asserts it is popping
/// the head:
///
/// ```text
/// /// Panics if this activation isn't the head of the list.
/// pub(crate) unsafe fn pop(&self) {
///     let prev = self.prev.replace(ptr::null());
///     let head = tls::raw::replace(prev);
///     assert!(core::ptr::eq(head, self));
/// }
/// ```
/// (`wasmtime-50.0.2/src/runtime/vm/traphandlers.rs:625-629`)
///
/// Suspend A (A is the head), suspend B (B becomes the head), resume A — and A's
/// pop finds B at the head. The refusal is real, it is wasmtime's, and it is
/// **per thread**, not per store.
#[test]
fn q3_two_parked_fibers_on_one_thread_are_refused() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));

    let a = guest_fiber(&engine, &module, &log, 512 * 1024);
    assert!(a.resume(()).is_err(), "A suspends inside wasm");
    let b = guest_fiber(&engine, &module, &log, 512 * 1024);
    assert!(b.resume(()).is_err(), "B suspends inside wasm on the same thread");
    note(
        &log,
        "host loop: A and B are both parked inside wasm, on one thread",
    );

    // Resuming A now pops a `CallThreadState` that is no longer the head.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let _ = a.resume(());
    }));
    let message = caught_message(&outcome);
    eprintln!("--- Q3 two-parked refusal, verbatim ---");
    for line in lines(&log) {
        eprintln!("{line}");
    }
    eprintln!("resume A with B parked -> {message}");

    // Both are still suspended, and a suspended fiber cannot be dropped
    // (`debug_assert!(self.done.get(), "fiber dropped without finishing")`), which
    // would turn this panic into an abort. Leaking is the only way to report rather
    // than crash.
    std::mem::forget(a);
    std::mem::forget(b);

    assert!(
        outcome.is_err(),
        "resuming A with B parked must be refused; if this passes the ceiling is \
         higher than one parked fiber per thread"
    );
    assert!(
        message.contains("core::ptr::eq") || message.contains("assertion failed"),
        "the refusal must be the trap handler's LIFO assertion, got: {message}"
    );
}

// ---------------------------------------------------------------------------
// Q4 — thread affinity.
// ---------------------------------------------------------------------------

/// Proves a bound by requiring it: this compiles only if the type satisfies it.
fn require_send<T: Send>(_: &T) {}

/// **Q4.** Is a suspended fiber resumable from a different OS thread?
///
/// # The bounds, asked of the compiler
///
/// `Fiber` **is** `Send` — this line would not build otherwise:
fn _fiber_is_send() {
    require_send(&None::<Fiber<'static, Resume, Yield, i32>>);
}
///
/// `Suspend` is **not**, and the compiler names the reason:
///
/// ```text
/// error[E0277]: `*mut u8` cannot be sent between threads safely
///    |
///    = help: within `Suspend<(), &str, i32>`, the trait `Send` is not implemented
///            for `*mut u8`
/// ```
///
/// That is `Suspend { top_of_stack: *mut u8 }` (`nostd.rs:125` — the active
/// implementation here; see the module docs on why it is not `unix.rs`). A
/// `Suspend` exists only on the fiber's own stack and cannot be carried anywhere.
///
/// # The runtime half
///
/// `Fiber: Send` is the *permission* to hand a parked task to another executor. The
/// measurement is whether resuming it there actually works, given that the trap
/// handler's activation was pushed on the creating thread and the handle had to be
/// republished process-wide.
#[test]
fn q4_thread_affinity() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let fiber = guest_fiber(&engine, &module, &log, 512 * 1024);
    assert!(fiber.resume(()).is_err(), "the fiber suspends on this thread");
    assert!(!fiber.done());
    note(&log, "host loop (thread 1): the fiber is suspended here");

    // The handle cannot travel as a `Suspend` (it is `!Send`), so it travels as a
    // bare address and is re-installed on the resuming thread. That is the cost of
    // cross-thread resume: a pool would have to own this unsafe step, and own the
    // claim that the fiber is not resumed concurrently on both threads.
    let handle = current() as usize;

    let moved_log = Arc::clone(&log);
    let described = std::thread::spawn(move || {
        install(handle as *mut ());
        let result = catch_unwind(AssertUnwindSafe(|| {
            let r = fiber.resume(());
            std::mem::forget(fiber);
            r
        }));
        let described = match &result {
            Ok(Ok(value)) => format!("Ok({value}) — resumed and completed on thread 2"),
            Ok(Err(reason)) => format!("Err({reason})"),
            Err(payload) => format!("panicked: {}", payload_text(&**payload)),
        };
        note(&moved_log,
            format!("host loop (thread 2): resume returned {described}"),
        );
        described
    })
    .join()
    .expect("the resuming thread does not panic outside the catch");

    eprintln!("--- Q4, cross-thread resume, verbatim ---");
    for line in lines(&log) {
        eprintln!("{line}");
    }
    eprintln!("cross-thread resume outcome: {described}");

    // Recorded, not asserted: the finding is which outcome it is, and every one of
    // them is a fact the capability table needs. The `eprintln!` above is the
    // evidence; this assertion only ensures the resuming side reported at all.
    assert!(
        lines(&log).iter().any(|l| l.contains("thread 2")),
        "the resuming side must have reported"
    );
}
