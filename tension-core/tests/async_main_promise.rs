//! An `async main` runs on the **Promise** backend — the regression guard for
//! round AS2.
//!
//! `tests/programs/async/async-main-promise.ts` is built with `PLAIN_FLAGS`
//! plus `--exportStart __start`: no `--enable stack-switching`, so `main` is
//! lowered by Backend A into a state machine, and the shell `__start` runs is
//! the Promise one — call `main`, then drain the guest's ready queue.
//!
//! **What broke, and why this test is the shape it is.** Before AS2, a program
//! that awaited and was built without stack switching got *no shell at all*:
//! `shouldEmitAsyncShell` returned `hasAwait && asyncShellSuspends`, which is
//! `true && false` for exactly that build, so `main` had zero call sites and the
//! guest exited 0 having printed nothing — measured on Linux as well as on
//! Windows, so the platform was never the variable. `hasAwait` is latched from
//! every parsed source, reachability not consulted, so one unreachable `await`
//! in an imported library file was enough to switch a program off.
//!
//! Two assertions, and they are different questions:
//!
//! 1. **The module loads on an engine without stack switching.** That is the
//!    Windows blocker stated as a property, and it is measurable here: a default
//!    `Config` has the feature off, exactly like the Promise backend, and
//!    `continuation_module.rs` relies on the same fact. A shell that emitted
//!    continuation types would pass assertion 2 on this machine and fail this
//!    one — which is precisely how the bug survived four rounds of Linux
//!    measurement.
//! 2. **`main` runs, in order, and the guest exits 0.** The transcript is
//!    `async-main-promise.expected.txt`; an empty stdout is the defect.
//!
//! The program imports `print` from the framework's `io` module and not the
//! barrel: importing the barrel would drag in `./2d`'s `await` and make the test
//! depend on the reachability-blindness rather than on the shell.

#[path = "support/programs.rs"]
mod support_programs;

use std::process::Command;

use support_programs::{guest, programs_dir};

fn transcript(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// A guest the Promise backend must be able to *load*, wherever it was built.
///
/// A default `Config` does not enable stack switching, so this is the same gate
/// a Windows host meets. `Module::new` is the whole check: wasmtime refuses a
/// module that merely declares a continuation type, before any code runs.
#[test]
fn the_promise_entry_loads_without_stack_switching() {
    let guest = guest("async-main-promise");
    let bytes = std::fs::read(&guest)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", guest.display()));
    let engine = wasmtime::Engine::new(&wasmtime::Config::new()).expect("a default engine");
    if let Err(error) = wasmtime::Module::new(&engine, &bytes) {
        panic!(
            "{} must load on an engine without stack switching — that is the Promise \
             backend, and the whole point of round AS2:\n{error:?}",
            guest.display()
        );
    }
}

#[test]
fn async_main_runs_on_the_promise_backend() {
    let guest = guest("async-main-promise");
    let expected_path = programs_dir().join("async-main-promise.expected.txt");
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
        !expected.is_empty(),
        "{} is empty; the expected transcript must say what the guest prints",
        expected_path.display()
    );
    // The defect was an exit 0 with nothing on stdout, so this is the assertion
    // that would have caught it: silence is a failure, not a pass.
    assert!(
        !transcript(&stdout).is_empty(),
        "async main printed nothing — `main` was never called. This is the \
         AS2 defect: no shell was emitted for an awaiting program built \
         without stack switching.\nstderr:\n{stderr}"
    );
    assert_eq!(
        transcript(&stdout),
        expected,
        "the Promise backend's transcript differs\nstderr:\n{stderr}"
    );
    assert!(
        output.status.success(),
        "the guest must exit 0, got {:?}\nstderr:\n{stderr}",
        output.status.code()
    );
}
