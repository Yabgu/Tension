//! A1's end-to-end smoke test: the real interpreter, the real adapter library,
//! and hand-written guests.
//!
//! Every other A1 test drives a module inside the test process. These drive the
//! *binary* — `cargo` builds `tension-core` for this test and hands its path
//! over in `CARGO_BIN_EXE_tension-core` — so what is exercised is the whole run
//! path in `main`: the load-time checks on the guest, the session's memory
//! lifecycle, the adapter loader, the arena the guest opens, and the imports a
//! capability registers.
//!
//! The adapter libraries come from `build.rs` (`cargo:rustc-env`): the reference
//! adapter and its bad-ABI twin. Nothing here is AssemblyScript — the guests are
//! WAT files under `tests/fixtures/`, readable in one screen each.
//!
//! **`--session-open` is A1's convenience, not the design.** A1 has no guest SDK,
//! so the smoke fixture cannot send the config TLV a real guest sends; the run is
//! started with the host performing the open instead. That path is a flag, so a
//! guest that opens its own session (the design's contract; covered by
//! `test_verb_path_through_a_guest` in `src/session/mod.rs`) is unaffected. One
//! test below pins the difference: the same fixture without the flag traps,
//! because the arena never reaches READY.
//!
//! What these tests assert is the *observable* contract: exit status, stdout, and
//! the diagnostic on stderr. A refusal is only a refusal if it says what is
//! wrong, so the tests check the words as well as the code.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The interpreter under test.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");
/// The reference adapter, and the same source built with an ABI of 2.
const ECHO: &str = env!("TENSION_ECHO_ADAPTER");
const ECHO_BAD_ABI: &str = env!("TENSION_ECHO_BADABI_ADAPTER");

fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
        .to_str()
        .expect("the fixture path is UTF-8")
        .to_string()
}

fn run(args: &[&str]) -> Output {
    Command::new(BINARY)
        .args(args)
        .output()
        .expect("the interpreter starts")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The happy path, and the only test that proves the pieces fit together: the
/// host opens the session, the guest reads the arena it prepared — the control
/// block's magic and READY state, `SessionInfo.maxArenaSize` — calls both
/// imports the echo adapter registered (including one that round-trips bytes
/// through the host's `guest_read`/`guest_write`), prints `OK`, and returns.
///
/// The guest traps on any mismatch, so `OK` on stdout is the guest's own
/// assertion that every one of those steps returned what the design says.
#[test]
fn test_happy_path() {
    let guest = fixture("session_guest.wat");
    let output = run(&["--session-open", "--capability", ECHO, &guest]);

    assert!(
        output.status.success(),
        "the run failed (exit {:?})\nstdout: {}\nstderr: {}",
        output.status.code(),
        stdout(&output),
        stderr(&output)
    );
    assert!(
        stdout(&output).contains("OK"),
        "the guest's assertion output is missing\nstdout: {}\nstderr: {}",
        stdout(&output),
        stderr(&output)
    );
    let err = stderr(&output);
    assert!(
        err.contains("host open: arena 6250528, ceiling 8388608"),
        "the host's open must say so\nstderr: {err}"
    );
    assert!(
        err.contains("echo: two imports registered"),
        "the adapter's own log lines are missing\nstderr: {err}"
    );
}

/// The host's open is a *flag*, and this is what it buys: without it the arena
/// never reaches READY, so the fixture's first assertion traps and the run
/// fails. A guest that opened its own session — the design's contract — would
/// not need the flag, and this test is the tripwire for the day the convenience
/// quietly became the rule.
#[test]
fn test_host_open_is_a_flag_and_not_the_rule() {
    let guest = fixture("session_guest.wat");
    let output = run(&["--capability", ECHO, &guest]);

    assert!(
        !output.status.success(),
        "without `--session-open` the fixture's READY assertion must trap\nstdout: {}",
        stdout(&output)
    );
    assert!(
        !stdout(&output).contains("OK"),
        "nothing may be printed past a trap\nstdout: {}",
        stdout(&output)
    );
}

/// A guest whose declared memory cannot hold the arena its ceiling implies.
/// The session refuses the whole run before instantiation, naming the
/// disagreement: this is the check that catches a build whose `--memoryBase`
/// does not describe the module it was applied to.
#[test]
fn test_bad_memory_import_refused() {
    let guest = fixture("bad_memory_guest.wat");
    let output = run(&[&guest]);

    assert!(!output.status.success(), "the run must fail");
    let err = stderr(&output);
    assert!(
        err.contains("--memoryBase") && err.contains("declared memory size disagree"),
        "the diagnostic must name the disagreement\nstderr: {err}"
    );
    assert!(
        !stdout(&output).contains("OK"),
        "a refused guest must not have run"
    );
}

/// F2 check 1: a guest that imports `session::*` but declares no memory. The
/// session owns the arena, so every session guest must import it, and the
/// diagnostic names both spellings it may use.
#[test]
fn test_missing_memory_import_refused() {
    let guest = fixture("no_memory_import_guest.wat");
    let output = run(&[&guest]);

    assert!(!output.status.success(), "the run must fail");
    let err = stderr(&output);
    assert!(
        err.contains("imports `session::*` but declares no memory import")
            && err.contains("env::memory or session::memory"),
        "the diagnostic must name the missing import and both spellings\nstderr: {err}"
    );
}

/// F2 check 2: a guest that imports a memory but does not re-export it as
/// `memory`. Without this check the first host call would panic on an `expect`;
/// the check bails with the line the module has to add.
#[test]
fn test_missing_memory_export_refused() {
    let guest = fixture("no_export_memory_guest.wat");
    let output = run(&[&guest]);

    assert!(!output.status.success(), "the run must fail");
    let err = stderr(&output);
    assert!(
        err.contains("does not re-export it as `memory`")
            && err.contains("(export \"memory\" (memory 0))"),
        "the diagnostic must name the fix\nstderr: {err}"
    );
    assert!(
        !stdout(&output).contains("OK"),
        "nothing was instantiated, so nothing ran"
    );
}

/// The bad-ABI twin of the reference adapter: same source, `abi_version = 2`.
/// The loader refuses it at load — before `init`, before `link`, before any
/// function pointer from its vtable is called — and the diagnostic names the
/// file and both versions.
#[test]
fn test_bad_abi_adapter_refused() {
    let guest = fixture("session_guest.wat");
    let output = run(&["--session-open", "--capability", ECHO_BAD_ABI, &guest]);

    assert!(!output.status.success(), "the run must fail");
    let err = stderr(&output);
    assert!(
        err.contains("was built against adapter ABI 2") && err.contains("this build is 1"),
        "the diagnostic must name both versions\nstderr: {err}"
    );
    assert!(
        err.contains(ECHO_BAD_ABI),
        "the diagnostic must name the file it refused\nstderr: {err}"
    );
}

/// Two adapters claiming the same `(module, name)` pair. The registry refuses
/// the second rather than letting load order decide an ABI — and with the same
/// library twice it refuses even a byte-identical copy, which is the strongest
/// form of the check and needs no second C fixture.
#[test]
fn test_duplicate_import_refused() {
    let guest = fixture("session_guest.wat");
    let output = run(&["--capability", ECHO, "--capability", ECHO, &guest]);

    assert!(!output.status.success(), "the run must fail");
    let err = stderr(&output);
    assert!(
        err.contains("`echo`::`add`") && err.contains("already claimed"),
        "the diagnostic must name the duplicate\nstderr: {err}"
    );
}

/// The reference adapter's own audit line: `region_lookup` answered for JOB at
/// link time, i.e. before the arena exists. If a library were built without the
/// frozen layout reaching that call, the echo adapter would log the other line
/// and the required-region check would never fire.
#[test]
fn test_region_lookup_answered_before_the_arena_existed() {
    let guest = fixture("session_guest.wat");
    let output = run(&["--session-open", "--capability", ECHO, &guest]);
    let err = stderr(&output);
    assert!(
        err.contains("echo: the JOB region answered at link time"),
        "the link-time query must be answered from the frozen layout\nstderr: {err}"
    );
}


/// A2's epoch, end to end: the host opens the session and registers the guest's
/// `onBatch` (`--session-callbacks 1`), posts three JOB_DONE events
/// (`--post-test-events`), and the guest subscribes, waits, and prints what its
/// callback was handed.
///
/// The line the guest prints is `OK <count> <class> <a> <b>` — so it is the
/// guest's own assertion that the batch held three records, that they were
/// JOB_DONE's, and that the first one carried the payload the host posted.
#[test]
fn test_epoch_fixture_delivers_the_batch() {
    let guest = fixture("session_guest_epoch.wat");
    let output = run(&[
        "--session-callbacks",
        "1",
        "--post-test-events",
        "--capability",
        ECHO,
        &guest,
    ]);

    assert!(
        output.status.success(),
        "the run failed (exit {:?})\nstdout: {}\nstderr: {}",
        output.status.code(),
        stdout(&output),
        stderr(&output)
    );
    assert!(
        stdout(&output).contains("OK 3 4 1 2"),
        "the guest's batch assertion output is missing\nstdout: {}\nstderr: {}",
        stdout(&output),
        stderr(&output)
    );
    let err = stderr(&output);
    assert!(
        err.contains("session_subscribe(class=4, mode=2)"),
        "the guest's subscribe must succeed\nstderr: {err}"
    );
    assert!(
        err.contains("epoch delivered 3 record(s)"),
        "the epoch must report three deliveries\nstderr: {err}"
    );
    assert!(
        err.contains("echo: publish wrote its sentinel"),
        "the adapter's publish hook must have run before the delivery\nstderr: {err}"
    );
}

/// A2's fault path, end to end: the guest's `onBatch` traps, so `session_wait`
/// returns `-EIO`, the session moves to FAULTED, the slot is disabled, and the
/// guest — which traps when the verb's return value is not the documented one —
/// makes the run fail.
#[test]
fn test_epoch_fixture_reports_a_trapping_callback() {
    let guest = fixture("session_guest_trap.wat");
    let output = run(&[
        "--session-callbacks",
        "1",
        "--post-test-events",
        "--capability",
        ECHO,
        &guest,
    ]);

    assert!(
        !output.status.success(),
        "a trapping callback must fail the run\nstdout: {}",
        stdout(&output)
    );
    let err = stderr(&output);
    assert!(
        err.contains("callback `onBatch` trapped"),
        "the diagnostic must name the slot that trapped\nstderr: {err}"
    );
    assert!(
        err.contains("the slot is disabled for this session and the session is FAULTED"),
        "the diagnostic must report the fault\nstderr: {err}"
    );
    // Both refusals the fixture asserts: -EIO from the trapping wait, and
    // -EBADF from the next one (§6.3's blanket rule for a non-READY session).
    assert!(
        err.contains("epoch -> -5"),
        "the trapping epoch returns -EIO\nstderr: {err}"
    );
    assert!(
        err.contains("epoch -> -9"),
        "a FAULTED session refuses the next verb with -EBADF\nstderr: {err}"
    );
}


/// A2c's deferred path, end to end: the guest's `onBatch` calls a DEFERRABLE
/// verb three times, the session copies the arguments instead of calling the
/// adapter, and the apply phase runs them after the batch — which is what the
/// guest's second wait triggers and what it reads back as the sum of three
/// applied bytes.
#[test]
fn test_deferred_submissions_apply_after_the_batch() {
    let guest = fixture("session_guest_defer.wat");
    let output = run(&[
        "--session-callbacks",
        "1",
        "--post-test-events",
        "--capability",
        ECHO,
        &guest,
    ]);

    assert!(
        output.status.success(),
        "the run failed (exit {:?})\nstdout: {}\nstderr: {}",
        output.status.code(),
        stdout(&output),
        stderr(&output)
    );
    assert!(
        stdout(&output).contains("OK 3"),
        "the guest's applied-sum assertion is missing\nstdout: {}\nstderr: {}",
        stdout(&output),
        stderr(&output)
    );
    let err = stderr(&output);
    assert!(
        err.contains("deferred from a callback"),
        "the deferrable call must be copied, not run\nstderr: {err}"
    );
    assert!(
        err.contains("apply: 3 applied, 0 rejected, 0 dropped"),
        "the apply phase must run all three\nstderr: {err}"
    );
}

/// A2c's R7, end to end: a callback queues two submissions and then traps. The
/// queue belongs to the session, so the work survives the fault — and the host
/// reports how much of it is still waiting after the guest returns.
///
/// The process still exits 0: a callback trap is a *session* fault, reported to
/// the guest as `-EIO` from the wait that hit it and `-EBADF` for every verb
/// after it (§8), not a crash. What it costs is the epoch, not the run.
#[test]
fn test_deferred_submissions_survive_a_trap() {
    let guest = fixture("session_guest_defer_trap.wat");
    let output = run(&[
        "--session-callbacks",
        "1",
        "--post-test-events",
        "--capability",
        ECHO,
        &guest,
    ]);

    let err = stderr(&output);
    assert!(
        err.contains("callback `onBatch` trapped"),
        "the trap must be reported\nstderr: {err}"
    );
    assert!(
        err.contains("epoch -> -5"),
        "the trapping epoch is -EIO\nstderr: {err}"
    );
    assert!(
        err.contains("epoch -> -9"),
        "and the next verb is -EBADF: the session is FAULTED\nstderr: {err}"
    );
    assert!(
        err.contains("pending after the guest: 2 submission(s)"),
        "R7: the two queued submissions outlive the trap\nstderr: {err}"
    );
}

/// A2c's rejection path, end to end: the callback queues a submission whose
/// apply the adapter refuses, the session posts a SUBMISSION_REJECTED event, and
/// the guest's `onEvent` — subscribed to that class as DIRECT — receives it with
/// the verb id and the adapter's errno.
#[test]
fn test_a_rejected_submission_is_delivered() {
    let guest = fixture("session_guest_defer_rejected.wat");
    let output = run(&[
        "--session-callbacks",
        "1,2",
        "--post-test-events",
        "--capability",
        ECHO,
        &guest,
    ]);

    assert!(
        output.status.success(),
        "the run failed (exit {:?})\nstdout: {}\nstderr: {}",
        output.status.code(),
        stdout(&output),
        stderr(&output)
    );
    assert!(
        stdout(&output).contains("R 3 3"),
        "the guest must report class 3 (SUBMISSION_REJECTED) and verb 3\nstdout: {}\nstderr: {}",
        stdout(&output),
        stderr(&output)
    );
    let err = stderr(&output);
    assert!(
        err.contains("adapter `echo` refused verb 3 with -22"),
        "the adapter's refusal must be named\nstderr: {err}"
    );
}

/// Path resolution: `--capability` takes a path, and a value that names no file
/// is looked up as `libtension_<name>.so` through `TENSION_CAPABILITY_PATH`
/// (round-2 decision 3). A name that resolves nowhere is a named refusal, not a
/// silent no-adapter run.
#[test]
fn test_capability_name_resolves_through_the_path_variable() {
    let dir = PathBuf::from(ECHO)
        .parent()
        .expect("the adapter lives in a directory")
        .to_path_buf();
    let guest = fixture("session_guest.wat");
    let output = Command::new(BINARY)
        .env("TENSION_CAPABILITY_PATH", &dir)
        .args(["--session-open", "--capability", "echo", &guest])
        .output()
        .expect("the interpreter starts");
    assert!(
        output.status.success(),
        "the name must resolve to libtension_echo.so\nstderr: {}",
        stderr(&output)
    );

    let output = Command::new(BINARY)
        .env("TENSION_CAPABILITY_PATH", &dir)
        .args(["--session-open", "--capability", "no-such-capability", &guest])
        .output()
        .expect("the interpreter starts");
    assert!(!output.status.success());
    let err = stderr(&output);
    assert!(
        err.contains("libtension_no-such-capability.so"),
        "the diagnostic must name what it looked for\nstderr: {err}"
    );
}
