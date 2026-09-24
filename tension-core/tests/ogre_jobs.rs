//! The 3a acid test, from cargo (chunk 3, round 3a-ii).
//!
//! One guest, one session, five clauses about jobs — and it asserts its own
//! results, which is what makes it the milestone's gate rather than a
//! collection of unit tests. Skips with a printed reason when the fixture or
//! the shared object has not been built.

use std::path::{Path, PathBuf};
use std::process::Command;

fn built(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-ogre")
        .join("build")
        .join(name)
}

fn fixture() -> Option<PathBuf> {
    let path = std::env::var("TENSION_OGRE_JOBS_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-jobs.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_jobs: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
         skipping the acid test",
        path.display()
    );
    None
}

/// The shared fixture volume (chunk 11): every fixture that loads anything
/// mounts this one, packed by `tension-ogre/tests/pack.sh` from
/// `tension-ogre/tests/resources/`. Absent means run.sh has not run.
fn volume() -> Option<PathBuf> {
    let path = built("fixtures.tns");
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "FIXTURE: {} is not built — run `tension-ogre/tests/run.sh` (it packs the shared \
         fixture volume); skipping the acid test",
        path.display()
    );
    None
}

fn adapter() -> Option<PathBuf> {
    let path = std::env::var("TENSION_OGRE_DSO_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("libtension_ogre.so"));
    if path.exists() {
        return Some(path);
    }
    eprintln!("ogre_jobs: {} is not built — run `tension-ogre/build.sh`; skipping", path.display());
    None
}

#[test]
fn test_ogre_jobs_acid() {
    let (Some(fixture), Some(adapter), Some(volume)) = (fixture(), adapter(), volume()) else { return };
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(&adapter)
        .arg(&fixture)
        .arg("--renderer=null")
        .arg(format!("--tns={}", volume.display()))
        .output()
        .expect("the interpreter runs");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the acid test failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 5/5 passed"),
        "the guest did not pass its own clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}
