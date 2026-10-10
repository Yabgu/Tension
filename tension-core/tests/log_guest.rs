//! The guest logging imports, end to end.
//!
//! A hand-written `.wat` guest (the host loads the text format as readily as a
//! compiled `game.wasm`) calls `tension::io::log` and `tension::io::log_structured`,
//! and the host's configured layout writes the lines. This is the guest half of
//! the promise that the layout is applied once, in the host: the guest sends a
//! level, a name, and a message; the bytes on stderr are the host's.
//!
//! The binary is run as a subprocess (`CARGO_BIN_EXE_tension-core`), so the test
//! observes exactly what a user would: the interpreter's stderr.

use std::process::{Command, Output};

/// A guest that logs one INFO record and one structured WARN on start.
///
/// `log(level, name_ptr, name_len, msg_ptr, msg_len)` and
/// `log_structured(level, name_ptr, name_len, json_ptr, json_len)`. The buffers:
/// name `guest` at 64 (5 bytes), message `hello from the guest` at 128 (20
/// bytes), payload `{"n":1}` at 256 (7 bytes).
const GUEST: &str = r#"(module
  (import "tension::io" "log" (func $log (param i32 i32 i32 i32 i32)))
  (import "tension::io" "log_structured" (func $log_structured (param i32 i32 i32 i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "guest")
  (data (i32.const 128) "hello from the guest")
  (data (i32.const 256) "{\"n\":1}")
  (func (export "_start_game")
    (call $log (i32.const 2) (i32.const 64) (i32.const 5) (i32.const 128) (i32.const 20))
    (call $log_structured (i32.const 3) (i32.const 64) (i32.const 5) (i32.const 256) (i32.const 7)))
)
"#;

/// Write the guest once and run the interpreter with `extra` flags before it.
fn run_host(extra: &[&str]) -> Output {
    let dir = std::env::temp_dir().join(format!("tension-log-guest-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let guest = dir.join("guest.wat");
    std::fs::write(&guest, GUEST).expect("write the guest");

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .args(extra)
        .arg(&guest)
        .output()
        .expect("run tension-core");

    let _ = std::fs::remove_file(&guest);
    output
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn the_guest_logs_through_tension_io() {
    let output = run_host(&["--log-format=json"]);
    assert!(output.status.success(), "host failed: {}", stderr_of(&output));
    let stderr = stderr_of(&output);

    // The message record: one JSON object per line.
    let message = stderr
        .lines()
        .find(|line| line.contains("\"logger\":\"guest\"") && line.contains("hello from the guest"))
        .unwrap_or_else(|| panic!("no guest message record on stderr:\n{stderr}"));
    assert!(message.starts_with('{') && message.ends_with('}'), "{message}");
    assert!(message.contains("\"level\":\"INFO\""), "{message}");
    assert!(message.contains("\"msg\":\"hello from the guest\""), "{message}");

    // The structured record: the payload is spliced as a nested object.
    let structured = stderr
        .lines()
        .find(|line| line.contains("\"data\":{\"n\":1}"))
        .unwrap_or_else(|| panic!("no guest structured record on stderr:\n{stderr}"));
    assert!(structured.contains("\"level\":\"WARN\""), "{structured}");
    assert!(structured.contains("\"logger\":\"guest\""), "{structured}");
}

#[test]
fn a_per_logger_override_silences_the_guest() {
    // The guest's records are named `guest`; the host's filter applies to them
    // exactly as to a native adapter's.
    let output = run_host(&["--log-level=guest:off"]);
    assert!(output.status.success(), "host failed: {}", stderr_of(&output));
    let stderr = stderr_of(&output);
    assert!(
        !stderr.contains("hello from the guest") && !stderr.contains("\"n\":1"),
        "both guest records should be filtered out:\n{stderr}"
    );
}

#[test]
fn the_text_layout_is_the_default() {
    let output = run_host(&[]);
    assert!(output.status.success(), "host failed: {}", stderr_of(&output));
    let stderr = stderr_of(&output);
    assert!(
        stderr
            .lines()
            .any(|line| line.ends_with("INFO  guest: hello from the guest")),
        "the message record is missing:\n{stderr}"
    );
    // A structured-only record carries no message, so its payload takes the
    // message slot.
    assert!(
        stderr
            .lines()
            .any(|line| line.ends_with("WARN  guest: {\"n\":1}")),
        "the structured record is missing:\n{stderr}"
    );
}
