//! The C ABI (DESIGN.md §9.2) — the only surface Rust links against.
//!
//! Everything here is a boundary, so the rules are strict:
//!
//! * **no panics**: every entry point validates its arguments and maps every
//!   Zig error to a negative errno. No `try` escapes, no `unreachable`, no
//!   unchecked `@intCast` on caller-supplied values.
//! * **no borrowed state outliving the call**: the handle owns the pak (or
//!   borrows the caller's, per `tension_res_load_borrowed`), the fd table, and
//!   the readdir cursor. Nothing else is global, so two handles never interact.
//! * **`const tension_res *` is the caller's intent**, not our state: the fd
//!   calls mutate the handle's own tables, which is why they `@constCast` the
//!   parameter the header declares `const`.
//!
//! The handle is opaque to C: `typedef struct tension_res tension_res;` names a
//! type C never dereferences.

const std = @import("std");
const errors = @import("errors.zig");
const block = @import("block.zig");
const walk = @import("walk.zig");
const vfs_mod = @import("vfs.zig");
const writer = @import("writer.zig");

/// The 12-byte record of §7.4 — the header's `tension_res_stat`. Named `Stat`
/// here because Zig file-scope declarations share one namespace. (The C
/// function is `tension_res_stat_path`: C++ puts type names and function names
/// in one namespace, and the header must compile as C++.)
pub const Stat = vfs_mod.StatRecord;

/// The path length the ABI accepts (must match `TENSION_RES_PATH_MAX` in
/// `include/tension_res.h`). The walker's own limits (64 components, 0xFFFF
/// bytes each) stay authoritative; this only stops a caller's lie from being
/// dereferenced.
pub const PATH_MAX: usize = 1024 * 1024;

/// The allocator backing handles and owned blob copies. Page-granular and
/// libc-free, so the static library links into any host.
const gpa = std.heap.page_allocator;

/// The opaque handle: one pak (owned or borrowed) plus its runtime state.
pub const tension_res = struct {
    /// Owns this handle and, for `tension_res_load`, the blob copy.
    alloc: std.mem.Allocator,
    /// Non-null when this handle owns the bytes it serves.
    owned: ?[]u8,
    /// The served bytes: the copy, or the caller's buffer (§9.2).
    served: []const u8,
    /// The reader the walker and the VFS both fetch through (§6.8). Kept here
    /// so its address is stable: `walker.reader.ctx` points at it.
    sr: block.SliceReader,
    /// The pak set the VFS resolves over. Held as an array inside the handle so
    /// `vfs.paks` points at stable memory.
    paks: [1]walk.Walker,
    vfs: vfs_mod.Vfs,
};

// ---------------------------------------------------------------------------
// load / free
// ---------------------------------------------------------------------------

pub export fn tension_res_load(
    bytes: ?[*]const u8,
    len: usize,
    out: ?*?*tension_res,
    err: ?[*]u8,
    errcap: usize,
) i32 {
    return loadImpl(bytes, len, out, err, errcap, true);
}

pub export fn tension_res_load_borrowed(
    bytes: ?[*]const u8,
    len: usize,
    out: ?*?*tension_res,
    err: ?[*]u8,
    errcap: usize,
) i32 {
    return loadImpl(bytes, len, out, err, errcap, false);
}

pub export fn tension_res_free(res: ?*tension_res) void {
    const self = res orelse return;
    if (self.owned) |buf| self.alloc.free(buf);
    self.alloc.destroy(self);
}

fn loadImpl(
    bytes: ?[*]const u8,
    len: usize,
    out: ?*?*tension_res,
    err: ?[*]u8,
    errcap: usize,
    copy: bool,
) i32 {
    const slot = out orelse {
        setErr(err, errcap, "out is null");
        return errors.EINVAL;
    };
    slot.* = null;
    const src = bytes orelse {
        setErr(err, errcap, "bytes is null");
        return errors.EINVAL;
    };
    if (len == 0) {
        setErr(err, errcap, "empty blob");
        return errors.EINVAL;
    }

    var owned: ?[]u8 = null;
    var served: []const u8 = undefined;
    if (copy) {
        const buf = gpa.alloc(u8, len) catch {
            setErr(err, errcap, "out of memory");
            return errors.ENOMEM;
        };
        @memcpy(buf, src[0..len]);
        owned = buf;
        served = buf;
    } else {
        served = src[0..len];
    }

    const handle = createHandle(owned, served) catch |e| {
        if (owned) |buf| gpa.free(buf); // the handle never took ownership
        setErr(err, errcap, describe(e));
        return errnoForLoad(e);
    };
    slot.* = handle;
    setErr(err, errcap, "");
    return 0;
}

/// What a load can fail with: a parser error, or no memory for the copy.
const LoadError = walk.WalkError || error{OutOfMemory};

fn createHandle(owned: ?[]u8, served: []const u8) LoadError!*tension_res {
    const self = try gpa.create(tension_res);
    errdefer gpa.destroy(self);
    self.alloc = gpa;
    self.owned = owned;
    self.served = served;
    self.sr = .{ .bytes = served };
    self.paks = .{try walk.Walker.init(served, self.sr.blockReader())};
    self.vfs = vfs_mod.Vfs.init(&self.paks, self.alloc);
    return self;
}

/// Load failures as errno values (the header's table).
fn errnoForLoad(e: LoadError) i32 {
    return switch (e) {
        error.OutOfMemory => errors.ENOMEM,
        error.Invalid => errors.EINVAL,
        error.Truncated => errors.EIO,
        error.NotFound => errors.ENOENT,
        error.NotDir => errors.ENOTDIR,
        error.IsDir => errors.EISDIR,
    };
}

fn describe(e: LoadError) []const u8 {
    return switch (e) {
        error.OutOfMemory => "out of memory", // handled by the caller
        error.Invalid => "not a readable ECMA-208 volume",
        error.Truncated => "blob ends inside a structure",
        error.NotFound => "no readable root directory",
        error.NotDir => "root is not a directory",
        error.IsDir => "root is a directory where a file was expected",
    };
}

// ---------------------------------------------------------------------------
// path-addressed calls
// ---------------------------------------------------------------------------

pub export fn tension_res_open(res: ?*const tension_res, path: ?[*]const u8, path_len: usize) i32 {
    const self = mutable(res) orelse return errors.EINVAL;
    const p = pathSlice(path, path_len) orelse return errors.EINVAL;
    return self.vfs.open(p);
}

pub export fn tension_res_stat_path(
    res: ?*const tension_res,
    path: ?[*]const u8,
    path_len: usize,
    out: ?*Stat,
) i32 {
    const self = mutable(res) orelse return errors.EINVAL;
    const o = out orelse return errors.EINVAL;
    const p = pathSlice(path, path_len) orelse return errors.EINVAL;
    return self.vfs.stat(p, o);
}

pub export fn tension_res_readdir(
    res: ?*const tension_res,
    path: ?[*]const u8,
    path_len: usize,
    index: u32,
    name: ?[*]u8,
    name_cap: usize,
    out: ?*Stat,
) i32 {
    const self = mutable(res) orelse return errors.EINVAL;
    const o = out orelse return errors.EINVAL;
    const p = pathSlice(path, path_len) orelse return errors.EINVAL;
    const buf: []u8 = if (name_cap == 0) &.{} else blk: {
        const n = name orelse return errors.EINVAL;
        break :blk n[0..name_cap];
    };
    return self.vfs.readdir(p, index, buf, o);
}

// ---------------------------------------------------------------------------
// fd-addressed calls
// ---------------------------------------------------------------------------

pub export fn tension_res_read(
    res: ?*const tension_res,
    fd: i32,
    dst: ?[*]u8,
    len: usize,
) i32 {
    const self = mutable(res) orelse return errors.EINVAL;
    if (len == 0) {
        // A zero-length read still reports a bad handle, like POSIX.
        return self.vfs.read(fd, @constCast(&[_]u8{}));
    }
    const d = dst orelse return errors.EINVAL;
    return self.vfs.read(fd, d[0..len]);
}

pub export fn tension_res_seek(
    res: ?*const tension_res,
    fd: i32,
    off: i64,
    whence: i32,
) i64 {
    const self = mutable(res) orelse return errors.EINVAL;
    if (whence < 0 or whence > 2) return errors.EINVAL;
    return self.vfs.seek(fd, off, @intCast(whence));
}

pub export fn tension_res_tell(res: ?*const tension_res, fd: i32) i64 {
    const self = mutable(res) orelse return errors.EINVAL;
    return self.vfs.tell(fd);
}

pub export fn tension_res_stat_fd(
    res: ?*const tension_res,
    fd: i32,
    out: ?*Stat,
) i32 {
    const self = mutable(res) orelse return errors.EINVAL;
    const o = out orelse return errors.EINVAL;
    return self.vfs.statFd(fd, o);
}

pub export fn tension_res_close(res: ?*const tension_res, fd: i32) i32 {
    const self = mutable(res) orelse return errors.EINVAL;
    return self.vfs.close(fd);
}

// ---------------------------------------------------------------------------
// packer (phase 7)
// ---------------------------------------------------------------------------

pub export fn tension_res_pack(
    dir: ?[*:0]const u8,
    out: ?[*:0]const u8,
    err: ?[*]u8,
    errcap: usize,
) i32 {
    const d = dir orelse {
        setErr(err, errcap, "dir is null");
        return errors.EINVAL;
    };
    const o = out orelse {
        setErr(err, errcap, "out is null");
        return errors.EINVAL;
    };
    const source = std.mem.span(d);
    const dest = std.mem.span(o);
    if (source.len == 0 or dest.len == 0) {
        setErr(err, errcap, "empty source or output path");
        return errors.EINVAL;
    }
    if (source.len > PATH_MAX or dest.len > PATH_MAX) {
        setErr(err, errcap, "source or output path is too long");
        return errors.EINVAL;
    }
    const stats = writer.pack(gpa, source, dest, null) catch |e| {
        setErr(err, errcap, packDescribe(e));
        return writer.errnoFor(e);
    };
    // On success the message is informational, not an error report.
    var buf: [160]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "packed {d} files, {d} directories, {d} bytes", .{
        stats.files, stats.directories, stats.bytes,
    }) catch "packed";
    setErr(err, errcap, text);
    return 0;
}

fn packDescribe(e: writer.PackError) []const u8 {
    return switch (e) {
        error.NotFound => "source path does not exist (or a symlink is dangling)",
        error.NotDir => "the source is not a directory",
        error.IsDir => "a File expected a regular file",
        error.AccessDenied => "permission denied while reading the source tree",
        error.OutOfMemory => "out of memory",
        error.NoSpace, error.InvalidValue => "the layout cannot be expressed in this format",
        error.NameTooLong => "a name or path is longer than the format allows",
        error.TooDeep => "the source tree is nested deeper than the packer follows",
        error.IoRead, error.IoWrite => "reading the source tree or writing the pak failed",
        error.Truncated, error.Invalid => "the source changed while it was being packed",
    };
}

// ---------------------------------------------------------------------------
// boundary helpers
// ---------------------------------------------------------------------------

/// The header declares the handle `const`; the fd table and readdir cursor
/// live inside it, so the fd calls take a mutable view of the same object.
fn mutable(res: ?*const tension_res) ?*tension_res {
    const r = res orelse return null;
    return @constCast(r);
}

fn pathSlice(path: ?[*]const u8, len: usize) ?[]const u8 {
    if (len > PATH_MAX) return null;
    if (len == 0) return &.{}; // the empty path is the root (§7.1)
    const p = path orelse return null;
    return p[0..len];
}

/// Write a NUL-terminated reason into the caller's buffer, truncated to
/// `errcap` (which may be 0 or the buffer NULL — then nothing is written).
fn setErr(err: ?[*]u8, errcap: usize, msg: []const u8) void {
    const buf = err orelse return;
    if (errcap == 0) return;
    const n = @min(msg.len, errcap - 1);
    @memcpy(buf[0..n], msg[0..n]);
    buf[n] = 0;
}

// ---------------------------------------------------------------------------
// Tests: the boundary rules that do not need a fixture
// ---------------------------------------------------------------------------

const testing = std.testing;

test "the exported record matches the header's 12 bytes" {
    try testing.expectEqual(@as(usize, 12), @sizeOf(Stat));
    try testing.expectEqual(@as(usize, 4), @alignOf(Stat));
}

test "load rejects bad arguments with a message, never a panic" {
    var err: [64]u8 = undefined;
    var out: ?*tension_res = null;
    // null output slot
    try testing.expectEqual(errors.EINVAL, tension_res_load(&.{}, 1, null, &err, err.len));
    // null bytes
    try testing.expectEqual(errors.EINVAL, tension_res_load(null, 16, &out, &err, err.len));
    try testing.expect(out == null);
    // empty blob
    try testing.expectEqual(errors.EINVAL, tension_res_load(&.{}, 0, &out, &err, err.len));
    try testing.expect(out == null);
    // a message was written and NUL-terminated
    try testing.expect(std.mem.indexOfScalar(u8, &err, 0) != null);
    try testing.expect(err[0] != 0);
    // a tiny buffer still gets a truncated, terminated message
    var small: [4]u8 = undefined;
    _ = tension_res_load(&.{}, 0, &out, &small, small.len);
    try testing.expectEqual(@as(u8, 0), small[3]);

    // malformed blobs are errno, not crashes
    var zeros = [_]u8{0} ** 4096;
    try testing.expect(tension_res_load(&zeros, zeros.len, &out, &err, err.len) < 0);
    try testing.expect(out == null);
    try testing.expect(tension_res_load_borrowed(&zeros, zeros.len, &out, &err, err.len) < 0);
    try testing.expect(out == null);

    // paths at the boundary
    var handle: ?*tension_res = null;
    try testing.expect(tension_res_load(null, 0, &handle, null, 0) < 0);
    try testing.expect(tension_res_open(null, "/", 1) == errors.EINVAL);
    var rec: Stat = undefined;
    try testing.expect(tension_res_stat_path(null, "/", 1, &rec) == errors.EINVAL);
    try testing.expect(tension_res_readdir(null, "/", 1, 0, null, 0, &rec) == errors.EINVAL);

    // the packer rejects a null source with a message, never a crash
    var msg: [64]u8 = undefined;
    const out_path: [*:0]const u8 = "out.tns";
    try testing.expectEqual(errors.EINVAL, tension_res_pack(null, out_path, &msg, msg.len));
}
