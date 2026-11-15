//! Does Ogre render into a surface SDL created?
//!
//! This is the north star's end-to-end proof, and it is the only test in the
//! tree that exercises all of it at once: SDL3 owns the window and the
//! `VkSurfaceKHR`, the Ogre-Next adapter adopts both instead of creating its
//! own, renders, is resized by the host, renders again, and tears down in the
//! order the architecture requires (adapters first, instance last).
//!
//! # Why this lives here and not in `tension-ogre/tests/`
//!
//! It needs both halves: `tension_core::platform` to make the window and the
//! surface, and the adapter DSO loaded through the real ABI. A C++ probe could
//! do the first with SDL directly, but it would then be testing a second copy of
//! the host's setup rather than the host's own — and the point is that *these*
//! handles, made by *this* code, reach Ogre.
//!
//! `harness = false` for the reason the other platform probes give:
//! `sdl3::init()` lets the first calling thread claim main-thread status and
//! refuses every later one, so a normal `#[test]` would pass exactly once.
//!
//! # Unix only, and why
//!
//! The adapter is reached with `libc::dlopen`/`dlsym` rather than through
//! `tension_core`'s own loader, because the loader is what the assertion is
//! *about*: a test that went through it could not tell "the adapter is wrong"
//! from "the loader is wrong". That puts the test on `libc`, which has no
//! `dlopen` on Windows, so the body is compiled for Unix and a Windows run
//! reports itself as skipped.
//!
//! The compile gate is what lets `cargo test` build this crate on Windows at
//! all; before it, the whole `core` suite failed to compile there ("cannot find
//! function `dlopen` in crate `libc`"). Making the body run on Windows is a
//! separate piece of work — a `LoadLibraryExA`/`GetProcAddress` shim mirroring
//! `tension-core/src/adapter/ffi.rs`'s `os_loader`, plus `dso_path()` learning
//! the `.dll` spelling.
//!
//! The skip **exits 0**: `cargo test` has no way to report "not applicable", and
//! a non-zero exit would fail the `core` suite on every Windows machine for a
//! test that cannot run there. The banner it prints says so instead, and
//! `docs/known-limitations.md` is where the missing coverage is recorded.
//!
//! # What each assertion is for
//!
//! Every one is a real assertion rather than "did not crash", because the
//! interesting failures here are silent: a renderer that quietly made its own
//! window would render fine and prove nothing.
//!
//! Run: `cargo test --test ogre_host_surface`, or as the `ogre-host-surface`
//! suite in `npm test`. Needs a display that supports Vulkan; skipped with a
//! printed reason when there is none.

// On Windows the body is compiled out (`main` is Unix-gated below), so the
// helpers it drove are unused there. `allow` rather than `cfg` on each item:
// keeping them compiled means they stay type-checked, which is the value of
// building this file on a platform that cannot run it.
#![cfg_attr(not(unix), allow(dead_code, unused_imports, unused_variables))]

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tension_core::platform::{HostShared, HostWindow, WindowTarget};

// ── the adapter ABI, mirrored ────────────────────────────────────────────────
//
// Only what this test drives. The sizes are pinned by
// `tension-core/src/adapter/ffi.rs`'s own layout assertions, which is where the
// authority lives; these are the same numbers.

#[repr(C, align(8))]
#[derive(Clone, Copy)]
struct TensionValue {
    bits: u64,
}

type ImportFn = Option<unsafe extern "C" fn(*mut c_void, *const TensionValue, u32, *mut TensionValue) -> i32>;

#[repr(C)]
#[derive(Clone, Copy)]
struct TensionHostSurface {
    struct_size: u32,
    width: u32,
    height: u32,
    reserved: u32,
    instance: u64,
    surface: u64,
    /// Appended after ABI v7; a pre-existing adapter passes 32 and never sees
    /// it. The mirror carries it so the test can assert what the host writes.
    native_handle: u64,
}

/// The ABI's `tension_ctrl_msg`, spelled out rather than imported: this file
/// mirrors the C header field for field, and the crate's type is the same shape
/// by a `const` assertion in `adapter/ffi.rs`. Importing it would hide a
/// mismatch that the mirror exists to catch.
#[repr(C)]
#[derive(Clone, Copy)]
struct CtrlMsg {
    kind: u32,
    visibility: u32,
    arg0: i32,
    arg1: i32,
    arg2: i32,
    arg3: i32,
    source: u32,
    reserved: u32,
}

/// The core API table, in the order `tension_adapter.h` declares it.
///
/// `host_surface` is the slot this test exists to exercise, and it is the *last*
/// one — so the struct must be exactly 176 bytes or every slot this test
/// populates would be misaligned. The assertion below is the guard.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct ApiTable {
    abi_version: u32,
    user: *mut c_void,
    guest_read: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32) -> i32>,
    guest_write: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void, u32) -> i32>,
    guest_size: Option<unsafe extern "C" fn(*mut c_void) -> u32>,
    resolve_callback: Option<unsafe extern "C" fn(*mut c_void, u32, u32, *const u32, u32, *mut *mut c_void) -> i32>,
    call_callback: Option<unsafe extern "C" fn(*mut c_void, *mut c_void, *const TensionValue, u32, *mut TensionValue) -> i32>,
    release_callback: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
    log: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, u32)>,
    register_import: Option<
        unsafe extern "C" fn(
            *mut c_void, *const c_char, *const c_char, u32, *const u32, u32,
            ImportFn, *mut c_void, u32, u32,
        ) -> i32,
    >,
    register_source: Option<unsafe extern "C" fn(*mut c_void, *const c_char, u32, *mut u32) -> i32>,
    post_event: Option<unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32, u32, f32, f32, *mut u64) -> i32>,
    class_info: Option<unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32, *mut u32) -> i32>,
    region_lookup: Option<unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32) -> i32>,
    log_named: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, *const c_char, u32)>,
    log_structured: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, *const c_char, u32)>,
    guest_read_checked: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32, u32) -> i32>,
    signal_frame: Option<unsafe extern "C" fn(*mut c_void)>,
    shader_generate: Option<unsafe extern "C" fn(*const c_void, *mut c_char, u32) -> i32>,
    compile_graph: Option<
        unsafe extern "C" fn(*mut c_void, *const u8, u32, *mut u8, u32, *mut u8, u32, *mut u32, *mut u32) -> i32,
    >,
    post_control: Option<unsafe extern "C" fn(*mut c_void, *const CtrlMsg) -> i32>,
    host_surface: Option<unsafe extern "C" fn(*mut c_void, *mut TensionHostSurface) -> i32>,
    host_surface_extension:
        Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_char, u32, *mut u32) -> i32>,
    // ABI v7: the event dispatcher. The record pointers are typed as `c_void`
    // here because this mirror exists to pin the *layout* — the sizes these
    // tests care about are pointer sizes, and copying the four record structs
    // into three files would be three more places to drift.
    register_event_layer:
        Option<unsafe extern "C" fn(*mut c_void, *const c_void, *mut *mut c_void) -> i32>,
    unregister_event_layer: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
    host_window_info: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
    pad_state: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void) -> i32>,
}

const _: () = assert!(std::mem::size_of::<ApiTable>() == 216);
const _: () = assert!(std::mem::offset_of!(ApiTable, host_surface) == 168);
const _: () = assert!(std::mem::offset_of!(ApiTable, host_surface_extension) == 176);
// Four u32 then three u64. The first 32 bytes are what a pre-`native_handle`
// adapter reads; 40 is what this header declares.
const _: () = assert!(std::mem::size_of::<TensionHostSurface>() == 40);
const _: () = assert!(std::mem::offset_of!(TensionHostSurface, native_handle) == 32);

#[repr(C)]
#[derive(Clone, Copy)]
struct Vtable {
    abi_version: u32,
    name: *const c_char,
    flags: u32,
    init: Option<unsafe extern "C" fn(*mut c_void, *const ApiTable) -> i32>,
    link: Option<unsafe extern "C" fn(*mut c_void, *const ApiTable) -> i32>,
    publish: Option<unsafe extern "C" fn(*mut c_void, *const ApiTable) -> i32>,
    apply: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void, u32) -> i32>,
    shutdown: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    destroy: Option<unsafe extern "C" fn(*mut c_void)>,
}

#[derive(Clone)]
struct Registered {
    module: CString,
    name: CString,
    func: ImportFn,
    ctx: *mut c_void,
}

/// What the adapter registered during `link`, so `ogre::init` can be called.
#[derive(Default)]
struct Collected {
    imports: Vec<Registered>,
    surface: Option<TensionHostSurface>,
    /// The size the stub reports. Mutable, because the point of the per-frame
    /// check is that the host's size *changes* — a frozen snapshot made the test
    /// assert 320x240 after a resize to 640x480, which is a harness bug, not an
    /// adapter one.
    ///
    /// Atomics because two threads touch them for real: the render thread reads
    /// these once per frame while this thread writes them across a resize. A
    /// plain tuple would be a data race that "works" until it doesn't.
    live_width: AtomicU32,
    live_height: AtomicU32,
    /// The names the host enabled, served by `host_surface_extension`. Empty
    /// until the window has a surface; the adapter reads them during `init`.
    extensions: Vec<String>,
    /// Incremented by `signal_frame`, which the adapter calls after every
    /// frame it presents. This is the only frame counter that crosses the ABI,
    /// so it is what "frame 1 rendered" means here.
    frames: AtomicU32,
    surface_calls: u32,
    surface_enosys: u32,
}

const ENOSYS: i32 = -38;
const EINVAL: i32 = -22;
const ENOENT: i32 = -2;
const ENODEV: i32 = -19;

/// Capture the adapter's log lines instead of discarding them: the log is where
/// the surface handoff and the per-frame resize check both announce themselves,
/// so it is the observable this test asserts on.
unsafe extern "C" fn capture_log(user: *mut c_void, _level: i32, msg: *const c_char, len: u32) {
    if user.is_null() || msg.is_null() {
        return;
    }
    let state = unsafe { &mut *(user as *mut State) };
    let bytes = unsafe { std::slice::from_raw_parts(msg as *const u8, len as usize) };
    let line = String::from_utf8_lossy(bytes).into_owned();
    // Echoed when asked for: a crash on the render thread kills the process
    // before the captured log can be printed, and an unbuffered stderr is the
    // only channel that survives it.
    if std::env::var_os("TENSION_TEST_TRACE").is_some() {
        eprintln!("  adapter: {line}");
    }
    state.logs.push(line);
}

/// The adapter logs through `log_named`, not the legacy `log` slot — so this is
/// where its lines actually arrive. Both are captured: which one a build uses is
/// not this test's business.
unsafe extern "C" fn capture_log_named(
    user: *mut c_void,
    _level: i32,
    _name: *const c_char,
    msg: *const c_char,
    len: u32,
) {
    if user.is_null() || msg.is_null() {
        return;
    }
    let state = unsafe { &mut *(user as *mut State) };
    let bytes = unsafe { std::slice::from_raw_parts(msg as *const u8, len as usize) };
    let line = String::from_utf8_lossy(bytes).into_owned();
    if std::env::var_os("TENSION_TEST_TRACE").is_some() {
        eprintln!("  adapter: {line}");
    }
    state.logs.push(line);
}

unsafe extern "C" fn record_import(
    user: *mut c_void,
    module: *const c_char,
    name: *const c_char,
    _ret: u32,
    _params: *const u32,
    _n: u32,
    func: ImportFn,
    ctx: *mut c_void,
    _verb: u32,
    _flags: u32,
) -> i32 {
    let collected = unsafe { &mut *(user as *mut Collected) };
    collected.imports.push(Registered {
        module: unsafe { CStr::from_ptr(module) }.to_owned(),
        name: unsafe { CStr::from_ptr(name) }.to_owned(),
        func,
        ctx,
    });
    0
}

unsafe extern "C" fn record_source(_: *mut c_void, _: *const c_char, _: u32, out: *mut u32) -> i32 {
    unsafe { *out = 1 };
    0
}

unsafe extern "C" fn record_region(_: *mut c_void, _: u32, off: *mut u32, size: *mut u32) -> i32 {
    unsafe {
        *off = 4096;
        *size = 65536;
    }
    0
}

/// The extensions the host enabled, as `host_surface`. `-ENOENT` past the end
/// is how the adapter enumerates, so the list needs no separate count.
unsafe extern "C" fn host_surface_extension(
    user: *mut c_void,
    index: u32,
    out_name: *mut c_char,
    capacity: u32,
    out_len: *mut u32,
) -> i32 {
    if user.is_null() || out_name.is_null() || out_len.is_null() || capacity < 256 {
        return EINVAL;
    }
    let collected = unsafe { &mut *(user as *mut Collected) };
    let Some(name) = collected.extensions.get(index as usize) else {
        return ENOENT;
    };
    let bytes = name.as_bytes();
    if bytes.len() + 1 > capacity as usize {
        return EINVAL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr() as *const c_char, out_name, bytes.len());
        *out_name.add(bytes.len()) = 0;
        *out_len = bytes.len() as u32;
    }
    0
}

/// The slot under test: hand back what the host published, or -ENOSYS.
unsafe extern "C" fn host_surface(user: *mut c_void, out: *mut TensionHostSurface) -> i32 {
    let collected = unsafe { &mut *(user as *mut Collected) };
    collected.surface_calls += 1;
    match collected.surface {
        Some(mut surface) => {
            // Zero means "not set yet"; the adapter treats a zero size as
            // "nothing to compare", which is the pre-resize behaviour.
            let (width, height) = (
                collected.live_width.load(Ordering::Relaxed),
                collected.live_height.load(Ordering::Relaxed),
            );
            if width != 0 && height != 0 {
                surface.width = width;
                surface.height = height;
            }
            unsafe { *out = surface };
            0
        }
        None => {
            collected.surface_enosys += 1;
            ENOSYS
        }
    }
}

/// `ogre::init(cfg_ptr, cfg_len)` takes guest pointers, and there is no guest.
///
/// The adapter reads the config through `guest_read`, so this test supplies a
/// `guest_read` that serves one buffer — the encoded TLV — and refuses
/// everything else. That is enough for `init`, which is the only verb called
/// here, and it keeps the test from needing an interpreter.
unsafe extern "C" fn guest_read(
    user: *mut c_void,
    ptr: u32,
    dst: *mut c_void,
    len: u32,
) -> i32 {
    // `user` is the `State`, not the buffer: `Collected` is its first field, so
    // casting to `GuestBuf` reads `Collected`'s bytes as a `Vec` and segfaults.
    // The first version did exactly that.
    let state = unsafe { &mut *((user as *mut State)).as_mut().expect("user is non-null") };
    let state = &mut state.guest;
    let start = ptr as usize;
    let end = start.saturating_add(len as usize);
    if end > state.bytes.len() {
        return EINVAL;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(state.bytes.as_ptr().add(start), dst as *mut u8, len as usize);
    }
    0
}

#[derive(Default)]
struct GuestBuf {
    bytes: Vec<u8>,
}

#[derive(Default)]
struct State {
    collected: Collected,
    guest: GuestBuf,
    logs: Vec<String>,
    /// Where `guest_write` deposits bytes. The adapter's `screenshot` verb
    /// writes pixels here through that slot; the render thread never touches
    /// it, so a plain `Vec` is enough.
    readback: Vec<u8>,
}

/// Did any captured log line contain `needle`?
fn logged(state: &State, needle: &str) -> bool {
    state.logs.iter().any(|line| line.contains(needle))
}

fn encode_config(renderer: u32, width: u32, height: u32, headless: bool) -> Vec<u8> {
    // `u32 count`, then per entry `u32 key`, `u8 tag`, `i64 value`.
    // Four entries, not five: `kMaxConfigBytes` caps the whole stream and five
    // entries is 69 bytes. `headless` is the optional one — the host's surface
    // is present, so the guest asking for a window is the honest encoding.
    let _ = headless;
    let entries: [(u32, i64); 4] = [
        (1, 1),                       // abi_version, must be first
        (2, renderer as i64),         // renderer
        (6, width as i64),
        (7, height as i64),
    ];
    let mut out = Vec::with_capacity(4 + entries.len() * 13);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (key, value) in entries {
        out.extend_from_slice(&key.to_le_bytes());
        out.push(2); // tag 2: i64
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// `TENSION_ADAPTER_ABI_VERSION`, parsed from the header.
///
/// `ogre_surface.rs` and `ogre_smoke.rs` parse it the same way, for the same
/// reason: the bin's `ffi` module is not exported to an integration test, and a
/// literal here is a second copy of a number that changed twice in one week.
fn adapter_header_abi_version() -> u32 {
    let header = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("include")
        .join("tension_adapter.h");
    let text = std::fs::read_to_string(&header)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", header.display()));
    text.lines()
        .find_map(|line| line.trim().strip_prefix("#define TENSION_ADAPTER_ABI_VERSION "))
        .map(|value| value.trim_end_matches('u').trim().parse::<u32>().expect("a number"))
        .unwrap_or_else(|| panic!("{} has no TENSION_ADAPTER_ABI_VERSION", header.display()))
}

fn dso_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("TENSION_OGRE_DSO") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-ogre")
        .join("build")
        .join("libtension_ogre.so");
    candidate.exists().then_some(candidate)
}

/// Wait until the adapter has presented more than `after` frames, and return the
/// count it reached (unchanged on timeout, so the caller's assertion fails).
fn wait_for_frames(state: &State, after: u32, timeout: std::time::Duration) -> u32 {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let frames = state.collected.frames.load(Ordering::SeqCst);
        if frames > after || std::time::Instant::now() >= deadline {
            return frames;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Ask the adapter for a frame of pixels, the way a guest would.
///
/// `ogre::screenshot(ptr, cap)` is the ABI's whole readback surface: it arms a
/// request, and if a frame has landed since the last one it writes tightly
/// packed RGBA8 to `ptr` and returns the byte count. `-1` means "armed, not
/// ready yet" — the download happens on the render thread at the next
/// `frameRenderingQueued`, which is *before* the swap, so this reads the image
/// Ogre just drew rather than one the presentation engine owns.
///
/// Returns the bytes, or `None` if none arrived before the timeout.
fn screenshot(
    state_ptr: *mut c_void,
    entry: &Registered,
    capacity: u32,
    timeout: std::time::Duration,
) -> Option<Vec<u8>> {
    let func = entry.func.expect("screenshot has a shim");
    let deadline = std::time::Instant::now() + timeout;
    loop {
        // SAFETY: `state_ptr` is the `State` the table's `user` points at, and
        // this thread is the only one that clears the buffer. The render thread
        // writes the *other* fields through atomics.
        unsafe { (*(state_ptr as *mut State)).readback.clear() };
        let mut ret = TensionValue { bits: 0 };
        let args = [
            TensionValue { bits: 0 },             // ptr: offset 0 in the sink
            TensionValue { bits: capacity as u64 },
        ];
        let rc = unsafe { func(entry.ctx, args.as_ptr(), 2, &mut ret) };
        let written = ret.bits as u32 as i32;
        if rc == 0 && written > 0 {
            // SAFETY: as above; the adapter has finished writing this buffer.
            let bytes = unsafe { (*(state_ptr as *mut State)).readback.clone() };
            return Some(bytes[..(written as usize).min(bytes.len())].to_vec());
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// How many captured log lines contain `needle`.
/// Ask for frames until one arrives at the expected byte length, or the deadline
/// passes.
///
/// **Why this exists rather than one `screenshot` call.** The frame counter and
/// the readback are two different facts: `wait_for_frames` proves a frame was
/// *presented*, and `screenshot` returns the most recently landed one, which can
/// still be a frame drawn before the swapchain rebuild took effect. Measured on
/// an unchanged tree: 1 failure in 15 runs of this test alone, and 1 in 6 runs
/// of the full suite — because the sleep before this point is wall clock and the
/// render thread's progress is not, so load changes the odds.
///
/// Bounding the wait on the *size* makes “when to look” deterministic without
/// weakening the claim: the assertion is still “a readback of exactly
/// `width*height*4` bytes exists after the resize”, and a build that never
/// rebuilds the swapchain still fails, 20 s later instead of immediately.
///
/// Returns the bytes on success; on timeout, `None` and the last size that *did*
/// arrive — the difference between “no frame at all” and “frames at the old
/// size” is the difference between a stalled render thread and a rebuild that
/// never happened. The second field is only meaningful when the first is `None`.
fn screenshot_of_size(
    state_ptr: *mut c_void,
    entry: &Registered,
    capacity: u32,
    width: u32,
    height: u32,
    timeout: std::time::Duration,
) -> (Option<Vec<u8>>, Option<usize>) {
    let expected = width as usize * height as usize * 4;
    let deadline = std::time::Instant::now() + timeout;
    let mut last_seen = None;
    loop {
        // One attempt per iteration; `screenshot` does the arming and the copy.
        if let Some(bytes) = screenshot(state_ptr, entry, capacity, std::time::Duration::from_millis(20)) {
            if bytes.len() == expected {
                return (Some(bytes), None);
            }
            last_seen = Some(bytes.len());
        }
        if std::time::Instant::now() >= deadline {
            return (None, last_seen);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn count_log(state: &State, needle: &str) -> usize {
    state.logs.iter().filter(|line| line.contains(needle)).count()
}

/// Wait until a captured log line contains `needle`.
fn wait_for_log(state: &State, needle: &str, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if logged(state, needle) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn check(condition: bool, what: &str) {
    if condition {
        println!("ok   {what}");
    } else {
        println!("FAIL {what}");
        std::process::exit(1);
    }
}

#[cfg(unix)]
fn main() {
    let dso = match dso_path() {
        Some(path) => path,
        None => {
            eprintln!("FAIL: no libtension_ogre.so; build it with `node scripts/build-ogre.mjs`");
            std::process::exit(1);
        }
    };

    // ── (a) the host owns a window and a surface ─────────────────────────
    let mut window = match HostWindow::new(
        "tension-ogre-host-surface",
        320,
        240,
        WindowTarget::Vulkan,
        HostShared::new(),
    ) {
        Ok(window) => window,
        Err(error) => {
            eprintln!("SKIP: no host window on this machine: {error}");
            std::process::exit(77);   // the suite treats 77 as "no display"
        }
    };
    let surface = match window.surface() {
        Ok(surface) => surface,
        Err(error) => {
            eprintln!("SKIP: no host surface on this machine: {error}");
            std::process::exit(77);
        }
    };
    println!("driver: {}  instance 0x{:x}  surface 0x{:x}",
             window.driver(), surface.instance, surface.surface);
    check(surface.instance != 0, "a. host instance is non-zero");
    check(surface.surface != 0, "a. host surface is non-zero");

    // ── (b) the adapter sees it through the ABI ──────────────────────────
    let c_path = CString::new(dso.to_string_lossy().as_bytes()).expect("no NUL in a path");
    // SAFETY: dlopen of a shared object this repository built.
    let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    check(!handle.is_null(), "b. libtension_ogre.so loads");
    let symbol = unsafe { libc::dlsym(handle, c"tension_adapter_v1".as_ptr()) };
    check(!symbol.is_null(), "b. the adapter exports tension_adapter_v1");

    let entry: extern "C" fn() -> *const Vtable = unsafe { std::mem::transmute(symbol) };
    let vtable = entry();
    check(!vtable.is_null(), "b. the vtable is non-null");
    let abi = unsafe { (*vtable).abi_version };
    // Parsed from the header rather than written down: this check used to hold a
    // literal, and it went stale on the very next bump (ABI v7), failing with
    // the adapter — which was rebuilt correctly — accused of being old. A number
    // the header owns has no business in a second copy.
    check(
        abi == adapter_header_abi_version(),
        &format!("b. the adapter is built against ABI {}", adapter_header_abi_version()),
    );

    let mut state = Box::new(State::default());
    state.collected.surface = Some(TensionHostSurface {
        struct_size: std::mem::size_of::<TensionHostSurface>() as u32,
        width: surface.width,
        height: surface.height,
        reserved: 0,
        instance: surface.instance,
        surface: surface.surface,
        native_handle: surface.native_handle,
    });
    // The adapter asks for these during `init`; Ogre's external-instance path
    // treats them as the record of what the instance enabled. Handing over the
    // window's real list is the whole point — an empty one would tell Ogre the
    // instance has nothing, and the swapchain would be built without the
    // window-system extension the surface needs.
    state.collected.extensions = window.instance_extensions().to_vec();
    println!("instance extensions: {:?}", state.collected.extensions);
    let state_ptr = &mut *state as *mut State as *mut c_void;

    let api = ApiTable {
        abi_version: abi,
        user: state_ptr,
        guest_read: Some(guest_read),
        guest_write: Some(guest_write),
        guest_size: Some(guest_size),
        resolve_callback: Some(refuse_resolve),
        call_callback: Some(refuse_call),
        release_callback: Some(release_nothing),
        log: Some(capture_log),
        register_import: Some(record_import),
        register_source: Some(record_source),
        post_event: Some(post_nothing),
        class_info: Some(class_info_nothing),
        region_lookup: Some(record_region),
        log_named: Some(capture_log_named),
        log_structured: Some(capture_log_named),
        guest_read_checked: Some(guest_read_checked_stub),
        signal_frame: Some(count_frame),
        shader_generate: Some(shader_nothing),
        compile_graph: Some(compile_nothing),
        post_control: Some(refuse_control),
        host_surface: Some(host_surface),
        host_surface_extension: Some(host_surface_extension),
        // ABI v7: Ogre registers no event layer, so these stay NULL.
        register_event_layer: None,
        unregister_event_layer: None,
        host_window_info: None,
        pad_state: None,
    };

    let init = unsafe { (*vtable).init }.expect("init is present");
    check(unsafe { init(std::ptr::null_mut(), &api) } == 0, "b. adapter init accepts the table");
    let link = unsafe { (*vtable).link }.expect("link is present");
    check(unsafe { link(std::ptr::null_mut(), &api) } == 0, "b. adapter link succeeds");

    // The config goes into the buffer `guest_read` serves *before* `init` runs;
    // the first version of this test assigned it afterwards and `init` then
    // reported "config length is out of range" for a stream of zero bytes.
    let config = encode_config(3 /* Vulkan */, surface.width, surface.height, false);
    state.guest.bytes = config;
    println!("config: {} bytes, renderer=Vulkan", state.guest.bytes.len());

    // Call `ogre::init` with the encoded config. It reads the config through
    // `guest_read`, reads the host surface through `host_surface`, and starts
    // the render thread — the thread that will render and, once per frame,
    // compare the host's size against its own.
    let init_import = state
        .collected
        .imports
        .iter()
        .find(|registered| registered.name.to_str() == Ok("init"))
        .cloned()
        .expect("ogre::init is registered");
    {
        let mut ret = TensionValue { bits: 0 };
        let args = [
            TensionValue { bits: 0 },                        // cfg_ptr: our buffer starts at 0
            TensionValue { bits: state.guest.bytes.len() as u64 },
        ];
        let func = init_import.func.expect("init has a shim");
        println!("  calling init with cfg_ptr={} cfg_len={}", args[0].bits, args[1].bits);
        let rc = unsafe { func(init_import.ctx, args.as_ptr(), 2, &mut ret) };
        println!("  init rc = {rc}");
        for line in &state.logs {
            println!("  adapter: {line}");
        }
        check(rc == 0, "c. ogre::init accepted the config");
        check(ret.bits == 0, "c. ogre::init returned 0 in the result slot");
    }
    check(
        state.collected.surface_calls > 0,
        "c. the adapter asked the host for its surface during init",
    );
    check(
        state.collected.surface_enosys == 0,
        "c. host_surface answered 0, never -ENOSYS",
    );
    check(
        logged(&state, "host's surface"),
        "c. the adapter logged the host surface it adopted",
    );

    // ── (c) frame 1 ──────────────────────────────────────────────────────
    //
    // `ogre::init` starts a render thread; the frames are driven by the
    // adapter's own loop, and it reports each one through `signal_frame`.
    // Without this counter "it rendered" would mean "it did not crash".
    let frames_at_start = wait_for_frames(&state, 0, std::time::Duration::from_secs(60));
    println!("  frames presented after init: {frames_at_start}");
    check(frames_at_start > 0, "c. frame 1 rendered into the host surface");
    check(
        logged(&state, "Vulkan plugin loading with the host's instance"),
        "c. the Vulkan plugin was loaded with the host's instance, not its own",
    );
    check(
        logged(&state, "host instance extension:"),
        "c. the host's extension names reached the plugin",
    );

    // ── (c) the pixels, at the size the host asked for ───────────────────
    //
    // "A frame was presented" and "the swapchain holds a frame of the right
    // size" are different claims, and only the first was proven until now. The
    // readback is Ogre's own download ticket, taken in `frameRenderingQueued` —
    // before the swap, so it reads the image just drawn rather than one the
    // presentation engine owns.
    //
    // Dimension, not colour: the default clear is black, and "cleared to black"
    // is indistinguishable from "never cleared" by mean pixel value. A byte
    // count of `w * h * 4` is not ambiguous — a stale 320x240 swapchain would
    // report 307200 here no matter what its pixels contained.
    const SHOT_CAP: u32 = 4 * 1024 * 1024;
    let shot = state
        .collected
        .imports
        .iter()
        .find(|registered| registered.name.to_str() == Ok("screenshot"))
        .cloned();
    check(shot.is_some(), "c. ogre::screenshot is registered");
    let mut frame1_px = Vec::new();
    if let Some(entry) = &shot {
        let pixels = screenshot(state_ptr, entry, SHOT_CAP, std::time::Duration::from_secs(20));
        let expected = (surface.width * surface.height * 4) as usize;
        match &pixels {
            Some(bytes) => {
                println!(
                    "  frame 1 readback: {} bytes (expected {expected} for {}x{})",
                    bytes.len(),
                    surface.width,
                    surface.height
                );
                check(!bytes.is_empty(), "c. frame 1 readback returned pixels");
                check(
                    bytes.len() == expected,
                    "c. frame 1 readback is exactly w*h*4 at the host's size",
                );
            }
            None => {
                println!("  FAIL frame 1 readback: no pixels within 20s");
                std::process::exit(1);
            }
        }
        frame1_px = pixels.unwrap_or_default();
    }

    // ── (d) resize the host ──────────────────────────────────────────────
    window.set_size(640, 480).expect("set_size");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let events = window.pump();
        if events.resized == Some((640, 480)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let (width, height) = window.published_size();
    check((width, height) == (640, 480), "d. the host published the new size");
    // The stub now serves the *live* size, which is what the adapter polls once
    // per frame. Stored before the wait below, so the render thread's next
    // comparison sees 640x480 rather than the size it started at.
    state.collected.live_width.store(width, Ordering::SeqCst);
    state.collected.live_height.store(height, Ordering::SeqCst);

    // ── (e) what the renderer would see next frame ───────────────────────
    //
    // The adapter reads this through `host_surface` once per frame and compares
    // it against its own window; a difference is what triggers
    // `requestResolution` and therefore the resize hunk. Asserting the *value*
    // is what makes this a proof rather than a liveness check.
    let mut observed = TensionHostSurface {
        struct_size: std::mem::size_of::<TensionHostSurface>() as u32,
        width: 0,
        height: 0,
        reserved: 0,
        instance: 0,
        surface: 0,
        native_handle: 0,
    };
    // SAFETY: `host_surface` above, routed through the table the adapter holds.
    let rc = unsafe { host_surface(state_ptr, &mut observed) };
    check(rc == 0, "e. host_surface answers after the resize");
    check(
        (observed.width, observed.height) == (640, 480),
        "e. the renderer would see 640x480 and ask for a swapchain rebuild",
    );
    // The second currency travels with the first. A render system that cannot
    // adopt the `VkSurfaceKHR` — GL3+, D3D11 — adopts this instead, and the two
    // are published from one record so they cannot disagree about which window
    // they name.
    //
    // **Zero is a legal answer on some drivers.** `HostWindow::native_handle`
    // documents 0 for a platform with no adoptable handle — Wayland's
    // `wl_surface` is not one any render system here accepts — so the assertion
    // is "either there is no handle, or it is the window's own", never "there is
    // always a handle". Requiring non-zero on all of Linux made this test pass
    // on X11 and fail on a native Wayland session, which is a property of the
    // driver, not of the host surface path it is testing.
    let publishes_handle = !matches!(window.driver(), "wayland" | "offscreen" | "dummy");
    if publishes_handle {
        check(
            observed.native_handle != 0,
            "e. the host published a native window handle alongside the surface",
        );
    } else {
        check(
            observed.native_handle == 0,
            "e. the driver publishes no native handle, and the record says 0 rather than a stale one",
        );
    }
    check(
        observed.native_handle == state.collected.surface.unwrap().native_handle,
        "e. the native handle is the window's, not a second one",
    );

    // ── (e) frame 2, after the resize ────────────────────────────────────
    //
    // Two separate facts, and the difference between them is the whole point:
    //
    //   * the adapter *noticed* the host's new size and called
    //     `requestResolution` (the log line), and
    //   * a frame was presented *after* that call.
    //
    // A run where the rebuild is requested and the next frame fails is a
    // resize-hunk finding, not a pass. So both are asserted, in order.
    let rebuild = wait_for_log(&state, "requesting a swapchain rebuild", std::time::Duration::from_secs(30));
    check(rebuild, "e. Ogre asked the swapchain to rebuild after the host resize");
    let frames_after = wait_for_frames(&state, frames_at_start, std::time::Duration::from_secs(30));
    println!("  frames presented after the resize: {frames_after}");
    check(
        frames_after > frames_at_start,
        "e. a frame was presented after the rebuild request",
    );

    // Did the rebuild take effect, or does the size check fire every frame?
    //
    // `requestResolution` on the external-surface path ends in
    // `setFinalResolution`, so Ogre's own width becomes the host's and the
    // per-frame comparison stops finding a difference. If that did not happen,
    // the same log line repeats at the frame rate — which distinguishes "asked
    // for a rebuild" from "rebuilt".
    let rebuilds_before = count_log(&state, "requesting a swapchain rebuild");
    std::thread::sleep(std::time::Duration::from_millis(400));
    let rebuilds_after = count_log(&state, "requesting a swapchain rebuild");
    println!("  rebuild requests: {rebuilds_before} -> {rebuilds_after}");
    check(
        rebuilds_after == rebuilds_before,
        "e. the rebuild converged: the size check stopped firing once Ogre took the new size",
    );

    // ── (e) the pixels, at the new size ──────────────────────────────────
    //
    // This is the pixel-level half of the resize claim. Ogre's window metadata
    // says 640x480 after `setFinalResolution`, but metadata is what
    // `requestResolution` writes; the swapchain images are what matter. A
    // readback that comes back 640x480x4 means the rebuilt swapchain is the one
    // being drawn into, not the old one still attached.
    if let Some(entry) = &shot {
        match screenshot_of_size(state_ptr, entry, SHOT_CAP, 640, 480, std::time::Duration::from_secs(20)) {
            (Some(bytes), _) => {
                println!("  frame 2 readback: {} bytes (expected {})", bytes.len(), 640 * 480 * 4);
                check(!bytes.is_empty(), "e. frame 2 readback returned pixels");
                check(
                    bytes.len() == 640 * 480 * 4,
                    "e. frame 2 readback is exactly 640x480x4 — the rebuilt swapchain is the one drawn into",
                );
                // A frame that is new but never written to would be all zeroes.
                // Dimension is the load-bearing claim; this only rules out the
                // crudest form of "the image was never touched".
                let non_zero = bytes.iter().filter(|byte| **byte != 0).count();
                println!("  frame 2 non-zero bytes: {non_zero} of {}", bytes.len());
                check(non_zero > 0, "e. frame 2 readback is not an untouched zero buffer");
            }
            (None, last_seen) => {
                match last_seen {
                    Some(size) => println!(
                        "  FAIL frame 2 readback: frames kept arriving at {size} bytes, never 640x480x4, within 20s"
                    ),
                    None => println!("  FAIL frame 2 readback: no pixels within 20s after the resize"),
                }
                std::process::exit(1);
            }
        }
        // ── settled ──────────────────────────────────────────────────────
        //
        // No new resize, a couple of hundred milliseconds of ordinary frames:
        // the size must not flap. A rebuild loop or a bounce between the host's
        // size and Ogre's would show up here as a third dimension.
        //
        // One sample is enough here, and that is not the same bet the frame-2
        // readback above was making: `screenshot` returns the most recently
        // landed frame, and a 640x480x4 one has already landed, so no older
        // frame can arrive behind it. The convergence check above catches an
        // actual flap — every flap logs a rebuild request.
        std::thread::sleep(std::time::Duration::from_millis(200));
        match screenshot(state_ptr, entry, SHOT_CAP, std::time::Duration::from_secs(20)) {
            Some(bytes) => {
                println!("  settle readback: {} bytes", bytes.len());
                check(
                    bytes.len() == 640 * 480 * 4,
                    "e. settled readback is still 640x480x4 — the size is stable",
                );
            }
            None => {
                println!("  FAIL settle readback: no pixels within 20s of settling");
                std::process::exit(1);
            }
        }
    }
    if frame1_px.is_empty() {
        println!("  note: frame 1 produced no pixels, so the 320x240 readback was not exercised");
    }

    // ── (f) window_handle ────────────────────────────────────────────────
    //
    // This must be -ENODEV: the host owns the window, so Ogre has no native
    // handle to report. The verb is a deprecated stub — v7 retired the exchange
    // rather than re-pointing it (`docs/vision.md` §5.5, `INPUT.md` §3).
    let window_handle = state
        .collected
        .imports
        .iter()
        .find(|registered| registered.name.to_str() == Ok("window_handle"))
        .cloned();
    check(window_handle.is_some(), "f. ogre::window_handle is registered");
    if let Some(entry) = window_handle {
        let func = entry.func.expect("window_handle has a shim");
        let mut ret = TensionValue { bits: 0 };
        let args = [TensionValue { bits: 0 }, TensionValue { bits: 0 }];
        let rc = unsafe { func(entry.ctx, args.as_ptr(), 2, &mut ret) };
        println!("  window_handle rc = {rc}");
        // `tension_value` is a union: the shim writes `ret->i32`, so only the
        // low 32 bits are set and the high half keeps whatever the caller left
        // (zero here). Comparing the whole u64 against `ENODEV as u64` compares
        // a sign-extended negative against a zero-extended one and fails on a
        // correct answer — which is what the first version of this line did.
        check(
            rc == ENODEV && ret.bits as u32 as i32 == ENODEV,
            "f. ogre::window_handle answers -ENODEV while the host owns the window",
        );
    }

    // ── (g) teardown: adapter first, instance last ───────────────────────
    if let Some(shutdown) = unsafe { (*vtable).shutdown } {
        check(unsafe { shutdown(std::ptr::null_mut()) } == 0, "g. adapter shutdown returns 0");
    }
    if let Some(destroy) = unsafe { (*vtable).destroy } {
        unsafe { destroy(std::ptr::null_mut()) };
        println!("ok   g. adapter destroy returned");
    }
    unsafe { libc::dlclose(handle) };
    drop(window);
    println!("PASS: host surface handed to Ogre, resized, and torn down in order");
}

unsafe extern "C" fn guest_size(_: *mut c_void) -> u32 {
    u32::MAX
}

// ── stubs for the slots this test does not drive ────────────────────────────
//
// The core API's documented invariant is that *every* slot is a real function
// pointer, so an adapter that calls one gets a refusal rather than a null
// dereference. This test's first version left seven of them null and took a
// SIGSEGV inside `ogre::init` — the invariant is not decoration.

unsafe extern "C" fn refuse_control(_: *mut c_void, _: *const CtrlMsg) -> i32 { ENOSYS }

/// A real guest write, because `ogre::screenshot` hands its pixels back through
/// this slot: refusing it would test the refusal instead of the screenshot.
/// `ptr` is an offset into one flat guest buffer, which is how the adapter uses
/// it (the test chooses the offset, always 0).
unsafe extern "C" fn guest_write(user: *mut c_void, ptr: u32, src: *const c_void, len: u32) -> i32 {
    if user.is_null() || src.is_null() {
        return EINVAL;
    }
    let state = unsafe { &mut *(user as *mut State) };
    let start = ptr as usize;
    let end = start.saturating_add(len as usize);
    if end > state.readback.len() {
        state.readback.resize(end, 0);
    }
    unsafe {
        std::ptr::copy_nonoverlapping(src as *const u8, state.readback.as_mut_ptr().add(start), len as usize);
    }
    0
}

unsafe extern "C" fn refuse_resolve(_: *mut c_void, _: u32, _: u32, _: *const u32, _: u32, _: *mut *mut c_void) -> i32 { ENOSYS }

unsafe extern "C" fn refuse_call(_: *mut c_void, _: *mut c_void, _: *const TensionValue, _: u32, _: *mut TensionValue) -> i32 { ENOSYS }

unsafe extern "C" fn release_nothing(_: *mut c_void, _: *mut c_void) -> i32 { 0 }

unsafe extern "C" fn post_nothing(_: *mut c_void, _: u32, _: u32, _: u32, _: u32, _: u32, _: f32, _: f32, _: *mut u64) -> i32 { ENOSYS }

unsafe extern "C" fn class_info_nothing(_: *mut c_void, _: u32, _: *mut u32, _: *mut u32, _: *mut u32) -> i32 { ENOSYS }

unsafe extern "C" fn guest_read_checked_stub(user: *mut c_void, ptr: u32, dst: *mut c_void, len: u32, _cap: u32) -> i32 {
    unsafe { guest_read(user, ptr, dst, len) }
}

/// The adapter's "I presented a frame" signal, which is the only frame counter
/// that crosses the ABI. Counted with an atomic because the render thread calls
/// it while this thread polls the count.
unsafe extern "C" fn count_frame(user: *mut c_void) {
    if user.is_null() {
        return;
    }
    let state = unsafe { &*(user as *const State) };
    let n = state.collected.frames.fetch_add(1, Ordering::SeqCst) + 1;
    if std::env::var_os("TENSION_TEST_TRACE").is_some() {
        eprintln!("  frame {n} presented");
    }
}

unsafe extern "C" fn shader_nothing(_: *const c_void, _: *mut c_char, _: u32) -> i32 { ENOSYS }

unsafe extern "C" fn compile_nothing(_: *mut c_void, _: *const u8, _: u32, _: *mut u8, _: u32, _: *mut u8, _: u32, _: *mut u32, _: *mut u32) -> i32 { ENOSYS }

/// What a Windows run reports.
///
/// `harness = false` means the exit status *is* the verdict, and cargo has no
/// third state, so this prints the reason and exits 0. The alternative — exit
/// non-zero — makes `npm test -- core` red on every Windows machine for a test
/// that cannot run there at all, which teaches people to ignore the suite.
#[cfg(not(unix))]
fn main() {
    eprintln!(
        "SKIP: ogre_host_surface loads the adapter through `libc::dlopen`, which has no \
         Windows equivalent here; the host window and surface halves of this probe are \
         covered by the platform_create / platform_surface suites."
    );
}
