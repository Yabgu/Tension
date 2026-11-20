//! Build and locate a test program — one recipe, every test that runs one.
//!
//! `scripts/build-test-programs.mjs` carries the flag list for each program
//! (a `.ts` in `tests/programs/`), because the compiler is vendored and two
//! copies of a flag list drift. This module is the Rust side of that one
//! recipe: it invokes the script when a `.wasm` is missing or older (the script
//! decides), and hands back the artifact.
//!
//! Included with `#[path = "support/programs.rs"] mod support_programs;` beside
//! the existing `#[path = "support/ci.rs"] mod support_ci;`. The skip policy is
//! the same one: a failing build or a missing artifact **fails** by default and
//! prints a skip only with `TENSION_TEST_ALLOW_SKIP=1`.

#[path = "ci.rs"]
mod support_ci;

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tension-core is a directory under the repository root")
        .to_path_buf()
}

pub fn programs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("programs")
}

/// Run the builder. Cheap when every artifact is current.
pub fn build() {
    let script = repo().join("scripts").join("build-test-programs.mjs");
    let status = Command::new("node")
        .arg(&script)
        .current_dir(programs_dir())
        .status()
        .unwrap_or_else(|error| {
            support_ci::skip_or_fail(format_args!(
                "test programs: could not run `node {}`: {error}",
                script.display()
            ));
            panic!("unreachable: skip_or_fail panics by default")
        });
    if !status.success() {
        support_ci::skip_or_fail(format_args!(
            "test programs: `node {}` failed ({status}); the programs are not built",
            script.display()
        ));
    }
}

/// One program's artifact, built on demand.
pub fn guest(name: &str) -> PathBuf {
    build();
    let path = programs_dir().join("build").join(format!("{name}.wasm"));
    if !path.exists() {
        support_ci::skip_or_fail(format_args!(
            "test programs: {} does not exist after the build",
            path.display()
        ));
    }
    path
}
