//! C3: the adapter teardown path, from the host's own run.
//!
//! The vtable has `shutdown` and `destroy` slots (`tension_adapter.h`), but
//! before C3 the host called neither: a `LoadedAdapter` was dropped, which
//! closed the DSO and left the render thread to the DSO's own static
//! destructor. This proves the host now calls `shutdown` then `destroy`, once
//! each, on the path that had no teardown at all — a guest that **traps**.
//!
//! The machinery is a probe adapter (`tests/support/teardown_probe_adapter.c`)
//! whose two teardown slots append one line each to the file named by
//! `$TENSION_TEARDOWN_LOG`, and a guest whose `_start_game` is a bare
//! `unreachable`. The test runs the real interpreter and reads the file back.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// The probe adapter, compiled by `build.rs`.
const PROBE: &str = env!("TENSION_TEARDOWN_PROBE_ADAPTER");

/// A guest that traps the moment it runs. It imports `session::memory`, which
/// makes it a *session* guest — the host defines the arena under that name only
/// for a guest that imports from `session` (`main.rs`), and it is the guest
/// shape a capability-using game has. It re-exports the memory as `memory`
/// (`check_guest_module`), and `_start_game` is a single `unreachable`, so the
/// host's call to it fails — the fault this test injects.
const TRAP_GUEST: &str = r#"
(module
  (import "session" "memory" (memory 132 4096))
  (export "memory" (memory 0))
  (func (export "_start_game")
    unreachable
  )
)
"#;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tension-teardown-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("the scratch directory is creatable");
    dir.join(name)
}

#[test]
fn a_trapping_guest_still_shuts_the_adapter_down_once() {
    let guest = scratch("trap.wat");
    fs::write(&guest, TRAP_GUEST).expect("the trap guest is written");
    let log = scratch("teardown.log");
    let _ = fs::remove_file(&log);

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--capability")
        .arg(PROBE)
        .arg(&guest)
        .env("TENSION_TEARDOWN_LOG", &log)
        .output()
        .expect("the interpreter runs");

    // The guest traps, so the run itself is a failure ...
    assert!(
        !output.status.success(),
        "the trapping guest should not exit 0\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );

    // ... but the adapter was still torn down: `shutdown` then `destroy`, and
    // exactly once apiece. Before C3 this file did not exist at all.
    let recorded = fs::read_to_string(&log).unwrap_or_default();
    let lines: Vec<&str> = recorded.lines().collect();
    assert_eq!(
        lines,
        vec!["shutdown", "destroy"],
        "the adapter's teardown must run exactly once, shutdown then destroy; got {lines:?}"
    );
}
