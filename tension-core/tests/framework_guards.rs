//! The framework's guards, observed from a guest instead of a JS proxy.
//!
//! `tension-framework/tests/rt-dispatch.mjs` used to compile a probe and
//! instantiate it under a Node `Proxy` that answered every host import with
//! zeros. The state it wanted — **no session open and no task table** — is
//! reachable from a real guest, so the probe is now
//! `tests/programs/rt-guards.ts` and this file runs it through `tension-core`,
//! the host whose guards are being claimed.
//!
//! What each line asserts:
//!
//! - `start=ok` — `rt.start()` binds every completion family with no session;
//! - `job-class=4`, `job-key=7` — `rt.job(7)` returns a handle stamped with the
//!   success class (`CLASS_JOB_DONE` = 4) and the id, and allocation is inert;
//! - `job-settled=0` — nothing has delivered it;
//! - `has-runnable-before=0`, `has-runnable-after=0` — the dispatcher never
//!   claims work that does not exist;
//! - `resumed-after-park=0` — `awaitJob` parked with no table and returned
//!   without resuming (a wild region read here used to trap);
//! - `resumed-after-on-event=0` — `rt.onEvent` with no session is a no-op;
//! - `ai-dropped=-1` — a region-table read refuses without a session rather
//!   than reading address 0 as if it were a table;
//! - `guard-result=41` — the program's own verdict: 41 when every clause held,
//!   a negative number at the first that did not.
//!
//! The program imports no session, so the host creates none (`host/guest.rs`
//! scopes that to a module with a session import). That is what makes the
//! no-session state real rather than simulated.
//!
//! Skip policy: `tests/support/programs.rs`. A missing program is rebuilt; a
//! failing build or a missing artifact prints a skip only with
//! `TENSION_TEST_ALLOW_SKIP=1`.

#[path = "support/programs.rs"]
mod support_programs;

use std::collections::BTreeMap;
use std::process::Command;

use support_programs::guest;

#[test]
fn the_guards_hold_with_no_session_and_no_table() {
    let guest = guest("rt-guards");
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg(&guest)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "the guard program failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        output.status.code(),
        stderr.lines().rev().take(10).collect::<Vec<_>>().join("\n")
    );

    let mut values = BTreeMap::new();
    for line in stdout.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(": ") {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    let want = |key: &str| -> &str {
        values
            .get(key)
            .unwrap_or_else(|| panic!("no `{key}:` line; transcript: {values:?}"))
    };

    assert_eq!(want("start"), "ok", "rt.start() did not bind without a session");
    assert_eq!(want("job-class"), "4", "rt.job did not stamp the success class");
    assert_eq!(want("job-key"), "7", "rt.job did not stamp the job id");
    assert_eq!(want("job-settled"), "0", "a job handle arrived settled");
    assert_eq!(want("has-runnable-before"), "0", "the dispatcher claimed work");
    assert_eq!(
        want("resumed-after-park"),
        "0",
        "parking with no table resumed the task or delivered something"
    );
    assert_eq!(
        want("resumed-after-on-event"),
        "0",
        "rt.onEvent with no session delivered a record"
    );
    assert_eq!(
        want("ai-dropped"),
        "-1",
        "a region-table read did not refuse without a session"
    );
    assert_eq!(want("has-runnable-after"), "0", "the dispatcher claimed work");
    assert_eq!(want("guard-result"), "41", "the program's own verdict moved");
}
