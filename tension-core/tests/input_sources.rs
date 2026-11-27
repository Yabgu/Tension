//! **One awaitable shape, two sources** — the file reader proves the surface is not
//! AI-shaped (DL57 decision 6).
//!
//! `probe/input-sources.ten` awaits stdin's lines and then a file's, through the *same*
//! function: `drain(0, …)` and `drain(1, …)` differ by one integer. What this asserts is
//! that the host serves both from one surface — `input_arm`, `await inputTask(source)`, the
//! `InputEvent` branch, `readLineNow(source)` — which is the claim the round makes and the
//! reason the shape is worth having.
//!
//! **A real source, not a stub.** `input_arm(1)` opens `TENSION_INPUT_FILE` on the host's
//! reader thread and posts `IO_READY` per line exactly as stdin does. The gate supplies both:
//! stdin from the test, the file from a temporary path it writes.
//!
//! Also asserts the two properties the round is about, on the same run: **one park per
//! event** (`TENSION_ITERATIONS` counts them) and **exit 0** — a guest that finishes its
//! input and then spins on a park it already served would fail here, which is how DL57's
//! `parked()` leak was found.

#[path = "support/programs.rs"]
mod support_programs;

use std::io::Write;
use std::process::{Command, Stdio};

use support_programs::{guest, programs_dir};

fn transcript(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
fn one_program_reads_stdin_and_a_file_through_the_same_awaitable() {
    let path = programs_dir().join("probe/input-sources.expected.txt");
    let expected_text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    let expected = transcript(&expected_text);
    assert!(!expected.is_empty(), "the expected transcript must not be empty");

    // The file source's lines, written by the test so the gate needs no fixture data.
    let dir = std::env::temp_dir().join(format!("tension-input-sources-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let file = dir.join("lines.txt");
    std::fs::write(&file, "from file one\nfrom file two\n").expect("the file source's lines");

    let mut child = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .env("TENSION_INPUT_FILE", &file)
        .env("TENSION_ITERATIONS", "1")
        .arg(guest("input-sources"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the interpreter runs");
    child
        .stdin
        .as_mut()
        .expect("stdin is piped")
        .write_all(b"from stdin\n")
        .expect("the stdin line reaches the guest");
    let output = child.wait_with_output().expect("the run finishes");
    let _ = std::fs::remove_dir_all(&dir);

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // **Exit 0 is the flakiness assertion as much as a success one.** A guest that read
    // everything and then left a park in the scheduler never exits; that is the shape DL57
    // measured as `rc=124` after the final `--- end ---`.
    assert!(
        output.status.success(),
        "the probe must exit 0 after its last line\nstderr:\n{stderr}"
    );
    assert_eq!(
        transcript(&stdout),
        expected,
        "the two sources' transcripts differ\nstderr:\n{stderr}"
    );

    // **One park per event, and the event count is the line count plus one EOF each.** Both
    // sources are `(IO_READY family, source)` parks, so the class names them; the count is
    // what says a park is not being re-served.
    let parks: Vec<&str> = stderr
        .lines()
        .filter(|line| line.contains("park task="))
        .collect();
    // stdin contributes one line and one EOF; the file contributes two lines and one EOF.
    assert_eq!(
        parks.len(),
        5,
        "one park per event: 1 line + 1 EOF (stdin) + 2 lines + 1 EOF (file) = 5; got {}:\n{}",
        parks.len(),
        parks.join("\n")
    );
}
