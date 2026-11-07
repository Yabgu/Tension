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
    /// Kept alive for the process's lifetime: dropping `Sdl` calls `SDL_Quit`,
    /// which tears down the video subsystem under every window that outlives it.
    _sdl: sdl3::Sdl,
    /// Cheap to clone; holds the video subsystem alive.
    video: sdl3::VideoSubsystem,
    window: sdl3::video::Window,
    /// `Some` once `surface()` has succeeded.
    instance: Option<ash::Instance>,
    entry: Option<ash::Entry>,
    surface: Option<HostSurface>,
    /// The instance extensions SDL asked for, kept because they are the only
    /// record of *which* window-system interface this surface came from. A log
    /// line naming them answers "did we get Wayland or XWayland?" without a
    /// second query, and the probe asserts on them.
    extensions: Vec<String>,
    title: String,
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

        // Before any window: SDL has to know which Vulkan library the surface
        // call should use. See the module header on the two loaders.
        video
            .vulkan_load_library_default()
            .map_err(|e| PlatformError::NoVulkanSurface(e.to_string()))?;

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
            _sdl: sdl,
            video,
            window,
            instance: None,
            entry: None,
            surface: None,
            extensions: Vec::new(),
            title: title.to_string(),
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
        self.surface
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

    /// The window's current drawable size in pixels.
    pub fn size(&self) -> (u32, u32) {
        self.window.size()
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
