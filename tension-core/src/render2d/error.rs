//! The refusals a 2D canvas can make, and the errno each one becomes.
//!
//! The guest sees an `i32`, so the codes are the contract and the messages are
//! for the log. The set is `tension-2d/src/render.cpp`'s and
//! `tension-2d/src/adapter.cpp`'s, carried over variant for variant — a guest
//! that handled `-ENODEV` before the merge handles it after, which is what makes
//! the in-core backend a substitution rather than a migration the guest has to
//! know about.
//!
//! Every code here is one the C++ path could return. Nothing is invented, and
//! nothing is dropped: parity is measured on the *numbers* as much as on the
//! pixels (`tests/render2d_parity.rs` compares both).
//!
//! SPDX-License-Identifier: MIT

/// `EBADF` — the guest span could not be reached at all.
pub const EBADF: i32 = -9;
/// `EBUSY` — the swapchain is already held, or a canvas is already open.
pub const EBUSY: i32 = -16;
/// `EIO` — a GPU call failed after the device came up.
pub const EIO: i32 = -5;
/// `ENODEV` — SDL has no GPU backend, the window cannot be claimed, or nothing
/// has been presented yet.
pub const ENODEV: i32 = -19;
/// `ENOMEM` — the device is up but an allocation failed.
pub const ENOMEM: i32 = -12;
/// `EINVAL` — the arguments do not describe a canvas, a record, or a page.
pub const EINVAL: i32 = -22;
/// `ENOENT` — the handle, pipe or texture named does not exist.
pub const ENOENT: i32 = -2;
/// `ENOSPC` — a table is full, a buffer is short, or the stager is.
pub const ENOSPC: i32 = -28;
/// `ENOSYS` — the verb or layout is not served by this build.
pub const ENOSYS: i32 = -38;
/// `ECANCELED` — the user closed the window; presented once, reported once.
pub const ECANCELED: i32 = -125;

/// Why an operation refused.
///
/// Carries the message as well as the code because the two go to different
/// readers: the guest gets the code, the log gets the sentence. A refusal that
/// only had a code would be the `-ENODEV` ambiguity this type exists to avoid —
/// "no GPU", "no presentable window" and "nothing presented yet" are all
/// `-ENODEV`, and the message is the only place they differ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Render2dError {
    /// The swapchain is held by another renderer, or a canvas is already open.
    Busy(String),
    /// No usable GPU device, no presentable window, or nothing presented yet.
    NoDevice(String),
    /// Allocation failed after the device came up.
    NoMemory(String),
    /// Bad arguments.
    Invalid(String),
    /// A table is full or a caller's buffer is too short.
    Full(String),
    /// The handle, pipe or texture named does not exist.
    NotFound(String),
    /// This build does not serve the requested layout or verb.
    Unsupported(String),
    /// A GPU call failed after the device came up.
    Io(String),
    /// The user closed the window.
    Canceled(String),
}

impl Render2dError {
    /// The errno the guest sees.
    pub fn errno(&self) -> i32 {
        match self {
            Render2dError::Busy(_) => EBUSY,
            Render2dError::NoDevice(_) => ENODEV,
            Render2dError::NoMemory(_) => ENOMEM,
            Render2dError::Invalid(_) => EINVAL,
            Render2dError::Full(_) => ENOSPC,
            Render2dError::NotFound(_) => ENOENT,
            Render2dError::Unsupported(_) => ENOSYS,
            Render2dError::Io(_) => EIO,
            Render2dError::Canceled(_) => ECANCELED,
        }
    }

    /// The sentence the log gets.
    pub fn message(&self) -> &str {
        match self {
            Render2dError::Busy(m)
            | Render2dError::NoDevice(m)
            | Render2dError::NoMemory(m)
            | Render2dError::Invalid(m)
            | Render2dError::Full(m)
            | Render2dError::NotFound(m)
            | Render2dError::Unsupported(m)
            | Render2dError::Io(m)
            | Render2dError::Canceled(m) => m,
        }
    }
}

impl std::fmt::Display for Render2dError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message(), self.errno())
    }
}

impl std::error::Error for Render2dError {}
