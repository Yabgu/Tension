//! The OGRE adapter's end-to-end tests (chunk 2, round 2b — the hello-window
//! milestone).
//!
//! Each test spawns the real interpreter with the real adapter and the real
//! guest fixture: nothing here is a mock, and the two render systems are the
//! ones the machine has. They skip, with a printed reason, when the fixture or
//! the shared object has not been built — `cargo test` must not require asc or
//! OGRE-Next to be installed.
//!
//! Build both with `tension-ogre/tests/run.sh`, which is also the gate that
//! exercises the manual window case.
//!
//! What each test is for:
//!
//!   headless       RenderSystem_NULL: a window object, a frame loop, an event
//!                  from the render thread, a status record the guest reads —
//!                  with no display at all. The headless gate.
//!   no display     GL3+ with DISPLAY unset: OGRE throws on the X connection
//!                  and the adapter catches it. Before the catch this aborted
//!                  the process (exit 134, measured).
//!   vulkan         A renderer this build's plugins cannot provide: refused by
//!                  name with -ENOSYS rather than pretended.
//!   shutdown-only  ogre::shutdown before any init: 0, not an error.

#[path = "support/ci.rs"]
mod support_ci;

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
    if let Ok(explicit) = std::env::var("TENSION_OGRE_FIXTURE_PATH") {
        return Some(PathBuf::from(explicit));
    }
    let path = built("guest-window.wasm");
    if path.exists() {
        return Some(path);
    }
    support_ci::skip_or_fail(format_args!(
        "ogre_window: {} is not built — run `tension-ogre/tests/run.sh` (it needs asc); \
         skipping the window tests",
        path.display()
    ));
    None
}

fn adapter() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("TENSION_OGRE_DSO_PATH") {
        return Some(PathBuf::from(explicit));
    }
    let path = built("libtension_ogre.so");
    if path.exists() {
        return Some(path);
    }
    support_ci::skip_or_fail(format_args!(
        "ogre_window: {} is not built — run `tension-ogre/build.sh`; skipping the window tests",
        path.display()
    ));
    None
}

struct Run {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

fn run(fixture: &Path, adapter: &Path, args: &[&str], clear_display: bool) -> Run {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tension-core"));
    command.arg("--capability").arg(adapter).arg(fixture).args(args);
    if clear_display {
        // GL3+ on this install goes through GLX: no display is no X
        // connection, which is the failure this test is about.
        command.env_remove("DISPLAY").env_remove("WAYLAND_DISPLAY");
    }
    let output = command.output().expect("the interpreter runs");
    Run {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code(),
    }
}

#[test]
fn test_ogre_null_window_headless() {
    let (Some(fixture), Some(adapter)) = (fixture(), adapter()) else { return };
    let run = run(&fixture, &adapter, &["--renderer=null", "--frames=3"], false);

    assert_eq!(run.code, Some(0), "stdout: {}\nstderr: {}", run.stdout, run.stderr);
    assert!(
        run.stdout.trim_start().starts_with("OK "),
        "the guest reports its own success on the first line of stdout: {}",
        run.stdout
    );
    assert!(
        run.stderr.contains("ogre: window \"Tension\" 1280x720 created (NULL Rendering Subsystem)"),
        "the adapter logged no window: {}",
        run.stderr
    );
}

#[test]
// **What this pins changed with the programmatic window API.** It used to clear
// DISPLAY and expect the GL3+ plugin to throw on the X connection, caught by the
// backend and reported as a plugin-stage `-EIO`. That path is no longer the
// reachable one: a renderer has no window of its own any more, so on a machine
// with no display the *window* is what fails first — before any adapter is
// initialised. The assertion follows the architecture: a display-less run is
// refused once, cleanly, by the call that asked for the window.
//
// X11-only for the same reason as before: on Windows there is no DISPLAY to
// clear and a window opens through WGL, so the scenario does not reproduce and
// the test is skipped with the reason attached rather than deleted or loosened.
#[cfg_attr(windows, ignore = "no DISPLAY on Windows, and a window opens through WGL")]
fn test_ogre_no_display_refuses_the_window() {
    let (Some(fixture), Some(adapter)) = (fixture(), adapter()) else { return };
    let run = run(
        &fixture,
        &adapter,
        &["--renderer=gl3plus", "--create-window", "--expect-no-display"],
        true,
    );

    // The guest handles the refusal and exits cleanly: a non-zero exit here
    // would mean the failure escaped as a panic.
    assert_eq!(run.code, Some(0), "stderr: {}", run.stderr);
    assert!(
        run.stdout.trim_start().starts_with("OK no-window"),
        "expected the window refusal to be reported: {}",
        run.stdout
    );
    assert!(
        run.stderr.contains("No available video device")
            || run.stderr.contains("X display")
            || run.stderr.contains("GLX"),
        "the diagnostic does not name the failure: {}",
        run.stderr
    );
}

#[test]
fn test_ogre_vulkan_refused() {
    let (Some(fixture), Some(adapter)) = (fixture(), adapter()) else { return };

    // Opt-in, because the outcome is decided by the machine's Vulkan stack rather
    // than by this tree. Measured on WSL2 (2026-11-05, software `dzn` driver):
    // the plugin produces the expected refusal and then the process segfaults
    // inside Ogre's VulkanXcbSupport. On a machine with a conformant Vulkan ICD
    // this runs as written. `TENSION_OGRE_VULKAN_TEST=1` asks for it explicitly,
    // the same switch `scripts/test-ogre.mjs` uses.
    if std::env::var("TENSION_OGRE_VULKAN_TEST").as_deref() != Ok("1") {
        eprintln!(
            "test_ogre_vulkan_refused: skipped — set TENSION_OGRE_VULKAN_TEST=1 to \
             exercise the no-display Vulkan refusal (needs a conformant Vulkan ICD)"
        );
        return;
    }

    // No display, and that is what makes the case deterministic: *with* one,
    // Vulkan comes up through the software ICD (lavapipe) and there is no
    // refusal to assert at all. This mirrors `tension-ogre/tests/run.sh`'s
    // `vulkan` case, which pins the same plugin-stage refusal. A build without
    // Vulkan answers -ENOSYS instead, so both refusals are accepted; either
    // way the diagnostic must name the renderer.
    let run = run(&fixture, &adapter, &["--renderer=vulkan", "--expect-fail"], true);

    assert_eq!(run.code, Some(0), "stderr: {}", run.stderr);
    let first = run.stdout.trim_start();
    assert!(
        first.starts_with("FAIL 0 -5") || first.starts_with("FAIL 0 -38"),
        "expected a refusal (-EIO at the plugin stage, or -ENOSYS with no Vulkan): {}",
        run.stdout
    );
    assert!(
        run.stderr.contains("vulkan") || run.stderr.contains("renderer 3"),
        "the refusal does not name the renderer: {}",
        run.stderr
    );
}

#[test]
fn test_ogre_shutdown_before_init() {
    let (Some(fixture), Some(adapter)) = (fixture(), adapter()) else { return };
    let run = run(&fixture, &adapter, &["--shutdown-only"], false);

    assert_eq!(run.code, Some(0), "stderr: {}", run.stderr);
    assert!(
        run.stdout.trim_start().starts_with("OK shutdown-before-init"),
        "stop with nothing running is not a failure: {}",
        run.stdout
    );
}
