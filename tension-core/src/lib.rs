//! The library half of tension-core.
//!
//! The binary owns the interpreter loop; this target exists so the resource
//! subsystem can be exercised by integration tests (`tests/`) with the same
//! code the runtime links against, rather than a copy of it.
//!
//! `res` is the safe wrapper over the tension-res C ABI, and `logging::ffi`
//! exports the `tension_log` C ABI; those two modules are where the `unsafe`
//! lives. Everything else — `world` (the P8c compiler: the author's YAML in,
//! world bytes out) and the rest of `logging` — has no FFI at all.
//!
//! `logging` lives in the library rather than the binary because its C ABI has
//! to be reachable by the integration tests and the C harness they link, not
//! only by the interpreter's `main`.

pub mod logging;
pub mod res;
pub mod world;
