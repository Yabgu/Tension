//! `tension::threads` — the cooperative-thread contract's **surface**, with no
//! mechanism behind it.
//!
//! Every verb here answers `-ENOTSUP` and does nothing else. That is the whole
//! point of the module existing now: a guest's imports resolve at instantiation
//! (`docs/backlog/threading.md` §4), so the shape of the contract can be fixed,
//! reviewed, and tested before a scheduler, a dispatcher, or a continuation
//! exists. What lands later replaces bodies, not signatures.
//!
//! # Why a stub is worth shipping
//!
//! The alternative was to write the verbs when the mechanism arrives, and the
//! recorded cost of that is in this tree: `tension::dev` was designed and built
//! in the same slice, so its first guest-facing shape had no review between the
//! sketch and the run. A stub inverts that. `-ENOTSUP` is a lie only if nothing
//! ever returns it, and `tests/threads_stub.rs` is a guest that calls all six and
//! traps unless each one answers it — so the surface is exercised on every gate
//! run, not merely compiled.
//!
//! # The two errno classes
//!
//! `-ENOTSUP` (**-95**) is this module's answer, and it means "this build does
//! not carry the mechanism yet" — the same code, and the same meaning, the 2D
//! adapter uses for "a preset this build does not carry".
//!
//! `-ENOSYS` (**-38**) is *reserved for the parallel half* and deliberately not
//! returned by anything here. The distinction the backlog draws is real — a
//! guest branching on the number should be able to tell "not yet" from "this
//! build never will" — but no verb in this surface can even ask for a parallel
//! context, so a code no path returns would be a code that lies about being
//! reachable. When a parallel spawn exists, it answers -ENOSYS until
//! shared-everything-threads lands, and this paragraph is the place that says so.
//!
//! # Cancel semantics, fixed now
//!
//! The cooperative contract's cancellation is **not** a flag a guest polls and
//! is **not** "cancel and resume". It is: throw an exception into the suspended
//! continuation with `resume_throw`; a handler inside the guest decides; if
//! there is no handler (or the guest chooses not to recover) **the store is
//! discarded**. wasmtime enforces the last half itself — a consumed continuation
//! traps with "continuation already consumed", measured in
//! `tests/stack_switching.rs`, so a contract that wanted to resume a cancelled
//! thread could not.
//!
//! # The run table's shape
//!
//! The registration a thread's handle will come from already exists for runs:
//! `HostState::runs` is `HashMap<i32, GuestRun>` with a `next_run_id` counter
//! (`sandbox.rs`). The contract's target shape is
//! `HashMap<CtxHandle, GuestContext>`, where the key names *any* context — a
//! run, a continuation-owning task — and the value names which kind it is.
//!
//! Neither the key type nor the value type changes in this commit, and that is a
//! decision rather than an omission: with no mechanism writing to the table, a
//! rename is churn that would hide the stub in review, and a `GuestContext`
//! invented before the scheduler decides it is a design decision the backlog
//! deliberately withholds (§5). `threads::CtxHandle` exists in the library
//! (`src/threads/mod.rs`) as the wire vocabulary those verbs already speak, so
//! the rename is available the day the mechanism lands.

use wasmtime::{Caller, Linker};

use crate::HostState;

/// "This build does not carry the mechanism yet."
///
/// The same `-ENOTSUP` the 2D adapter answers for a preset it does not carry, and
/// the same number: whatever a guest does with it, it does with one meaning.
pub(crate) const ENOTSUP: i32 = -95;

/// Register the `tension::threads` verbs.
///
/// Registered for **every** guest, root and nested alike, the way `tension::dev`
/// and `tension::io` are: a guest's imports have to resolve at instantiation, and
/// a capability that appears only once something uses it is a capability a
/// guest cannot link against.
pub fn link_threads(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    // self() -> CtxHandle | -errno
    linker.func_wrap("tension::threads", "self", |_: Caller<'_, HostState>| -> i32 {
        ENOTSUP
    })?;

    // context_of(handle) -> CtxHandle | -errno
    linker.func_wrap(
        "tension::threads",
        "context_of",
        |_: Caller<'_, HostState>, _handle: i32| -> i32 { ENOTSUP },
    )?;

    // spawn(entry, arg) -> CtxHandle | -errno
    linker.func_wrap(
        "tension::threads",
        "spawn",
        |_: Caller<'_, HostState>, _entry: i32, _arg: i32| -> i32 { ENOTSUP },
    )?;

    // join(ctx, timeout) -> 0 joined | -errno
    linker.func_wrap(
        "tension::threads",
        "join",
        |_: Caller<'_, HostState>, _ctx: i32, _timeout: i32| -> i32 { ENOTSUP },
    )?;

    // post(ctx, msg) -> 0 queued | -errno
    linker.func_wrap(
        "tension::threads",
        "post",
        |_: Caller<'_, HostState>, _ctx: i32, _msg: i32| -> i32 { ENOTSUP },
    )?;

    // await_task(task, timeout) -> status | -errno
    linker.func_wrap(
        "tension::threads",
        "await_task",
        |_: Caller<'_, HostState>, _task: i32, _timeout: i32| -> i32 { ENOTSUP },
    )?;

    Ok(())
}
