//! The OGRE capability's end-to-end smoke test (A3b).
//!
//! Two checks, and they answer different questions:
//!
//! 1. `test_ogre_adapter_loads_and_registers` — the stub adapter loads through
//!    the registry and registers the seven `ogre::*` verbs under the module
//!    name the SDK imports from. No guest, no session: just the ABI surface.
//! 2. `test_ogre_stub_end_to_end` — the AssemblyScript fixture, built by
//!    `tension-framework/tests/run.sh`, runs against this interpreter with the
//!    stub loaded. That is the whole chain: session_open, `queueMeshLoad`, an
//!    epoch whose publish completes the job, a `JOB_DONE` delivery, and a
//!    callback that resolves the job to its resource.
//!
//! The second test needs the fixture compiled, which needs `asc` — a toolchain
//! `cargo test` does not have. When the artifact is missing it says so and
//! returns; `npm test` in `tension-framework` is the gate that builds and runs
//! it, and this test re-runs the same binary when it is there so a regression
//! shows up in both places.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The stub adapter, built by `build.rs` beside the echo adapter.
const OGRE_STUB: &str = env!("TENSION_OGRE_STUB_ADAPTER");

fn framework_build(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-framework")
        .join("build")
        .join(name)
}

#[test]
fn test_ogre_adapter_loads_and_registers() {
    let adapter = adapter_under_test();
    assert_eq!(adapter.name(), "ogre-stub");

    let mut verbs: Vec<(String, String)> = adapter
        .imports()
        .iter()
        .map(|import| (import.module.clone(), import.name.clone()))
        .collect();
    verbs.sort();

    let mut expected: Vec<(String, String)> = [
        "init",
        "shutdown",
        "queue_mesh_load",
        "queue_texture_load",
        "job_state",
        "job_release",
        "last_error",
    ]
    .iter()
    .map(|name| ("ogre".to_string(), name.to_string()))
    .collect();
    expected.sort();
    assert_eq!(verbs, expected, "the ogre namespace's verb set");

    // The regions the adapter asked about at link are what the session must
    // keep in the arena (§7.2): JOB, RESOURCE and STRING among them.
    let regions = adapter.required_regions().to_vec();
    assert!(
        regions.contains(&3) && regions.contains(&4) && regions.contains(&6),
        "the adapter must declare the JOB (3), RESOURCE (4) and STRING (6) regions, got {regions:?}"
    );
}

#[test]
fn test_ogre_stub_end_to_end() {
    let guest = framework_build("guest-ogre.wasm");
    if !guest.exists() {
        eprintln!(
            "ogre_smoke: {} is not built — run `npm test` in tension-framework (it needs asc); \
             skipping the end-to-end leg",
            guest.display()
        );
        return;
    }

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(OGRE_STUB)
        .arg(&guest)
        .output()
        .expect("the interpreter runs");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the fixture failed (exit {:?})\nstdout: {stdout}\nstderr: {stderr}",
        output.status.code()
    );
    assert!(
        stdout.contains("OK"),
        "the fixture must print OK\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert!(
        stderr.contains("ogre-stub: a job completed"),
        "the adapter's publish must have completed the job\nstderr: {stderr}"
    );
}

/// The stub adapter, loaded and linked the way the run loads it.
fn adapter_under_test() -> tension_core_adapter_probe::Loaded {
    tension_core_adapter_probe::load(Path::new(OGRE_STUB))
}

/// The registry lives in the binary's crate, which an integration test cannot
/// reach — so this is a tiny parallel loader: `dlopen`, the entry point, the
/// version check, and the adapter's own `link` through the core API the
/// registry would hand it. It exists to check the *surface*; the behaviour is
/// covered end to end above.
mod tension_core_adapter_probe {
    use std::ffi::{c_char, c_void, CStr};
    use std::path::Path;

    pub struct Loaded {
        pub name: String,
        pub imports: Vec<Import>,
        pub required_regions: Vec<u32>,
    }

    pub struct Import {
        pub module: String,
        pub name: String,
    }

    impl Loaded {
        pub fn name(&self) -> &str {
            &self.name
        }
        pub fn imports(&self) -> &[Import] {
            &self.imports
        }
        pub fn required_regions(&self) -> &[u32] {
            &self.required_regions
        }
    }

    #[repr(C)]
    struct ApiTable {
        abi_version: u32,
        user: *mut c_void,
        guest_read: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32) -> i32>,
        guest_write: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void, u32) -> i32>,
        guest_size: Option<unsafe extern "C" fn(*mut c_void) -> u32>,
        resolve_callback: *mut c_void,
        call_callback: *mut c_void,
        release_callback: *mut c_void,
        log: Option<unsafe extern "C" fn(*mut c_void, i32, *const c_char, u32)>,
        register_import: Option<
            unsafe extern "C" fn(
                *mut c_void,
                *const c_char,
                *const c_char,
                u32,
                *const u32,
                u32,
                *mut c_void,
                *mut c_void,
                u32,
                u32,
            ) -> i32,
        >,
        register_source:
            Option<unsafe extern "C" fn(*mut c_void, *const c_char, u32, *mut u32) -> i32>,
        post_event: *mut c_void,
        class_info: *mut c_void,
        region_lookup:
            Option<unsafe extern "C" fn(*mut c_void, u32, *mut u32, *mut u32) -> i32>,
    }

    #[repr(C)]
    struct Vtable {
        abi_version: u32,
        name: *const c_char,
        flags: u32,
        init: Option<unsafe extern "C" fn(*mut c_void, *const ApiTable) -> i32>,
        link: Option<unsafe extern "C" fn(*mut c_void, *const ApiTable) -> i32>,
        publish: *mut c_void,
        apply: *mut c_void,
        shutdown: *mut c_void,
        destroy: *mut c_void,
    }

    /// What the adapter tells us during `link`. It travels to the callbacks
    /// through the API table's user pointer, so there is no static state to
    /// share — this loader could run twice in one process.
    #[derive(Default)]
    struct Collected {
        imports: Vec<Import>,
        regions: Vec<u32>,
    }

    unsafe extern "C" fn record_import(
        user: *mut c_void,
        module: *const c_char,
        name: *const c_char,
        _ret: u32,
        _params: *const u32,
        _n: u32,
        _func: *mut c_void,
        _ctx: *mut c_void,
        _verb_id: u32,
        _flags: u32,
    ) -> i32 {
        let module = unsafe { CStr::from_ptr(module) }.to_string_lossy().into_owned();
        let name = unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned();
        let collected = unsafe { &mut *(user as *mut Collected) };
        collected.imports.push(Import { module, name });
        0
    }

    unsafe extern "C" fn record_source(
        _user: *mut c_void,
        _name: *const c_char,
        _hint: u32,
        out_id: *mut u32,
    ) -> i32 {
        if !out_id.is_null() {
            unsafe { *out_id = 1 };
        }
        0
    }

    unsafe extern "C" fn record_region(
        user: *mut c_void,
        kind: u32,
        out_offset: *mut u32,
        out_size: *mut u32,
    ) -> i32 {
        let collected = unsafe { &mut *(user as *mut Collected) };
        collected.regions.push(kind);
        if !out_offset.is_null() {
            unsafe { *out_offset = 0x1000 };
        }
        if !out_size.is_null() {
            unsafe { *out_size = 0x1000 };
        }
        0
    }

    unsafe extern "C" fn quiet_log(_user: *mut c_void, _level: i32, _msg: *const c_char, _len: u32) {}

    pub fn load(path: &Path) -> Loaded {
        let library = unsafe { libc::dlopen(c_path(path).as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        assert!(!library.is_null(), "dlopen failed for {}", path.display());
        let symbol = unsafe { libc::dlsym(library, c"tension_adapter_v1".as_ptr()) };
        assert!(!symbol.is_null(), "no entry point in {}", path.display());
        let entry: extern "C" fn() -> *const Vtable = unsafe { std::mem::transmute(symbol) };
        let adapter = entry();
        assert!(!adapter.is_null());

        let mut collected = Collected::default();
        let api = ApiTable {
            abi_version: unsafe { (*adapter).abi_version },
            user: &mut collected as *mut Collected as *mut c_void,
            guest_read: None,
            guest_write: None,
            guest_size: None,
            resolve_callback: std::ptr::null_mut(),
            call_callback: std::ptr::null_mut(),
            release_callback: std::ptr::null_mut(),
            log: Some(quiet_log),
            register_import: Some(record_import),
            register_source: Some(record_source),
            post_event: std::ptr::null_mut(),
            class_info: std::ptr::null_mut(),
            region_lookup: Some(record_region),
        };

        assert_eq!(api.abi_version, 1, "the stub is built against ABI 1");
        unsafe {
            if let Some(init) = (*adapter).init {
                assert_eq!(init(std::ptr::null_mut(), &api), 0, "init");
            }
            let link = (*adapter).link.expect("the stub links");
            assert_eq!(link(std::ptr::null_mut(), &api), 0, "link");
        }
        let name = unsafe { CStr::from_ptr((*adapter).name) }
            .to_string_lossy()
            .into_owned();
        Loaded {
            name,
            imports: collected.imports,
            required_regions: collected.regions,
        }
    }

    fn c_path(path: &Path) -> std::ffi::CString {
        std::ffi::CString::new(path.to_str().expect("utf-8 path")).expect("no interior nul")
    }
}
