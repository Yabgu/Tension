//! End-to-end coverage for what `--debug` does to a guest now that the host
//! does not build DWARF: it reports whether the compiler already embedded any,
//! says what to do when it did not, and points lldb at the sources.
//!
//! These drive the **binary**, like `session_smoke.rs`: `cargo` builds
//! `tension-core` and hands its path over in `CARGO_BIN_EXE_tension-core`, so
//! what is exercised is the real run path in `main` — argument parsing, the
//! report, and the load.
//!
//! Inputs are committed bytes under `tests/fixtures/` (see the READMEs there):
//! `dwarf-guest` was built by TensionScript 0.14.0, which embeds DWARF;
//! `legacy-guest` by 0.13.2, which does not. Nothing here compiles a guest,
//! calls npm, or needs a network.
//!
//! What is asserted is behaviour, not bytes (rule 4): the report strings a user
//! sees. Two of those assertions are negative on purpose — no report may claim
//! to synthesise, and none may call an older guest's build "deprecated" — so
//! re-introducing a host-side fallback fails here rather than passing quietly.
//!
//! # CI toolchain requirement (measured, and not what it looks like)
//!
//! `--no-default-features` does **not** make this suite runnable without Zig and
//! gfortran. The features gate `cpal` and `llama-cpp-2` only; `build.rs` calls
//! `zig build` (for `tension-res`) and `tension-solver/build.sh` (gfortran)
//! unconditionally, with no `#[cfg(feature = ...)]` on either path. Verified by
//! putting a failing `zig` stub first on `PATH`: `--no-default-features` still
//! reaches `build.rs:65`'s panic. Same for a `gfortran` stub (`build.rs:165`).
//!
//! A clean `--no-default-features --release` build on a machine that *has* both
//! took 1 m 42 s and peaked at ~1051 MB RSS. So the recipe is:
//!
//! ```sh
//! cargo test --manifest-path tension-core/Cargo.toml --test e2e_debug
//! ```
//!
//! on a runner that installs Zig (>= 0.16), gfortran (>= 14) and, for the
//! default features, `libasound2-dev`. Dropping features buys compile time for
//! `cpal`/llama.cpp, not toolchain freedom.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The interpreter under test.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");

/// The report line a guest that already carries DWARF must produce.
const PASSTHROUGH: &str = "DWARF: present (compiler-emitted) — passed through as-is";
/// The report line a guest with no `.debug_*` sections must produce.
const ABSENT: &str = "DWARF: absent — no .debug_* sections in the module";
/// What the user is told to do about it.
const REBUILD_HINT: &str =
    "rebuild with TensionScript 0.14.0 or later to embed DWARF at compile time";

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn fixture_wasm(name: &str) -> PathBuf {
    fixture_dir(name).join("game.wasm")
}

/// Run the binary with `args` and the guest, returning the whole output.
fn run(guest: &Path, args: &[&str]) -> Output {
    let mut command = Command::new(BINARY);
    command.args(args);
    if let Some(dir) = guest.parent() {
        // An absolute guest path keeps the report's paths independent of the
        // test's working directory.
        command.arg(dir.join(guest.file_name().expect("fixture has a file name")));
    }
    command.output().expect("spawn tension-core")
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

// ------------------------------------------------------------------- A1 ---

/// A guest that carries `.debug_info` + `.debug_line` is reported as
/// compiler-emitted and passed through: nothing in the report may claim to
/// have built DWARF for it.
#[test]
fn test_dwarf_guest_carries_dwarf_passthrough() {
    let output = run(&fixture_wasm("dwarf-guest"), &["--debug"]);
    let stderr = stderr_of(&output);

    assert!(
        stderr.contains(PASSTHROUGH),
        "expected the pass-through report line.\nstderr:\n{stderr}"
    );
    // "synthesi" rather than "synthesiz": it also catches "synthesise" and
    // "synthesised", which is what a reintroduced fallback would print.
    assert!(
        !stderr.contains("synthesi"),
        "a guest that carries DWARF must not be synthesised for.\nstderr:\n{stderr}"
    );
    // The load carries the reason through the log, not just the report.
    assert!(
        stderr.contains("guest already carries DWARF; leaving it alone"),
        "expected the unchanged-load reason.\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains(ABSENT),
        "a DWARF guest must not be reported as absent.\nstderr:\n{stderr}"
    );
}

// ------------------------------------------------------------------- A2 ---

/// A guest with no `.debug_*` sections is reported as absent, with the fix
/// named. The host does not offer to build DWARF for it, and does not call the
/// user's build deprecated.
#[test]
fn test_legacy_guest_reports_no_dwarf() {
    let output = run(&fixture_wasm("legacy-guest"), &["--debug"]);
    let stderr = stderr_of(&output);

    assert!(
        stderr.contains(ABSENT),
        "expected the no-DWARF report line.\nstderr:\n{stderr}"
    );
    assert!(
        stderr.contains(REBUILD_HINT),
        "expected the rebuild hint.\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains("synthesi"),
        "the host must not offer to synthesise DWARF.\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains("Deprecated") && !stderr.contains("deprecated"),
        "the report must not call the user's build deprecated.\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains(PASSTHROUGH),
        "the legacy guest must not be reported as compiler-emitted.\nstderr:\n{stderr}"
    );
}

// ------------------------------------------------------------------- A3 ---

/// `--symbol-path` is what tells lldb where the sources are, and it still
/// reaches the hint printed at startup.
///
/// The flag refuses a path that does not exist (`main` exits 2), so the test
/// supplies a real directory rather than the harmless-but-rejected
/// `/tmp/does-not-matter`: the assertion is about the hint text, and it is
/// worth reaching the report to check it.
#[test]
fn test_symbol_path_prints_lldb_hint() {
    let elsewhere = std::env::temp_dir().join(format!("tension-e2e-symbols-{}", std::process::id()));
    std::fs::create_dir_all(&elsewhere).expect("create symbol path");
    let elsewhere_str = elsewhere.to_str().expect("utf-8 temp path");

    let output = run(
        &fixture_wasm("legacy-guest"),
        &["--debug", "--symbol-path", elsewhere_str],
    );
    let stderr = stderr_of(&output);

    assert!(
        stderr.contains(&format!("target.debug-file-search-paths {elsewhere_str}")),
        "--symbol-path must be offered to lldb as a search path.\nstderr:\n{stderr}"
    );
    // The hint is an lldb command, so it must carry the flag's value verbatim.
    assert!(
        stderr.contains(&format!("symbol path: {elsewhere_str}")),
        "the report must echo the symbol path it was given.\nstderr:\n{stderr}"
    );

    let _ = std::fs::remove_dir_all(&elsewhere);
}

// The lldb breakpoint test that used to live here spawned standalone wasmtime
// under lldb against the dwarf-guest fixture. That tests compiler-emitted DWARF
// under a debugger — a TensionScript-side claim, covered by TensionScript's
// tests/debug/ and by this repo's Node E2E debug mode (which runs 10 live
// examples under lldb through tension-core). It was removed because it measured
// neither the host's pass-through nor any tension-core behaviour, and because it
// required a sibling ~/work/TensionScript checkout for its wasmtime lookup.
