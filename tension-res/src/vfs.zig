//! The read-only resource VFS (DESIGN.md §7): path rules, fd table, `stat`,
//! `readdir`, `read`/`seek`/`tell`.
//!
//! Two properties are structural rather than conventional:
//!
//! * every payload byte is fetched through a pak's `block.BlockReader` — the
//!   VFS is handed `walk.Walker`s and never sees a pak byte slice at all;
//! * nothing allocates except the per-open chunk cache below: the fd table and
//!   the readdir cursor are fixed fields, path components live on the walker's
//!   stack, and a listing is produced one entry at a time. The one allocation
//!   is a chunked File's chain, materialized on first use and freed by `close`
//!   (§8.3) — the walker itself stays stateless and allocates nothing.
//!
//! Failures are the negative errno values of §7.7; malformed input never
//! panics.

const std = @import("std");
const errors = @import("errors.zig");
const index = @import("index.zig");
const metadata = @import("metadata.zig");
const walk = @import("walk.zig");
const flate = std.compress.flate;

/// The host ABI's `out_ptr` record: 12 bytes, little-endian (6.1, §7.4).
pub const StatRecord = extern struct {
    kind: u32,
    size: u32,
    flags: u32,
};

pub const KIND_FILE: u32 = 0;
pub const KIND_DIRECTORY: u32 = 1;
/// `StatRecord.flags` bit 0: the payload is compressed (the index entry's
/// `compression_method` is not 0, §6.7/§7.4).
pub const FLAG_COMPRESSED: u32 = 1 << 0;

/// One cursor per open (§7.3); 64 concurrent handles is the phase-5 table.
pub const MAX_FDS: usize = 64;
pub const MAX_PAKS: usize = 16;

/// §8.3: the per-open chunk cache holds at most this many chunks. A File with
/// a longer chain is *not* cached — every navigation re-walks it instead
/// (cold seeks stay O(chunks), warm ones are O(1) through the handle's hint).
pub const MAX_FILE_CHUNKS: u32 = 4096;

/// One cached chunk of a chunked File: the walker's span (§8.3).
pub const CachedSpan = walk.ChunkSpan;

/// `RES_SEEK_*` (§7.5).
pub const SEEK_SET: u8 = 0;
pub const SEEK_CUR: u8 = 1;
pub const SEEK_END: u8 = 2;

/// One open handle (§7.3): one cursor, one resolved payload range.
pub const Handle = struct {
    in_use: bool = false,
    pak: usize = 0,
    kind: index.Kind = .file,
    /// What `stat_fd` reports — the index entry's size, so it agrees with
    /// `stat` (§7.4) even if a pak's stream length disagreed.
    stat_size: u32 = 0,
    /// What `read` bounds against — the File's own STREAM SIZE (§7.5).
    data_len: u64 = 0,
    /// Absolute image offset of the payload's first byte.
    data_abs: u64 = 0,
    /// False when the payload is compressed or absent: `read` is `-EIO` while
    /// the handle stays open and `stat` keeps working (§11).
    readable: bool = true,
    compressed: bool = false,
    pos: u64 = 0,
    /// §8.4: the PKWARE method id from the child-index entry (§6.7): 0 stored,
    /// 8 Deflate. The Stream Header must agree with it or the handle opens
    /// unreadable.
    method: u16 = 0,
    /// The *stored* payload length (the stream's STREAM SIZE), kept because
    /// `data_len` reports the expanded size for a compressed File.
    stored_len: u64 = 0,
    /// The decoded payload, materialized on first read and freed by `close`.
    expanded: ?[]u8 = null,
    /// §8.3: set when the File's payload spans Buffers. `chain` is the walker's
    /// description — enough to re-walk at any time; `spans` is the per-open
    /// cache of chunk extents, materialized on the first read or seek and freed
    /// by `close`. `spans` stays null for a chain longer than
    /// MAX_FILE_CHUNKS, which is then re-walked per navigation instead.
    chain: ?walk.Chain = null,
    spans: ?[]CachedSpan = null,
    /// The span the last read/seek landed in, and the File offset it starts at:
    /// the sequential fast path (no search, no walk).
    hint: u32 = 0,
    hint_off: u64 = 0,
};

/// The one-entry readdir cursor cache (§7.6): offsets, never pak bytes.
const Cursor = struct {
    valid: bool = false,
    pak: usize = 0,
    /// The directory's identity: the absolute offset of its index Stream.
    dir: u64 = 0,
    index: u32 = 0,
    entry_pos: u32 = 0,
    next_pos: u32 = 0,
};

pub const Vfs = struct {
    /// The loaded paks, in load order. Borrowed: the caller owns the walkers
    /// (and their readers) and keeps them alive for the VFS's lifetime.
    paks: []const walk.Walker = &.{},
    /// The only thing this module allocates from: the per-handle chunk cache
    /// (§8.3). Borrowed; the caller keeps it alive for the VFS's lifetime.
    alloc: std.mem.Allocator,
    fds: [MAX_FDS]Handle = [_]Handle{.{}} ** MAX_FDS,
    cursor: Cursor = .{},

    pub fn init(paks: []const walk.Walker, alloc: std.mem.Allocator) Vfs {
        return .{ .paks = paks, .alloc = alloc };
    }

    /// No pak loaded: every query misses (§7.2/§11).
    pub fn noPaks(alloc: std.mem.Allocator) Vfs {
        return .{ .alloc = alloc };
    }

    // -- resolution -------------------------------------------------------

    const Resolution = union(enum) {
        found: struct { pak: usize, loc: walk.Location },
        /// Every pak said "not here" — the strict `-ENOENT` of §7.7.
        missing,
        /// A precise failure (malformed path, a file in a path position, …).
        /// It must not be masked by another pak's `-ENOENT` (§7.2).
        failed: i32,
    };

    /// First-match resolution over the pak set (§7.2).
    fn firstResolve(self: *const Vfs, path: []const u8, expect: walk.Expect) Resolution {
        var failed: ?i32 = null;
        for (self.paks, 0..) |_, i| {
            if (self.paks[i].resolve(path, expect)) |loc| {
                return .{ .found = .{ .pak = i, .loc = loc } };
            } else |e| {
                const code = walk.errnoFor(e);
                if (code != errors.ENOENT and failed == null) failed = code;
            }
        }
        if (failed) |code| return .{ .failed = code };
        return .missing;
    }

    // -- stat -------------------------------------------------------------

    /// `stat` (§7.4). The record is always zeroed on failure.
    pub fn stat(self: *const Vfs, path: []const u8, out: *StatRecord) i32 {
        out.* = .{ .kind = 0, .size = 0, .flags = 0 };
        switch (self.firstResolve(path, .any)) {
            .found => |f| {
                out.* = recordFor(f.loc);
                return 0;
            },
            .missing => return errors.ENOENT,
            .failed => |code| return code,
        }
    }

    /// `stat_fd` — the same record for an open handle (§7.4).
    pub fn statFd(self: *Vfs, fd: i32, out: *StatRecord) i32 {
        out.* = .{ .kind = 0, .size = 0, .flags = 0 };
        const h = self.handle(fd) orelse return errors.EBADF;
        out.* = .{
            .kind = if (h.kind == .directory) KIND_DIRECTORY else KIND_FILE,
            .size = h.stat_size,
            .flags = if (h.compressed) FLAG_COMPRESSED else 0,
        };
        return 0;
    }

    // -- open / close -----------------------------------------------------

    /// `open` (§7.3/§7.5): a handle ≥ 1, or a negative errno. A directory is
    /// `-EISDIR`; a malformed path is `-EINVAL`; the table being full is
    /// `-EMFILE`.
    pub fn open(self: *Vfs, path: []const u8) i32 {
        const f = switch (self.firstResolve(path, .file)) {
            .found => |v| v,
            .missing => return errors.ENOENT,
            .failed => |code| return code,
        };
        const slot = self.freeSlot() orelse return errors.EMFILE;

        var h = Handle{
            .in_use = true,
            .pak = f.pak,
            .kind = f.loc.kind,
            .stat_size = f.loc.size,
            .compressed = f.loc.compression_method != 0,
        };
        if (self.paks[f.pak].openData(f.loc)) |d| {
            // §8.3: a File whose payload spans Buffers is described by its
            // chain; the cache is materialized on the first read or seek.
            if (d.location == .chunked) h.chain = d.location.chunked;
            h.data_abs = d.abs;
            h.data_len = d.len; // stored bytes: what the volume actually holds
            h.stored_len = d.len;
            h.method = f.loc.compression_method; // the entry's method (§6.7)
            // §8.4: the two records must agree, and the fast path is never
            // trusted alone. A stored File carries FORMAT 0 and no compress
            // fields; a compressed File carries FORMAT 2, the same method id
            // and an expanded size that matches the entry's `size`. Anything
            // else — including a method this build cannot decode — is -EIO.
            const clear = @intFromEnum(metadata.StreamFormat.clear_data);
            const comp = @intFromEnum(metadata.StreamFormat.compressed);
            const agrees = if (h.method == 0)
                d.stream_format == clear and d.compress_type == null and d.expanded_size == null
            else
                h.method == 8 and d.stream_format == comp and
                    d.compress_type != null and d.compress_type.? == h.method and
                    d.expanded_size != null and d.expanded_size.? == h.stat_size;
            h.readable = agrees and
                d.stream_type == @intFromEnum(metadata.StreamType.data);

            // What the guest sees is the expanded size (§8.4); reads are
            // bounded by it, and the stored bytes are fetched by `stored_len`.
            if (h.readable and h.method != 0) h.data_len = h.stat_size;
        } else |e| switch (e) {
            // A File with no Data stream opens, but never reads (§11).
            error.NotFound => h.readable = false,
            else => return walk.errnoFor(e),
        }

        self.fds[slot] = h;
        return @intCast(slot + 1);
    }

    /// `close` is idempotent within the table: a second close of an in-range
    /// handle returns 0 again; out-of-range handles are `-EBADF` (§7.3).
    pub fn close(self: *Vfs, fd: i32) i32 {
        if (fd < 1 or fd > MAX_FDS) return errors.EBADF;
        const h = &self.fds[@intCast(fd - 1)];
        // §8.3: the cache is per open; closing frees it. Two handles on the same
        // File share nothing, so this never touches another handle's cache.
        if (h.spans) |spans| {
            self.alloc.free(spans);
            h.spans = null;
        }
        if (h.expanded) |bytes| {
            self.alloc.free(bytes);
            h.expanded = null;
        }
        h.method = 0;
        h.stored_len = 0;
        h.chain = null;
        h.hint = 0;
        h.hint_off = 0;
        h.in_use = false;
        return 0;
    }

    // -- read / seek / tell -----------------------------------------------

    /// `read` (§7.5): short only at end of file; `0` means end of file. A File
    /// whose payload spans Buffers is read chunk by chunk — a request that
    /// crosses a boundary simply loops (§8.3), with no per-byte navigation: a
    /// chunk is consumed to its end and the next index follows from the hint.
    pub fn read(self: *Vfs, fd: i32, dst: []u8) i32 {
        const h = self.handle(fd) orelse return errors.EBADF;
        if (h.kind == .directory) return errors.EISDIR;
        if (!h.readable) return errors.EIO;
        if (h.pos >= h.data_len) return 0;

        if (h.method != 0) return self.readExpanded(h, dst);
        return self.readStored(h, dst, h.data_len);
    }

    /// §8.4: serve a compressed File from its decoded buffer, expanding it on
    /// the first read. A File costs expanded-size memory for the life of the
    /// handle, and the whole File is decoded before the first byte is served —
    /// the known limitation §8.4 records, not a bug.
    fn readExpanded(self: *Vfs, h: *Handle, dst: []u8) i32 {
        if (h.expanded == null) {
            const code = self.expand(h);
            if (code != 0) return code;
        }
        const bytes = h.expanded.?;
        const at: usize = @intCast(h.pos);
        const avail = bytes.len - at;
        var want = dst.len;
        if (want > avail) want = avail;
        if (want == 0) return 0;
        std.mem.copyForwards(u8, dst[0..want], bytes[at..][0..want]);
        h.pos += want;
        return @intCast(want);
    }

    /// Decode the stored bytes into exactly the expanded size. The cursor is
    /// parked at 0 for the fetch and restored afterwards, so the fetch runs
    /// through the ordinary read paths — the chunk chain, the per-open chunk
    /// cache, the single-chunk fast path — and nothing here duplicates them.
    fn expand(self: *Vfs, h: *Handle) i32 {
        const stored_len: usize = @intCast(h.stored_len);
        const compressed = self.alloc.alloc(u8, stored_len) catch return errors.ENOMEM;
        defer self.alloc.free(compressed);
        const saved = h.pos;
        h.pos = 0;
        defer h.pos = saved;

        var got: usize = 0;
        while (got < stored_len) {
            const take = self.readStored(h, compressed[got..], h.stored_len);
            if (take < 0) return take;
            if (take == 0) return errors.EIO; // the chain ended early
            got += @intCast(take);
        }

        const size: usize = @intCast(h.stat_size);
        const expanded = self.alloc.alloc(u8, size) catch return errors.ENOMEM;
        errdefer self.alloc.free(expanded);
        var in = std.Io.Reader.fixed(compressed);
        var window: [flate.max_window_len]u8 = undefined;
        var dc = flate.Decompress.init(&in, .raw, &window);
        var out = std.Io.Writer.fixed(expanded);
        const written = dc.reader.streamRemaining(&out) catch {
            self.alloc.free(expanded);
            return errors.EIO;
        };
        // Short, long, or failed: never serve partial bytes (13.15.7.1's
        // STREAM EXPANDED SIZE is the authority on how many there must be).
        if (written != size) {
            self.alloc.free(expanded);
            return errors.EIO;
        }
        h.expanded = expanded;
        return 0;
    }

    /// The reading half of a stored payload: `limit` bounds it (the File's
    /// total payload for a plain File, the stored length while decoding one).
    fn readStored(self: *Vfs, h: *Handle, dst: []u8, limit: u64) i32 {
        if (h.pos >= limit) return 0;
        var want: u64 = dst.len;
        if (want > limit - h.pos) want = limit - h.pos;
        if (h.chain) |chain| return self.readChunked(h, chain, dst[0..@intCast(want)]);

        const bytes = self.paks[h.pak].reader.read(h.data_abs + h.pos, @intCast(want)) catch |e| {
            return errors.errnoFor(e);
        };
        std.mem.copyForwards(u8, dst[0..bytes.len], bytes);
        h.pos += bytes.len;
        return @intCast(bytes.len);
    }

    /// The reading half of §8.3: copy `want` bytes out of a chunked File,
    /// crossing as many chunk boundaries as it takes. The chunk cache is used
    /// when it exists; a chain too long to cache is re-walked per navigation
    /// (the walker's `locate`), which is the documented cost of a huge chain.
    fn readChunked(self: *Vfs, h: *Handle, chain: walk.Chain, want: []u8) i32 {
        var written: usize = 0;
        while (written < want.len) {
            const off = h.pos + written;
            const place = if (self.cachedSpans(h, chain)) |spans|
                self.spanAt(h, spans, off)
            else
                self.walkTo(h, chain, off);
            const pos = switch (place) {
                .found => |p| p,
                .err => |code| return code,
            };
            var take: u64 = want.len - written;
            const avail: u64 = @as(u64, pos.payload_len) - pos.offset_in_chunk;
            if (take > avail) take = avail;
            if (take == 0) return errors.EIO; // a span that carries nothing
            const from = self.paks[h.pak].reader.read(
                pos.payload_abs + pos.offset_in_chunk,
                @intCast(take),
            ) catch |e| return errors.errnoFor(e);
            std.mem.copyForwards(u8, want[written..][0..from.len], from);
            if (from.len == 0) return errors.EIO; // the reader ran out early
            written += from.len;
        }
        h.pos += written;
        return @intCast(written);
    }

    const Place = union(enum) {
        found: walk.ChunkPos,
        err: i32,
    };

    /// The handle's chunk cache, materialized on first use (§8.3). Returns null
    /// when the chain is longer than MAX_FILE_CHUNKS: caching it is exactly what
    /// the policy forbids, so those Files are re-walked per navigation instead.
    fn cachedSpans(self: *Vfs, h: *Handle, chain: walk.Chain) ?[]CachedSpan {
        if (h.spans) |spans| return spans;
        if (chain.chunk_count > MAX_FILE_CHUNKS) return null;
        const spans = self.alloc.alloc(CachedSpan, chain.chunk_count) catch return null;
        if (self.paks[h.pak].chainSpans(.{ .chunked = chain }, spans)) |_| {
            h.spans = spans;
            h.hint = 0;
            h.hint_off = 0;
            return spans;
        } else |_| {
            self.alloc.free(spans);
            return null;
        }
    }

    /// Find the chunk holding File offset `off` in the cached chain, starting
    /// from the handle's hint: a sequential read advances without a search, and
    /// a seek backwards restarts from chunk 0 (the cold-seek cost §8.3
    /// documents — O(chunks), and no walker call at all).
    fn spanAt(self: *Vfs, h: *Handle, spans: []CachedSpan, off: u64) Place {
        _ = self;
        var i: u32 = h.hint;
        var start: u64 = h.hint_off;
        if (i >= spans.len or off < start) {
            i = 0;
            start = 0;
        }
        while (i < spans.len) : (i += 1) {
            const len: u64 = spans[i].payload_len;
            if (off < start + len) {
                h.hint = i;
                h.hint_off = start;
                return .{ .found = .{
                    .chunk_index = i,
                    .offset_in_chunk = @intCast(off - start),
                    .payload_abs = spans[i].payload_abs,
                    .payload_len = spans[i].payload_len,
                } };
            }
            start += len;
        }
        return .{ .err = errors.EIO }; // the chain does not cover this offset
    }

    /// The uncached path: the walker answers where `off` lives, walking the
    /// chain from chunk 0. Only reached for chains past MAX_FILE_CHUNKS.
    fn walkTo(self: *Vfs, h: *Handle, chain: walk.Chain, off: u64) Place {
        const at = std.math.cast(u32, off) orelse return .{ .err = errors.EINVAL };
        const pos = self.paks[h.pak].locate(.{ .chunked = chain }, at) catch |e| {
            return .{ .err = walk.errnoFor(e) };
        };
        return .{ .found = pos };
    }

    /// `seek` (§7.5): `whence` is `RES_SEEK_SET`/`CUR`/`END`; a negative
    /// result is `-EINVAL`; seeking past end of file is allowed.
    pub fn seek(self: *Vfs, fd: i32, off: i64, whence: u8) i64 {
        const h = self.handle(fd) orelse return errors.EBADF;
        const base: i64 = switch (whence) {
            SEEK_SET => 0,
            SEEK_CUR => std.math.cast(i64, h.pos) orelse return errors.EINVAL,
            SEEK_END => std.math.cast(i64, h.data_len) orelse return errors.EINVAL,
            else => return errors.EINVAL,
        };
        const target = std.math.add(i64, base, off) catch return errors.EINVAL;
        if (target < 0) return errors.EINVAL;
        h.pos = @intCast(target);
        // §8.3: a seek is the other place the cache is materialized, so the
        // first read after a seek needs no walk. Seeks past end of file stay
        // legal (§7.5) — the next read reports end of file.
        if (h.chain) |chain| _ = self.cachedSpans(h, chain);
        return target;
    }

    /// `tell` (§7.5).
    pub fn tell(self: *Vfs, fd: i32) i64 {
        const h = self.handle(fd) orelse return errors.EBADF;
        return std.math.cast(i64, h.pos) orelse errors.EINVAL;
    }

    // -- readdir ----------------------------------------------------------

    /// `readdir` (§7.6). Returns the **full** name length of the child's raw
    /// NS1 name, `0` past the last child, or a negative errno. Writes
    /// `min(name_out.len, len)` bytes — the `tension::io` `arg` convention — so
    /// `name_out.len == 0` is a size probe. No suffix is added: the record's
    /// `kind` carries "directory", and a returned name must round-trip into
    /// `stat`/`open` unchanged (the `/` suffix is a phase-8 formatting rule).
    pub fn readdir(self: *Vfs, path: []const u8, ordinal: u32, name_out: []u8, out: *StatRecord) i32 {
        out.* = .{ .kind = 0, .size = 0, .flags = 0 };
        for (self.paks, 0..) |_, i| {
            const view = self.paks[i].openDir(path) catch |e| {
                const code = walk.errnoFor(e);
                if (code != errors.ENOENT) return code; // precise failures win (§7.2)
                continue;
            };
            return self.scanDir(i, view, ordinal, name_out, out);
        }
        return errors.ENOENT;
    }

    fn scanDir(self: *Vfs, pak: usize, view: index.ChunkView, ordinal: u32, name_out: []u8, out: *StatRecord) i32 {
        const dir_id = view.stream_start;
        var pos: u32 = view.header.entry_area_off;
        var i: u32 = 0;
        if (self.cursor.valid and self.cursor.pak == pak and self.cursor.dir == dir_id) {
            // Ascending enumeration — and the probe/write pair for one index —
            // resume where the last step stopped (§7.6).
            if (self.cursor.index == ordinal) {
                pos = self.cursor.entry_pos;
                i = ordinal;
            } else if (self.cursor.index != std.math.maxInt(u32) and self.cursor.index + 1 == ordinal) {
                pos = self.cursor.next_pos;
                i = ordinal;
            }
        }

        while (true) {
            const step = (view.nextEntry(pos) catch |e| return errors.errnoFor(e)) orelse return 0;
            if (i == ordinal) {
                const e = step.entry;
                const total: usize = e.name.len;
                const n = @min(name_out.len, total);
                std.mem.copyForwards(u8, name_out[0..n], e.name[0..n]);
                out.* = .{
                    .kind = if (e.kind == .directory) KIND_DIRECTORY else KIND_FILE,
                    .size = e.size,
                    .flags = if (e.compression_method != 0) FLAG_COMPRESSED else 0,
                };
                self.cursor = .{
                    .valid = true,
                    .pak = pak,
                    .dir = dir_id,
                    .index = ordinal,
                    .entry_pos = pos,
                    .next_pos = step.next,
                };
                return @intCast(total);
            }
            i += 1;
            pos = step.next;
        }
    }

    // -- internals --------------------------------------------------------

    fn handle(self: *Vfs, fd: i32) ?*Handle {
        if (fd < 1 or fd > MAX_FDS) return null;
        const h = &self.fds[@intCast(fd - 1)];
        if (!h.in_use) return null;
        return h;
    }

    fn freeSlot(self: *const Vfs) ?usize {
        for (&self.fds, 0..) |h, i| {
            if (!h.in_use) return i;
        }
        return null;
    }
};

fn recordFor(loc: walk.Location) StatRecord {
    return .{
        .kind = if (loc.kind == .directory) KIND_DIRECTORY else KIND_FILE,
        .size = loc.size,
        .flags = if (loc.compression_method != 0) FLAG_COMPRESSED else 0,
    };
}

// ---------------------------------------------------------------------------
// Tests for the pieces that do not need a fixture
// ---------------------------------------------------------------------------

const testing = std.testing;

test "the stat record is the 12-byte ABI record" {
    try testing.expectEqual(@as(usize, 12), @sizeOf(StatRecord));
    try testing.expectEqual(@as(usize, 0), @offsetOf(StatRecord, "kind"));
    try testing.expectEqual(@as(usize, 4), @offsetOf(StatRecord, "size"));
    try testing.expectEqual(@as(usize, 8), @offsetOf(StatRecord, "flags"));
}

test "a VFS with no paks misses everything" {
    var vfs = Vfs.noPaks(testing.allocator);
    var rec: StatRecord = undefined;
    try testing.expectEqual(errors.ENOENT, vfs.stat("/", &rec));
    try testing.expectEqual(errors.ENOENT, vfs.stat("a/b", &rec));
    try testing.expectEqual(errors.ENOENT, vfs.open("a"));
    var name: [64]u8 = undefined;
    try testing.expectEqual(errors.ENOENT, vfs.readdir("/", 0, &name, &rec));
}

test "handles are 1-based and the table bounds every operation" {
    var vfs = Vfs.noPaks(testing.allocator);
    var rec: StatRecord = undefined;
    try testing.expectEqual(errors.EBADF, vfs.read(0, &[_]u8{}));
    try testing.expectEqual(errors.EBADF, vfs.read(-1, &[_]u8{}));
    try testing.expectEqual(errors.EBADF, vfs.seek(0, 0, SEEK_SET));
    try testing.expectEqual(errors.EBADF, vfs.tell(0));
    try testing.expectEqual(errors.EBADF, vfs.close(0));
    try testing.expectEqual(errors.EBADF, vfs.close(MAX_FDS + 1));
    try testing.expectEqual(errors.EBADF, vfs.statFd(1, &rec));
    // `close` is idempotent for in-range handles, even unused ones (§7.3).
    try testing.expectEqual(@as(i32, 0), vfs.close(1));
    try testing.expectEqual(@as(i32, 0), vfs.close(1));
}
