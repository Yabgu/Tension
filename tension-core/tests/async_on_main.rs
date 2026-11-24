//! One program, two hosts: the shared `async-main` ABI contract.
//!
//! `tests/programs/async-on-main.ts` is a verbatim copy (plus a header naming
//! its origin) of TensionScript's `examples/async-main/main.ts`.
//! TensionScript's `tests/rt/examples.js` asserts that file on a stub host;
//! this test asserts the same file on `tension-core`. If the two hosts disagree
//! about the ABI — a tag, a suspension count, a value carried across a
//! suspension — one of the two suites fails, which was the point: before this,
//! `examples/async-on-main/game.ts` and the TensionScript example both claimed
//! to be the contract and differed, so neither suite could catch the drift.
//!
//! The expected transcript is `async-on-main.expected.txt`, one line per line:
//!
//! ```text
//! carried: 11
//! carried: 12
//! carried: 13
//! suspensions: 6
//! total: 33
//! final: 149
//! status: 149
//! ```
//!
//! The first six lines are the guest's `env.emit(tag, value)` calls, named by
//! the host's tag table (`host/io.rs`). `status` is the harness's own line: the
//! program has no `_start_game`, `__start` runs its continuation chain, and the
//! host prints `__asyncStatus` after `__start` returns — the same value
//! TensionScript's `run.mjs` reads from the export. A change to the program is a
//! change to both repos in the same breath.
//!
//! Built by `scripts/build-test-programs.mjs`, whose `ASYNC_ON_MAIN_FLAGS` add
//! `--exportStart __start`: the boot body is an export the host calls, not a
//! start section that would run before the arena check. The `-O0` in that flag
//! list is the pinned Binaryen's requirement for stack switching, and the reason
//! is recorded there.
//!
//! No capability, window or volume: `tension-core <guest>` is the whole
//! invocation.

#[path = "support/programs.rs"]
mod support_programs;

use std::process::Command;

use support_programs::{guest, programs_dir};

fn transcript(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim_end)
        // The host logs to stderr; an empty line is never part of the contract.
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
fn the_shared_program_prints_the_contract_transcript() {
    let guest = guest("async-on-main");
    let expected_path = programs_dir().join("async-on-main.expected.txt");
    let expected_text = std::fs::read_to_string(&expected_path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", expected_path.display()));
    let expected = transcript(&expected_text);

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(&guest)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);

    // `async-on-main` is a stackful guest: one store, one executor, no threads,
    // every suspension a continuation. On a target without stack switching the
    // host refuses it by name; assert that refusal rather than failing with a
    // mystery, and print the reason.
    if !tension_core::async_backend::current().supports_continuations() {
        assert!(
            !output.status.success(),
            "async-on-main must be refused on a target without stack switching, but it exited 0\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stderr.contains("stack switching") || stderr.contains("continuation"),
            "the refusal for async-on-main must name the feature, got:\n{stderr}"
        );
        eprintln!(
            "async-on-main: stack switching is unavailable on {} — the host refused \
             the guest by name (expected), and the transcript comparison is skipped",
            std::env::consts::OS,
        );
        return;
    }

    assert!(
        output.status.success(),
        "the shared program failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(10).collect::<Vec<_>>().join("\n")
    );

    let actual = transcript(&stdout);
    assert_eq!(
        actual, expected,
        "the transcript does not match {}.\nTensionScript's `tests/rt/examples.js` \
         asserts the same program; a change here is a change in both repos.\nstdout:\n{stdout}",
        expected_path.display()
    );
}

// ---------------------------------------------------------------------------
// The same contract, on the fiber backend (DL38, I90)
// ---------------------------------------------------------------------------

/// **The gate that would have caught I90.**
///
/// The continuation build above was the only build of this program, so a whole
/// backend could lose its suspensions and every suite stayed green: the fiber
/// artifact printed `suspensions: 0`, `total: 0`, `final: 13` and **exited 0** —
/// a transcript that is wrong in the most dangerous way, because nothing failed.
///
/// This runs the *same source*, compiled with `--stackful-backend=fiber` and
/// without `--enable stack-switching` (`async-on-main-fiber`, an alias in
/// `scripts/build-test-programs.mjs`), and asserts the **same seven lines**.
///
/// # Why one expected file and not two
///
/// The seven lines are the ABI contract, and a backend is not allowed to change
/// them: `carried` proves a local survived the suspension, `suspensions` that the
/// bodies ran, `total`/`final` that the values came back. Two expected files
/// would let the fiber backend drift and still pass — which is the defect, one
/// level up. So both tests read `async-on-main.expected.txt`.
///
/// # No stack-switching gate
///
/// The continuation test refuses to compare on a target without continuations,
/// because the host must refuse that guest. This one needs no such branch: a
/// fiber artifact declares no continuation type (DL37), so it loads and runs
/// everywhere — and if it quietly did not, that is a failure to report, not a
/// reason to skip.
#[test]
fn the_fiber_backend_prints_the_same_contract_transcript() {
    let guest = guest("async-on-main-fiber");
    let expected_path = programs_dir().join("async-on-main.expected.txt");
    let expected_text = std::fs::read_to_string(&expected_path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", expected_path.display()));
    let expected = transcript(&expected_text);

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(&guest)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "the fiber build of the shared program failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(10).collect::<Vec<_>>().join("\n")
    );

    let actual = transcript(&stdout);
    assert_eq!(
        actual, expected,
        "the fiber build's transcript does not match {}. The two backends share one \
         contract (I90): a value that arrives on one and not the other is the defect \
         this test exists for.\nstdout:\n{stdout}\nstderr:\n{stderr}",
        expected_path.display()
    );

    // **The executor was chosen from the artifact**, with no flag saying so: this
    // is what makes the test a test of the record and the lowering together.
    assert!(
        stderr.contains("executor: fiber"),
        "the artifact's record did not select the fiber executor:\n{stderr}"
    );
}
