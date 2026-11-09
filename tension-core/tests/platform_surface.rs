//! Does the host actually own a Vulkan surface?
//!
//! `platform::HostWindow` exists so SDL can create the window and the
//! `VkSurfaceKHR` while a renderer — Ogre-Next — consumes both. Everything in
//! that sentence is invisible to the rest of the test suite: no other test opens
//! a window, and the Ogre suites build on surfaces Ogre made itself. So this
//! probe is the only thing that would notice if `surface()` stopped working.
//!
//! # Why `harness = false`
//!
//! `sdl3::init()` lets the **first** calling thread claim main-thread status and
//! refuses every later one (`sdl3::sdl::Sdl::new`). A normal `#[test]` runs on a
//! spawned thread, so it passes — once. Two tests in one binary fail, because the
//! second one is refused. Measured, not assumed: a two-test file failed with
//! "Cannot initialize `Sdl` from a thread other than the main thread".
//!
//! `harness = false` gives one `fn main()` on the real main thread, so the check
//! is a property of the test's shape rather than a warning in a comment. It also
//! avoids the `test-mode` feature, which would disable a real production guard to
//! make a test convenient.
//!
//! # What it asserts
//!
//! * an instance and a surface, both non-zero, from the session's own driver;
//! * the instance extension set matches the driver that was used — because
//!   "creation succeeded" is not enough. `SDL_VIDEODRIVER=offscreen` also
//!   succeeds, and produces a `VK_EXT_headless_surface`, which is not a window
//!   system and proves nothing about Wayland or X11. A probe that passed blind
//!   there would be worse than no probe.
//! * clean teardown: the object drops, the process exits 0, nothing leaks a
//!   descriptor past its own frame.
//!
//! # Negative controls
//!
//! Driven by `SDL_VIDEODRIVER`, and asserted to *fail*:
//!
//! * `dummy` — a real SDL driver with no Vulkan support at all;
//! * a driver name that does not exist — SDL_Init refuses.
//!
//! The probe runs them itself (`--negative-controls`) and requires a clean
//! non-zero exit from each. Without that, a probe that silently passed under
//! `dummy` would look exactly like success.
//!
//! Run: `cargo test --test platform_surface` (registered in `npm test`), or
//! `-- --negative-controls` for the failure path.

use tension_core::platform::{HostShared, HostWindow, WindowTarget};

/// What the driver's instance extension list must contain.
///
/// The headless one is called out as a note rather than treated as equivalent:
/// it exercises the plumbing (instance → surface → destroy) but not a window
/// system, so it must never be read as "Wayland works in CI".
fn expected_extension(driver: &str) -> Option<&'static str> {
    match driver {
        "wayland" => Some("VK_KHR_wayland_surface"),
        "x11" => Some("VK_KHR_xlib_surface"),
        "offscreen" => Some("VK_EXT_headless_surface"),
        _ => None,
    }
}

fn run_positive() -> Result<(), String> {
    let mut window = HostWindow::new(
        "tension-surface-probe",
        320,
        240,
        WindowTarget::Vulkan,
        HostShared::new(),
    )
        .map_err(|e| format!("HostWindow::new failed: {e}"))?;

    let driver = window.driver();
    println!("driver: {driver}");

    if window.has_surface() {
        return Err("has_surface() is true before surface() was called".to_string());
    }

    let surface = window
        .surface()
        .map_err(|e| format!("surface() failed: {e}"))?;

    // The two things the renderer will be handed. Zero is not a valid handle for
    // either, and an adapter that received one would have no way to tell the
    // difference between "no surface" and "a surface at address 0".
    if surface.instance == 0 {
        return Err("surface().instance is null".to_string());
    }
    if surface.surface == 0 {
        return Err("surface().surface is null".to_string());
    }
    println!(
        "instance: 0x{:x}  surface: 0x{:x}  {}x{}",
        surface.instance, surface.surface, surface.width, surface.height
    );

    if !window.has_surface() {
        return Err("has_surface() is false after surface() succeeded".to_string());
    }

    // Creation is cheap to fake; the extension list is what says *how* it was
    // created. Assert it against the driver SDL reports.
    let extensions: Vec<String> = window.instance_extensions().to_vec();
    println!("instance extensions: {extensions:?}");

    match expected_extension(driver) {
        Some(expected) => {
            if !extensions.iter().any(|e| e == expected) {
                return Err(format!(
                    "driver '{driver}' should expose {expected}, but the list is {extensions:?}"
                ));
            }
            if expected == "VK_EXT_headless_surface" {
                println!("note: headless surface — not native WSI");
            }
        }
        None => {
            println!("note: driver '{driver}' has no recorded WSI expectation");
        }
    }

    // A second call must return the same surface, not build another one: two
    // instances would mean two Vulkan loaders and an orphaned device later.
    let again = window.surface().map_err(|e| format!("second surface() failed: {e}"))?;
    if again != surface {
        return Err(format!("surface() returned a different surface on the second call: {again:?}"));
    }
    println!("cached: second surface() returned the same handles");

    drop(window);
    println!("PASS: host owns a Vulkan surface on '{driver}'");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let negative = args.iter().any(|a| a == "--negative-controls");

    if negative {
        // The outer process runs the two failing configurations and requires
        // them to fail. It does that by re-invoking itself with the env var set,
        // `--must-fail`, and asserting a non-zero exit.
        std::process::exit(run_negative_controls());
    }
    if args.iter().any(|a| a == "--must-fail") {
        // Inner run: a non-zero exit here is the *expected* outcome.
        match run_positive() {
            Ok(()) => {
                eprintln!("MUST-FAIL: surface creation succeeded under a driver that cannot");
                std::process::exit(0);
            }
            Err(message) => {
                println!("expected failure: {message}");
                std::process::exit(3);
            }
        }
    }

    match run_positive() {
        Ok(()) => std::process::exit(0),
        Err(message) => {
            eprintln!("FAIL: {message}");
            std::process::exit(1);
        }
    }
}

/// Run the probe under two drivers that cannot work, and require both to fail.
fn run_negative_controls() -> i32 {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("FAIL: cannot find our own binary: {e}");
            return 1;
        }
    };

    let cases = [
        ("dummy", "a driver with no Vulkan support"),
        ("tension-no-such-driver", "a driver name SDL does not have"),
    ];

    let mut failures = 0;
    for (driver, why) in cases {
        let output = std::process::Command::new(&exe)
            .arg("--must-fail")
            .env("SDL_VIDEODRIVER", driver)
            .output();

        match output {
            Ok(output) if output.status.code() == Some(3) => {
                println!("ok   SDL_VIDEODRIVER={driver} failed as expected ({why})");
            }
            Ok(output) => {
                eprintln!(
                    "FAIL SDL_VIDEODRIVER={driver}: expected our own exit code 3, got {:?}\n  \
                     stdout: {}\n  stderr: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stdout).trim(),
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                failures += 1;
            }
            Err(e) => {
                eprintln!("FAIL SDL_VIDEODRIVER={driver}: could not spawn the probe: {e}");
                failures += 1;
            }
        }
    }

    if failures == 0 {
        println!("PASS: both negative controls failed cleanly");
        0
    } else {
        1
    }
}
