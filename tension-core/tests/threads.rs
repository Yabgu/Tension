//! The thread ABI's host half: `env.__executorCount` and `env.__startThread`.
//!
//! TensionScript's `docs/thread-abi.md` is the contract and
//! `tension-core/src/thread.rs` is this host's side of it. These four tests are
//! the observations that contract asks for, run against **real guests** — the
//! compiler's own `~lib/thread`, compiled by this repository's pinned compiler —
//! rather than against hand-written WAT. `src/thread.rs`'s unit test covers the
//! pool in isolation (a worker that writes one word); these cover the boot
//! sequence, the cross-store request, and the refusals.
//!
//! The guests live in `tests/guests/` as `.ts` plus `build.mjs`, so the ABI they
//! exercise is visible and versioned. `build.mjs` carries the flag list (and the
//! `--optimizeLevel 0` the pinned Binaryen needs — see its header).
//!
//! What each test reads:
//!
//! 1. **count** — `executors=3` for `--executors 2`, plus the carved block's own
//!    numbers, which is how the *boot order* becomes visible: a `__controlBase`
//!    of 0 would mean `__threadInit` never ran before `__start`.
//! 2. **spawn and join** — `answer=242`: the worker (id 1) doubled 21 and packed
//!    its own id into the reply, so one number proves both the crossing and the
//!    store it crossed from. `join=0` is `__threadJoin(1)`.
//! 3. **two workers, twelve tasks** — `valueSum=66` (0+…+11), `workerSum=30`
//!    (six tasks each to executors 1 and 2), `observed=12`: no value lost, none
//!    doubled, none misrouted.
//! 4. **the refusals** — `-1` for an id out of range at both ends, `0` for the
//!    first spawn of a valid id, `-2` for the second.
//!
//! Skip policy: `tests/support/ci.rs`. A missing guest is rebuilt rather than
//! skipped; a failing build fails the test, because the compiler is vendored and
//! the pin is proven.

#[path = "support/ci.rs"]
mod support_ci;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("tension-core is a directory under the repository root")
        .to_path_buf()
}

fn guests_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("guests")
}

/// Build every guest whose `.wasm` is missing or older than its `.ts`.
///
/// One recipe: `tests/guests/build.mjs`, which is also what a developer runs by
/// hand. The build line is not restated here, for the reason `async_on_main.rs`
/// gives — two copies of a flag list drift, and the flag that would go first is
/// the one the pinned optimizer needs.
fn build_guests() {
    let dir = guests_dir();
    let script = dir.join("build.mjs");
    let status = Command::new("node")
        .arg(&script)
        .current_dir(&dir)
        .status()
        .unwrap_or_else(|error| {
            support_ci::skip_or_fail(format_args!(
                "threads: could not run `node {}`: {error}",
                script.display()
            ));
            panic!("unreachable: skip_or_fail panics by default")
        });
    if !status.success() {
        support_ci::skip_or_fail(format_args!(
            "threads: `node {}` failed ({status}); the guests are not built",
            script.display()
        ));
    }
}

/// One guest's artifact, built on demand.
fn guest(name: &str) -> PathBuf {
    build_guests();
    let path = guests_dir().join("build").join(format!("{name}.wasm"));
    if !path.exists() {
        support_ci::skip_or_fail(format_args!(
            "threads: {} does not exist after the build",
            path.display()
        ));
    }
    path
}

/// Run one guest and return its `key=value` lines.
///
/// The host logs to stderr, so the guest's own lines are all that is on stdout;
/// parsing them into a map keeps the assertions about *values*, not order —
/// which is what these tests are for. Ordering is `async_on_main.rs`'s job.
fn run(name: &str, workers: usize) -> BTreeMap<String, String> {
    let guest = guest(name);
    let output = Command::new(env!("CARGO_BIN_EXE_tension-core"))
        .arg("--executors")
        .arg(workers.to_string())
        .arg(&guest)
        .output()
        .expect("the interpreter runs");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{} failed (exit {:?})\nstdout: {stdout}\nstderr: {}",
        guest.display(),
        output.status.code(),
        stderr.lines().rev().take(8).collect::<Vec<_>>().join("\n")
    );

    let mut values = BTreeMap::new();
    for line in stdout.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    values
}

fn want<'a>(values: &'a BTreeMap<String, String>, key: &str) -> &'a str {
    values
        .get(key)
        .unwrap_or_else(|| panic!("no `{key}=` line; transcript: {values:?}"))
        .as_str()
}

#[test]
fn one_executor_count_plus_the_pool() {
    let values = run("count", 2);

    // `--executors 2` is two workers; main is always there.
    assert_eq!(want(&values, "executors"), "3");

    // The boot order, as the guest sees it: the host carved the control block
    // before `__start` ran. A module that reached its entry with no carve would
    // report `0` here and find nothing from `__heap_base`.
    assert_eq!(want(&values, "controlBase"), "carved");
    assert_eq!(want(&values, "executorTotal"), "3");
    // The host's capacity (`thread_boot`'s `CAPACITY`), read back from the guest.
    assert_eq!(want(&values, "ringCapacity"), "1024");
    assert!(
        want(&values, "controlStride").parse::<i32>().unwrap_or(0) > 0,
        "the record stride is published: {values:?}"
    );
}

#[test]
fn a_worker_runs_on_its_own_store_and_joins() {
    let values = run("spawn-join", 2);

    // The `$starts` indices came from `TaskBase.entry` — a module fact, which is
    // why a store other than the one that made the task can resolve them.
    assert!(
        want(&values, "workIndex").parse::<i32>().unwrap_or(-1) >= 0,
        "the work body has a spawn entry: {values:?}"
    );
    assert!(
        want(&values, "deliverIndex").parse::<i32>().unwrap_or(-1) >= 0,
        "the reply body has a spawn entry: {values:?}"
    );

    assert_eq!(want(&values, "spawn"), "0", "the host accepted the spawn");
    // 21 doubled in a store whose id is 1, packed as (1 + 1) * 100 + 42.
    assert_eq!(want(&values, "answer"), "242");
    // The request's origin word, as main served it: the worker's id.
    assert_eq!(want(&values, "replyOrigin"), "1");
    assert_eq!(want(&values, "join"), "0", "__threadJoin saw the exit");
}

#[test]
fn two_workers_observe_every_value_exactly_once() {
    let values = run("two-workers", 2);

    assert_eq!(want(&values, "spawn1"), "0");
    assert_eq!(want(&values, "spawn2"), "0");

    // Twelve tasks, values 0..11: a lost reply shortens the count, a doubled one
    // lengthens it, and either moves the sum.
    assert_eq!(want(&values, "observed"), "12");
    assert_eq!(want(&values, "valueSum"), "66");
    // Executor 1 served the six even values and executor 2 the six odd ones, and
    // the reply packs `self + 1` — so 6*2 + 6*3.
    assert_eq!(want(&values, "workerSum"), "30");

    assert_eq!(want(&values, "join1"), "0");
    assert_eq!(want(&values, "join2"), "0");
}

#[test]
fn the_contracts_refusals_are_values() {
    let values = run("spawn-refusals", 2);

    // Ids are `1..executorTotal`; main is 0 and is never a spawn target.
    assert_eq!(want(&values, "spawnMain"), "-1", "main cannot be spawned");
    assert_eq!(
        want(&values, "spawnPastEnd"),
        "-1",
        "the count is 3, so 3 is past the end"
    );
    assert_eq!(want(&values, "spawnFirst"), "0");
    assert_eq!(
        want(&values, "spawnAgain"),
        "-2",
        "a live id is refused, not started twice"
    );
    assert_eq!(want(&values, "join"), "0");
}

/// A guest that imports a **shared** memory and prints: the case that found
/// `Extern::into_memory()` answering `None` for a `SharedMemory`.
///
/// It is not a thread test as such, it is the *transport* under three of them —
/// every test above prints from a shared-memory guest — but it is cheap and it
/// names the failure directly: without `tension_core::thread::GuestMemory`, this
/// guest panics the host in `tension::io print` with "game must export a memory
/// named 'memory'" while the export is right there.
#[test]
fn a_shared_memory_guest_can_print() {
    let values = run("count", 0);
    // With no workers configured, main is the whole pool.
    assert_eq!(want(&values, "executors"), "1");
}
