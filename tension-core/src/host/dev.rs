//! `tension::dev` — a guest that runs another guest.
//!
//! # What this namespace is for
//!
//! The editor compiles the user's game and runs it inside its own viewport; the
//! docs viewer compiles a snippet and runs it on demand. Both are one guest
//! asking the host to stand up another. That is the whole namespace: `run` opens
//! a sandboxed guest and calls its entrypoint, `out` hands back what it printed,
//! `stop` gives up on it. The record path (`frame`, `read`) is slice 4 and is
//! deliberately absent — see "What is not here" below.
//!
//! # The model: synchronous, and honest about it
//!
//! `dev.run` **runs the guest to completion before it returns.** A nested guest
//! is `!Send` (`sandbox.rs`, `GuestState`) and there is no background thread, so
//! "start a run" and "wait for it" are the same call. That is enough for the docs
//! caller, which wants a snippet's output, and it is what the acceptance tests
//! exercise.
//!
//! It is **not** Play Mode. A game that never returns would block the editor's
//! frame, and a run that has to be watched frame by frame needs `dev.frame`,
//! which needs the record path, which is slice 4. The distinction is stated here
//! because the verb names (`run`, `stop`) suggest an asynchronous model that this
//! slice does not implement: `stop` today means "discard a finished run's
//! retained state", not "interrupt a running one".
//!
//! # What is not here, and why
//!
//! * **`read`.** It is the record-copy verb, and records come from `dev.frame`.
//!   Registered now it could only ever answer "no records", which is the
//!   "a flag that is accepted and does nothing" failure this tree refuses
//!   everywhere else — an ABI slot that lies is worse than an ABI slot that does
//!   not exist yet. It lands with `frame` in slice 4, with the whole-frame
//!   `-ENOSPC` rule already pinned.
//! * **`compile`.** Pass 3, and it needs the compiler as a capability rather than
//!   a shell-out; the module cache it will fill is already here
//!   (`host/module_cache.rs`).
//! * **Input ownership.** Slice 5. A nested guest's `InputBridge` says "not mine"
//!   and nothing can change that yet.
//!
//! # Errors, and what they mean
//!
//! | errno | when |
//! | --- | --- |
//! | `-EINVAL` | a malformed path (empty, or not UTF-8) |
//! | `-EACCES` | a relative path with no write root to resolve it under |
//! | `-ENOENT` | no such wasm file |
//! | `-ELOOP` | this run would be the fifth guest deep |
//! | `-EBADF` | an unknown run id |
//! | `-ENOSPC` | the caller's buffer is smaller than the output |
//!
//! `-ELOOP` is the one that matters beyond its own call: nesting is bounded
//! because a guest that can spawn a guest that can spawn a guest is a fork bomb
//! with extra steps.

use std::sync::Arc;

use wasmtime::{Caller, Linker};

use crate::host::HostConfig;
use crate::logging::{self, Level};
use crate::sandbox::{GuestRun, RunKind, Sandbox, MAX_DEPTH};
#[cfg(test)]
use crate::sandbox::MemoryBudget;
use crate::HostState;

/// Too many levels of nesting.
const ELOOP: i32 = -40;
const EINVAL: i32 = -22;
const EACCES: i32 = -13;
const ENOENT: i32 = -2;
const EBADF: i32 = -9;
const ENOSPC: i32 = -28;
/// A guest trapped while being driven.
const EFAULT: i32 = -14;

/// `run` flags. **Not exhaustive**: `RUN_SURFACE` is reserved for the
/// texture-rendering path (`docs/backlog/buffer-rendering.md`), which is a later
/// pass. A caller that passes an unknown flag is refused rather than having it
/// ignored, and a later value is an addition rather than a contradiction.
pub(crate) const RUN_BATCH: i32 = 1 << 0;
/// Ask to be driven frame by frame. Refused unless the guest exports
/// `_game_running` (see [`crate::sandbox::RunKind`]).
pub(crate) const RUN_RENDERING: i32 = 1 << 1;

/// The memory a sandboxed run gets by default. **PROVISIONAL**, like the tick and
/// the depth cap: 64 MiB is generous for a 2D game and small enough that a fork
/// bomb hits a wall quickly.
const DEFAULT_BUDGET: usize = 64 * 1024 * 1024;

/// Register the `tension::dev` verbs.
///
/// Registered for **every** guest, the process's own included: the editor is the
/// guest that calls these, and a nested guest may also (bounded by [`MAX_DEPTH`]).
pub fn link_dev(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    // run(path_ptr, path_len, flags) -> run_id | -errno
    linker.func_wrap(
        "tension::dev",
        "run",
        |mut caller: Caller<'_, HostState>, ptr: i32, len: i32, flags: i32| -> i32 {
            let path = match guest_path(&mut caller, ptr, len) {
                Ok(path) => path,
                Err(errno) => return errno,
            };

            // The kind has to be exactly one of the two, or the caller has not
            // said what it wants and the run would have to guess.
            let kind = match flags {
                RUN_BATCH => RunKind::Batch,
                RUN_RENDERING => RunKind::Rendering,
                other => {
                    logging::log(
                        Level::Warn,
                        "dev",
                        &format!("run refused: flags {other:#x} name no single kind"),
                    );
                    return EINVAL;
                }
            };

            let state = caller.data();
            // Depth is checked **before** anything is built: refusing after a
            // module load would make the bound cost a compile.
            let depth = state.guest_depth + 1;
            if depth > MAX_DEPTH {
                logging::log(
                    Level::Warn,
                    "dev",
                    &format!("run refused: nesting depth {depth} exceeds {MAX_DEPTH} (-ELOOP)"),
                );
                return ELOOP;
            }

            let resolved = match resolve_path(state, &path) {
                Ok(path) => path,
                Err(errno) => {
                    logging::log(Level::Warn, "dev", &format!("run refused: {path} ({errno})"));
                    return errno;
                }
            };

            // Built from the store's own handles rather than from a saved
            // `HostConfig`: the verb closure has the store, and these are the
            // only two pieces of the configuration it needs that are not already
            // in `HostState` (`res`, `write_root`, `args` are).
            let config = HostConfig {
                module_cache: Arc::clone(&state.module_cache),
                engine: state.engine.clone(),
                // A nested guest gets no arguments. Its argv is the outer
                // guest's convenience, and handing them over would make a
                // nested run's behaviour depend on flags it never saw.
                args: Vec::new(),
                guest_path: resolved,
                res: Arc::clone(&state.res),
                write_root: state.write_root.clone(),
                // No capability adapters: this slice links the core verbs only.
                // A nested guest that needs OGRE or input is slice 5's problem,
                // and it is on the singleton list for a reason.
                capabilities: Vec::new(),
                session_open: false,
                session_callbacks: None,
                post_test_events: false,
            };

            let mut sandbox = match Sandbox::open(&config, state.guest_depth) {
                Ok(sandbox) => sandbox,
                Err(error) => {
                    logging::log(Level::Warn, "dev", &format!("run refused: {error:#}"));
                    return EINVAL;
                }
            };
            sandbox.guest_mut().budget(DEFAULT_BUDGET);

            // Entry, then the kind check. A `Rendering` declaration on a module
            // with no `_game_running` is refused **here**, before it occupies a
            // run id, so a caller never gets back a handle to a run that cannot
            // be driven.
            let started = match kind {
                // A batch run is "entry, then done", which is `run_batch`; going
                // through it keeps one definition of that lifetime rather than a
                // second `start` call site with the same meaning.
                RunKind::Batch => sandbox.run_batch().map(|_| ()),
                RunKind::Rendering => sandbox.start(kind),
            };
            if let Err(error) = &started {
                let message = format!("{error:#}");
                let refused = message.contains("rendering run needs a guest");
                logging::log(
                    Level::Warn,
                    "dev",
                    &format!("run refused: {message}"),
                );
                return if refused { EINVAL } else { ENOENT };
            }
            let state = caller.data_mut();
            let id = state.next_run_id;
            state.next_run_id += 1;
            let out_len = sandbox.guest().out().len();
            state.runs.insert(id, GuestRun { depth, sandbox });

            // The budget is logged, not just applied: a bound nobody can observe
            // is a bound nobody can trust, and this is the line a reader checks
            // when a guest is refused for memory.
            let budget = sandbox_budget(&state.runs, id);
            logging::log(
                Level::Info,
                "dev",
                &format!(
                    "run {id}: {} at depth {depth}, {out_len} byte(s) of output, budget {}",
                    kind.as_str(),
                    budget.map_or("unlimited".to_string(), |b| format!("{b} bytes")),
                ),
            );
            id
        },
    )?;

    // stop(run_id) -> 0 | -errno
    linker.func_wrap(
        "tension::dev",
        "stop",
        |mut caller: Caller<'_, HostState>, id: i32| -> i32 {
            let state = caller.data_mut();
            match state.runs.remove(&id) {
                Some(run) => {
                    // Dropping the run drops its store and joins its watchdog.
                    // `Watchdog::drop` is what makes that a bounded operation
                    // rather than a thread left bumping an epoch.
                    logging::log(
                        Level::Info,
                        "dev",
                        &format!("stop {id}: released (depth {})", run.depth),
                    );
                    0
                }
                None => {
                    logging::log(Level::Warn, "dev", &format!("stop refused: no run {id}"));
                    EBADF
                }
            }
        },
    )?;

    // frame(run_id) -> 1 still running | 0 complete | -errno
    //
    // The completeness rule is the sandbox's (`Sandbox::frame`): a frame returns
    // only once the inner guest presented, so a mid-frame yield cannot hand back
    // a torn frame.
    linker.func_wrap(
        "tension::dev",
        "frame",
        |mut caller: Caller<'_, HostState>, id: i32| -> i32 {
            let state = caller.data_mut();
            let Some(run) = state.runs.get_mut(&id) else {
                return EBADF;
            };
            match run.sandbox.frame() {
                Ok(true) => 1,
                Ok(false) => 0,
                Err(error) => {
                    // A trap is reported, and the run stays in the registry: the
                    // records it built before trapping are real.
                    logging::log(Level::Error, "dev", &format!("frame {id} failed: {error:#}"));
                    EFAULT
                }
            }
        },
    )?;

    // read(run_id, ptr, cap) -> byte length (cap <= 0, a probe) | bytes written | -errno
    //
    // Probe-then-fill for the *length*, whole-frame refusal for the fill: the
    // same pair `out` uses, with the same reason. A partial frame is worse than
    // no frame — it draws the first half of a scene and looks like a renderer
    // bug.
    linker.func_wrap(
        "tension::dev",
        "read",
        |mut caller: Caller<'_, HostState>, id: i32, ptr: i32, cap: i32| -> i32 {
            let (len, records) = {
                let state = caller.data();
                let Some(run) = state.runs.get(&id) else {
                    return EBADF;
                };
                let len = run.sandbox.records_len();
                if cap <= 0 {
                    return len as i32;
                }
                if (cap as usize) < len {
                    // Whole frame or nothing.
                    return ENOSPC;
                }
                let mut out = vec![0u8; len];
                run.sandbox.records_into(&mut out);
                (len, out)
            };
            match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(memory) => {
                    let start = ptr as usize;
                    if memory.data_size(&caller) < start + len {
                        return EINVAL;
                    }
                    memory.data_mut(&mut caller)[start..start + len].copy_from_slice(&records);
                    len as i32
                }
                None => EBADF,
            }
        },
    )?;

    // out(run_id, ptr, cap) -> byte length (cap <= 0, a probe) | bytes written | -errno
    //
    // Probe-then-fill, the same shape as `res_size`/`res_read`: a guest that does
    // not know how much a run printed asks with `cap = 0` and allocates what it is
    // told. Two calls through one verb rather than two verbs, because the length
    // and the bytes must come from the same record.
    linker.func_wrap(
        "tension::dev",
        "out",
        |mut caller: Caller<'_, HostState>, id: i32, ptr: i32, cap: i32| -> i32 {
            // The length and the bytes are read in one borrow, then the borrow
            // ends before the guest's memory is written. (An earlier version
            // called `drop()` on that borrow to end it; `drop` on a reference is
            // a no-op, and only the compiler's last-use analysis made it work.)
            let (len, written) = {
                let state = caller.data();
                let Some(run) = state.runs.get(&id) else {
                    return EBADF;
                };
                let out = run.sandbox.guest().out();
                let len = out.len();
                if cap <= 0 {
                    return len as i32;
                }
                if (cap as usize) < len {
                    // Refused rather than truncated: half a guest's output,
                    // silently, is a debugging session that starts from a wrong
                    // premise.
                    return ENOSPC;
                }
                (len, out.to_vec())
            };
            match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(memory) => {
                    let start = ptr as usize;
                    if memory.data_size(&caller) < start + len {
                        return EINVAL;
                    }
                    memory.data_mut(&mut caller)[start..start + len].copy_from_slice(&written);
                    len as i32
                }
                None => EBADF,
            }
        },
    )?;

    Ok(())
}

/// The budget a run was given, for the log line above.
fn sandbox_budget(
    runs: &std::collections::HashMap<i32, GuestRun>,
    id: i32,
) -> Option<usize> {
    runs.get(&id).and_then(|run| run.sandbox.guest().budget_limit())
}

/// Read a guest string, refusing what cannot be a path.
fn guest_path(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> Result<String, i32> {
    if ptr < 0 || len <= 0 {
        return Err(EINVAL);
    }
    let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Err(EBADF);
    };
    let start = ptr as usize;
    let end = start + len as usize;
    let bytes = memory.data(&*caller);
    if end > bytes.len() {
        return Err(EINVAL);
    }
    let Ok(text) = std::str::from_utf8(&bytes[start..end]) else {
        return Err(EINVAL);
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(EINVAL);
    }
    Ok(text)
}

/// Resolve a requested guest path: absolute as given, relative under the write
/// root, and nothing else.
///
/// **Why the write root and not the process's cwd.** A guest naming a file must
/// not be able to reach anything the host would not have written there; the write
/// root is the one directory the run already declared as writable, and `res_open`
/// falls back to it for the same reason. An absolute path is taken as given
/// because the outer guest is trusted — it is the editor — and a sandboxed guest
/// that wants to escape is bounded by the same rule one level in.
fn resolve_path(state: &HostState, path: &str) -> Result<String, i32> {
    let requested = std::path::Path::new(path);
    let full = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        match &state.write_root {
            Some(root) => root.root().join(requested),
            None => return Err(EACCES),
        }
    };
    if !full.is_file() {
        return Err(ENOENT);
    }
    Ok(full.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The errno table above is a contract a guest branches on, so the numbers
    /// are asserted rather than assumed: a typo here is invisible to every other
    /// test in the tree.
    #[test]
    fn the_errnos_are_the_ones_a_guest_expects() {
        assert_eq!(ELOOP, -40);
        assert_eq!(ENOENT, -2);
        assert_eq!(EBADF, -9);
        assert_eq!(ENOSPC, -28);
        assert_eq!(EACCES, -13);
        assert_eq!(EINVAL, -22);
    }

    /// A budget that is not a whole number of pages would be silently rounded
    /// down by `MemoryBudget::of_bytes`, so the constant is asserted rather than
    /// trusted: a guest denied 64 MiB by 32 KiB is a confusing refusal.
    #[test]
    fn the_default_budget_is_a_whole_number_of_pages() {
        let budget = MemoryBudget::of_bytes(DEFAULT_BUDGET);
        assert_eq!(budget.limit(), Some(DEFAULT_BUDGET));
        assert_eq!(DEFAULT_BUDGET % 65536, 0);
    }
}
