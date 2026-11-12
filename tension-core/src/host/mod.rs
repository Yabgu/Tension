//! The host's guest-facing surface, one module per import namespace.
//!
//! `main()` used to register every verb inline — 26 `func_wrap` calls in a
//! 1661-line function, which made it impossible to stand a second guest up
//! without running the binary's whole setup. This module is that surface moved
//! out, one namespace at a time, so a sandboxed store can be linked by calling
//! `link_io` / `link_res` / (later) `link_platform` instead of re-deriving them.
//!
//! **Each `link_*` is a move, not a redesign.** The bodies are byte-identical to
//! what `main()` held; the only change is the signature, which takes the linker
//! and nothing else, because the verbs already read their state through
//! `Caller::data()`.

pub mod io;
pub mod res;

pub use io::link_io;
pub use res::link_res;
