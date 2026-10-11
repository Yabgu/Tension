//! The manifest cross-check (`tension-ogre/DESIGN.md` §10, A3a.9).
//!
//! Three places hold the arena's shape hash: the generated constants the AS
//! runtime compiles against (`tension-framework/assembly/runtime/layout.ts`),
//! the source of truth the generator derives them from
//! (`tension-framework/session.json`), and this build's own
//! `arena::layout_hash()`, which `tension-core layout-hash` prints — the same
//! command the AS build consumes.
//!
//! They must agree. When they do not, a guest compiled against one shape would
//! be refused by a host of another at `session_open`, with a diagnostic that
//! names two numbers and no file; this test names the file, and it runs in
//! `cargo test` rather than in a build script, so it fails in review rather than
//! in someone's first run.
//!
//! The hash is read out of `layout.ts` rather than out of a separate stamp file
//! on purpose: that is the *source the AS build compiles*, so the check cannot
//! pass while the guest is built against something else.

use std::path::{Path, PathBuf};
use std::process::Command;

fn framework_file(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-framework")
        .join(name)
}

/// The value of `export const <name>: u32 = <n>;` in a generated file.
fn generated_u32(path: &Path, name: &str) -> u32 {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{} is not readable: {e}", path.display()));
    let prefix = format!("export const {name}: u32 = ");
    let line = text
        .lines()
        .find(|line| line.starts_with(&prefix))
        .unwrap_or_else(|| panic!("{} has no `{name}`", path.display()));
    line[prefix.len()..]
        .trim_end_matches(';')
        .trim()
        .parse()
        .unwrap_or_else(|e| panic!("{}'s {name} is not a number: {e}", path.display()))
}

/// This build's hash, from the binary the AS pipeline calls.
fn host_layout_hash() -> u32 {
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("layout-hash")
        .output()
        .expect("the interpreter runs");
    assert!(output.status.success(), "`tension-core layout-hash` failed");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .expect("`layout-hash` prints a decimal u32")
}

#[test]
fn the_as_runtime_agrees_with_this_builds_layout_hash() {
    let layout_ts = framework_file("assembly/runtime/layout.ts");
    let session_json = framework_file("session.json");

    let as_hash = generated_u32(&layout_ts, "LAYOUT_HASH");
    let host_hash = host_layout_hash();

    let manifest = std::fs::read_to_string(&session_json)
        .unwrap_or_else(|e| panic!("{} is not readable: {e}", session_json.display()));
    let manifest_hash: u32 = manifest
        .lines()
        .find_map(|line| line.trim().strip_prefix("\"layout_hash\":"))
        .map(|rest| rest.trim().trim_end_matches(','))
        .and_then(|number| number.parse().ok())
        .expect("session.json states layout_hash");

    assert_eq!(
        host_hash, manifest_hash,
        "the arena's shape and session.json disagree: re-run \
         `tension-framework/build.sh` and update session.json deliberately"
    );
    assert_eq!(
        as_hash, host_hash,
        "the AS runtime and the host disagree about the arena's shape: \
         re-run `tension-framework/build.sh --hash {host_hash}` so the guest is \
         compiled against the shape the host has"
    );
}

/// The adapter header's `TENSION_ADAPTER_LAYOUT_HASH`, parsed from the macro the
/// C side compiles against.
fn adapter_header_layout_hash() -> u32 {
    let header = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("include")
        .join("tension_adapter.h");
    let text = std::fs::read_to_string(&header)
        .unwrap_or_else(|e| panic!("{} is not readable: {e}", header.display()));
    text.lines()
        .find_map(|line| line.trim().strip_prefix("#define TENSION_ADAPTER_LAYOUT_HASH "))
        .map(|rest| rest.trim().trim_end_matches('u'))
        .and_then(|number| number.parse().ok())
        .unwrap_or_else(|| panic!("{} has no TENSION_ADAPTER_LAYOUT_HASH", header.display()))
}

#[test]
fn the_adapter_header_agrees_with_this_builds_layout_hash() {
    // C4.1c: an adapter bakes this macro into its vtable, and the host refuses
    // the adapter at load when the two disagree. If the macro drifts from the
    // host's own `arena::layout_hash()`, *every* adapter in this tree would be
    // refused at the first `--capability`, so the drift is caught here instead.
    assert_eq!(
        adapter_header_layout_hash(),
        host_layout_hash(),
        "tension_adapter.h's TENSION_ADAPTER_LAYOUT_HASH disagrees with \
         `tension-core layout-hash`: update the macro when the arena layout moves"
    );
}

#[test]
fn the_runtime_states_the_arena_constants_the_manifest_does() {
    // The relation, not just the hash: a guest whose arena_size exceeded its
    // ceiling would be refused by `session_open` (C1) with a number, and the
    // generated file is where those two numbers come from.
    let layout_ts = framework_file("assembly/runtime/layout.ts");
    let arena = generated_u32(&layout_ts, "ARENA_SIZE");
    let ceiling = generated_u32(&layout_ts, "MAX_ARENA_SIZE");
    let memory_base = generated_u32(&layout_ts, "MEMORY_BASE");
    assert!(arena <= ceiling, "arena_size {arena} exceeds the ceiling {ceiling} (C1)");
    assert_eq!(memory_base, ceiling, "memoryBase is the ceiling (§4.1)");
    assert_eq!(arena % 16, 0, "arena_size is 16-byte aligned");
}
