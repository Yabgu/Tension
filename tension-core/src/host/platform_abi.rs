//! The `tension::platform` namespace: one registration, two kinds of guest.
//!
//! Every import here is a core service — a guest with no renderer and no
//! capability still has a window to talk about — so the namespace is registered
//! for the process's own guest **and** for a nested one. What differs is what
//! the answers mean:
//!
//! * **`Kind::Root`** owns the process. `surface_width` is the window's logical
//!   width, `window_info` is the window's record, `create_window` reaches
//!   `SDL_CreateWindow`, and the mutators mutate.
//! * **`Kind::Nested`** draws into the outer guest's viewport. There is no
//!   window: `create_window` and `close_window` refuse `-ENOTSUP`, the mutators
//!   refuse `-ENOTSUP`, and `surface_width`/`window_info` answer the **viewport
//!   rect** given at `dev.run` with origin (0,0).
//!
//! Registered in one function for both kinds because the alternative — a second
//! registration site for the nested verbs — would put two implementations of one
//! name in the ABI page with nothing to tell them apart. The kind is a parameter
//! of the registration, and each shim that cares branches on it once.

use wasmtime::{Caller, Linker};

use crate::adapter;
use crate::host::guest::Kind;
use crate::logging::Level;
use crate::platform;
use crate::{read_guest_span, write_guest, HostState};

/// `-ENOTSUP`: this verb exists in the surface but means nothing to this kind of
/// guest. Distinct from `-EINVAL` (the caller sent nonsense) and `-ENODEV`
/// (there is a window and it is not usable): here there is *no* window by
/// design, and asking again will not help.
const ENOTSUP: i32 = -95;

/// A nested guest's viewport, as `dev.run` was told it.
///
/// `(0, 0)` when nothing was set — the guest then draws at zero size, which is
/// visible as nothing rather than as a plausible-looking wrong size.
fn nested_viewport(caller: &Caller<'_, HostState>) -> (u32, u32) {
    caller.data().nested_viewport.unwrap_or((0, 0))
}

/// The window width a guest sees, or 0 for "nothing to draw into".
///
/// **This answers the window question, not the Vulkan question.** Whether a
/// `VkInstance` and a `VkSurfaceKHR` exist is a renderer's business and is
/// deliberately invisible here: a guest asking how big its window is must not
/// depend on whether something has claimed the surface for swapchain work. The
/// two were conflated in the first cut — the guest read 0 for a window that was
/// plainly open — which is exactly the ambiguity `has_surface()` exists to
/// prevent on the Rust side, re-created one layer up.
///
/// 0 is unambiguous because a real window is never 0 wide: `parse_window_size`
/// refuses it at the CLI and `apply_control` clamps to 1.
///
/// A **nested** guest's answer is its viewport, not the window: what it draws
/// into is the rectangle the outer guest gave it.
fn surface_width(caller: &Caller<'_, HostState>, kind: Kind) -> u32 {
    match kind {
        Kind::Nested => nested_viewport(caller).0,
        Kind::Root => caller
            .data()
            .host_window
            .as_ref()
            .map(|window| window.published_size().0)
            .unwrap_or(0),
    }
}

/// The height, with the same "0 means nothing to draw into" contract.
fn surface_height(caller: &Caller<'_, HostState>, kind: Kind) -> u32 {
    match kind {
        Kind::Nested => nested_viewport(caller).1,
        Kind::Root => caller
            .data()
            .host_window
            .as_ref()
            .map(|window| window.published_size().1)
            .unwrap_or(0),
    }
}

/// Register the whole namespace for one guest.
pub(crate) fn link_platform(linker: &mut Linker<HostState>, kind: Kind) -> anyhow::Result<()> {
    // tension::platform ABI -----------------------------------------------
    //
    // The guest's half of the control bus. Three imports, registered beside
    // `tension::io` because they are core services, not capabilities: a guest
    // with no renderer and no capability still has a window to talk about.
    //
    // `control` constructs the message and posts it with source GUEST — the
    // stamp is applied by the bus, so the value here is irrelevant and is set
    // only so the struct is fully initialised.
    //
    // All three are ordinary imports with `flags = 0` in the adapter sense,
    // which does not apply to them: the flag machinery lives in the *adapter*
    // dispatch (`adapter/ffi.rs`), gated on `HostState::depth`, and a core
    // import never goes through it. So these work from a scheduler-triggered
    // frame as well as a normal one — verified by reading the resume path,
    // which sets no depth.
    linker.func_wrap(
        "tension::platform",
        "control",
        |mut caller: Caller<'_, HostState>, kind: u32, a0: i32, a1: i32, a2: i32, a3: i32| -> i32 {
            let msg = platform::TensionCtrlMsg {
                kind,
                visibility: platform::CTRL_OBSERVABLE,
                arg0: a0,
                arg1: a1,
                arg2: a2,
                arg3: a3,
                source: platform::CTRL_SRC_GUEST,
                reserved: 0,
            };
            let bus = std::sync::Arc::clone(&caller.data().control);
            match bus.post_guest(&msg) {
                Ok(()) => 0,
                Err(platform::ControlError::UnknownKind) => -22, // EINVAL
                Err(platform::ControlError::Malformed) => -22,
                Err(platform::ControlError::Full) => -28,       // ENOSPC
            }
        },
    )?;
    linker.func_wrap(
        "tension::platform",
        "surface_width",
        move |caller: Caller<'_, HostState>| -> u32 { surface_width(&caller, kind) },
    )?;
    linker.func_wrap(
        "tension::platform",
        "surface_height",
        move |caller: Caller<'_, HostState>| -> u32 { surface_height(&caller, kind) },
    )?;

    // The programmatic window API (ABI v7).
    //
    // These are the guest's whole window surface now that `--window` is gone:
    // an application that wants a window asks for one, and the host creates it
    // with the flags its target implies. Everything else about a window is
    // either read (`window_info`) or, from E1b, mutated.
    //
    // **`create_window` is the only place `SDL_CreateWindow` is reached from a
    // guest call**, and it runs on the interpreter thread — the same thread the
    // host loop pumps on, which is what SDL requires and what `SDL_GPU`'s claim
    // requires too. No queue, no deferral: a guest that creates a window and
    // immediately claims it must be able to.
    linker.func_wrap(
        "tension::platform",
        "create_window",
        move |mut caller: Caller<'_, HostState>, cfg_ptr: u32, cfg_len: u32| -> i32 {
            // A nested guest has no window and cannot be given one: the window
            // is a **process singleton**, one per process, created by whoever
            // owns the process. `-ENOTSUP` rather than a silent no-op, because a
            // guest that asked for a window and got `0` would go on to claim a
            // surface that does not exist.
            if kind == Kind::Nested {
                return ENOTSUP;
            }
            const CONFIG_BYTES: u32 = 56;
            const EINVAL: i32 = -22;
            const EBUSY: i32 = -16;
            const EIO: i32 = -5;
            const MAX_TITLE: u32 = 4096;

            if cfg_len < CONFIG_BYTES {
                return EINVAL;
            }
            let Some(bytes) = read_guest_span(&mut caller, cfg_ptr, CONFIG_BYTES) else {
                return EINVAL;
            };
            let u32_at = |at: usize| -> u32 {
                u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
            };
            let i32_at = |at: usize| -> i32 {
                i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
            };

            // `struct_size` is the caller's own build. A shorter struct than this
            // host reads would leave fields the caller never wrote, so it is a
            // refusal rather than a default.
            if u32_at(0) < CONFIG_BYTES {
                return EINVAL;
            }
            let Some(target) = platform::WindowTarget::from_u32(u32_at(4)) else {
                return EINVAL;
            };
            let Some(mode) = platform::WindowMode::from_u32(u32_at(16)) else {
                return EINVAL;
            };
            let flags = u32_at(20);
            if flags & !platform::window_flags::KNOWN != 0 {
                return EINVAL;
            }
            let title_ptr = u32_at(48);
            let title_len = u32_at(52);
            if title_len > MAX_TITLE {
                return EINVAL;
            }
            let title = if title_len == 0 {
                String::new()
            } else {
                let Some(raw) = read_guest_span(&mut caller, title_ptr, title_len) else {
                    return EINVAL;
                };
                match String::from_utf8(raw) {
                    Ok(text) => text,
                    Err(_) => return EINVAL,
                }
            };

            let config = platform::WindowConfig {
                target,
                width: u32_at(8),
                height: u32_at(12),
                mode,
                flags,
                x: i32_at(24),
                y: i32_at(28),
                min_width: u32_at(32),
                min_height: u32_at(36),
                max_width: u32_at(40),
                max_height: u32_at(44),
                title,
            };

            let data = caller.data_mut();
            if data.host_window.is_some() {
                // Said here rather than in `platform::create_window` so the
                // errno is the guest's `-EBUSY` and not a generic `-EIO`.
                return EBUSY;
            }
            match platform::create_window(&mut data.host_window, &config, &data.shared) {
                Ok(id) => {
                    crate::logging::log(
                        Level::Info,
                        "core",
                        &format!(
                            "create_window: {}x{} target={:?} on '{}' (SDL {})",
                            config.width,
                            config.height,
                            config.target,
                            data.host_window
                                .as_ref()
                                .map(|w| w.driver().to_string())
                                .unwrap_or_default(),
                            data.host_window
                                .as_ref()
                                .map(|w| w.sdl_version())
                                .unwrap_or_default()
                        ),
                    );
                    // A Vulkan window's surface is what a renderer adopts, and
                    // it is created — and published — here, before the guest can
                    // call `ogre::init`. Failing to make it fails the whole
                    // create: a window that cannot carry the surface its target
                    // promised is worse than no window, because the guest would
                    // go on to init a renderer into nothing.
                    if config.target == platform::WindowTarget::Vulkan {
                        let made = data
                            .host_window
                            .as_mut()
                            .map(|window| {
                                window.surface().map(|surface| {
                                    (surface, window.instance_extensions().to_vec())
                                })
                            })
                            .unwrap_or_else(|| {
                                Err(platform::PlatformError::Sdl(
                                    "the window vanished during creation".to_string(),
                                ))
                            });
                        match made {
                            Ok((surface, extensions)) => {
                                if let Some(cell) = data.host_surface.as_ref() {
                                    *cell.lock().expect("the surface mutex is never poisoned") =
                                        Some(adapter::PublishedSurface { surface, extensions });
                                }
                                crate::logging::log(
                                    Level::Info,
                                    "core",
                                    &format!(
                                        "create_window: surface published ({}x{}, instance 0x{:x})",
                                        surface.width, surface.height, surface.instance
                                    ),
                                );
                            }
                            Err(error) => {
                                data.host_window = None;
                                crate::logging::log(
                                    Level::Warn,
                                    "core",
                                    &format!("create_window: no Vulkan surface: {error}"),
                                );
                                return EIO;
                            }
                        }
                    }
                    id as i32
                }
                Err(platform::PlatformError::Busy(_)) => EBUSY,
                Err(error) => {
                    crate::logging::log(
                        Level::Warn,
                        "core",
                        &format!("create_window refused: {error}"),
                    );
                    EIO
                }
            }
        },
    )?;
    linker.func_wrap(
        "tension::platform",
        "close_window",
        move |mut caller: Caller<'_, HostState>, id: u32| -> i32 {
            // The window is not this guest's to close (see `create_window`).
            if kind == Kind::Nested {
                return ENOTSUP;
            }
            const ENODEV: i32 = -19;
            const EBUSY: i32 = -16;
            let data = caller.data_mut();
            if id != platform::WINDOW_ID {
                return ENODEV;
            }
            // A renderer adopted this window and built a swapchain on it. Tearing
            // it down underneath is the crash the teardown order exists to
            // prevent, so the guest closes the canvas first and the window second.
            if let Some(owner) = data.render2d.owner() {
                crate::logging::log(
                    Level::Warn,
                    "core",
                    &format!(
                        "close_window refused: the swapchain is held by {}; close it first",
                        owner.name()
                    ),
                );
                return EBUSY;
            }
            // Dropping the window destroys the surface and the instance first,
            // in that order (`HostWindow::drop`); clearing the cell is what makes
            // a renderer that reads afterwards see "no window" rather than a
            // handle into freed state.
            if data.host_window.take().is_some() {
                crate::logging::log(Level::Info, "core", "close_window: window closed");
            }
            if let Some(cell) = data.host_surface.as_ref() {
                *cell.lock().expect("the surface mutex is never poisoned") = None;
            }
            // The published record goes with it: `host_window_info` answers a
            // zeroed record for "no window", and a stale one would let a layer
            // believe the window it is reading about still exists.
            match data.shared.window.lock() {
                Ok(mut cell) => *cell = None,
                Err(poisoned) => *poisoned.into_inner() = None,
            }
            0
        },
    )?;
    linker.func_wrap(
        "tension::platform",
        "window_info",
        move |mut caller: Caller<'_, HostState>, id: u32, out_ptr: u32| -> i32 {
            const EINVAL: i32 = -22;
            // **The viewport rect, origin (0,0).** A nested guest draws into the
            // outer guest's viewport, so that rectangle is its screen: reporting
            // the window's on-screen position would hand it a coordinate space it
            // cannot map, and the record's one `w`/`h` is both dest and source
            // texel rect ("sprite cannot stretch"), so the size must be the one
            // the records are drawn at.
            if kind == Kind::Nested {
                if id != platform::WINDOW_ID {
                    return EINVAL;
                }
                let (width, height) = nested_viewport(&caller);
                let info = platform::WindowInfo {
                    width,
                    height,
                    pixel_width: width,
                    pixel_height: height,
                    dpi_scale_milli: 1000,
                    mode: platform::WindowMode::Windowed,
                    focused: true,
                    minimized: false,
                    close_requested: false,
                };
                let rec = platform::encode_window_info(Some(&info));
                if !write_guest(&mut caller, out_ptr as i32, &rec) {
                    return EINVAL;
                }
                return 0;
            }
            // One window per process, so an unknown id is a caller bug rather
            // than a lookup miss. **No window is not an error**: it writes a
            // zeroed record and returns 0, which is what makes `width > 0` the
            // whole headless guard in a guest's update loop.
            //
            // The record is encoded by `platform::encode_window_info`, the same
            // function the adapter slot `host_window_info` writes through. It
            // used to be a hand-built `[u32; 9]` here plus a separate last word,
            // while the adapter had this struct -- one layout, two encoders, and
            // a field added to either would have drifted silently.
            let info = if id == platform::WINDOW_ID {
                caller.data().host_window.as_ref().map(|window| window.info())
            } else {
                return EINVAL;
            };
            let rec = platform::encode_window_info(info.as_ref());
            if !write_guest(&mut caller, out_ptr as i32, &rec) {
                return EINVAL;
            }
            0
        },
    )?;

    // ── the window mutators (E1b) ─────────────────────────────────────────
    //
    // Three imports beside `window_info`, and imports rather than adapter
    // slots for the same reason it is one: this is the guest's own window, and
    // no second party has to agree about the shape of the call. An adapter that
    // needs to know the result reads `host_window_info`, which the pump
    // republishes every frame — so a renderer still learns about a toggle
    // without a second path to the window.
    //
    // **Synchronous, like `create_window`.** They run on the interpreter
    // thread, which is the thread the host pumps on and the only one SDL's
    // window API permits. The alternative — a control message — would defer the
    // change by a frame and turn "did the driver accept it" into something the
    // guest could only poll for.
    //
    // Names are snake_case to match every neighbour (`create_window`,
    // `window_info`); the SDK's camelCase surface is `platform.setFullscreen`
    // and friends, which is a wrapper and not the wire.
    linker.func_wrap(
        "tension::platform",
        "set_fullscreen",
        move |mut caller: Caller<'_, HostState>, mode: u32| -> i32 {
            if kind == Kind::Nested {
                return ENOTSUP;
            }
            const EINVAL: i32 = -22;
            const ENODEV: i32 = -19;
            const EIO: i32 = -5;
            // The three modes this ABI defines. A fourth number is a caller
            // built against a newer header, and guessing at it would give it a
            // window it did not ask for.
            let Some(mode) = platform::WindowMode::from_u32(mode) else {
                return EINVAL;
            };
            let data = caller.data_mut();
            let Some(window) = data.host_window.as_mut() else {
                return ENODEV;
            };
            match window.set_fullscreen(mode) {
                Ok(()) => 0,
                Err(error) => {
                    crate::logging::log(
                        Level::Warn,
                        "core",
                        &format!("set_fullscreen({mode:?}) refused: {error}"),
                    );
                    EIO
                }
            }
        },
    )?;
    linker.func_wrap(
        "tension::platform",
        "set_window_size",
        move |mut caller: Caller<'_, HostState>, width: u32, height: u32| -> i32 {
            // Resizing the window is the outer guest's business; a nested guest
            // re-renders when it is told a new viewport size, which is the
            // resize path the buffer backlog describes.
            if kind == Kind::Nested {
                return ENOTSUP;
            }
            const EINVAL: i32 = -22;
            const ENODEV: i32 = -19;
            const EIO: i32 = -5;
            // A zero dimension is refused rather than clamped here: the host
            // floors it too, so that a core module cannot ask SDL for nothing,
            // but a guest sending 0 has a caller bug and should be told.
            if width == 0 || height == 0 {
                return EINVAL;
            }
            let data = caller.data_mut();
            let Some(window) = data.host_window.as_mut() else {
                return ENODEV;
            };
            match window.set_window_size(width, height) {
                Ok(()) => 0,
                Err(error) => {
                    crate::logging::log(
                        Level::Warn,
                        "core",
                        &format!("set_window_size({width}x{height}) refused: {error}"),
                    );
                    EIO
                }
            }
        },
    )?;
    linker.func_wrap(
        "tension::platform",
        "set_window_title",
        move |mut caller: Caller<'_, HostState>, title_ptr: u32, title_len: u32| -> i32 {
            const EINVAL: i32 = -22;
            // **Accepted and dropped, not refused.** The framework imports this
            // verb at module level, so a refusal would force every nested guest
            // to branch on "am I nested" for a cosmetic call. The title belongs
            // to the outer editor, which set it. The argument is still validated
            // (a bad pointer is a caller bug in either world).
            if kind == Kind::Nested {
                const MAX_TITLE_NESTED: u32 = 4096;
                if title_len > MAX_TITLE_NESTED {
                    return EINVAL;
                }
                if title_len > 0 && read_guest_span(&mut caller, title_ptr, title_len).is_none() {
                    return EINVAL;
                }
                return 0;
            }
            const ENODEV: i32 = -19;
            const EIO: i32 = -5;
            const MAX_TITLE: u32 = 4096;
            // The bound `create_window` uses, for the same reason: the title is
            // copied into the window, and an unbounded length is an allocation
            // a guest chooses.
            if title_len > MAX_TITLE {
                return EINVAL;
            }
            let title = if title_len == 0 {
                String::new()
            } else {
                let Some(raw) = read_guest_span(&mut caller, title_ptr, title_len) else {
                    return EINVAL;
                };
                match String::from_utf8(raw) {
                    Ok(text) => text,
                    // A title is UTF-8 on the wire, like every other string
                    // this host accepts; bytes that are not are a caller bug,
                    // not something to lossily repair.
                    Err(_) => return EINVAL,
                }
            };
            let data = caller.data_mut();
            let Some(window) = data.host_window.as_mut() else {
                return ENODEV;
            };
            match window.set_window_title(&title) {
                Ok(()) => 0,
                Err(error) => {
                    crate::logging::log(
                        Level::Warn,
                        "core",
                        &format!("set_window_title refused: {error}"),
                    );
                    EIO
                }
            }
        },
    )?;
    Ok(())
}
