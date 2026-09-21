//! The angular acid test, from cargo (chunk 8, round 8c2).
//!
//! Sixteen bodies under the angular model — fourteen in a pile, one rolling at
//! a metre per second, one spinning — for 120 rendered frames, then asked the
//! questions a linear model cannot answer: do the orientations stay unit
//! quaternions, does the pile settle and sleep, does the sliding sphere reach
//! the closed form's 5/7 while turning, and does a spinning body keep turning
//! instead of being slept by a signal that only watches translation.
//!
//! Two of the fixture's clauses are a *finding* rather than a check: a sphere
//! that reaches rolling has no slip left for friction, and a sphere spinning
//! about the vertical axis has none below its centre either — so neither stops,
//! and the fixture asserts the shape of that motion (clauses 2 and 7) rather
//! than pretending they sleep. See the fixture's header and DESIGN.md §12.
//!
//! The structural half always runs (renderer=null, no display needed); the pixel
//! half needs a window and is opt-in behind `TENSION_OGRE_WINDOW_TEST=1`, the
//! same switch `run.sh` uses.
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
    let path = std::env::var("TENSION_OGRE_ANGULAR_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-angular.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_angular: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
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
    eprintln!("ogre_angular: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_angular: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the pixel tier \
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

/// The structural tier: the pile sleeps, the orientations stay unit, the pile's
/// angular momentum goes to zero, the rolling sphere reaches the closed form,
/// and the spinning body turns without wandering — while the two bodies the
/// model cannot stop are still moving exactly as it says they must.
#[test]
fn test_ogre_angular_structural() {
    if fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("null");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            line.starts_with("2 ok:")
                || line.starts_with("5 ok:")
                || line.starts_with("6 ok:")
                || line.starts_with("7 ok:")
        })
        .collect();
    assert!(
        output.status.success(),
        "the structural angular clauses failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 7/7 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
    println!("ogre_angular: {}", measured.join("\n              "));
}

/// The pixel tier: the spheres are drawn where the state says, nothing is under
/// the floor, and the frame is busy while the bodies move and still once the
/// pile has slept.
#[test]
fn test_ogre_angular_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            line.starts_with("8 ok:") || line.starts_with("9 ok:") || line.starts_with("10 ok:")
        })
        .collect();
    assert!(
        output.status.success(),
        "the angular pixel clauses failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 10/10 passed"),
        "the guest did not pass its ten clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_angular: {}", measured.join("\n              "));
}
