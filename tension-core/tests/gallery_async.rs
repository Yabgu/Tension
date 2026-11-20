//! Main's step policy, and the fallback loop it runs.
//!
//! Two programs, both on one store with no threads, both asserting something the
//! design promises and nothing else tests:
//!
//! | program | question |
//! |---|---|
//! | `async/main-policy.ts` | can a program replace **main's** default step? |
//! | `async/fallback-loop.ts` | what actually runs when `main` suspends? |
//!
//! Both print `tag: value` lines; this file parses them and compares numbers.
//! Prose lines are ignored — a check that matched wording would break the first
//! time someone improved a comment.

#[path = "support/programs.rs"]
mod support_programs;

use std::collections::BTreeMap;
use std::process::Command;

use support_programs::guest;

/// `tag: value` lines, as a map. Prose lines are dropped.
fn tags(stdout: &str) -> BTreeMap<String, Vec<i64>> {
    let mut map: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for line in stdout.lines() {
        let Some((tag, value)) = line.trim().split_once(": ") else {
            continue;
        };
        let Ok(number) = value.trim().parse::<i64>() else {
            continue;
        };
        map.entry(tag.trim().to_string()).or_default().push(number);
    }
    map
}

fn run(name: &str) -> BTreeMap<String, Vec<i64>> {
    let program = guest(name);
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(&program)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{name} failed (exit {:?})\nstdout:\n{stdout}\nstderr:\n{}",
        output.status.code(),
        stderr.lines().rev().take(12).collect::<Vec<_>>().join("\n")
    );
    tags(&stdout)
}

fn one(tags: &BTreeMap<String, Vec<i64>>, tag: &str) -> i64 {
    *tags
        .get(tag)
        .unwrap_or_else(|| panic!("no `{tag}: <number>` line; saw {:?}", tags.keys().collect::<Vec<_>>()))
        .first()
        .expect("a tag line carries one value")
}

/// A program's own `mainStep` replaces the shell's default for main.
///
/// The step counts its own invocations, so `installed` distinguishes "the shell
/// took our step" from "the shell kept `__mainStep__` and happened to work": if
/// the override had not been installed, the counter would never move and
/// `installed` would be 0.
#[test]
fn a_program_can_replace_mains_step() {
    let tags = run("main-policy");
    assert_eq!(
        one(&tags, "installed"),
        1,
        "the program's mainStep was not installed: {tags:?}"
    );
    assert!(
        one(&tags, "steps") > 0,
        "the installed step never ran: {tags:?}"
    );
    assert_eq!(one(&tags, "value"), 30, "1*10 + 2*10: {tags:?}");
}

/// A suspension yields to the executor's step, and the loop keeps turning.
///
/// Each suspension is marked with the iteration it was observed on. Strictly
/// increasing marks prove the loop came back around between them; `iterations`
/// being at least the suspension count proves the loop did not stop early. Fewer
/// iterations than suspensions would mean a task never resumed; a huge number
/// would mean the step spun without draining.
#[test]
fn a_suspension_falls_back_into_the_executor_loop() {
    let tags = run("fallback-loop");
    let marks: Vec<i64> = ["after a", "after b", "after c"]
        .iter()
        .map(|tag| one(&tags, tag))
        .collect();
    assert!(
        marks[0] < marks[1] && marks[1] < marks[2],
        "each suspension must land on a later loop iteration, saw {marks:?}"
    );
    let iterations = one(&tags, "iterations");
    assert!(
        iterations >= 3,
        "the loop must turn at least once per suspension, saw {iterations}"
    );
    assert_eq!(one(&tags, "value"), 9, "2 + 3 + 4: {tags:?}");
}

/// A program can **own** main's scheduling, not just observe it.
///
/// `main-step-replaced.ts` never calls `__mainStep__`: it drives two ready slots
/// and then drains one request, which is the opposite order to the default. Both
/// counters are its own, so a green run says the shell ran *its* step.
#[test]
fn a_program_can_own_mains_scheduling_outright() {
    let tags = run("main-step-replaced");
    assert!(
        one(&tags, "iterations") > 0,
        "the replacement step never ran: {tags:?}"
    );
    // `main` prints from **inside** `driveReady`, so the last iteration is still
    // in progress when the transcript is taken: `drains` may be one behind.
    // Measured: iterations 4, drains 3. That is the loop, not a bug — and it is
    // worth pinning, because a step that drained *before* driving would print
    // equal counts and mean something else.
    let iterations = one(&tags, "iterations");
    let drains = one(&tags, "drains");
    assert!(
        drains >= 1 && (drains == iterations || drains + 1 == iterations),
        "one drain per iteration, minus the one still in progress: iterations {iterations}, drains {drains}"
    );
    assert_eq!(
        one(&tags, "value"),
        306,
        "101 + 102 + 103, i.e. every suspension resumed: {tags:?}"
    );
}
