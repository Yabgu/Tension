//! `tension::threads` exists, and every verb in it answers `-ENOTSUP`.
//!
//! The stub is worth a test precisely because it does nothing: a capability that
//! is registered for every guest but never exercised is a linker typo waiting to
//! surface as a nested guest's `unknown import`. So the guest here **imports all
//! six verbs at instantiation** and traps unless each answers `-95`.
//!
//! A trap is the assertion. Exit 0 means the imports resolved *and* the codes
//! were right; either failure gives a non-zero exit with the guest's own
//! `unreachable` (or the host's `unknown import: tension::threads::…`, which is
//! the message this test exists to make impossible to miss).
//!
//! It drives the real binary, `session_smoke`'s pattern: the linker this
//! exercises is the one `guest.rs` builds for every guest, not a copy.

use std::path::Path;
use std::process::{Command, Output};

/// The interpreter under test.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");

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

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn every_threads_verb_answers_enotsup() {
    let guest = fixture("threads_stub_guest.wat");
    let output = run(&[&guest]);

    assert!(
        output.status.success(),
        "the stub guest did not complete (exit {:?})\nstderr: {}",
        output.status.code(),
        stderr(&output)
    );

    // The run succeeded, so the six imports resolved; this assertion is here so
    // that a *silent* failure to link cannot be mistaken for success if the host
    // ever started tolerating unknown imports.
    assert!(
        !stderr(&output).contains("unknown import"),
        "every `tension::threads` verb must be registered for this guest\nstderr: {}",
        stderr(&output)
    );
}
