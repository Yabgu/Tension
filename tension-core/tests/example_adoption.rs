//! Examples adopt the DWARF-emitting compiler.
//!
//! TensionScript 0.14.0 emits `.debug_abbrev` / `.debug_info` / `.debug_line` /
//! `.debug_ranges` itself when `--debug` **and** `--sourceMap` are set, so the
//! host only has to pass them through — it no longer builds DWARF at all. This
//! suite pins the adoption at three levels:
//!
//! | test | what it locks | failure mode |
//! | --- | --- | --- |
//! | `test_examples_pin_dwarf_emitting_compiler` | every example's pin reaches 0.14.0 | hard failure |
//! | `test_example_artifacts_carry_dwarf` | a committed artifact that carries DWARF is passed through untouched | hard failure when the section is there |
//! | `test_launch_configs_are_well_formed` | every example's `launch.json` is parseable JSONC with `program` + `request` | hard failure |
//!
//! The middle test **skips** rather than fails when an example has no built
//! artifact, has no `build:debug` script (a release-only example legitimately
//! produces no DWARF), or has an artifact whose `.debug_info` is absent. The
//! suite must run on a clean checkout that has no compiler and no OGRE; its job
//! is to catch drift in what *is* checked in and to verify what *is* built, not
//! to require a build in-test. Each skip prints its reason.
//!
//! Artifacts are `build/*.wasm` rather than strictly `build/game.wasm`: the ai
//! example builds `build/story.wasm` and the audio example `build/demo.wasm`,
//! and a rule that silently ignored them would miss two of the fifteen
//! examples.
//!
//! ```sh
//! cargo test --manifest-path tension-core/Cargo.toml --test example_adoption
//! ```

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The interpreter under test.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");

/// The report line a guest that already carries DWARF must produce.
const PASSTHROUGH: &str = "DWARF: present (compiler-emitted) — passed through as-is";

/// The lowest compiler release that emits DWARF itself.
const MIN_COMPILER: (u64, u64, u64) = (0, 14, 0);

/// Examples whose `package.json` is expected at minimum. A walker that silently
/// found nothing would turn every assertion below into a vacuous pass, so the
/// count is checked too. Adding examples only raises it.
const MIN_EXAMPLES: usize = 15;

/// Launch configurations expected at minimum, for the same reason.
const MIN_LAUNCH_CONFIGS: usize = 14;

/// Bound on a guest run. Example guests are real programs: an OGRE example on a
/// machine with a display could otherwise keep a window open forever. The DWARF
/// report is printed while the module loads, before `_start_game` runs, so the
/// kill does not affect the assertion.
const RUN_TIMEOUT: Duration = Duration::from_secs(20);

// ------------------------------------------------------------- discovery ---

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tension-core sits under the repository root")
        .to_path_buf()
}

/// Every directory under `examples/` that holds a `package.json`, recursively.
/// `node_modules` is skipped: the examples' dependencies carry their own
/// manifests and none of them is an example.
fn example_dirs() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() {
                if entry.file_name() != "node_modules" {
                    walk(&path, out);
                }
            } else if entry.file_name() == "package.json" {
                if let Some(parent) = path.parent() {
                    out.push(parent.to_path_buf());
                }
            }
        }
    }

    let mut found = Vec::new();
    walk(&repo_root().join("examples"), &mut found);
    found.sort();
    found
}

fn read_package(example: &Path) -> serde_json::Value {
    let path = example.join("package.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("parse {} as JSON: {e}", path.display()))
}

fn relative(path: &Path) -> String {
    path.strip_prefix(repo_root())
        .unwrap_or(path)
        .display()
        .to_string()
}

// -------------------------------------------------------- requirements ---

/// The lowest version a semver requirement admits, for the forms the examples
/// actually use: `0.14.0`, `^0.14.0`, `~0.14.0`, `>=0.14.0`. Returns `None`
/// for anything this does not understand (a `file:` or `workspace:` spec, a
/// range with an upper bound), so the caller can fail loudly instead of
/// guessing that an unprovable pin is fine.
fn lowest_allowed(requirement: &str) -> Option<(u64, u64, u64)> {
    let mut rest = requirement.trim();
    for prefix in [">=", "^", "~", "="] {
        if let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped.trim();
            break;
        }
    }
    // Reject upper bounds and unions: `>=0.14.0 <0.15.0` and `0.13 || 0.14`
    // are not forms this project uses, and reading only the left side would
    // report a version the requirement may not actually allow.
    if rest.contains('<') || rest.contains('|') || rest.contains(' ') || rest.contains('*') {
        return None;
    }
    let core: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

// -------------------------------------------------------------- T1 ---

/// Every example pins a compiler that reaches 0.14.0.
#[test]
fn test_examples_pin_dwarf_emitting_compiler() {
    let examples = example_dirs();
    assert!(
        examples.len() >= MIN_EXAMPLES,
        "found only {} example(s) under examples/ — expected at least {MIN_EXAMPLES}. \
         The walker is broken, and every assertion below would pass vacuously. \
         Found: {:?}",
        examples.len(),
        examples.iter().map(|p| relative(p)).collect::<Vec<_>>()
    );

    let mut failures = Vec::new();
    for example in &examples {
        let package = read_package(example);
        let name = relative(example);
        let Some(requirement) = package["devDependencies"]["@yabgu_gm/tensionscript"].as_str()
        else {
            failures.push(format!(
                "{name}: no devDependencies[\"@yabgu_gm/tensionscript\"] string"
            ));
            continue;
        };
        match lowest_allowed(requirement) {
            Some(version) if version >= MIN_COMPILER => {}
            Some(version) => failures.push(format!(
                "{name}: pins {requirement} (lowest {}.{}.{}), which does not reach 0.14.0",
                version.0, version.1, version.2
            )),
            None => failures.push(format!(
                "{name}: pins {requirement}, which this test cannot prove reaches 0.14.0"
            )),
        }
    }

    assert!(
        failures.is_empty(),
        "examples must pin @yabgu_gm/tensionscript ^0.14.0 or later so their \
         debug builds carry compiler-emitted DWARF:\n  {}",
        failures.join("\n  ")
    );
    eprintln!("T1: {} example(s) pin a compiler that reaches 0.14.0", examples.len());
}

// -------------------------------------------------------------- T2 ---

/// Run the host under `--debug` with a bounded wait and return its stderr.
fn debug_stderr(wasm: &Path) -> String {
    let mut child = Command::new(BINARY)
        .arg("--debug")
        .arg(wasm)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("spawn {BINARY} on {}: {e}", wasm.display()));

    let mut stderr = child.stderr.take().expect("stderr was piped");
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stderr.read_to_string(&mut buffer);
        let _ = sender.send(buffer);
    });

    let deadline = Instant::now() + RUN_TIMEOUT;
    loop {
        match child.try_wait().expect("poll tension-core") {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
    receiver.recv_timeout(Duration::from_secs(5)).unwrap_or_default()
}

/// The marker the host's `has_debug_sections` keys on. Reading the section
/// names out of the bytes is enough to decide whether a guest is a DWARF guest;
/// this test decides *skip vs. verify*, it does not re-implement the check.
fn carries_dwarf(bytes: &[u8]) -> bool {
    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|window| window == needle)
    }
    contains(bytes, b".debug_info") && contains(bytes, b".debug_line")
}

/// A built example artifact that carries DWARF is passed through untouched.
#[test]
fn test_example_artifacts_carry_dwarf() {
    let mut verified = 0usize;
    let mut skipped = Vec::new();
    let mut failures = Vec::new();

    for example in example_dirs() {
        let name = relative(&example);
        let build = example.join("build");
        let mut artifacts: Vec<PathBuf> = fs::read_dir(&build)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().is_some_and(|e| e == "wasm"))
                    .collect()
            })
            .unwrap_or_default();
        artifacts.sort();

        if artifacts.is_empty() {
            skipped.push(format!("{name}: no build/*.wasm artifact (not built here)"));
            continue;
        }

        let package = read_package(&example);
        if !package["scripts"]["build:debug"].is_string() {
            skipped.push(format!(
                "{name}: release-only build (no \"build:debug\" script), so its \
                 artifact carries no DWARF by design"
            ));
            continue;
        }

        for artifact in artifacts {
            let artifact_name = relative(&artifact);
            let bytes = match fs::read(&artifact) {
                Ok(bytes) => bytes,
                Err(error) => {
                    failures.push(format!("{artifact_name}: read failed: {error}"));
                    continue;
                }
            };
            if !carries_dwarf(&bytes) {
                skipped.push(format!(
                    "{artifact_name}: no .debug_info/.debug_line section, so \
                     there is no pass-through to verify"
                ));
                continue;
            }

            let stderr = debug_stderr(&artifact);
            if stderr.contains(PASSTHROUGH) {
                verified += 1;
            } else {
                failures.push(format!(
                    "{artifact_name}: carries DWARF but the host did not report the \
                     pass-through line.\n    stderr:\n{}",
                    stderr.trim()
                ));
            }
        }
    }

    for reason in &skipped {
        eprintln!("T2 skip: {reason}");
    }
    eprintln!("T2: verified {verified} artifact(s), skipped {}", skipped.len());

    assert!(
        failures.is_empty(),
        "compiler-emitted DWARF must reach the debugger untouched:\n  {}",
        failures.join("\n  ")
    );
    if verified == 0 {
        eprintln!(
            "T2: nothing to verify on this checkout — no built artifact carries \
             DWARF. Run the examples' build:debug scripts to exercise this test."
        );
    }
}

// -------------------------------------------------------------- T3 ---

/// Strip `//` and `/* */` comments and trailing commas from JSONC, respecting
/// string literals and escapes, so `serde_json` can read a VS Code file.
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                out.push('\n');
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            if c == '*' && next == Some('/') {
                in_block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(escaped) = next {
                    out.push(escaped);
                    i += 2;
                    continue;
                }
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }
        if c == '/' && next == Some('/') {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if c == '/' && next == Some('*') {
            in_block_comment = true;
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }

    // Trailing commas: `,]` or `,}` with only whitespace between.
    let chars: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(out.len());
    for (index, &ch) in chars.iter().enumerate() {
        if ch == ',' {
            let mut lookahead = index + 1;
            while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                lookahead += 1;
            }
            if matches!(chars.get(lookahead), Some(']') | Some('}')) {
                continue;
            }
        }
        cleaned.push(ch);
    }
    cleaned
}

/// Every example's `launch.json` parses and declares usable configurations.
#[test]
fn test_launch_configs_are_well_formed() {
    let mut inspected = 0usize;
    let mut configs_seen = 0usize;
    let mut failures = Vec::new();

    for example in example_dirs() {
        let path = example.join(".vscode").join("launch.json");
        if !path.exists() {
            continue;
        }
        inspected += 1;
        let name = relative(&path);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                failures.push(format!("{name}: read failed: {error}"));
                continue;
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&strip_jsonc(&text)) {
            Ok(value) => value,
            Err(error) => {
                failures.push(format!("{name}: not valid JSONC: {error}"));
                continue;
            }
        };
        let Some(configurations) = value["configurations"].as_array() else {
            failures.push(format!("{name}: no \"configurations\" array"));
            continue;
        };
        for (index, configuration) in configurations.iter().enumerate() {
            configs_seen += 1;
            if !configuration["program"].is_string() {
                failures.push(format!("{name}: configurations[{index}] has no \"program\" string"));
            }
            if !configuration["request"].is_string() {
                failures.push(format!("{name}: configurations[{index}] has no \"request\" string"));
            }
        }
    }

    assert!(
        inspected >= MIN_LAUNCH_CONFIGS,
        "found only {inspected} launch.json file(s) under examples/ — expected at \
         least {MIN_LAUNCH_CONFIGS}; the walker is broken"
    );
    assert!(
        failures.is_empty(),
        "launch configurations must stay parseable and complete:\n  {}",
        failures.join("\n  ")
    );
    eprintln!(
        "T3: {inspected} launch.json file(s), {configs_seen} configuration(s) well formed"
    );
}
