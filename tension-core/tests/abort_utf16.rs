//! The host's `env.abort` diagnostic, pinned for UTF-16 — the `read_as_string`
//! decode in `src/main.rs`.
//!
//! AssemblyScript's `stub` runtime traps through `env.abort(msg, file, line,
//! col)`; both strings are UTF-16 code units in the guest's memory, and the
//! host decodes them into the line a failed run shows:
//!
//! ```text
//! [tension-core] game aborted: <msg> (in <file>, line N, col M)
//! ```
//!
//! The decode used to walk the units one at a time through `char::from_u32`,
//! so a **surrogate pair** — every character outside the BMP, an emoji among
//! them — came out as two U+FFFD. The guest fixture carries a pair in the
//! message and a lone surrogate in the file name, which pins both halves of
//! the contract: a pair is one character, and a lone surrogate is exactly one
//! replacement character (never dropped, never a panic).
//!
//! Nothing here needs an adapter or a session: the run is the interpreter
//! alone, a hand-written guest, and the bytes that guest left in its memory.

use std::path::Path;
use std::process::Command;

/// The interpreter under test, built for this test by `cargo`.
const BINARY: &str = env!("CARGO_BIN_EXE_tension-core");

fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
        .to_str()
        .expect("the fixture path is UTF-8")
        .to_string()
}

#[test]
fn abort_diagnostic_decodes_utf16_like_the_guest_wrote_it() {
    let guest = fixture("abort_utf16_guest.wat");
    let output = Command::new(BINARY)
        .arg(&guest)
        .output()
        .expect("the interpreter starts");
    let err = String::from_utf8_lossy(&output.stderr);

    assert_eq!(
        output.status.code(),
        Some(1),
        "an aborted guest exits 1\nstderr: {err}"
    );
    assert!(
        err.contains(
            "game aborted: abort probe: emoji 😀 and ünïcode \
             (in probe\u{FFFD}.ts, line 7, col 1)"
        ),
        "the diagnostic must be the guest's strings decoded verbatim; a \
         surrogate pair that collapsed into two U+FFFD is the regression \
         this test exists for\nstderr: {err}"
    );
    assert_eq!(
        err.matches('\u{FFFD}').count(),
        1,
        "exactly one replacement character — the file name's lone surrogate, \
         and nothing else\nstderr: {err}"
    );
}
