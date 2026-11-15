//! The compiled-module cache: one compilation per guest file per process.
//!
//! **Why this exists.** `GuestHost::new` compiled the guest's bytes every time it
//! was called, which was invisible while there was exactly one guest per
//! process. A sandbox changes that: the second guest is usually *the same module*
//! — the editor's Play Mode compiles the project's wasm once and runs it on
//! demand — and compiling it again per run would put a Cranelift pass on every
//! press of a button. The engine already owns the compiled-code cache for a
//! module it has seen; what it does not own is the mapping from a *file* to that
//! module, because `Module::new` takes bytes.
//!
//! **Key, and why it is a fingerprint rather than a path.** A rebuild writes the
//! same path with different bytes, and a stale module would be a guest that runs
//! last week's code while the file on disk says otherwise. So an entry is valid
//! only while the file's size and modification time are unchanged; anything else
//! is a miss and recompiles. That is the same rule `tension dev` applies to
//! itself (restart on write), moved down to the compile.
//!
//! **Why the hit path skips `check_guest_module`.** The check is a property of
//! the module, not of the file, and a hit returns the *same* module the check
//! passed on the load that compiled it — same fingerprint, therefore same bytes.
//! Re-running it would need the bytes, and reading them is most of what a hit is
//! saving.
//!
//! **Why `compiles` is counted rather than inferred.** Pass 2's acceptance
//! requires a test that the second store does not recompile, and "the cache has
//! an entry" is not that claim — an entry could be written and ignored. The
//! counter is incremented in the only place compilation happens, which makes it
//! the mechanism rather than a flag about the mechanism. It is also the honest
//! shape for a cache: a cache that cannot say how often it missed is a cache
//! nobody can tune.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use anyhow::{Context, Result};
use wasmtime::{Engine, Module};

/// What a file looked like when its module was compiled.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Fingerprint {
    modified: Option<SystemTime>,
    size: u64,
}

impl Fingerprint {
    /// The file's current fingerprint, or `None` when it cannot be read.
    fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        Some(Self {
            modified: metadata.modified().ok(),
            size: metadata.len(),
        })
    }
}

/// The outcome of a load. `compiled` is the difference between "this call
/// compiled the guest" and "this call found it already compiled".
pub(crate) struct Loaded {
    pub(crate) module: Module,
    /// The bytes, present only on a miss — the caller's load-time check needs
    /// them, and a hit deliberately avoids the read. Therefore: `Some` means
    /// "this call compiled it".
    pub(crate) bytes: Option<Vec<u8>>,
}

/// One cache per process, shared by every guest ([`super::HostConfig`] holds it
/// in an `Arc`).
#[derive(Default)]
pub(crate) struct ModuleCache {
    entries: Mutex<HashMap<PathBuf, (Fingerprint, Module)>>,
    compiles: AtomicUsize,
}

impl ModuleCache {
    /// The module for `path`, compiling it only when this file has not been
    /// compiled yet (or has changed since).
    pub(crate) fn load(&self, engine: &Engine, path: &str) -> Result<Loaded> {
        let as_path = Path::new(path);
        let fingerprint = Fingerprint::of(as_path);

        // A file whose metadata cannot be read is not cached: the miss below
        // will fail with the read error, which names the path.
        if let Some(fingerprint) = fingerprint {
            let entries = self
                .entries
                .lock()
                .map_err(|_| anyhow::anyhow!("module cache: the mutex was poisoned"))?;
            if let Some((cached, module)) = entries.get(as_path) {
                if *cached == fingerprint {
                    return Ok(Loaded {
                        module: module.clone(),
                        bytes: None,
                    });
                }
            }
        }

        let bytes = std::fs::read(as_path).with_context(|| format!("{path}"))?;
        let module = Module::new(engine, &bytes).with_context(|| format!("{path}"))?;
        self.compiles.fetch_add(1, Ordering::SeqCst);

        // Insert only when the file can be fingerprinted: an entry keyed by
        // nothing would be a cache that never hits but never says so.
        if let Some(fingerprint) = fingerprint {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| anyhow::anyhow!("module cache: the mutex was poisoned"))?;
            entries.insert(as_path.to_path_buf(), (fingerprint, module.clone()));
        }

        Ok(Loaded {
            module,
            bytes: Some(bytes),
        })
    }

    /// How many times this cache has compiled a module.
    ///
    /// Read by the sandbox test that has to prove a second store reuses the first
    /// one's compilation, and by nothing else yet — a compile counter is also the
    /// observability a cache needs to be tuned, which is why it is a method on the
    /// cache rather than a test-only hook.
    #[allow(dead_code)]
    pub(crate) fn compiles(&self) -> usize {
        self.compiles.load(Ordering::SeqCst)
    }
}
