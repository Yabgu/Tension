//! The thread ABI's host half: `env.__executorCount` and `env.__startThread`.
//!
//! TensionScript's `docs/thread-abi.md` is the contract and
//! `tension-core/src/thread.rs` is this host's side of it. These four tests are
//! the observations that contract asks for, run against **real guests** — the
//! compiler's own `~lib/thread`, compiled by this repository's pinned compiler —
//! rather than against hand-written WAT. `src/thread.rs`'s unit test covers the
//! pool in isolation (a worker that writes one word); these cover the boot
//! sequence, the cross-store request, and the refusals.
//!
//! The programs live in `tests/programs/` as `.ts`, so the ABI they exercise
//! is visible and versioned. `scripts/build-test-programs.mjs` carries the flag
//! list, `--optimizeLevel 0` among them — a choice of build speed and artifact
//! size, not a workaround; pass `--optimize=<n>` to that script to build the
//! same programs at another level (see `tests/gallery_optimized.rs`).
//!
//! What each test reads:
//!
//! 1. **count** — `executors=3` for `--executors 2`, plus the carved block's own
//!    numbers, which is how the *boot order* becomes visible: a `__controlBase`
//!    of 0 would mean `__threadInit` never ran before `__start`.
//! 2. **spawn and join** — `answer=242`: the worker (id 1) doubled 21 and packed
//!    its own id into the reply, so one number proves both the crossing and the
//!    store it crossed from. `join=0` is `__threadJoin(1)`.
//! 3. **two workers, twelve tasks** — `valueSum=66` (0+…+11), `workerSum=30`
//!    (six tasks each to executors 1 and 2), `observed=12`: no value lost, none
//!    doubled, none misrouted.
//! 4. **the refusals** — `-1` for an id out of range at both ends, `0` for the
//!    first spawn of a valid id, `-2` for the second.
//!
//! Skip policy: `tests/support/programs.rs` (over `tests/support/ci.rs`). A
//! missing program is rebuilt rather than skipped; a failing build fails the
//! test, because the compiler is vendored and the pin is proven.

#[path = "support/programs.rs"]
mod support_programs;

use std::collections::BTreeMap;
use std::process::Command;

use support_programs::guest;

/// Run one guest and return its `key=value` lines.
///
/// The host logs to stderr, so the guest's own lines are all that is on stdout;
/// parsing them into a map keeps the assertions about *values*, not order —
/// which is what these tests are for. Ordering is `async_on_main.rs`'s job.
///
/// The thread programs are continuation modules (`--enable stack-switching` is
/// how the `$starts` table exists to serve requests), so on a target without
/// stack switching they are refused by the host. The refusal is asserted here
/// (exit non-zero, stderr naming the feature) and the caller gets `None`, with
/// the reason printed.
fn run(name: &str, workers: usize) -> Option<BTreeMap<String, String>> {
    let guest = guest(name);
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--executors")
        .arg(workers.to_string())
        .arg(&guest)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);

    if tension_core::async_backend::current().supports_continuations() {
        assert!(
            output.status.success(),
            "{} failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
            guest.display(),
            output.status.code(),
            stderr.lines().rev().take(8).collect::<Vec<_>>().join("\n")
        );

        let mut values = BTreeMap::new();
        for line in stdout.lines() {
            let line = line.trim();
            if let Some((key, value)) = line.split_once('=') {
                values.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
        return Some(values);
    }

    assert!(
        !output.status.success(),
        "{name} must be refused on a target without stack switching, but it exited 0\n\
         stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(
        stderr.contains("stack switching") || stderr.contains("continuation"),
        "the refusal for {name} must name the feature, got:\n{stderr}"
    );
    eprintln!(
        "{name}: stack switching is unavailable on {} — the host refused the guest \
         by name (expected), and the thread ABI assertions are skipped",
        std::env::consts::OS,
    );
    None
}

fn want<'a>(values: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    values
        .get(key)
        .unwrap_or_else(|| panic!("no `{key}=` line; transcript: {values:?}"))
        .as_str()
}

#[test]
fn one_executor_count_plus_the_pool() {
    let Some(values) = run("count", 2) else {
        return;
    };

    // `--executors 2` is two workers; main is always there.
    assert_eq!(want(&values, "executors"), "3");

    // The boot order, as the guest sees it: the host carved the control block
    // before `__start` ran. A module that reached its entry with no carve would
    // report `0` here and find nothing from `__heap_base`.
    assert_eq!(want(&values, "controlBase"), "carved");
    assert_eq!(want(&values, "executorTotal"), "3");
    // The host's capacity (`thread_boot`'s `CAPACITY`), read back from the guest.
    assert_eq!(want(&values, "ringCapacity"), "1024");
    assert!(
        want(&values, "controlStride").parse::<i32>().unwrap_or(0) > 0,
        "the record stride is published: {values:?}"
    );
}

#[test]
fn a_worker_runs_on_its_own_store_and_joins() {
    let Some(values) = run("spawn-join", 2) else {
        return;
    };

    // The `$starts` indices came from `TaskBase.entry` — a module fact, which is
    // why a store other than the one that made the task can resolve them.
    assert!(
        want(&values, "workIndex").parse::<i32>().unwrap_or(-1) >= 0,
        "the work body has a spawn entry: {values:?}"
    );
    assert!(
        want(&values, "deliverIndex").parse::<i32>().unwrap_or(-1) >= 0,
        "the reply body has a spawn entry: {values:?}"
    );

    assert_eq!(want(&values, "spawn"), "0", "the host accepted the spawn");
    // 21 doubled in a store whose id is 1, packed as (1 + 1) * 100 + 42.
    assert_eq!(want(&values, "answer"), "242");
    // The request's origin word, as main served it: the worker's id.
    assert_eq!(want(&values, "replyOrigin"), "1");
    assert_eq!(want(&values, "join"), "0", "__threadJoin saw the exit");
}

#[test]
fn two_workers_observe_every_value_exactly_once() {
    let Some(values) = run("two-workers", 2) else {
        return;
    };

    assert_eq!(want(&values, "spawn1"), "0");
    assert_eq!(want(&values, "spawn2"), "0");

    // Twelve tasks, values 0..11: a lost reply shortens the count, a doubled one
    // lengthens it, and either moves the sum.
    assert_eq!(want(&values, "observed"), "12");
    assert_eq!(want(&values, "valueSum"), "66");
    // Executor 1 served the six even values and executor 2 the six odd ones, and
    // the reply packs `self + 1` — so 6*2 + 6*3.
    assert_eq!(want(&values, "workerSum"), "30");

    assert_eq!(want(&values, "join1"), "0");
    assert_eq!(want(&values, "join2"), "0");
}

#[test]
fn the_contracts_refusals_are_values() {
    let Some(values) = run("spawn-refusals", 2) else {
        return;
    };

    // Ids are `1..executorTotal`; main is 0 and is never a spawn target.
    assert_eq!(want(&values, "spawnMain"), "-1", "main cannot be spawned");
    assert_eq!(
        want(&values, "spawnPastEnd"),
        "-1",
        "the count is 3, so 3 is past the end"
    );
    assert_eq!(want(&values, "spawnFirst"), "0");
    assert_eq!(
        want(&values, "spawnAgain"),
        "-2",
        "a live id is refused, not started twice"
    );
    assert_eq!(want(&values, "join"), "0");
}

// ---------------------------------------------------------------------------
// DL21: the wake path, guarded.
// ---------------------------------------------------------------------------

/// One run of the wake guest, with the whole output kept.
///
/// `run` above parses `key=value` lines and asserts nothing else; this test needs
/// the **log** (the sticky buffer's line, the park's claim, the refusal's words)
/// and the exit code, so it takes the raw streams. It also cannot reuse `run`'s
/// skip branch: that one skips every thread guest on a target without stack
/// switching, and this guest is built **without** stack switching on purpose —
/// the Promise shell is what resumes it. Skipping it there would make the guard
/// skip on exactly the engine it was written for.
struct Run {
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_with(extra: &[&str]) -> Run {
    let guest = support_programs::guest_thread_fixture("wake-on-worker");
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--executors")
        .arg("2")
        .args(extra)
        .arg(&guest)
        // The park seam and the sticky claim log at Debug; the buffered line, the
        // served count and the refusal log at Info. Debug is what makes the
        // *ordering* below observable instead of just the outcome.
        .env("TENSION_LOG_LEVEL", "debug")
        .output()
        .expect("the interpreter runs");
    Run {
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}

/// Where `needle` sits in `haystack`, panicking with the whole text when absent.
fn at(haystack: &str, needle: &str) -> usize {
    haystack.find(needle).unwrap_or_else(|| {
        panic!("expected `{needle}` in the log; the log was:\n{haystack}")
    })
}

/// **The guard for the round's most important behaviour**: a task parked on a
/// worker is resumed by a completion that was posted *before* it parked.
///
/// # What makes this a test and not a demonstration
///
/// Four things are asserted, and none of them is the exit code on its own — DL20B
/// shipped a run that exited **0** with a task stranded, so an exit-code-only
/// guard would have passed through its own worst bug:
///
/// 1. the completion was **buffered before there was a park** (`no park yet:
///    sticky`) and the park then **claimed** it (`had already arrived`), asserted
///    in that order in the log;
/// 2. both `AFTER` lines are printed, so the continuation ran, in the worker;
/// 3. `main: wakes served=1` and exit **0**;
/// 4. no refusal and no `detached` anywhere — the two ways a "successful" run can
///    still be wrong.
///
/// # The negative control, in the same test
///
/// The second half runs the **same guest without `--post-completion`** and asserts
/// the opposite: the `AFTER` lines are absent and the run exits non-zero with a
/// refusal naming the executor. Without it, part 1 would prove only that a program
/// can print two lines, and a wake path that resumed *everything* unconditionally
/// would pass this file. The pair is one test so that neither half can be dropped
/// without the other going red.
#[test]
fn a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake() {
    // -- the proof ---------------------------------------------------------
    let resumed = run_with(&["--post-completion", "4,7"]);

    let buffered = at(&resumed.stderr, "buffered (no park yet: sticky)");
    let claimed = at(&resumed.stderr, "claimed a completion that had already arrived");
    assert!(
        buffered < claimed,
        "the completion must be buffered *before* the park claims it — that is the \
         sticky half, and the order in the log is the only evidence of it:\n{}",
        resumed.stderr
    );

    for line in [
        "inner: AFTER the await, value=0",
        "worker: AFTER the await, value=0",
    ] {
        assert!(
            resumed.stdout.contains(line),
            "`{line}` is missing — the continuation did not run:\nstdout: {}\nstderr: {}",
            resumed.stdout,
            resumed.stderr
        );
    }

    assert!(
        resumed.stdout.contains("main: wakes served=1"),
        "the host must report exactly one served wake, got:\n{}",
        resumed.stdout
    );
    assert!(
        resumed.stdout.contains("main: join=0"),
        "the worker did not join cleanly:\n{}",
        resumed.stdout
    );
    assert_eq!(
        resumed.status,
        Some(0),
        "a resumed task must leave nothing stranded:\nstdout: {}\nstderr: {}",
        resumed.stdout,
        resumed.stderr
    );

    assert!(
        !resumed.stderr.contains("Error:")
            && !resumed.stderr.contains("never resumed"),
        "the strand refusal fired on a run that resumed its task:\n{}",
        resumed.stderr
    );
    // `join_finished` detaches after a grace period with a warning. A session
    // pool that stops and joins in order must never reach it (DL20B's B7).
    assert!(
        !resumed.stderr.contains("detached"),
        "a healthy session run must not detach a worker:\n{}",
        resumed.stderr
    );

    // -- the negative control ----------------------------------------------
    let stranded = run_with(&[]);

    for line in ["inner: AFTER the await", "worker: AFTER the await"] {
        assert!(
            !stranded.stdout.contains(line),
            "without `--post-completion` nothing completes the pair, so `{line}` \
             must not be printed:\nstdout: {}",
            stranded.stdout
        );
    }
    assert!(
        stranded.status.is_some_and(|code| code != 0),
        "a run with a stranded task must fail, not exit 0:\nstdout: {}\nstderr: {}",
        stranded.stdout,
        stranded.stderr
    );
    assert!(
        stranded.stderr.contains("never resumed"),
        "the refusal must name what happened:\n{}",
        stranded.stderr
    );
    assert!(
        stranded.stderr.contains("executor 1"),
        "the refusal must name the executor it happened on:\n{}",
        stranded.stderr
    );
}

/// A guest that imports a **shared** memory and prints: the case that found
/// `Extern::into_memory()` answering `None` for a `SharedMemory`.
///
/// It is not a thread test as such, it is the *transport* under three of them —
/// every test above prints from a shared-memory guest — but it is cheap and it
/// names the failure directly: without `tension_core::thread::GuestMemory`, this
/// guest panics the host in `tension::io print` with "game must export a memory
/// named 'memory'" while the export is right there.
#[test]
fn a_shared_memory_guest_can_print() {
    let Some(values) = run("count", 0) else {
        return;
    };
    // With no workers configured, main is the whole pool.
    assert_eq!(want(&values, "executors"), "1");
}
