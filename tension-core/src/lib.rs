//! The library half of tension-core.
//!
//! The binary owns the interpreter loop; this target exists so the resource
//! subsystem can be exercised by integration tests (`tests/`) with the same
//! code the runtime links against, rather than a copy of it.
//!
//! `res` is the safe wrapper over the tension-res C ABI; it is the only module
//! here that contains `unsafe`. `world` is the P8c compiler — the author's
//! YAML in, world bytes out — with no FFI at all.

pub mod res;
pub mod world;
