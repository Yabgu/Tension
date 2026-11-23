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
use std::process::{Command, Stdio};

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
    run_guest("wake-on-worker", extra)
}

/// The same, for any thread fixture by name — DL22 runs one guest twice.
fn run_guest(name: &str, extra: &[&str]) -> Run {
    let guest = support_programs::guest_thread_fixture(name);
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

// ---------------------------------------------------------------------------
// DL22: the owner's own park record is the truth (I53).
// ---------------------------------------------------------------------------

/// **A second waiter on one key is refused, not silently abandoned**, when the
/// completion arrives *after* both have parked — the ordering a real producer
/// creates, and the one DL21 could not reach.
///
/// # The defect this guards
///
/// Before DL22 the strand count came from the shared ledger, which holds **one**
/// entry per key: the second park overwrites the first, so the first waiter is
/// absent from the ledger whether or not it was ever resumed. With a late post the
/// ledger's holder was woken, the displaced waiter was filtered out of the
/// predicate, `unresolved` came out **0**, and the run **exited 0 with a task
/// abandoned** — measured, `waiter 1` printing `BEFORE` and nothing else. The count
/// now comes from the owning store's own per-park record, so it is 1.
///
/// # What is asserted
///
/// - exit **1**, and the refusal names `executor 1` with a count of exactly **1** —
///   not 0 (the defect: nothing was resumed and nothing was reported) and not 2
///   (the wake did not mark resolution, i.e. Part 2 is not finished);
/// - the seam recorded **2** parks, so the 1 is a per-*park* number and not a
///   per-key one;
/// - `waiter 2` printed its `AFTER` line and `waiter 1` did not — the test pins
///   *which* ordering happened, because the ledger's slot holds the later park;
/// - no `detached`.
///
/// # The compulsory mirror
///
/// The second half runs the **same guest** with the completion posted *before* the
/// parks (`--post-completion`, DL21's shape). It must still exit 1 with a refusal,
/// and it must still resume the *other* waiter — `waiter 1`, the one the first park
/// claimed from the sticky buffer. If that half changed, this round moved wake
/// semantics under cover of fixing a count, and the round is wrong.
#[test]
fn a_second_waiter_is_refused_when_the_completion_arrives_after_both_parks() {
    // -- the fix: posted after both parks -----------------------------------
    let late = run_guest(
        "two-waiters-late",
        &["--post-completion-after-parks", "4,7,2"],
    );

    // Two parks at the seam, one resumed, one abandoned: the truthful count is 1.
    assert!(
        late.stderr.contains("recorded 2 park(s)"),
        "both waiters must have parked for this test to be about two waiters:\n{}",
        late.stderr
    );
    assert_eq!(
        late.status,
        Some(1),
        "an abandoned task must fail the run, not exit 0:\nstdout: {}\nstderr: {}",
        late.stdout,
        late.stderr
    );
    assert!(
        late.stderr.contains("left 1 task(s) parked and never resumed"),
        "the count must be exactly 1 — 0 is DL22's defect, 2 means the wake did not \
         mark resolution:\n{}",
        late.stderr
    );
    assert!(
        late.stderr.contains("executor 1"),
        "the refusal must name the executor:\n{}",
        late.stderr
    );
    assert!(
        late.stderr.contains("first: task 0 on class 4 key 7"),
        "the abandoned task is the earlier park, which the ledger displaced:\n{}",
        late.stderr
    );

    assert!(
        late.stdout.contains("waiter 2: AFTER the await"),
        "the ledger's holder is resumed and must print:\n{}",
        late.stdout
    );
    assert!(
        !late.stdout.contains("waiter 1: AFTER the await"),
        "the displaced waiter was not resumed, so it must not print an AFTER line:\n{}",
        late.stdout
    );
    assert!(
        !late.stderr.contains("detached"),
        "a healthy session run must not detach a worker:\n{}",
        late.stderr
    );

    // -- the mirror: posted before both parks (DL21's shape, unchanged) -----
    let sticky = run_guest("two-waiters-late", &["--post-completion", "4,7"]);

    assert_eq!(
        sticky.status,
        Some(1),
        "the sticky ordering must still refuse:\nstdout: {}\nstderr: {}",
        sticky.stdout,
        sticky.stderr
    );
    assert!(
        sticky.stderr.contains("left 1 task(s) parked and never resumed"),
        "the sticky count must stay 1:\n{}",
        sticky.stderr
    );
    // The mirror's *other* waiter resumes: the first park claims the buffered
    // completion, so the later park is the one left over.
    assert!(
        sticky.stdout.contains("waiter 1: AFTER the await"),
        "the first park claims the sticky completion and must print:\n{}",
        sticky.stdout
    );
    assert!(
        !sticky.stdout.contains("waiter 2: AFTER the await"),
        "the later park is the one left in the ledger, so it must not print:\n{}",
        sticky.stdout
    );
    assert!(
        !sticky.stderr.contains("detached"),
        "a healthy session run must not detach a worker:\n{}",
        sticky.stderr
    );
}

// ---------------------------------------------------------------------------
// DL28 — the refusal end to end (I55's last unmeasured piece).
// ---------------------------------------------------------------------------

/// **A delivery the ledger never matched must fail the run and name itself.**
///
/// DL26 tested `delivery_target` as a decision, the refusal's message, and the pool's
/// bookkeeping. What none of that measured is the wire between them: that
/// `service_wakes` actually refuses, that `note_refused_delivery` reaches main, and that
/// main **exits 1 with its own sentence** rather than the strand sentence or silence.
///
/// The delivery is produced by `--deliver-foreign`, which enqueues straight onto
/// executor 1's queue once a park on the pair is recorded — bypassing `Pool::deliver` and
/// therefore the ledger. That bypass is what makes it foreign: nothing has agreed that
/// task 9999 is a task this store ever parked.
///
/// **The ordering is load-bearing and is asserted, not assumed.** The legitimate
/// `--post-completion 4,7` is claimed at the same seam (by `claim_early`, which runs
/// before the injection), so it is enqueued first and the guest resumes before the loop
/// reaches the foreign delivery. That is what makes assertion 4 possible: the task
/// resolved, so the strand sentence must be **absent** and only the refusal's sentence
/// may appear.
///
/// The run, verbatim, is quoted in `DL28-REPORT.md` §B.
#[test]
fn a_foreign_delivery_fails_the_run_by_name() {
    let run = run_with(&[
        "--post-completion",
        "4,7",
        "--deliver-foreign",
        "4,7,9999",
    ]);
    let all = format!("{}\n{}", run.stdout, run.stderr);

    // 2. **exit 1** — a foreign delivery is a failure, not a warning.
    assert_eq!(
        run.status,
        Some(1),
        "a foreign delivery must fail the run:\nstdout: {}\nstderr: {}",
        run.stdout,
        run.stderr
    );

    // 3. It names the task **and** the pair, so the producer can be found.
    assert!(
        run.stderr.contains("refused to wake task 9999"),
        "the refusal must name the foreign task:\n{}",
        run.stderr
    );
    assert!(
        run.stderr.contains("class 4 key 7"),
        "the refusal must name the pair the delivery was for:\n{}",
        run.stderr
    );
    assert!(
        run.stderr.contains("executor 1"),
        "the refusal must name the executor that refused it:\n{}",
        run.stderr
    );

    // 4a. main's own sentence for this failure.
    assert!(
        run.stderr
            .contains("a completion was delivered to a task its store never parked"),
        "the run's error must carry the delivery sentence:\n{}",
        run.stderr
    );
    // 4b. **and not the strand sentence** — the task itself resumed, so claiming it was
    // left parked would be telling the reader the wrong reason.
    assert!(
        !all.contains("a task was left parked when the session stopped"),
        "this run resumed its task, so the strand sentence must be absent:\n{all}"
    );

    // 5. The legitimate wake still did its job: the guest printed both AFTER lines.
    assert!(
        run.stdout.contains("inner: AFTER the await, value=0"),
        "the legitimate wake must still resume the inner task:\n{}",
        run.stdout
    );
    assert!(
        run.stdout.contains("worker: AFTER the await, value=0"),
        "and the worker's own continuation:\n{}",
        run.stdout
    );

    // 6. A healthy session teardown, not a detach.
    assert!(
        !all.contains("detached"),
        "the session must stop and join in order:\n{all}"
    );

    // The instrument's own evidence that it fired where it said it did.
    assert!(
        run.stderr
            .contains("injected class 4 key 7 for task 9999"),
        "the flag must report its injection:\n{}",
        run.stderr
    );

    // -- the control: the same guest and the same legitimate wake, no instrument ----
    //
    // Without this, the run above proves only that the fixture can fail. It is the
    // second half of one test rather than a test of its own so the pair cannot be
    // separated: drop one and the other's meaning changes. It is also the gate's
    // "with the flag absent the binary behaves as at 96a30ac" check, kept as an
    // assertion rather than a one-off pasted log.
    let control = run_with(&["--post-completion", "4,7"]);
    assert_eq!(
        control.status,
        Some(0),
        "the control run must succeed:\nstdout: {}\nstderr: {}",
        control.stdout,
        control.stderr
    );
    assert!(
        !control.stderr.contains("refused to wake"),
        "nothing may be refused without the instrument:\n{}",
        control.stderr
    );
    assert!(
        !control.stderr.contains("a completion was delivered to a task"),
        "and no delivery sentence either:\n{}",
        control.stderr
    );
}

/// A guest that imports a **shared** memory and prints: the case that found/// `Extern::into_memory()` answering `None` for a `SharedMemory`.
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

// ---------------------------------------------------------------------------
// DL31: the spawn entry is the one the lowering created.
// ---------------------------------------------------------------------------

/// `__spawnIndexOf(anAsyncFunction)` must answer the **spawn entry**'s index, and a
/// worker spawned at that answer must run the body it names.
///
/// The defect this guards, measured end to end at DL30: the API answered the
/// **factory** `f` — the function a user writes — so `__serveOne` resumed `f`.
/// A factory creates a task, binds it, and returns it, which is *normal
/// completion*: `__resumeTask` answers `-1`, the `if (awaited >= 0)` guard never
/// fires, nothing is queued, and the task is left unsettled with nothing to drive
/// it. The run exited **0** with no sentence — the failure mode this arc exists to
/// remove, and the reason the assertions below are about a *line appearing* rather
/// than about an exit code.
///
/// Three things are asserted, and they are separable:
///
/// 1. the number — `spawnIndexOf=3`, the `$spawnStart` entry. Not `4`, the factory;
///    not `0`, the body continuation;
/// 2. the body ran *through* its suspension — both worker lines, in order;
/// 3. the run is clean — exit 0, joined, no strand, no refusal.
///
/// Mutation-checked: falling back to `target.internalName` in
/// `builtin_async_spawnIndexOf` makes the answer `4`, the worker prints nothing,
/// and this test fails on assertion 1 (see `DL31-REPORT.md`).
#[test]
fn an_async_worker_entry_is_served_as_its_spawn_entry() {
    // The guest is a continuation module, so a target without stack switching
    // cannot serve it at all. Same policy as `run`: say so, and assert the host
    // refuses it by name rather than silently passing.
    let guest = support_programs::guest_thread_fixture_as_committed("spawn-entry-async");
    let mut child = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--executors")
        .arg("2")
        .arg(&guest)
        .env("TENSION_LOG_LEVEL", "debug")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the interpreter runs");

    // **Bounded, because the defect's signature is a hang, not an exit code.**
    // Measured at DL31: the guest built by the pre-fix compiler prints
    // `spawnIndexOf=4`, spawns, and then joins a worker that never exits — the
    // process sits there until killed. An unbounded `wait` turns that regression
    // into a hung CI job with no message, which is the silence this arc exists to
    // remove; a deadline turns it into a failing assertion that names the cause.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut timed_out = false;
    loop {
        match child.try_wait().expect("the interpreter is waitable") {
            Some(_) => break,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                timed_out = true;
                break;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }

    // `wait_with_output` after a kill still returns what was written, so the
    // assertions below can quote the guest's own lines in the failure message.
    let output = child.wait_with_output().expect("the output is collectable");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    assert!(
        !timed_out,
        "the run did not finish in 30 s — the worker was never served and `__threadJoin` \
         is waiting on it. That is how the pre-fix `__spawnIndexOf` fails (it answers the \
         factory's index, so `__serveOne` queues nothing and the created task is never \
         driven); stdout:\n{stdout}\nstderr:\n{stderr}"
    );

    if !tension_core::async_backend::current().supports_continuations() {
        assert!(
            !output.status.success(),
            "the guest must be refused on a target without stack switching, but it exited 0\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stderr.contains("stack switching") || stderr.contains("continuation"),
            "the refusal must name the feature, got:\n{stderr}"
        );
        return;
    }

    assert_eq!(
        output.status.code(),
        Some(0),
        "the run must succeed\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    // 1. The number under test. 3 is `$spawnStart` in this program's table:
    //    `[0] $start · [1] ~asyncMainStart · [2] coreloop · [3] $spawnStart`.
    assert!(
        stdout.contains("main: spawnIndexOf=3"),
        "`__spawnIndexOf` must answer the spawn entry's index (3), not the factory's \
         (4) and not the body's (0); stdout was:\n{stdout}"
    );

    // 2. The body ran, and ran past its suspension. Order is asserted, not just
    //    presence: a line printed after the `await` is the only thing that
    //    distinguishes "served and finished" from "started".
    let entered = at(&stdout, "worker: entered (async entry)");
    let resumed = at(&stdout, "worker: AFTER the await, value=0");
    assert!(
        entered < resumed,
        "the worker's AFTER line must follow its entry line; stdout was:\n{stdout}"
    );

    // 3. Clean: spawned, joined, and nothing stranded or refused.
    assert!(
        stdout.contains("main: spawn=0"),
        "the spawn record must be accepted; stdout was:\n{stdout}"
    );
    assert!(
        stdout.contains("main: join=0"),
        "the worker must be joined; stdout was:\n{stdout}"
    );
    assert!(
        !stderr.contains("STRANDED") && !stderr.contains("left 1 task"),
        "nothing may be stranded — the served task is the one that ran:\n{stderr}"
    );
    assert!(
        !stderr.contains("refused"),
        "no wake or delivery may be refused in a healthy run:\n{stderr}"
    );
    assert!(
        !stdout.contains("detached") && !stderr.contains("detached"),
        "`detached` must not appear in a healthy run"
    );
}
