//! The OGRE adapter's structural test (chunk 2, round 2a).
//!
//! Everything here is about the *surface*: that the shared object loads, that
//! `tension_adapter_v1` returns a well-formed vtable, and that `init` + `link`
//! register exactly what the guest SDK expects — three imports under `ogre`,
//! one event source, one region declaration. No renderer runs and no guest
//! exists: the render thread starts only when a *guest* calls `ogre::init`, so
//! this test is display-free and OGRE-free, which is what lets it live in
//! `cargo test` (DESIGN.md §14, the structural layer).
//!
//! The DSO is found at `TENSION_OGRE_DSO_PATH` when that is set, otherwise at
//! `tension-ogre/build/libtension_ogre.so` beside this crate. Absent, the test
//! says so and returns — `cargo test` must not require a C++ toolchain.

use std::ffi::{c_char, c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ── the ABI, mirrored from tension-core/include/tension_adapter.h ────────
//
// Only the fields this test drives are exercised; the rest exist so the struct
// has the session's exact size and field order.

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
}

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
}

const TENSION_ADAPTER_ABI_VERSION: u32 = 1;
const TENSION_VT_I32: u32 = 1;
const TENSION_IMPORT_REENTRANT_READONLY: u32 = 1 << 1;
const TENSION_REGION_RESOURCE: u32 = 4;
const TENSION_REGION_JOB: u32 = 3;
const TENSION_REGION_SCENE: u32 = 8;
const TENSION_REGION_MATERIAL: u32 = 9;
const TENSION_REGION_RENDERABLE: u32 = 10;
const TENSION_REGION_BUFFER_POOL: u32 = 11;

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
    out_offset: *mut u32,
    out_size: *mut u32,
) -> i32 {
    with_recorded(|recorded| recorded.regions.push(kind));
    // Plausible answers, from the frozen layout: the RESOURCE region.
    if !out_offset.is_null() {
        unsafe { *out_offset = 0x3000 };
    }
    if !out_size.is_null() {
        unsafe { *out_size = 48 * 1024 };
    }
    0
}

unsafe extern "C" fn quiet_log(_user: *mut c_void, _level: i32, _msg: *const c_char, _len: u32) {}

// ── finding the DSO ─────────────────────────────────────────────────────

fn dso_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("TENSION_OGRE_DSO_PATH") {
        return PathBuf::from(explicit);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-ogre")
        .join("build")
        .join("libtension_ogre.so")
}

fn load(path: &Path) -> Option<*const Vtable> {
    if !path.exists() {
        eprintln!(
            "ogre_surface: {} is not built — run `tension-ogre/build.sh` (it needs no OGRE-Next); \
             skipping the surface test",
            path.display()
        );
        return None;
    }
    let c_path = std::ffi::CString::new(path.to_str().expect("utf-8 path")).expect("no interior nul");
    let library = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    assert!(!library.is_null(), "dlopen failed for {}", path.display());
    let symbol = unsafe { libc::dlsym(library, c"tension_adapter_v1".as_ptr()) };
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

#[test]
fn test_ogre_adapter_surface() {
    let path = dso_path();
    let Some(vtable) = load(&path) else { return };
    *RECORDED.lock().expect("the recording mutex") = Some(Recorded::default());

    // ── the vtable itself ────────────────────────────────────────────────
    assert_eq!(unsafe { (*vtable).abi_version }, TENSION_ADAPTER_ABI_VERSION);
    let name = unsafe { CStr::from_ptr((*vtable).name) }.to_string_lossy().into_owned();
    assert_eq!(name, "ogre", "the vtable names the wasm module it implements");
    assert_eq!(unsafe { (*vtable).flags }, 0, "flags are reserved");
    let init = unsafe { (*vtable).init }.expect("init is present");
    let link = unsafe { (*vtable).link }.expect("link is present");
    let shutdown = unsafe { (*vtable).shutdown }.expect("shutdown must be present");
    let publish = unsafe { (*vtable).publish }.expect("publish writes the renderer's record");
    let _destroy = unsafe { (*vtable).destroy }.expect("destroy must be present");
    assert!(
        unsafe { (*vtable).apply }.is_none(),
        "no deferrable verb exists yet, so apply is NULL (tension_adapter.h)"
    );

    // ── init: ABI check and nothing else ─────────────────────────────────
    let table = ApiTable {
        abi_version: TENSION_ADAPTER_ABI_VERSION,
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
    };

    let refused = unsafe { init(std::ptr::null_mut(), &table) };
    assert_eq!(refused, 0, "init accepts an ABI-1 table");
    assert!(
        with_recorded(|recorded| recorded.imports.is_empty()),
        "init registers nothing: registration is valid only while link runs"
    );

    // A wrong ABI version is refused rather than tolerated.
    let wrong = ApiTable { abi_version: 2, ..table };
    assert_eq!(
        unsafe { init(std::ptr::null_mut(), &wrong) },
        -22,
        "init refuses an ABI it does not speak (-EINVAL)"
    );

    // ── link: the registrations ──────────────────────────────────────────
    assert_eq!(unsafe { link(std::ptr::null_mut(), &table) }, 0, "link succeeds");

    let (imports, sources, regions) = with_recorded(|recorded| {
        (recorded.imports.clone(), recorded.sources.clone(), recorded.regions.clone())
    });

    let expected = vec![
        Registered {
            module: "ogre".into(),
            name: "init".into(),
            ret_type: TENSION_VT_I32,
            nparams: 2,
            verb_id: 1,
            flags: 0,
        },
        Registered {
            module: "ogre".into(),
            name: "shutdown".into(),
            ret_type: TENSION_VT_I32,
            nparams: 0,
            verb_id: 2,
            flags: 0,
        },
        Registered {
            module: "ogre".into(),
            name: "last_error".into(),
            ret_type: TENSION_VT_I32,
            nparams: 2,
            verb_id: 3,
            flags: TENSION_IMPORT_REENTRANT_READONLY,
        },
        Registered {
            module: "ogre".into(),
            name: "queue_mesh_load".into(),
            ret_type: TENSION_VT_I32,
            nparams: 3,
            verb_id: 4,
            flags: 0,
        },
        Registered {
            module: "ogre".into(),
            name: "queue_texture_load".into(),
            ret_type: TENSION_VT_I32,
            nparams: 3,
            verb_id: 5,
            flags: 0,
        },
        Registered {
            module: "ogre".into(),
            name: "job_state".into(),
            ret_type: TENSION_VT_I32,
            nparams: 2,
            verb_id: 6,
            flags: TENSION_IMPORT_REENTRANT_READONLY,
        },
        Registered {
            module: "ogre".into(),
            name: "job_release".into(),
            ret_type: TENSION_VT_I32,
            nparams: 1,
            verb_id: 7,
            flags: 0,
        },
        Registered {
            module: "ogre".into(),
            name: "submit".into(),
            ret_type: TENSION_VT_I32,
            nparams: 3,
            verb_id: 8,
            flags: 0,
        },
        Registered {
            module: "ogre".into(),
            name: "screenshot".into(),
            ret_type: TENSION_VT_I32,
            nparams: 2,
            verb_id: 9,
            flags: TENSION_IMPORT_REENTRANT_READONLY,
        },
        Registered {
            module: "ogre".into(),
            name: "submit_motion".into(),
            ret_type: TENSION_VT_I32,
            nparams: 1,
            verb_id: 10,
            flags: 0,
        },
    ];
    assert_eq!(imports, expected, "the ten imports of the SDK, and their flags");

    assert_eq!(sources, vec!["ogre".to_string()], "one event source, named for the module");
    assert_eq!(
        regions,
        vec![
            TENSION_REGION_RESOURCE,
            TENSION_REGION_JOB,
            TENSION_REGION_SCENE,
            TENSION_REGION_MATERIAL,
            TENSION_REGION_RENDERABLE,
            TENSION_REGION_BUFFER_POOL,
        ],
        "the regions this adapter declares: the two it writes, then the four it reads"
    );

    // ── publish with nothing to say ──────────────────────────────────────
    // The status mirror is clean (no thread ever ran), so publish must not
    // touch guest memory — which is why a null guest_write is safe here.
    assert_eq!(
        unsafe { publish(std::ptr::null_mut(), &table) },
        0,
        "publish is a no-op while the mirror is clean"
    );

    // ── shutdown is idempotent and safe before any init ──────────────────
    assert_eq!(unsafe { shutdown(std::ptr::null_mut()) }, 0, "nothing running: 0");
    assert_eq!(unsafe { shutdown(std::ptr::null_mut()) }, 0, "and again");
}
