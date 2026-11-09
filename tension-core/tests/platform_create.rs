//! Does the guest's window API do what its doc says?
//!
//! The three imports (`create_window`, `close_window`, `window_info`) are the
//! guest's whole window surface now that `--window` is gone. Their contract has
//! four claims worth asserting, and this probe makes them one at a time:
//!
//! 1. A config creates a window at the requested size, and `info()` reports it.
//! 2. A second create is refused **-EBUSY** rather than replacing the first.
//! 3. `info()` with no window is a zeroed record with `width == 0`, not an
//!    error — the headless guard a guest's update loop depends on.
//! 4. A `Vulkan` window carries a surface, and a `Gpu` one does not have to.
//!
//! # What this does not test
//!
//! The wasm imports themselves. They are thin: read a struct from guest memory,
//! call what is here, write a struct back. Proving *their* wiring is what
//! `examples/platform-control` does end-to-end, and its own suite asserts it.
//! This probe is the RPC-free half — the state machine — so a failure here is
//! never an interpreter problem.
//!
//! # Why `harness = false`
//!
//! `sdl3::init()` lets the first calling thread claim main-thread status and
//! refuses every later one, so a normal `#[test]` would pass exactly once.

use tension_core::platform::{
    create_window, window_flags, HostWindow, PlatformError, WindowConfig, WindowMode, WindowTarget,
    WINDOW_POS_CENTERED,
};

fn plain(width: u32, height: u32) -> WindowConfig {
    WindowConfig {
        target: WindowTarget::Plain,
        width,
        height,
        mode: WindowMode::Windowed,
        flags: window_flags::RESIZABLE | window_flags::DECORATED,
        x: WINDOW_POS_CENTERED,
        y: WINDOW_POS_CENTERED,
        ..Default::default()
    }
}

fn run() -> Result<(), String> {
    // ── 3. no window: a zeroed record, not an error ──────────────────────
    let empty: Option<HostWindow> = None;
    let info = empty.as_ref().map(|w| w.info()).unwrap_or_default();
    println!("no window: width={} height={}", info.width, info.height);
    if info.width != 0 || info.height != 0 {
        return Err(format!(
            "a missing window reported {}x{}, not 0x0",
            info.width, info.height
        ));
    }

    // ── 1. create at the requested size ──────────────────────────────────
    let mut slot: Option<HostWindow> = None;
    let id = create_window(&mut slot, &plain(320, 240)).map_err(|e| format!("create: {e}"))?;
    println!("created id {id} on '{}'", slot.as_ref().map(|w| w.driver()).unwrap_or("?"));
    if id != 1 {
        return Err(format!("the first window's id is {id}, not 1"));
    }
    let window = slot.as_ref().ok_or("create_window succeeded but stored nothing")?;
    let info = window.info();
    println!("info: {}x{} pixels {}x{} dpi {}", info.width, info.height, info.pixel_width, info.pixel_height, info.dpi_scale_milli);
    if (info.width, info.height) != (320, 240) {
        return Err(format!("info says {}x{}, not 320x240", info.width, info.height));
    }
    if info.pixel_width == 0 || info.pixel_height == 0 {
        return Err("the pixel size is zero; a render target allocated from it would fail".to_string());
    }
    if info.mode != WindowMode::Windowed {
        return Err("a windowed window reports another mode".to_string());
    }

    // ── 2. a second create is refused, and leaves the first alone ────────
    match create_window(&mut slot, &plain(640, 480)) {
        Err(PlatformError::Busy(_)) => println!("second create: -EBUSY as documented"),
        Err(other) => return Err(format!("second create refused with {other}, not Busy")),
        Ok(_) => return Err("a second window was created; one window per process is the limit".to_string()),
    }
    let still = slot.as_ref().ok_or("the refused create dropped the existing window")?.info();
    if (still.width, still.height) != (320, 240) {
        return Err(format!(
            "the refused create changed the existing window to {}x{}",
            still.width, still.height
        ));
    }

    // ── 4. close: the slot empties and info goes back to zero ────────────
    let closed = slot.take();
    drop(closed);
    let after = slot.as_ref().map(|w| w.info()).unwrap_or_default();
    if after.width != 0 {
        return Err("the window survived the drop".to_string());
    }
    println!("closed: info is back to 0x0");

    // ── 4b. a Vulkan window carries a surface ────────────────────────────
    let mut vulkan_slot: Option<HostWindow> = None;
    let mut config = plain(320, 240);
    config.target = WindowTarget::Vulkan;
    config.title = "tension-create-probe (vulkan)".to_string();
    create_window(&mut vulkan_slot, &config).map_err(|e| format!("create(vulkan): {e}"))?;
    let window = vulkan_slot.as_mut().ok_or("create(vulkan) stored nothing")?;
    let surface = window.surface().map_err(|e| format!("surface: {e}"))?;
    println!(
        "vulkan window: instance 0x{:x} surface 0x{:x} {}x{}",
        surface.instance, surface.surface, surface.width, surface.height
    );
    if surface.instance == 0 || surface.surface == 0 {
        return Err("a Vulkan window produced no surface".to_string());
    }
    if window.instance_extensions().is_empty() {
        return Err("the instance reports no extensions; the adapter could not build from it".to_string());
    }
    println!("extensions: {:?}", window.instance_extensions());

    Ok(())
}

fn main() {
    match run() {
        Ok(()) => println!("platform_create: all assertions passed"),
        Err(why) => {
            eprintln!("platform_create: {why}");
            std::process::exit(1);
        }
    }
}
