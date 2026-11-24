//! DL36 — the fiber executor, from the binary and from the library.
//!
//! `src/fiber.rs` is the executor and `tests/fiber.rs` (DL24) measured the
//! *mechanism* in isolation. This file is the round's contract: a real guest,
//! under the real host, with the executor chosen **by the artifact** rather than
//! by a flag, and every refusal named.
//!
//! # The five claims
//!
//! 1. `a_fiber_guest_parks_and_resumes_with_the_producers_word` — the guest parks
//!    once, the host posts the completion **after** the park, the task resumes, and
//!    the value it reads is the producer's (500), not 0. Ordering is asserted, not
//!    assumed: the park line precedes the completion line in the transcript.
//! 2. `a_continuation_guest_is_refused_by_a_fiber_executor` — exit non-zero, both
//!    backend names in the message, nothing instantiated.
//! 3. `a_fiber_guest_is_refused_by_a_continuation_executor` — the same sentence
//!    with the two names swapped.
//! 4. `a_never_woken_park_is_refused_at_shutdown` — no completion, so the run must
//!    fail by name rather than hang or exit 0. Bounded by the test harness's own
//!    patience: the executor returns as soon as its producer says "nothing".
//! 5. `two_parked_tasks_on_two_threads_both_complete` — two fibers, two OS threads,
//!    both parked at the same time, both resumed with their own value. That is the
//!    shape DL24 measured a *single* thread cannot do, and it is why a pool is one
//!    thread per parked task.
//!
//! # The guest
//!
//! One committed artifact, `tests/programs/fixtures/fiber/i70-fiber.wasm`, with its
//! `.build.json` sidecar. Committed rather than built here because the artifact
//! **is** the compiler behaviour under test (it carries
//! `tension.stackful-backend` = `fiber`), and because the CI job that runs this
//! suite has no compiler — the same rule the thread and debug fixtures follow.

// **No crate-level `cfg`** (DL38, I91). This file carried
// `#![cfg(target_os = "linux")]`, which on any other target compiled the file to
// zero tests — and a suite reporting `test result: ok. 0 passed` is a green line
// over nothing. DL36 read exactly that as a pass. Nothing here is
// platform-specific: the executor is `wasmtime-internal-fiber`, the artifact is
// ordinary wasm, and every host call in the test is `std`. If a single test ever
// needs a target gate it gets one **on that test**, with the platform and the
// reason named.

use std::path::PathBuf;
use std::process::Command;

use tension_core::fiber::{self, Backend, Outcome, Park};

/// The committed fiber guest. **Resolved under the tree**, never from `/tmp`: a
/// test that reads a path outside its own repository is a test that cannot be
/// reproduced.
fn fiber_guest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/programs/fixtures/fiber/i70-fiber.wasm")
}

/// A committed continuation guest, for the mismatch direction that needs one.
/// `wake-on-worker` is a Promise-backend guest: its record is absent, which by
/// the format's own rule means `continuation`.
fn continuation_guest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/programs/fixtures/thread/wake-on-worker.wasm")
}

/// One run of the real binary: `(status, stdout, stderr)`.
fn run(args: &[&std::ffi::OsStr]) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .args(args)
        .output()
        .expect("the host binary runs");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

/// The index of the first stderr line containing `needle`, or `None`.
fn line_at(stderr: &str, needle: &str) -> Option<usize> {
    stderr.lines().position(|line| line.contains(needle))
}

// ---------------------------------------------------------------------------
// 1. The I70 claim, under the real executor
// ---------------------------------------------------------------------------

#[test]
fn a_fiber_guest_parks_and_resumes_with_the_producers_word() {
    let guest = fiber_guest();
    // `500` is the producer's number, and nothing else in this run can produce it:
    // a suspension that never parked, or a park whose completion was dropped, both
    // read 0.
    let (status, stdout, stderr) = run(&[
        "--executors".as_ref(),
        "1".as_ref(),
        "--post-completion".as_ref(),
        "4,7,500".as_ref(),
        guest.as_os_str(),
    ]);

    assert_eq!(status, 0, "the run failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
    // The guest's own transcript: it reached the park and it read the value.
    assert!(stdout.contains("before=1"), "the guest never reached the await:\n{stdout}");
    assert!(
        stdout.contains("value=500"),
        "the awaited value was not the producer's:\n{stdout}"
    );

    // **Counts.** One park, one completion: the host logs both, and the numbers are
    // what make "parks >= 1, wakes >= 1" a measurement rather than a phrase.
    let parks = stderr.lines().filter(|line| line.contains(" parked on class 4 key 7")).count();
    let completions = stderr
        .lines()
        .filter(|line| line.contains("completing class 4 key 7 with 500"))
        .count();
    assert_eq!(parks, 1, "expected exactly one park:\n{stderr}");
    assert_eq!(completions, 1, "expected exactly one completion:\n{stderr}");

    // **Ordering.** The producer is asked only after the guest has parked, so the
    // park line must come first. Asserted rather than trusted: this is I70's whole
    // shape — a completion that arrives before the park is a different mechanism
    // (the sticky buffer) and a different claim.
    let parked = line_at(&stderr, " parked on class 4 key 7").expect("a park line");
    let completed = line_at(&stderr, "completing class 4 key 7 with 500").expect("a completion line");
    assert!(
        parked < completed,
        "the completion was posted before the park:\n{stderr}"
    );

    // And the executor was chosen from the artifact, with no flag saying so.
    assert!(
        stderr.contains("executor: fiber"),
        "the artifact's record did not select the fiber executor:\n{stderr}"
    );
}

// ---------------------------------------------------------------------------
// 2 and 3. The mismatch, both directions
// ---------------------------------------------------------------------------

#[test]
fn a_continuation_guest_is_refused_by_a_fiber_executor() {
    let guest = continuation_guest();
    let (status, stdout, stderr) = run(&[
        "--executors".as_ref(),
        "1".as_ref(),
        "--executor=fiber".as_ref(),
        guest.as_os_str(),
    ]);

    assert_eq!(status, 2, "expected a load-time refusal:\nstdout:\n{stdout}\nstderr:\n{stderr}");
    // Both names, and the direction they are in.
    assert!(
        stderr.contains("built for the `continuation` backend"),
        "the refusal does not name the guest's backend:\n{stderr}"
    );
    assert!(
        stderr.contains("this executor is the `fiber` backend"),
        "the refusal does not name the executor's backend:\n{stderr}"
    );
    // **Nothing ran**: no executor line, and no guest output at all.
    assert!(
        !stderr.contains("executor: fiber"),
        "the refusal came after the executor was chosen:\n{stderr}"
    );
    assert!(stdout.is_empty(), "the guest produced output anyway:\n{stdout}");
}

#[test]
fn a_fiber_guest_is_refused_by_a_continuation_executor() {
    let guest = fiber_guest();
    let (status, stdout, stderr) = run(&[
        "--executors".as_ref(),
        "1".as_ref(),
        "--executor=continuation".as_ref(),
        guest.as_os_str(),
    ]);

    assert_eq!(status, 2, "expected a load-time refusal:\nstdout:\n{stdout}\nstderr:\n{stderr}");
    assert!(
        stderr.contains("built for the `fiber` backend"),
        "the refusal does not name the guest's backend:\n{stderr}"
    );
    assert!(
        stderr.contains("this executor is the `continuation` backend"),
        "the refusal does not name the executor's backend:\n{stderr}"
    );
    assert!(stdout.is_empty(), "the guest produced output anyway:\n{stdout}");
}

// ---------------------------------------------------------------------------
// 4. A park nobody completes
// ---------------------------------------------------------------------------

#[test]
fn a_never_woken_park_is_refused_at_shutdown() {
    let guest = fiber_guest();
    // No `--post-completion`: the producer has nothing, so the executor must stop
    // and say why. `Command::output` waits for the process, so a hang would show up
    // as a test that never returns — which is the failure this test exists to
    // forbid, and it is the reason the producer answers `None` immediately instead
    // of waiting for a completion that is not coming.
    let (status, stdout, stderr) = run(&[
        "--executors".as_ref(),
        "1".as_ref(),
        guest.as_os_str(),
    ]);

    assert_ne!(status, 0, "a stranded run must not exit 0:\nstdout:\n{stdout}\nstderr:\n{stderr}");
    // The host's error path, and the strand named with its own vocabulary.
    assert!(
        stderr.contains("parked on class 4 key 7 and no completion arrived"),
        "the strand was not named:\n{stderr}"
    );
    assert!(
        stdout.contains("before=1"),
        "the guest never reached the park, so nothing was stranded:\n{stdout}"
    );
    assert!(
        !stdout.contains("value="),
        "the guest resumed without a completion:\n{stdout}"
    );
}

// ---------------------------------------------------------------------------
// 5. Two threads, two parked fibers
// ---------------------------------------------------------------------------

#[test]
fn two_parked_tasks_on_two_threads_both_complete() {
    // **Two threads, because one cannot.** wasmtime keeps its `CallThreadState` in
    // a thread-local LIFO, so a second fiber parked on one thread makes the first
    // one's resume trip an assertion inside the engine (DL24, measured). The
    // executor's model is one suspended fiber per OS thread, and this is the test
    // that holds it to that.
    //
    // Both threads park **before either is resumed** — a barrier, not a sleep — so
    // the run really is two simultaneously suspended fibers and not two sequential
    // ones.
    let bytes = std::fs::read(fiber_guest()).expect("the committed guest");
    assert_eq!(
        Backend::of(&bytes),
        Backend::Fiber,
        "the committed fixture is not a fiber build"
    );

    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut handles = Vec::new();
    for value in [500i32, 700i32] {
        let bytes = bytes.clone();
        let barrier = std::sync::Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || -> (Outcome, i32) {
            let mut config = wasmtime::Config::new();
            config.wasm_threads(true);
            config.shared_memory(true);
            // **No `wasm_stack_switching` here, and its absence is the claim.**
            // DL36 had to turn it on: a fiber artifact then still declared the
            // shell's continuation types and three tags, and wasmtime refuses to
            // *parse* those with the feature off (I85). DL37 removed them, so this
            // engine is the one a target without stack switching can build — which
            // is what makes this test say something about such a target at all.
            // If a future lowering move put a `(cont …)` back, this test would fail
            // to load the module rather than quietly asking for the feature.
            let engine = wasmtime::Engine::new(&config).expect("an engine");
            let module = wasmtime::Module::new(&engine, &bytes).expect("the module");
            let mut store = wasmtime::Store::new(&engine, ());
            let mut linker = wasmtime::Linker::new(&engine);

            // The three imports this guest uses. The **executor** below is the
            // tree's (`tension_core::fiber`); only the ABI registration is here,
            // because a test store has no audio, no res and no session.
            linker
                .func_wrap(
                    "scheduler",
                    "park",
                    move |_caller: wasmtime::Caller<'_, ()>, task_id: i64, class: i32, key: i32| {
                        // **The park import's contract**: record nothing here (the
                        // test has no ledger) and suspend. `suspend_current` answers
                        // `false` when no fiber is running, which in this store would
                        // be a harness bug rather than a guest event.
                        let parked = Park {
                            task: task_id as u64,
                            class: class as u32,
                            key: key as u32,
                        };
                        assert!(
                            fiber::suspend_current(parked),
                            "a park outside a fiber: the executor published no handle"
                        );
                    },
                )
                .expect("scheduler::park");
            linker
                .func_wrap(
                    "scheduler",
                    "completion",
                    |_caller: wasmtime::Caller<'_, ()>, _task_id: i64| -> i32 {
                        fiber::completion_value()
                    },
                )
                .expect("scheduler::completion");
            let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
            let log_for_print = std::sync::Arc::clone(&log);
            let memory = wasmtime::SharedMemory::new(&engine, wasmtime::MemoryType::shared(2, 256))
                .expect("a shared memory");
            let memory_for_print = memory.clone();
            linker
                .func_wrap(
                    "tension::io",
                    "print",
                    move |caller: wasmtime::Caller<'_, ()>, ptr: i32, len: i32| {
                        let cells = memory_for_print.data();
                        // SAFETY: the guest has just written this range and this
                        // store is single-threaded for the duration of the call.
                        let data = unsafe {
                            std::slice::from_raw_parts(cells.as_ptr() as *const u8, cells.len())
                        };
                        let start = ptr as usize;
                        let end = (start + len.max(0) as usize).min(data.len());
                        log_for_print
                            .lock()
                            .unwrap()
                            .extend_from_slice(&data[start..end]);
                    },
                )
                .expect("tension::io::print");
            linker
                .func_wrap("env", "abort", |_c: wasmtime::Caller<'_, ()>, _m: i32, _f: i32, _l: i32, _x: i32| {})
                .expect("env::abort");
            linker
                .func_wrap("env", "__executorCount", |_c: wasmtime::Caller<'_, ()>| -> i32 { 2 })
                .expect("env::__executorCount");
            linker
                .func_wrap("env", "__startThread", |_c: wasmtime::Caller<'_, ()>, _a: i32| -> i32 { -1 })
                .expect("env::__startThread");
            linker
                .define(&mut store, "env", "memory", memory)
                .expect("the shared memory");

            let instance = linker.instantiate(&mut store, &module).expect("the instance");
            // The two calls this guest needs before its entry — the same two
            // `thread_boot` makes, because they are what a shared build requires.
            let init = instance
                .get_typed_func::<i32, i32>(&mut store, "__threadInit")
                .expect("__threadInit");
            init.call(&mut store, 1024).expect("the control block");
            let base = instance
                .get_typed_func::<(), i32>(&mut store, "__mainArenaBase")
                .expect("__mainArenaBase")
                .call(&mut store, ())
                .expect("the base");
            let size = instance
                .get_typed_func::<(), i32>(&mut store, "__mainArenaSize")
                .expect("__mainArenaSize")
                .call(&mut store, ())
                .expect("the size");
            instance
                .get_typed_func::<(i32, i32), ()>(&mut store, "__arenaInit")
                .expect("__arenaInit")
                .call(&mut store, (base, size))
                .expect("the arena");

            let barrier_for_park = std::sync::Arc::clone(&barrier);
            let outcome = fiber::run(
                &mut store,
                instance,
                |store, instance| {
                    let start = instance.get_typed_func::<(), i32>(&mut *store, "__start")?;
                    Ok(start.call(store, ())?)
                },
                move |park| {
                    assert_eq!((park.class, park.key), (4, 7), "an unexpected park");
                    // **The rendezvous.** Both threads wait here, each with its fiber
                    // suspended, so neither can be holding the other's completion —
                    // this is two live parked tasks, not two sequential ones.
                    barrier_for_park.wait();
                    Some(value)
                },
            )
            .expect("the executor runs");

            let printed = String::from_utf8_lossy(&log.lock().unwrap()).to_string();
            (outcome, {
                // The guest's own last line, as a number, so the assertion is about
                // the value it read rather than about the string it printed.
                printed
                    .lines()
                    .rev()
                    .find_map(|line| line.strip_prefix("value="))
                    .and_then(|value| value.trim().parse::<i32>().ok())
                    .expect("the guest printed its value")
            })
        }));
    }

    let results: Vec<(Outcome, i32)> = handles
        .into_iter()
        .map(|handle| handle.join().expect("the thread finished"))
        .collect();

    for (outcome, value) in &results {
        assert!(
            matches!(outcome, Outcome::Done(_)),
            "a parked task did not complete: {outcome:?}"
        );
        assert_ne!(*value, 0, "a task resumed with 0 — the producer's word was lost");
    }
    let values: Vec<i32> = results.iter().map(|(_, value)| *value).collect();
    assert_eq!(
        values,
        vec![500, 700],
        "each task must read its own producer's value"
    );
}
