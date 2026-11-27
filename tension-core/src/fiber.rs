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
//! That last sentence is measured at both ends now. The **mechanism** was always
//! fiber-only. Since DL37 the **type section** is too: a
//! `--stackful-backend=fiber` build declares no `cont` type and no tag section,
//! and asks for no continuation feature, so a stock engine — stack switching
//! off — parses it. Measured on the committed fixture
//! (`tests/programs/fixtures/fiber/i70-fiber.wasm`, built by
//! `dist/assemblyscript.js` `1065f81c4a54`): zero `0x5d` bytes in the type
//! section, zero tag sections, `tension.stackful-backend` = `fiber`. The older
//! claim that a fiber artifact "still declares the shell's continuation types
//! and tags" (two `cont` types, three tags) described the pre-DL37 lowering and
//! is no longer true of this fixture; I85 is what removed it.
//!
//! The remaining question was **this module's**, and it is answered: the executor
//! runs on the Windows target (measured there 2026-11-24). The fixture parks on
//! (class 4, key 7), the host's `--post-completion 4,7,500` answers *after* the
//! park, the task resumes and reads `value=500` — the producer's word, not a zero
//! — and the run exits 0. So a stackful guest built for this executor both loads
//! **and runs** on Windows. I16 is unchanged and narrower than it was read: it is
//! the *continuation* backend that wasmtime will not run on this target.
//!
//! The suite that asserts these five claims is `tests/fiber-runner.rs`. At this
//! HEAD its tests carry `#![cfg(target_os = "linux")]`, so on Windows it compiles
//! to zero tests; the Windows measurement above was made by invoking the binary
//! with the suite's own arguments. Un-gating it is a separate decision.
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
    /// The **promise** lowering (DL51): async functions are state machines driven by
    /// `__asyncPump`, and a suspension is a call to the host park import.
    ///
    /// It is its own backend rather than a flavour of fiber because a stackful shell needs
    /// a root to resume and a library module has none — so a module with an `await` and no
    /// exported `main` compiles **only** this way. Until DL51 it was what a build with no
    /// flags produced, which made it an unstated default; it is a named choice now, and
    /// `auto` never selects it.
    Promise,
}

impl Backend {
    /// The word the artifact carries, and the word the refusal uses.
    pub fn name(self) -> &'static str {
        match self {
            Backend::Continuation => "continuation",
            Backend::Fiber => "fiber",
            Backend::Promise => "promise",
        }
    }

    /// The one line printed where the host says which executor it chose.
    pub fn label(self) -> &'static str {
        match self {
            Backend::Continuation => "continuation (wasm suspend, resumed by the executor table)",
            Backend::Fiber => "fiber (scheduler::park suspends an OS thread's stack)",
            Backend::Promise => "promise (state machine driven by __asyncPump)",
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
        match find_custom_section(module_bytes, BACKEND_SECTION) {
            Some(payload) if payload == b"fiber" => Backend::Fiber,
            Some(payload) if payload == b"promise" => Backend::Promise,
            _ => Backend::Continuation,
        }
    }
}

/// The capability declaration a DL51+ artifact carries: what it needs of a host.
///
/// Three lines, `key=value`, no JSON — the writer is the compiler and this reader is
/// Rust with no serde in the runtime, so a parser on either side would be a second
/// thing to keep in step (`src/compiler.ts`'s `emitRequiresSection` says why).
pub const REQUIRES_SECTION: &[u8] = b"tension.requires";

/// What an artifact declares it requires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requires {
    /// The backend the artifact was lowered for.
    pub backend: Backend,
    /// The class of host it runs on.
    pub target: TargetClass,
    /// Wasm features a host must **configure before loading**. Only these: bulk memory
    /// and sign extension are universally on and cannot be refused, so listing them
    /// would be noise.
    pub features: Vec<String>,
}

/// Portable, or Linux-only, and the artifact says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetClass {
    /// One artifact for Linux, Windows and macOS (the fiber lowering).
    Portable,
    /// Needs `stack-switching`, whose feature declaration is module-wide; wasmtime
    /// refuses such a module off x86-64 Linux/macOS before it executes (I16).
    LinuxOnly,
}

impl TargetClass {
    /// The word the artifact carries, and the word a refusal uses.
    pub fn name(self) -> &'static str {
        match self {
            TargetClass::Portable => "portable",
            TargetClass::LinuxOnly => "linux-only",
        }
    }
}

impl Requires {
    /// Reads the declaration, or `None` for an artifact built before DL51.
    pub fn of(module_bytes: &[u8]) -> Option<Requires> {
        let payload = find_custom_section(module_bytes, REQUIRES_SECTION)?;
        let text = std::str::from_utf8(payload).ok()?;
        let mut backend = None;
        let mut target = None;
        let mut features = Vec::new();
        for line in text.split('\n') {
            // **Both halves trimmed.** Measured: a payload whose value carried trailing
            // spaces parsed as an unknown target class, `Requires::of` answered `None`,
            // and the host then **skipped the check entirely** — a declaration that fails
            // to parse is not a declaration a host may wave through. Trimmed, an unknown
            // class still returns `None` below, which is the refusal this block wants;
            // what the trim removes is the *silent* version of it.
            let (key, value) = line.split_once('=')?;
            let (key, value) = (key.trim(), value.trim());
            match key {
                "backend" => {
                    backend = Some(match value {
                        "fiber" => Backend::Fiber,
                        "promise" => Backend::Promise,
                        "continuation" => Backend::Continuation,
                        // An unknown backend is not folded into a default: a host that
                        // guessed would pick the wrong executor for a module it cannot
                        // read, which is exactly what this block exists to prevent.
                        _ => return None,
                    })
                }
                // An unknown target class is **not** silently portable: a host that
                // guessed would run a module it cannot, which is the failure this block
                // exists to prevent.
                "target" => {
                    target = Some(match value {
                        "portable" => TargetClass::Portable,
                        "linux-only" => TargetClass::LinuxOnly,
                        _ => return None,
                    })
                }
                "features" => {
                    features = value
                        .split(',')
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(str::to_owned)
                        .collect()
                }
                _ => {}
            }
        }
        Some(Requires { backend: backend?, target: target?, features })
    }
}

/// What this host offers, so a refusal can name both sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Provision {
    /// The backend this process is running.
    pub backend: Backend,
    /// Whether `wasm_stack_switching(true)` was accepted here.
    pub continuations: bool,
    /// Whether `shared_memory(true)` is on (it is, unconditionally — see `main.rs`).
    pub shared_memory: bool,
    /// The platform, for the message. `std::env::consts::OS`.
    pub platform: &'static str,
}

/// An artifact whose declared requirements this host cannot meet.
///
/// **Both facts, always** — what the artifact needs and what this host provides — for the
/// same reason [`Mismatch`] names both backends: a refusal that names one side sends the
/// reader looking for a flag that is not the problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmetRequirement {
    /// What the artifact declares.
    pub requires: Requires,
    /// What this process offers.
    pub provision: Provision,
    /// The unmet keys, in the declaration's order: `stack-switching`, `linux-only`, …
    pub unmet: Vec<String>,
}

impl std::fmt::Display for UnmetRequirement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let needs = if self.unmet.is_empty() {
            "nothing this host can check".to_owned()
        } else {
            self.unmet.join(", ")
        };
        write!(
            f,
            "this guest requires `{needs}` (it declares backend `{}`, target `{}`, features [{}]) \
             and this host provides backend `{}` on `{}`, stack-switching {}, shared-memory {} \
             — refusing by name, nothing was run",
            self.requires.backend.name(),
            self.requires.target.name(),
            self.requires.features.join(","),
            self.provision.backend.name(),
            self.provision.platform,
            if self.provision.continuations { "on" } else { "off" },
            if self.provision.shared_memory { "on" } else { "off" },
        )
    }
}

impl std::error::Error for UnmetRequirement {}

impl Requires {
    /// Every requirement this provision does not meet, named.
    pub fn unmet_against(&self, provision: Provision) -> Vec<String> {
        let mut unmet = Vec::new();
        if self.target == TargetClass::LinuxOnly && provision.platform != "linux" {
            unmet.push(format!("target `linux-only` (this host is `{}`)", provision.platform));
        }
        for feature in &self.features {
            match feature.as_str() {
                "stack-switching" if !provision.continuations => {
                    unmet.push("feature `stack-switching`".to_owned())
                }
                "shared-memory" if !provision.shared_memory => {
                    unmet.push("feature `shared-memory`".to_owned())
                }
                _ => {}
            }
        }
        unmet
    }
}

/// The payload of the first custom section named `name`, or `None`.
///
/// One walker, shared by [`Backend::of`] and [`Requires::of`], so the two cannot come to
/// disagree about where a custom section starts.
fn find_custom_section<'a>(module_bytes: &'a [u8], name: &[u8]) -> Option<&'a [u8]> {
    let mut i = 8; // magic + version
    while i < module_bytes.len() {
        let id = module_bytes[i];
        i += 1;
        let Some((size, next)) = leb(module_bytes, i) else { break };
        let end = (next + size).min(module_bytes.len());
        if id == 0 {
            if let Some((name_len, after)) = leb(module_bytes, next) {
                let name_end = (after + name_len).min(end);
                if &module_bytes[after..name_end] == name {
                    return Some(&module_bytes[name_end..end]);
                }
            }
        }
        i = end;
    }
    None
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
    /// **Which class the wake arrived as**, for `scheduler::completionClass`.
    ///
    /// The payload alone cannot describe a family whose members mean different things —
    /// `AI_READY` (bytes waiting), `AI_DONE` (over) and `AI_ERROR` (failed) are three
    /// events with one word between them. The host's producer is the only side that knows
    /// which arrived, so it answers both and this carries the class the same way
    /// `COMPLETION` carries the value: one word, one resume, one thread (DL57).
    static COMPLETION_CLASS: Cell<i32> = const { Cell::new(-1) };
}

/// **Whether a park here can suspend** — i.e. whether this thread is inside
/// [`run`]'s fiber.
///
/// A predicate beside `suspend_current` rather than a flag on it, because the two
/// questions differ: `suspend_current` *acts* (it suspends this stack), and
/// `scheduler::completion` needs to *ask* without acting. Answering both from the
/// same thread-local is what keeps them from disagreeing (DL41).
pub fn running() -> bool {
    !SUSPEND.with(|slot| slot.get()).is_null()
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

/// **What `scheduler::completionClass(task_id)` answers**: the class the wake that resumed
/// this task arrived as. `-1` before any keyed completion, which the guest reads as "no
/// class" rather than as class 0 (`DEVICE_LOST`).
pub fn completion_class() -> i32 {
    COMPLETION_CLASS.with(|cell| cell.get())
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
/// answers the payload **and the class the wake arrives as**, or `None` when nothing will
/// ever complete this park. Two words rather than one: the class is what a multi-member
/// family is read by (`rt.classify` dispatches on it), and making it part of the answer
/// means a producer cannot forget to say which event it delivered. That call order *is* the
/// I70 ordering (park, then wake), so no test has to arrange it.
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
    P: FnMut(Park) -> Option<(i32, u32)>,
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
        let Some((value, class)) = producer(parked) else {
            // Nothing will complete this park. The fiber is still suspended and
            // cannot be dropped; leaking it is the only sound choice, and the
            // refusal below is what makes the leak visible instead of a hang.
            if let Some(fiber) = slot.take() {
                std::mem::forget(fiber);
            }
            return Ok(Outcome::Stranded(Stranded { park: parked }));
        };
        COMPLETION.with(|cell| cell.set(value));
        COMPLETION_CLASS.with(|cell| cell.set(class as i32));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A module carrying one custom section, built by hand: the compiler's writer is
    /// twenty lines and this is the same twenty, so the reader is tested against bytes
    /// and not against a struct it could have agreed with by accident.
    fn module_with(name: &str, payload: &str) -> Vec<u8> {
        fn leb(mut n: usize) -> Vec<u8> {
            let mut out = Vec::new();
            loop {
                let byte = (n & 0x7f) as u8;
                n >>= 7;
                if n == 0 {
                    out.push(byte);
                    return out;
                }
                out.push(byte | 0x80);
            }
        }
        let mut body = leb(name.len());
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(payload.as_bytes());
        let mut out = b"\0asm\x01\0\0\0".to_vec();
        out.push(0);
        out.extend(leb(body.len()));
        out.extend(body);
        out
    }

    fn linux(name: &'static str) -> Provision {
        Provision { backend: Backend::Fiber, continuations: true, shared_memory: true, platform: name }
    }

    #[test]
    fn a_fiber_artifact_is_portable() {
        let bytes = module_with("tension.requires", "backend=fiber\ntarget=portable\nfeatures=");
        let requires = Requires::of(&bytes).expect("a fiber declaration must parse");
        assert_eq!(requires.backend, Backend::Fiber);
        assert_eq!(requires.target, TargetClass::Portable);
        assert!(requires.features.is_empty());
        assert!(requires.unmet_against(linux("linux")).is_empty());
        // The point of `portable`: the same artifact is accepted where the continuation
        // backend is refused (I16), which is the whole reason `auto` means fiber.
        assert!(requires.unmet_against(linux("windows")).is_empty());
    }

    #[test]
    fn a_continuation_artifact_is_refused_off_linux_by_name() {
        let bytes = module_with(
            "tension.requires",
            "backend=continuation\ntarget=linux-only\nfeatures=stack-switching",
        );
        let requires = Requires::of(&bytes).expect("a continuation declaration must parse");
        // A Windows host: the platform the class excludes, **and** `async_backend::build`
        // could not turn the feature on there (wasmtime's `check_compatible_features`),
        // so both requirements are genuinely unmet — which is the honest pairing, not a
        // device to make the count two.
        let windows = Provision { platform: "windows", continuations: false, ..linux("windows") };
        let unmet = requires.unmet_against(windows);
        assert_eq!(unmet.len(), 2, "both the class and the feature are unmet: {unmet:?}");
        assert!(unmet[0].contains("linux-only") && unmet[0].contains("windows"), "{unmet:?}");
        assert!(unmet[1].contains("stack-switching"), "{unmet:?}");

        // **And the message carries both sides**, which is the rule this block exists for:
        // a reader must learn what the artifact needs *and* what this host offers.
        let refusal = UnmetRequirement { requires, provision: windows, unmet };
        let text = refusal.to_string();
        assert!(text.contains("linux-only"), "{text}");
        assert!(text.contains("windows"), "{text}");
        assert!(text.contains("continuation"), "{text}");
        assert!(text.contains("stack-switching"), "{text}");
        assert!(text.contains("nothing was run"), "{text}");
    }

    #[test]
    fn a_continuation_artifact_on_linux_meets_its_requirements() {
        let bytes = module_with(
            "tension.requires",
            "backend=continuation\ntarget=linux-only\nfeatures=stack-switching",
        );
        let requires = Requires::of(&bytes).unwrap();
        assert!(
            requires
                .unmet_against(Provision { continuations: true, ..linux("linux") })
                .is_empty()
        );
        // A host that could not turn the feature on refuses it even on Linux.
        assert!(!requires
            .unmet_against(Provision { continuations: false, ..linux("linux") })
            .is_empty());
    }

    #[test]
    fn a_promise_artifact_declares_itself() {
        let bytes = module_with("tension.requires", "backend=promise\ntarget=portable\nfeatures=");
        assert_eq!(Requires::of(&bytes).unwrap().backend, Backend::Promise);
    }

    #[test]
    fn shared_memory_is_a_requirement_a_host_can_fail() {
        let bytes = module_with(
            "tension.requires",
            "backend=fiber\ntarget=portable\nfeatures=shared-memory",
        );
        let requires = Requires::of(&bytes).unwrap();
        assert!(requires.unmet_against(linux("linux")).is_empty());
        let unmet = requires.unmet_against(Provision { shared_memory: false, ..linux("linux") });
        assert_eq!(unmet.len(), 1);
        assert!(unmet[0].contains("shared-memory"));
    }

    #[test]
    fn a_trailing_space_does_not_disable_the_check() {
        // Measured while building this round: an untrimmed value parsed as an unknown
        // target class, `Requires::of` answered `None`, and the host skipped the check —
        // a declaration that fails to parse must never become a module waved through.
        let bytes = module_with("tension.requires", "backend=fiber \ntarget= portable \nfeatures=");
        let requires = Requires::of(&bytes).expect("surrounding whitespace must not defeat it");
        assert_eq!(requires.backend, Backend::Fiber);
        assert_eq!(requires.target, TargetClass::Portable);
    }

    #[test]
    fn an_unknown_value_is_not_folded_into_a_default() {
        // A host that guessed would pick an executor for a module it cannot read.
        assert!(Requires::of(&module_with("tension.requires", "backend=gpu\ntarget=portable\nfeatures=")).is_none());
        assert!(Requires::of(&module_with("tension.requires", "backend=fiber\ntarget=plan9\nfeatures=")).is_none());
    }

    #[test]
    fn an_artifact_without_the_section_parses_as_none() {
        assert!(Requires::of(b"\0asm\x01\0\0\0").is_none());
    }

    #[test]
    fn the_two_sections_agree_on_every_word() {
        // `tension.stackful-backend` is what every pre-DL51 reader reads and
        // `tension.requires` is what the host checks; the compiler writes both, and the
        // host refuses when they disagree (`main.rs`). This pins the reader's half.
        for (word, expected) in [("fiber", Backend::Fiber), ("promise", Backend::Promise)] {
            let bytes = module_with("tension.stackful-backend", word);
            assert_eq!(Backend::of(&bytes), expected);
        }
        assert_eq!(Backend::of(b"\0asm\x01\0\0\0"), Backend::Continuation, "absence is continuation");
    }
}
