//! The chunk-5b acid test, from cargo (round 5b).
//!
//! A rigged mesh under a PBS material, one bone rotated 90° over sixty renderer
//! frames, and the assertion that the silhouette changed shape **because of the
//! rig** — nothing in the fixture ever submits motion, which is what makes "the
//! mesh deformed" a claim about skinning rather than about a moving object.
//!
//! The structural half always runs (renderer=null, no display needed); the
//! pixel half needs a real window and is opt-in behind
//! `TENSION_OGRE_WINDOW_TEST=1`, the same switch `run.sh` uses.
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
    let path = std::env::var("TENSION_OGRE_SKINNING_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-skinning.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_skinning: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
         skipping the acid test",
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
    eprintln!("ogre_skinning: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_skinning: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the windowed tier \
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

/// The structural tier: mesh, rig, submissions, an accepted batch, two refused
/// batches, and the frame counter — the six clauses that need no pixels.
/// RenderSystem_NULL has no framebuffer, so the guest states that itself rather
/// than pretending.
#[test]
fn test_ogre_skinning_structural() {
    if fixture().is_none() || adapter().is_none() {
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
        stdout.contains("ACID 6/6 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}

/// The visual tier: the deformation. The clause that matters is the flip — a
/// fifth of the frame's silhouette changed state in *both* directions, at a
/// bone no motion channel ever touched. Printed either way, so a failure says
/// what the frames held.
#[test]
fn test_ogre_skinning_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            line.starts_with("baseline: ")
                || line.starts_with("final: ")
                || line.starts_with("report: flip")
        })
        .collect();
    assert!(
        output.status.success(),
        "the visual acid test failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 10/10 passed"),
        "the guest did not pass its ten clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_skinning: {}", measured.join("\n               "));
}
