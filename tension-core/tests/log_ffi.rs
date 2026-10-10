//! The logging C ABI, end to end.
//!
//! `tests/support/log_harness.c` is compiled by `build.rs` and linked into this
//! test binary. It calls the two symbols the host exports — `tension_log` and
//! `tension_log_structured` — the way a native consumer that links
//! libtension_core would. That this test binary links at all is half the proof:
//! the symbols are real and resolvable from C. The assertions are the other
//! half: the records reached the host's configured sink, through the host's
//! layout.
//!
//! The logger is configured **once per test binary** (the global is a
//! `OnceLock`), into a temp file at `trace`, so every level passes and the
//! lines can be read back. The assertions match a line's *suffix* — the prefix
//! is a timestamp that differs per line — and use `ends_with` per line, so the
//! three tests may run in any order against the same file.

use std::ffi::{c_char, CString};
use std::path::PathBuf;
use std::sync::OnceLock;

use tension_core::logging::{Config, Level};

extern "C" {
    /// Emits one record per level plus a structured one. From `log_harness.c`.
    fn log_harness_emit() -> i32;
    /// Emits with null pointers and an out-of-range level. From `log_harness.c`.
    fn log_harness_emit_null() -> i32;
}

/// Install the logger once, into a temp file, at `trace`, and return its path.
fn log_file() -> &'static PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("tension-log-ffi-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut config = Config::default();
        config.set_file(path.clone());
        config.set_level_spec("trace").expect("`trace` parses");
        tension_core::logging::init(config).expect("the logger installs");
        path
    })
}

fn read_log() -> String {
    std::fs::read_to_string(log_file()).expect("the log file is readable")
}

/// Whether any line ends with `suffix`. The timestamp varies per line, so the
/// stable part of a line is everything after it.
fn has_line(contents: &str, suffix: &str) -> bool {
    contents.lines().any(|line| line.ends_with(suffix))
}

#[test]
fn the_c_harness_emits_through_the_host_logger() {
    let _ = log_file();
    assert_eq!(unsafe { log_harness_emit() }, 0);

    let contents = read_log();
    // The level tag is padded to five columns; the logger name and message
    // follow the host's text layout. The default filter is `info`, but this
    // run is configured at `trace`, so the DEBUG line is here too.
    assert!(has_line(&contents, "INFO  harness: hello from C"), "{contents}");
    assert!(has_line(&contents, "DEBUG harness: a debug line"), "{contents}");
    assert!(has_line(&contents, "ERROR harness: an error"), "{contents}");
    // A structured-only record puts its payload in the message slot.
    assert!(
        has_line(&contents, "WARN  harness: {\"payload\":true}"),
        "{contents}"
    );
}

#[test]
fn the_c_abi_survives_null_pointers() {
    let _ = log_file();
    // Null name, null payload, and a level code outside the enum: the guard
    // means these return rather than trap, and the null name falls back to
    // `core`.
    assert_eq!(unsafe { log_harness_emit_null() }, 0);
    let contents = read_log();
    assert!(has_line(&contents, "INFO  core: "), "{contents}");
}

#[test]
fn the_free_symbol_is_callable_from_rust_too() {
    // This test also pins the symbols into the link: a Rust call site is what
    // guarantees the object defining `tension_log` is pulled into the binary,
    // so the C object's reference to it always resolves.
    let _ = log_file();
    let name = CString::new("rustcaller").expect("no interior nul");
    let message = b"from rust";
    unsafe {
        tension_core::logging::ffi::tension_log(
            Level::Info as i32,
            name.as_ptr(),
            message.as_ptr() as *const c_char,
            message.len(),
        );
    }
    assert!(
        has_line(&read_log(), "INFO  rustcaller: from rust"),
        "the Rust caller's line should be in the log"
    );
}
