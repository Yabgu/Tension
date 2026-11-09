//! The refusals a 2D canvas can make, and the errno each one becomes.
//!
//! The guest sees an `i32`, so the codes are the contract and the messages are
//! for the log. The set is `tension-2d/src/render.cpp`'s, carried over
//! unchanged — a guest that handled `-ENODEV` before the merge handles it after,
//! which is what makes the in-core backend a substitution rather than a
//! migration the guest has to know about.
//!
//! SPDX-License-Identifier: MIT

/// `EBUSY` — the swapchain is already held, or a canvas is already open.
pub const EBUSY: i32 = -16;
/// `ENODEV` — SDL has no GPU backend, or the window cannot be claimed.
pub const ENODEV: i32 = -19;
/// `ENOMEM` — the device is up but a texture or buffer could not be allocated.
pub const ENOMEM: i32 = -12;
/// `EINVAL` — the arguments do not describe a canvas.
pub const EINVAL: i32 = -22;
/// `ENOSYS` — the verb is registered but not ported yet (Pass A: eight of ten).
pub const ENOSYS: i32 = -38;

/// Why `open` or `close` refused.
///
/// Carries the message as well as the code because the two go to different
/// readers: the guest gets the code, the log gets the sentence. A refusal that
/// only had a code would be the `-ENODEV` ambiguity this type exists to avoid
/// — "no GPU" and "a window you cannot present to" are both `-ENODEV`, and the
/// message is the only place they differ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Render2dError {
    /// The swapchain is held by another renderer, or this one already has a
    /// canvas. `-EBUSY`.
    Busy(String),
    /// No usable GPU device, or a window that cannot be claimed. `-ENODEV`.
    NoDevice(String),
    /// Allocation failed after the device came up. `-ENOMEM`.
    NoMemory(String),
    /// Bad arguments. `-EINVAL`.
    Invalid(String),
}

impl Render2dError {
    /// The errno the guest sees.
    pub fn errno(&self) -> i32 {
        match self {
            Render2dError::Busy(_) => EBUSY,
            Render2dError::NoDevice(_) => ENODEV,
            Render2dError::NoMemory(_) => ENOMEM,
            Render2dError::Invalid(_) => EINVAL,
        }
    }

    /// The sentence the log gets.
    pub fn message(&self) -> &str {
        match self {
            Render2dError::Busy(m)
            | Render2dError::NoDevice(m)
            | Render2dError::NoMemory(m)
            | Render2dError::Invalid(m) => m,
        }
    }
}

impl std::fmt::Display for Render2dError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message(), self.errno())
    }
}

impl std::error::Error for Render2dError {}
