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
//!
//! [`guest_debug`] is the same recipe in the script's `--debug` mode: the same
//! program, the same flags, plus `--debug --sourceMap`, landing in
//! `build/debug/<name>.wasm`. One caller
//! (`tests/debugger.rs`) needs a line table; nothing else should pay for one.
//!
//! # A debug guest resolves in three steps
//!
//! 1. The **committed fixture** at `tests/programs/fixtures/debug/<name>.wasm`,
//!    if it is there. That is the whole point of committing one: the CI job that
//!    runs the breakpoint assertions installs no compiler (the tarball it would
//!    install is in `.packs/`, which is not in the repository), so a resolution
//!    that could only build would leave that job nothing to bind in.
//! 2. Otherwise the compiler's `--debug` mode, **if the vendored compiler is
//!    installed** (`node_modules/@yabgu_gm/tensionscript`). A developer's
//!    checkout builds the artifact it wants to inspect.
//! 3. Otherwise one line naming what is missing and what to run, and `None`.
//!
//! Step 3 is the one case that does **not** go through
//! [`support_ci::skip_or_fail`], and the reason is in the shape of the answer:
//! a checkout with no compiler and no fixture cannot produce the artifact at
//! all, so there is nothing to fail *on* — the honest report is the missing
//! recipe. A test that resolves to `None` prints that line and returns without
//! asserting a stop; the fixture's own presence is asserted separately, by a
//! test that hard-fails, so a deleted fixture cannot turn a green job into a
//! test that measured nothing.

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
    run_builder(&[]);
}

/// Run the builder in its `--debug` mode: `build/debug/`, `--debug --sourceMap`.
pub fn build_debug() {
    // **One build at a time, per test process.** `cargo test` runs this file's
    // tests on several threads, and two of them can reach the builder at once —
    // the breakpoint tests when the artifacts are stale, and the negative
    // control that needs a release build. Two `node` processes writing the same
    // output files means one can read a half-written `.wasm`, which surfaces as
    // a breakpoint that does not bind rather than as a build error. Measured:
    // the first run after a checkout fails 2 of 5, a rerun passes, because the
    // first run is the one that builds.
    run_builder(&["--debug"]);
}

fn run_builder(extra: &[&str]) {
    // **One builder at a time, per test process** — release and debug alike.
    // `cargo test` runs these tests on several threads; two `node` processes
    // writing the same output files means one can read a half-written `.wasm`,
    // which surfaces as a breakpoint that does not bind rather than as a build
    // error. Measured: the first run after a fresh checkout failed 2 of 5
    // breakpoint tests and a rerun passed, because the first run is the one
    // that builds.
    static BUILDING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = BUILDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let script = repo().join("scripts").join("build-test-programs.mjs");
    let status = Command::new("node")
        .arg(&script)
        .args(extra)
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
            "test programs: `node {} {}` failed ({status}); the programs are not built",
            script.display(),
            extra.join(" ")
        ));
    }
}

/// One program's artifact, built on demand.
pub fn guest(name: &str) -> PathBuf {
    build();
    artifact(&programs_dir().join("build"), name)
}

/// The committed debug artifacts — a `--debug --sourceMap` build in the tree,
/// so a machine with no compiler can still be handed one.
pub fn debug_fixtures_dir() -> PathBuf {
    programs_dir().join("fixtures").join("debug")
}

/// Whether the vendored compiler is installed in this checkout.
///
/// The path is the one the root `package.json` devDependency installs to, which
/// is why the check is a directory and not a version: `scripts/tensionscript.mjs`
/// is the only thing that decides *which* compiler runs and proves it came from
/// the pinned tarball. This answers the weaker question the resolution order
/// needs — is there a compiler here at all, or is a build a waste of a spawn.
pub fn compiler_installed() -> bool {
    repo()
        .join("node_modules")
        .join("@yabgu_gm")
        .join("tensionscript")
        .is_dir()
}

/// One program's **debug** artifact — the same program with DWARF and a source
/// map — as the committed fixture, else built on demand, else `None`.
///
/// The order is documented at the top of this file and stated here once, so the
/// test and any future caller cannot drift: fixture, build, one printed line.
/// `None` means "this machine cannot produce the artifact", never "the
/// artifact is broken" — the caller prints nothing further and asserts nothing.
pub fn guest_debug(name: &str) -> Option<PathBuf> {
    let fixture = debug_fixtures_dir().join(format!("{name}.wasm"));
    if fixture.is_file() {
        return Some(fixture);
    }

    if !compiler_installed() {
        eprintln!(
            "debugger: no debug artifact for {name} — {} is not committed, and the vendored \
             compiler is not installed at node_modules/@yabgu_gm/tensionscript; run \
             `npm install`, then `node scripts/build-test-programs.mjs --debug`",
            fixture.display()
        );
        return None;
    }

    build_debug();
    Some(artifact(&programs_dir().join("build").join("debug"), name))
}

fn artifact(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(format!("{name}.wasm"));
    if !path.exists() {
        support_ci::skip_or_fail(format_args!(
            "test programs: {} does not exist after the build",
            path.display()
        ));
    }
    path
}
