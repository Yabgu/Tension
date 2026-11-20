//! The one async backend a process gets, and the answer to "can a continuation
//! module run here?"
//!
//! Wasmtime 50 enables the stack-switching proposal per *engine*, but Cranelift
//! has to support it on the target. Its own check
//! (`check_compatible_features`/`compiler_panicking_wasm_features` in
//! `wasmtime/src/config.rs`) marks `STACK_SWITCHING` unsupported on every target
//! except x86-64 Linux, macOS and Darwin; there is no configuration switch that
//! overrides it. On Windows, `wasm_stack_switching(true)` makes `Engine::new`
//! itself fail, before any module is examined — which is what took the whole
//! host down instead of a refusal it could report.
//!
//! The honest shape of that is **not** "the engine refuses to exist". The
//! engine still exists, built without the feature; a module that *needs*
//! continuations is then refused at compile time, by name, with the platform in
//! the message. That is what [`AsyncBackend::Promise`] records: the host's
//! `scheduler::park` import (the Promise seam) is still registered, and a guest
//! compiled without `--enable stack-switching` reaches it.

use wasmtime::{Config, Engine};

/// Which async backend a target gives this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsyncBackend {
    /// `wasm_stack_switching(true)` was accepted: a module carrying
    /// `cont.new`/`suspend`/`resume` compiles and runs.
    Continuations,
    /// wasmtime refuses stack switching on this target. The engine is built
    /// without it; a continuation module is refused at compile time. The
    /// Promise seam (`scheduler::park`) is registered, but a Promise-compiled
    /// `async function main` does not run end to end yet — that gap is a
    /// TensionScript round, not this host's.
    Promise,
}

impl AsyncBackend {
    /// Whether a continuation module can run in this process.
    pub fn supports_continuations(self) -> bool {
        matches!(self, AsyncBackend::Continuations)
    }

    /// The one line printed at startup and in `--help`.
    pub fn label(self) -> &'static str {
        match self {
            AsyncBackend::Continuations => "continuations (wasmtime stack switching)",
            AsyncBackend::Promise => "promise (no stack switching on this target)",
        }
    }
}

/// Build the engine every guest shares, trying stack switching and falling back
/// to a real engine without it when wasmtime refuses the feature.
///
/// `base` carries every engine-level switch *except* stack switching (debug
/// info, epoch interruption, threads, shared memory). The feature is tried on
/// top of it; when wasmtime refuses it — its own target check, not a platform
/// list this tree keeps — the engine is rebuilt without it and the answer is
/// [`AsyncBackend::Promise`]. A refusal that is not the stack-switching one is
/// an error: a silent downgrade would hide a different misconfiguration.
pub fn build(base: &Config) -> anyhow::Result<(Engine, AsyncBackend)> {
    let mut with = base.clone();
    with.wasm_stack_switching(true);
    match Engine::new(&with) {
        Ok(engine) => Ok((engine, AsyncBackend::Continuations)),
        Err(refusal) => {
            // `Engine::new` names the unsupported feature in its message; match
            // on that rather than on a platform list, so the answer moves when
            // wasmtime's support does.
            if !format!("{refusal}").contains("wasm_stack_switching") {
                return Err(anyhow::Error::from(refusal));
            }
            let engine = Engine::new(base)?;
            Ok((engine, AsyncBackend::Promise))
        }
    }
}

/// The answer as a cheap probe, without running a guest.
///
/// `--help` has to name the backend, and a test has to assert the capability
/// without parsing the startup line. The real run uses [`build`] and carries the
/// same answer; this is the same question asked of a throwaway engine.
pub fn current() -> AsyncBackend {
    // Cached: the answer is process-wide, and both `--help` and several test
    // constructors ask it repeatedly — no reason to build a throwaway engine
    // more than once.
    static CACHED: std::sync::OnceLock<AsyncBackend> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| match build(&Config::new()) {
        Ok((_, backend)) => backend,
        // A default engine always builds; this arm exists only so a future
        // wasmtime refusal does not turn a probe into a panic.
        Err(_) => AsyncBackend::Promise,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_engine_always_builds() {
        // `current` must never panic, whatever the target.
        let _ = current();
    }

    #[test]
    fn the_answer_agrees_with_the_engine_it_builds() {
        let (_, backend) = build(&Config::new()).expect("a plain engine builds");
        assert_eq!(backend, current());
    }
}
