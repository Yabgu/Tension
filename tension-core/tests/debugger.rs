//! What a debugger can actually see of a guest, asserted on every platform
//! that can have it.
//!
//! Three claims, in the order a person meets them:
//!
//! | test | claim | runs on |
//! |---|---|---|
//! | `the_debug_report_names_what_a_debugger_can_see` | `--debug` reports the DWARF, the source map and the lldb recipe a breakpoint needs | every platform |
//! | `a_source_breakpoint_binds_in_a_promise_guest` | a `.ts` line in a DWARF-carrying guest stops under lldb | Linux/macOS (Windows: fact, below) |
//! | `a_source_breakpoint_binds_in_a_stack_switching_guest` | the same for an async program on the stackful backend | self-upgrading, see below |
//!
//! # Why the first test is the one that must never regress
//!
//! Whether a source breakpoint can bind is a property of the *guest* — the
//! compiler's DWARF — plus one host flag. The host does not build a line table
//! (`src/debug.rs`), so the most it can do is say, at startup, what it received
//! and which lldb commands follow from that. That report is what a person reads
//! when a breakpoint does not bind, on every platform, including the one where
//! no breakpoint can bind at all.
//!
//! # The Windows fact
//!
//! lldb on Windows does not register wasmtime's GDB-JIT image: the guest runs,
//! and `image list` shows no `JIT(0x…)` entry at all (measured on the msys2
//! lldb; wasmtime gates the JIT-debug module on `gdb_jit_int`, which the GDB
//! plugin reads, and that path exists for the ELF targets). So (b) and (c) keep
//! their count on Windows but assert only what is observable there — the
//! report. They are not `#[ignore]`d: an ignored test is a test nobody notices
//! has stopped existing.
//!
//! # Why (c) passes today without a debugger
//!
//! The pinned compiler (0.14.1) emits **no DWARF for a stack-switching
//! program** — it warns `DWARF emission failed: type form is not a function
//! type` at build time and ships `name` + `sourceMappingURL` only. That is
//! upstream and this round does not fake it. The test therefore reads the
//! artifact's custom sections first: absent `.debug_info` prints the reason and
//! returns. When the pin moves, the same test runs lldb with no edit — which is
//! the whole point of asserting the section walk rather than a version string.
//!
//! # One lldb driver
//!
//! Nothing here parses lldb output. (b) and (c) spawn
//! `tools/e2e-debugger/runner.js --guest … --file … --line …`, the same entry
//! point the examples' debug mode uses, and read the one JSON line it prints.
//! `TENSION_CORE` points that driver at `CARGO_BIN_EXE_tension-core`, so the
//! binary under test is the one cargo just built rather than whatever
//! `target/release` happens to hold.
//!
//! Skip policy: `tests/support/ci.rs`. A missing artifact or a missing lldb
//! fails by default; `TENSION_TEST_ALLOW_SKIP=1` prints the reason instead.

#[path = "support/ci.rs"]
mod support_ci;

// `support/programs.rs` carries both build modes; this target uses only the
// debug one, so the release helpers are allowed to go unreferenced here rather
// than being duplicated for this file's benefit.
#[allow(dead_code)]
#[path = "support/programs.rs"]
mod support_programs;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use support_programs::guest_debug;

/// The interpreter under test.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");

/// The line in `tests/programs/async/rt-guards.ts` that the Promise guest is
/// expected to stop on: `line("job-key: " + handle._record.key.toString());`.
/// It runs after two host calls, so the stop is inside the guest's own body
/// rather than at its entry.
const RT_GUARDS_LINE: u64 = 96;

/// The line in `tests/programs/async/main-policy.ts`: the `print` after two
/// `await`s. Stopping there is the claim — the program suspended twice on the
/// stackful backend and the debugger still had a source line to stop on.
const MAIN_POLICY_LINE: u64 = 41;

// ------------------------------------------------------------- sections ---

/// The custom section names a wasm module carries, in file order.
///
/// The same walk `main.rs::declares_start_section` does for the start section —
/// magic and version, then `(id, size)` pairs — because `wasmtime::Module`
/// exposes custom sections but the test needs them before the host is involved
/// at all. A malformed module answers what it managed to read; the caller is
/// asking "is `.debug_info` here", and a truncated file answers no.
fn custom_sections(bytes: &[u8]) -> Vec<String> {
    const CUSTOM: u8 = 0;
    let mut sections = Vec::new();
    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
        return sections;
    }
    let mut at = 8usize;
    while at < bytes.len() {
        let id = bytes[at];
        at += 1;
        let Some(size) = read_uleb(bytes, &mut at) else {
            return sections;
        };
        let Some(end) = at.checked_add(size).filter(|end| *end <= bytes.len()) else {
            return sections;
        };
        if id == CUSTOM {
            let mut cursor = at;
            if let Some(name_len) = read_uleb(bytes, &mut cursor) {
                let stop = cursor.saturating_add(name_len).min(end);
                if stop > cursor {
                    sections.push(String::from_utf8_lossy(&bytes[cursor..stop]).into_owned());
                }
            }
        }
        at = end;
    }
    sections
}

/// An unsigned LEB128 integer, or `None` past the end of the buffer.
fn read_uleb(bytes: &[u8], at: &mut usize) -> Option<usize> {
    let mut value = 0usize;
    let mut shift = 0u32;
    loop {
        let byte = *bytes.get(*at)?;
        *at += 1;
        value |= ((byte & 0x7f) as usize).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift >= usize::BITS {
            return None;
        }
    }
}

/// Whether the artifact carries `.debug_info` — the section that makes a source
/// breakpoint possible at all.
fn carries_debug_info(guest: &Path) -> bool {
    match std::fs::read(guest) {
        Ok(bytes) => custom_sections(&bytes).iter().any(|name| name == ".debug_info"),
        Err(error) => {
            support_ci::skip_or_fail(format_args!(
                "debugger: cannot read {}: {error}",
                guest.display()
            ));
            false
        }
    }
}

// --------------------------------------------------------------- report ---

/// Run the host the way a person would, and return its stderr.
fn debug_report(guest: &Path) -> String {
    let dir = guest.parent().expect("the artifact has a parent directory");
    let output = Command::new(BINARY)
        .arg("--debug")
        .arg("--symbol-path")
        .arg(dir)
        .arg(guest)
        .output()
        .expect("the interpreter runs");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The lines `--debug` prints as the lldb recipe, per `src/debug.rs::report`.
/// The three a breakpoint needs: the GDB JIT loader, a source line, a function
/// pattern. The `image list` hint is printed beside them and is not asserted
/// here — it is advice, not a step.
fn recipe_lines(source_file: &str, module_hint: &str) -> [String; 3] {
    [
        "lldb: settings set plugin.jit-loader.gdb.enable on".to_string(),
        format!("lldb: breakpoint set -f {source_file} -l <line>"),
        format!("lldb: breakpoint set -r '{module_hint}'"),
    ]
}

// ------------------------------------------------------------- the tool ---

/// What `tools/e2e-debugger/runner.js --guest` answers.
///
/// One JSON line, printed last, in the shape the examples' debug mode reports
/// through the same driver: whether the process stopped, and where.
struct Observation {
    stopped: bool,
    hit_breakpoint: bool,
    file: Option<String>,
    line: Option<u64>,
    function: Option<String>,
    /// Present only when the question could not be measured (no lldb, no
    /// artifact). Emphatically not the same answer as "did not bind".
    reason: Option<String>,
}

impl Observation {
    fn describe(&self) -> String {
        format!(
            "stopped={} hit_breakpoint={} file={} line={} function={}",
            self.stopped,
            self.hit_breakpoint,
            self.file.as_deref().unwrap_or("(none)"),
            self.line.map(|line| line.to_string()).unwrap_or_else(|| "(none)".into()),
            self.function.as_deref().unwrap_or("(none)"),
        )
    }
}

/// The repository root — the runner resolves everything from its own location,
/// but a child process needs somewhere to start, and this is where a person
/// runs it from.
fn repo_root() -> PathBuf {
    support_programs::repo()
}

/// Debug one artifact under lldb, through the repo's one driver.
fn observe_under_lldb(guest: &Path, file: &str, line: u64) -> Observation {
    let runner = repo_root()
        .join("tools")
        .join("e2e-debugger")
        .join("runner.js");
    if !runner.exists() {
        support_ci::skip_or_fail(format_args!(
            "debugger: {} is missing, so there is no lldb driver to run",
            runner.display()
        ));
    }

    let output: Output = Command::new("node")
        .arg(&runner)
        .arg("--guest")
        .arg(guest)
        .arg("--file")
        .arg(file)
        .arg("--line")
        .arg(line.to_string())
        .env("TENSION_CORE", BINARY)
        .current_dir(repo_root())
        .output()
        .unwrap_or_else(|error| {
            support_ci::skip_or_fail(format_args!(
                "debugger: could not run `node {}`: {error}",
                runner.display()
            ));
            panic!("unreachable: skip_or_fail panics by default")
        });

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let Some(json) = stdout.lines().rev().find(|line| line.trim_start().starts_with('{')) else {
        panic!(
            "the lldb driver printed no JSON report (exit {:?})\nstdout:\n{stdout}\nstderr:\n{stderr}",
            output.status.code()
        );
    };
    let value: serde_json::Value = serde_json::from_str(json.trim())
        .unwrap_or_else(|error| panic!("the driver's report is not JSON: {error}\n{json}"));

    let text = |key: &str| value.get(key).and_then(|value| value.as_str()).map(str::to_string);
    Observation {
        stopped: value.get("stopped").and_then(|v| v.as_bool()).unwrap_or(false),
        hit_breakpoint: value
            .get("hit_breakpoint")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        file: text("file"),
        line: value.get("line").and_then(|v| v.as_u64()),
        function: text("function"),
        reason: text("reason"),
    }
}

// ---------------------------------------------------------------- tests ---

/// (a) The startup report names the three things a debugger needs — DWARF, the
/// source map, the lldb recipe — for the artifact a person actually builds.
///
/// Every platform. A failure here is not "the debugger is broken": it is the
/// report that a reader uses to find out *why* a breakpoint does not bind, so a
/// silent change to it costs more than any single platform's bind.
#[test]
fn the_debug_report_names_what_a_debugger_can_see() {
    let guest = guest_debug("rt-guards");
    let stderr = debug_report(&guest);

    assert!(
        stderr.contains("DWARF: present (compiler-emitted) — passed through as-is"),
        "a debug artifact of rt-guards must report DWARF present; sections were {:#?}\nstderr:\n{stderr}",
        custom_sections(&std::fs::read(&guest).expect("read the artifact")),
    );

    // The map the compiler wrote beside the artifact, marked found. The URL is
    // the compiler's (``./rt-guards.wasm.map`` today), so the assertion is on
    // the file it names and the resolution — not on its prefix.
    let map_name = format!(
        "{}.map",
        guest.file_name().expect("artifact has a name").to_string_lossy()
    );
    let map_line = stderr
        .lines()
        .find(|line| line.contains("debug:   source map: "))
        .unwrap_or_else(|| panic!("the report names no source map\nstderr:\n{stderr}"));
    assert!(
        map_line.contains(&map_name),
        "expected the report to name `{map_name}` — the map the compiler wrote beside the artifact\ngot:\n{map_line}"
    );
    assert!(
        map_line.trim_end().ends_with("(found)"),
        "the map is beside the artifact, so it must resolve — otherwise the source-map link is broken\ngot:\n{map_line}"
    );

    for wanted in recipe_lines("rt-guards.ts", "rt-guards/") {
        assert!(
            stderr.contains(&wanted),
            "the report must carry the lldb recipe line `{wanted}`\nstderr:\n{stderr}"
        );
    }
}

/// (b) A source breakpoint in a **Promise** guest binds.
///
/// The plain build emits DWARF today, so this is the assertion that keeps the
/// whole path — compiler DWARF, host `--debug`, wasmtime's JIT registration,
/// lldb — honest. The measured stop is `rt-guards.ts:96`.
///
/// Windows cannot bind (module docs, "the Windows fact"), so there the test
/// asserts the capability fact it can check and says what it did not measure.
#[test]
fn a_source_breakpoint_binds_in_a_promise_guest() {
    let guest = guest_debug("rt-guards");

    if cfg!(windows) {
        eprintln!(
            "lldb on windows does not register JIT images, so a guest breakpoint cannot bind \
             (measured; see docs/debugging.md)"
        );
        assert_dwarf_report_only(&guest);
        return;
    }

    let observation = observe_under_lldb(&guest, "rt-guards.ts", RT_GUARDS_LINE);
    if let Some(reason) = &observation.reason {
        support_ci::skip_or_fail(format_args!("debugger: {reason}"));
        return;
    }
    eprintln!("rt-guards under lldb: {}", observation.describe());

    assert!(
        observation.stopped,
        "lldb never stopped the process at all — the guest breakpoint was pending to the end: {}",
        observation.describe()
    );
    assert!(
        observation.hit_breakpoint,
        "the breakpoint did not bind: {}",
        observation.describe()
    );
    assert_eq!(
        observation.file.as_deref(),
        Some("rt-guards.ts"),
        "stopped in the wrong file: {}",
        observation.describe()
    );
    assert_eq!(
        observation.line,
        Some(RT_GUARDS_LINE),
        "stopped on the wrong line: {}",
        observation.describe()
    );
    // The stop must be inside the guest's own function, not the host's frame
    // that happened to run: `<dir>/rt-guards/_start_game` is the symbol the
    // JIT image carries for it.
    let function = observation.function.as_deref().unwrap_or("");
    assert!(
        function.contains("rt-guards/_start_game"),
        "stopped in the host rather than the guest: {}",
        observation.describe()
    );
}

/// (c) The regression guard for the reason DWARF exists: a breakpoint in an
/// **async program on the stackful backend**.
///
/// Today the pinned compiler emits no DWARF for a stack-switching program, so
/// this prints that reason and returns. It re-reads the artifact every run, so
/// the day the pin carries DWARF this test starts asserting a real stop with no
/// edit — no version check, no flag to flip.
#[test]
fn a_source_breakpoint_binds_in_a_stack_switching_guest() {
    let guest = guest_debug("main-policy");

    if !carries_debug_info(&guest) {
        eprintln!(
            "the pinned compiler emits no DWARF for stack-switching programs yet \
             (tensionscript 0.14.1; see the warning at build time)"
        );
        return;
    }

    if cfg!(windows) {
        eprintln!(
            "lldb on windows does not register JIT images, so a guest breakpoint cannot bind \
             (measured; see docs/debugging.md)"
        );
        assert_dwarf_report_only(&guest);
        return;
    }

    let observation = observe_under_lldb(&guest, "main-policy.ts", MAIN_POLICY_LINE);
    if let Some(reason) = &observation.reason {
        support_ci::skip_or_fail(format_args!("debugger: {reason}"));
        return;
    }
    eprintln!("main-policy under lldb: {}", observation.describe());

    assert!(
        observation.hit_breakpoint,
        "the artifact carries .debug_info but the breakpoint did not bind: {}",
        observation.describe()
    );
    assert_eq!(
        observation.file.as_deref(),
        Some("main-policy.ts"),
        "stopped in the wrong file: {}",
        observation.describe()
    );
    assert_eq!(
        observation.line,
        Some(MAIN_POLICY_LINE),
        "stopped on the wrong line: {}",
        observation.describe()
    );
}

/// The one assertion a platform without JIT images can still make: the host
/// reports the guest's DWARF, so the missing stop is the platform's, not the
/// build's.
fn assert_dwarf_report_only(guest: &Path) {
    let stderr = debug_report(guest);
    assert!(
        stderr.contains("DWARF: present (compiler-emitted) — passed through as-is"),
        "the artifact has no DWARF to report — this is a build problem, not a platform one\nstderr:\n{stderr}"
    );
}
