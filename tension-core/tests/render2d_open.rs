//! Does the in-core 2D renderer open and close a canvas, and does it enforce
//! "one renderer holds the swapchain"?
//!
//! # What this probe asserts
//!
//! * the **arbitration** — a second claim on a held swapchain is refused with
//!   `-EBUSY` and a message that names the holder. Pure logic, no GPU, so it
//!   runs everywhere;
//! * `open(OFFSCREEN)` makes a device and **no window** — the headless path, and
//!   the reason a CI run never opens a window;
//! * `open(WINDOWED)` **creates the host window on demand**, at the size the
//!   renderer declared, and claims it for the device;
//! * `close` releases the claim and leaves the window standing (Pass A's
//!   deliberate half-lifecycle);
//! * a second `open` while one is open is refused;
//! * a reopen after `close` works, reusing the window.
//!
//! # Why `harness = false`
//!
//! `platform_surface` and `platform_window`'s reason, restated because it is the
//! one that bites: `sdl3::init()` lets the **first** calling thread claim
//! main-thread status and refuses every later one. A normal `#[test]` runs on a
//! spawned thread, so a two-test file fails on the second. `harness = false`
//! gives one `fn main()` on the real main thread.
//!
//! # What a skip means
//!
//! A machine with no usable GPU, or with no display for a window, cannot run the
//! second half. That is environmental, and this probe says so and exits 0 — but
//! **only** for a refusal that names the device or the window. Every other
//! failure exits 1, so a skip cannot hide a broken claim, a broken guard or a
//! canvas that did not close.
//!
//! `TENSION_SKIP_GPU_TESTS=1` skips the GPU half explicitly, for a rig known to
//! have neither (the WSL2/Mesa `dzn` case, where pipeline creation fails with
//! `VK_ERROR_OUT_OF_HOST_MEMORY` — the same failure the untouched C++ oracle
//! reproduces, so it is the environment, not this code).
//!
//! Run: `cargo test --test render2d_open --features render2d-core`.

use tension_core::platform::HostWindow;
use tension_core::render2d::{Render2dError, Render2dState, RendererId};

/// Collected failures, so one run reports every problem rather than the first.
struct Probe {
    failures: Vec<String>,
}

impl Probe {
    fn new() -> Self {
        Probe {
            failures: Vec::new(),
        }
    }

    fn check(&mut self, what: &str, condition: bool) {
        if condition {
            println!("  ok   {what}");
        } else {
            println!("  FAIL {what}");
            self.failures.push(what.to_string());
        }
    }

    fn equal<T: PartialEq + std::fmt::Debug>(&mut self, what: &str, got: T, want: T) {
        if got == want {
            println!("  ok   {what}");
        } else {
            println!("  FAIL {what}: got {got:?}, want {want:?}");
            self.failures.push(what.to_string());
        }
    }
}

fn main() {
    let mut probe = Probe::new();

    // ── the arbitration: no GPU, no window, pure state ──────────────────────
    println!("arbitration");
    {
        let mut state = Render2dState::default();

        probe.check("nothing is claimed at construction", state.owner().is_none());
        probe.check(
            "2D can claim an unclaimed swapchain",
            state.claim_swapchain(RendererId::Render2d).is_ok(),
        );
        probe.equal("2D holds it", state.owner(), Some(RendererId::Render2d));

        match state.claim_swapchain(RendererId::RenderOgre) {
            Ok(()) => {
                println!("  FAIL Ogre was allowed to claim a held swapchain");
                probe.failures.push("second claim refused".to_string());
            }
            Err(Render2dError::Busy(message)) => {
                println!("  ok   Ogre is refused: {message}");
                probe.check("the refusal names the holder", message.contains("held by 2D"));
            }
            Err(other) => {
                println!("  FAIL refused with the wrong kind: {other:?}");
                probe.failures.push("refusal kind".to_string());
            }
        }
        probe.equal(
            "the refusal did not disturb the holder",
            state.owner(),
            Some(RendererId::Render2d),
        );

        // Releasing something you do not hold is a no-op, not an error.
        state.release_swapchain(RendererId::RenderOgre);
        probe.equal(
            "a non-holder's release changes nothing",
            state.owner(),
            Some(RendererId::Render2d),
        );

        state.release_swapchain(RendererId::Render2d);
        probe.check("2D's release clears the claim", state.owner().is_none());
        probe.check(
            "Ogre can claim once it is free",
            state.claim_swapchain(RendererId::RenderOgre).is_ok(),
        );
        state.release_swapchain(RendererId::RenderOgre);
    }

    // ── argument validation: also no GPU (it refuses before creating) ───────
    println!("validation");
    {
        let mut state = Render2dState::default();
        let mut window: Option<HostWindow> = None;
        let zero = state.open_offscreen(0, 180);
        probe.equal("a zero-width canvas is EINVAL", zero.err().map(|e| e.errno()), Some(-22));
        probe.check("and it created nothing", state.canvas().is_none() && !state.has_device());
        probe.check(
            "the swapchain is still unclaimed",
            state.owner().is_none(),
        );
        let windowed_zero = state.open_windowed(&mut window, 320, 0);
        probe.equal(
            "a zero-height windowed canvas is EINVAL",
            windowed_zero.err().map(|e| e.errno()),
            Some(-22),
        );
        probe.check(
            "and it created no window",
            window.is_none(),
        );
    }

    // ── the GPU half ───────────────────────────────────────────────────────
    if std::env::var("TENSION_SKIP_GPU_TESTS").is_ok() {
        println!("gpu: skipped by TENSION_SKIP_GPU_TESTS (would run on a machine with a GPU)");
        finish(&probe);
        return;
    }

    let mut state = Render2dState::default();
    let mut window: Option<HostWindow> = None;

    println!("offscreen open");
    match state.open_offscreen(320, 180) {
        Ok(handle) => {
            probe.equal("open returns handle 1", handle, 1);
            probe.check("a device is up", state.has_device());
            let canvas = state.canvas();
            probe.equal("the canvas is 320x180", canvas.map(|c| (c.width, c.height)), Some((320, 180)));
            probe.check("the canvas is offscreen", canvas.map(|c| c.windowed) == Some(false));
            probe.check("no window exists", window.is_none());
            probe.check("no swapchain claim", state.owner().is_none());

            println!("second open while one is open");
            let again = state.open_offscreen(320, 180);
            probe.equal(
                "a second canvas is EBUSY",
                again.err().map(|e| e.errno()),
                Some(-16),
            );

            println!("close");
            probe.equal("close answers 0", state.close(1).unwrap_or(-1), 0);
            probe.check("the canvas is gone", state.canvas().is_none());
            probe.check("the device is gone", !state.has_device());
            probe.equal(
                "close with nothing open is EINVAL",
                state.close(1).err().map(|e| e.errno()),
                Some(-22),
            );
        }
        Err(error) => {
            skip_or_fail(&mut probe, "offscreen open", &error);
            if !probe.failures.is_empty() {
                finish(&probe);
                return;
            }
            // No GPU: the windowed half cannot run either.
            finish(&probe);
            return;
        }
    }

    println!("windowed open creates the window on demand");
    match state.open_windowed(&mut window, 320, 180) {
        Ok(handle) => {
            probe.equal("open returns handle 1", handle, 1);
            probe.check("a window was created", window.is_some());
            probe.equal(
                "at the size the renderer declared",
                window.as_ref().map(|w| w.published_size()),
                Some((320, 180)),
            );
            probe.equal("2D holds the swapchain", state.owner(), Some(RendererId::Render2d));
            probe.check(
                "the canvas is windowed",
                state.canvas().map(|c| c.windowed) == Some(true),
            );

            println!("a second windowed open");
            let mut other_window: Option<HostWindow> = None;
            let again = state.open_windowed(&mut other_window, 320, 180);
            probe.equal(
                "a second canvas is EBUSY",
                again.err().map(|e| e.errno()),
                Some(-16),
            );
            probe.check(
                "and it created no second window",
                other_window.is_none(),
            );

            println!("close releases the claim and keeps the window");
            probe.equal("close answers 0", state.close(1).unwrap_or(-1), 0);
            probe.check("the swapchain is free", state.owner().is_none());
            probe.check("the device is gone", !state.has_device());
            probe.check(
                "the window is still standing (Pass A's half-lifecycle)",
                window.is_some(),
            );

            println!("reopen reuses the window");
            match state.open_windowed(&mut window, 320, 180) {
                Ok(handle) => {
                    probe.equal("reopen returns handle 1", handle, 1);
                    probe.equal(
                        "and claims again",
                        state.owner(),
                        Some(RendererId::Render2d),
                    );
                    probe.equal("closing it answers 0", state.close(1).unwrap_or(-1), 0);
                    probe.check("and releases again", state.owner().is_none());
                }
                Err(error) => {
                    println!("  FAIL reopen refused: {error}");
                    probe.failures.push("reopen".to_string());
                }
            }
        }
        Err(error) => skip_or_fail(&mut probe, "windowed open", &error),
    }

    finish(&probe);
}

/// A refusal that names the device or the window is environmental; anything
/// else is a bug.
fn skip_or_fail(probe: &mut Probe, what: &str, error: &Render2dError) {
    match error {
        Render2dError::NoDevice(message) => {
            println!("gpu: SKIP {what} — no usable device or display here: {message}");
            println!("gpu: this would run on a machine with a GPU; nothing above failed");
        }
        other => {
            println!("  FAIL {what}: {other}");
            probe.failures.push(what.to_string());
        }
    }
}

fn finish(probe: &Probe) -> () {
    if probe.failures.is_empty() {
        println!("\nrender2d_open: PASS");
    } else {
        println!("\nrender2d_open: FAIL ({} check(s))", probe.failures.len());
        for failure in &probe.failures {
            println!("  - {failure}");
        }
        std::process::exit(1);
    }
}
