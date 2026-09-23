//! The lighting acid test, from cargo (chunk 10, round 10b).
//!
//! One directional light through the guest's `submitLight`, shading a PBS
//! surface whose diffuse and specular are written and whose emissive is zero —
//! the shape chunk 5b's "PBS renders black" workaround avoided — with an
//! emissive-only PBS surface and an Unlit surface in the same frame as
//! regression controls that a light must not touch.
//!
//! The structural half always runs (renderer=null, no display needed): the wire
//! offsets, the meshes, the scene, the light's round trip through the region and
//! its upsert, and thirty frames with the light in the scene and no refusal in
//! the session log. The pixel half needs a window and is opt-in behind
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
    let path = std::env::var("TENSION_OGRE_LIGHT_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| built("guest-light.wasm"));
    if path.exists() {
        return Some(path);
    }
    eprintln!(
        "ogre_light: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
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
    eprintln!("ogre_light: {} is not built — run `tension-ogre/build.sh`; skipping",
              path.display());
    None
}

fn windowed() -> bool {
    if std::env::var("TENSION_OGRE_WINDOW_TEST").as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "ogre_light: TENSION_OGRE_WINDOW_TEST is not 1 — skipping the pixel tier \
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

/// The structural tier: the light is mirrored (kind, colour, intensity,
/// direction) and upserts, the scene is accepted, thirty frames run with the
/// light in the scene, and the adapter refuses nothing on the way —
/// `apply_lights`'s refusals are log lines, so the session log is what says the
/// light was realised rather than dropped.
#[test]
fn test_ogre_light_structural() {
    if fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("null");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| line.starts_with("3 ok:") || line.starts_with("4 ok:"))
        .collect();
    assert!(
        output.status.success(),
        "the structural lighting clauses failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 4/4 passed (structural, renderer=null)"),
        "the guest did not pass its structural clauses\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert!(
        !stderr.contains("refused"),
        "the adapter refused a submission:\n{}",
        stderr.lines().filter(|line| line.contains("refused")).collect::<Vec<_>>().join("\n")
    );
    println!("ogre_light: {}", measured.join("\n            "));
}

/// The pixel tier: the lit surface is lit (its halves and the ten-band profile),
/// the light is what does it (dark without it, lit again with it back), the
/// emissive-only and Unlit surfaces are byte-identical either way, and the
/// skinned path shades too.
#[test]
fn test_ogre_light_pixels() {
    if !windowed() || fixture().is_none() || adapter().is_none() {
        return;
    }
    let output = run("gl3plus");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let measured: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            line.starts_with("5 ok:")
                || line.starts_with("6 ok:")
                || line.starts_with("7 ok:")
                || line.starts_with("8 ok:")
                || line.starts_with("9 ok:")
        })
        .collect();
    assert!(
        output.status.success(),
        "the lighting pixel clauses failed (exit {:?})\n{}\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        measured.join("\n"),
        stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
    );
    assert!(
        stdout.contains("ACID 9/9 passed"),
        "the guest did not pass its nine clauses\n{}\nstdout: {stdout}\nstderr: {stderr}",
        measured.join("\n")
    );
    println!("ogre_light: {}", measured.join("\n            "));
}
