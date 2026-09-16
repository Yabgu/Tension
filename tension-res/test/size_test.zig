//! Size family tests (phase 9e): the single-chunk boundary, the Buffer-fill
//! band, and multi-MiB Files read through the VFS.
//!
//! Two rules shape everything here. (1) **No expected chunk count is computed
//! from BUFFER_SIZE or header lengths** (e3): the boundary and the counts come
//! from what the packer and walker actually emitted, and the assertions are
//! properties — "the chain covers exactly N bytes", "chunk_count > 1 above the
//! cap", "touches the cache cap" — which stay true when the fill rule or a
//! header length changes. (2) **A File of a MiB or more is never materialized
//! by the test** (e1): the source is streamed to disk in 64 KiB pieces and the
//! pak is mapped read-only, not read into the heap.

const std = @import("std");
const res = @import("../src/root.zig");
const support = @import("prune_support.zig");
const writer = res.writer;
const walk = res.walk;
const vfs_mod = res.vfs;
const Vfs = vfs_mod.Vfs;
const StatRecord = vfs_mod.StatRecord;
const testing = std.testing;
const io = testing.io;
const page = std.heap.page_size_min;

const MIB: u64 = 1024 * 1024;
const PIECE: usize = 64 * 1024;

/// The deterministic payload the size tests use, as a function of the byte's
/// offset: nothing is stored, so a check costs one multiply and no memory.
/// The payload generator for the size families. It must **not** be
/// compressible: these tests exist to put Files past the per-open chunk cache,
/// and §8.4's threshold would collapse a repeating pattern and quietly end that
/// coverage. The keystream is a pure function of the offset, so the volumes
/// stay byte-reproducible.
fn patternByte(i: u64) u8 {
    return support.keystreamByte(i);
}

fn patternInto(buf: []u8, off: u64) void {
    support.fillKeystream(buf, off);
}

/// Write `len` bytes of the pattern to `path` in 64 KiB pieces: the source File
/// is the one thing a size test must not hold whole (e1).
fn writePattern(path: []const u8, len: u64) !void {
    const file = try std.Io.Dir.cwd().createFile(io, path, .{ .truncate = true });
    defer file.close(io);
    var scratch: [PIECE]u8 = undefined;
    var off: u64 = 0;
    while (off < len) {
        const n: usize = @intCast(@min(@as(u64, scratch.len), len - off));
        patternInto(scratch[0..n], off);
        try file.writePositionalAll(io, scratch[0..n], off);
        off += n;
    }
}

/// A pak mapped read-only. The walker uses the slice for its length; every byte
/// is fetched through the `BlockReader`, which reads the same mapping — so a
/// 100 MiB volume costs address space, not resident memory (§6.8).
const Mapped = struct {
    bytes: []align(page) const u8 = &.{},

    fn open(path: []const u8) !Mapped {
        const file = try std.Io.Dir.cwd().openFile(io, path, .{});
        defer file.close(io);
        const st = try file.stat(io);
        if (st.size == 0) return error.EmptyPak;
        const map = try std.posix.mmap(
            null,
            @intCast(st.size),
            .{ .READ = true },
            .{ .TYPE = .PRIVATE },
            file.handle,
            0,
        );
        return .{ .bytes = map };
    }

    fn close(self: *Mapped) void {
        if (self.bytes.len > 0) std.posix.munmap(self.bytes);
        self.bytes = &.{};
    }
};

/// A scratch source tree and the paks packed from it. `TmpDir.sub_path` is
/// relative to `.zig-cache/tmp`, and the packer takes a cwd-relative path.
const Sig = struct {
    tmp: std.testing.TmpDir,
    alloc: std.mem.Allocator,
    src: []const u8 = &.{},
    out: []const u8 = &.{},

    fn init(alloc: std.mem.Allocator, sub: []const u8) !Sig {
        var s = Sig{ .tmp = std.testing.tmpDir(.{}), .alloc = alloc };
        s.src = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/{s}", .{ s.tmp.sub_path, sub });
        s.out = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/out.tns", .{s.tmp.sub_path});
        try s.tmp.dir.createDirPath(io, sub);
        return s;
    }

    fn deinit(self: *Sig) void {
        self.alloc.free(self.src);
        self.alloc.free(self.out);
        self.tmp.cleanup();
    }

    fn srcPath(self: *Sig, name: []const u8, buf: *[512]u8) ![]const u8 {
        return std.fmt.bufPrint(buf, "{s}/{s}", .{ self.src, name });
    }

    /// A second output path, for the determinism re-pack (e4).
    fn outPath(self: *Sig, name: []const u8, buf: *[512]u8) ![]const u8 {
        return std.fmt.bufPrint(buf, ".zig-cache/tmp/{s}/{s}", .{ self.tmp.sub_path, name });
    }
};

/// A loaded volume: mapping, reader and walker pinned together, because the
/// walker's reader holds a pointer to the reader and the reader to the map.
/// Nothing here may be moved after `load`.
const Volume = struct {
    mapped: Mapped = .{},
    sr: res.block.SliceReader = .{ .bytes = &.{} },
    wk: walk.Walker = undefined,

    fn load(self: *Volume, path: []const u8) !void {
        self.mapped = try Mapped.open(path);
        self.sr = .{ .bytes = self.mapped.bytes };
        self.wk = try walk.Walker.init(self.mapped.bytes, self.sr.blockReader());
    }

    fn deinit(self: *Volume) void {
        self.mapped.close();
    }
};

/// Two paks must hold the same bytes (e4: packing is a pure function of the
/// source tree — no timestamps, no randomness, no filesystem metadata).
fn filesEqual(a: []const u8, b: []const u8) !bool {
    var ma = try Mapped.open(a);
    defer ma.close();
    var mb = try Mapped.open(b);
    defer mb.close();
    if (ma.bytes.len != mb.bytes.len) return false;
    return std.mem.eql(u8, ma.bytes, mb.bytes);
}

/// Read a File end to end through the VFS in 64 KiB pieces and check every byte
/// against the pattern, then check that a read at end of file is 0 (§7.5).
/// The payload is never held whole: two 64 KiB buffers, whatever the size.
fn readAllVerify(vfs: *Vfs, fd: i32, total: u64) !void {
    const alloc = testing.allocator;
    const got_buf = try alloc.alloc(u8, PIECE);
    defer alloc.free(got_buf);
    const want_buf = try alloc.alloc(u8, PIECE);
    defer alloc.free(want_buf);

    var off: u64 = 0;
    while (off < total) {
        const n: usize = @intCast(@min(@as(u64, PIECE), total - off));
        const got = vfs.read(fd, got_buf[0..n]);
        if (got <= 0) return error.ShortRead;
        try testing.expectEqual(n, @as(usize, @intCast(got)));
        patternInto(want_buf[0..n], off);
        try testing.expectEqualSlices(u8, want_buf[0..n], got_buf[0..n]);
        off += n;
    }
    try testing.expectEqual(@as(i32, 0), vfs.read(fd, got_buf[0..1]));
}

/// The File's payload total, summed from the chain the walker describes (e3
/// step 3): the property is "the chain covers exactly N bytes", never a
/// predicted chunk count.
fn chainPayloadTotal(vol: *Volume, loc: walk.Location, alloc: std.mem.Allocator) !u64 {
    const stream = try vol.wk.openData(loc);
    const chain = switch (stream.location) {
        .chunked => |c| c,
        .single => return stream.len,
    };
    const spans = try alloc.alloc(walk.ChunkSpan, chain.chunk_count);
    defer alloc.free(spans);
    _ = try vol.wk.chainSpans(.{ .chunked = chain }, spans);
    var sum: u64 = 0;
    for (spans) |sp| sum += sp.payload_len;
    return sum;
}

// --- the single-chunk boundary ---------------------------------------------

/// Does the packer split a File of `size` bytes? Answered by packing it and
/// asking the walker — the only source of truth for the boundary (e3).
fn probeChunked(alloc: std.mem.Allocator, sig: *Sig, size: usize) !bool {
    var names: [2][512]u8 = undefined;
    const src = try sig.srcPath("probe.bin", &names[0]);
    const out = try sig.outPath("probe.tns", &names[1]);
    try writePattern(src, size);
    _ = try writer.pack(alloc, sig.src, out, null);
    var vol: Volume = .{};
    try vol.load(out);
    defer vol.deinit();
    const loc = try vol.wk.resolve("probe.bin", .file);
    const stream = try vol.wk.openData(loc);
    return stream.location == .chunked;
}

test "the single-chunk boundary: cap-1, cap, cap+1, and the Buffer-fill band" {
    const alloc = testing.allocator;
    var sig = try Sig.init(alloc, "cap");
    defer sig.deinit();

    // e3: the boundary comes from the packer. Double until a payload is split,
    // walk down to the first split payload, then climb past the band to the
    // payload that fills a Buffer exactly — single again, because an
    // exactly-full Buffer needs no Blank Space FT (13.3).
    // Find a chunked size, then walk down to the first one above a single: that
    // single is the payload which fills a Buffer exactly (need == BUFFER SIZE),
    // and it is *single* because an exactly-full Buffer needs no Blank Space FT
    // (13.3). Below it sits a run of chunked sizes — the band, where the File
    // would leave its Buffer with fewer bytes than a Blank Space FT needs — and
    // the run ends at the largest File that leaves a Buffer with room to spare.
    // Every number here comes from the packer (e3); nothing is arithmetic on
    // BUFFER_SIZE or header lengths, and both walks are bounded, because a
    // boundary search that cannot terminate writes ever-larger Files.
    var probe: usize = 1;
    while (!try probeChunked(alloc, &sig, probe)) probe *= 2;
    while (probe > 1 and try probeChunked(alloc, &sig, probe - 1)) probe -= 1;
    const first_chunked = probe;
    const exact_full = first_chunked - 1;
    // The band sits directly below the exactly-full size, so the scan starts
    // there: it walks down while sizes are split, and stops on the largest File
    // that leaves its Buffer with room to spare.
    var band_low = exact_full;
    var steps: usize = 0;
    while (steps < 64 and band_low > 1 and try probeChunked(alloc, &sig, band_low - 1)) : (steps += 1) band_low -= 1;
    try testing.expect(steps < 64); // it ended on a single, not on the bound

    try testing.expect(first_chunked > 1);
    try testing.expect(band_low >= 2);
    try testing.expect(band_low + 1 <= exact_full); // the band is a run of sizes
    std.debug.print(
        "9e: boundary with_room={d} band=[{d}..{d}] exact_full={d} first_chunked={d}\n",
        .{ band_low - 1, band_low, exact_full - 1, exact_full, first_chunked },
    );

    const sizes = [_]usize{
        band_low - 1, // the largest File that leaves a Buffer with room to spare
        band_low, // the first size of the band: chunked
        first_chunked, // just above the exactly-full size: chunked
        first_chunked + 1, // and still chunked
        exact_full, // exactly fills the Buffer: single
    };
    for (sizes) |size| {
        // Single only at the two derived sizes; every size in between and above
        // the band is chunked.
        const want_chunked = size != band_low - 1 and size != exact_full;
        var names: [2][512]u8 = undefined;
        const src = try sig.srcPath("probe.bin", &names[0]);
        const out = try sig.outPath("probe.tns", &names[1]);
        try writePattern(src, size);
        _ = try writer.pack(alloc, sig.src, out, null);

        var vol: Volume = .{};
        try vol.load(out);
        defer vol.deinit();

        const loc = try vol.wk.resolve("probe.bin", .file);
        const stream = try vol.wk.openData(loc);
        try testing.expectEqual(@as(u32, @intCast(size)), stream.len);
        try testing.expectEqual(want_chunked, stream.location == .chunked);

        // The chain, if any, covers exactly this many bytes (e3).
        const covered = try chainPayloadTotal(&vol, loc, alloc);
        try testing.expectEqual(@as(u64, @intCast(size)), covered);
        if (want_chunked) {
            try testing.expect(stream.location.chunked.chunk_count > 1);
        }

        // locate(): the ends behave per variant. A chunked File refuses the
        // offset *at* its total; a single-chunk File accepts it as the EOF
        // position, and both refuse one past.
        const at = @as(u32, @intCast(size));
        try testing.expectEqual(@as(u32, 0), (try vol.wk.locate(stream.location, 0)).chunk_index);
        try testing.expect((try vol.wk.locate(stream.location, at - 1)).offset_in_chunk < at);
        if (want_chunked) {
            try testing.expectError(error.Invalid, vol.wk.locate(stream.location, at));
        } else {
            const eof = try vol.wk.locate(stream.location, at);
            try testing.expectEqual(at, eof.offset_in_chunk);
        }
        try testing.expectError(error.Invalid, vol.wk.locate(stream.location, at + 1));

        // Through the VFS: every byte, then EOF.
        var paks = [_]walk.Walker{vol.wk};
        var vfs = Vfs.init(&paks, alloc);
        const fd = vfs.open("probe.bin");
        try testing.expect(fd >= 1);
        try readAllVerify(&vfs, fd, size);
        try testing.expectEqual(@as(i32, 0), vfs.close(fd));

        // e4: the same tree packs to the same bytes.
        const out2 = try sig.outPath("probe2.tns", &names[0]);
        _ = try writer.pack(alloc, sig.src, out2, null);
        try testing.expect(try filesEqual(out, out2));
    }
}

// --- the uncached path at scale --------------------------------------------

test "8 MiB at this pak's Buffer size: the chain exceeds the cache cap" {
    const alloc = testing.allocator;
    var sig = try Sig.init(alloc, "uncached");
    defer sig.deinit();
    var names: [2][512]u8 = undefined;
    const src = try sig.srcPath("big.bin", &names[0]);
    const out = try sig.outPath("big.tns", &names[1]);

    const total: u64 = 8 * MIB;
    try writePattern(src, total);
    _ = try writer.pack(alloc, sig.src, out, null);

    var vol: Volume = .{};
    try vol.load(out);
    defer vol.deinit();
    const loc = try vol.wk.resolve("big.bin", .file);
    const stream = try vol.wk.openData(loc);
    const chain = switch (stream.location) {
        .chunked => |c| c,
        .single => return error.ExpectedChunked,
    };
    try testing.expectEqual(@as(u32, @intCast(total)), chain.total_size);
    // The premise of this test, asserted rather than assumed: at this Buffer
    // size an 8 MiB File needs more chunks than the cache will hold (§8.3).
    try testing.expect(chain.chunk_count > vfs_mod.MAX_FILE_CHUNKS);
    try testing.expectEqual(total, try chainPayloadTotal(&vol, loc, alloc));
    std.debug.print(
        "9e: 8 MiB: buffer_size={d} chunks={d} (cap {d}) uncached\n",
        .{ vol.wk.buffer_size, chain.chunk_count, vfs_mod.MAX_FILE_CHUNKS },
    );

    var paks = [_]walk.Walker{vol.wk};
    var vfs = Vfs.init(&paks, alloc);
    const fd = vfs.open("big.bin");
    try testing.expect(fd >= 1);

    // The whole payload, byte for byte, with no cache behind it.
    try readAllVerify(&vfs, fd, total);
    try testing.expect(vfs.fds[@intCast(fd - 1)].spans == null);

    try testing.expect(vfs.fds[@intCast(fd - 1)].chain != null);

    const last = total - 1;
    try testing.expectEqual(@as(i64, last), vfs.seek(fd, last, vfs_mod.SEEK_SET));
    var one: [1]u8 = undefined;
    try testing.expectEqual(@as(i32, 1), vfs.read(fd, &one));
    try testing.expectEqual(patternByte(last), one[0]);
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));

    // e4 at this size too.
    const out2 = try sig.outPath("big2.tns", &names[0]);
    _ = try writer.pack(alloc, sig.src, out2, null);
    try testing.expect(try filesEqual(out, out2));
}

test "8 MiB uncached: a cold seek walks, and so does a repeat of it" {
    const alloc = testing.allocator;
    var sig = try Sig.init(alloc, "coldseek");
    defer sig.deinit();
    var names: [2][512]u8 = undefined;
    const src = try sig.srcPath("big.bin", &names[0]);
    const out = try sig.outPath("big.tns", &names[1]);

    const total: u64 = 8 * MIB;
    try writePattern(src, total);
    _ = try writer.pack(alloc, sig.src, out, null);

    // The recorder has to *be* the reader the walker was built on, so the
    // volume is assembled here rather than through `Volume.load`: the mapping,
    // the recorder and the walker are pinned in this frame (the walker's reader
    // holds a pointer to the recorder).
    var map = try Mapped.open(out);
    defer map.close();
    var rec: support.Recorder = undefined;
    rec.inner = .{ .bytes = map.bytes };
    rec.reset();
    const wk = try walk.Walker.init(map.bytes, rec.reader());
    try testing.expect(wk.buffer_size > 0);

    const loc = try wk.resolve("big.bin", .file);
    const stream = try wk.openData(loc);
    const chain = switch (stream.location) {
        .chunked => |c| c,
        .single => return error.ExpectedChunked,
    };
    try testing.expect(chain.chunk_count > vfs_mod.MAX_FILE_CHUNKS);

    var paks = [_]walk.Walker{wk};
    var vfs = Vfs.init(&paks, alloc);
    const fd = vfs.open("big.bin");
    try testing.expect(fd >= 1);
    try testing.expect(vfs.fds[@intCast(fd - 1)].spans == null);

    // Navigation to a far offset costs a walk from chunk 0, and a repeat of the
    // same offset costs the *same* walk: there is no cache to hit, and a seek
    // alone moves only the cursor, so the read is what walks. Identical counts
    // are the proof that nothing was remembered between the two.
    const near = total - 5;
    var tail: [3]u8 = undefined;
    try testing.expectEqual(@as(i64, near), vfs.seek(fd, near, vfs_mod.SEEK_SET));
    rec.reset();
    try testing.expectEqual(@as(i32, 3), vfs.read(fd, &tail));
    const cold_1 = rec.count;
    try testing.expectEqual(patternByte(near), tail[0]);
    try testing.expectEqual(patternByte(near + 2), tail[2]);

    try testing.expectEqual(@as(i64, near), vfs.seek(fd, near, vfs_mod.SEEK_SET));
    rec.reset();
    try testing.expectEqual(@as(i32, 3), vfs.read(fd, &tail));
    const cold_2 = rec.count;

    // MAX_LOG = 8192 saturates this count: the real number of reads is larger.
    // The equality below proves nothing was cached (the repeat walked again);
    // the magnitude of the walk is not measured by this test.
    try testing.expect(cold_1 > 0);
    try testing.expectEqual(cold_1, cold_2); // no cache: the repeat walks it all again
    std.debug.print(
        "9e: 8 MiB uncached: read at the far offset {d} reads, repeat {d} reads\n",
        .{ cold_1, cold_2 },
    );
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));
}

// --- large, cached Files ----------------------------------------------------

/// A File of `size` bytes in a tree whose Buffer size keeps its chain cached:
/// a directory with many children inflates the Buffer the packer must allocate
/// for that directory's index (§8.2), and a bigger Buffer means fewer chunks.
/// The suite reports what came out instead of assuming it.
fn largeCachedCase(alloc: std.mem.Allocator, sub: []const u8, size: u64) !void {
    var sig = try Sig.init(alloc, sub);
    defer sig.deinit();

    const many = try std.fmt.allocPrint(alloc, "{s}/many", .{sig.src});
    defer alloc.free(many);
    try std.Io.Dir.cwd().createDirPath(io, many);
    var child: [64]u8 = undefined;
    var i: usize = 0;
    while (i < 800) : (i += 1) {
        const name = try std.fmt.bufPrint(&child, "{s}/f{d:0>5}.bin", .{ many, i });
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = name, .data = "tiny\n" });
    }

    var names: [2][512]u8 = undefined;
    const src = try sig.srcPath("big.bin", &names[0]);
    const out = try sig.outPath("big.tns", &names[1]);
    try writePattern(src, size);
    _ = try writer.pack(alloc, sig.src, out, null);

    var vol: Volume = .{};
    try vol.load(out);
    defer vol.deinit();
    const loc = try vol.wk.resolve("big.bin", .file);
    const stream = try vol.wk.openData(loc);
    const chain = switch (stream.location) {
        .chunked => |c| c,
        .single => return error.ExpectedChunked,
    };
    try testing.expectEqual(@as(u32, @intCast(size)), chain.total_size);
    try testing.expect(chain.chunk_count > 1);
    try testing.expectEqual(size, try chainPayloadTotal(&vol, loc, alloc));
    std.debug.print(
        "9e: {d} MiB: buffer_size={d} chunks={d} cap={d} cached={}\n",
        .{ size / MIB, vol.wk.buffer_size, chain.chunk_count, vfs_mod.MAX_FILE_CHUNKS, chain.chunk_count <= vfs_mod.MAX_FILE_CHUNKS },
    );

    var paks = [_]walk.Walker{vol.wk};
    var vfs = Vfs.init(&paks, alloc);
    const fd = vfs.open("big.bin");
    try testing.expect(fd >= 1);

    // The whole payload, byte for byte (the cache makes this linear).
    // Cache presence asserted via spans != null; cold/warm read-count behavior
    // is verified in the 9c VFS test at a smaller size.
    try readAllVerify(&vfs, fd, size);
    const cached = chain.chunk_count <= vfs_mod.MAX_FILE_CHUNKS;
    if (cached) {
        try testing.expect(vfs.fds[@intCast(fd - 1)].spans != null);
    }
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));

    // e4: byte-identical repack at this size.
    const out2 = try sig.outPath("big2.tns", &names[0]);
    _ = try writer.pack(alloc, sig.src, out2, null);
    try testing.expect(try filesEqual(out, out2));
}

test "20 MiB File: chunked, byte-identical round trip" {
    try largeCachedCase(testing.allocator, "m20", 20 * MIB);
}

test "100 MiB File: chunked, byte-identical round trip" {
    try largeCachedCase(testing.allocator, "m100", 100 * MIB);
}
