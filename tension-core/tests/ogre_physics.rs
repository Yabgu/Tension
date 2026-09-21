//! The rigid-body acid test, from cargo (chunk 6).
//!
//! Sixteen spheres dropped into a box for sixty rendered frames, then asked
//! whether the physics held: is anything still moving, is anything under the
//! floor, is anything inside anything else, and is the picture where the state
//! says it should be. The configuration — and the tolerances — are chunk 6a's
//! probe configuration, so the numbers mean something: 0.1 m/s of allowed creep
//! against 0.057 measured, 5 mm of allowed penetration against 4.0 measured.
//!
//! The structural half always runs (renderer=null, no display needed); the
//! pixel half needs a window and is opt-in behind `TENSION_OGRE_WINDOW_TEST=1`,
//! the same switch `run.sh` uses.
//!
//! Both skip with a printed reason when the fixture or the shared object has not
//! been built.

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
    let path = std::env::var("TENSION_OGRE_PHYSICS_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-physics.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_physics: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
         skipping",
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
    eprintln!("ogre_physics: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_physics: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the pixel tier \
         (it opens a real window)"
    );
    false
}

fn run(renderer: &str) -> std::process::Output {
    let (Some(fixture), Some(adapter)) = (fixture(), adapter()) else {
        panic!("the fixture and the adapter must both be built to run this test");
    };
    Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(&adapter)
        .arg(&fixture)
        .arg(format!("--renderer={renderer}"))
        .output()
        .expect("the interpreter runs")
}

/// The structural tier: the world runs, the state at frame 60 is finite, at
/// rest, above the floor, non-overlapping and nearly out of energy, and by
/// frame 240 the pile is asleep with a kinetic energy of exactly zero and a
/// state that has not changed in thirty frames.
#[test]
fn test_ogre_physics_structural() {
    if fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("null");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| line.starts_with("2 ok:") || line.starts_with("5 ok:"))
        .collect();
    assert!(
        output.status.success(),
        "the structural physics clauses failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 9/9 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}

/// The pixel tier: the pile is drawn where the state says, nothing is under the
/// floor on screen, and the pile flips pixels while it moves and none once it
/// has settled.
#[test]
fn test_ogre_physics_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            line.starts_with("7 ok:") || line.starts_with("8 ok:") || line.starts_with("9 ok:")
        })
        .collect();
    assert!(
        output.status.success(),
        "the physics pixel clauses failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 12/12 passed"),
        "the guest did not pass its twelve clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_physics: {}", measured.join("\n              "));
}
