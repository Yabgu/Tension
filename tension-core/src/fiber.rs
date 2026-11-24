//! The fiber executor: **one suspended stackful task per OS thread**.
//!
//! # Why a fiber, and why this is not a second `thread.rs`
//!
//! A stackful guest's suspension has two possible expressions, and the compiler
//! records which one an artifact uses (`tension.stackful-backend`, DL35):
//!
//! - `continuation` — wasm `suspend`. The executor resumes a continuation out of
//!   a table. This is the default and it is what every existing guest does.
//! - `fiber` — a call to the host's `scheduler::park`. There is no `suspend`
//!   instruction anywhere in the module, so **running it needs no continuation
//!   table and the engine never executes a suspension**.
//!
//! That last sentence is deliberately narrower than it was when this round
//! started, because the wider one was measured false: a fiber artifact **still
//! declares the shell's continuation types and tags** (two `cont` types, three
//! tags in `tests/programs/fixtures/fiber/i70-fiber.wasm`), and an engine with
//! `wasm_stack_switching` off refuses to *parse* those — "cannot define
//! continuation types when stack switching is disabled". So the mechanism is
//! fiber-only and the type section is not: a stackful guest still cannot load on
//! the Windows target (I16), and dropping the unused types is a lowering change
//! this round did not make (I85). What *is* true — and what `tests/fiber-runner.rs`
//! asserts — is that the run's suspension is the host's, one suspended fiber per
//! OS thread, with no `suspend` in the artifact at all.
//!
//! The suspension then lives here. `scheduler::park` calls [`suspend_current`],
//! which hands control back to the loop below; the loop decides what the task is
//! waiting for and resumes it. The guest's stack, its locals and its position are
//! preserved by the fiber itself — a fibre's whole job is that the wasm call
//! returns to exactly where it stopped.
//!
//! # The ceiling is the OS thread, and it is measured
//!
//! One suspended fiber per thread, **not** one per store (DL24): wasmtime keeps
//! its `CallThreadState` in a thread-local LIFO, so a second fiber parked on the
//! same thread makes the first one's resume trip an assertion inside the engine
//! (`core::ptr::eq(head, self)`). A pool is therefore one thread per parked task;
//! promise tasks ride along on any of them. No migration, no cross-thread
//! hand-off — `Suspend` is `!Send` and resuming on another thread runs the guest's
//! continuation and then trips the same assertion (DL24 Q4).
//!
//! # Shutdown: resume or refuse, and the refusal is named
//!
//! A suspended fiber **cannot be dropped** (`debug_assert!(self.done.get())` in
//! the crate's `lib.rs`), so a task that is never woken leaks its stack. The
//! alternative — forgetting it silently — is what leaves a run hanging with no
//! output or exiting 0 having done nothing, which is the failure mode this
//! module's [`Outcome::Stranded`] exists to name. Leak and name is the choice;
//! the leak is one stack (512 KiB by default) at the end of a run by definition.

use std::cell::Cell;

use wasmtime::{Instance, Store};
use wasmtime_internal_fiber::{Fiber, FiberStack, Suspend};

/// The custom section a stackful build records its backend in.
///
/// **Absence means `continuation`**, and that is a stated default rather than an
/// inference: it is how every artifact built before the record existed says
/// `continuation` without growing four bytes to say it (`src/compiler.ts` in the
/// compiler tree). See [`Backend::of`].
pub const BACKEND_SECTION: &[u8] = b"tension.stackful-backend";

/// Which backend a guest was **built for**, and which one is **running** it.
///
/// One type for both sides of the comparison, because the refusal is the same
/// sentence in both directions with the two names swapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// wasm `suspend`, resumed out of a continuation table.
    Continuation,
    /// A call to `scheduler::park`, suspended on a fiber.
    Fiber,
}

impl Backend {
    /// The word the artifact carries, and the word the refusal uses.
    pub fn name(self) -> &'static str {
        match self {
            Backend::Continuation => "continuation",
            Backend::Fiber => "fiber",
        }
    }

    /// The one line printed where the host says which executor it chose.
    pub fn label(self) -> &'static str {
        match self {
            Backend::Continuation => "continuation (wasm suspend, resumed by the executor table)",
            Backend::Fiber => "fiber (scheduler::park suspends an OS thread's stack)",
        }
    }

    /// **Reads the artifact.** `fiber` when the module's record says so, and
    /// `continuation` when there is no record at all.
    ///
    /// Parsing the section list by hand rather than asking wasmtime, for one
    /// reason worth stating: wasmtime 50's `Module` API exposes no
    /// `custom_sections()`, and the bytes are already in hand at load time — this
    /// reads them in a dozen lines with no dependency and no second compile of
    /// the module. A malformed file is not a case this needs to survive: the
    /// engine has already accepted the same bytes as a module.
    pub fn of(module_bytes: &[u8]) -> Backend {
        let mut i = 8; // magic + version
        while i < module_bytes.len() {
            let id = module_bytes[i];
            i += 1;
            let Some((size, next)) = leb(module_bytes, i) else { break };
            let end = (next + size).min(module_bytes.len());
            if id == 0 {
                if let Some((name_len, after)) = leb(module_bytes, next) {
                    let name_end = (after + name_len).min(end);
                    if &module_bytes[after..name_end] == BACKEND_SECTION {
                        let payload = &module_bytes[name_end..end];
                        return if payload == b"fiber" {
                            Backend::Fiber
                        } else {
                            Backend::Continuation
                        };
                    }
                }
            }
            i = end;
        }
        Backend::Continuation
    }
}

/// One unsigned LEB128 value at `at`, or `None` when the bytes run out.
fn leb(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    let mut value = 0usize;
    let mut shift = 0u32;
    let mut i = at;
    while i < bytes.len() {
        let byte = bytes[i];
        i += 1;
        value |= ((byte & 0x7f) as usize).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some((value, i));
        }
        shift = shift.checked_add(7)?;
    }
    None
}

/// A guest built for one backend, paired with an executor of the other.
///
/// **Both names, in one sentence, in both directions.** A refusal that named only
/// the guest would send a reader looking for a flag that is not the problem, and
/// one that named only the executor would leave the artifact's own claim out of
/// the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mismatch {
    /// What `tension.stackful-backend` says (or its absence).
    pub guest: Backend,
    /// What this process is running.
    pub executor: Backend,
}

impl std::fmt::Display for Mismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "this guest was built for the `{}` backend and this executor is the `{}` backend — \
             refusing by name, nothing was run",
            self.guest.name(),
            self.executor.name()
        )
    }
}

impl std::error::Error for Mismatch {}

/// What a fiber task suspended on: the contract's `(class, key)` pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Park {
    /// The guest's task id — its slot index, the id `scheduler::park` was given.
    pub task: u64,
    /// The completion class the task waits for.
    pub class: u32,
    /// The completion key the task waits for.
    pub key: u32,
}

/// A task the executor stopped for: it parked and nothing was posted for it.
///
/// The existing vocabulary, kept: a strand is a park the run could not resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stranded {
    pub park: Park,
}

impl std::fmt::Display for Stranded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "task {} parked on class {} key {} and no completion arrived",
            self.park.task, self.park.class, self.park.key
        )
    }
}

/// How a fiber task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The guest returned from its call with this status.
    Done(i32),
    /// It parked and the producer had nothing for it. **Never a hang and never a
    /// zero exit**: the caller reports it and fails the run.
    Stranded(Stranded),
}

// ---------------------------------------------------------------------------
// The suspend handle, published for exactly one wasm call (DL24's mechanism)
// ---------------------------------------------------------------------------

thread_local! {
    /// The `&mut Suspend` of the fiber running on this thread, or null.
    ///
    /// **A thread-local and not a parameter**, because `scheduler::park` is a
    /// host function whose signature the artifact fixes (`void(i64,i32,i32)`) —
    /// there is nowhere in it to pass a handle. It is published by the fiber
    /// closure immediately before the wasm call and cleared immediately after, so
    /// the window in which it is set is exactly the call that may suspend.
    static SUSPEND: Cell<*mut ()> = const { Cell::new(std::ptr::null_mut()) };

    /// The value the wake delivered, for `scheduler::completion` to answer.
    ///
    /// Set by [`run`] immediately before it resumes a fiber, and read by the
    /// guest's next `scheduler::completion(task_id)` call, which the compiler puts
    /// directly after the park returns. One word, on the thread that owns the
    /// fiber, for one resume — the same discipline as the handle above.
    static COMPLETION: Cell<i32> = const { Cell::new(0) };
}

/// **The park import's last line.** Suspends the current thread's fiber and
/// answers `true`, or answers `false` when no fiber is running — which is a host
/// bug in a fiber-mode run, not a guest event, so the caller decides what to say.
///
/// `Park` is the yield value: it travels out through the `Suspend` and is what the
/// executor's loop sees when the wasm call gives control back.
pub fn suspend_current(park: Park) -> bool {
    let handle = SUSPEND.with(|slot| slot.get());
    if handle.is_null() {
        return false;
    }
    // SAFETY: published by `run`'s fiber closure, on this fiber's own stack, and
    // valid for the whole of the wasm call that is running right now. The cast
    // restores the concrete `Suspend<(), Park, i32>` that `Fiber` was created
    // with — the one type in this module, so the pointer cannot mean anything
    // else.
    let suspend: &mut Suspend<(), Park, i32> = unsafe { &mut *(handle as *mut Suspend<(), Park, i32>) };
    let (): () = suspend.suspend(park);
    true
}

/// **What `scheduler::completion(task_id)` answers**: the payload the wake that
/// resumed this task carried, or `0` when the task did not park on a keyed pair
/// (a keyless park has no completion to carry).
///
/// `task_id` is not consulted, and that is deliberate rather than an omission: one
/// fiber is suspended at a time on this thread, so "the completion this thread
/// just delivered" is unambiguous. A second parked task on the same thread is what
/// DL24 measured to be impossible.
pub fn completion_value() -> i32 {
    COMPLETION.with(|cell| cell.get())
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/// Runs one guest call on a fiber and drives it to completion or a strand.
///
/// # What it owns, and what the caller owns
///
/// The **fiber, the suspend handle, and the loop** are here. The **call** and the
/// **producer** are the caller's: `call` is "invoke the guest's entry with this
/// store" (every host has its own idea: the binary calls `__start`, a test calls
/// its own export), and `producer` is "what does this park wait for" — the one
/// decision a host makes about its own completions.
///
/// `producer` is called **after** the guest has parked, with the park in hand. It
/// answers the payload to resume with, or `None` when nothing will ever complete
/// this park. That call order *is* the I70 ordering (park, then wake), so no test
/// has to arrange it.
///
/// `store` is borrowed for the whole run: the fiber executes on the calling
/// thread, so no `Send` bound is needed and nothing is moved between threads.
pub fn run<T, C, P>(
    store: &mut Store<T>,
    instance: Instance,
    mut call: C,
    mut producer: P,
) -> anyhow::Result<Outcome>
where
    C: FnMut(&mut Store<T>, Instance) -> anyhow::Result<i32>,
    P: FnMut(Park) -> Option<i32>,
{
    let stack = FiberStack::new(512 * 1024, true)
        .map_err(|_| anyhow::anyhow!("the fiber stack could not be allocated"))?;
    // A suspended fiber cannot be dropped, so the value is only ever *taken* out
    // on the path that finished. On the strand path it is deliberately leaked.
    let mut slot: Option<Fiber<'_, (), Park, i32>> = Some(
        Fiber::new(stack, move |(), suspend| {
            let handle = suspend as *mut _ as *mut ();
            let previous = SUSPEND.with(|cell| {
                let previous = cell.get();
                cell.set(handle);
                previous
            });
            let status = call(store, instance).unwrap_or(-1);
            SUSPEND.with(|cell| cell.set(previous));
            status
        })
        .map_err(|_| anyhow::anyhow!("the fiber could not be created"))?,
    );
    // -- first resume: run to the first park, or to completion ----------------
    let mut parked = match slot.as_ref().expect("the fiber is live").resume(()) {
        Ok(status) => {
            if let Some(fiber) = slot.take() {
                let _ = fiber.into_stack();
            }
            return Ok(Outcome::Done(status));
        }
        Err(park) => park,
    };

    // -- the loop: one resume per completion ---------------------------------
    loop {
        let Some(value) = producer(parked) else {
            // Nothing will complete this park. The fiber is still suspended and
            // cannot be dropped; leaking it is the only sound choice, and the
            // refusal below is what makes the leak visible instead of a hang.
            if let Some(fiber) = slot.take() {
                std::mem::forget(fiber);
            }
            return Ok(Outcome::Stranded(Stranded { park: parked }));
        };
        COMPLETION.with(|cell| cell.set(value));
        match slot.as_ref().expect("the fiber is live").resume(()) {
            Ok(status) => {
                if let Some(fiber) = slot.take() {
                    let _ = fiber.into_stack();
                }
                return Ok(Outcome::Done(status));
            }
            Err(next) => parked = next,
        }
    }
}
