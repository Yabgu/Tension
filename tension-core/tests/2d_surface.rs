//! The 2D adapter's structural test — `ogre_surface.rs`'s twin.
//!
//! The audit that opened this pass found the gap this file closes: OGRE's guest
//! surface is pinned by a test that loads the DSO and checks every registration,
//! and 2D's was not. The 2D verb surface was "pinned by the smoke core instead"
//! (`docs/modules/2d.md` §2), which is a different claim — the smoke core runs
//! *behaviour*, and behaviour passes as long as the verbs it happens to call are
//! right.
//!
//! This file is the other claim: that `tension::2d` registers exactly the ten
//! verbs the header declares, at the verb ids the header assigns, with the flags
//! it marks, and with the vtable slots a regionless capability must leave NULL.
//! A guest SDK whose imports drift from this no longer has pixels to blame — the
//! drift shows up here as a diff against a pin.
//!
//! It is display-free and GPU-free: no device is created, because `open` is the
//! verb that creates one and this test calls no verb. It starts no thread and
//! touches no guest memory, so it can live in `cargo test`.
//!
//! The DSO is found at `TENSION_2D_DSO_PATH` when that is set, otherwise at
//! `tension-2d/build/libtension_2d.so` beside this crate. Absent, the test says
//! so and fails — `support/ci.rs` is the one place that policy lives.
//!
//! ## What this test asserts that the brief did not
//!
//! The pass's instructions said to expect "the vtable registers 9 verbs …
//! skipping shader_compile_raw's id", and "info (id 8) and screenshot (id 9) are
//! REENTRANT_READONLY". Both are wrong, and the test follows the code:
//!
//!   * the vtable registers **ten** verbs, id 4 (`shader_compile_raw`)
//!     **included** — the adapter answers `-ENOSYS` at the verb rather than
//!     omitting the registration (`adapter.cpp:460`, `:248-254`). The SDK omits
//!     the wrapper; the wire keeps the door.
//!   * **only `info`** carries `TENSION_IMPORT_REENTRANT_READONLY`
//!     (`adapter.cpp:465`). `screenshot` waits for the GPU, so it cannot be
//!     called from a callback, and it registers flags 0 (`adapter.cpp:466`).
//!
//! The instructions also asked for "post_control returns ENOSYS" and
//! "host_surface returns ENOSYS". Neither is an adapter-side slot: they are
//! `tension_core_api` fields the adapter may *call*. 2D declares no interest in
//! either, so the testable form of that claim is that the adapter never calls
//! them — which the recording stubs below assert by counting calls during
//! `init` and `link`.

#[path = "support/ci.rs"]
mod support_ci;

use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ── the ABI, mirrored from tension-core/include/tension_adapter.h ────────
//
// Only the fields this test drives are exercised; the rest exist so the struct
// has the session's exact size and field order. The size assertion below is
// what keeps this mirror honest — a table shorter than the real one is a trap
// for the next slot a DSO does read, which is the bug `ogre_surface.rs` records
// having had.

/// `tension_value` is one 8-byte slot; the imports under test take `i32`s.
#[repr(C, align(8))]
#[allow(dead_code)]
struct TensionValue {
    bits: u64,
}

type ImportFn = Option<unsafe extern "C" fn(*mut c_void, *const TensionValue, u32, *mut TensionValue) -> i32>;

#[derive(Clone, Copy)]
#[repr(C)]
struct ApiTable {
    abi_version: u32,
    user: *mut c_void,
    guest_read: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32) -> i32>,
    guest_write: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void, u32) -> i32>,
    guest_size: Option<unsafe extern "C" fn(*mut c_void) -> u32>,
    resolve_callback:
        Option<unsafe extern "C" fn(*mut c_void, u32, u32, *const u32, u32, *mut *mut c_void) -> i32>,
    call_callback: Option<
        unsafe extern "C" fn(*mut c_void, *mut c_void, *const TensionValue, u32, *mut TensionValue) -> i32,
    >,
    release_callback: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
    log: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, u32)>,
    register_import: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
            u32,
            *const u32,
            u32,
            ImportFn,
            *mut c_void,
            u32,
            u32,
        ) -> i32,
    >,
    register_source: Option<unsafe extern "C" fn(*mut c_void, *const c_char, u32, *mut u32) -> i32>,
    post_event:
        Option<unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32, u32, f32, f32, *mut u64) -> i32>,
    class_info: Option<unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32, *mut u32) -> i32>,
    region_lookup: Option<unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32) -> i32>,
    log_named: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, *const c_char, u32)>,
    log_structured: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, *const c_char, u32)>,
    guest_read_checked:
        Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32, u32) -> i32>,
    signal_frame: Option<unsafe extern "C" fn(*mut c_void)>,
    shader_generate:
        Option<unsafe extern "C" fn(*const c_void, *mut c_char, u32) -> i32>,
    compile_graph: Option<
        unsafe extern "C" fn(
            *mut c_void,
            *const u8,
            u32,
            *mut u8,
            u32,
            *mut u8,
            u32,
            *mut u32,
            *mut u32,
        ) -> i32,
    >,
    post_control: Option<unsafe extern "C" fn(*mut c_void, *const TensionCtrlMsg) -> i32>,
    host_surface: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
    host_surface_extension:
        Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_char, u32, *mut u32) -> i32>,
}

/// Mirrors `tension_ctrl_msg` (ABI v6). Eight 4-byte fields, no padding.
#[repr(C)]
#[derive(Clone, Copy)]
struct TensionCtrlMsg {
    kind: u32,
    visibility: u32,
    arg0: i32,
    arg1: i32,
    arg2: i32,
    arg3: i32,
    source: u32,
    reserved: u32,
}

const _: () = assert!(std::mem::size_of::<ApiTable>() == 184);
const _: () = assert!(std::mem::size_of::<TensionCtrlMsg>() == 32);

#[repr(C)]
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
    // Appended under rule 11, after `destroy`. `ogre_surface.rs` stops one field
    // short of this; the field exists, and a test that pins the vtable should
    // pin all of it.
    layout_hash: u32,
}

/// `TENSION_ADAPTER_ABI_VERSION`, parsed from the header.
///
/// A literal would be a second copy of a number the header owns, and both
/// surface tests used to hold one — and both were wrong within one bump.
fn tension_adapter_abi_version() -> u32 {
    header_define("TENSION_ADAPTER_ABI_VERSION")
}

/// `TENSION_ADAPTER_LAYOUT_HASH`, parsed from the header, for the same reason.
fn tension_adapter_layout_hash() -> u32 {
    header_define("TENSION_ADAPTER_LAYOUT_HASH")
}

fn header_define(name: &str) -> u32 {
    let header = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("include")
        .join("tension_adapter.h");
    let text = std::fs::read_to_string(&header)
        .unwrap_or_else(|e| panic!("{} is not readable: {e}", header.display()));
    let prefix = format!("#define {name} ");
    text.lines()
        .find_map(|line| line.trim().strip_prefix(prefix.as_str()))
        .map(|rest| rest.trim().trim_end_matches('u'))
        .and_then(|number| number.parse().ok())
        .unwrap_or_else(|| panic!("{} has no {name}", header.display()))
}

const TENSION_VT_I32: u32 = 1;
const TENSION_IMPORT_REENTRANT_READONLY: u32 = 1 << 1;

// ── what the adapter registers, as it registers it ───────────────────────

#[derive(Clone, Debug, PartialEq)]
struct Registered {
    module: String,
    name: String,
    ret_type: u32,
    nparams: u32,
    verb_id: u32,
    flags: u32,
}

#[derive(Default)]
struct Recorded {
    imports: Vec<Registered>,
    sources: Vec<String>,
    regions: Vec<u32>,
    post_control_calls: u32,
    host_surface_calls: u32,
}

static RECORDED: Mutex<Option<Recorded>> = Mutex::new(None);

fn with_recorded<T>(f: impl FnOnce(&mut Recorded) -> T) -> T {
    let mut guard = RECORDED.lock().expect("the recording mutex");
    f(guard.as_mut().expect("init() seeds the recording"))
}

unsafe extern "C" fn record_import(
    _user: *mut c_void,
    module: *const c_char,
    name: *const c_char,
    ret_type: u32,
    _params: *const u32,
    nparams: u32,
    _function: ImportFn,
    _ctx: *mut c_void,
    verb_id: u32,
    flags: u32,
) -> i32 {
    let module = unsafe { CStr::from_ptr(module) }.to_string_lossy().into_owned();
    let name = unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned();
    with_recorded(|recorded| {
        recorded.imports.push(Registered { module, name, ret_type, nparams, verb_id, flags });
    });
    0
}

unsafe extern "C" fn record_source(
    _user: *mut c_void,
    name: *const c_char,
    _hint: u32,
    out_source_id: *mut u32,
) -> i32 {
    let name = unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned();
    with_recorded(|recorded| recorded.sources.push(name));
    if !out_source_id.is_null() {
        unsafe { *out_source_id = 1 };
    }
    0
}

unsafe extern "C" fn record_region(
    _user: *mut c_void,
    kind: u32,
    _out_offset: *mut u32,
    _out_size: *mut u32,
) -> i32 {
    with_recorded(|recorded| recorded.regions.push(kind));
    0
}

unsafe extern "C" fn quiet_log(_user: *mut c_void, _level: i32, _msg: *const c_char, _len: u32) {}

/// A `post_control` that answers "handled" if it is ever called, and counts.
///
/// `-ENOSYS` would be the honest answer for a host that does not route control
/// messages, and the adapter would then be expected to carry on — but 2D never
/// asks, so which answer it gets is moot. Counting is the assertion: the answer
/// value only matters if the call happens, and the test fails if it does.
unsafe extern "C" fn count_post_control(_user: *mut c_void, _msg: *const TensionCtrlMsg) -> i32 {
    with_recorded(|recorded| recorded.post_control_calls += 1);
    -38 // -ENOSYS: this host does not consume control messages
}

/// A `host_surface` that reports "no surface", and counts.
unsafe extern "C" fn count_host_surface(_user: *mut c_void, _out: *mut c_void) -> i32 {
    with_recorded(|recorded| recorded.host_surface_calls += 1);
    -38 // -ENOSYS: there is no host surface to hand out (contradiction 24)
}

// ── finding the DSO ─────────────────────────────────────────────────────

fn dso_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("TENSION_2D_DSO_PATH") {
        return PathBuf::from(explicit);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-2d")
        .join("build")
        .join("libtension_2d.so")
}

#[cfg(windows)]
extern "system" {
    fn LoadLibraryExA(
        lpLibFileName: *const std::ffi::c_char,
        hFile: *mut std::ffi::c_void,
        dwFlags: u32,
    ) -> *mut std::ffi::c_void;
    fn GetProcAddress(hModule: *mut std::ffi::c_void, lpProcName: *const std::ffi::c_char) -> *mut std::ffi::c_void;
}

fn load(path: &Path) -> Option<*const Vtable> {
    if !path.exists() {
        support_ci::skip_or_fail(format_args!(
            "2d_surface: {} is not built — run `node scripts/build-2d.mjs`; skipping the surface test",
            path.display()
        ));
        return None;
    }
    let _c_path = std::ffi::CString::new(path.to_str().expect("utf-8 path")).expect("no interior nul");
    #[cfg(windows)]
    let (library, symbol) = unsafe {
        // LOAD_WITH_ALTERED_SEARCH_PATH (0x8): the adapter's import is SDL3, which
        // the build stages beside it.
        const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;
        let absolute = std::path::absolute(path).expect("an absolute path to the DSO");
        let c_abs = std::ffi::CString::new(absolute.to_str().expect("utf-8 path"))
            .expect("no interior nul");
        let lib = LoadLibraryExA(c_abs.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH);
        let sym = if !lib.is_null() {
            GetProcAddress(lib, c"tension_adapter_v1".as_ptr())
        } else {
            std::ptr::null_mut()
        };
        (lib, sym)
    };
    #[cfg(unix)]
    let (library, symbol) = unsafe {
        let lib = libc::dlopen(_c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        let sym = if !lib.is_null() {
            libc::dlsym(lib, c"tension_adapter_v1".as_ptr())
        } else {
            std::ptr::null_mut()
        };
        (lib, sym)
    };
    assert!(!library.is_null(), "dlopen/LoadLibrary failed for {}", path.display());
    assert!(
        !symbol.is_null(),
        "{} has no tension_adapter_v1 symbol — the one name the session looks up",
        path.display()
    );
    let entry: extern "C" fn() -> *const Vtable = unsafe { std::mem::transmute(symbol) };
    let vtable = entry();
    assert!(!vtable.is_null(), "tension_adapter_v1 returned null");
    // The library stays open for the process's lifetime: the adapter's state
    // lives in it, and dlclose would tear that down under a live thread.
    Some(vtable)
}

/// The ten verbs the header declares, in registration order, with the
/// parameter count each registers.
///
/// `adapter.cpp:451-471` is the table this restates. Written out rather than
/// derived from the header, because the header gives signatures in prose and
/// the wire gives arity: this is the pin, and it is meant to be read beside
/// that table.
fn expected_registrations() -> Vec<Registered> {
    let verb = |name: &str, nparams: u32, verb_id: u32, flags: u32| Registered {
        module: "tension::2d".into(),
        name: name.into(),
        ret_type: TENSION_VT_I32,
        nparams,
        verb_id,
        flags,
    };
    vec![
        verb("open", 3, 1, 0),
        verb("close", 1, 2, 0),
        verb("set_pipeline", 3, 3, 0),
        // Registered, and `-ENOSYS` at the verb. The SDK omits the wrapper; the
        // wire keeps the door (tension_2d.h:143-151).
        verb("shader_compile_raw", 5, 4, 0),
        verb("submit", 4, 5, 0),
        verb("present", 1, 6, 0),
        verb("texture_load", 4, 7, 0),
        // The only re-entrant verb: a snapshot, no blocking, no pump.
        verb("info", 3, 8, TENSION_IMPORT_REENTRANT_READONLY),
        // Not re-entrant: it waits for the GPU, which no callback may do.
        verb("screenshot", 3, 9, 0),
        // Appended last so no existing id moved (adapter.cpp:467-469).
        verb("set_texture", 4, 10, 0),
    ]
}

#[test]
fn test_2d_adapter_surface() {
    let path = dso_path();
    let Some(vtable) = load(&path) else { return };
    *RECORDED.lock().expect("the recording mutex") = Some(Recorded::default());

    // ── the vtable itself ────────────────────────────────────────────────
    assert_eq!(unsafe { (*vtable).abi_version }, tension_adapter_abi_version());
    let name = unsafe { CStr::from_ptr((*vtable).name) }.to_string_lossy().into_owned();
    assert_eq!(name, "tension::2d", "the vtable names the wasm module it implements");
    assert_eq!(unsafe { (*vtable).flags }, 0, "flags are reserved");
    assert_eq!(
        unsafe { (*vtable).layout_hash },
        tension_adapter_layout_hash(),
        "the arena layout the adapter was built against"
    );

    let init = unsafe { (*vtable).init }.expect("init is present");
    let link = unsafe { (*vtable).link }.expect("link is present");
    let shutdown = unsafe { (*vtable).shutdown }.expect("shutdown must be present");
    let _destroy = unsafe { (*vtable).destroy }.expect("destroy must be present");
    assert!(
        unsafe { (*vtable).publish }.is_none(),
        "2D owns no regions, so publish is NULL (tension_2d.h:35-43)"
    );
    assert!(
        unsafe { (*vtable).apply }.is_none(),
        "no verb is DEFERRABLE, so apply is NULL — `submit` must answer a count, and a \
         deferred call cannot (docs/modules/2d.md §2)"
    );

    // ── init: the ABI check and nothing else ─────────────────────────────
    //
    // Every appended slot is `None` on purpose. `None` is a null function
    // pointer, so an adapter that reads one during init or link faults — a loud
    // failure instead of a silent read of garbage. That is the real rule under
    // test: an adapter may not call a slot it does not need.
    //
    // `post_control` and `host_surface` are the exception, and are stubs rather
    // than nulls: they exist to count calls. 2D must not consume the control bus
    // and must not ask for a host surface (contradiction 24 is unresolved), so
    // the assertion is zero calls, which a null slot could not report.
    let table = ApiTable {
        abi_version: tension_adapter_abi_version(),
        user: std::ptr::null_mut(),
        guest_read: None,
        guest_write: None,
        guest_size: None,
        resolve_callback: None,
        call_callback: None,
        release_callback: None,
        log: Some(quiet_log),
        register_import: Some(record_import),
        register_source: Some(record_source),
        post_event: None,
        class_info: None,
        region_lookup: Some(record_region),
        log_named: None,
        log_structured: None,
        guest_read_checked: None,
        signal_frame: None,
        shader_generate: None,
        compile_graph: None,
        post_control: Some(count_post_control),
        host_surface: Some(count_host_surface),
        host_surface_extension: None,
    };

    assert_eq!(
        unsafe { init(std::ptr::null_mut(), &table) },
        0,
        "init accepts a table of the current ABI version"
    );
    assert!(
        with_recorded(|recorded| recorded.imports.is_empty()),
        "init registers nothing: registration is valid only while link runs"
    );

    // A wrong ABI version is refused rather than tolerated. Both directions
    // matter: an older table would be read past its end, a newer one would be
    // silently missing slots.
    for wrong_version in [1u32, tension_adapter_abi_version() + 1] {
        let wrong = ApiTable { abi_version: wrong_version, ..table };
        assert_eq!(
            unsafe { init(std::ptr::null_mut(), &wrong) },
            -22,
            "init refuses ABI {wrong_version} (-EINVAL)"
        );
    }

    // ── link: the registrations ──────────────────────────────────────────
    assert_eq!(unsafe { link(std::ptr::null_mut(), &table) }, 0, "link succeeds");

    let (imports, sources, regions, post_control_calls, host_surface_calls) =
        with_recorded(|recorded| {
            (
                recorded.imports.clone(),
                recorded.sources.clone(),
                recorded.regions.clone(),
                recorded.post_control_calls,
                recorded.host_surface_calls,
            )
        });

    // Registration order is the adapter's, and it is pinned: verb ids are
    // stable, and a reused id is a silent misroute.
    assert_eq!(imports, expected_registrations(), "ten registrations, in order");

    // The claims the whole test exists for, stated separately so a failure
    // names the rule rather than printing two long vectors.
    assert_eq!(imports.len(), 10, "ten verbs — the header's figure, not the design note's nine");
    for (i, registration) in imports.iter().enumerate() {
        assert_eq!(
            registration.verb_id,
            (i + 1) as u32,
            "`{}` must hold verb_id {}",
            registration.name,
            i + 1
        );
        assert_eq!(registration.ret_type, TENSION_VT_I32, "`{}` returns i32", registration.name);
        assert_eq!(registration.module, "tension::2d");
    }
    let reentrant: Vec<&str> = imports
        .iter()
        .filter(|r| r.flags & TENSION_IMPORT_REENTRANT_READONLY != 0)
        .map(|r| r.name.as_str())
        .collect();
    assert_eq!(
        reentrant,
        vec!["info"],
        "only `info` is REENTRANT_READONLY: `screenshot` waits for the GPU"
    );
    // No deferrable verb, which is why `apply` is NULL above.
    assert!(
        imports.iter().all(|r| r.flags & !TENSION_IMPORT_REENTRANT_READONLY == 0),
        "no registration carries a flag other than REENTRANT_READONLY"
    );

    assert!(
        sources.is_empty(),
        "2D declares no event source — it consumes nothing from the platform"
    );
    assert!(
        regions.is_empty(),
        "2D declares no arena region: sprite state travels through `submit`"
    );
    assert_eq!(post_control_calls, 0, "2D does not consume the control bus");
    assert_eq!(host_surface_calls, 0, "2D ignores the host surface (contradiction 24)");

    // ── shutdown is idempotent ───────────────────────────────────────────
    //
    // Nothing was opened, so this is the "no device" path. It must not fault,
    // and calling it twice is what the host does on a trap-then-teardown.
    assert_eq!(unsafe { shutdown(std::ptr::null_mut()) }, 0, "shutdown with nothing open");
    assert_eq!(unsafe { shutdown(std::ptr::null_mut()) }, 0, "shutdown is idempotent");
}
