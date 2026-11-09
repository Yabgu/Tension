//! The in-core 2D renderer's device, its window claim, and the arbitration
//! that decides which renderer owns the swapchain.
//!
//! # What this file is, and what it is not
//!
//! This is **Pass A** of the merge: the skeleton. It creates the GPU device,
//! claims the host's window for it, and releases both on `close`. The eight
//! remaining verbs — `submit`, `present`, `texture_load`, `set_texture`,
//! `set_pipeline`, `info`, `screenshot`, `shader_compile_raw` — are registered
//! by the binary as `-ENOSYS` so a guest that imports them still instantiates;
//! their bodies arrive in Pass B, together with the deletion of the C++ adapter.
//!
//! # Why the window is claimed, not created here
//!
//! `tension-2d` used to call `SDL_CreateWindow` itself (`render.cpp:522`), which
//! contradicted the north star: the host owns the window, a renderer consumes
//! it. The merge is what makes the old behaviour unnecessary — as a DSO, 2D had
//! no way to reach the host's `SDL_Window`, and `SDL_GPU` has no
//! external-surface API to hand it a `VkSurfaceKHR` instead. In-core, the
//! renderer is inside the process that owns the window, so `open` can claim it.
//!
//! The window is created **on demand**: the first `open(WINDOWED)` makes one at
//! the size the renderer declares, so `Canvas.open(320, 180, OPEN_WINDOWED)`
//! needs no `--window 320x180` beside it. `--window` still exists for the one
//! example that has no renderer at all (`examples/platform-control`), and Pass C
//! is where that example and the flag go.
//!
//! # Why the device is destroyed on `close` rather than kept idle
//!
//! SDL releases a window's GPU claim when the claiming device is destroyed, and
//! `sdl3` 0.22 exposes `SDL_DestroyGPUDevice` through `Drop` but not
//! `SDL_ReleaseWindowFromGPUDevice` at all. Destroying the device on `close` is
//! therefore the one release path that needs no `unsafe` block and no second
//! binding crate. The cost is device setup on a reopen, which no example does:
//! a guest opens its canvas once and closes it at exit.
//!
//! SPDX-License-Identifier: MIT

use crate::platform::{HostWindow, PlatformError};
use crate::render2d::error::Render2dError;

use sdl3::gpu::{Device, ShaderFormat};

/// Which renderer holds the swapchain.
///
/// Two today. `Render2d` is this module; `RenderOgre` is the DSO that still
/// creates its own window unless the host published a surface. The guard exists
/// so the *second* one to ask gets a Tension-shaped message rather than SDL's
/// generic one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RendererId {
    Render2d,
    RenderOgre,
}

impl RendererId {
    /// The name a refusal names. Short, and the same word the log uses.
    pub fn name(self) -> &'static str {
        match self {
            RendererId::Render2d => "2D",
            RendererId::RenderOgre => "Ogre",
        }
    }
}

/// One open canvas. Capacity is one, as it was in the DSO
/// (`adapter.cpp:44-46`: the handle is 1 or 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Canvas {
    /// The canvas size the guest declared. The offscreen target is this big.
    pub width: u32,
    pub height: u32,
    /// Whether this canvas presents to the host's window.
    pub windowed: bool,
}

/// The 2D renderer's whole state: a device, at most one canvas, and who owns
/// the swapchain.
///
/// Lives in `HostState` beside `host_window`, because both are touched by the
/// same verb on the same thread and splitting them would mean threading a
/// mutable reference through the ABI glue for no gain.
#[derive(Default)]
pub struct Render2dState {
    /// Up while a canvas is open. Dropped by `close`.
    device: Option<Device>,
    /// The video subsystem, held for as long as the device is.
    ///
    /// Not redundant with `HostWindow`'s: an **offscreen** canvas has no window,
    /// and `SDL_CreateGPUDevice` still needs the video subsystem initialised or
    /// it refuses with "Video subsystem not initialized". The DSO did the same
    /// init explicitly (`render.cpp:485`, `SDL_Init(SDL_INIT_VIDEO)`); SDL
    /// refcounts it, so keeping a second handle is free and keeps the two
    /// canvases from having two lifecycles.
    ///
    /// Declared after `device` so the device drops first — field order is drop
    /// order, and a device outliving its subsystem is the ordering that faults.
    video: Option<sdl3::VideoSubsystem>,
    /// `Some` while a canvas is open.
    canvas: Option<Canvas>,
    /// Who may present. `None` when nobody has claimed the swapchain.
    swapchain_owner: Option<RendererId>,
}

impl Render2dState {
    /// The open canvas, if any.
    pub fn canvas(&self) -> Option<Canvas> {
        self.canvas
    }

    /// Who holds the swapchain, if anyone.
    pub fn owner(&self) -> Option<RendererId> {
        self.swapchain_owner
    }

    /// Whether a GPU device is up.
    pub fn has_device(&self) -> bool {
        self.device.is_some()
    }

    /// Take the swapchain, or refuse because someone else has it.
    ///
    /// **This is the arbitration the merge was for.** SDL_GPU refuses a second
    /// claim cleanly — `VULKAN_ClaimWindow`, read at release-3.4.18
    /// (`SDL_gpu_vulkan.c:9940-10012`), returns `false` with
    /// `"Window already claimed"` for a different device and refcounts for the
    /// same one, leaving the existing claim untouched either way. That is safe
    /// but not *legible*: the refusal arrives as `-ENODEV` with a string that
    /// reads like "no GPU", which is why core mediates first and SDL stays the
    /// backstop.
    ///
    /// `RenderOgre` does not route through here yet — the DSO's claim is made
    /// inside Ogre, and Pass D wires it in. Until then this guard arbitrates
    /// 2D against itself, which is the case Pass A can actually exercise.
    pub fn claim_swapchain(&mut self, who: RendererId) -> Result<(), Render2dError> {
        match self.swapchain_owner {
            Some(held) if held != who => Err(Render2dError::Busy(format!(
                "the swapchain is held by {}; {} cannot present to the same window",
                held.name(),
                who.name()
            ))),
            _ => {
                self.swapchain_owner = Some(who);
                Ok(())
            }
        }
    }

    /// Give the swapchain back. Idempotent, and a no-op for a renderer that
    /// does not hold it — releasing something you never claimed is not an error
    /// worth failing a close over.
    pub fn release_swapchain(&mut self, who: RendererId) {
        if self.swapchain_owner == Some(who) {
            self.swapchain_owner = None;
        }
    }

    /// Open a canvas that presents to the host's window.
    ///
    /// Creates the window first if there is none: at `width`x`height`, which is
    /// the size the renderer declared. This is the whole of "the host creates
    /// the window on demand" — there is no flag, no startup window, and no
    /// second size to keep in step.
    ///
    /// `host_window` is `&mut Option<HostWindow>` rather than a `HostWindow`
    /// because the window outlives the canvas: `close` releases the claim and
    /// leaves the window standing, and only process exit destroys it.
    pub fn open_windowed(
        &mut self,
        host_window: &mut Option<HostWindow>,
        width: u32,
        height: u32,
    ) -> Result<i32, Render2dError> {
        if self.canvas.is_some() {
            return Err(Render2dError::Busy(
                "a canvas is already open; one at a time".to_string(),
            ));
        }
        if width == 0 || height == 0 {
            return Err(Render2dError::Invalid(format!(
                "a canvas cannot be {width}x{height}"
            )));
        }
        // Refuse before creating anything, so a refusal leaves no window behind
        // for the next caller to trip over.
        self.claim_swapchain(RendererId::Render2d)?;

        if host_window.is_none() {
            let window = HostWindow::new("Tension", width, height).map_err(|error| {
                self.release_swapchain(RendererId::Render2d);
                Render2dError::NoDevice(format!("creating the host window: {error}"))
            })?;
            *host_window = Some(window);
        } else if let Some(window) = host_window.as_ref() {
            let (open_width, open_height) = window.published_size();
            if (open_width, open_height) != (width, height) {
                // Not a refusal: the swapchain scales to the drawable size, so a
                // mismatch shows the same frame larger or smaller rather than a
                // crop. Worth a line because it is the one case where the canvas
                // size and the window size disagree, and the reason is always
                // that `--window` chose first.
                crate::logging::log(
                    crate::logging::Level::Info,
                    "2d",
                    &format!(
                        "open: canvas is {width}x{height}, window is \
                         {open_width}x{open_height} (from --window); presenting scaled"
                    ),
                );
            }
        }

        let window = host_window
            .as_ref()
            .ok_or_else(|| Render2dError::NoDevice("no host window".to_string()))?;

        // Initialised before the device, and kept even though the window has its
        // own handle: SDL_InitSubSystem refcounts, and a device created against a
        // video subsystem that is dropped underneath it is the kind of order bug
        // that only shows up on the second open.
        let video = ensure_video(&mut self.swapchain_owner)?;

        let device = Device::new(ShaderFormat::SPIRV, false).map_err(|error| {
            self.release_swapchain(RendererId::Render2d);
            Render2dError::NoDevice(format!("CreateGPUDevice: {error}"))
        })?;

        // The thread rule: `SDL_ClaimWindowForGPUDevice` must run on the thread
        // that created the window (`SDL_gpu.h:4140-4142`). Every verb runs on
        // the interpreter thread, which is the thread `HostWindow::new` ran on,
        // so the rule holds by construction rather than by convention.
        let device = device.with_window(window.sdl_window()).map_err(|error| {
            self.release_swapchain(RendererId::Render2d);
            Render2dError::NoDevice(format!(
                "ClaimWindowForGPUDevice: {error} — if this reads `Window already \
                 claimed`, another renderer holds it"
            ))
        })?;

        self.device = Some(device);
        self.video = Some(video);
        self.canvas = Some(Canvas {
            width,
            height,
            windowed: true,
        });
        Ok(1)
    }

    /// Open a canvas that presents nowhere.
    ///
    /// No window, no claim, no swapchain: `screenshot` reads the target back and
    /// that is the only way to see the frame. This is what every headless run
    /// and every pixel assertion in CI uses, and it is why a 2D-only headless
    /// run never creates a window at all.
    pub fn open_offscreen(&mut self, width: u32, height: u32) -> Result<i32, Render2dError> {
        if self.canvas.is_some() {
            return Err(Render2dError::Busy(
                "a canvas is already open; one at a time".to_string(),
            ));
        }
        if width == 0 || height == 0 {
            return Err(Render2dError::Invalid(format!(
                "a canvas cannot be {width}x{height}"
            )));
        }

        let video = ensure_video(&mut self.swapchain_owner)?;

        let device = Device::new(ShaderFormat::SPIRV, false)
            .map_err(|error| Render2dError::NoDevice(format!("CreateGPUDevice: {error}")))?;

        self.device = Some(device);
        self.video = Some(video);
        self.canvas = Some(Canvas {
            width,
            height,
            windowed: false,
        });
        Ok(1)
    }

    /// Close the canvas: release the claim, destroy the device, keep the window.
    ///
    /// The window staying up is deliberate and temporary. Destroying it here
    /// would need a lifecycle that answers "what if the guest reopens?" — and a
    /// guest that closes its canvas has finished drawing, so the window is
    /// already idle. Pass C takes the decision; this pass leaves the window to
    /// process exit, where `main` already drops it after the adapters.
    pub fn close(&mut self, handle: i32) -> Result<i32, Render2dError> {
        let canvas = self.canvas.ok_or_else(|| {
            Render2dError::Invalid("close: no canvas is open".to_string())
        })?;
        if handle != 1 {
            return Err(Render2dError::Invalid(format!(
                "close: handle {handle} is not the open canvas"
            )));
        }
        if canvas.windowed {
            self.release_swapchain(RendererId::Render2d);
        }
        // Dropping the device is what releases SDL's window claim (see the
        // module header). Order matters: the claim goes with the device, and the
        // window outlives both.
        self.device = None;
        self.video = None;
        self.canvas = None;
        Ok(0)
    }
}

/// Bring up SDL's video subsystem, or say which step refused.
///
/// `sdl3::init()` is refcounted and thread-checked: a second call on the same
/// thread is fine, a call from another thread is refused by the crate. Every
/// caller here runs on the interpreter thread, which is the thread that created
/// any window that exists — the same thread rule the GPU claim lives under.
///
/// The `swapchain_owner` is passed only so the failure path can undo a claim
/// that was taken before the video came up; without that, a failed open would
/// leave the swapchain held by a renderer with no device.
fn ensure_video(
    swapchain_owner: &mut Option<RendererId>,
) -> Result<sdl3::VideoSubsystem, Render2dError> {
    let fail = |swapchain_owner: &mut Option<RendererId>, message: String| {
        if *swapchain_owner == Some(RendererId::Render2d) {
            *swapchain_owner = None;
        }
        Render2dError::NoDevice(message)
    };

    let sdl = match sdl3::init() {
        Ok(sdl) => sdl,
        Err(error) => return Err(fail(swapchain_owner, format!("SDL_Init: {error}"))),
    };
    match sdl.video() {
        Ok(video) => Ok(video),
        Err(error) => Err(fail(
            swapchain_owner,
            format!("SDL_InitSubSystem(VIDEO): {error}"),
        )),
    }
}

/// Turn a platform refusal into the errno a guest sees.
///
/// A small mapping rather than a `From` impl, because the two error types carry
/// different audiences: this one only ever runs at the boundary where the guest
/// is about to be told `-ENODEV`.
pub fn platform_errno(error: &PlatformError) -> i32 {
    Render2dError::NoDevice(error.to_string()).errno()
}
