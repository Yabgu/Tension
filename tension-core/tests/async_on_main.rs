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
