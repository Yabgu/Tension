//! Async on main: a stackful continuation chain on one store, with no host.
//!
//! `examples/async-on-main/game.ts` is the counterpart of `async_await.rs` that
//! this file exists to prove: `async_await.rs` needs a real cross-thread
//! completion, so it needs OGRE, a loader thread and a fixture volume. Here
//! there is no producer at all. The guest's own core loop
//! (`~lib/async/__coreloopAwait`, emitted into `__start` by the compiler's
//! stackful backend) is the only thing that resumes a parked continuation, and
//! the only import the module carries is `tension::io` for the transcript.
//!
//! What the guest prints, and what is asserted below:
//!
//! 1. **ordering** — every `before await` line precedes its `after await` line,
//!    and the chain's bodies print between them;
//! 2. **a call runs nothing** — `bodies run=0` before the first await, `3` after
//!    it: all three bodies of `main -> outer -> mid -> base` ran after the park;
//! 3. **lifted locals survive** — `a == 16` (the chain's value), and the loop's
//!    running `total` is 16, 23, 40, 67 rather than restarting each iteration;
//! 4. **the loop ran exactly three times**, one suspension per iteration, and
//!    the final value is the sum the guest computed.
//!
//! The guest is built by [`built_guest`] from the example's own source with the
//! example's own flags (`package.json`), so the two cannot disagree: the build
//! line is read from `scripts` rather than restated here.
//!
//! Nothing here needs a capability, a window or a resource volume, and nothing
//! here runs a nested guest: `tension-core <guest>` is the whole invocation.

#[path = "support/ci.rs"]
mod support_ci;

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tension-core is a directory under the repository root")
        .to_path_buf()
}

/// The example's directory, which is also where its `package.json` build line
/// lives.
fn example_dir() -> PathBuf {
    repo().join("examples").join("async-on-main")
}

/// The build command, read out of the example's `scripts.build`.
///
/// One recipe, two callers: `npm run build` in the example and this test. A
/// second copy of the flag list here would be the drift this repository refuses
/// — and the flag that matters most (`--enable stack-switching`) is exactly the
/// one a hand-written copy would drop, because without it the compiler emits the
/// state-machine lowering and the program still prints a plausible transcript.
fn build_script() -> Vec<String> {
    let manifest = example_dir().join("package.json");
    let text = std::fs::read_to_string(&manifest)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", manifest.display()));
    // `"build": "node ../../scripts/tensionscript.mjs game.ts -o build/game.wasm …"`
    let key = "\"build\":";
    let start = text
        .find(key)
        .unwrap_or_else(|| panic!("{} has no `build` script", manifest.display()))
        + key.len();
    let rest = &text[start..];
    let open = rest.find('"').expect("the build script is a JSON string");
    let close = rest[open + 1..]
        .find('"')
        .expect("the build script is a closed JSON string");
    let line = &rest[open + 1..open + 1 + close];
    // The script is written for a shell; split on whitespace, which is what its
    // simple `node <script> <args…>` form allows and what the flags contain.
    line.split_whitespace().map(str::to_string).collect()
}

/// The guest, built if it is missing or older than its source.
fn built_guest() -> PathBuf {
    let dir = example_dir();
    let guest = dir.join("build").join("game.wasm");
    let source = dir.join("game.ts");
    let stale = match (std::fs::metadata(&guest), std::fs::metadata(&source)) {
        (Ok(out), Ok(src)) => match (out.modified(), src.modified()) {
            (Ok(out), Ok(src)) => out < src,
            _ => false,
        },
        _ => true,
    };
    if !stale {
        return guest;
    }

    let parts = build_script();
    let (program, args) = parts
        .split_first()
        .expect("the build script is not empty");
    // `node` first in the script: the compiler is the repository's one entry
    // point, `scripts/tensionscript.mjs`, which resolves and proves the pin.
    let status = Command::new(program)
        .args(args)
        .current_dir(&dir)
        .status()
        .unwrap_or_else(|error| {
            support_ci::skip_or_fail(format_args!(
                "async_on_main: could not run `{program}` to build {}: {error}",
                guest.display()
            ));
            panic!("unreachable: skip_or_fail panics by default")
        });
    if !status.success() {
        support_ci::skip_or_fail(format_args!(
            "async_on_main: `{}` failed ({status}); the guest is not built",
            parts.join(" ")
        ));
    }
    if !guest.exists() {
        support_ci::skip_or_fail(format_args!(
            "async_on_main: the build reported success but {} does not exist",
            guest.display()
        ));
    }
    guest
}

/// The guest's lines, in order, with the host's own log lines removed.
fn transcript(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim_end)
        // The host logs to stderr, but a `--log-file` default or a future
        // framing change must not be able to pass as a transcript line.
        .filter(|line| !line.is_empty() && !line.starts_with("20"))
        .map(str::to_string)
        .collect()
}

#[test]
fn a_three_deep_chain_and_a_loop_suspend_on_main() {
    let guest = built_guest();
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(&guest)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the guest failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(8).collect::<Vec<_>>().join("\n")
    );

    let lines = transcript(&stdout);
    let at = |needle: &str| {
        lines
            .iter()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("no line containing {needle:?}\ntranscript:\n{stdout}"))
    };

    // 1. Ordering, at the granularity the suspension makes visible: the call
    //    site's pre-await line, then every body in the chain, then the resolved
    //    value. A lowering that ran the callee eagerly would print the bodies
    //    before "before await"; one that resumed the caller early would print
    //    "after await" before "outer: after await mid".
    let order = [
        "main: begin",
        "main: before await outer(1)",
        "    outer: runs, x=1",
        "    mid: runs, x=1",
        "    base: runs",
        "    mid: after await base, b=7",
        "    outer: after await mid, m=8",
        "main: after await outer(1)",
        "main: total before the loop=16",
    ];
    let mut previous = 0;
    for needle in order {
        let here = at(needle);
        assert!(
            here >= previous,
            "the transcript is out of order at {needle:?} (line {here}, after {previous})\n{stdout}"
        );
        previous = here;
    }

    // 2. A call runs nothing, and every body ran only after the park.
    assert!(
        lines
            .iter()
            .any(|line| line.contains("main: before await outer(1) — bodies run=0")),
        "the callee's bodies ran before the await\n{stdout}"
    );
    assert!(
        lines
            .iter()
            .any(|line| line.contains("main: after await outer(1) — bodies run=3, a=16")),
        "the chain did not run exactly three bodies across the await, or the value is wrong\n{stdout}"
    );

    // 3. Lifted locals: `total` accumulates across three suspensions instead of
    //    being re-initialised by each resume.
    for (iteration, total) in [(0, 23), (1, 40), (2, 67)] {
        let expected = format!("main: loop i={iteration} total={total}");
        assert!(
            lines.iter().any(|line| line == &expected),
            "no {expected:?} — a lifted local did not survive the loop's suspensions\n{stdout}"
        );
    }

    // 4. The loop ran exactly three times: one pre-await line per iteration and
    //    no fourth.
    for iteration in 0..3 {
        let expected = format!("main: loop i={iteration} before await");
        assert_eq!(
            lines.iter().filter(|line| line == &&expected).count(),
            1,
            "iteration {iteration} did not suspend exactly once\n{stdout}"
        );
    }
    assert!(
        !lines.iter().any(|line| line.contains("main: loop i=3")),
        "the loop ran more than three times\n{stdout}"
    );
    assert_eq!(
        lines.last().map(String::as_str),
        Some("main: done, total=67"),
        "the last line is not the loop's final value\n{stdout}"
    );
}
