//! The chunk-4 acid test, from cargo (round 4b).
//!
//! One guest, one solver, one batch per frame: a solver steps once per renderer
//! frame and drives N bodies through **one** `submit_motion` call per frame.
//! The structural half always runs (renderer=null, no display needed); the
//! pixel half and the throughput report need a real window and are opt-in
//! behind `TENSION_OGRE_WINDOW_TEST=1`, the same switch `run.sh` uses.
//!
//! All three skip with a printed reason when the fixture or the shared object
//! has not been built.

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
    let path = std::env::var("TENSION_OGRE_MOTION_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-motion.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_motion: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
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
    eprintln!("ogre_motion: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_motion: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the windowed tier \
         (it opens a real window)"
    );
    false
}

fn run(renderer: &str, bodies: &str) -> std::process::Output {
    let (Some(fixture), Some(adapter), Some(volume)) = (fixture(), adapter(), volume()) else {
        panic!("the fixture, the adapter and the fixture volume must all be built to run this test");
    };
    Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(&adapter)
        .arg(&fixture)
        .arg(format!("--renderer={renderer}"))
        .arg(format!("--tns={}", volume.display()))
        .arg(format!("--bodies={bodies}"))
        .output()
        .expect("the interpreter runs")
}

/// The structural tier: the five clauses that need no pixels. RenderSystem_NULL
/// has no framebuffer, so the guest states that itself rather than pretending.
#[test]
fn test_ogre_motion_structural() {
    if fixture().is_none() || adapter().is_none() || volume().is_none() {
        return;
    }
    let output = run("null", "1");
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

/// The visual tier: pixels. The assertion that matters is that the centroid
/// moved by what the solver said it moved, within the band the probe's
/// calibration allows — printed either way, so a failure says what the frame
/// held.
#[test]
fn test_ogre_motion_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() || volume().is_none() {
        return;
    }
    let output = run("gl3plus", "1");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            line.starts_with("baseline: ")
                || line.starts_with("final: ")
                || line.starts_with("report: delta")
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
    println!("ogre_motion: {}", measured.join("\n           "));
}

/// The throughput tier: the same assertions carrying 64 entries per frame, with
/// the batch's own numbers reported. The frame-rate clause is a tripwire, not a
/// proof — at 1024 bodies the probe measured a 12 µs transform pass, so this
/// cannot fail for cost reasons without something being badly wrong.
#[test]
fn test_ogre_motion_throughput() {
    if !windowed() || fixture().is_none() || adapter().is_none() || volume().is_none() {
        return;
    }
    let output = run("gl3plus", "64");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let reported: Vec<&str> = stdout
        .lines()
        .filter(|line| line.starts_with("report: ") || line.starts_with("final: "))
        .collect();
    assert!(
        output.status.success(),
        "the throughput run failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        reported.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 10/10 passed"),
        "the guest did not pass at N=64\n{}\nstdout: {stdout}\nstderr: {stderr}",
        reported.join("\n")
    );
    assert!(
        stdout.contains("entries/frame 64"),
        "the batch did not carry 64 entries per frame\n{}",
        reported.join("\n")
    );
    println!("ogre_motion: {}", reported.join("\n           "));
}
