//! The render tripwire, from cargo (post-chunk-5 audit).
//!
//! One control mesh (`cube.mesh`, a plain unrigged 100-unit box), one distinct
//! colour per material kind, and a pixel assertion per kind. This is the
//! question chunk 5b's failure could not be asked from the skinning test — a
//! material that draws nothing and a rig that does not move produce the same
//! picture — and it exists so that a future hand-written list cannot omit a
//! path in silence again.
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
    let path = std::env::var("TENSION_OGRE_RENDER_CHECK_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-render-check.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_render_check: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
         skipping the tripwire",
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
    eprintln!("ogre_render_check: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_render_check: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the windowed tier \
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

/// The structural tier: the control mesh loads, the camera and one renderable
/// per material kind are submitted. No pixels — RenderSystem_NULL has no
/// framebuffer, and the guest says so itself rather than pretending.
#[test]
fn test_ogre_render_check_structural() {
    if fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("null");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the structural tripwire failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 4/4 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}

/// The pixel tier: both material kinds drew, in the colours they were given.
/// The mean colour of each half is printed either way, so a failure says what
/// was on the screen rather than only that something was wrong.
#[test]
fn test_ogre_render_check_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| line.starts_with("unlit: ") || line.starts_with("pbs: "))
        .collect();
    assert!(
        output.status.success(),
        "the pixel tripwire failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 6/6 passed"),
        "the guest did not pass its six clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_render_check: {}", measured.join("\n                   "));
}
