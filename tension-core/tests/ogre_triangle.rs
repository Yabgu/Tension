//! The 3b acid test, from cargo (chunk 3, round 3b-ii).
//!
//! One guest, one scene: a mesh, an Unlit material, a camera, a renderable —
//! and, under a renderer that has a framebuffer, the pixels they produce. The
//! structural half always runs (renderer=null, no display needed); the pixel
//! half needs a real window and is opt-in behind `TENSION_OGRE_WINDOW_TEST=1`,
//! the same switch `tension-ogre/tests/run.sh` uses.
//!
//! Both skip with a printed reason when the fixture or the shared object has
//! not been built.

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
    let path = std::env::var("TENSION_OGRE_TRIANGLE_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-triangle.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_triangle: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
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
    eprintln!("ogre_triangle: {} is not built — run `tension-ogre/build.sh`; skipping",
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

/// The structural tier: the five clauses that need no pixels. RenderSystem_NULL
/// has no framebuffer, so the guest states that itself rather than pretending.
#[test]
fn test_ogre_triangle_structural() {
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

/// The visual tier: the same fixture under GL3+, where the pixels are. Opt-in
/// because it opens a real window, and it prints the measured statistics
/// (corner colour, non-background count, mean colour) so a failure says what
/// the frame actually held.
#[test]
fn test_ogre_triangle_pixels() {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() != Ok("1") {
        eprintln!(
            "ogre_triangle: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the visual tier \
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
    let pixels = stdout
        .lines()
        .find(|line| line.starts_with("pixels: "))
        .unwrap_or("pixels: (none reported)");
    assert!(
        output.status.success(),
        "the visual acid test failed (exit {:?})\n{pixels}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 8/8 passed"),
        "the guest did not pass its eight clauses\n{pixels}\nstdout: {stdout}\nstderr: {stderr}"
    );
    println!("ogre_triangle: {pixels}");
}
