//! Vulkan instance and surface creation for the host-owned window.
//!
//! # Two loaders, one library
//!
//! There are two independent paths to Vulkan in this process, and the code
//! depends on them resolving to the same thing:
//!
//!   * `SDL_Vulkan_LoadLibrary`, called through `VideoSubsystem`
//!     (`sdl3::video::VideoSubsystem::vulkan_load_library_default`). SDL needs
//!     it to know which `vkGetInstanceProcAddr` to use for the window-system
//!     surface call.
//!   * `ash::Entry::load()`, which `dlopen`s the Vulkan loader itself.
//!
//! In practice both resolve to the same `libvulkan.so.1` (or `vulkan-1.dll`),
//! which is what makes the pairing legal: SDL creates a `VkSurfaceKHR` for an
//! instance *ash* created. This is verified rather than assumed — the
//! `platform_surface` probe builds the instance with ash and hands it to
//! `SDL_Vulkan_CreateSurface`, and the surface comes back live.
//!
//! **If a future change gives either side a different loader — a bundled
//! libvulkan, a `VK_ICD_FILENAMES`-style override applied to one and not the
//! other, or an ash `Entry::load_from(path)` — the instance and the surface
//! become incompatible and `SDL_Vulkan_CreateSurface` will fail or, worse,
//! appear to succeed.** The fix then is not to patch around it: it is to take
//! both the instance handle *and* the surface from the same loader, which means
//! dropping `ash::Entry::load()` for SDL's `vkGetInstanceProcAddr`. Recorded as
//! contradiction entry 11 in `docs-contradictions.md`.
//!
//! # Ownership
//!
//! The host owns the `VkInstance`; the renderer creates its own `VkDevice` from
//! it. So the instance must outlive every adapter, which is why
//! `HostWindow` is dropped after `teardown_adapters` in `main`.

use ash::vk;
use ash::vk::Handle;
use std::sync::atomic::{AtomicU32, Ordering};

/// What a renderer needs to render into the host's window.
///
/// Plain integers rather than Vulkan types: this crosses the adapter ABI as two
/// `u64`s, and keeping the boundary type dumb is what lets `tension_adapter.h`
/// describe it without knowing what `ash` is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostSurface {
    /// `VkInstance`, borrowed from the host. The adapter must not destroy it.
    pub instance: u64,
    /// `VkSurfaceKHR`, likewise borrowed. The adapter builds a swapchain on it
    /// and must not destroy it.
    pub surface: u64,
    /// Current drawable size in pixels.
    pub width: u32,
    pub height: u32,
}


/// What one pump of the window's event queue found.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlatformEvents {
    /// The drawable size changed, and the published size now holds the new one.
    pub resized: Option<(u32, u32)>,
    /// The user asked to close the window: SDL_EVENT_QUIT, or a close request
    /// on this window specifically.
    pub close_requested: bool,
    /// How many SDL events were drained. Recorded rather than returned because
    /// a loop wants "did anything happen?", and a count would invite it to
    /// infer meaning from a number that has none.
    pub drained: u32,
}

/// Why a window or a surface could not be created.
#[derive(Debug)]
pub enum PlatformError {
    /// SDL refused: no display, no driver, or no Vulkan support in the driver.
    Sdl(String),
    /// Vulkan refused, with the loader's own message.
    Vulkan(String),
    /// The window exists but has no Vulkan-backed drawable — the `dummy`
    /// driver, for instance, which has no WSI at all.
    NoVulkanSurface(String),
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlatformError::Sdl(message) => write!(f, "sdl: {message}"),
            PlatformError::Vulkan(message) => write!(f, "vulkan: {message}"),
            PlatformError::NoVulkanSurface(message) => write!(f, "no vulkan surface: {message}"),
        }
    }
}

impl std::error::Error for PlatformError {}

/// A window the host owns, plus the Vulkan instance and surface that go with it.
///
/// # Why the surface is lazy
///
/// A window is cheap and a `VkInstance` is not. Most runs — every test suite, the
/// headless examples — want no window at all, and a run that opens a window but
/// loads no renderer should not pay for a Vulkan instance it will never use. The
/// instance is created on the first `surface()` call, which is the moment an
/// adapter says it wants one.
///
/// The cost of that choice is that "there is a window" and "there is a surface"
/// are different questions. `has_surface()` answers the second; the presence of
/// `HostWindow` answers the first.
pub struct HostWindow {
    /// Dropped first of the SDL handles: a window must not outlive the video
    /// subsystem, and field order is drop order in Rust.
    window: sdl3::video::Window,
    /// At most one `EventPump` may be alive per process, so it is created once
    /// and kept: `Sdl::event_pump` refuses a second one.
    event_pump: sdl3::EventPump,
    /// Cheap to clone; holds the video subsystem alive.
    video: sdl3::VideoSubsystem,
    /// `Some` once `surface()` has succeeded.
    instance: Option<ash::Instance>,
    entry: Option<ash::Entry>,
    surface: Option<HostSurface>,
    /// The instance extensions SDL asked for, kept because they are the only
    /// record of *which* window-system interface this surface came from. A log
    /// line naming them answers "did we get Wayland or XWayland?" without a
    /// second query, and the probe asserts on them.
    extensions: Vec<String>,
    /// Current drawable size in pixels.
    ///
    /// Atomics, not plain fields, because two threads touch them: the pump
    /// writes them on the main thread when SDL reports a resize, and a
    /// renderer's frame loop reads them to decide whether its swapchain is
    /// stale. A plain field would be a data race that only shows up as a
    /// one-frame mis-sized swapchain under load.
    width: AtomicU32,
    height: AtomicU32,
    title: String,
    /// Last, so it outlives everything above it: `Sdl`'s drop calls `SDL_Quit`,
    /// which tears down the video subsystem under every window that outlived
    /// it. Never read — it is a lifetime anchor, and the leading underscore is
    /// the declaration of that rather than an oversight.
    _sdl: sdl3::Sdl,
}

impl HostWindow {
    /// Create a window. Must be called from the main thread: `sdl3` refuses to
    /// initialise anywhere else (`sdl3::sdl::Sdl::new`), and that restriction is
    /// the portable one even though SDL 3.4 itself is more permissive.
    ///
    /// The window is created with `SDL_WINDOW_VULKAN` from the start. Adding
    /// that flag later is not possible on every driver, and on Wayland the
    /// surface is a property of the window's creation, not something bolted on
    /// after.
    pub fn new(title: &str, width: u32, height: u32) -> Result<Self, PlatformError> {
        let sdl = sdl3::init().map_err(|e| PlatformError::Sdl(e.to_string()))?;
        let video = sdl
            .video()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        // At most one alive, and `Sdl` owns the right to make it.
        let event_pump = sdl
            .event_pump()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        let mut builder = video.window(title, width, height);
        builder.set_flags(
            sdl3::video::WindowFlags::VULKAN
                | sdl3::video::WindowFlags::RESIZABLE
                | sdl3::video::WindowFlags::HIGH_PIXEL_DENSITY,
        );
        let window = builder
            .build()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        Ok(HostWindow {
            window,
            event_pump,
            video,
            instance: None,
            entry: None,
            surface: None,
            extensions: Vec::new(),
            width: AtomicU32::new(width),
            height: AtomicU32::new(height),
            title: title.to_string(),
            _sdl: sdl,
        })
    }

    /// The window's title, as created.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Create the Vulkan instance and surface, or return the cached one.
    ///
    /// The instance is created from the extensions **SDL** asks for, not a list
    /// this file guesses. That is what makes one code path serve Wayland
    /// (`VK_KHR_wayland_surface`), X11 (`VK_KHR_xlib_surface`), and the
    /// `offscreen` driver (`VK_EXT_headless_surface`) without a platform `cfg`
    /// anywhere in this crate.
    ///
    /// Takes `&mut self` because the first call is what creates the instance —
    /// a caller that only reads state uses `published()` instead.
    pub fn surface(&mut self) -> Result<HostSurface, PlatformError> {
        if let Some(surface) = self.surface {
            return Ok(surface);
        }

        // Loaded here rather than in `new`, because a window does not need
        // Vulkan: `--window` on a machine with no Vulkan should open the
        // window and report that nothing asked for a surface, not refuse to
        // start. Measured that this ordering is legal — SDL creates a
        // SDL_WINDOW_VULKAN window happily before any library is loaded, and
        // `SDL_Vulkan_GetInstanceExtensions` answers correctly once it is.
        //
        // See the module header on the two loaders.
        self.video
            .vulkan_load_library_default()
            .map_err(|e| PlatformError::NoVulkanSurface(e.to_string()))?;

        let extensions = self
            .window
            .vulkan_instance_extensions()
            .map_err(|e| PlatformError::NoVulkanSurface(e.to_string()))?;

        let names: Vec<std::ffi::CString> = extensions
            .iter()
            .map(|name| {
                std::ffi::CString::new(name.as_str())
                    .map_err(|_| PlatformError::Vulkan(format!("extension name has a NUL: {name}")))
            })
            .collect::<Result<_, _>>()?;
        let pointers: Vec<*const std::os::raw::c_char> =
            names.iter().map(|name| name.as_ptr()).collect();

        // SAFETY: `Entry::load` dlopens the Vulkan loader. It is a process-wide
        // singleton and stays alive as long as `self.entry` does, which is as
        // long as the instance it is used to create and destroy.
        let entry = unsafe { ash::Entry::load() }
            .map_err(|e| PlatformError::Vulkan(e.to_string()))?;

        let application_name =
            std::ffi::CString::new("tension-core").expect("no NUL in a literal");
        let app_info = vk::ApplicationInfo::default()
            .application_name(&application_name)
            .api_version(vk::make_api_version(0, 1, 1, 0));
        let create_info = vk::InstanceCreateInfo::default()
            .application_info(&app_info)
            .enabled_extension_names(&pointers);

        // SAFETY: no validation layers are requested, so there is no callback
        // to keep alive past this call; the extension list outlives it.
        let instance = unsafe { entry.create_instance(&create_info, None) }
            .map_err(|e| PlatformError::Vulkan(format!("create_instance: {e}")))?;

        // SAFETY: `instance` was created just above by this loader and the
        // window was built with SDL_WINDOW_VULKAN, which is what SDL requires.
        let surface = unsafe { self.window.vulkan_create_surface(instance.handle()) }
            .map_err(|e| {
                // The instance must not leak when the surface fails.
                unsafe { instance.destroy_instance(None) };
                PlatformError::NoVulkanSurface(e.to_string())
            })?;

        let (width, height) = self.window.size();
        self.width.store(width, Ordering::Relaxed);
        self.height.store(height, Ordering::Relaxed);
        let published = HostSurface {
            instance: instance.handle().as_raw(),
            surface: surface.as_raw(),
            width,
            height,
        };

        self.extensions = extensions;
        self.entry = Some(entry);
        self.instance = Some(instance);
        self.surface = Some(published);
        Ok(published)
    }

    /// The surface if one has been created, without creating one.
    ///
    /// This is the read the executor and the render thread both use: it must not
    /// have side effects, because the render thread calls it every frame.
    pub fn published(&self) -> Option<HostSurface> {
        self.surface.map(|surface| HostSurface {
            width: self.width.load(Ordering::Relaxed),
            height: self.height.load(Ordering::Relaxed),
            ..surface
        })
    }

    /// The current drawable size, without creating anything.
    ///
    /// Safe from any thread; this is what a renderer compares against its own
    /// swapchain size once per frame.
    pub fn published_size(&self) -> (u32, u32) {
        (
            self.width.load(Ordering::Relaxed),
            self.height.load(Ordering::Relaxed),
        )
    }

    /// Whether a Vulkan surface exists yet.
    ///
    /// Callers should ask this rather than comparing `published()` against
    /// zero: "no surface" and "a surface at address 0" are different facts, and
    /// only one of them is possible. A boolean cannot conflate them.
    pub fn has_surface(&self) -> bool {
        self.surface.is_some()
    }

    /// The Vulkan instance extensions SDL requested, once `surface()` has run.
    ///
    /// Empty before that. This is what distinguishes a real window-system
    /// surface (`VK_KHR_wayland_surface`, `VK_KHR_xlib_surface`) from the
    /// `offscreen` driver's `VK_EXT_headless_surface`: both create a surface,
    /// only the first is an interface a user can see.
    pub fn instance_extensions(&self) -> &[String] {
        &self.extensions
    }


    /// Drain pending SDL events, update the published size, and report what
    /// happened.
    ///
    /// **Main thread only.** SDL's event functions must run on the thread that
    /// initialised the video subsystem, and `HostWindow::new` is what does that.
    /// Nothing here calls a window *setter*, so a layer or a guest cannot reach
    /// SDL through this: they go through the control queue instead, and the
    /// executor calls the setters.
    ///
    /// Called once per host-loop iteration. The loop's existing 16 ms wait
    /// timeout bounds how long events can sit undrained; see `main.rs`'s note on
    /// `HOST_LOOP_SLICE_MS`.
    pub fn pump(&mut self) -> PlatformEvents {
        let mut events = PlatformEvents::default();

        self.event_pump.pump_events();
        let window_id = self.window.id();

        while let Some(event) = self.event_pump.poll_event() {
            events.drained += 1;
            match event {
                sdl3::event::Event::Quit { .. } => events.close_requested = true,
                sdl3::event::Event::Window {
                    win_event: sdl3::event::WindowEvent::CloseRequested,
                    window_id: id,
                    ..
                } if id == window_id => events.close_requested = true,
                sdl3::event::Event::Window {
                    win_event: sdl3::event::WindowEvent::Resized(width, height),
                    window_id: id,
                    ..
                } if id == window_id => {
                    // Pixels, not points: `Window::size()` is the drawable size,
                    // which is what a swapchain is built from.
                    let (width, height) = (width.max(0) as u32, height.max(0) as u32);
                    if width > 0 && height > 0 {
                        self.width.store(width, Ordering::Relaxed);
                        self.height.store(height, Ordering::Relaxed);
                        events.resized = Some((width, height));
                    }
                }
                _ => {}
            }
        }

        events
    }

    /// The window's current drawable size in pixels, read from SDL.
    ///
    /// Main thread only (it calls into SDL). Everything else reads
    /// `published_size`, which is an atomic read.
    pub fn size(&self) -> (u32, u32) {
        self.window.size()
    }

    /// Ask the window system to resize the window.
    ///
    /// **This is the executor's call, and the only place `SDL_SetWindowSize`
    /// is reached.** It is `pub` because the `platform_window` probe has to
    /// synthesise a resize — a test cannot ask a compositor to drag a corner —
    /// and not because an adapter may use it.
    ///
    /// The rule "no layer and no guest calls SDL_SetWindow*" is enforced by
    /// *ownership*, not by visibility: an adapter never receives a `HostWindow`
    /// or any pointer to one. It gets a `post_control` function and a
    /// `host_surface` reader. Widening this method's visibility cannot widen
    /// that, because there is nothing to widen it through. If a future change
    /// ever hands an adapter a `HostWindow`, that change is the bug — not this
    /// `pub`.
    ///
    /// Main thread only, like every other window call.
    pub fn set_size(&mut self, width: u32, height: u32) -> Result<(), PlatformError> {
        self.window
            .set_size(width, height)
            .map_err(|e| PlatformError::Sdl(e.to_string()))
    }

    /// The SDL version this process actually linked against.
    ///
    /// Worth a log line at startup: the `sdl3` crate is generated from a
    /// slightly newer header set than the system library this tree ships
    /// against, so "which SDL am I running?" is a question that comes up the
    /// first time a call behaves differently than its binding suggests.
    pub fn sdl_version(&self) -> String {
        let version = sdl3::version::version();
        format!("{}.{}.{}", version.major, version.minor, version.patch)
    }

    /// The video driver SDL actually chose. Useful in logs, and the only way a
    /// test can assert *which* WSI it exercised.
    pub fn driver(&self) -> &'static str {
        self.video.current_video_driver()
    }
}

impl Drop for HostWindow {
    fn drop(&mut self) {
        // The surface and instance are the host's, and go first: an adapter
        // destroyed after them would be holding handles into freed state.
        // `main` orders `teardown_adapters` before this, and the ordering is
        // restated here because the drop is what makes it fatal to get wrong.
        if let (Some(instance), Some(entry), Some(surface)) =
            (self.instance.take(), self.entry.as_ref(), self.surface.take())
        {
            let loader = ash::khr::surface::Instance::new(entry, &instance);
            // SAFETY: created by this object, not yet destroyed, and no adapter
            // holds it — `teardown_adapters` runs first.
            unsafe {
                loader.destroy_surface(vk::SurfaceKHR::from_raw(surface.surface), None);
                instance.destroy_instance(None);
            }
        }
    }
}
