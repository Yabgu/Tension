//! Packer tests (phase 7): round-trip through the reader, determinism, the
//! byte-identity check against the committed `minimal.sidf`, and the error
//! table. Source trees are built in a `std.testing.tmpDir`, so nothing here
//! touches the repository.

const std = @import("std");
const res = @import("../src/root.zig");
const writer = res.writer;
const vfs_mod = res.vfs;
const walk = res.walk;
const c_api = res.c_api;
const fields = res.fields;
const support = @import("prune_support.zig");
const testing = std.testing;
const io = testing.io;

const PAYLOAD = "hello\n";

// --- helpers ---------------------------------------------------------------

fn readFileAll(alloc: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = try std.Io.Dir.cwd().openFile(io, path, .{});
    defer file.close(io);
    const st = try file.stat(io);
    const buf = try alloc.alloc(u8, @intCast(st.size));
    var off: u64 = 0;
    while (off < buf.len) {
        const n = try std.Io.File.readPositionalAll(file, io, buf[@intCast(off)..], off);
        if (n == 0) break;
        off += n;
    }
    return buf[0..@intCast(off)];
}

const Scratch = struct {
    tmp: std.testing.TmpDir,
    alloc: std.mem.Allocator,
    src: []const u8 = &.{},
    out: []const u8 = &.{},

    /// `TmpDir.sub_path` is relative to `.zig-cache/tmp`, and the packer takes
    /// a path relative to the process's cwd — so the base is spelled out here.
    fn init(alloc: std.mem.Allocator, sub: []const u8) !Scratch {
        var s = Scratch{ .tmp = std.testing.tmpDir(.{}), .alloc = alloc };
        s.src = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/{s}", .{ s.tmp.sub_path, sub });
        s.out = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/out.tns", .{s.tmp.sub_path});
        return s;
    }

    fn deinit(self: *Scratch) void {
        self.alloc.free(self.src);
        self.alloc.free(self.out);
        self.tmp.cleanup();
    }

    fn dirPath(self: *Scratch, sub: []const u8) ![]const u8 {
        return std.fmt.allocPrint(self.alloc, "{s}/{s}", .{ self.src, sub });
    }
};

/// Load a packed image into a VFS (the same shape the C ABI produces).
const Harness = struct {
    sr: res.block.SliceReader,
    paks: [1]walk.Walker,
    vfs: vfs_mod.Vfs,

    fn init(h: *Harness, bytes: []const u8) !void {
        h.sr = .{ .bytes = bytes };
        h.paks = .{try walk.Walker.init(bytes, h.sr.blockReader())};
        h.vfs = vfs_mod.Vfs.init(&h.paks, std.testing.allocator);
    }
};

// --- the conformance check -------------------------------------------------

test "packing the fixture's source tree reproduces minimal.sidf byte for byte" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/hello.txt", .data = PAYLOAD });

    const stats = try writer.pack(alloc, sc.src, sc.out, null);
    try testing.expectEqual(@as(usize, 1), stats.files);
    try testing.expectEqual(@as(usize, 1), stats.directories);

    const produced = try readFileAll(alloc, sc.out);
    defer alloc.free(produced);
    const expected = @embedFile("fixtures/minimal.sidf");

    if (!std.mem.eql(u8, produced, expected)) {
        var i: usize = 0;
        while (i < @min(produced.len, expected.len) and produced[i] == expected[i]) : (i += 1) {}
        std.debug.print(
            "minimal.sidf diverges at byte {d}: produced {d} bytes, expected {d} (produced={d}, expected={d})\n",
            .{
                i, produced.len, expected.len,
                if (i < produced.len) produced[i] else 0,
                if (i < expected.len) expected[i] else 0,
            },
        );
        return error.FixtureDiverged;
    }
    try testing.expectEqual(@as(usize, 5632), produced.len);
}

// --- round trip ------------------------------------------------------------

/// <src>/a.txt, <src>/z.txt (empty), <src>/sub/b.txt, <src>/sub/empty/
fn buildTree(sc: *Scratch) !void {
    try sc.tmp.dir.createDirPath(io, "assets/sub/empty");
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/a.txt", .data = "alpha" });
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/z.txt", .data = "" });
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/sub/b.txt", .data = "bravo-bravo" });
}

test "a packed tree round-trips through the reader" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try buildTree(&sc);

    const stats = try writer.pack(alloc, sc.src, sc.out, null);
    try testing.expectEqual(@as(usize, 3), stats.directories);
    try testing.expectEqual(@as(usize, 3), stats.files);

    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);
    var h: Harness = undefined;
    try Harness.init(&h, image);

    // Root listing, NS1 order, raw names: a.txt, sub, z.txt.
    var name: [64]u8 = undefined;
    var rec: vfs_mod.StatRecord = undefined;
    const want = [_][]const u8{ "a.txt", "sub", "z.txt" };
    for (want, 0..) |w, i| {
        const n = h.vfs.readdir("/", @intCast(i), &name, &rec);
        try testing.expectEqual(@as(i32, @intCast(w.len)), n);
        try testing.expectEqualStrings(w, name[0..@intCast(n)]);
    }
    try testing.expectEqual(@as(i32, 0), h.vfs.readdir("/", 3, &name, &rec));

    // Every file's bytes.
    const expect = [_]struct { path: []const u8, bytes: []const u8 }{
        .{ .path = "a.txt", .bytes = "alpha" },
        .{ .path = "sub/b.txt", .bytes = "bravo-bravo" },
        .{ .path = "z.txt", .bytes = "" },
    };
    for (expect) |e| {
        const fd = h.vfs.open(e.path);
        try testing.expect(fd >= 1);
        var buf: [64]u8 = undefined;
        const n = h.vfs.read(fd, &buf);
        try testing.expectEqual(@as(i32, @intCast(e.bytes.len)), n);
        try testing.expectEqualStrings(e.bytes, buf[0..@intCast(n)]);
        try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
        // stat agrees with the length we just read.
        var st: vfs_mod.StatRecord = undefined;
        try testing.expectEqual(@as(i32, 0), h.vfs.stat(e.path, &st));
        try testing.expectEqual(@as(u32, @intCast(e.bytes.len)), st.size);
        try testing.expectEqual(vfs_mod.KIND_FILE, st.kind);
    }

    // The empty directory exists and enumerates as empty.
    try testing.expectEqual(@as(i32, 0), h.vfs.stat("sub/empty", &rec));
    try testing.expectEqual(vfs_mod.KIND_DIRECTORY, rec.kind);
    try testing.expectEqual(@as(i32, 0), h.vfs.readdir("sub/empty", 0, &name, &rec));
    try testing.expectEqual(@as(i32, 0), h.vfs.stat("sub", &rec));
    try testing.expectEqual(vfs_mod.KIND_DIRECTORY, rec.kind);

    // The reader's own lookup path agrees.
    const loc = try h.paks[0].lookup("sub/b.txt");
    try testing.expectEqual(@as(u32, "bravo-bravo".len), loc.size);
}

test "packing is deterministic" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try buildTree(&sc);

    const out2 = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/out2.tns", .{sc.tmp.sub_path});
    defer alloc.free(out2);

    _ = try writer.pack(alloc, sc.src, sc.out, null);
    _ = try writer.pack(alloc, sc.src, out2, null);

    const a = try readFileAll(alloc, sc.out);
    defer alloc.free(a);
    const b = try readFileAll(alloc, out2);
    defer alloc.free(b);
    try testing.expectEqualSlices(u8, a, b);
}

test "a large directory grows the index chunk payload and still round-trips" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");

    // 400 children with 40-byte names: the §6.7 stream outgrows the 512-byte
    // starting chunk payload, so `buildIndex` has to grow it (§8.2).
    const n = 400;
    var nbuf: [64]u8 = undefined;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const name = try std.fmt.bufPrint(&nbuf, "file-with-a-long-name-{d:0>21}", .{i});
        const path = try std.fmt.allocPrint(alloc, "assets/{s}", .{name});
        defer alloc.free(path);
        try sc.tmp.dir.writeFile(io, .{ .sub_path = path, .data = "x" });
    }

    const stats = try writer.pack(alloc, sc.src, sc.out, null);
    try testing.expectEqual(@as(usize, n), stats.files);

    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);
    var h: Harness = undefined;
    try Harness.init(&h, image);

    // The chunk payload really did grow, and every child resolves.
    const view = try h.paks[0].openDir("/");
    try testing.expect(view.header.chunk_payload > writer.INDEX_CHUNK_MIN);
    i = 0;
    while (i < n) : (i += 1) {
        const name = try std.fmt.bufPrint(&nbuf, "file-with-a-long-name-{d:0>21}", .{i});
        const fd = h.vfs.open(name);
        try testing.expect(fd >= 1);
        try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
    }
}

test "a symlink is packed as a regular file" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/target.txt", .data = "linked-bytes" });
    sc.tmp.dir.symLink(io, "target.txt", "assets/link.txt", .{}) catch |e| switch (e) {
        error.PermissionDenied, error.AccessDenied => return, // sandbox: nothing to prove
        else => return e,
    };

    const stats = try writer.pack(alloc, sc.src, sc.out, null);
    try testing.expectEqual(@as(usize, 2), stats.files);

    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);
    var h: Harness = undefined;
    try Harness.init(&h, image);

    var rec: vfs_mod.StatRecord = undefined;
    try testing.expectEqual(@as(i32, 0), h.vfs.stat("link.txt", &rec));
    try testing.expectEqual(vfs_mod.KIND_FILE, rec.kind); // resolved, not a link
    try testing.expectEqual(@as(u32, "linked-bytes".len), rec.size);
    const fd = h.vfs.open("link.txt");
    try testing.expect(fd >= 1);
    var buf: [32]u8 = undefined;
    const got = h.vfs.read(fd, &buf);
    try testing.expectEqualStrings("linked-bytes", buf[0..@intCast(got)]);
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
}

// --- errors ----------------------------------------------------------------

test "the packer reports missing and mistyped sources as errors" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");
    // A regular file sitting where a directory should be, and a missing path.
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/plain.txt", .data = "not a directory" });

    const missing = try sc.dirPath("does-not-exist");
    defer alloc.free(missing);
    try testing.expectError(error.NotFound, writer.pack(alloc, missing, sc.out, null));

    const plain = try sc.dirPath("plain.txt");
    defer alloc.free(plain);
    try testing.expectError(error.NotDir, writer.pack(alloc, plain, sc.out, null));
}

test "tension_res_pack maps pack failures to the ABI errno table" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/hello.txt", .data = PAYLOAD });

    var err: [128]u8 = undefined;
    const out_z = try alloc.dupeZ(u8, sc.out);
    defer alloc.free(out_z);
    const src_z = try alloc.dupeZ(u8, sc.src);
    defer alloc.free(src_z);
    const out_ptr: [*:0]const u8 = out_z.ptr;
    const src_ptr: [*:0]const u8 = src_z.ptr;

    // Success through the C ABI: 0, and the file exists with the fixture bytes.
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_pack(src_ptr, out_ptr, &err, err.len));
    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);
    try testing.expectEqualSlices(u8, @embedFile("fixtures/minimal.sidf"), image);

    // A missing source is -ENOENT with a message.
    var missing: [64]u8 = undefined;
    const missing_path = try std.fmt.bufPrintZ(&missing, "{s}/nope", .{sc.src});
    try testing.expectEqual(@as(i32, -2), c_api.tension_res_pack(missing_path.ptr, out_ptr, &err, err.len));
    try testing.expect(std.mem.indexOfScalar(u8, &err, 0) != null);
    try testing.expect(err[0] != 0);

    // A null argument is -EINVAL, never a crash.
    try testing.expectEqual(@as(i32, -22), c_api.tension_res_pack(null, out_ptr, &err, err.len));
    try testing.expectEqual(@as(i32, -22), c_api.tension_res_pack(src_ptr, null, &err, err.len));
}

// --- 10: per-File compression (§8.4) ----------------------------------------

test "compression: Deflate for a compressible File, stored for an incompressible one" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");

    const compressible = try alloc.alloc(u8, 4096);
    defer alloc.free(compressible);
    @memset(compressible, 'A'); // Deflate takes this to a tiny fraction
    const incompressible = try alloc.alloc(u8, 4096);
    defer alloc.free(incompressible);
    support.fillKeystream(incompressible, 0); // and cannot touch this

    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/compressible.bin", .data = compressible });
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/incompressible.bin", .data = incompressible });
    _ = try writer.pack(alloc, sc.src, sc.out, null);

    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);
    var h: Harness = undefined;
    try Harness.init(&h, image);

    // The decision, read back out of the volume: both halves are recorded, in
    // the index entry (§6.7) and in the Stream Header (13.15.7.1), and they
    // agree.
    const c_loc = try h.paks[0].resolve("compressible.bin", .file);
    try testing.expectEqual(@as(u16, 8), c_loc.compression_method); // PKWARE APPNOTE: 8 = Deflate
    const c_stream = try h.paks[0].openData(c_loc);
    try testing.expectEqual(@as(u8, 2), c_stream.stream_format); // 13.15.7.4: compressed data
    try testing.expectEqual(@as(?u16, 8), c_stream.compress_type);
    try testing.expectEqual(@as(?u64, 4096), c_stream.expanded_size); // the guest-visible size
    try testing.expect(c_stream.len < 4096); // STREAM SIZE is the stored bytes
    try testing.expectEqual(@as(u32, 4096), c_loc.size);

    const i_loc = try h.paks[0].resolve("incompressible.bin", .file);
    try testing.expectEqual(@as(u16, 0), i_loc.compression_method);
    const i_stream = try h.paks[0].openData(i_loc);
    try testing.expectEqual(@as(u8, 0), i_stream.stream_format); // clear data
    try testing.expectEqual(@as(?u16, null), i_stream.compress_type);
    try testing.expectEqual(@as(?u64, null), i_stream.expanded_size);

    // Both read back expanded, byte for byte, through the VFS.
    const fd = h.vfs.open("compressible.bin");
    try testing.expect(fd >= 1);
    var buf: [64]u8 = undefined;
    var off: usize = 0;
    while (off < compressible.len) {
        const n = h.vfs.read(fd, &buf);
        try testing.expect(n > 0);
        try testing.expectEqualSlices(u8, compressible[off..][0..@intCast(n)], buf[0..@intCast(n)]);
        off += @intCast(n);
    }
    try testing.expectEqual(@as(i32, 0), h.vfs.read(fd, &buf)); // end of file
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));

    const fd2 = h.vfs.open("incompressible.bin");
    try testing.expectEqual(@as(i32, 64), h.vfs.read(fd2, &buf));
    try testing.expectEqualSlices(u8, incompressible[0..64], buf[0..64]);
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd2));

    // Determinism with compression in the picture.
    const out2 = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/out2.tns", .{sc.tmp.sub_path});
    defer alloc.free(out2);
    _ = try writer.pack(alloc, sc.src, out2, null);
    const again = try readFileAll(alloc, out2);
    defer alloc.free(again);
    try testing.expectEqualSlices(u8, image, again);
}

// --- 9b: the chunk chain ---------------------------------------------------

test "a multi-chunk File resolves to .chunked and locate walks its chain" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");

    // Bigger than one Buffer, so the packer splits it (§8.3). No flag, no
    // refusal: this is the only behaviour the packer has.
    // Incompressible on purpose: this test needs the File to span Buffers, and
    // a compressible payload would shrink under §8.4's threshold.
    const payload = try alloc.alloc(u8, 6000);
    defer alloc.free(payload);
    support.fillKeystream(payload, 0);
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/big.bin", .data = payload });

    _ = try writer.pack(alloc, sc.src, sc.out, null);
    // Determinism: the same tree packs to the same bytes, chunking included.
    const out2 = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/out2.tns", .{sc.tmp.sub_path});
    defer alloc.free(out2);
    _ = try writer.pack(alloc, sc.src, out2, null);
    {
        const a = try readFileAll(alloc, sc.out);
        defer alloc.free(a);
        const bb = try readFileAll(alloc, out2);
        defer alloc.free(bb);
        try testing.expectEqualSlices(u8, a, bb);
    }

    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);
    var sr = res.block.SliceReader{ .bytes = image };
    const w = try walk.Walker.init(image, sr.blockReader());

    const loc = try w.resolve("big.bin", .file);
    const stream = try w.openData(loc);
    try testing.expectEqual(@as(u32, @intCast(payload.len)), stream.len);

    const chain = switch (stream.location) {
        .chunked => |c| c,
        .single => return error.ExpectedChunked,
    };
    try testing.expect(chain.chunk_count >= 2);
    try testing.expectEqual(@as(u32, @intCast(payload.len)), chain.total_size);
    try testing.expectEqual(loc.buffer_address, chain.first.buffer_address);
    try testing.expectEqual(loc.buffer_offset, chain.first.buffer_offset);
    try testing.expect(chain.first.chunk_size > 0);
    std.debug.print(
        "9b: {d}-byte File -> {d} chunks, first chunk {d} File Space bytes\n",
        .{ payload.len, chain.chunk_count, chain.first.chunk_size },
    );

    // locate: offset 0 and one byte in are in chunk 0. The position carries the
    // chunk's payload span too (§8.3) — that is what the VFS reads from.
    const expectPos = struct {
        fn check(wk: *const walk.Walker, file_loc: walk.FileLocation, off: u32, index: u32, in_chunk: u32) !void {
            const q = try wk.locate(file_loc, off);
            try testing.expectEqual(index, q.chunk_index);
            try testing.expectEqual(in_chunk, q.offset_in_chunk);
            try testing.expect(q.payload_len > 0);
            try testing.expect(q.payload_abs > 0);
        }
    }.check;
    try expectPos(&w, stream.location, 0, 0, 0);
    try expectPos(&w, stream.location, 1, 0, 1);

    // Find the chunk-0/chunk-1 boundary by walking offsets, then assert both
    // sides of it plus a byte inside chunk 1.
    var boundary: u32 = 0;
    var off: u32 = 0;
    while (off < @as(u32, @intCast(payload.len))) : (off += 1) {
        const pos = try w.locate(stream.location, off);
        if (pos.chunk_index == 1) {
            boundary = off;
            break;
        }
    }
    try testing.expect(boundary > 0);
    try expectPos(&w, stream.location, boundary, 1, 0);
    try expectPos(&w, stream.location, boundary - 1, 0, boundary - 1);
    try expectPos(&w, stream.location, boundary + 1, 1, 1);
    // The ends are out of range.
    try testing.expectError(error.Invalid, w.locate(stream.location, @intCast(payload.len)));
    try testing.expectError(error.Invalid, w.locate(stream.location, @intCast(payload.len + 1)));

    // An inconsistent chain is refused: corrupt the first continuation's FILE
    // CHUNK SIZE (#0B) so it cannot cover its own headers.
    const chunk1_off: usize = @intCast(loc_abs(&w, loc) + w.buffer_size);
    const fcs_at = chunk1_off + 2 + 1 + 2 + 1 + 1; // FID + len + resync + FID + len
    fields.writeUintLe(image[fcs_at..][0..4], 1);
    var sr2 = res.block.SliceReader{ .bytes = image };
    const w2 = try walk.Walker.init(image, sr2.blockReader());
    const loc2 = try w2.resolve("big.bin", .file);
    try testing.expectError(error.Invalid, w2.openData(loc2));
}

test "a chain whose last chunk does not close with a Stream Trailer is refused" {
    const alloc = testing.allocator;
    var sc = try Scratch.init(alloc, "assets");
    defer sc.deinit();
    try sc.tmp.dir.createDirPath(io, "assets");

    // Incompressible on purpose: this test needs the File to span Buffers, and
    // a compressible payload would shrink under §8.4's threshold.
    const payload = try alloc.alloc(u8, 6000);
    defer alloc.free(payload);
    support.fillKeystream(payload, 0);
    try sc.tmp.dir.writeFile(io, .{ .sub_path = "assets/big.bin", .data = payload });

    _ = try writer.pack(alloc, sc.src, sc.out, null);

    const image = try readFileAll(alloc, sc.out);
    defer alloc.free(image);

    // Everything the test needs to know comes from the walker: the file's
    // location, the chain's shape, and which chunk holds the last byte. No
    // layout is recomputed by hand.
    var sr = res.block.SliceReader{ .bytes = image };
    const w = try walk.Walker.init(image, sr.blockReader());
    const loc = try w.resolve("big.bin", .file);
    const stream = try w.openData(loc);
    const chain = switch (stream.location) {
        .chunked => |c| c,
        .single => return error.ExpectedChunked,
    };
    const last_pos = try w.locate(stream.location, chain.total_size - 1);
    const last_chunk_abs = loc_abs(&w, loc) + @as(u64, last_pos.chunk_index) * w.buffer_size;
    // The last chunk's payload ends where its STREAM TRAILER FT (13.15.7.2)
    // begins. The continuation header's length comes from the writer's own
    // emitter (13.13), not from a number this test recomputes.
    var scratch: [64]u8 = undefined;
    var sw = fields.Writer{ .buf = &scratch };
    try writer.writeContinuationHeader(&sw, 0);
    const cont_len = sw.len;
    const trailer_start =
        last_chunk_abs + cont_len + @as(u64, last_pos.offset_in_chunk) + 1;
    try testing.expect(trailer_start < image.len);

    // Flipping the trailer's opening FID byte is exactly "this File Space does
    // not close": the probe for the trailer fails, so the chain cannot be
    // accepted as ending here.
    image[@intCast(trailer_start)] ^= 0x01;

    var sr2 = res.block.SliceReader{ .bytes = image };
    const w2 = try walk.Walker.init(image, sr2.blockReader());
    const loc2 = try w2.resolve("big.bin", .file);
    try testing.expectError(error.Invalid, w2.openData(loc2));
}

/// The absolute offset a location's (buffer_address, buffer_offset) names, as
/// the reader computes it (§11.1 ruling 4).
fn loc_abs(w: *const walk.Walker, loc: walk.Location) u64 {
    _ = w;
    return (@as(u64, 1) + loc.buffer_address) * 512 + loc.buffer_offset;
}
