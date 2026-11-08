//! Does the pump actually deliver window events?
//!
//! `platform_surface` proves a surface can be created. It says nothing about
//! whether the host notices the user resizing or closing the window, which is
//! the other half of "the host owns the window": owning it means servicing it.
//!
//! # What this tests, and what it deliberately does not
//!
//! It tests the **pump**, not the process. `main.rs` wires the pump into
//! `host_loop`; asserting `host_loop` from here would mean starting an
//! interpreter, loading a guest and waiting on a scheduler — a lot of machinery
//! between the assertion and the thing under test. So this drives
//! `HostWindow::pump()` directly, which is the same call the loop makes.
//!
//! The resize is produced with `SDL_SetWindowSize`, which is the only way to
//! make a window system emit a resize without a human. That is legal here
//! because this thread is the one that initialised SDL — the same rule that
//! makes the pump main-thread-only.
//!
//! # Why `harness = false`
//!
//! Same reason as `platform_surface`: `sdl3::init()` lets the first calling
//! thread claim main-thread status and refuses every later one. A normal
//! `#[test]` runs on a spawned thread and would pass exactly once.
//!
//! # Is a resize event guaranteed?
//!
//! Measured on this rig, SDL coalesces back-to-back resizes and delivers one
//! event carrying the final size. So the probe sets one size, pumps until the
//! published size changes or a bounded number of pumps elapse, and then asserts.
//! It does **not** assume the event arrives on the first pump: on Wayland a
//! resize is a round trip through the compositor.

use std::time::{Duration, Instant};

use tension_core::platform::HostWindow;

/// How long to keep pumping for the compositor to answer.
///
/// Generous: a resize on Wayland is a round trip, and CI runs under Xvfb on
/// lavapipe. The probe fails on the *assertion*, not on the clock, so a slow
/// machine takes longer and still passes.
const RESIZE_TIMEOUT: Duration = Duration::from_secs(5);

fn pump_until_resized(window: &mut HostWindow) -> Result<(u32, u32), String> {
    let deadline = Instant::now() + RESIZE_TIMEOUT;
    while Instant::now() < deadline {
        let events = window.pump();
        if let Some(size) = events.resized {
            return Ok(size);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Err(format!(
        "no resize event within {:?} (published size is {:?})",
        RESIZE_TIMEOUT,
        window.published_size()
    ))
}

fn run() -> Result<(), String> {
    let mut window =
        HostWindow::new("tension-window-probe", 320, 240).map_err(|e| format!("new: {e}"))?;

    println!("driver: {}", window.driver());
    let (start_width, start_height) = window.published_size();
    println!("published at start: {start_width}x{start_height}");
    if (start_width, start_height) != (320, 240) {
        return Err(format!(
            "published size at start is {start_width}x{start_height}, not 320x240"
        ));
    }

    // Drain whatever the window emitted while opening. A compositor may send an
    // initial configure/resize, and consuming it here is what makes the next
    // resize unambiguous rather than "an event arrived, possibly a stale one".
    let drained = window.pump().drained;
    println!("drained {drained} startup event(s)");

    // The resize. `set_size` takes pixels, and the pump reads the drawable size.
    println!("requesting 640x480");
    window
        .set_size(640, 480)
        .map_err(|e| format!("set_size: {e}"))?;

    let (width, height) = pump_until_resized(&mut window)?;
    println!("resize event: {width}x{height}");
    if (width, height) != (640, 480) {
        return Err(format!(
            "resize reported {width}x{height}; the request was 640x480"
        ));
    }

    // The published size is what a renderer reads, and it must have moved with
    // the event rather than only the event's payload moving.
    let (published_width, published_height) = window.published_size();
    if (published_width, published_height) != (640, 480) {
        return Err(format!(
            "published size is {published_width}x{published_height} after the resize event"
        ));
    }
    println!("published after resize: {published_width}x{published_height}");

    // And `published()` — the reader a renderer gets — must agree with
    // `published_size()`, or two consumers of one number would disagree.
    if let Some(surface) = window.published() {
        if (surface.width, surface.height) != (640, 480) {
            return Err(format!(
                "published() reports {}x{} while published_size() reports {}x{}",
                surface.width, surface.height, published_width, published_height
            ));
        }
    }

    drop(window);
    println!("PASS: pump delivered a resize and updated the published size");
    Ok(())
}

fn main() {
    match run() {
        Ok(()) => std::process::exit(0),
        Err(message) => {
            eprintln!("FAIL: {message}");
            std::process::exit(1);
        }
    }
}
