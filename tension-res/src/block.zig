//! The read interface every byte in tension-res is fetched through
//! (DESIGN.md §6.8).
//!
//! A `BlockReader` is a type-erased `{ ctx, read_fn }` pair. `SliceReader` is
//! the trivial implementation over an in-memory pak; tests wrap it with a
//! recorder. `ctx` must outlive every reader derived from it.

const errors = @import("errors.zig");

pub const Error = errors.ParseError;

pub const BlockReader = struct {
    ctx: *const anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        read: *const fn (ctx: *const anyopaque, offset: u64, len: usize) Error![]const u8,
    };

    pub fn read(self: BlockReader, offset: u64, len: usize) Error![]const u8 {
        return self.vtable.read(self.ctx, offset, len);
    }
};

/// A BlockReader over a byte slice (the in-memory pak).
pub const SliceReader = struct {
    bytes: []const u8,

    pub fn blockReader(self: *const SliceReader) BlockReader {
        return .{ .ctx = @ptrCast(self), .vtable = &vtable };
    }

    const vtable = BlockReader.VTable{ .read = readImpl };

    fn readImpl(ctx: *const anyopaque, offset: u64, len: usize) Error![]const u8 {
        const self: *const SliceReader = @alignCast(@ptrCast(ctx));
        if (offset > self.bytes.len) return error.Truncated;
        const start: usize = @intCast(offset);
        if (len > self.bytes.len - start) return error.Truncated;
        return self.bytes[start..][0..len];
    }
};

test "slice reader serves exact ranges and rejects out-of-bounds" {
    const std = @import("std");
    const bytes = [_]u8{ 1, 2, 3, 4, 5 };
    const sr = SliceReader{ .bytes = &bytes };
    const r = sr.blockReader();
    try std.testing.expectEqualSlices(u8, &.{ 2, 3 }, try r.read(1, 2));
    try std.testing.expectError(error.Truncated, r.read(4, 2));
    try std.testing.expectError(error.Truncated, r.read(9, 1));
}
