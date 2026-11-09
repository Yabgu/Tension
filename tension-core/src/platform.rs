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
//! dropping `ash::Entry::load()` for SDL's `vkGetInstanceProcAddr`.
//!
//! # Ownership
//!
//! The host owns the `VkInstance`; the renderer creates its own `VkDevice` from
//! it. So the instance must outlive every adapter, which is why
//! `HostWindow` is dropped after `teardown_adapters` in `main`.

use ash::vk;
use ash::vk::Handle;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;


// ── the control bus ──────────────────────────────────────────────────────────

/// Mirrors `tension_ctrl_msg` (ABI v6): one window-control message.
///
/// `source` is an *output* of the enqueue, not an input to it. [`ControlBus`]
/// stamps it, so a caller cannot claim to be the core and consume the reserved
/// capacity the core needs in order never to be starved.
#[repr(C)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct TensionCtrlMsg {
    pub kind: u32,
    pub visibility: u32,
    pub arg0: i32,
    pub arg1: i32,
    pub arg2: i32,
    pub arg3: i32,
    pub source: u32,
    pub reserved: u32,
}

const _: () = assert!(std::mem::size_of::<TensionCtrlMsg>() == 32);

/// `tension_ctrl_kind`. Kinds are additive; an unknown one is refused.
pub const CTRL_RESIZE: u32 = 1;

/// `tension_ctrl_visibility`.
pub const CTRL_CORE_ONLY: u32 = 0;
pub const CTRL_OBSERVABLE: u32 = 1;

/// `TENSION_CTRL_SRC_*` — stamped by the bus, never taken from a caller.
pub const CTRL_SRC_LAYER: u32 = 0;
pub const CTRL_SRC_CORE: u32 = 1;
pub const CTRL_SRC_GUEST: u32 = 2;

/// Total queue depth.
pub const CTRL_QUEUE_CAPACITY: usize = 16;
/// Slots only the core may use. Four is enough for a frame's worth of timer,
/// DPI and focus traffic and small enough that a guest cannot be starved of the
/// general twelve by anything the core does.
pub const CTRL_RESERVED_CORE: usize = 4;
/// Slots a layer or a guest may use.
pub const CTRL_GENERAL_CAPACITY: usize = CTRL_QUEUE_CAPACITY - CTRL_RESERVED_CORE;

// Compile-time, because these two numbers are the whole starvation argument and
// a later edit to either should fail the build rather than quietly make the
// reservation meaningless.
const _: () = assert!(CTRL_RESERVED_CORE > 0);
const _: () = assert!(CTRL_RESERVED_CORE < CTRL_QUEUE_CAPACITY);
const _: () = assert!(CTRL_GENERAL_CAPACITY + CTRL_RESERVED_CORE == CTRL_QUEUE_CAPACITY);

/// Why a control message was refused. Every variant maps to an errno at the
/// boundary; nothing is dropped silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlError {
    /// `kind` is not a value this build knows.
    UnknownKind,
    /// `reserved` was non-zero, so the message is not from this ABI's shape.
    Malformed,
    /// The caller's share of the queue is full.
    Full,
}

/// What the bus did with a core-sourced message.
///
/// The core is the one source that must never be dropped, so when both its
/// reserved slots and the general region are full it does not queue: it returns
/// the message to the caller to apply directly. That is only legal on the
/// window's own thread, which is where every core post originates — `host_loop`,
/// after the pump. The enum exists so the caller cannot forget that case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreAdmission {
    Queued,
    ApplyNow(TensionCtrlMsg),
}

/// One queue, three sources, one executor.
///
/// A single deque rather than one per source: arrival order across sources is
/// then the order things actually happened, which is one rule instead of three.
/// Reservation is expressed as an admission test on the non-core count, not as
/// a second queue, so that ordering survives.
#[derive(Debug, Default)]
pub struct ControlBus {
    inner: Mutex<BusState>,
}

#[derive(Debug, Default)]
struct BusState {
    entries: VecDeque<TensionCtrlMsg>,
    /// How many queued entries came from a source other than the core. Never
    /// more than [`CTRL_GENERAL_CAPACITY`], which is what keeps four slots free.
    non_core: usize,
    posted: u64,
    applied: u64,
    refused: u64,
}

/// What the bus has done, for the probe and for a startup line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ControlStats {
    pub posted: u64,
    pub applied: u64,
    pub refused: u64,
    pub queued: usize,
}

impl ControlBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate and stamp one message, then admit it.
    ///
    /// `claimed_source` is what the caller says it is; it is overwritten. The
    /// caller's claim is never consulted, which is why forging it is pointless
    /// rather than merely discouraged.
    fn admit(&self, msg: &TensionCtrlMsg, source: u32) -> Result<CoreAdmission, ControlError> {
        if msg.kind != CTRL_RESIZE {
            return Err(ControlError::UnknownKind);
        }
        if msg.reserved != 0 {
            return Err(ControlError::Malformed);
        }

        let mut stamped = *msg;
        stamped.source = source;

        let mut state = self.inner.lock().expect("the control mutex is never poisoned");

        let admitted = if source == CTRL_SRC_CORE {
            // Reserved slots first, then the general region: the core may use
            // the whole queue, because it is the source that cannot be starved.
            if state.entries.len() < CTRL_QUEUE_CAPACITY {
                state.entries.push_back(stamped);
                Ok(CoreAdmission::Queued)
            } else {
                // Both regions full. Apply now, on this thread.
                Ok(CoreAdmission::ApplyNow(stamped))
            }
        } else if state.non_core < CTRL_GENERAL_CAPACITY && state.entries.len() < CTRL_QUEUE_CAPACITY {
            state.entries.push_back(stamped);
            state.non_core += 1;
            Ok(CoreAdmission::Queued)
        } else {
            Err(ControlError::Full)
        };

        match admitted {
            Ok(_) => state.posted += 1,
            Err(_) => state.refused += 1,
        }
        admitted
    }

    /// A layer's post. Uses only the general region.
    pub fn post_layer(&self, msg: &TensionCtrlMsg) -> Result<(), ControlError> {
        self.admit(msg, CTRL_SRC_LAYER).map(|_| ())
    }

    /// A guest's post, from `tension::platform.control`. Uses only the general
    /// region, so a guest cannot starve the core or another guest's queue
    /// share beyond the twelve it may already use.
    pub fn post_guest(&self, msg: &TensionCtrlMsg) -> Result<(), ControlError> {
        self.admit(msg, CTRL_SRC_GUEST).map(|_| ())
    }

    /// The core's own post. May use any slot; returns `ApplyNow` when the queue
    /// is genuinely full.
    pub fn post_core(&self, msg: &TensionCtrlMsg) -> Result<CoreAdmission, ControlError> {
        self.admit(msg, CTRL_SRC_CORE)
    }

    /// Take everything queued, in arrival order.
    ///
    /// Swap-drain: the queue is replaced rather than iterated, so a producer on
    /// another thread never blocks on the executor and the executor never holds
    /// the lock while calling into SDL. This is the mechanism that makes
    /// `post_control` callable from any thread while the executor runs.
    pub fn drain(&self) -> Vec<TensionCtrlMsg> {
        let mut state = self.inner.lock().expect("the control mutex is never poisoned");
        let taken: Vec<TensionCtrlMsg> = state.entries.drain(..).collect();
        state.non_core = 0;
        state.applied += taken.len() as u64;
        taken
    }

    pub fn stats(&self) -> ControlStats {
        let state = self.inner.lock().expect("the control mutex is never poisoned");
        ControlStats {
            posted: state.posted,
            applied: state.applied,
            refused: state.refused,
            queued: state.entries.len(),
        }
    }
}

// ── the programmatic window API (ABI v7, guest-facing) ──────────────────────

/// What a created window's pixels are meant for. The value decides the flags
/// the window is created with, and on Windows the difference is load-bearing:
/// an `SDL_WINDOW_VULKAN` window makes SDL want a Vulkan loader, and a
/// D3D12-only machine need not have one.
///
/// The numbers are `TENSION_WINDOW_TARGET_*` in `tension_adapter.h`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowTarget {
    /// An ordinary window. No graphics API is promised anything.
    Plain,
    /// The window will be handed to `SDL_GPU`. On Linux SDL builds a Vulkan
    /// surface from an ordinary window; on Windows and macOS it uses D3D12 and
    /// Metal natively. No `VULKAN` flag either way.
    Gpu,
    /// The window will be handed to `SDL_Vulkan_CreateSurface`, which requires
    /// `SDL_WINDOW_VULKAN` at creation. What a renderer that wants the host's
    /// `VkSurfaceKHR` needs — Ogre-Next's external-surface path.
    Vulkan,
}

impl WindowTarget {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(WindowTarget::Plain),
            1 => Some(WindowTarget::Gpu),
            2 => Some(WindowTarget::Vulkan),
            _ => None,
        }
    }
}

/// `TENSION_WINDOW_MODE_*`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WindowMode {
    #[default]
    Windowed,
    Fullscreen,
    BorderlessFullscreen,
}

impl WindowMode {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(WindowMode::Windowed),
            1 => Some(WindowMode::Fullscreen),
            2 => Some(WindowMode::BorderlessFullscreen),
            _ => None,
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            WindowMode::Windowed => 0,
            WindowMode::Fullscreen => 1,
            WindowMode::BorderlessFullscreen => 2,
        }
    }
}

/// `TENSION_WINDOW_FLAG_*`. Named so a caller does not OR bare integers, and
/// `KNOWN` is what the shim validates against: a flag this build does not
/// define is refused rather than ignored, because a caller that asked for
/// always-on-top and silently did not get it has no way to find out.
pub mod window_flags {
    pub const RESIZABLE: u32 = 1 << 0;
    pub const DECORATED: u32 = 1 << 1;
    pub const ALWAYS_ON_TOP: u32 = 1 << 2;
    pub const HIDDEN: u32 = 1 << 3;
    pub const HIGH_DPI: u32 = 1 << 4;
    pub const KNOWN: u32 = RESIZABLE | DECORATED | ALWAYS_ON_TOP | HIDDEN | HIGH_DPI;
}

/// `TENSION_WINDOW_POS_CENTERED`: let the window system place the window. A
/// sentinel rather than 0, because 0 is the origin and a caller may mean it.
pub const WINDOW_POS_CENTERED: i32 = i32::MIN;

/// A window the guest — or an in-core renderer — asks the host to create.
///
/// One-shot: nothing caches this. After creation the facts live on the window
/// (`published_size`, the atomics), and a second copy would be a second thing
/// to keep in step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowConfig {
    pub target: WindowTarget,
    pub width: u32,
    pub height: u32,
    pub mode: WindowMode,
    pub flags: u32,
    /// `WINDOW_POS_CENTERED`, or an absolute desktop position.
    pub x: i32,
    pub y: i32,
    /// 0 means "no bound", matching the wire.
    pub min_width: u32,
    pub min_height: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub title: String,
}

impl Default for WindowConfig {
    fn default() -> Self {
        // What a caller that filled nothing in gets: a plain resizable window at
        // 1280x720 with a title, which is the shape every example wants.
        WindowConfig {
            target: WindowTarget::Plain,
            width: 1280,
            height: 720,
            mode: WindowMode::Windowed,
            flags: window_flags::RESIZABLE | window_flags::DECORATED | window_flags::HIGH_DPI,
            x: WINDOW_POS_CENTERED,
            y: WINDOW_POS_CENTERED,
            min_width: 0,
            min_height: 0,
            max_width: 0,
            max_height: 0,
            title: "Tension".to_string(),
        }
    }
}

/// A snapshot of the window's state, as `tension_window_info` carries it.
///
/// `width == 0` means "there is no window", which is the whole headless guard —
/// not an error. A guest's update loop reads this every frame and must not have
/// to special-case "no window" as a failure.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WindowInfo {
    /// Logical units: what a UI lays out in.
    pub width: u32,
    pub height: u32,
    /// Drawable pixels: what a render target is allocated at.
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// Display scale x 1000 (1000 = 1.0). An integer because this crosses the
    /// ABI and a float there is a rounding argument waiting to happen.
    pub dpi_scale_milli: u32,
    pub mode: WindowMode,
    pub focused: bool,
    pub minimized: bool,
    pub close_requested: bool,
}

/// The window id every created window has. One window per process is this
/// ABI's limit (`docs/known-limitations.md`), and ids are 1-based, so the
/// number is fixed rather than allocated.
pub const WINDOW_ID: u32 = 1;

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
    /// The request is legal but cannot be served now: a window already exists,
    /// or a renderer still holds the one being closed.
    Busy(String),
}

impl std::fmt::Display for PlatformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlatformError::Sdl(message) => write!(f, "sdl: {message}"),
            PlatformError::Vulkan(message) => write!(f, "vulkan: {message}"),
            PlatformError::NoVulkanSurface(message) => write!(f, "no vulkan surface: {message}"),
            PlatformError::Busy(message) => write!(f, "busy: {message}"),
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
    /// Drawable pixels, which on a high-DPI display is not `width`/`height`.
    /// Written by the pump from `PIXEL_SIZE_CHANGED` and read by `window_info`;
    /// a renderer that allocates a target from the logical size draws a blurry
    /// frame on a 2x display.
    pixel_width: AtomicU32,
    pixel_height: AtomicU32,
    /// Display scale x 1000, so this can be an atomic without a float.
    dpi_scale_milli: AtomicU32,
    /// What the window system says, refreshed by the pump from the events SDL
    /// actually delivers. Initialised from the creation request, because a
    /// window created fullscreen may never emit ENTER_FULLSCREEN.
    fullscreen: AtomicBool,
    focused: AtomicBool,
    minimized: AtomicBool,
    /// Latched: once the user asks to close, it stays asked until the window is
    /// destroyed. A guest reading it every frame wants a state, not an edge.
    close_requested: AtomicBool,
    title: String,
    /// Last, so it outlives everything above it: `Sdl`'s drop calls `SDL_Quit`,
    /// which tears down the video subsystem under every window that outlived
    /// it. Never read — it is a lifetime anchor, and the leading underscore is
    /// the declaration of that rather than an oversight.
    _sdl: sdl3::Sdl,
}

impl HostWindow {
    /// Create a window for a renderer that will claim it, with the flags its
    /// target implies.
    ///
    /// Must be called from the main thread: `sdl3` refuses to initialise
    /// anywhere else (`sdl3::sdl::Sdl::new`), and that restriction is the
    /// portable one even though SDL 3.4 itself is more permissive. `SDL_GPU`'s
    /// `SDL_ClaimWindowForGPUDevice` carries the same rule, so creating and
    /// claiming on one thread falls out rather than being arranged.
    ///
    /// **`target` decides whether `SDL_WINDOW_VULKAN` is set, and it has to be
    /// decided here.** `SDL_Vulkan_CreateSurface` requires the flag, adding it
    /// later is not possible on every driver, and on Wayland the surface is a
    /// property of the window's creation. A `Gpu` window does not set it: SDL_GPU
    /// builds its own surface from an ordinary window on Linux and uses D3D12
    /// or Metal natively elsewhere, and on Windows asking for the flag makes SDL
    /// require a Vulkan loader a D3D12-only machine need not have.
    pub fn new(
        title: &str,
        width: u32,
        height: u32,
        target: WindowTarget,
    ) -> Result<Self, PlatformError> {
        let sdl = sdl3::init().map_err(|e| PlatformError::Sdl(e.to_string()))?;
        let video = sdl
            .video()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        // At most one alive, and `Sdl` owns the right to make it.
        let event_pump = sdl
            .event_pump()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        let mut flags = sdl3::video::WindowFlags::RESIZABLE
            | sdl3::video::WindowFlags::HIGH_PIXEL_DENSITY;
        if target == WindowTarget::Vulkan {
            flags |= sdl3::video::WindowFlags::VULKAN;
        }
        let mut builder = video.window(title, width, height);
        builder.set_flags(flags);
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
            pixel_width: AtomicU32::new(width),
            pixel_height: AtomicU32::new(height),
            dpi_scale_milli: AtomicU32::new(1000),
            fullscreen: AtomicBool::new(false),
            focused: AtomicBool::new(true),
            minimized: AtomicBool::new(false),
            close_requested: AtomicBool::new(false),
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
        // Vulkan: a `plain` or `gpu` window on a machine with no Vulkan should
        // open and report that nothing asked for a surface, not refuse to
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
                sdl3::event::Event::Quit { .. } => {
                    self.close_requested.store(true, Ordering::Relaxed);
                    events.close_requested = true;
                }
                sdl3::event::Event::Window {
                    win_event,
                    window_id: id,
                    ..
                } if id == window_id => {
                    self.apply_window_event(&mut events, win_event);
                }
                // A display's scale changed under the window (a monitor switch,
                // or the compositor's DPI setting). The scale belongs to the
                // display, so the event is display-scoped; the window just
                // re-reads its own.
                sdl3::event::Event::Display {
                    display_event: sdl3::event::DisplayEvent::ContentScaleChanged,
                    ..
                } => {
                    let scale = (self.window.display_scale() * 1000.0).round() as u32;
                    self.dpi_scale_milli.store(scale.max(1), Ordering::Relaxed);
                }
                _ => {}
            }
        }

        events
    }

    /// One window event against this window's state.
    ///
    /// Split out of [`pump`] so the pump stays one readable loop, and so every
    /// arm here is visibly "an atomic updated from an event" — the contract
    /// `window_info` depends on. Nothing here calls SDL except the DPI read,
    /// which is why the caller has already established this is the window's
    /// thread.
    fn apply_window_event(&self, events: &mut PlatformEvents, event: sdl3::event::WindowEvent) {
        use sdl3::event::WindowEvent;
        match event {
            WindowEvent::CloseRequested => {
                // Latched, not an edge: a guest polling `window_info` wants to
                // know the user asked, not that they asked once.
                self.close_requested.store(true, Ordering::Relaxed);
                events.close_requested = true;
            }
            WindowEvent::Resized(width, height) => {
                // Logical size. The drawable size arrives separately, as
                // `PixelSizeChanged`, and is what a swapchain is built from.
                let (width, height) = (width.max(0) as u32, height.max(0) as u32);
                if width > 0 && height > 0 {
                    self.width.store(width, Ordering::Relaxed);
                    self.height.store(height, Ordering::Relaxed);
                    events.resized = Some((width, height));
                }
            }
            WindowEvent::PixelSizeChanged(width, height) => {
                let (width, height) = (width.max(0) as u32, height.max(0) as u32);
                if width > 0 && height > 0 {
                    self.pixel_width.store(width, Ordering::Relaxed);
                    self.pixel_height.store(height, Ordering::Relaxed);
                }
            }
            WindowEvent::EnterFullscreen => self.fullscreen.store(true, Ordering::Relaxed),
            WindowEvent::LeaveFullscreen => self.fullscreen.store(false, Ordering::Relaxed),
            WindowEvent::FocusGained => self.focused.store(true, Ordering::Relaxed),
            WindowEvent::FocusLost => self.focused.store(false, Ordering::Relaxed),
            WindowEvent::Minimized => self.minimized.store(true, Ordering::Relaxed),
            WindowEvent::Restored | WindowEvent::Maximized => {
                self.minimized.store(false, Ordering::Relaxed)
            }
            _ => {}
        }
    }

    /// The window's state as one snapshot, from the atomics only.
    ///
    /// Safe from any thread: no SDL call, no lock, no allocation. A renderer's
    /// frame loop and a guest's update loop both read it, from different
    /// threads, which is exactly why the fields are atomics.
    pub fn info(&self) -> WindowInfo {
        let (width, height) = (self.width.load(Ordering::Relaxed), self.height.load(Ordering::Relaxed));
        let (pixel_width, pixel_height) = (
            self.pixel_width.load(Ordering::Relaxed),
            self.pixel_height.load(Ordering::Relaxed),
        );
        WindowInfo {
            width,
            height,
            // A driver that never sends PIXEL_SIZE_CHANGED leaves these at the
            // creation size, which equals the logical size on a 1x display. That
            // is the honest answer rather than zero: a renderer allocating from
            // zero pixels fails, and the fallback is the size the window asked
            // for.
            pixel_width: if pixel_width == 0 { width } else { pixel_width },
            pixel_height: if pixel_height == 0 { height } else { pixel_height },
            dpi_scale_milli: self.dpi_scale_milli.load(Ordering::Relaxed),
            mode: if self.fullscreen.load(Ordering::Relaxed) {
                WindowMode::Fullscreen
            } else {
                WindowMode::Windowed
            },
            focused: self.focused.load(Ordering::Relaxed),
            minimized: self.minimized.load(Ordering::Relaxed),
            close_requested: self.close_requested.load(Ordering::Relaxed),
        }
    }

    /// The window's current drawable size in pixels, read from SDL.
    ///
    /// Main thread only (it calls into SDL). Everything else reads
    /// `published_size`, which is an atomic read.
    pub fn size(&self) -> (u32, u32) {
        self.window.size()
    }

    /// The `sdl3` window, for a renderer that has to claim it.
    ///
    /// `pub(crate)` is the whole of the safety argument. An adapter reaches this
    /// type only as two `u64`s across the C ABI — it never holds a `HostWindow`
    /// — so widening this to `pub` could not widen an adapter's reach. But a
    /// *core* module can hold one, and the 2D renderer must: `SDL_GPU` has no
    /// external-surface API, so the only way it can present to the host's window
    /// is to claim that window by handle (`SDL_ClaimWindowForGPUDevice`).
    ///
    /// The rule this does **not** break: no layer and no guest calls
    /// `SDL_SetWindow*`. Claiming is not setting, and the setters stay behind
    /// `apply_control`.
    pub(crate) fn sdl_window(&self) -> &sdl3::video::Window {
        &self.window
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

    /// Apply one control message.
    ///
    /// **The executor.** This is the only path by which a layer or a guest can
    /// change the window, and it runs on the window's own thread because
    /// `HostWindow` is not `Sync` and the bus hands messages to whoever holds
    /// one. A `CORE_ONLY` message is handled and leaves nothing to observe,
    /// which is exactly why the bus reserves capacity for the core: a dropped
    /// `CORE_ONLY` would be undetectable.
    pub fn apply_control(&mut self, msg: &TensionCtrlMsg) -> Result<(), PlatformError> {
        match msg.kind {
            CTRL_RESIZE => {
                let width = msg.arg0.max(1) as u32;
                let height = msg.arg1.max(1) as u32;
                self.window
                    .set_size(width, height)
                    .map_err(|e| PlatformError::Sdl(e.to_string()))?;
                // The resize *event* may arrive later; publish now so a guest
                // polling on the next frame sees the size it asked for rather
                // than a stale one, and let the event correct it if the window
                // system clamps.
                if msg.visibility == CTRL_OBSERVABLE {
                    self.width.store(width, Ordering::Relaxed);
                    self.height.store(height, Ordering::Relaxed);
                }
                Ok(())
            }
            other => Err(PlatformError::Sdl(format!("unknown control kind {other}"))),
        }
    }

    /// Put the window into or out of fullscreen.
    ///
    /// **Main thread only.** Where `apply_control` is the path a *layer* takes,
    /// this is the path the host itself takes at creation, on the thread that
    /// made the window. The pump keeps `info().mode` true from the events SDL
    /// emits when the switch completes.
    pub fn set_fullscreen(&mut self, on: bool) -> Result<(), PlatformError> {
        self.window
            .set_fullscreen(on)
            .map_err(|e| PlatformError::Sdl(e.to_string()))
    }

    /// Window chrome on or off. Returns `false` when the driver refused; that is
    /// a hint no driver owes us, so it is not an error.
    pub fn set_bordered(&mut self, bordered: bool) -> bool {
        self.window.set_bordered(bordered)
    }

    /// Resize bounds. 0 in either dimension means "no bound" on the wire, and a
    /// caller that means it does not call this.
    pub fn set_min_size(&mut self, width: u32, height: u32) -> Result<(), PlatformError> {
        self.window
            .set_minimum_size(width, height)
            .map_err(|e| PlatformError::Sdl(format!("{e:?}")))
    }

    pub fn set_max_size(&mut self, width: u32, height: u32) -> Result<(), PlatformError> {
        self.window
            .set_maximum_size(width, height)
            .map_err(|e| PlatformError::Sdl(format!("{e:?}")))
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

/// Create the host's window from a guest's (or a renderer's) request.
///
/// One window per process: a second request is [`PlatformError::Busy`] rather
/// than a replacement, because a replacement would silently orphan a renderer's
/// claim on the first one. Closing first is the caller's move.
///
/// **Main thread only** — it calls `SDL_CreateWindow`, and every later call on
/// the window must be from the same thread.
pub fn create_window(
    slot: &mut Option<HostWindow>,
    config: &WindowConfig,
) -> Result<u32, PlatformError> {
    if slot.is_some() {
        return Err(PlatformError::Busy(
            "the host already owns a window; close it before creating another".to_string(),
        ));
    }
    if config.width == 0 || config.height == 0 {
        return Err(PlatformError::Sdl(format!(
            "a window cannot be {}x{}",
            config.width, config.height
        )));
    }

    let mut window = HostWindow::new(&config.title, config.width, config.height, config.target)?;

    // Mode is applied after creation, because SDL's fullscreen flags are a
    // state transition rather than a creation parameter on every driver:
    // `SDL_SetWindowFullscreen` picks the display, clamps to its mode, and emits
    // ENTER_FULLSCREEN — the event the pump latches. Doing it here keeps the
    // window's own record true from the first frame, even on a driver that never
    // emits the event for a window born fullscreen.
    match config.mode {
        WindowMode::Windowed => {}
        WindowMode::Fullscreen => {
            window.set_fullscreen(true)?;
            window.fullscreen.store(true, Ordering::Relaxed);
        }
        WindowMode::BorderlessFullscreen => {
            window.set_fullscreen(true)?;
            window.fullscreen.store(true, Ordering::Relaxed);
            // Borderless is the window system's decoration, not the mode: the
            // request is "fullscreen with no chrome".
            window.set_bordered(false);
        }
    }

    if config.min_width > 0 && config.min_height > 0 {
        window.set_min_size(config.min_width, config.min_height)?;
    }
    if config.max_width > 0 && config.max_height > 0 {
        window.set_max_size(config.max_width, config.max_height)?;
    }

    *slot = Some(window);
    Ok(WINDOW_ID)
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
