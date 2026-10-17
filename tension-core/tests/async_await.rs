//! Phase 4c: `await` against a real, delayed, cross-thread completion.
//!
//! `docs/async-await-plan-v2.md` §8.1 names this file as the *meaningful*
//! harness, for a reason the review made unavoidable (finding 8.2): a test that
//! runs `tension-core` as a subprocess cannot inject a delayed post — the
//! posting face lives inside the child — and the one existing in-process flag
//! (`--post-test-events`) posts *before* the guest starts, which proves delivery
//! but not suspension. The producer that does exist, on its own thread, after a
//! real delay, is the OGRE capability: the loader's worker reads the bytes and
//! the render thread posts `JOB_DONE` (`loader.cpp:433-439`, `adapter.cpp:194-197`).
//! So the guest here awaits a *mesh load*, and the test asserts the guest's own
//! transcript.
//!
//! The four criteria (§8.2), asserted by the guest and re-checked here:
//!
//! 1. **ordering** — the pre-await line precedes the post-await line, and the
//!    post-await line is printed by a later frame;
//! 2. **genuine yield** — `frames-while-suspended >= 1`, so a busy-waiting guest
//!    would fail;
//! 3. **lifted locals survive** — a local assigned before the await and read
//!    after it holds its value;
//! 4. **no reentrancy refusal** — no `-EBADF`/`-EBUSY` from any session verb;
//!
//! plus `jobResult(job) == the awaited value` and `jobState(job) == JOB_DONE`.
//!
//! The guest (`tension-ogre/tests/guest-async.ts`, built by that directory's
//! `run.sh`) prints one line per observation and `ASYNC PASS` at the end; any
//! failed clause prints `ASYNC FAIL: <reason>` and traps, so a wrong value is a
//! non-zero exit rather than a passing line.
//!
//! Skip policy: `tests/support/ci.rs`. A missing DSO, guest or volume **fails**
//! by default — and the message names the missing artifact. `TENSION_TEST_ALLOW_SKIP=1`
//! is the explicit opt-out for a developer iterating without the fixtures.

#[path = "support/ci.rs"]
mod support_ci;

use std::path::{Path, PathBuf};
use std::process::Command;

fn built(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-ogre")
        .join("build")
        .join(name)
}

fn guest() -> Option<PathBuf> {
    let path = std::env::var("TENSION_ASYNC_GUEST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-async.wasm"));
    if path.exists() {
        return Some(path);
    }
    support_ci::skip_or_fail(format_args!(
        "async_await: {} is not built — run `tension-ogre/tests/run.sh` (it compiles \
         guest-async.ts with the framework's session flags and needs a compiler with \
         the Phase 4 std); skipping",
        path.display()
    ));
    None
}

fn adapter() -> Option<PathBuf> {
    let path = std::env::var("TENSION_OGRE_DSO_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("libtension_ogre.so"));
    if path.exists() {
        return Some(path);
    }
    support_ci::skip_or_fail(format_args!(
        "async_await: {} is not built — run `tension-ogre/build.sh`; skipping",
        path.display()
    ));
    None
}

/// The packed fixture volume. `guest-async.ts` loads `resources/models/Barrel.mesh`
/// out of it, so no mount and no bytes means no job to await.
fn volume() -> Option<PathBuf> {
    let path = built("fixtures.tns");
    if path.exists() {
        return Some(path);
    }
    support_ci::skip_or_fail(format_args!(
        "FIXTURE: {} is not built — run `tension-ogre/tests/run.sh` (it packs the shared \
         fixture volume); skipping",
        path.display()
    ));
    None
}

#[test]
fn test_async_await_over_a_real_job() {
    let (Some(guest), Some(adapter), Some(volume)) = (guest(), adapter(), volume()) else { return };

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(&adapter)
        .arg(&guest)
        .arg("--renderer=null")
        .arg(format!("--tns={}", volume.display()))
        .output()
        .expect("the interpreter runs");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // The guest asserts its own clauses and traps on any failure, so "the
    // process exited 0 and printed PASS" is the whole contract; the two lines
    // below name the failure when it is not.
    assert!(
        output.status.success(),
        "the async harness failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(6).collect::<Vec<_>>().join("\n")
    );

    // 1. ordering: both lines present, pre before post.
    let pre = stdout.find("ASYNC pre-await").expect("no pre-await line");
    let post = stdout.find("ASYNC post-await").expect("no post-await line");
    assert!(pre < post, "the post-await line preceded the pre-await line\nstdout: {stdout}");

    // 2. genuine yield: the guest measured at least one frame while parked.
    let frames = stdout
        .lines()
        .find(|line| line.starts_with("ASYNC frames-while-suspended="))
        .and_then(|line| line.rsplit('=').next())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .expect("no frames-while-suspended line");
    assert!(
        frames >= 1,
        "frames-while-suspended = {frames}: the task did not suspend (a busy-waiting \
         guest passes every other criterion)\nstdout: {stdout}"
    );

    // 3 and 4, plus the two cross-checks, are the guest's own assertions — it
    // traps when a lifted local is wrong, a verb refuses with -EBADF/-EBUSY, or
    // the job's table disagrees with the record. Reaching here means it printed
    // PASS after checking them.
    assert!(
        stdout.contains("ASYNC PASS"),
        "the guest did not pass its own clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}
