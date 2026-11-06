//! The host's single shader generator.
//!
//! One slot, set once, read from any thread: the C ABI's `shader_generate` is an
//! any-thread entry point (rule 7), so the cell has to be thread-safe. `OnceLock`
//! is std's answer; the prompt's `OnceCell` is the single-threaded cell and would
//! not be `Sync`.
//!
//! Registration is explicit rather than lazy. A host that forgot to register
//! should answer `-ENOSYS` — "no generator" — and a lazy default would instead
//! hide the omission behind a working shader, making the missing call
//! invisible until someone depended on a different generator being installed.

use std::sync::OnceLock;

use tension_shadergen::{Errno, LayoutDesc, Result, ShaderGenerator};

static GENERATOR: OnceLock<Box<dyn ShaderGenerator + Send + Sync>> = OnceLock::new();

/// Install the process's generator. The first call wins; a later call is
/// ignored, because a generator that changes identity mid-run would make the
/// same layout produce different source at different times.
pub fn register(generator: Box<dyn ShaderGenerator + Send + Sync>) {
    let _ = GENERATOR.set(generator);
}

/// Whether [`register`] has been called.
pub fn is_registered() -> bool {
    GENERATOR.get().is_some()
}

/// Generate source for `layout`, or `Errno::Enosys` when no generator is
/// installed.
pub fn generate(layout: &LayoutDesc) -> Result<String> {
    match GENERATOR.get() {
        Some(generator) => generator.generate(layout),
        None => Err(Errno::Enosys),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry answers `-ENOSYS` rather than panicking when nothing is
    /// installed, because that is what the C ABI promises its callers.
    ///
    /// Note: this asserts the *unregistered* state, so it must not run
    /// `register`. The crate's own tests cover the registered path.
    #[test]
    fn unregistered_is_enosys() {
        if is_registered() {
            // Another test registered first; the property under test is the
            // empty state, which this process no longer has.
            return;
        }
        let layout = LayoutDesc {
            name: "empty".to_string(),
            preset_id: 1,
            record_size: 16,
            alignment: 4,
            fields: Vec::new(),
        };
        assert_eq!(generate(&layout).unwrap_err(), Errno::Enosys);
    }
}
