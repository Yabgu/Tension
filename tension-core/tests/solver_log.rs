//! The solver's diagnostics through the host logger.
//!
//! The solver shim reaches the host through a **bound callback**, not a host
//! symbol (`tension_solver_set_log`, mirroring `tension_solver_bind_callbacks`),
//! so `tension-core` installs a forwarding callback once in `link_solver` and a
//! shim warning arrives as a record on the `solver` logger.
//!
//! This drives the whole path: a hand-written `.wat` guest calls
//! `tension::solver::solver_create` with a wire stating a parameter the method
//! does not read, so the shim emits its ignored-parameter warning; the host
//! renders it through the JSON layout. It also pins the acceptance property that
//! a capability-free run at `--log-format=json` leaves **no** plain line on
//! stderr.

use std::process::{Command, Output};

const HEADER_LEN: usize = 64;

/// The §12 `TNSCONF1` wire for `method: euler`, `source: wasm`, `dim: 1`, and
/// one stated parameter — `relaxation` (bit 8), which euler's mask (relTol,
/// absTol) does not read, so the shim warns "ignored, not refused".
fn wire_euler_relaxation() -> Vec<u8> {
    let method = b"euler";
    let source = b"wasm";
    let bitmap: u32 = 1 << 8; // relaxation
    let params_off: u32 = HEADER_LEN as u32;
    let table_start = HEADER_LEN + 8 * bitmap.count_ones() as usize; // 72
    let method_ptr = table_start as u32;
    let source_ptr = (table_start + 4 + method.len()) as u32;

    let mut b = Vec::new();
    b.extend_from_slice(b"TNSCONF1");
    b.extend_from_slice(&1u16.to_le_bytes()); // format_version @8
    b.extend_from_slice(&1u16.to_le_bytes()); // schema_version @10
    b.extend_from_slice(&method_ptr.to_le_bytes()); // method_ptr @12
    b.extend_from_slice(&(method.len() as u32).to_le_bytes()); // method_len @16
    b.extend_from_slice(&source_ptr.to_le_bytes()); // source_ptr @20
    b.extend_from_slice(&(source.len() as u32).to_le_bytes()); // source_len @24
    b.extend_from_slice(&0u32.to_le_bytes()); // description_ptr @28
    b.extend_from_slice(&0u32.to_le_bytes()); // description_len @32
    b.extend_from_slice(&1u32.to_le_bytes()); // dim @36
    b.extend_from_slice(&params_off.to_le_bytes()); // parameters_off @40
    b.extend_from_slice(&bitmap.to_le_bytes()); // parameters_bitmap @44
    b.extend_from_slice(&0u32.to_le_bytes()); // world_ptr @48
    b.extend_from_slice(&0u32.to_le_bytes()); // world_len @52
    b.extend_from_slice(&[0u8; 8]); // reserved @56..64
    assert_eq!(b.len(), HEADER_LEN);

    b.extend_from_slice(&0.5f64.to_bits().to_le_bytes()); // the relaxation slot
    assert_eq!(b.len(), table_start);
    b.extend_from_slice(&(method.len() as u32).to_le_bytes());
    b.extend_from_slice(method);
    b.extend_from_slice(&(source.len() as u32).to_le_bytes());
    b.extend_from_slice(source);
    b
}

/// A plain guest (its own memory, no session) that calls `solver_create` with
/// the wire at address 1024 and ignores the result.
fn guest(blob: &[u8]) -> String {
    let escaped: String = blob.iter().map(|b| format!("\\{b:02x}")).collect();
    format!(
        r#"(module
  (import "tension::solver" "solver_create"
    (func $create (param i32 i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 1024) "{escaped}")
  (func (export "_start_game")
    (drop (call $create (i32.const 1024) (i32.const {len})
                        (i32.const 0) (i32.const 0) (i32.const 0)))))
"#,
        len = blob.len()
    )
}

fn run_host(extra: &[&str]) -> Output {
    let dir = std::env::temp_dir().join(format!("tension-solver-log-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let guest_path = dir.join("guest.wat");
    std::fs::write(&guest_path, guest(&wire_euler_relaxation())).expect("write the guest");

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .args(extra)
        .arg(&guest_path)
        .output()
        .expect("run tension-core");

    let _ = std::fs::remove_file(&guest_path);
    output
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn the_solver_warning_arrives_as_a_json_record() {
    let output = run_host(&["--log-format=json"]);
    let stderr = stderr_of(&output);

    // The shim's warning, through the callback, through the host logger, through
    // the JSON layout.
    let record = stderr
        .lines()
        .find(|line| line.contains("\"logger\":\"solver\""))
        .unwrap_or_else(|| panic!("no `solver` record on stderr:\n{stderr}"));
    assert!(record.starts_with('{') && record.ends_with('}'), "{record}");
    assert!(record.contains("\"level\":\"WARN\""), "{record}");
    assert!(
        record.contains("parameter 'relaxation' is not read by method 'euler'; ignored"),
        "{record}"
    );

    // And nothing plain shares the stream: every line is one JSON object.
    for line in stderr.lines().filter(|l| !l.is_empty()) {
        assert!(line.starts_with('{'), "plain line among the JSON: {line}");
    }
}

#[test]
fn the_default_text_layout_names_the_solver() {
    let output = run_host(&[]);
    let stderr = stderr_of(&output);
    assert!(
        stderr.lines().any(|line| {
            line.ends_with("WARN  solver: parameter 'relaxation' is not read by method 'euler'; ignored")
        }),
        "the text-layout record is missing:\n{stderr}"
    );
}
