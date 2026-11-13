//! The 2D renderer, in core.
//!
//! Before the merge this was a capability DSO at `tension-2d/`: an `adapter.cpp`
//! edge, a `render.cpp` body, and an ABI crossing between them. The port brings
//! it inside — the device, the window claim, the frame stager, the pipeline and
//! texture tables, and the graph compiler that used to be a two-call ABI round
//! trip.
//!
//! # What lives where
//!
//! * [`device`] — [`device::Render2dState`]: the device, the canvas, the frame
//!   stager, the tables, and the swapchain guard. Mechanism, no wasm; that is
//!   what lets `tests/render2d_open.rs` and `tests/render2d_parity.rs` drive it
//!   directly.
//! * [`pipeline`] — [`pipeline::PipelineCache`]: preset, guest graph, and the
//!   one-call compile that replaced `-ENOSYS` + two `compile_graph` calls.
//! * [`record`] — the 28-byte sprite record and the graph's ordering of them.
//! * [`iwi`] — the IWI container reader.
//! * [`error`] — the refusals and the errnos they become, variant for variant
//!   from the C++ path so a guest that handled them before handles them after.
//!
//! The ten `tension::2d` imports are registered by the binary (`main.rs`),
//! because a `func_wrap` needs `HostState` and `HostState` is the binary's. That
//! split is the same one `platform` already makes: the library owns the window
//! and the renderer, the binary owns the guest-facing names.
//!
//! # The bisect escape hatch
//!
//! Cargo feature `render2d-core` is **on by default** since Pass B. With it off
//! (`--no-default-features`, or `TENSION_RENDER2D=cpp` in
//! `scripts/build-native.mjs`) the ten verbs come from the C++ DSO at
//! `tension-2d/` exactly as they did before the merge. Pass C removes the flag
//! and the DSO together.
//!
//! SPDX-License-Identifier: MIT

pub mod device;
pub mod error;
pub mod iwi;
pub mod pipeline;
pub mod record;

pub use device::{Canvas, Mode, Render2dState, RendererId};
pub use error::Render2dError;
