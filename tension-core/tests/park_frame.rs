//! **`await` on a producer handle is a park, and the frame clock answers it** (DL56, I103).
//!
//! The defect this guards: `await rt.frame()` compiled to *the operand*, because the
//! lowering's rule is "if the operand isn't a task the lowering built, `await` is the
//! operand". A handle is a `Task<T>` with a stamped record and no body, so the inline path
//! ran an empty `drive()` and the awaited value came back `0`. The guest looped, the host
//! saw no park, and the artifact imported no `scheduler::park` — measured, before the fix,
//! as a whole program completing in one host pass.
//!
//! Three assertions, and they are three different questions:
//!
//! 1. **The park is in the artifact.** A fiber build that awaits a handle must import
//!    `scheduler::park`. A transcript alone cannot tell a park from a fast yield, so the
//!    import is the claim that the guest *can* suspend at all.
//! 2. **The guest resumes with the host's value, not a zero it was handed for free.** The
//!    transcript is `probe/park-frame.expected.txt`: two parks, two resumes, `done`.
//! 3. **One resume per post, in the same host pass.** `TENSION_ITERATIONS=1` makes the host
//!    print its pass number at each post and each resume; a resume in a *later* pass than
//!    its post is polling, which is the user's "seems like polling" report stated as a
//!    property. The iteration parsed out of the two lines must be equal.
//!
//! The probe opens no session and exports no `_game_running`: what is under test is the
//! park, and a host-driven guest would have to export `__taskWake` as well for a loop this
//! one does not need.

#[path = "support/programs.rs"]
mod support_programs;

use std::process::Command;

use support_programs::{fiber_fixtures_dir, guest_or_fixture, programs_dir};

fn transcript(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// The probe's artifact: built when this checkout has a compiler, the committed fixture
/// when it does not (`fixtures/fiber/park-frame.wasm`).
///
/// **Committed for the same reason the other fiber artifacts are**: CI has no compiler, and
/// a gate that only runs on a machine with one is not the gate this round needs. The
/// fixture is the artifact *under test* — the park import and the transcript are what it
/// must produce — so pinning it is the assertion, not a shortcut around one.
fn probe() -> std::path::PathBuf {
    guest_or_fixture("park-frame", fiber_fixtures_dir())
}

/// The `iteration=` number on a log line, whatever the rest of it says.
fn iteration_of(line: &str) -> u64 {
    let at = line
        .split("iteration=")
        .nth(1)
        .unwrap_or_else(|| panic!("a post/resume line must carry its iteration: {line}"));
    at.split(|c: char| !c.is_ascii_digit())
        .next()
        .and_then(|digits| digits.parse().ok())
        .unwrap_or_else(|| panic!("unreadable iteration in: {line}"))
}

#[test]
fn a_handle_await_imports_the_park() {
    let bytes = std::fs::read(probe())
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", probe().display()));
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("scheduler") && text.contains("park"),
        "a fiber artifact that awaits a handle must import `scheduler::park`; without it \
         the awaited value is the field default and nothing suspends"
    );
}

#[test]
fn the_frame_clock_posts_and_the_guest_resumes_once_per_post() {
    let path = programs_dir().join("probe/park-frame.expected.txt");
    let expected_text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display()));
    let expected = transcript(&expected_text);
    assert!(!expected.is_empty(), "the expected transcript must not be empty");

    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .env("TENSION_ITERATIONS", "1")
        .arg(probe())
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);

    // A guest whose handle await never parks strands, and the run fails — so a greens
    // status is already the first half of the claim.
    assert!(
        output.status.success(),
        "the probe must run to completion; a park with nothing to answer it is the DL56 \
         defect.\nstderr:\n{stderr}"
    );
    assert_eq!(
        transcript(&stdout),
        expected,
        "the probe's transcript differs — the guest did not park twice and resume twice\
         \nstderr:\n{stderr}"
    );

    // **One resume per post, in the same pass.** The host prints `post frame to task … at
    // … iteration=N` and `resume [ids] at … iteration=N`; a resume whose N differs from its
    // post's N means the body ran a tick late, which is polling.
    let posts: Vec<u64> = stderr
        .lines()
        .filter(|line| line.contains("post frame to task"))
        .map(iteration_of)
        .collect();
    let resumes: Vec<u64> = stderr
        .lines()
        .filter(|line| line.contains("resume ["))
        .map(iteration_of)
        .collect();
    assert_eq!(posts.len(), 2, "two frame parks, two posts; got {posts:?}\nstderr:\n{stderr}");
    assert_eq!(
        resumes.len(),
        2,
        "exactly one resume per post; got {resumes:?}\nstderr:\n{stderr}"
    );
    assert_eq!(
        posts, resumes,
        "each resume must happen in the pass that posted for it — a later pass is polling"
    );
}
