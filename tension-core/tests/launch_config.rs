//! The debugger configurations in `tests/programs/.vscode/` are code, and
//! nothing tested them.
//!
//! Measured: the lldb configuration launched `build/<name>.wasm` — the
//! **release** build, which carries no `.debug_*` sections at all — while the
//! whole point of that configuration is a `.ts` breakpoint. Every breakpoint
//! set through it would have been pending to the end, and the run would have
//! looked normal. Nothing caught it because nothing read the file: the
//! examples' `launch.json` files are read by `tools/e2e-debugger`, and this
//! folder's was not.
//!
//! So this file reads it, and asserts the two facts that make the other files
//! in this directory work:
//!
//! 1. every program in the picker exists as a source **and** has a debug
//!    artifact recipe (`build-test-programs.mjs --debug` builds all of them),
//!    so choosing one in VS Code cannot name a program that was never built;
//! 2. the configuration that says it debugs a guest opens the artifact that
//!    has a line table, and its `preLaunchTask` is the task that makes one.
//!
//! A comment cannot enforce either. This can.

use std::fs;
use std::path::{Path, PathBuf};

/// Strip `//` comments and trailing commas from a JSONC file.
///
/// Deliberately small: it walks the text, tracks whether it is inside a string,
/// and drops a `//` run that is not. It does not handle `/* */`, which these
/// files do not use — if one ever does, this fails to parse and says so, which
/// is the right way for a reader-only helper to be incomplete.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }
        if c == '/' && chars.peek() == Some(&'/') {
            // Drop to the end of the line, keeping the newline.
            for next in chars.by_ref() {
                if next == '\n' {
                    out.push('\n');
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }

    // Trailing commas: `,` followed only by whitespace before `]` or `}`.
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == ',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == ']' || bytes[j] == '}') {
                i += 1;
                continue;
            }
        }
        cleaned.push(c);
        i += 1;
    }
    cleaned
}

fn programs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("programs")
}

fn read_jsonc(path: &Path) -> serde_json::Value {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    serde_json::from_str(&strip_jsonc(&text))
        .unwrap_or_else(|error| panic!("{} is not JSON after stripping comments: {error}", path.display()))
}

/// The guest-source extensions, as `scripts/lib/guest-extensions.mjs` declares them.
///
/// Repeated here rather than shelled out for: a Rust test that spawns Node to learn
/// three strings is slower than the three strings, and this file already asserts
/// against `tasks.json` as data. The load-bearing check is the other direction —
/// `every_program_has_its_own_configuration` compares this list against the
/// configurations, so a program spelled with an extension missing here fails by
/// name rather than silently vanishing from the enumeration.
const GUEST_EXTENSIONS: [&str; 3] = ["tension", "ten", "ts"];

/// Every guest source under `tests/programs/`, by basename.
fn program_sources() -> Vec<String> {
    fn walk(dir: &Path, found: &mut Vec<String>) {
        for entry in fs::read_dir(dir).expect("the programs directory is readable") {
            let entry = entry.expect("a directory entry");
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().and_then(|n| n.to_str()) == Some("build") {
                    continue;
                }
                walk(&path, found);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|ext| GUEST_EXTENSIONS.contains(&ext))
            {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    found.push(stem.to_string());
                }
            }
        }
    }
    let mut found = Vec::new();
    walk(&programs_dir(), &mut found);
    found.sort();
    found
}

/// Every program under `tests/programs/` has exactly one configuration, and
/// every configuration names a program that exists.
///
/// One configuration per program, each naming its own `.wasm`: no picker, no
/// indirection. So the two lists must agree in both directions — a
/// configuration for a renamed program builds one file and runs another, and a
/// program with no configuration is a program that cannot be debugged at all.
#[test]
fn every_program_has_its_own_configuration() {
    let dir = programs_dir();
    let launch = read_jsonc(&dir.join(".vscode").join("launch.json"));

    let mut named: Vec<String> = launch["configurations"]
        .as_array()
        .expect("launch.json declares configurations")
        .iter()
        .filter_map(|config| config["name"].as_str())
        .filter_map(|name| name.strip_prefix("debug: "))
        .map(str::to_string)
        .collect();
    named.sort();

    let mut sources = program_sources();
    sources.sort();

    assert!(!named.is_empty(), "launch.json offers no configurations at all");
    assert_eq!(
        named, sources,
        "every program under tests/programs/ must have exactly one `debug: <name>` \
         configuration, and no configuration may name a program that is gone"
    );
}

/// The configuration that debugs a **guest** opens the artifact with a line
/// table, and builds one first.
///
/// `build/<name>.wasm` is the release artifact: no `--debug`, so no `.debug_*`
/// sections, so a `.ts` breakpoint can never bind. This assertion exists
/// because that is exactly what this file said before it was read by a test.
#[test]
fn the_guest_debugger_opens_a_debug_artifact() {
    let dir = programs_dir();
    let launch = read_jsonc(&dir.join(".vscode").join("launch.json"));
    let tasks = read_jsonc(&dir.join(".vscode").join("tasks.json"));

    let configs = launch["configurations"]
        .as_array()
        .expect("launch.json declares configurations");

    // The configurations that run a guest are the ones whose args name a
    // `.wasm`; a runner-based config hands the name to `runner.mjs`, which
    // resolves `build/debug/` itself (and says so when it prints the artifact).
    let mut guest_configs = 0;
    for config in configs {
        let args: Vec<String> = config["args"]
            .as_array()
            .map(|args| {
                args.iter()
                    .filter_map(|arg| arg.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let Some(artifact) = args.iter().find(|arg| arg.ends_with(".wasm")) else {
            continue;
        };
        guest_configs += 1;
        let name = config["name"].as_str().unwrap_or("<unnamed>");

        assert!(
            artifact.contains("build/debug/"),
            "`{name}` opens `{artifact}`, which is the release artifact — it carries no \
             `.debug_*` sections, so a `.ts` breakpoint cannot bind in it"
        );

        // Its pre-launch task must be one that appends `--debug`, or the file
        // it points at may simply not exist on a fresh checkout.
        let task_label = config["preLaunchTask"]
            .as_str()
            .unwrap_or_else(|| panic!("`{name}` names no preLaunchTask, so its artifact may not exist"));
        let task = tasks["tasks"]
            .as_array()
            .expect("tasks.json declares tasks")
            .iter()
            .find(|task| task["label"] == task_label)
            .unwrap_or_else(|| panic!("`{name}` names task `{task_label}`, which tasks.json does not define"));
        let command = task["command"].as_str().unwrap_or("");
        assert!(
            command.contains("--debug") && command.contains("--sourceMap"),
            "`{name}` runs task `{task_label}` (`{command}`), which does not build debug \
             artifacts; the guest it opens has no line table"
        );

        // **The task must build the file the configuration opens.** A task that
        // compiles a different program leaves the launched artifact stale, and
        // the symptom is a breakpoint that binds at the wrong line rather than
        // an error — the worst kind of mismatch to diagnose from a debugger.
        let program = name
            .strip_prefix("debug: ")
            .unwrap_or_else(|| panic!("`{name}` is not named `debug: <program>`"));
        // **The canonical guest spelling**: `.ten` (DL46; it was `.tension` at DL45). The `.ts` this
        // asserted through DL44 is still accepted by the compiler during the
        // deprecation window, so this could read green while the task compiled a
        // file the tree no longer has — which is why the assertion names the
        // canonical extension rather than any accepted one.
        assert!(
            command.contains(&format!("{program}.ten")),
            "`{name}` runs task `{task_label}` (`{command}`), which does not compile \
             {program}.ten"
        );
        assert!(
            command.contains(&format!("{program}.wasm")),
            "`{name}` runs task `{task_label}` (`{command}`), which does not write \
             {program}.wasm"
        );
    }

    assert!(
        guest_configs > 0,
        "no configuration opens a guest artifact at all, so this test measured nothing"
    );
}
