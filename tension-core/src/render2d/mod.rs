//! The 2D renderer, in core.
//!
//! Before the merge this was a capability DSO at `tension-2d/`: an `adapter.cpp`
//! edge, a `render.cpp` body, and an ABI crossing between them. Pass A brings
//! the skeleton inside — the device, the window claim, and the arbitration that
//! makes "exactly one renderer holds the swapchain" a rule the host enforces
//! rather than a hope.
//!
//! # What lives where
//!
//! * [`device`] — [`device::Render2dState`]: the device, the canvas, the
//!   swapchain guard. Pure mechanism, no wasm, no `HostState`; that is what lets
//!   `tests/render2d_open.rs` drive it directly.
//! * [`error`] — the refusals and the errnos they become. The set is the DSO's,
//!   unchanged, so a guest that handled `-ENODEV` before handles it after.
//!
//! The ten `tension::2d` imports are registered by the binary (`main.rs`),
//! because a `func_wrap` needs `HostState` and `HostState` is the binary's. That
//! split is the same one `platform` already makes: the library owns the window
//! and the surface, the binary owns the guest-facing names.
//!
//! # The dual path
//!
//! Cargo feature `render2d-core` decides which backend a guest's imports resolve
//! to. Off (the default for Pass A) is exactly the tree as it was: the ten verbs
//! come from the DSO, and none of this module's device code runs. On, the
//! imports come from the `func_wrap`s and a `tension::2d` DSO named on the
//! command line is skipped rather than loaded twice.
//!
//! Both paths must build and work. A Pass A where only the Rust path runs is a
//! regression of every existing 2D example, and it would fail its own gate.
//!
//! SPDX-License-Identifier: MIT

pub mod device;
pub mod error;

pub use device::{Canvas, Render2dState, RendererId};
pub use error::Render2dError;
