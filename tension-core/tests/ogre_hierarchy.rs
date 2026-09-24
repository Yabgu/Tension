//! The chunk-5a acid test, from cargo (round 5a).
//!
//! A parent node and a child node; a drawable hanging from the child; the
//! parent rotated 180 degrees about Y. The drawable's own record is never
//! touched again — so if the pixels move from one half of the frame to the
//! other, the composition is OGRE's scene graph doing it, which is the whole
//! claim of this round.
//!
//! The structural half always runs (renderer=null); the pixel half needs a real
//! window and is opt-in behind `TENSION_OGRE_WINDOW_TEST=1`, the same switch
//! `run.sh` uses.

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
    let path = std::env::var("TENSION_OGRE_HIERARCHY_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-hierarchy.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_hierarchy: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
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
    eprintln!("ogre_hierarchy: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn run(renderer: &str) -> std::process::Output {
    let (Some(fixture), Some(adapter), Some(volume)) = (fixture(), adapter(), volume()) else {
        panic!("the fixture, the adapter and the fixture volume must all be built to run this test");
    };
    Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(&adapter)
        .arg(&fixture)
        .arg(format!("--renderer={renderer}"))
        .arg(format!("--tns={}", volume.display()))
        .output()
        .expect("the interpreter runs")
}

/// The structural tier: the five clauses that need no pixels.
#[test]
fn test_ogre_hierarchy_structural() {
    if fixture().is_none() || adapter().is_none() || volume().is_none() {
        return;
    }
    let output = run("null");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the structural acid test failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 5/5 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}

/// The visual tier: the child's blob crosses from the right half of the frame
/// to the left after its parent turns. The measured halves are printed either
/// way, because "the object did not move" and "the object vanished" are the two
/// failures this clause exists to tell apart.
#[test]
fn test_ogre_hierarchy_pixels() {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() != Ok("1") {
        eprintln!(
            "ogre_hierarchy: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the pixel tier \
             (it opens a real window)"
        );
        return;
    }
    if fixture().is_none() || adapter().is_none() || volume().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| line.starts_with("baseline: ") || line.starts_with("after: "))
        .collect();
    assert!(
        output.status.success(),
        "the pixel acid test failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 8/8 passed"),
        "the guest did not pass its eight clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_hierarchy: {}", measured.join("\n               "));
}
