//! End-to-end coverage for the three `--debug` behaviours the host's DWARF work
//! established: pass-through, the legacy fallback (and its deprecation), and
//! `--symbol-path` not moving the compile directory.
//!
//! These drive the **binary**, like `session_smoke.rs`: `cargo` builds
//! `tension-core` and hands its path over in `CARGO_BIN_EXE_tension-core`, so
//! what is exercised is the real run path in `main` — argument parsing, the
//! report, the synthesiser, and the load.
//!
//! Inputs are committed bytes under `tests/fixtures/` (see the READMEs there):
//! `dwarf-guest` was built by a compiler that embeds DWARF, `legacy-guest` by a
//! release that does not. Nothing here compiles a guest, calls npm, or needs a
//! network.
//!
//! What is asserted is behaviour, not bytes (rule 4): the report strings a user
//! sees, how many times the deprecation appears, and one field
//! (`DW_AT_comp_dir`) read out of the synthesised module. The synth dump the
//! third test needs is a test-only flag — see the `test-dump` feature comment in
//! `Cargo.toml`; in a release build without that feature the flag does not
//! exist, and the test says so and skips rather than pretending to pass.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The interpreter under test.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");

/// The report line a guest that already carries DWARF must produce.
const PASSTHROUGH: &str = "DWARF: present (compiler-emitted) — passed through as-is";
/// The deprecation sentence, exactly as printed at the synthesis site.
const DEPRECATION: &str =
    "Deprecated; rebuild with TensionScript 0.14.0 or later to embed DWARF at compile time.";

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
        // An absolute guest path keeps DW_AT_comp_dir deterministic: the
        // synthesiser uses the guest's own directory, and a relative path would
        // record a relative directory that depends on the test's cwd.
        command.arg(dir.join(guest.file_name().expect("fixture has a file name")));
    }
    command.output().expect("spawn tension-core")
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

// ------------------------------------------------------------------- A1 ---

/// A guest that carries `.debug_info` + `.debug_line` is passed through: the
/// host reports it as compiler-emitted and does not synthesise anything.
#[test]
fn test_pass_through_legacy_vs_dwarf() {
    let output = run(&fixture_wasm("dwarf-guest"), &["--debug"]);
    let stderr = stderr_of(&output);

    assert!(
        stderr.contains(PASSTHROUGH),
        "expected the pass-through report line.\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains("synthesi"),
        "a guest that carries DWARF must not be synthesised for.\nstderr:\n{stderr}"
    );
    // The load carries the reason through the log, not just the report.
    assert!(
        stderr.contains("guest already carries DWARF; leaving it alone"),
        "expected the unchanged-load reason.\nstderr:\n{stderr}"
    );
}

// ------------------------------------------------------------------- A2 ---

/// A guest with no `.debug_*` sections still gets DWARF synthesised, and the
/// deprecation is printed exactly once — next to the synthesis summary, where
/// the claim is true.
#[test]
fn test_deprecation_warning_once() {
    let output = run(&fixture_wasm("legacy-guest"), &["--debug"]);
    let stderr = stderr_of(&output);

    assert!(
        stderr.contains("synthesiz"),
        "the legacy guest must be synthesised for.\nstderr:\n{stderr}"
    );
    assert!(
        stderr.contains("synthesized DWARF -"),
        "expected the synthesis summary.\nstderr:\n{stderr}"
    );
    let count = stderr.matches(DEPRECATION).count();
    assert_eq!(
        count, 1,
        "the deprecation must appear exactly once, saw {count}.\nstderr:\n{stderr}"
    );
    assert!(
        !stderr.contains(PASSTHROUGH),
        "the legacy guest must not be reported as compiler-emitted.\nstderr:\n{stderr}"
    );
}

// ------------------------------------------------------------------- A3 ---

/// `--symbol-path` names where the debugger looks for sources. It must not move
/// the compile directory the synthesiser records — that is the guest's own
/// directory — while still being offered to lldb.
#[test]
fn test_symbol_path_does_not_move_comp_dir() {
    // The flag's parsing requires an existing path (main.rs rejects a
    // `--symbol-path` that does not exist), so give it a real directory that is
    // deliberately not the guest's.
    let elsewhere = std::env::temp_dir().join(format!("tension-e2e-symbols-{}", std::process::id()));
    std::fs::create_dir_all(&elsewhere).expect("create symbol path");
    let elsewhere_str = elsewhere.to_str().expect("utf-8 temp path");
    let guest = fixture_wasm("legacy-guest");

    let output = run(&guest, &["--debug", "--symbol-path", elsewhere_str]);
    let stderr = stderr_of(&output);

    // A4: the flag still reaches lldb's search paths.
    assert!(
        stderr.contains("target.debug-file-search-paths") && stderr.contains(elsewhere_str),
        "--symbol-path must still be offered to lldb.\nstderr:\n{stderr}"
    );

    // A3: compare the recorded compile directory, which needs the synthesised
    // bytes. They exist only in memory unless a test build was asked to dump
    // them, so this half is gated on the flag being compiled in.
    #[cfg(any(feature = "test-dump", debug_assertions))]
    {
        let dump = std::env::temp_dir().join(format!("tension-e2e-dump-{}.wasm", std::process::id()));
        let _ = std::fs::remove_file(&dump);
        let dump_str = dump.to_str().expect("utf-8 temp path");

        let output = run(
            &guest,
            &["--debug", "--symbol-path", elsewhere_str, "--debug-dump-synth", dump_str],
        );
        assert!(
            output.status.success(),
            "spawning with the dump flag failed.\nstderr:\n{}",
            stderr_of(&output)
        );

        let bytes = std::fs::read(&dump).expect("the host wrote no synth dump");
        let comp_dir = debug_info_comp_dir(&bytes).expect("no DW_AT_comp_dir in the dump");

        let expected = fixture_dir("legacy-guest");
        assert_eq!(
            Path::new(&comp_dir),
            expected,
            "DW_AT_comp_dir must be the guest's directory, not --symbol-path ({elsewhere_str})"
        );
        assert!(
            !comp_dir.contains(elsewhere_str),
            "--symbol-path leaked into DW_AT_comp_dir: {comp_dir}"
        );

        let _ = std::fs::remove_file(&dump);
    }

    #[cfg(not(any(feature = "test-dump", debug_assertions)))]
    eprintln!(
        "skipped: comp_dir assertion needs the `test-dump` feature \
         (or a debug build); the lldb-search-path half still ran"
    );

    let _ = std::fs::remove_dir_all(&elsewhere);
}

/// Read `DW_AT_comp_dir` out of a module's `.debug_info`.
///
/// The compile unit is this encoder's abbrev 1, and its attributes are
/// `DW_AT_name` then `DW_AT_comp_dir`, both `DW_FORM_string`. So: find the
/// `.debug_info` custom section, skip the unit header, read the abbrev code,
/// then the first two NUL-terminated strings. That is a field-level read, not a
/// general DWARF parser — it exists to answer "which directory was recorded".
fn debug_info_comp_dir(wasm: &[u8]) -> Option<String> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        return None;
    }
    let mut i = 8usize;
    while i < wasm.len() {
        let id = wasm[i];
        i += 1;
        let size = read_uleb(wasm, &mut i)? as usize;
        let end = i.checked_add(size)?;
        if end > wasm.len() {
            return None;
        }
        if id == 0 {
            let mut name_read = i;
            let name_len = read_uleb(wasm, &mut name_read)? as usize;
            let name_end = name_read.checked_add(name_len)?;
            if name_end <= end && &wasm[name_read..name_end] == b".debug_info" {
                return cu_comp_dir(&wasm[name_end..end]);
            }
        }
        i = end;
    }
    None
}

/// Skip the unit header, the abbrev code, `DW_AT_name`, then take comp_dir.
fn cu_comp_dir(unit: &[u8]) -> Option<String> {
    if unit.len() < 11 {
        return None;
    }
    // unit_length(4) version(2) abbrev_offset(4) addr_size(1)
    let mut i = 11usize;
    let _abbrev = read_uleb(unit, &mut i)?; // 1 = compile unit
    let _name = read_cstr(unit, &mut i)?;
    read_cstr(unit, &mut i)
}

fn read_uleb(bytes: &[u8], i: &mut usize) -> Option<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *bytes.get(*i)?;
        *i += 1;
        if shift >= 64 {
            return None;
        }
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
}

fn read_cstr(bytes: &[u8], i: &mut usize) -> Option<String> {
    let start = *i;
    while *i < bytes.len() && bytes[*i] != 0 {
        *i += 1;
    }
    if *i >= bytes.len() {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes[start..*i]).into_owned();
    *i += 1;
    Some(text)
}

// ------------------------------------------------------- optional smoke ---

/// A source-line breakpoint against `dwarf-guest`, if this machine can do it.
///
/// Skipped — not failed — when lldb or the pinned Wasmtime is absent: the three
/// assertions above are the regression gate, and requiring a debugger on every
/// machine would make the suite unusable in CI. Wasmtime is looked for on
/// `PATH` and in the TensionScript harness cache, because that is where this
/// project's tooling already puts it.
#[test]
fn test_lldb_breakpoint_if_available() {
    let Some(lldb) = tool("lldb").or_else(|| tool("lldb-22")) else {
        eprintln!("lldb not on PATH — behavioural breakpoint smoke skipped");
        return;
    };
    let Some(wasmtime) = tool("wasmtime").or_else(harness_wasmtime) else {
        eprintln!("wasmtime not available — behavioural breakpoint smoke skipped");
        return;
    };

    let guest = fixture_wasm("dwarf-guest");
    let dir = std::env::temp_dir().join(format!("tension-e2e-lldb-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create lldb scratch dir");
    let commands = dir.join("lldb.cmds");
    std::fs::write(
        &commands,
        format!(
            "settings set plugin.jit-loader.gdb.enable on\n\
             settings set target.debug-file-search-paths \"{}\"\n\
             breakpoint set -f game.ts -l 3\n\
             run\n\
             quit\n",
            fixture_dir("dwarf-guest").display()
        ),
    )
    .expect("write lldb commands");

    let output = Command::new(&lldb)
        .args(["-b", "-s"])
        .arg(&commands)
        .arg("--")
        .arg(&wasmtime)
        .args(["run", "-D", "debug-info", "--invoke", "_start_game"])
        .arg(&guest)
        .output()
        .expect("spawn lldb");

    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        text.contains("stop reason = breakpoint") && text.contains("game.ts:3"),
        "the source breakpoint must resolve and stop in game.ts.\n{text}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// `which`-style lookup that needs no dependency.
fn tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// The Wasmtime the TensionScript harness pins, if that checkout is present.
fn harness_wasmtime() -> Option<PathBuf> {
    let repo = std::env::var_os("TENSIONSCRIPT_REPO")
        .map(PathBuf::from)
        .or_else(|| {
            let sibling = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("TensionScript");
            sibling.is_dir().then_some(sibling)
        })?;
    let cache = repo.join("tests").join("debug").join(".cache");
    let entries = std::fs::read_dir(cache).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("wasmtime");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
