//! **Spawned work runs, and the slot goes through the host's queue** (DL61, I95).
//!
//! Three tasks, none awaited, all three bodies must run exactly once. On the fiber backend
//! that was `0` of `3` through DL60 — and the whole reason it was zero is the ordering
//! defect this round fixed: `__driveSlot` was compiled *after* the override stubs were
//! finalized, so `TaskBase#drive`'s virtual stub was a bare `unreachable` and the record's
//! own synthesized `drive` was never compiled at all.
//!
//! Three assertions, three different questions:
//!
//! 1. **The artifact can hand a slot over.** It must import `scheduler::ready` and export
//!    `__driveSlot`. Without both, "the bodies ran" could only mean the guest ran them
//!    itself — the pumping this design refuses — so the artifact, not the transcript, is
//!    the claim about *how* the work started.
//! 2. **All three bodies run, once each, in submission order.** The transcript is
//!    `probe/spawn-ready.expected.txt`; the default FIFO policy makes the order the order
//!    they were handed over.
//! 3. **Ten runs agree.** A queue whose order depends on a hash map or a race would pass
//!    once; ten identical transcripts is the determinism the corpus example also needs.
//!
//! The probe's `work` awaits something on purpose: an async function with no `await` is not
//! lowered at all, so a probe without one measures nothing.

#[path = "support/programs.rs"]
mod support_programs;

use std::process::Command;

use support_programs::{fiber_fixtures_dir, guest_or_fixture, programs_dir};

/// The probe's artifact: built when this checkout has a compiler, the committed fixture when
/// it does not — the rule `park_frame` and `input_sources` follow, and what lets the
/// Stackful proofs job run this gate with no compiler at all.
fn probe() -> std::path::PathBuf {
    guest_or_fixture("spawn-ready", fiber_fixtures_dir())
}

fn transcript(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && !line.contains("INFO  core:"))
        .map(str::to_string)
        .collect()
}

#[test]
fn the_guest_hands_slots_to_the_host() {
    let bytes = std::fs::read(probe())
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", probe().display()));
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("scheduler") && text.contains("ready"),
        "a fiber guest that spawns must import `scheduler::ready`: the slot is the host's to \
         run, and a guest that ran it itself would be pumping"
    );
    assert!(
        text.contains("__driveSlot"),
        "the host's drain resumes a slot through `__driveSlot`, so the guest must export it"
    );
}

#[test]
fn every_spawned_body_runs_once_in_submission_order() {
    let expected_text = std::fs::read_to_string(programs_dir().join("probe/spawn-ready.expected.txt"))
        .expect("the expected transcript is committed");
    let expected = transcript(&expected_text);

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(probe())
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "the spawn probe failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(8).collect::<Vec<_>>().join("\n")
    );
    assert_eq!(
        transcript(&stdout),
        expected,
        "every spawned body must run exactly once, in submission order — a missing `ran N` is \
         work that was spawned and never started, which is the defect this gate exists for"
    );
}

#[test]
fn ten_runs_read_the_same_transcript() {
    let mut first: Option<Vec<String>> = None;
    for run in 1..=10 {
        let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
            .arg(probe())
            .output()
            .expect("the interpreter runs");
        assert!(output.status.success(), "run {run} did not exit 0");
        let lines = transcript(&String::from_utf8_lossy(&output.stdout));
        match &first {
            None => first = Some(lines),
            Some(expected) => assert_eq!(
                &lines, expected,
                "run {run} saw a different order: the ready queue's policy is FIFO, so the \
                 order is the hand-over order every time"
            ),
        }
    }
}
