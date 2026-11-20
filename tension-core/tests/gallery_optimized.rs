//! The same program, optimized, must behave the same — on this host, not only
//! in the compiler's own test suite.
//!
//! The compiler repo pins "a continuation module compiles at -O0..-O3"
//! (`TensionScript/tests/async/optimize.js`). That test can only prove the
//! build and the artifact's magic number; it never runs the guest. A defect
//! that survives optimization — a slot that was deduplicated, a resume that
//! lost its handler, an order that a pass reshuffled — would pass it and change
//! what this host observes.
//!
//! So this file asks the narrower, harder question: **is the transcript the
//! same at -O2 as at -O0?** `async/schedule-order.ts` is the guest, because its
//! transcript *is* its assertion: three policies, three creation orders, one
//! resume order, and a step the program owns.
//!
//! Two things are asserted, and the second is what keeps the first honest:
//!
//! 1. the two transcripts are identical, line for line;
//! 2. the -O2 artifact is materially smaller than the -O0 one. Without this, a
//!    builder that silently dropped the level would run the same `-O0` bytes
//!    twice and pass — a green test that measured nothing.

#[path = "support/programs.rs"]
mod support_programs;

use std::fs;
use std::path::Path;
use std::process::Command;

use support_programs::{guest, guest_optimized};

/// Run one artifact and answer its non-empty stdout lines, or `None` when this
/// target has no stack switching and the host refused the guest by name.
///
/// A refusal is asserted to name the feature: a silent empty stdout would make
/// the equality below pass for the wrong reason.
fn run(program: &Path, name: &str) -> Option<Vec<String>> {
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(program)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !tension_core::async_backend::current().supports_continuations() {
        assert!(
            !output.status.success(),
            "{name} must be refused on a target without stack switching, but it exited 0"
        );
        assert!(
            stderr.contains("stack switching") || stderr.contains("continuation"),
            "the refusal for {name} must name the feature, got:\n{stderr}"
        );
        eprintln!(
            "{name}: stack switching is unavailable on {} — the host refused the guest \
             by name (expected), and the optimized-transcript assertions are skipped",
            std::env::consts::OS,
        );
        return None;
    }

    assert!(
        output.status.success(),
        "{name} failed (exit {:?})\nstdout:\n{stdout}\nstderr:\n{}",
        output.status.code(),
        stderr.lines().rev().take(12).collect::<Vec<_>>().join("\n")
    );
    Some(
        stdout
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect(),
    )
}

/// The schedule is the assertion: -O2 must reproduce the -O0 transcript exactly.
#[test]
fn the_schedule_survives_optimization() {
    const LEVEL: u8 = 2;

    let baseline_path = guest("schedule-order");
    let optimized_path = guest_optimized("schedule-order", LEVEL);

    let Some(baseline) = run(&baseline_path, "schedule-order (-O0)") else {
        return;
    };
    let Some(optimized) = run(&optimized_path, "schedule-order (-O2)") else {
        return;
    };

    // **The level really changed.** If these were the same bytes, the builder
    // ignored the flag and the equality below would be vacuous.
    let unoptimized_len = fs::metadata(&baseline_path).expect("the -O0 artifact exists").len();
    let optimized_len = fs::metadata(&optimized_path).expect("the -O2 artifact exists").len();
    assert!(
        optimized_len * 2 < unoptimized_len,
        "the -O{LEVEL} artifact ({} bytes) is not materially smaller than the -O0 one \
         ({} bytes) — the level was probably not applied, so the transcript comparison \
         below would compare a program against itself",
        optimized_len,
        unoptimized_len
    );

    // The floor: three ranked bodies entered, three resumed, one eager body run
    // at its call site. Stated so a *shared* failure (both builds broken the
    // same way) cannot pass as equality.
    for marker in ["enter eager", "enter high", "enter mid", "enter low", "steps"] {
        assert!(
            baseline.iter().any(|line| line == marker || line.starts_with(marker)),
            "the -O0 transcript is missing `{marker}`, so it is not a schedule:\n{}",
            baseline.join("\n")
        );
    }

    assert_eq!(
        optimized,
        baseline,
        "the -O{LEVEL} transcript must match the -O0 one line for line\n\
         -O0:\n{}\n-O{LEVEL}:\n{}",
        baseline.join("\n"),
        optimized.join("\n")
    );

    eprintln!(
        "schedule-order: {} lines identical at -O0 and -O{LEVEL} ({} -> {} bytes)",
        baseline.len(),
        unoptimized_len,
        optimized_len
    );
}
