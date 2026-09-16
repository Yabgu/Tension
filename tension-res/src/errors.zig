//! Error model shared by every module in `tension-res`.
//!
//! Two error sets exist, and the split is deliberate:
//!
//! * `ParseError` — malformed or truncated *input*. Every parser returns these;
//!   nothing panics. The mapping to the C ABI's negative errno values is
//!   fixed here so every layer reports the same code:
//!
//!       error.Invalid   -> -22 (EINVAL)  structural violation: wrong FID,
//!                                        bad resynchronization pattern,
//!                                        missing mandatory field, impossible
//!                                        length, malformed value.
//!       error.Truncated ->  -5 (EIO)     input ends inside a structure.
//!
//! * `WriteError` — the caller's output buffer is inadequate or the caller
//!   asked for something contradictory (e.g. a fixed-width field with the
//!   wrong payload size). These never reach the ABI.
//!
//! The ABI error table itself (approved): -2 ENOENT, -20 ENOTDIR, -21 EISDIR,
//! -9 EBADF, -22 EINVAL, -5 EIO, plus -24 EMFILE for fd-table exhaustion
//! (§7.3). Only EINVAL/EIO originate in this module; the VFS adds the rest.

/// Error numbers, POSIX values (negated) as in the approved ABI table.
pub const ENOENT: i32 = -2;
pub const EIO: i32 = -5;
pub const EBADF: i32 = -9;
/// fd-table exhaustion. POSIX EMFILE, reached only by the VFS (§7.3); an
/// addition to the plan's six codes, ruled in the phase-5 report.
pub const EMFILE: i32 = -24;
/// Allocation failure at the C ABI boundary (`tension_res_load`).
pub const ENOMEM: i32 = -12;
/// Not implemented in this build: `tension_res_pack` until phase 7.
pub const ENOSYS: i32 = -38;
pub const ENOTDIR: i32 = -20;
pub const EISDIR: i32 = -21;
pub const EINVAL: i32 = -22;

/// Malformed or truncated input. No parser panics; they return these.
pub const ParseError = error{
    /// The bytes are structurally wrong for the requested structure.
    Invalid,
    /// The input ends inside a structure.
    Truncated,
};

/// Output-buffer and caller-contract failures. Never surfaced over the ABI.
pub const WriteError = error{
    /// The destination buffer is too small.
    NoSpace,
    /// The caller asked for an impossible encoding (e.g. a fixed-width field
    /// with the wrong data size).
    InvalidValue,
};

/// The errno-style code for a parse failure, as reported to the C ABI.
pub fn errnoFor(e: ParseError) i32 {
    return switch (e) {
        error.Invalid => EINVAL,
        error.Truncated => EIO,
    };
}

test "error mapping matches the ABI table" {
    const std = @import("std");
    try std.testing.expectEqual(@as(i32, -22), errnoFor(error.Invalid));
    try std.testing.expectEqual(@as(i32, -5), errnoFor(error.Truncated));
    try std.testing.expectEqual(@as(i32, -2), ENOENT);
    try std.testing.expectEqual(@as(i32, -20), ENOTDIR);
    try std.testing.expectEqual(@as(i32, -21), EISDIR);
    try std.testing.expectEqual(@as(i32, -9), EBADF);
}
