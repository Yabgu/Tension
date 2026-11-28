//! **A suspending `async` method lowers on fiber, and `this` survives the suspension**
//! (DL62, I126).
//!
//! The shape every OGRE example writes and the stackful backend refused with
//! `AS100: Not implemented: an async method (the stackful backend)`. The refusal was
//! narrower than it looked — a method *without* an `await` merely had its modifier
//! cleared — so the gap was exactly "a method body that must survive a suspension".
//!
//! Two fixtures, and the second is the one a naive lift breaks:
//!
//! - `probe/async-method.ten` — `this.count += value` **after** the await, so a record
//!   that lost its receiver would print the wrong number or trap.
//! - `probe/async-method-closure.ten` — an arrow that captures `this`, declared *after* the
//!   await. Rewriting every `this` to a `$self` parameter would have to reach inside this
//!   closure; keeping the body a member of its class means it needs no rewriting at all.
//!
//! Each is asserted twice: on the **artifact** (it imports `scheduler::ready` and exports
//! `__driveSlot`, so the host ran the body rather than the guest pumping) and on the
//! **transcript** (the awaited value, and the receiver read after the suspension).
//!
//! Fixtures are committed for the reason `park_frame` and `spawn_ready` are: CI installs no
//! compiler, so a gate that only runs on a developer's machine is not a gate.

#[path = "support/programs.rs"]
mod support_programs;

use std::process::Command;

use support_programs::{fiber_fixtures_dir, guest_or_fixture, programs_dir};

fn probe(name: &str) -> std::path::PathBuf {
    guest_or_fixture(name, fiber_fixtures_dir())
}

fn transcript(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && !line.contains("INFO  core:"))
        .map(str::to_string)
        .collect()
}

/// The artifact is the claim about *how* the body ran: the slot went to the host's queue.
fn assert_handed_over(name: &str) {
    let path = probe(name);
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("scheduler") && text.contains("ready"),
        "{name}: a fiber guest whose method suspends must import `scheduler::ready` — the \
         slot is the host's to run"
    );
    assert!(
        text.contains("__driveSlot"),
        "{name}: the host's drain resumes a slot through `__driveSlot`"
    );
    assert!(
        text.contains("backend=fiber"),
        "{name}: the artifact must declare the backend it was built for"
    );
}

fn assert_transcript(name: &str) {
    let expected_text = std::fs::read_to_string(
        programs_dir().join(format!("probe/{name}.expected.txt"))
    ).expect("the expected transcript is committed");
    let expected = transcript(&expected_text);

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(probe(name))
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{name} failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(8).collect::<Vec<_>>().join("\n")
    );
    assert_eq!(
        transcript(&stdout), expected,
        "{name}: a body that runs but loses its awaited value or its receiver is the I103 \
         shape — the numbers in this transcript are the whole assertion"
    );
}

#[test]
fn a_suspending_method_hands_its_slot_to_the_host() {
    assert_handed_over("async-method");
    assert_handed_over("async-method-closure");
}

#[test]
fn the_method_reads_its_receiver_after_the_suspension() {
    // `ctr before 1` then `ctr after 10` — the awaited value is 10, and `this.count`
    // accumulated it.
    assert_transcript("async-method");
}

#[test]
fn a_closure_capturing_this_after_an_await_still_sees_the_receiver() {
    assert_transcript("async-method-closure");
}

#[test]
fn ten_runs_read_the_same_transcript() {
    let mut first: Option<Vec<String>> = None;
    for run in 1..=10 {
        let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
            .arg(probe("async-method"))
            .output()
            .expect("the interpreter runs");
        assert!(output.status.success(), "run {run} did not exit 0");
        let lines = transcript(&String::from_utf8_lossy(&output.stdout));
        match &first {
            None => first = Some(lines),
            Some(expected) => assert_eq!(&lines, expected, "run {run} differed"),
        }
    }
}
