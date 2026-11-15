//! The engine features that cooperative threads are built on.
//!
//! This module exists before any thread does. It holds the one place the three
//! WebAssembly proposals stack switching needs are switched on, so that the
//! engine the contract will run on has a single answer to "is this engine able
//! to suspend a guest?" — and so the answer can be read, tested, and changed in
//! one line rather than three scattered `config.wasm_*` calls.
//!
//! # Why these three
//!
//! Stack switching (`Config::wasm_stack_switching`) is the proposal a
//! cooperative thread is made of: `cont.new` captures a function as a
//! **continuation**, `suspend` hands control back to whoever resumed it, and
//! `resume`/`resume_throw` put it back. It is `false` by default in wasmtime
//! and it **depends on** the other two:
//!
//! * `function_reference_types` — a continuation is a reference type, and a
//!   control tag is a function type;
//! * `exceptions` — the tag vocabulary: `suspend $t` mirrors a throw's payload
//!   shape, and `resume_throw` delivers a real exception into a suspended
//!   continuation. Already `true` by default in wasmtime 50, but enabled
//!   explicitly here because `resume_throw`'s meaning is what this tree relies
//!   on, and a default flipping must not silently change it.
//!
//! # Why it is not on the process engine yet
//!
//! `main.rs` builds the process's one engine with `epoch_interruption` and
//! nothing else. Turning stack switching on there turns it on for **every**
//! guest, including the root guest that has no use for it, before the contract's
//! surface exists — which would be a proposal enabled on the strength of a
//! design sketch. So this function is called today by the proof in
//! `tests/stack_switching.rs` and by nothing else; the sandbox engine's
//! construction is the call site that gains it when the contract lands.
//!
//! # Platform
//!
//! Stack switching is **x86_64-only** in wasmtime 50: Cranelift lowers it for
//! `x86_64` and refuses elsewhere. A build on aarch64 or Windows does not get a
//! silent no-op — the engine refuses the config — but it does mean the contract
//! cannot be exercised there. `tests/stack_switching.rs` therefore **records the
//! platform it ran on** rather than assuming Linux, and the gate reports it.

use wasmtime::Config;

/// Enable the three proposals a cooperative thread needs on `config`.
///
/// Order is the dependency order, so a failure names the prerequisite: exceptions
/// first, then function references, then stack switching on top of both.
pub fn enable(config: &mut Config) -> &mut Config {
    config.wasm_exceptions(true);
    config.wasm_function_references(true);
    config.wasm_stack_switching(true);
    config
}
