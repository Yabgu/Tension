//! A mesh that never was a file, from cargo (chunk 5.5).
//!
//! `MeshBuilder.triangle` writes nine floats and three indices into the guest's
//! own `BUFFER_POOL`, `ogre::create_mesh` turns them into a resource on the
//! render thread, and the fixture then asks a loaded mesh's questions of it —
//! including, under a real window, that it put pixels on the screen in the
//! material's colour.
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
    let path = std::env::var("TENSION_OGRE_PROCEDURAL_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-procedural.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_procedural: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
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
    eprintln!("ogre_procedural: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_procedural: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the pixel tier \
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

/// The structural tier: the mesh is built out of guest memory (both the
/// non-blocking call and the blocking helper), the resource record reaches
/// READY with no rig, and a renderable that names it is accepted. No pixels —
/// RenderSystem_NULL has no framebuffer.
#[test]
fn test_ogre_procedural_structural() {
    if fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("null");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the structural procedural clauses failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 5/5 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
}

/// The pixel tier: the triangle is on the screen, in the material's colour, and
/// it is a triangle rather than the whole window. The measured line is printed
/// either way, so a failure says what was on the screen.
#[test]
fn test_ogre_procedural_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| line.starts_with("triangle: "))
        .collect();
    assert!(
        output.status.success(),
        "the procedural pixel clause failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 6/6 passed"),
        "the guest did not pass its six clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_procedural: {}", measured.join("\n                "));
}
