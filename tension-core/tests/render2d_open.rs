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
//! `TENSION_TEST_ALLOW_SKIP=1` skips the GPU half explicitly, for a rig known to
//! have neither. That is **the tree's one skip flag** (`tests/support/ci.rs`,
//! the same variable every other suite honours) — there is deliberately no
//! GPU-specific second flag, because two spellings of "may I skip?" is how a
//! tree ends up with a suite that skips under one and fails under the other.
//!
//! Run: `cargo test --test render2d_open --features render2d-core`.

#[path = "support/ci.rs"]
mod support_ci;

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

    fn pass(&mut self, what: &str) {
        println!("  ok   {what}");
    }

    fn fail(&mut self, what: &str) {
        println!("  FAIL {what}");
        self.failures.push(what.to_string());
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

    // ── the `dummy` video driver is refused by name ───────────────────────
    //
    // The one case that runs before any device exists, and the one the C++
    // renderer had (`render.cpp:491-505`): a driver with no GPU backend must be
    // named, because SDL's own failure message reads like "this machine has no
    // GPU". It is set for this check and unset immediately, so the rest of the
    // probe is unaffected.
    if std::env::var("SDL_VIDEODRIVER").as_deref() == Ok("dummy") {
        println!("dummy driver (this process was started with SDL_VIDEODRIVER=dummy)");
        let mut state = Render2dState::default();
        match state.open_offscreen(8, 8) {
            Err(Render2dError::NoDevice(message)) => {
                probe.check(
                    "the refusal names the driver and the one that works",
                    message.contains("dummy") && message.contains("offscreen"),
                );
            }
            Err(other) => probe.fail(&format!("the dummy driver refused with {other:?}")),
            Ok(_) => probe.fail("the dummy driver was allowed to open a canvas"),
        }
        finish(&probe);
        return;
    }

    // ── the GPU half ───────────────────────────────────────────────────────
    if support_ci::skip_allowed() {
        println!("gpu: SKIP — TENSION_TEST_ALLOW_SKIP=1");
        println!("       reason a rig needs it: no GPU (Mesa dzn cannot create graphics");
        println!("       pipelines; the pre-port C++ renderer fails the same way)");
        println!("       what would run: offscreen open, windowed open on demand, the");
        println!("       swapchain claim and its refusal, close and reopen, and every");
        println!("       verb's refusals. Arbitration and validation already ran above —");
        println!("       they need no device.");
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

    // A fresh state: the windowed block above leaves its canvas open, and the
    // verb probe opens its own at a size a clear frame can be checked against.
    verbs(&mut probe);

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

// ---------------------------------------------------------------------------
// the ten verbs
// ---------------------------------------------------------------------------

/// Every verb's contract, called through the renderer rather than through the
/// wasm shims.
///
/// The shims (`main.rs`) only translate — guest memory in, a `Result` out — so
/// what is worth testing is the layer under them: does `submit` refuse a bucket
/// that belongs to another pipeline, does `texture_load` say `-ENOSYS` for a
/// PNG, does an empty `present` produce the clear colour. Each assertion names
/// the errno the C++ path returned for the same input, because a guest that
/// handled `-ENOENT` before the merge must still get `-ENOENT`.
fn verbs(probe: &mut Probe) {
    use tension_core::render2d::error::{EINVAL, ENOENT, ENOSYS};

    println!("verbs");
    let mut state = Render2dState::default();

    match state.open_offscreen(8, 8) {
        Ok(_) => {}
        Err(error) => {
            skip_or_fail(probe, "open for the verb probe", &error);
            return;
        }
    }

    // ── info ──────────────────────────────────────────────────────────────
    match state.info() {
        Ok(info) => {
            probe.equal("info version is 2", info.version, 2);
            probe.equal("info reports the canvas width", info.canvas_width, 8);
            probe.equal("info reports the canvas height", info.canvas_height, 8);
            probe.equal("info reports 4096 records", info.max_records, 4096);
            probe.equal("info reports 8 buckets", info.max_buckets, 8);
            probe.equal("info reports 64 textures", info.max_textures, 64);
            probe.equal("info flags are zero", info.flags, 0);
        }
        Err(error) => {
            println!("  FAIL info: {error}");
            probe.failures.push("info".to_string());
        }
    }

    // ── set_pipeline: the preset id ranges ────────────────────────────────
    probe.equal(
        "preset 0 is ENOENT",
        state.set_preset(0).err().map(|e| e.errno()),
        Some(ENOENT),
    );
    probe.equal(
        "preset 100 is ENOENT",
        state.set_preset(100).err().map(|e| e.errno()),
        Some(ENOENT),
    );
    probe.equal(
        "preset 2 is ENOSYS (a preset this build does not carry)",
        state.set_preset(2).err().map(|e| e.errno()),
        Some(ENOSYS),
    );
    probe.equal(
        "an empty graph blob is EINVAL",
        state.set_pipeline_blob(&[]).err().map(|e| e.errno()),
        Some(EINVAL),
    );

    // ── texture_load ──────────────────────────────────────────────────────
    // A 1x1 RGBA IWI, built here rather than loaded: the point is the decode
    // and the upload, and a fixture file would hide which byte was wrong.
    let mut iwi = vec![0u8; 78];
    iwi[0..4].copy_from_slice(b"IWI1");
    iwi[4..8].copy_from_slice(&1u32.to_le_bytes());
    iwi[8..12].copy_from_slice(&1u32.to_le_bytes());
    iwi[13..15].copy_from_slice(&4u16.to_le_bytes());
    iwi[15..17].copy_from_slice(&32u16.to_le_bytes());
    for component in 0..4u16 {
        let at = 18 + component as usize * 6;
        iwi[at] = component as u8;
        iwi[at + 2..at + 4].copy_from_slice(&(component * 8).to_le_bytes());
        iwi[at + 4..at + 6].copy_from_slice(&8u16.to_le_bytes());
    }
    iwi[66..74].copy_from_slice(&4u64.to_le_bytes());
    iwi[74..78].copy_from_slice(&[10, 20, 30, 255]);

    match state.texture_load(&iwi, 1) {
        Ok(id) => probe.equal("texture_load returns texture 1", id, 1),
        Err(error) => {
            skip_or_fail(probe, "texture_load", &error);
        }
    }
    probe.equal(
        "a second texture takes the next id",
        state.texture_load(&iwi, 1).ok(),
        Some(2),
    );
    // 80 bytes, so the length check passes and the magic check is what
    // decides. The C++ reader checks length first (`texture.cpp:71-74`), and a
    // short buffer is `-EINVAL` there too — refusing a truncated *container*
    // before refusing an unknown *format* is the ordering the DSO had.
    let mut png = vec![0u8; 80];
    png[0..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    probe.equal(
        "a PNG is ENOSYS, not EINVAL",
        state.texture_load(&png, 1).err().map(|e| e.errno()),
        Some(ENOSYS),
    );
    probe.equal(
        "an 8-byte stub is EINVAL (shorter than the container header)",
        state
            .texture_load(b"\x89PNG\r\n\x1a\n", 1)
            .err()
            .map(|e| e.errno()),
        Some(EINVAL),
    );
    probe.equal(
        "a non-RGBA8 target is ENOSYS",
        state.texture_load(&iwi, 4).err().map(|e| e.errno()),
        Some(ENOSYS),
    );

    // ── submit / set_texture: unknown handles ─────────────────────────────
    let record = [0u8; 28];
    probe.equal(
        "submit to an unknown pipe is ENOENT",
        state
            .submit(7, &record, 1, 28, 0)
            .err()
            .map(|e| e.errno()),
        Some(ENOENT),
    );
    probe.equal(
        "set_texture on an unknown pipe is ENOENT",
        state
            .set_texture(7, 0, 1)
            .err()
            .map(|e| e.errno()),
        Some(ENOENT),
    );

    // ── present with nothing staged, then screenshot ──────────────────────
    //
    // This is the one frame the rig can produce without a graphics pipeline:
    // an empty present opens a render pass, clears to black, draws nothing and
    // reads back. If the two backends disagree about the clear colour, the
    // target format or the readback layout, it shows up here — and it is the
    // only assertion in this file that inspects pixels.
    println!("present + screenshot (clear frame)");
    match state.present(&mut None) {
        Ok(0) => {
            probe.pass("present with nothing staged answers 0");
            match state.screenshot() {
                Ok(frame) => {
                    probe.equal("the frame is 8x8x4 bytes", frame.len(), 8 * 8 * 4);
                    // The clear colour is `{0,0,0,1}` in the C++ renderer.
                    let all_black = frame.chunks_exact(4).all(|px| px == [0, 0, 0, 255]);
                    probe.check("every pixel is the clear colour (0,0,0,255)", all_black);
                    if !all_black {
                        if let Some(first) = frame.chunks_exact(4).position(|px| px != [0, 0, 0, 255])
                        {
                            println!(
                                "       first differing pixel {first} is {:?}",
                                &frame[first * 4..first * 4 + 4]
                            );
                        }
                    }
                }
                Err(error) => skip_or_fail(probe, "screenshot", &error),
            }
        }
        Ok(other) => probe.fail(&format!("present answered {other}, not 0")),
        Err(error) => skip_or_fail(probe, "present", &error),
    }

    // ── close ─────────────────────────────────────────────────────────────
    probe.equal("close answers 0", state.close(1).unwrap_or(-1), 0);
    probe.equal(
        "info after close is ENODEV",
        state.info().err().map(|e| e.errno()),
        Some(-19),
    );
    probe.equal(
        "screenshot after close is ENODEV",
        state.screenshot().err().map(|e| e.errno()),
        Some(-19),
    );
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
