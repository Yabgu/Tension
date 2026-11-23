//! DL25 — the fiber executor: park suspends, a wake resumes, silence is named.
//!
//! # What this adds over DL24
//!
//! DL24 proved the *mechanism* in a single-threaded test: a host import can suspend
//! the calling fiber, and a later resume continues the guest with its locals intact.
//! It did not prove the **executor**, which is the thing a policy would implement:
//!
//! - a thread's loop that owns **exactly one** suspended fiber at a time;
//! - a wake addressed to a task on that thread, which resumes it;
//! - a parked fiber with no wake, **refused by name at shutdown** — the shape that
//!   would make I58 (a stackful continuation abandoned silently) loud;
//! - a wake that arrives for a task this executor does **not** own — refused, not
//!   resumed and not dropped. That is the pin DL24's Q4 requires.
//!
//! # The wake channel, and why this one
//!
//! `Mutex<VecDeque<Wake>> + Condvar`, per executor. Not an `mpsc` channel, because the
//! executor has to be able to *look* at what it has been handed and refuse a wake that
//! names someone else's task — a receiver that must accept or block cannot do that.
//! It is also the shape `tension-core/src/thread.rs`'s `ExecutorPool` already uses
//! (`inboxes: Mutex<Vec<Delivery>>` + `wake: Condvar`), so the probe measures the
//! arrangement the shipped pool would grow into rather than an invented one.
//!
//! # Process, not engine
//!
//! Nothing here touches `tension-core/src`, the shipped `scheduler::park`, the ABI
//! doc, std, or the compiler. The guest calls imports **this file defines**. That is
//! the round's gate, and it is why every answer below describes a mechanism that
//! could be adopted rather than a feature that now exists.
//!
//! # The one suspended fiber per thread constraint, honoured by construction
//!
//! DL24 measured that wasmtime's trap handler keeps a **per-thread** LIFO list of
//! activations (`CallThreadState`), so two fibers parked at once on one thread abort
//! on the second pop. This executor therefore creates, resumes and finishes its fiber
//! entirely inside one `serve` call on one thread, and holds exactly one at a time.
//! The constraint is not worked around; it is the loop's shape.

use std::cell::Cell;
use std::collections::VecDeque;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use wasmtime::{Caller, Engine, Linker, Module, Store};
use wasmtime_internal_fiber::{Fiber, FiberStack, Suspend};

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/// A task id, as the executor sees it. `u32` because it is an index in a pool, not a
/// guest address — this probe has no guest-side task table at all.
type TaskId = u32;

/// What the guest suspended on: the contract's `(class, key)` pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Park {
    class: i32,
    key: i32,
}

/// A wake: which task, and the pair it was waiting on. The pair travels so a refusal
/// can name it — a wake that only carried a task id would be refusable but not
/// explainable.
#[derive(Clone, Copy, Debug)]
struct Wake {
    task: TaskId,
    class: i32,
    key: i32,
}

/// A task left parked when its executor stopped.
#[derive(Clone, Copy, Debug)]
struct Strand {
    task: TaskId,
    park: Park,
}

impl std::fmt::Display for Strand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "task {} parked on class {} key {} and no wake arrived",
            self.task, self.park.class, self.park.key
        )
    }
}

/// A wake that named a task this executor does not own.
#[derive(Clone, Copy, Debug)]
struct WrongOwner {
    task: TaskId,
    park: Park,
    executor: usize,
}

impl std::fmt::Display for WrongOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "executor {} refused a wake for task {} (class {} key {}): it owns no such task",
            self.executor, self.task, self.park.class, self.park.key
        )
    }
}

/// How a `serve` call ended.
///
/// `Stranded` **is** the round's refusal: a value, not a process exit. A caller in the
/// binary would turn it into `Error: …` and exit 1, exactly as `strand_refusal` does
/// for the promise backend; here the probe returns it so a test can assert on the name.
#[derive(Debug)]
enum Outcome {
    /// The guest ran to completion with this result.
    Done(i32),
    /// The guest was still parked when the executor stopped.
    Stranded(Strand),
    /// A wake for a foreign task arrived, **and** this executor's own task was still
    /// parked at shutdown. Both are reported: the refusal is the pin, the strand is
    /// what would otherwise have been silent.
    RefusedWake {
        refusal: WrongOwner,
        stranded: Strand,
    },
}

// ---------------------------------------------------------------------------
// The scoped suspend handle (DL24's mechanism, unchanged)
// ---------------------------------------------------------------------------

thread_local! {
    static SUSPEND: Cell<*mut ()> = const { Cell::new(ptr::null_mut()) };
}

fn install(handle: *mut ()) {
    SUSPEND.with(|slot| slot.set(handle));
}

fn current() -> *mut () {
    SUSPEND.with(|slot| slot.get())
}

// ---------------------------------------------------------------------------
// The guest
// ---------------------------------------------------------------------------

/// `run(task, key)` prints `BEFORE` with the task id, parks on `(4, key)`, then prints
/// `AFTER` with `keep`.
///
/// `keep` is the contract's proof point: a local written before the park and read
/// after the resume. `task` and `key` are parameters so one module serves every task
/// in this file — no per-task rebuild, and the log says which task printed what.
const GUEST: &str = r#"
(module
  (import "env" "__park" (func $park (param i32 i32)))
  (import "env" "__print32" (func $print32 (param i32 i32)))
  (func (export "run") (param $task i32) (param $key i32) (result i32)
    (local $keep i32)
    (local.set $keep (i32.const 42))
    ;; tag 1 = BEFORE, value = the task id.
    (call $print32 (i32.const 1) (local.get $task))
    (call $park (i32.const 4) (local.get $key))
    ;; tag 2 = AFTER, value = the local, which must still be 42.
    (call $print32 (i32.const 2) (local.get $keep))
    (local.get $keep)))
"#;

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/// The re-park guest: **two** parks in sequence from one task.
///
/// `run(task, key)` parks on `(4, key)`, prints `AFTER 1`, parks on `(5, key + 1000)`,
/// prints `AFTER 2`, and returns 42. Two parks, two wakes, one task — the shape a
/// loading-zone task has when it awaits several resources in turn.
///
/// The keys differ (7 then 1007 for `key = 7`) on purpose: the executor's ledger wants
/// one entry per key, so two different keys is what lets both parks be recorded without
/// the second displacing the first.
const GUEST_REPARK: &str = r#"
(module
  (import "env" "__park" (func $park (param i32 i32)))
  (import "env" "__print32" (func $print32 (param i32 i32)))
  (func (export "run") (param $task i32) (param $key i32) (result i32)
    (local $keep i32)
    (local.set $keep (i32.const 42))
    (call $print32 (i32.const 1) (local.get $task))
    ;; first park: (4, key)
    (call $park (i32.const 4) (local.get $key))
    ;; tag 3 = AFTER 1, value = the local
    (call $print32 (i32.const 3) (local.get $keep))
    ;; second park: (5, key + 1000)
    (call $park (i32.const 5) (i32.add (local.get $key) (i32.const 1000)))
    ;; tag 4 = AFTER 2, value = the local
    (call $print32 (i32.const 4) (local.get $keep))
    (local.get $keep)))
"#;

type Log = Arc<Mutex<Vec<String>>>;

fn note(log: &Log, line: impl Into<String>) {
    let line = line.into();
    eprintln!("{line}");
    log.lock().unwrap().push(line);
}

fn lines(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

/// One executor: an owner thread's queue and the loop that serves it.
struct Executor {
    id: usize,
    queue: Mutex<VecDeque<Wake>>,
    cv: Condvar,
    stop: AtomicBool,
}

impl Executor {
    fn new(id: usize) -> Arc<Self> {
        Arc::new(Self {
            id,
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            stop: AtomicBool::new(false),
        })
    }

    /// Post a wake. Callable from any thread, which is the point: a producer is not
    /// the owner.
    fn post(&self, wake: Wake) {
        self.queue.lock().unwrap().push_back(wake);
        self.cv.notify_all();
    }

    /// Tell the executor to stop after its next wait.
    fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    /// Block until there is a wake to consider, or the executor is told to stop.
    ///
    /// `None` is "stop", `Some(wake)` is "consider this". A spurious wakeup is handled
    /// by looping, so this is the §3.2 "no spin" shape: a real primitive, re-checked.
    fn wait(&self) -> Option<Wake> {
        let mut queue = self.queue.lock().unwrap();
        loop {
            if let Some(wake) = queue.pop_front() {
                return Some(wake);
            }
            if self.stop.load(Ordering::SeqCst) {
                return None;
            }
            let (guard, timeout) = self
                .cv
                .wait_timeout(queue, Duration::from_millis(50))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue = guard;
            if timeout.timed_out() && self.stop.load(Ordering::SeqCst) {
                // Re-checked at the top of the loop; this branch only keeps the
                // timeout from being mistaken for a wake.
                continue;
            }
        }
    }

    /// Serve one task on **the calling thread**: create a fiber, resume it, and loop
    /// until it finishes, a foreign wake arrives, or the executor is stopped.
    ///
    /// Runs on the calling thread because a fiber is thread-affine (DL24 Q4): it must
    /// be created, suspended and resumed on one thread.
    fn serve(
        &self,
        engine: &Engine,
        module: &Module,
        log: &Log,
        task: TaskId,
        key: i32,
        parked_gate: Option<&Gate>,
    ) -> Outcome {
        let stack = FiberStack::new(512 * 1024, true)
            .map_err(|_| "the fiber stack could not be allocated")
            .expect("a fiber stack");

        let (engine_for_fiber, module_for_fiber, log_for_fiber) =
            (engine.clone(), module.clone(), Arc::clone(log));
        // `Option` so the fiber can be moved out on each exit path: `mem::forget`
        // needs ownership, and a suspended fiber **cannot be dropped**
        // (`debug_assert!(self.done.get(), "fiber dropped without finishing")`).
        let mut slot: Option<Fiber<'_, (), Park, i32>> = Some(
            Fiber::new(stack, move |(), suspend| {
                let handle = suspend as *mut _ as *mut ();
                let previous = current();
                install(handle);
                let result = run_guest(
                    &engine_for_fiber,
                    &module_for_fiber,
                    &log_for_fiber,
                    task,
                    key,
                );
                install(previous);
                result
            })
            .map_err(|_| "Fiber::new refused")
            .expect("a fiber"),
        );

        // -- first resume: run to the park, or to completion -------------------
        let mut parked = match slot.as_ref().unwrap().resume(()) {
            Ok(value) => {
                // Finished without parking. Reclaim the stack properly.
                if let Some(fiber) = slot.take() {
                    let _ = fiber.into_stack();
                }
                return Outcome::Done(value);
            }
            Err(park) => park,
        };
        note(
            log,
            format!(
                "executor {}: parked class={} key={} (task {task})",
                self.id, parked.class, parked.key
            ),
        );
        if let Some(gate) = parked_gate {
            gate.park();
        }

        // -- the loop ---------------------------------------------------------
        let mut refusal: Option<WrongOwner> = None;
        loop {
            let Some(wake) = self.wait() else { break };

            if wake.task != task {
                // **The pin.** A wake for a task this executor does not own. Refused
                // by name; the fiber is *not* resumed, and it is not dropped either
                // (it is leaked below, because a suspended fiber cannot be dropped).
                let refusal_value = WrongOwner {
                    task: wake.task,
                    park: Park {
                        class: wake.class,
                        key: wake.key,
                    },
                    executor: self.id,
                };
                note(log, format!("{refusal_value}"));
                refusal = Some(refusal_value);
                break;
            }

            match slot.as_ref().unwrap().resume(()) {
                Ok(value) => {
                    if let Some(fiber) = slot.take() {
                        let _ = fiber.into_stack();
                    }
                    note(
                        log,
                        format!("executor {}: task {task} resumed and finished", self.id),
                    );
                    return Outcome::Done(value);
                }
                Err(next) => {
                    // The guest parked again. Legal, and the loop keeps serving: the
                    // task is still the executor's to resume. This is the
                    // loading-zone shape — one stackful task awaiting several things
                    // in sequence — and until DL26 no test reached it.
                    parked = next;
                    note(
                        log,
                        format!(
                            "executor {}: task {task} parked again class={} key={}",
                            self.id, parked.class, parked.key
                        ),
                    );
                    if let Some(gate) = parked_gate {
                        gate.park();
                    }
                }
            }
        }

        // -- shutdown ---------------------------------------------------------
        // The fiber is still suspended, so it cannot be dropped. Leaking it is the
        // only sound choice, and it is the price H2's naming costs: an abandoned
        // stackful task leaks its stack.
        if let Some(fiber) = slot.take() {
            std::mem::forget(fiber);
        }

        let stranded = Strand {
            task,
            park: parked,
        };
        match refusal {
            Some(refusal) => Outcome::RefusedWake {
                refusal,
                stranded,
            },
            None => {
                note(log, format!("executor {}: STRANDED — {stranded}", self.id));
                Outcome::Stranded(stranded)
            }
        }
    }
}

/// A counting gate: the test's way to know that N executors have parked before it
/// posts wakes. Not part of the mechanism — it exists so H3's "both parked, then wake
/// in reverse order" is a synchronisation rather than a sleep.
struct Gate {
    parked: Mutex<usize>,
    cv: Condvar,
    want: usize,
}

impl Gate {
    fn new(want: usize) -> Self {
        Gate {
            parked: Mutex::new(0),
            cv: Condvar::new(),
            want,
        }
    }

    fn park(&self) {
        let mut count = self.parked.lock().unwrap();
        *count += 1;
        self.cv.notify_all();
    }

    fn wait_until_all_parked(&self) {
        self.wait_for(self.want);
    }

    /// Wait until at least `n` parks have happened.
    ///
    /// The re-park test needs staged waits: only **one** park exists until the first
    /// wake resumes the task, so waiting for two before posting anything deadlocks.
    fn wait_for(&self, n: usize) {
        let mut count = self.parked.lock().unwrap();
        while *count < n {
            count = self.cv.wait(count).unwrap_or_else(|p| p.into_inner());
        }
    }
}

/// Run the guest's `run(task, key)` in its own store, inside a fiber's closure.
fn run_guest(engine: &Engine, module: &Module, log: &Log, task: TaskId, key: i32) -> i32 {
    let mut store = Store::new(engine, ());
    let mut linker = Linker::new(engine);

    let park_log = Arc::clone(log);
    linker
        .func_wrap(
            "env",
            "__park",
            move |_caller: Caller<'_, ()>, class: i32, key: i32| -> Result<(), wasmtime::Error> {
                note(
                    &park_log,
                    format!("guest (task {task}): inside __park({class}, {key})"),
                );
                let handle = current();
                if handle.is_null() {
                    return Err(wasmtime::Error::msg(
                        "no suspend handle was published for this thread",
                    ));
                }
                // SAFETY: published by the fiber closure immediately before the wasm
                // call that is running right now; lives on this fiber's stack for the
                // whole of that call.
                let suspend: &mut Suspend<(), Park, i32> =
                    unsafe { &mut *(handle as *mut Suspend<(), Park, i32>) };
                let (): () = suspend.suspend(Park { class, key });
                note(
                    &park_log,
                    format!("guest (task {task}): __park returned — resumed"),
                );
                Ok(())
            },
        )
        .expect("the park import");

    let print_log = Arc::clone(log);
    linker
        .func_wrap(
            "env",
            "__print32",
            move |_caller: Caller<'_, ()>, tag: i32, value: i32| {
                let line = match tag {
                    1 => format!("guest (task {value}): BEFORE the park"),
                    2 => format!("guest (task {task}): AFTER the park keep={value}"),
                    // The re-park guest's two halves. The numbers are checked as
                    // well as the order: `keep` is set once, before either park, so a
                    // frame that did not survive the *second* suspension would show a
                    // different value in AFTER 2.
                    3 => format!("guest (task {task}): AFTER 1 keep={value}"),
                    4 => format!("guest (task {task}): AFTER 2 keep={value}"),
                    _ => format!("guest (task {task}): print tag {tag} value {value}"),
                };
                note(&print_log, line);
            },
        )
        .expect("the print import");

    let instance = linker
        .instantiate(&mut store, module)
        .expect("the guest instantiates");
    let run = instance
        .get_typed_func::<(i32, i32), i32>(&mut store, "run")
        .expect("the guest exports `run`");
    run.call(&mut store, (task as i32, key))
        .expect("the guest runs")
}

fn engine_and_module() -> (Engine, Module) {
    let engine = Engine::default();
    let module = Module::new(&engine, GUEST).expect("the WAT compiles");
    (engine, module)
}

// ---------------------------------------------------------------------------
// H1 — park suspends, wake resumes, frame survives.
// ---------------------------------------------------------------------------

/// The round's first half: one thread, one fiber, one park, one wake.
///
/// The wake is posted **from another thread** after the executor has parked, so the
/// resume is driven by a message crossing a thread boundary rather than by the same
/// stack that suspended — which is what an executor is for.
#[test]
fn h1_park_suspends_a_wake_resumes_and_the_local_survives() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let executor = Executor::new(1);
    let gate = Gate::new(1);

    let (outcome, _) = std::thread::scope(|scope| {
        let worker = {
            let executor = Arc::clone(&executor);
            let log = Arc::clone(&log);
            let gate = &gate;
            let engine = &engine;
            let module = &module;
            scope.spawn(move || executor.serve(engine, module, &log, 1, 7, Some(gate)))
        };

        // Wait until the fiber is genuinely parked, then post the wake from *this*
        // thread — a producer that is not the owner.
        gate.wait_until_all_parked();
        executor.post(Wake {
            task: 1,
            class: 4,
            key: 7,
        });

        let outcome = worker.join().expect("the executor thread does not panic");
        (outcome, ())
    });

    let observed = lines(&log);
    let text = observed.join("\n");

    assert!(
        matches!(outcome, Outcome::Done(42)),
        "the task must complete with the guest's result, got {outcome:?}:\n{text}"
    );

    // The three orderings the contract asks for, each by position.
    let before = observed
        .iter()
        .position(|l| l.contains("BEFORE the park"))
        .unwrap_or_else(|| panic!("no BEFORE line:\n{text}"));
    let parked = observed
        .iter()
        .position(|l| l.contains("inside __park(4, 7)"))
        .unwrap_or_else(|| panic!("no park line:\n{text}"));
    let loop_saw = observed
        .iter()
        .position(|l| l.contains("executor 1: parked class=4 key=7 (task 1)"))
        .unwrap_or_else(|| panic!("the loop never reported the park:\n{text}"));
    let after = observed
        .iter()
        .position(|l| l.contains("AFTER the park keep=42"))
        .unwrap_or_else(|| {
            panic!("no AFTER line, or the local did not survive the resume:\n{text}")
        });

    assert!(
        before < parked && parked < loop_saw && loop_saw < after,
        "order must be BEFORE, park, the loop's line, AFTER:\n{text}"
    );
    assert!(
        text.contains("task 1 resumed and finished"),
        "the loop must report the resume:\n{text}"
    );

    eprintln!("--- H1, verbatim ---");
    for line in &observed {
        eprintln!("{line}");
    }
}

// ---------------------------------------------------------------------------
// H2 — a parked fiber with no wake is named at shutdown.
// ---------------------------------------------------------------------------

/// The round's second half, and the one that matters for I58: **silence is not an
/// option.**
///
/// Same guest, same executor, **no wake**. The executor is told to stop, and its
/// result is `Outcome::Stranded` naming the task and its `(class, key)`. The probe's
/// refusal is that value — an `Err`-shaped answer a binary would turn into a
/// non-zero exit, not a process exit taken here (a test target cannot assert on its
/// own exit status without spawning itself).
#[test]
fn h2_a_parked_fiber_with_no_wake_is_named_at_shutdown() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let executor = Executor::new(1);
    let gate = Gate::new(1);

    let outcome = std::thread::scope(|scope| {
        let worker = {
            let executor = Arc::clone(&executor);
            let log = Arc::clone(&log);
            let gate = &gate;
            let engine = &engine;
            let module = &module;
            scope.spawn(move || executor.serve(engine, module, &log, 1, 7, Some(gate)))
        };

        gate.wait_until_all_parked();
        // **No wake.** Tell the executor to stop instead.
        executor.stop();
        worker.join().expect("the executor thread does not panic")
    });

    let observed = lines(&log);
    let text = observed.join("\n");

    match outcome {
        Outcome::Stranded(strand) => {
            assert_eq!(strand.task, 1, "{text}");
            assert_eq!(
                strand.park,
                Park { class: 4, key: 7 },
                "the strand must name the pair it was waiting on:\n{text}"
            );
            // The refusal is only useful if it is *readable*.
            let rendered = strand.to_string();
            assert!(
                rendered.contains("class 4 key 7"),
                "the refusal must name the pair, got: {rendered}"
            );
        }
        other => panic!("a task parked with no wake must strand, got {other:?}:\n{text}"),
    }

    assert!(
        text.contains("STRANDED"),
        "the shutdown line must be in the log:\n{text}"
    );
    assert!(
        !text.contains("AFTER the park"),
        "with no wake the guest must never reach AFTER:\n{text}"
    );

    eprintln!("--- H2, verbatim ---");
    for line in &observed {
        eprintln!("{line}");
    }
}

// ---------------------------------------------------------------------------
// H3 — two executors, wakes in reverse order, and the pin.
// ---------------------------------------------------------------------------

/// Two threads, one executor each, one parked fiber each. The wakes are delivered in
/// the **reverse** of the parking order, so a wake has to *find its owner*; a queue
/// position would give the wrong answer.
///
/// Task 1 parks on key 71, task 2 on key 72 — different keys so the log can be read
/// without guessing which parked first.
///
/// # Why the wakes are delivered one at a time
///
/// The first version posted both wakes and then asserted that task 2 finished before
/// task 1. **That is a race, not an assertion** — two owner threads resume
/// concurrently, so which guest's `AFTER` lands first is up to the scheduler. The
/// order is made observable instead: both tasks park, task 2 (the *second* to park) is
/// woken and **joined**, and only then is task 1 woken. Nothing sleeps, and the
/// reverse order is deterministic.
///
/// What it still proves is the point: at the moment task 2's wake was posted, task 1
/// was already parked and waiting. A wake routed by queue position would have resumed
/// task 1. It resumed task 2.
#[test]
fn h3_two_executors_are_woken_in_reverse_order() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let one = Executor::new(1);
    let two = Executor::new(2);
    let gate = Gate::new(2);

    std::thread::scope(|scope| {
        let a = {
            let executor = Arc::clone(&one);
            let log = Arc::clone(&log);
            let gate = &gate;
            let engine = &engine;
            let module = &module;
            scope.spawn(move || executor.serve(engine, module, &log, 1, 71, Some(gate)))
        };
        let b = {
            let executor = Arc::clone(&two);
            let log = Arc::clone(&log);
            let gate = &gate;
            let engine = &engine;
            let module = &module;
            scope.spawn(move || executor.serve(engine, module, &log, 2, 72, Some(gate)))
        };

        // Both parked before either is woken.
        gate.wait_until_all_parked();

        // **Reverse order:** the task that parked second is woken first, and completes
        // before the other is woken at all.
        two.post(Wake {
            task: 2,
            class: 4,
            key: 72,
        });
        let outcome_b = b.join().expect("executor 2 does not panic");
        one.post(Wake {
            task: 1,
            class: 4,
            key: 71,
        });
        let outcome_a = a.join().expect("executor 1 does not panic");

        let observed = lines(&log);
        let text = observed.join("\n");

        for (executor, outcome) in [(1, &outcome_a), (2, &outcome_b)] {
            assert!(
                matches!(outcome, Outcome::Done(42)),
                "executor {executor} must complete, got {outcome:?}:\n{text}"
            );
        }

        // Both AFTER lines, and task 2's is earlier in the log — it finished while task
        // 1 was still parked, which the join above ordered.
        let after2 = observed
            .iter()
            .position(|l| l.contains("AFTER the park keep=42") && l.contains("task 2"))
            .unwrap_or_else(|| panic!("task 2 never printed AFTER:\n{text}"));
        let after1 = observed
            .iter()
            .position(|l| l.contains("AFTER the park keep=42") && l.contains("task 1"))
            .unwrap_or_else(|| panic!("task 1 never printed AFTER:\n{text}"));
        assert!(
            after2 < after1,
            "task 2 was woken first and must finish first:\n{text}"
        );

        // And task 1 was parked the whole time task 2 ran: its resume line is later.
        let resumed1 = observed
            .iter()
            .position(|l| l.contains("executor 1: task 1 resumed and finished"))
            .unwrap_or_else(|| panic!("executor 1 never reported its resume:\n{text}"));
        assert!(
            after2 < resumed1,
            "task 1 must still have been parked when task 2 finished:\n{text}"
        );

        eprintln!("--- H3 reverse order, verbatim ---");
        for line in &observed {
            eprintln!("{line}");
        }
    });
}

/// **The pin.** A wake addressed to a task the executor does not own must be
/// **refused by name** — not resumed, not dropped.
///
/// The executor owns task 1; a wake for task 99 is posted. The refusal names the
/// executor and the task; the executor's own task is *still parked*, so the same run
/// also reports the strand. Both facts in one outcome, because a refusal that hid the
/// strand would be the silent loss this round exists to prevent.
#[test]
fn h3_a_wake_for_a_foreign_task_is_refused_by_name() {
    let (engine, module) = engine_and_module();
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let executor = Executor::new(1);
    let gate = Gate::new(1);

    let outcome = std::thread::scope(|scope| {
        let worker = {
            let executor = Arc::clone(&executor);
            let log = Arc::clone(&log);
            let gate = &gate;
            let engine = &engine;
            let module = &module;
            scope.spawn(move || executor.serve(engine, module, &log, 1, 7, Some(gate)))
        };

        gate.wait_until_all_parked();
        // The executor owns task 1. This names task 99.
        executor.post(Wake {
            task: 99,
            class: 4,
            key: 7,
        });
        worker.join().expect("the executor thread does not panic")
    });

    let observed = lines(&log);
    let text = observed.join("\n");

    match outcome {
        Outcome::RefusedWake {
            refusal,
            stranded,
        } => {
            assert_eq!(refusal.task, 99, "the refusal must name the foreign task:\n{text}");
            assert_eq!(refusal.executor, 1, "and the executor that refused it:\n{text}");
            let rendered = refusal.to_string();
            assert!(
                rendered.contains("task 99") && rendered.contains("executor 1"),
                "the refusal must be readable, got: {rendered}"
            );
            // **Not resumed**: the guest never printed AFTER, and the executor's own
            // task is still parked.
            assert_eq!(stranded.task, 1, "{text}");
            assert_eq!(stranded.park, Park { class: 4, key: 7 }, "{text}");
        }
        other => panic!(
            "a wake for a foreign task must be refused and the own task stranded, \
             got {other:?}:\n{text}"
        ),
    }

    assert!(
        !text.contains("AFTER the park"),
        "the foreign wake must not resume anything:\n{text}"
    );

    eprintln!("--- H3 pin, verbatim ---");
    for line in &observed {
        eprintln!("{line}");
    }
}

// ---------------------------------------------------------------------------
// I62 — re-park: one task, two parks in sequence.
// ---------------------------------------------------------------------------

/// **The loading-zone shape**: one stackful task awaiting several things in turn.
///
/// The guest parks on `(4, 7)`, is woken, prints `AFTER 1`, parks on `(5, 1007)`, is
/// woken again, prints `AFTER 2`, and returns 42. The executor serves both wakes from
/// one loop, with one fiber that is suspended twice.
///
/// # What this test does and does not reach
///
/// It exercises the probe's `Err(next)` branch — the re-park arm of the loop — which
/// until DL26 no test had run. It does **not** exercise `src/thread.rs`'s resolution
/// marking, and that distinction matters: see `DL26-REPORT.md` §B, where the engine's
/// find-first lookup is quoted as a live, unguarded defect. The probe holds **one**
/// `Park` in a local (the `parked` variable it overwrites); the engine holds a `Vec`
/// and searches it. A test in this file cannot reach the second.
///
/// # Why the wakes are staged
///
/// The second park does not exist until the first wake resumes the task, so the gate
/// is waited on twice, with the first wake posted in between. No sleeps.
#[test]
fn b_repark_one_task_parks_twice_and_both_wakes_resume_it() {
    let engine = Engine::default();
    let module = Module::new(&engine, GUEST_REPARK).expect("the re-park WAT compiles");
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let executor = Executor::new(1);
    let gate = Gate::new(2);

    let outcome = std::thread::scope(|scope| {
        let worker = {
            let executor = Arc::clone(&executor);
            let log = Arc::clone(&log);
            let gate = &gate;
            let engine = &engine;
            let module = &module;
            scope.spawn(move || executor.serve(engine, module, &log, 1, 7, Some(gate)))
        };

        // First park on (4, 7).
        gate.wait_for(1);
        executor.post(Wake {
            task: 1,
            class: 4,
            key: 7,
        });

        // The task resumed and parked again, on (5, 1007).
        gate.wait_for(2);
        executor.post(Wake {
            task: 1,
            class: 5,
            key: 1007,
        });

        worker.join().expect("the executor thread does not panic")
    });

    let observed = lines(&log);
    let text = observed.join("\n");

    assert!(
        matches!(outcome, Outcome::Done(42)),
        "the twice-parked task must complete with 42, got {outcome:?}:\n{text}"
    );
    assert!(
        !text.contains("STRANDED"),
        "a task that resumed from both parks must not strand:\n{text}"
    );

    let after1 = observed
        .iter()
        .position(|l| l.contains("AFTER 1 keep=42"))
        .unwrap_or_else(|| panic!("no AFTER 1 line:\n{text}"));
    let after2 = observed
        .iter()
        .position(|l| l.contains("AFTER 2 keep=42"))
        .unwrap_or_else(|| panic!("no AFTER 2 line:\n{text}"));
    assert!(
        after1 < after2,
        "the two halves must be printed in order:\n{text}"
    );

    // The local survives *both* suspensions: it was set once, before either park.
    assert_eq!(
        observed
            .iter()
            .filter(|l| l.contains("AFTER 1 keep=42") || l.contains("AFTER 2 keep=42"))
            .count(),
        2,
        "both AFTER lines must carry keep=42:\n{text}"
    );

    eprintln!("--- B: re-park, verbatim ---");
    for line in &observed {
        eprintln!("{line}");
    }
}

// ---------------------------------------------------------------------------
// C — delivery validation: which record a wake is for, and when it is refused.
// ---------------------------------------------------------------------------

/// **The two halves of `delivery_target`**, which is the decision `service_wakes` now
/// makes before it calls `__taskWake`.
///
/// # Why this is testable here and the executor is not
///
/// The engine's guard lives inside `service_wakes`, on a worker's own thread, against a
/// store nothing outside can reach. The *decision* was extracted into
/// `tension_core::thread::delivery_target(parks, task_id)` precisely so it can be
/// asserted: it takes a slice of the real `WorkerPark` records and answers an index or
/// `None`. This test is the gate for the two behaviours that matter, and it is the test
/// that would have caught the find-first marking DL22 shipped.
///
/// # Case 1 — a re-parking task (I62)
///
/// One task id, two records: the first resolved by its wake, the second still waiting.
/// The answer must be the **second**. `find(|p| p.task_id == id)` answers the first,
/// which is the defect: it marks an already-resolved record and leaves the live park
/// unresolved, so the strand refusal reports a task that resumed correctly.
///
/// # Case 2 — an id this store never parked (I55)
///
/// No record at all → `None`, and `service_wakes` refuses by name and does not wake.
/// A foreign or recycled id names a *different* task in this store's slot table.
#[test]
fn c_delivery_target_prefers_the_unresolved_record_and_refuses_an_unknown_id() {
    use tension_core::thread::{delivery_target, WorkerPark};

    let record = |task_id: u64, resolved: bool| WorkerPark {
        task_id,
        class: 4,
        key: 7,
        resolved,
    };

    // -- case 1: find-first would answer 0; the live park is 1 -----------------
    let two = [record(7, true), record(7, false)];
    assert_eq!(
        delivery_target(&two, 7),
        Some(1),
        "a wake must mark the *unresolved* record — index 0 is already resolved, and \
         marking it again is the false-STRANDED defect"
    );

    // The same question with the records the other way round: still the unresolved one,
    // not the first.
    let reversed = [record(7, false), record(7, true)];
    assert_eq!(
        delivery_target(&reversed, 7),
        Some(0),
        "the rule is 'unresolved first', not 'lowest index'"
    );

    // -- every record for that id already resolved -----------------------------
    // Not refused: a second post for a key that completed is the engine's own
    // behaviour (the AI stream posts READY then DONE for one key). The wake proceeds
    // and `__taskWake` is a no-op, so an index is the right answer.
    let all_resolved = [record(7, true), record(7, true)];
    assert!(
        delivery_target(&all_resolved, 7).is_some(),
        "an already-resolved id is delivered, not refused — the measurement, not a change"
    );

    // -- case 2: an id this store never parked --------------------------------
    assert_eq!(
        delivery_target(&two, 99),
        None,
        "an id with no record must be refused: waking it would resume whatever \
         `slots[99]` names in this store"
    );
    assert_eq!(
        delivery_target(&[], 7),
        None,
        "an empty park list refuses every delivery"
    );

    // -- and a different task's record is not this one ------------------------
    let other = [record(8, false)];
    assert_eq!(
        delivery_target(&other, 7),
        None,
        "a record for another task does not authorise this id"
    );

    // -- the refusal must be readable ---------------------------------------
    // The guard's message names all four facts a reader needs to find the producer:
    // which executor, which task, and the pair the completion was posted for.
    {
        use tension_core::thread::RefusedDelivery;
        let refused = RefusedDelivery {
            executor: 1,
            task_id: 99,
            class: 4,
            key: 7,
        };
        let rendered = refused.to_string();
        for needle in ["executor 1", "task 99", "class 4", "key 7"] {
            assert!(
                rendered.contains(needle),
                "the refusal must name `{needle}`, got: {rendered}"
            );
        }
        eprintln!("--- C: refusal message ---");
        eprintln!("{rendered}");
    }

    // -- the pool's own half: refused deliveries are taken, not read -----------
    // The three pieces of the guard are each asserted here: the decision (above), the
    // message (above), and the pool bookkeeping `service_wakes` writes through. What is
    // **not** asserted is the wiring — that `service_wakes` actually calls these — which
    // needs a worker whose store receives a foreign delivery, and nothing outside the
    // crate can hand one to a store. Stated in `DL26-REPORT.md` §C.
    {
        use std::sync::Arc;
        use tension_core::thread::{shared_memory_import, ExecutorPool, RefusedDelivery};
        use wasmtime::{Engine, Module, SharedMemory};

        // Shared memory has to be enabled on the engine before a module that imports
        // one can even be created — the pool's own construction requires it.
        let mut config = wasmtime::Config::new();
        config.shared_memory(true);
        let engine = Engine::new(&config).expect("an engine with shared memory");
        let module = Module::new(
            &engine,
            r#"(module (import "env" "memory" (memory 1 4 shared)))"#,
        )
        .expect("the minimal shared-memory module");
        let ty = shared_memory_import(&module).expect("it imports a shared memory");
        let memory = SharedMemory::new(&engine, ty).expect("a shared memory");
        fn identity(class: u32) -> u32 {
            class
        }
        fn wide(_family: u32) -> Option<u32> {
            Some(1024)
        }
        let pool: Arc<ExecutorPool> =
            ExecutorPool::new(engine, module, memory, 2, identity, wide).expect("a pool");

        assert!(
            pool.take_refused_deliveries().is_empty(),
            "a fresh pool has refused nothing"
        );
        pool.note_refused_delivery(RefusedDelivery {
            executor: 1,
            task_id: 99,
            class: 4,
            key: 7,
        });
        let taken = pool.take_refused_deliveries();
        assert_eq!(taken.len(), 1, "the refusal is recorded");
        assert_eq!(taken[0].task_id, 99);
        assert!(
            pool.take_refused_deliveries().is_empty(),
            "taken, not read: one refusal cannot become two"
        );
    }

    eprintln!("--- C: delivery_target, all cases ---");
    eprintln!("two = [resolved(7), unresolved(7)] -> {:?}", delivery_target(&two, 7));
    eprintln!("all_resolved(7)                     -> {:?}", delivery_target(&all_resolved, 7));
    eprintln!("unknown id 99                       -> {:?}", delivery_target(&two, 99));
    eprintln!("empty                               -> {:?}", delivery_target(&[], 7));
}
