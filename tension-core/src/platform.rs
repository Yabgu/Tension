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
/// Pointer confinement, on or off (arg0: 0 disables, 1 enables). A layer's way
/// of asking for relative mouse mode without ever seeing the `SDL_Window`: the
/// call itself is the executor's (`apply_control`), on the window's thread, and
/// it is the only place `SDL_SetWindowRelativeMouseMode` is reached.
pub const CTRL_RELATIVE_MOUSE: u32 = 2;

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
        if msg.kind != CTRL_RESIZE && msg.kind != CTRL_RELATIVE_MOUSE {
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
    /// The window system's own handle for the window — an X11 `Window` (XID) on
    /// X11, an `HWND` on Win32 — or 0 where there is no such handle (Wayland,
    /// macOS, headless drivers).
    ///
    /// This is what a renderer that cannot adopt a `VkSurfaceKHR` adopts
    /// instead: Ogre's GL3+ plugin takes it as `parentWindowHandle` and draws
    /// inside the host's window. Two renderers, one window, and the second one
    /// never gets to create a window of its own.
    pub native_handle: u64,
    /// Current drawable size in pixels.
    pub width: u32,
    pub height: u32,
}

// ── the event wire (ABI v7) ──────────────────────────────────────────────────
//
// A capability does not own SDL's event queue: the host initialises the video
// subsystem, owns the window, and pumps on the thread that did so. A capability
// that wants events registers a *layer* and receives batches, synchronously,
// once per pump. `tension_adapter.h`'s event-wire block is the argument; this is
// the Rust half, and the two are pinned against each other by exact size and
// offset assertions on both sides.

/// Event families — `TENSION_EVENT_*`. One per event, and a layer's mask is a
/// bitwise OR of them.
pub const EVENT_QUIT: u32 = 1;
pub const EVENT_WINDOW: u32 = 2;
pub const EVENT_KEY: u32 = 4;
pub const EVENT_TEXT: u32 = 8;
pub const EVENT_MOUSE_MOTION: u32 = 16;
pub const EVENT_MOUSE_BUTTON: u32 = 32;
pub const EVENT_MOUSE_WHEEL: u32 = 64;
pub const EVENT_PAD: u32 = 128;

/// Every family this build defines. A registration whose mask names anything
/// outside this is refused rather than silently subscribed to nothing.
pub const EVENT_FAMILIES_KNOWN: u32 = EVENT_QUIT
    | EVENT_WINDOW
    | EVENT_KEY
    | EVENT_TEXT
    | EVENT_MOUSE_MOTION
    | EVENT_MOUSE_BUTTON
    | EVENT_MOUSE_WHEEL
    | EVENT_PAD;

/// `TENSION_EVENT_WINDOW`'s subtype, in `a0`.
pub const WINDOW_EVENT_RESIZED: u32 = 1;
pub const WINDOW_EVENT_PIXEL_SIZE_CHANGED: u32 = 2;
pub const WINDOW_EVENT_FOCUS_GAINED: u32 = 3;
pub const WINDOW_EVENT_FOCUS_LOST: u32 = 4;
pub const WINDOW_EVENT_MINIMIZED: u32 = 5;
pub const WINDOW_EVENT_RESTORED: u32 = 6;
pub const WINDOW_EVENT_ENTER_FULLSCREEN: u32 = 7;
pub const WINDOW_EVENT_LEAVE_FULLSCREEN: u32 = 8;
pub const WINDOW_EVENT_CLOSE_REQUESTED: u32 = 9;
/// The pointer entered or left the window. Added in v7b, when the input
/// capability moved onto the dispatcher: it keeps `POINTER_OVER` in its state
/// record, and the four original subtypes could not say this. Additive — no
/// struct changed and nothing was renumbered.
pub const WINDOW_EVENT_MOUSE_ENTER: u32 = 10;
pub const WINDOW_EVENT_MOUSE_LEAVE: u32 = 11;

/// `TENSION_EVENT_KEY`'s `flags` bits. The direction is a flag rather than a
/// second subtype so a consumer tests one word for "is this a press".
pub const KEY_FLAG_DOWN: u32 = 1;
pub const KEY_FLAG_REPEAT: u32 = 2;

/// `TENSION_EVENT_PAD`'s subtype, in `a0`.
pub const PAD_EVENT_ADDED: u32 = 1;
pub const PAD_EVENT_REMOVED: u32 = 2;
pub const PAD_EVENT_BUTTON_DOWN: u32 = 3;
pub const PAD_EVENT_BUTTON_UP: u32 = 4;
pub const PAD_EVENT_AXIS: u32 = 5;

// ── the modifier bits (`TENSION_EVENT_KEY`'s `a2`) ──────────────────────────
//
// The wire's own numbering, not SDL's: a guest is not linked against SDL and
// reading its `SDL_Keymod` constants would be a dependency it cannot see. The
// translation is `key_mod_bits` below, and it is the only place the two
// vocabularies meet.
pub const KEY_MOD_SHIFT: u32 = 1 << 0;
pub const KEY_MOD_CTRL: u32 = 1 << 1;
pub const KEY_MOD_ALT: u32 = 1 << 2;
pub const KEY_MOD_SUPER: u32 = 1 << 3;
pub const KEY_MOD_CAPS: u32 = 1 << 4;
pub const KEY_MOD_NUM: u32 = 1 << 5;
pub const KEY_MOD_MODE: u32 = 1 << 6;

/// How many UTF-8 bytes one `TENSION_EVENT_TEXT` carries inline.
pub const EVENT_TEXT_BYTES: usize = 32;

/// SDL's `SDL_Keymod` word as the wire's bits.
///
/// Both `L*` and `R*` halves collapse into one bit: a guest that asks "is shift
/// held" is asking about the keyboard, not about a hand. Caps and Num stay
/// distinct because they are latching states a text field may want to draw.
pub fn key_mod_bits(keymod: sdl3::keyboard::Mod) -> u32 {
    use sdl3::keyboard::Mod;
    let mut bits = 0u32;
    if keymod.intersects(Mod::LSHIFTMOD | Mod::RSHIFTMOD) {
        bits |= KEY_MOD_SHIFT;
    }
    if keymod.intersects(Mod::LCTRLMOD | Mod::RCTRLMOD) {
        bits |= KEY_MOD_CTRL;
    }
    if keymod.intersects(Mod::LALTMOD | Mod::RALTMOD) {
        bits |= KEY_MOD_ALT;
    }
    if keymod.intersects(Mod::LGUIMOD | Mod::RGUIMOD) {
        bits |= KEY_MOD_SUPER;
    }
    if keymod.contains(Mod::CAPSMOD) {
        bits |= KEY_MOD_CAPS;
    }
    if keymod.contains(Mod::NUMMOD) {
        bits |= KEY_MOD_NUM;
    }
    if keymod.contains(Mod::MODEMOD) {
        bits |= KEY_MOD_MODE;
    }
    bits
}

/// How many events one pump may translate. A batch larger than this in a single
/// drain is not a frame's input; the excess is counted and reported rather than
/// silently allocating, because this runs inside the frame's own budget.
pub const EVENT_BATCH_CAPACITY: usize = 256;

/// `TENSION_MAX_EVENT_LAYERS`: how many layers one host serves.
pub const TENSION_MAX_EVENT_LAYERS: usize = 8;

/// `TENSION_PAD_SLOTS`: how many gamepad slots the host serves. The record and
/// the slot arrived with ABI v7; the host opens pads from v7b's pump.
pub const PAD_SLOTS: u32 = 8;

/// `TENSION_PAD_RECORD_VERSION` / `TENSION_PAD_RECORD_ATTACHED`, the two words
/// of a slot record the host writes.
pub const PAD_RECORD_VERSION: u32 = 1;
pub const PAD_RECORD_ATTACHED: u32 = 1;

/// Mirrors `tension_event`: one event, 40 bytes, 8-byte alignment.
#[repr(C)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct TensionEvent {
    pub family: u32,
    pub flags: u32,
    pub a0: i64,
    pub a1: i64,
    pub a2: i64,
    pub a3: i64,
}

impl TensionEvent {
    /// A zeroed event, for the pump's stack buffer: `[TensionEvent::EMPTY; N]`
    /// is only possible with a `const` value, which `Default` is not.
    pub const EMPTY: Self = Self {
        family: 0,
        flags: 0,
        a0: 0,
        a1: 0,
        a2: 0,
        a3: 0,
    };

    pub const fn new(family: u32, flags: u32, a0: i64, a1: i64, a2: i64, a3: i64) -> Self {
        Self {
            family,
            flags,
            a0,
            a1,
            a2,
            a3,
        }
    }
}

const _: () = assert!(std::mem::size_of::<TensionEvent>() == 40);
const _: () = assert!(std::mem::offset_of!(TensionEvent, a0) == 8);

/// A layer's `dispatch`: a batch of the events whose families its mask names.
///
/// # Safety
///
/// `events` is valid for `count` reads for the duration of the call. The callee
/// must not retain it.
pub type EventDispatchFn =
    unsafe extern "C" fn(*mut std::ffi::c_void, *const TensionEvent, u32) -> i32;

/// A layer's `shutdown`, called once when the dispatcher is torn down.
///
/// # Safety
///
/// `layer_user` is the token this host issued, still valid at the call.
pub type EventShutdownFn = unsafe extern "C" fn(*mut std::ffi::c_void);

/// Mirrors `tension_event_layer`: one subscription, 32 bytes.
#[repr(C)]
#[derive(Copy, Clone)]
pub struct TensionEventLayer {
    pub struct_size: u32,
    pub reserved: u32,
    pub event_mask: u32,
    pub reserved2: u32,
    pub dispatch: Option<EventDispatchFn>,
    pub shutdown: Option<EventShutdownFn>,
}

const _: () = assert!(std::mem::size_of::<TensionEventLayer>() == 32);
const _: () = assert!(std::mem::offset_of!(TensionEventLayer, dispatch) == 16);

/// Mirrors `tension_pad_record`: one gamepad slot, 48 bytes.
#[repr(C)]
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct TensionPadRecord {
    pub version: u32,
    pub flags: u32,
    pub buttons: u32,
    pub reserved0: u32,
    pub axes: [f32; 6],
    pub reserved1: u64,
}

const _: () = assert!(std::mem::size_of::<TensionPadRecord>() == 48);
const _: () = assert!(std::mem::offset_of!(TensionPadRecord, axes) == 16);

/// Every gamepad slot the host serves, as of the last pump.
///
/// `present` is a bitmask rather than a `bool` per slot so a reader takes one
/// lock for the whole answer: a slot's record and its liveness can then never
/// disagree, which a per-slot cell could be caught in the middle of.
#[derive(Clone, Debug)]
pub struct PadMirror {
    pub present: u32,
    pub records: [TensionPadRecord; PAD_SLOTS as usize],
}

impl PadMirror {
    pub const EMPTY: Self = Self {
        present: 0,
        records: [TensionPadRecord {
            version: 0,
            flags: 0,
            buttons: 0,
            reserved0: 0,
            axes: [0.0; 6],
            reserved1: 0,
        }; PAD_SLOTS as usize],
    };
}

impl Default for PadMirror {
    fn default() -> Self {
        Self::EMPTY
    }
}

/// Mirrors `tension_window_info`: what `host_window_info` writes, 40 bytes.
///
/// The guest's `tension::platform.window_info` writes this same record to guest
/// memory, and this is the adapter-facing copy of it — one layout, two
/// destinations. `mode` is the ABI's number (`WindowMode::as_u32`), not the
/// Rust enum, because the wire is what both sides agreed on.
#[repr(C)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct TensionWindowInfo {
    pub struct_size: u32,
    pub width: u32,
    pub height: u32,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub dpi_scale_milli: u32,
    pub mode: u32,
    pub focused: u32,
    pub minimized: u32,
    pub close_requested: u32,
}

const _: () = assert!(std::mem::size_of::<TensionWindowInfo>() == 40);

impl TensionWindowInfo {
    /// The record for "the host owns no window": every field zero, **including**
    /// `struct_size`, which is what a caller that checks nothing will see as a
    /// zeroed record rather than a live window of size 0.
    pub const EMPTY: Self = Self {
        struct_size: 0,
        width: 0,
        height: 0,
        pixel_width: 0,
        pixel_height: 0,
        dpi_scale_milli: 0,
        mode: 0,
        focused: 0,
        minimized: 0,
        close_requested: 0,
    };

    /// One live window's record.
    pub fn from_info(info: &WindowInfo) -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            width: info.width,
            height: info.height,
            pixel_width: info.pixel_width,
            pixel_height: info.pixel_height,
            dpi_scale_milli: info.dpi_scale_milli,
            mode: info.mode.as_u32(),
            focused: u32::from(info.focused),
            minimized: u32::from(info.minimized),
            close_requested: u32::from(info.close_requested),
        }
    }

    /// The record as the wire spells it: ten `u32`s, little-endian, in
    /// declaration order.
    ///
    /// **This is the only encoder.** The guest import
    /// (`tension::platform.window_info`) and the adapter slot
    /// (`host_window_info`) both write through this function, so a field added
    /// here cannot land in one destination and miss the other — which is what
    /// had happened: the guest shim hand-built a `[u32; 9]` plus a separate
    /// word while this struct was the adapter's copy of the same layout.
    ///
    /// Byte order is fixed rather than `repr(C)`-memcpy'd: the guest is wasm
    /// and reads little-endian by definition, and an explicit table is a place
    /// where a field's position is visible in one screen rather than inferred
    /// from a struct declaration plus padding rules.
    pub fn to_wire_bytes(&self) -> [u8; 40] {
        let fields = [
            self.struct_size,
            self.width,
            self.height,
            self.pixel_width,
            self.pixel_height,
            self.dpi_scale_milli,
            self.mode,
            self.focused,
            self.minimized,
            self.close_requested,
        ];
        let mut out = [0u8; 40];
        for (index, value) in fields.iter().enumerate() {
            out[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        out
    }
}

/// One `tension_window_info`, on the wire, for "this window" or "no window".
///
/// `None` is the zeroed record — **including** `struct_size`, which is the
/// convention that makes `width > 0` the whole headless test for a guest and a
/// capability alike.
pub fn encode_window_info(info: Option<&WindowInfo>) -> [u8; 40] {
    info.map(TensionWindowInfo::from_info)
        .unwrap_or(TensionWindowInfo::EMPTY)
        .to_wire_bytes()
}

/// One registered layer, as the bus keeps it.
///
/// The token is a `usize`, not a raw pointer, for the same reason
/// `AdapterHost::ctx` is: the bus is shared by `Arc<Mutex<..>>` and therefore
/// has to be `Send`, which a `*mut c_void` is not. Nothing dereferences it — it
/// is an opaque 1-based handle, exactly as rule 2 describes ids.
#[derive(Copy, Clone)]
struct RegisteredLayer {
    token: usize,
    mask: u32,
    dispatch: EventDispatchFn,
    shutdown: Option<EventShutdownFn>,
    /// Set once a non-zero `dispatch` return has been logged, so a layer that
    /// reports the same failure every frame is one line rather than sixty a
    /// second.
    logged_error: bool,
}

impl RegisteredLayer {
    const EMPTY: Self = Self {
        token: 0,
        mask: 0,
        // Never called: `LayerSnapshot::dispatch` walks only `len` entries.
        dispatch: no_dispatch,
        shutdown: None,
        logged_error: false,
    };
}

/// The placeholder for unused snapshot slots. It is never invoked — a snapshot
/// carries a length, and only entries below it are dispatched — but it must be
/// *some* function, and a loud one is better than a fabricated address.
unsafe extern "C" fn no_dispatch(_: *mut std::ffi::c_void, _: *const TensionEvent, _: u32) -> i32 {
    -38 // -ENOSYS: an empty slot was dispatched, which is a bug in this module
}

/// The layer table, copied out of the bus so the mutex can be released before
/// any adapter code runs.
///
/// **This copy is what makes the dispatcher deadlock-free.** A layer may call
/// `post_event` and `post_control` from its dispatch (rule 13 allows both, and
/// input needs them). If the bus's mutex were still held, a layer that called
/// `register_event_layer` would block on the same lock the dispatcher is
/// holding — on one thread, which is a deadlock, not a refusal. Copying the
/// table means the lock is free for the whole dispatch, and the `dispatching`
/// flag inside the bus (checked under that lock) is what turns a re-entrant
/// registration into `-EBUSY`.
#[derive(Copy, Clone)]
pub struct LayerSnapshot {
    layers: [RegisteredLayer; TENSION_MAX_EVENT_LAYERS],
    len: usize,
}

impl LayerSnapshot {
    /// How many layers the snapshot holds.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Hand `events` to every layer whose mask names at least one of their
    /// families, and record each layer's non-zero return in `failed`.
    ///
    /// One `dispatch` call per layer per pump, with only that layer's events —
    /// the filtering is the host's, so a layer cannot receive a family it did
    /// not subscribe to even if it asks. Returns the number of layers called.
    ///
    /// **Main thread, outside any guest call** (rule 13). The caller must not
    /// hold the bus's lock.
    pub fn dispatch(&self, events: &[TensionEvent], failed: &mut [bool; TENSION_MAX_EVENT_LAYERS]) -> u32 {
        if events.is_empty() {
            return 0;
        }
        let mut filtered = [TensionEvent::EMPTY; EVENT_BATCH_CAPACITY];
        let mut called = 0u32;
        for index in 0..self.len {
            let layer = self.layers[index];
            let mut count = 0usize;
            for event in events {
                if layer.mask & event.family != 0 && count < filtered.len() {
                    filtered[count] = *event;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            // SAFETY: `layer.dispatch` is a function pointer this host validated
            // at registration (non-null), `filtered` is a live stack array of
            // `count` initialised events, and `layer.token` is the token this
            // host issued for that layer.
            let status = unsafe { (layer.dispatch)(layer.token as *mut std::ffi::c_void, filtered.as_ptr(), count as u32) };
            failed[index] = status != 0;
            called += 1;
        }
        called
    }
}

/// A window event with no payload beyond its subtype.
///
/// `pub` so a probe can assert the wire's encoding without a device: this is the
/// translation contract, and a test that needs a compositor to check a constant
/// is a test that will be skipped exactly where it matters.
pub fn window_state_event(subtype: u32) -> TensionEvent {
    TensionEvent::new(EVENT_WINDOW, 0, subtype as i64, 0, 0, 0)
}

/// Append one event to the pump's batch, counting what does not fit.
///
/// A separate function rather than a closure so the pump's loop keeps `self`
/// borrowable: a closure capturing `count` and `overflow` mutably cannot also
/// call `self.apply_window_event`.
fn push_event(
    batch: &mut [TensionEvent; EVENT_BATCH_CAPACITY],
    count: &mut usize,
    overflow: &mut u32,
    event: TensionEvent,
) {
    if *count < batch.len() {
        batch[*count] = event;
        *count += 1;
    } else {
        *overflow += 1;
    }
}

/// One key event on the wire: `a0` scancode, `a1` keycode, `a2` modifiers,
/// `a3` repeat, and the direction in `flags`.
///
/// `pub` for the same reason as [`window_state_event`]: the encoding is the
/// contract, and a probe can only check it without a keyboard this way.
pub fn key_event(
    down: bool,
    keycode: Option<sdl3::keyboard::Keycode>,
    scancode: Option<sdl3::keyboard::Scancode>,
    keymod: sdl3::keyboard::Mod,
    repeat: bool,
) -> TensionEvent {
    let mut flags = 0u32;
    if down {
        flags |= KEY_FLAG_DOWN;
    }
    if repeat {
        flags |= KEY_FLAG_REPEAT;
    }
    TensionEvent::new(
        EVENT_KEY,
        flags,
        scancode.map(|code| code as i32 as i64).unwrap_or(0),
        keycode.map(|code| code as u32 as i64).unwrap_or(0),
        key_mod_bits(keymod) as i64,
        if repeat { 1 } else { 0 },
    )
}

/// One 8-byte word of a text payload, little-endian, zero-padded.
///
/// `TENSION_EVENT_TEXT` carries UTF-8 inline across four of these, so this is
/// where a chunk of bytes becomes the wire's words. A short chunk pads with
/// zeroes, which is unambiguous because `flags` — not a NUL — is the length.
pub fn text_word(bytes: &[u8], offset: usize) -> i64 {
    let mut word: u64 = 0;
    for index in 0..8 {
        let byte = bytes.get(offset + index).copied().unwrap_or(0);
        word |= (byte as u64) << (index * 8);
    }
    word as i64
}

/// One mouse-button event: `a0` button, `a1` down, `a2` clicks, `a3` the mask
/// after the change, and the device id in `flags`.
///
/// The mask is read from SDL rather than tracked here: a button held when the
/// window opened is in SDL's answer and not in any sequence of events this pump
/// has seen. It is a call, but `SDL_GetMouseState` touches no window state and
/// this is already the window's thread.
fn button_event(
    down: bool,
    which: u32,
    button: sdl3::mouse::MouseButton,
    clicks: u8,
    pump: &sdl3::EventPump,
) -> TensionEvent {
    let mask = sdl3::mouse::MouseState::new(pump).to_sdl_state();
    TensionEvent::new(
        EVENT_MOUSE_BUTTON,
        which,
        button as u8 as i64,
        if down { 1 } else { 0 },
        clicks as i64,
        mask as i64,
    )
}

/// The dispatcher: who is subscribed, and whether a dispatch is in flight.
///
/// One per process, shared by `Arc<Mutex<..>>` between the window (which pumps
/// and dispatches) and the API table (which registers and unregisters).
#[derive(Default)]
pub struct EventBus {
    layers: Vec<RegisteredLayer>,
    /// 1-based, never reused: a freed token that came back would let a layer
    /// unregister somebody else's subscription.
    next_token: usize,
    /// True between `begin_dispatch` and `end_dispatch`.
    dispatching: bool,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate and admit one subscription, returning the token.
    ///
    /// # Safety
    ///
    /// `layer` must point to a readable `tension_event_layer` for the duration
    /// of the call. The struct is copied field by field and nothing is retained.
    pub unsafe fn register(&mut self, layer: *const TensionEventLayer) -> Result<usize, i32> {
        const EINVAL: i32 = -22;
        const ENOSPC: i32 = -28;
        const EBUSY: i32 = -16;

        if layer.is_null() {
            return Err(EINVAL);
        }
        let layer = unsafe { *layer };
        if (layer.struct_size as usize) < std::mem::size_of::<TensionEventLayer>()
            || layer.reserved != 0
            || layer.reserved2 != 0
            || layer.event_mask == 0
            || layer.event_mask & !EVENT_FAMILIES_KNOWN != 0
        {
            return Err(EINVAL);
        }
        let Some(dispatch) = layer.dispatch else {
            return Err(EINVAL);
        };
        // A registration from inside a dispatch would mutate the table the
        // snapshot was copied from, so it is refused. The bus is unlocked here
        // (see `LayerSnapshot`), which is what lets this be a refusal rather
        // than a deadlock.
        if self.dispatching {
            return Err(EBUSY);
        }
        if self.layers.len() >= TENSION_MAX_EVENT_LAYERS {
            return Err(ENOSPC);
        }
        let token = self.next_token + 1;
        self.next_token = token;
        self.layers.push(RegisteredLayer {
            token,
            mask: layer.event_mask,
            dispatch,
            shutdown: layer.shutdown,
            logged_error: false,
        });
        Ok(token)
    }

    /// Remove a subscription. `shutdown` is **not** called: see the header.
    pub fn unregister(&mut self, token: usize) -> Result<(), i32> {
        const EINVAL: i32 = -22;
        const EBUSY: i32 = -16;
        if self.dispatching {
            return Err(EBUSY);
        }
        let Some(index) = self.layers.iter().position(|layer| layer.token == token) else {
            return Err(EINVAL);
        };
        self.layers.remove(index);
        Ok(())
    }

    /// Copy the table out and mark a dispatch in flight.
    ///
    /// `None` when a dispatch is already running — a pump that somehow nests
    /// (it cannot today: both pump call sites are on one thread, sequentially)
    /// drops its batch rather than recursing into adapter code.
    pub fn begin_dispatch(&mut self) -> Option<LayerSnapshot> {
        if self.dispatching || self.layers.is_empty() {
            return None;
        }
        self.dispatching = true;
        let mut layers = [RegisteredLayer::EMPTY; TENSION_MAX_EVENT_LAYERS];
        layers[..self.layers.len()].copy_from_slice(&self.layers);
        Some(LayerSnapshot {
            layers,
            len: self.layers.len(),
        })
    }

    /// Close a dispatch and absorb each layer's result.
    pub fn end_dispatch(
        &mut self,
        snapshot: &LayerSnapshot,
        failed: &[bool; TENSION_MAX_EVENT_LAYERS],
    ) {
        self.dispatching = false;
        for index in 0..snapshot.len {
            if !failed[index] {
                continue;
            }
            let token = snapshot.layers[index].token;
            let Some(layer) = self.layers.iter_mut().find(|layer| layer.token == token) else {
                continue;
            };
            if !layer.logged_error {
                layer.logged_error = true;
                crate::logging::log(
                    crate::logging::Level::Warn,
                    "core",
                    &format!(
                        "event layer {} returned a non-zero status from dispatch; the frame is \
                         unaffected and this is logged once",
                        token
                    ),
                );
            }
        }
    }

    /// Take the table out, so `shutdown` can be called with no lock held.
    pub fn take_layers(&mut self) -> LayerSnapshot {
        let mut layers = [RegisteredLayer::EMPTY; TENSION_MAX_EVENT_LAYERS];
        let len = self.layers.len();
        layers[..len].copy_from_slice(&self.layers);
        self.layers.clear();
        self.dispatching = false;
        LayerSnapshot { layers, len }
    }

    /// How many layers are registered. For the probe and the startup line.
    pub fn len(&self) -> usize {
        self.layers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }
}

/// The state one host shares with its adapters: the dispatcher, and the window
/// record `host_window_info` serves.
///
/// One struct rather than two `Arc`s because both are written by the same
/// event — a pump updates the record and dispatches the batch — and a reader
/// that took them from different pumps could see a size the batch disagrees
/// with. `main` builds one, hands a clone to `AdapterHost` and another to the
/// window, and later to whatever window replaces it.
pub struct HostShared {
    pub events: Mutex<EventBus>,
    /// The window's state as of the last pump; `None` when no window exists.
    pub window: Mutex<Option<WindowInfo>>,
    /// Every gamepad slot as of the last pump. A *mirror*, not a live SDL read:
    /// `pad_state` is documented any-thread, and SDL's gamepad getters are not
    /// thread-safe, so the only honest any-thread answer is the one the window's
    /// thread sampled last.
    pub pads: Mutex<PadMirror>,
}

impl HostShared {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            events: Mutex::new(EventBus::new()),
            window: Mutex::new(None),
            pads: Mutex::new(PadMirror::EMPTY),
        })
    }

    /// Dispatch one batch, releasing the lock for the whole of it.
    ///
    /// Returns the number of layers called, and the number of layers whose
    /// dispatch returned non-zero.
    pub fn dispatch(&self, events: &[TensionEvent]) -> (u32, u32) {
        let snapshot = match self.events.lock() {
            Ok(mut bus) => bus.begin_dispatch(),
            Err(poisoned) => poisoned.into_inner().begin_dispatch(),
        };
        let Some(snapshot) = snapshot else {
            return (0, 0);
        };
        let mut failed = [false; TENSION_MAX_EVENT_LAYERS];
        let called = snapshot.dispatch(events, &mut failed);
        let failures = failed[..snapshot.len()].iter().filter(|failed| **failed).count() as u32;
        match self.events.lock() {
            Ok(mut bus) => bus.end_dispatch(&snapshot, &failed),
            Err(poisoned) => poisoned.into_inner().end_dispatch(&snapshot, &failed),
        }
        (called, failures)
    }

    /// The dispatcher's own teardown: every layer still registered gets its
    /// `shutdown`, once, with no lock held, and the published window record is
    /// cleared — a teardown that left it standing would let a late reader
    /// believe in a window that is about to be destroyed.
    ///
    /// Called on both of `main`'s exit paths, after the adapters have been torn
    /// down — a layer whose adapter is already gone would be a call into
    /// unloaded code, so the ordering is adapters first, then this. It is
    /// idempotent: a second call finds no layers.
    pub fn clear(&self) {
        // The record first: `host_window_info` must stop answering about a
        // window that the teardown after this is about to destroy.
        match self.window.lock() {
            Ok(mut cell) => *cell = None,
            Err(poisoned) => *poisoned.into_inner() = None,
        }
        // Pads go with it. A slot left standing would let `pad_state` answer for
        // a handle the window's teardown is about to close.
        match self.pads.lock() {
            Ok(mut mirror) => *mirror = PadMirror::EMPTY,
            Err(poisoned) => *poisoned.into_inner() = PadMirror::EMPTY,
        }
        let snapshot = match self.events.lock() {
            Ok(mut bus) => bus.take_layers(),
            Err(poisoned) => poisoned.into_inner().take_layers(),
        };
        for index in 0..snapshot.len {
            let Some(shutdown) = snapshot.layers[index].shutdown else {
                continue;
            };
            // SAFETY: the token is this host's, `shutdown` was validated as a
            // non-null function pointer at registration, and the table was
            // taken out of the bus so nothing can call into the layer again.
            unsafe { shutdown(snapshot.layers[index].token as *mut std::ffi::c_void) };
        }
    }
}

impl Default for HostShared {
    fn default() -> Self {
        Self {
            events: Mutex::new(EventBus::new()),
            window: Mutex::new(None),
            pads: Mutex::new(PadMirror::EMPTY),
        }
    }
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
    /// How many events the pump translated onto the event wire, and how many
    /// were dropped because one drain produced more than
    /// [`EVENT_BATCH_CAPACITY`]. A non-zero `overflow` means a layer missed
    /// events this pump — said out loud rather than silently truncated.
    pub translated: u32,
    pub overflow: u32,
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
/// The pads the host has opened, in the slots it assigned.
///
/// Owned by the window's thread and never shared: `pad_state` reads the mirror
/// in `HostShared`, and this struct is what fills it — once per pump, on the
/// thread SDL permits. The split is the whole of the thread rule: SDL's gamepad
/// getters are not thread-safe, so the only any-thread answer is a sampled one.
struct PadDevices {
    /// `None` when `SDL_InitSubSystem(GAMEPAD)` was refused. Pads are then
    /// simply not served, which is `-ENODEV` per slot and not an error: a
    /// machine with no gamepad support is a machine with no pads.
    subsystem: Option<sdl3::GamepadSubsystem>,
    slots: [Option<sdl3::gamepad::Gamepad>; PAD_SLOTS as usize],
    /// The joystick instance id each slot holds, so a removal can be matched to
    /// its slot without reopening anything.
    ids: [u32; PAD_SLOTS as usize],
}

impl PadDevices {
    fn new(subsystem: Option<sdl3::GamepadSubsystem>) -> Self {
        Self {
            subsystem,
            slots: [const { None }; PAD_SLOTS as usize],
            ids: [0; PAD_SLOTS as usize],
        }
    }

    /// Open `instance` into the first free slot and return the slot.
    ///
    /// Idempotent: an instance already held returns its slot rather than
    /// opening a second handle. `None` when every slot is taken or SDL refused
    /// the open — a pad that will not open is a pad the host cannot report, and
    /// the log line is the honest answer.
    fn open(&mut self, instance: u32) -> Option<u32> {
        let slots = PAD_SLOTS as usize;
        for slot in 0..slots {
            if self.slots[slot].is_some() && self.ids[slot] == instance {
                return Some(slot as u32);
            }
        }
        let subsystem = self.subsystem.as_ref()?;
        let free = (0..slots).find(|slot| self.slots[*slot].is_none())?;
        let id = sdl3::joystick::JoystickId::from(instance);
        match subsystem.open(id) {
            Ok(pad) => {
                let name = pad.name().unwrap_or_else(|| "(unnamed)".to_string());
                crate::logging::log(
                    crate::logging::Level::Info,
                    "core",
                    &format!("pad: slot {free} '{name}' (instance {instance})"),
                );
                self.slots[free] = Some(pad);
                self.ids[free] = instance;
                Some(free as u32)
            }
            Err(error) => {
                crate::logging::log(
                    crate::logging::Level::Warn,
                    "core",
                    &format!("pad: instance {instance} could not be opened: {error}"),
                );
                None
            }
        }
    }

    /// Release the slot holding `instance`, if any.
    fn close(&mut self, instance: u32) {
        for slot in 0..PAD_SLOTS as usize {
            if self.ids[slot] == instance && self.slots[slot].is_some() {
                self.slots[slot] = None;
                self.ids[slot] = 0;
                crate::logging::log(
                    crate::logging::Level::Info,
                    "core",
                    &format!("pad: slot {slot} released (instance {instance})"),
                );
            }
        }
    }

    fn any_live(&self) -> bool {
        self.slots.iter().any(|slot| slot.is_some())
    }

    /// Write every live slot's record into `out` and return how many are live.
    ///
    /// Buttons and axes are read here, not by the reader: `pad_state` is
    /// any-thread and these getters are not. The normalisation is the same one
    /// the capability did for itself — sticks in `[-1, 1]`, triggers in
    /// `[0, 1]` — so the wire did not move when the pads did.
    fn sample(&self, out: &mut PadMirror) -> u32 {
        out.present = 0;
        let mut live = 0u32;
        for slot in 0..PAD_SLOTS as usize {
            let Some(pad) = self.slots[slot].as_ref() else {
                continue;
            };
            let mut record = TensionPadRecord {
                version: crate::platform::PAD_RECORD_VERSION,
                flags: crate::platform::PAD_RECORD_ATTACHED,
                ..TensionPadRecord::default()
            };
            let raw = pad.raw();
            let buttons = sdl3::sys::gamepad::SDL_GAMEPAD_BUTTON_COUNT.0;
            for button in 0..buttons {
                // SAFETY: `raw` is a gamepad this process opened and has not
                // closed, and the index is inside SDL's own button range.
                if unsafe {
                    sdl3::sys::gamepad::SDL_GetGamepadButton(
                        raw,
                        sdl3::sys::gamepad::SDL_GamepadButton(button),
                    )
                } {
                    record.buttons |= 1u32 << button;
                }
            }
            let axes = sdl3::sys::gamepad::SDL_GAMEPAD_AXIS_COUNT.0;
            for axis in 0..axes.min(6) {
                // SAFETY: as above; the raw value is Sint16 by SDL's contract.
                let raw_value = unsafe {
                    sdl3::sys::gamepad::SDL_GetGamepadAxis(
                        raw,
                        sdl3::sys::gamepad::SDL_GamepadAxis(axis),
                    )
                };
                let mut value = raw_value as f32 / 32767.0;
                if axis == sdl3::sys::gamepad::SDL_GAMEPAD_AXIS_LEFT_TRIGGER.0
                    || axis == sdl3::sys::gamepad::SDL_GAMEPAD_AXIS_RIGHT_TRIGGER.0
                {
                    value = value.max(0.0);
                }
                record.axes[axis as usize] = value.clamp(-1.0, 1.0);
            }
            out.records[slot] = record;
            out.present |= 1u32 << slot;
            live += 1;
        }
        live
    }
}

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
    /// Pointer confinement, as `apply_control` set it. Not part of
    /// `WindowInfo` (the guest's record is about the window, not the pointer),
    /// but a layer asks for it and the host must remember what it granted.
    relative_mouse: AtomicBool,
    /// The pads the host opened, and the only place a gamepad handle lives.
    /// Filled from hotplug events in `pump`, read into `HostShared::pads` at the
    /// end of the same pump so an any-thread `pad_state` never touches SDL.
    pads: PadDevices,
    title: String,
    /// The dispatcher and the published window record, shared with the API
    /// table so an adapter can register a layer and read `host_window_info`.
    ///
    /// Held by the window rather than by the host loop because `pump` is the one
    /// place events are drained, and it is reached from two callers — the host
    /// loop and the 2D renderer's present. Dispatching *inside* `pump` is what
    /// makes it impossible for one of them to drain an event the other never
    /// dispatches; before v7 there were two pollers on one queue and the split
    /// was measured to be nondeterministic.
    shared: std::sync::Arc<HostShared>,
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
        shared: std::sync::Arc<HostShared>,
    ) -> Result<Self, PlatformError> {
        let sdl = sdl3::init().map_err(|e| PlatformError::Sdl(e.to_string()))?;
        let video = sdl
            .video()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        // At most one alive, and `Sdl` owns the right to make it.
        let event_pump = sdl
            .event_pump()
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;

        // Gamepads belong to the host from v7b. A capability cannot open one:
        // SDL's gamepad calls belong to the thread that initialised the
        // subsystem, and that thread is this one. A refusal here is not fatal —
        // a machine with no gamepad support is a machine with no pads, and
        // `pad_state` answers -ENODEV per slot either way.
        let gamepad = match sdl.gamepad() {
            Ok(subsystem) => Some(subsystem),
            Err(error) => {
                crate::logging::log(
                    crate::logging::Level::Info,
                    "core",
                    &format!("pad: the gamepad subsystem is not available: {error}"),
                );
                None
            }
        };

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

        // **Text input is not enabled automatically in SDL3.** Without this call
        // the pump never produces `SDL_EVENT_TEXT_INPUT`, so the
        // `TENSION_EVENT_TEXT` family translates nothing at all — measured: the
        // editor's inspector field received every key *down* and no text, while the
        // earlier pass that added the family had only verified that the verb answers
        // 0 when nothing has been typed (trivially true when nothing *can* be).
        //
        // Started here, at creation, for the reason the window record is published
        // here: it is the one place every creator passes through.
        video.text_input().start(&window);

        let window = HostWindow {
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
            relative_mouse: AtomicBool::new(false),
            pads: PadDevices::new(gamepad),
            title: title.to_string(),
            shared,
            _sdl: sdl,
        };
        // Publish the window record at *creation*, not at the first pump.
        //
        // A guest may create a window and immediately ask `window_info` (or, as
        // the input capability does, attach to the host's window), and both would
        // otherwise be told "no window" until something happened to pump. That is
        // a real ordering the fixtures exercise: `createWindow`, `input.open`,
        // `input.attach`, no wait in between.
        //
        // Writing it here rather than at the call sites is what makes it true for
        // every creator.
        match window.shared.window.lock() {
            Ok(mut cell) => *cell = Some(window.info()),
            Err(poisoned) => *poisoned.into_inner() = Some(window.info()),
        }
        Ok(window)
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
            native_handle: self.native_handle(),
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
        // One batch per pump, on the stack and capped. This runs inside the
        // frame's own budget, so an unbounded batch would let a burst of input
        // allocate its way into that budget; the excess is counted instead.
        let mut batch = [TensionEvent::EMPTY; EVENT_BATCH_CAPACITY];
        let mut count = 0usize;
        let mut overflow = 0u32;
        // Hotplug, applied after the drain. Opening or closing a pad in the
        // middle of the loop would re-enter SDL's joystick state while an event
        // from it is still in hand, and the two are cheap to batch: at most
        // `PAD_SLOTS` of each can matter in one pump.
        let mut pads_added = [0u32; PAD_SLOTS as usize];
        let mut pads_removed = [0u32; PAD_SLOTS as usize];
        let mut added = 0usize;
        let mut removed = 0usize;

        self.event_pump.pump_events();
        let window_id = self.window.id();

        while let Some(event) = self.event_pump.poll_event() {
            events.drained += 1;
            match event {
                sdl3::event::Event::Quit { .. } => {
                    self.close_requested.store(true, Ordering::Relaxed);
                    events.close_requested = true;
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(EVENT_QUIT, 0, 0, 0, 0, 0),
                    );
                }
                sdl3::event::Event::Window {
                    win_event,
                    window_id: id,
                    ..
                } if id == window_id => {
                    if let Some(wire) = self.apply_window_event(&mut events, win_event) {
                        push_event(&mut batch, &mut count, &mut overflow, wire);
                    }
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
                // ── the wire's families ─────────────────────────────────
                //
                // Key: `a0` scancode, `a1` keycode, `a2` the modifier word,
                // `a3` repeat. Both codes are `Option` in `sdl3` and `0` is a
                // real value for neither (`Scancode::Unknown` and
                // `Keycode::Unknown` are 0), so "absent" and "unknown" collapse
                // to the same wire value — which is honest: an adapter that sees
                // 0 cannot tell them apart because there is nothing to tell.
                sdl3::event::Event::KeyDown {
                    keycode,
                    scancode,
                    keymod,
                    repeat,
                    ..
                } => {
                    let wire = key_event(true, keycode, scancode, keymod, repeat);
                    push_event(&mut batch, &mut count, &mut overflow, wire);
                }
                sdl3::event::Event::KeyUp {
                    keycode,
                    scancode,
                    keymod,
                    repeat,
                    ..
                } => {
                    let wire = key_event(false, keycode, scancode, keymod, repeat);
                    push_event(&mut batch, &mut count, &mut overflow, wire);
                }
                sdl3::event::Event::TextInput { text, .. } => {
                    // `flags` is the byte count; `a0..a3` carry the UTF-8 bytes
                    // inline (`TENSION_EVENT_TEXT_BYTES` per event). Text a user
                    // typed is not a scalar — a dead-key composition, an IME
                    // commit and a paste each arrive as one event holding
                    // several codepoints — and a consumer that had to go back to
                    // SDL for the rest would need SDL.
                    //
                    // Anything longer than one event is split at a UTF-8
                    // boundary into consecutive events, so a paste arrives
                    // whole. Splitting on a boundary rather than at 32 bytes is
                    // what keeps every event decodable on its own.
                    let mut start = 0usize;
                    while start < text.len() {
                        let mut end = (start + EVENT_TEXT_BYTES).min(text.len());
                        // Never split a multi-byte sequence: back up to the
                        // first byte of a character (`10xxxxxx` is a
                        // continuation).
                        while end < text.len() && end > start && (text.as_bytes()[end] & 0xC0) == 0x80 {
                            end -= 1;
                        }
                        let chunk = &text.as_bytes()[start..end];
                        push_event(
                            &mut batch,
                            &mut count,
                            &mut overflow,
                            TensionEvent::new(
                                EVENT_TEXT,
                                chunk.len() as u32,
                                text_word(chunk, 0),
                                text_word(chunk, 8),
                                text_word(chunk, 16),
                                text_word(chunk, 24),
                            ),
                        );
                        start = end;
                    }
                }
                // Mouse motion: `a0`/`a1` are the integer position, and
                // `a2`/`a3` hold the sub-pixel delta as an f32 bit pattern
                // (low 32 bits, zero-extended). The delta is not rounded: the
                // input capability accumulates it as a float precisely so a slow
                // drag does not truncate to zero every frame.
                sdl3::event::Event::MouseMotion {
                    which,
                    x,
                    y,
                    xrel,
                    yrel,
                    ..
                } => {
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(
                            EVENT_MOUSE_MOTION,
                            which,
                            x as i64,
                            y as i64,
                            (xrel.to_bits() as i64) & 0xFFFF_FFFF,
                            (yrel.to_bits() as i64) & 0xFFFF_FFFF,
                        ),
                    );
                }
                // Buttons: `a0` button, `a1` down, `a2` clicks, `a3` the button
                // mask after the change. `flags` is the device id.
                sdl3::event::Event::MouseButtonDown {
                    which,
                    mouse_btn,
                    clicks,
                    ..
                } => {
                    let wire = button_event(true, which, mouse_btn, clicks, &self.event_pump);
                    push_event(&mut batch, &mut count, &mut overflow, wire);
                }
                sdl3::event::Event::MouseButtonUp {
                    which,
                    mouse_btn,
                    clicks,
                    ..
                } => {
                    let wire = button_event(false, which, mouse_btn, clicks, &self.event_pump);
                    push_event(&mut batch, &mut count, &mut overflow, wire);
                }
                // Wheel: `a0`/`a1` are the integer direction, `a2`/`a3` the f32
                // bit patterns. Both are sent because "how many notches" and
                // "how much" are different questions and SDL answers them in
                // floats on a trackpad.
                sdl3::event::Event::MouseWheel { which, x, y, .. } => {
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(
                            EVENT_MOUSE_WHEEL,
                            which,
                            y as i64,
                            x as i64,
                            (y.to_bits() as i64) & 0xFFFF_FFFF,
                            (x.to_bits() as i64) & 0xFFFF_FFFF,
                        ),
                    );
                }
                // Pads: `a0` subtype, `a1` the joystick instance id, `a2` the
                // button or axis index, `a3` the value. Slots are the host's to
                // assign; this family is how a capability learns a pad exists.
                sdl3::event::Event::GamepadAdded { which, .. } => {
                    if added < pads_added.len() && !pads_added[..added].contains(&(which.raw() as u32)) {
                        pads_added[added] = which.raw() as u32;
                        added += 1;
                    }
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(EVENT_PAD, 0, PAD_EVENT_ADDED as i64, which.raw() as i64, 0, 0),
                    );
                }
                sdl3::event::Event::GamepadRemoved { which, .. } => {
                    if removed < pads_removed.len()
                        && !pads_removed[..removed].contains(&(which.raw() as u32))
                    {
                        pads_removed[removed] = which.raw() as u32;
                        removed += 1;
                    }
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(EVENT_PAD, 0, PAD_EVENT_REMOVED as i64, which.raw() as i64, 0, 0),
                    );
                }
                sdl3::event::Event::GamepadButtonDown { which, button, .. } => {
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(
                            EVENT_PAD,
                            0,
                            PAD_EVENT_BUTTON_DOWN as i64,
                            which.raw() as i64,
                            button as i64,
                            1,
                        ),
                    );
                }
                sdl3::event::Event::GamepadButtonUp { which, button, .. } => {
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(
                            EVENT_PAD,
                            0,
                            PAD_EVENT_BUTTON_UP as i64,
                            which.raw() as i64,
                            button as i64,
                            0,
                        ),
                    );
                }
                sdl3::event::Event::GamepadAxisMotion {
                    which,
                    axis,
                    value,
                    ..
                } => {
                    push_event(
                        &mut batch,
                        &mut count,
                        &mut overflow,
                        TensionEvent::new(
                            EVENT_PAD,
                            0,
                            PAD_EVENT_AXIS as i64,
                            which.raw() as i64,
                            axis as i64,
                            value as i64,
                        ),
                    );
                }
                _ => {}
            }
        }

        // Pads change before the record is published and the batch dispatched,
        // for the same reason the window record does: a layer that answers
        // `pad_state` from inside its dispatch must see the slot the PAD event
        // in that same batch was about.
        if added > 0 || removed > 0 || self.pads.any_live() {
            for instance in &pads_added[..added] {
                self.pads.open(*instance);
            }
            for instance in &pads_removed[..removed] {
                self.pads.close(*instance);
            }
            match self.shared.pads.lock() {
                Ok(mut mirror) => {
                    self.pads.sample(&mut mirror);
                }
                Err(poisoned) => {
                    self.pads.sample(&mut poisoned.into_inner());
                }
            }
        }

        // Publish the record, then dispatch the batch. That order is what lets a
        // layer read `host_window_info` from inside its dispatch and see the
        // state the batch belongs to rather than the previous frame's.
        {
            let info = self.info();
            match self.shared.window.lock() {
                Ok(mut cell) => *cell = Some(info),
                Err(poisoned) => *poisoned.into_inner() = Some(info),
            }
        }
        if count > 0 {
            self.shared.dispatch(&batch[..count]);
        }
        events.translated = count as u32;
        events.overflow = overflow;
        events
    }

    /// One window event against this window's state.
    ///
    /// Split out of [`pump`] so the pump stays one readable loop, and so every
    /// arm here is visibly "an atomic updated from an event" — the contract
    /// `window_info` depends on. Nothing here calls SDL except the DPI read,
    /// which is why the caller has already established this is the window's
    /// thread.
    fn apply_window_event(
        &self,
        events: &mut PlatformEvents,
        event: sdl3::event::WindowEvent,
    ) -> Option<TensionEvent> {
        use sdl3::event::WindowEvent;
        match event {
            WindowEvent::CloseRequested => {
                // Latched, not an edge: a guest polling `window_info` wants to
                // know the user asked, not that they asked once.
                self.close_requested.store(true, Ordering::Relaxed);
                events.close_requested = true;
                Some(TensionEvent::new(
                    EVENT_WINDOW,
                    0,
                    WINDOW_EVENT_CLOSE_REQUESTED as i64,
                    0,
                    0,
                    0,
                ))
            }
            WindowEvent::Resized(width, height) => {
                // Logical size. The drawable size arrives separately, as
                // `PixelSizeChanged`, and is what a swapchain is built from.
                let (width, height) = (width.max(0) as u32, height.max(0) as u32);
                if width > 0 && height > 0 {
                    self.width.store(width, Ordering::Relaxed);
                    self.height.store(height, Ordering::Relaxed);
                    events.resized = Some((width, height));
                    return Some(TensionEvent::new(
                        EVENT_WINDOW,
                        0,
                        WINDOW_EVENT_RESIZED as i64,
                        width as i64,
                        height as i64,
                        0,
                    ));
                }
                None
            }
            WindowEvent::PixelSizeChanged(width, height) => {
                let (width, height) = (width.max(0) as u32, height.max(0) as u32);
                if width > 0 && height > 0 {
                    self.pixel_width.store(width, Ordering::Relaxed);
                    self.pixel_height.store(height, Ordering::Relaxed);
                    return Some(TensionEvent::new(
                        EVENT_WINDOW,
                        0,
                        WINDOW_EVENT_PIXEL_SIZE_CHANGED as i64,
                        width as i64,
                        height as i64,
                        0,
                    ));
                }
                None
            }
            WindowEvent::EnterFullscreen => {
                self.fullscreen.store(true, Ordering::Relaxed);
                Some(window_state_event(WINDOW_EVENT_ENTER_FULLSCREEN))
            }
            WindowEvent::LeaveFullscreen => {
                self.fullscreen.store(false, Ordering::Relaxed);
                Some(window_state_event(WINDOW_EVENT_LEAVE_FULLSCREEN))
            }
            WindowEvent::FocusGained => {
                self.focused.store(true, Ordering::Relaxed);
                Some(window_state_event(WINDOW_EVENT_FOCUS_GAINED))
            }
            WindowEvent::FocusLost => {
                self.focused.store(false, Ordering::Relaxed);
                Some(window_state_event(WINDOW_EVENT_FOCUS_LOST))
            }
            // Not window state (nothing in `WindowInfo` distinguishes them),
            // but a layer's state record does: the input capability reports
            // `POINTER_OVER`, and these two events are the only place that can
            // come from once it stopped polling SDL itself.
            WindowEvent::MouseEnter => Some(window_state_event(WINDOW_EVENT_MOUSE_ENTER)),
            WindowEvent::MouseLeave => Some(window_state_event(WINDOW_EVENT_MOUSE_LEAVE)),
            WindowEvent::Minimized => {
                self.minimized.store(true, Ordering::Relaxed);
                Some(window_state_event(WINDOW_EVENT_MINIMIZED))
            }
            // Maximised is not minimised: both leave the window restored from
            // the atomics' point of view, and the atomics carry one boolean. The
            // wire reports the pair as RESTORED rather than inventing a
            // subtype the state record cannot distinguish.
            WindowEvent::Restored | WindowEvent::Maximized => {
                self.minimized.store(false, Ordering::Relaxed);
                Some(window_state_event(WINDOW_EVENT_RESTORED))
            }
            _ => None,
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

    /// Resize the window and publish the request.
    ///
    /// The guest-facing mutator (`tension::platform.set_window_size`). Unlike
    /// [`set_size`], which only asks, this records the size it asked for, for
    /// the same reason `CTRL_RESIZE` does: a guest that resizes and reads
    /// `windowInfo` on its next line should see the size it requested rather
    /// than the one from before. A window system that clamps corrects the
    /// record with the resize event the pump latches.
    ///
    /// A dimension below 1 is clamped rather than refused: the host has the
    /// only say in what a window can be, and SDL on some drivers answers a
    /// zero-sized resize by doing nothing at all.
    ///
    /// Main thread only.
    pub fn set_window_size(&mut self, width: u32, height: u32) -> Result<(), PlatformError> {
        let width = width.max(1);
        let height = height.max(1);
        self.set_size(width, height)?;
        self.width.store(width, Ordering::Relaxed);
        self.height.store(height, Ordering::Relaxed);
        Ok(())
    }

    /// Shrink a windowed request that cannot fit the display's work area, and
    /// put it back where a window that *did* fit would have been placed.
    ///
    /// **The failure this exists for.** A window is created at a *client* size
    /// and the window system adds its decoration around that. Asked for
    /// 1920x1080 on a 1920x1080 display, Win32 builds a 1936x1119 outer frame and
    /// centres *that*, so the client origin lands at (0, 0) while the title bar
    /// sits at y = -31 and the left border at x = -8. Every pixel of the client is
    /// on screen and none of the chrome is: the window reads as "it opened
    /// fullscreen" and there is no frame left to drag or an X to click. Measured
    /// with `GetWindowRect` on a 1920x1080 display. A window manager that
    /// constrains its own windows never produces it, which is why the same
    /// project looked correct on Linux.
    ///
    /// SDL will not say how big the decoration is — `Window::border_size` is
    /// X11-only, and physical pixels besides — so the request is fitted into the
    /// work area with [`DECORATION_MARGIN`] standing in for the frame. Re-centring
    /// is not cosmetic: the position the window system picked was computed for the
    /// size that did not fit, and leaving it there would keep the chrome off the
    /// screen with the client merely smaller.
    ///
    /// Main thread only.
    pub fn fit_to_work_area(&mut self) -> Result<(), PlatformError> {
        let requested = (
            self.width.load(Ordering::Relaxed),
            self.height.load(Ordering::Relaxed),
        );

        // A driver with no display to ask — `offscreen`, `dummy` — has no work
        // area to fit into. That is not a failure: the window was created.
        let Ok(display) = self.window.get_display() else {
            return Ok(());
        };
        let Ok(area) = display.get_usable_bounds() else {
            return Ok(());
        };
        let work = (area.width().max(1), area.height().max(1));

        let fitted = fitted_client_size(requested, work);
        if fitted == requested {
            return Ok(());
        }

        // `set_window_size` rather than `set_size`: it publishes the size, so a
        // guest that reads `windowInfo()` before the next pump sees the window it
        // actually has instead of the one it asked for.
        self.set_window_size(fitted.0, fitted.1)?;

        let x = area.x() + (work.0 as i32 - fitted.0 as i32) / 2;
        let y = area.y() + (work.1 as i32 - fitted.1 as i32) / 2;
        self.window
            .set_position(sdl3::video::WindowPos::from(x), sdl3::video::WindowPos::from(y));

        crate::logging::log(
            crate::logging::Level::Info,
            "core",
            &format!(
                "create_window: {}x{} does not fit the {}x{} work area; opened at {}x{}",
                requested.0, requested.1, work.0, work.1, fitted.0, fitted.1
            ),
        );
        Ok(())
    }

    /// Change the window's title.
    ///
    /// The host keeps the title it created the window with, so this updates
    /// both the window system and that copy: [`title`](Self::title) must not
    /// go on answering the old name after the guest renamed the window.
    ///
    /// Main thread only.
    pub fn set_window_title(&mut self, title: &str) -> Result<(), PlatformError> {
        self.window
            .set_title(title)
            .map_err(|e| PlatformError::Sdl(e.to_string()))?;
        self.title.clear();
        self.title.push_str(title);
        Ok(())
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
            // Pointer confinement. The caller (a layer) never sees the window;
            // this is the only place `SDL_SetWindowRelativeMouseMode` is
            // reached, which is what keeps "no layer calls SDL" true by
            // ownership rather than by convention.
            CTRL_RELATIVE_MOUSE => {
                let on = msg.arg0 != 0;
                // Called through the sys binding rather than `MouseUtil`: the
                // crate hands that type out only from an `Sdl` it does not
                // expose a constructor for, and this is the window's thread with
                // a live `SDL_Window`, which is the whole precondition.
                //
                // SAFETY: `self.window` is a window this process created and has
                // not destroyed, and this call is on the thread that created it.
                let ok = unsafe {
                    sdl3::sys::mouse::SDL_SetWindowRelativeMouseMode(self.window.raw(), on)
                };
                if !ok {
                    return Err(PlatformError::Sdl(
                        sdl3::get_error().to_string(),
                    ));
                }
                self.relative_mouse.store(on, Ordering::Relaxed);
                Ok(())
            }
            other => Err(PlatformError::Sdl(format!("unknown control kind {other}"))),
        }
    }

    /// Put the window into the requested mode.
    ///
    /// **Main thread only.** This is the one place a [`WindowMode`] becomes SDL
    /// calls and a move of the window's own record, and both the creating call
    /// ([`create_window`]) and the guest verb
    /// (`tension::platform.set_fullscreen`) go through it. A second copy of
    /// this match is exactly how creation and later mutation drift apart: before
    /// E1b the creation path had its own, so `BorderlessFullscreen` was decided
    /// in one place and would have had to be remembered in another.
    ///
    /// The record moves from the *request*, on success, because a driver may
    /// take a round trip through the compositor to emit `ENTER_FULLSCREEN` — a
    /// guest that sets the mode and reads it back must not see the old one. The
    /// pump still owns the truth afterwards: a window the *user* takes
    /// fullscreen, or leaves, updates the record from the event.
    ///
    /// `BorderlessFullscreen` reads back as `Fullscreen`: `WindowInfo::mode`
    /// derives from one boolean, and "fullscreen with no chrome" is a
    /// decoration, not a third state a reader can distinguish.
    pub fn set_fullscreen(&mut self, mode: WindowMode) -> Result<(), PlatformError> {
        match mode {
            WindowMode::Windowed => {
                self.switch_fullscreen(false)?;
                // Leaving borderless fullscreen has to restore the decoration
                // it removed, or the window returns chromeless with nothing to
                // drag it by.
                self.set_bordered(true);
            }
            WindowMode::Fullscreen => self.switch_fullscreen(true)?,
            WindowMode::BorderlessFullscreen => {
                self.switch_fullscreen(true)?;
                self.set_bordered(false);
            }
        }
        self.fullscreen
            .store(mode != WindowMode::Windowed, Ordering::Relaxed);
        Ok(())
    }

    /// The SDL half of [`set_fullscreen`]. Private on purpose: the mode is the
    /// interface, and a caller that could ask for a bare `bool` would be able
    /// to skip the bookkeeping that keeps `info().mode` true.
    fn switch_fullscreen(&mut self, on: bool) -> Result<(), PlatformError> {
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

    /// The window system's own handle for this window, or 0 where the platform
    /// or the driver has none.
    ///
    /// Read through SDL's window properties rather than `SDL_GetWindowWMInfo`:
    /// the property query answers 0 for "this build or driver has no such
    /// handle" instead of needing a struct layout that changes per SDL version,
    /// and it is the same source the `raw-window-handle` implementations use.
    ///
    /// **Main thread only**, like every other `SDL_GetWindowProperties` call: it
    /// takes the window's lock, and SDL's window functions belong to the thread
    /// that made the window.
    ///
    /// Which driver is in play matters. On X11 the handle is a number (the
    /// XID) and on Win32 it is a pointer (the `HWND`); both fit a `u64`.
    /// Wayland's `wl_surface` is not a handle any Ogre render system here
    /// accepts, and macOS has its own spelling — those answer 0, which callers
    /// must read as "no adoptable handle" rather than as a handle with the
    /// value zero.
    pub fn native_handle(&self) -> u64 {
        let driver = self.video.current_video_driver();

        // SAFETY: `SDL_GetWindowProperties` returns the window's property set,
        // borrowed from the window, which this `HostWindow` keeps alive for the
        // duration of the call. The property reads are typed by SDL: a number
        // property through `SDL_GetNumberProperty`, a pointer property through
        // `SDL_GetPointerProperty`.
        unsafe {
            let properties = sdl3::sys::video::SDL_GetWindowProperties(self.window.raw());
            if properties.0 == 0 {
                return 0;
            }

            #[cfg(target_os = "windows")]
            {
                if driver == "windows" {
                    let hwnd = sdl3::sys::properties::SDL_GetPointerProperty(
                        properties,
                        sdl3::sys::video::SDL_PROP_WINDOW_WIN32_HWND_POINTER,
                        std::ptr::null_mut(),
                    );
                    return hwnd as usize as u64;
                }
                return 0;
            }

            #[cfg(all(unix, not(target_os = "macos")))]
            {
                if driver == "x11" {
                    // An XID is 32 bits today and `XID` widens without warning,
                    // so a negative answer is impossible — but the property API
                    // is signed, and a negative would be a driver bug rather
                    // than a handle.
                    let xid = sdl3::sys::properties::SDL_GetNumberProperty(
                        properties,
                        sdl3::sys::video::SDL_PROP_WINDOW_X11_WINDOW_NUMBER,
                        0,
                    );
                    return if xid > 0 { xid as u64 } else { 0 };
                }
                // Wayland: `wl_surface` is not a handle Ogre's GLX window takes
                // on this build, so there is nothing to hand over.
                return 0;
            }

            #[allow(unreachable_code)]
            0
        }
    }
}

/// What a windowed request must leave of the display's work area for the window
/// system's own decoration.
///
/// Win32 draws a 16x39 frame around a 1920x1080 client at 100% scale, so these
/// are twice the frame in each direction: a request that lands within a title
/// bar of the work area's edge takes the fitting path too, instead of
/// overhanging by exactly the amount it was allowed to be close by. They are
/// *logical* units, because the request and `SDL_GetDisplayUsableBounds` are
/// both logical — above 100% scale the same frame is fewer logical pixels, so
/// the margin only ever gives back slack.
const DECORATION_MARGIN: (u32, u32) = (32, 64);

/// The client size a windowed request becomes on a display whose work area is
/// `work`.
///
/// Pure so the arithmetic has a test that needs no display: the SDL calls
/// around it (`get_display`, `get_usable_bounds`, `set_size`) are the part that
/// needs a window, and they carry no decisions of their own.
fn fitted_client_size(requested: (u32, u32), work: (u32, u32)) -> (u32, u32) {
    let max = (
        work.0.saturating_sub(DECORATION_MARGIN.0).max(1),
        work.1.saturating_sub(DECORATION_MARGIN.1).max(1),
    );
    (requested.0.min(max.0), requested.1.min(max.1))
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
    shared: &std::sync::Arc<HostShared>,
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

    let mut window = HostWindow::new(
        &config.title,
        config.width,
        config.height,
        config.target,
        std::sync::Arc::clone(shared),
    )?;

    // Mode is applied after creation, because SDL's fullscreen flags are a
    // state transition rather than a creation parameter on every driver:
    // `SDL_SetWindowFullscreen` picks the display, clamps to its mode, and emits
    // ENTER_FULLSCREEN — the event the pump latches. Doing it here keeps the
    // window's own record true from the first frame, even on a driver that never
    // emits the event for a window born fullscreen.
    //
    // Through the same mutator a guest's `set_fullscreen` calls, so that
    // "borderless" and "move the record" have one definition rather than a
    // second, silently-divergent copy at creation.
    window.set_fullscreen(config.mode)?;

    if config.min_width > 0 && config.min_height > 0 {
        window.set_min_size(config.min_width, config.min_height)?;
    }
    if config.max_width > 0 && config.max_height > 0 {
        window.set_max_size(config.max_width, config.max_height)?;
    }

    // Last, so an explicit min/max bound still has the window system's own clamp
    // behind it — and skipped for a fullscreen request, which has already taken
    // the whole display and has no frame to keep on screen.
    if config.mode == WindowMode::Windowed {
        // A refusal here is not fatal: the window exists and is usable, it merely
        // overhangs, which is the window this code had before it existed.
        if let Err(error) = window.fit_to_work_area() {
            crate::logging::log(
                crate::logging::Level::Warn,
                "core",
                &format!("create_window: could not fit the window to its work area: {error}"),
            );
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A request that already fits keeps every pixel it asked for: the margin
    /// only exists where something has to give.
    #[test]
    fn a_request_inside_the_work_area_is_untouched() {
        assert_eq!(fitted_client_size((1280, 720), (1920, 1032)), (1280, 720));
        // 1888x968 is exactly the largest client a 1920x1032 work area holds
        // once the decoration margin is paid, so it is the boundary case for
        // "fits" rather than an arbitrary one.
        assert_eq!(
            fitted_client_size(
                (1920 - DECORATION_MARGIN.0, 1032 - DECORATION_MARGIN.1),
                (1920, 1032)
            ),
            (1920 - DECORATION_MARGIN.0, 1032 - DECORATION_MARGIN.1)
        );
    }

    /// The bug this arithmetic exists for: a client the size of the display
    /// leaves no room for the frame, which is what put the title bar above the
    /// screen. Each axis is fitted on its own, because a window can overhang in
    /// one and not the other.
    #[test]
    fn a_request_the_size_of_the_work_area_loses_the_frame_from_both_axes() {
        assert_eq!(
            fitted_client_size((1920, 1080), (1920, 1032)),
            (1888, 968)
        );
        assert_eq!(
            fitted_client_size((1920, 720), (1920, 1032)),
            (1888, 720)
        );
        assert_eq!(
            fitted_client_size((1280, 1080), (1920, 1032)),
            (1280, 968)
        );
    }

    /// A work area narrower than the margin still yields a window: one pixel is
    /// refused by `create_window`'s own zero check, and a saturating subtraction
    /// that wrapped to a huge value would produce a window larger than the
    /// display — the exact failure this function removes.
    #[test]
    fn a_work_area_smaller_than_the_margin_still_yields_a_usable_window() {
        assert_eq!(fitted_client_size((800, 600), (16, 32)), (1, 1));
        assert_eq!(fitted_client_size((800, 600), (0, 0)), (1, 1));
    }
}