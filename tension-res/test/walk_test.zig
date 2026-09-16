//! Walker tests (phase 4): a small deterministic volume with a depth-6 target
//! and siblings at every level, the §6.8 error table, the "never touches
//! pak_bytes" proof, and malformed-fixture cases.

const std = @import("std");
const res = @import("../src/root.zig");
const support = @import("prune_support.zig");
const walk = res.walk;
const writer = res.writer;
const fields = res.fields;
const index = res.index;
const testing = std.testing;

var nodes: [64]support.Node = undefined;
var image: [64 * 1024]u8 = undefined;
var names: [1024]u8 = undefined;
var payloads: [1024]u8 = undefined;

const F_PAYLOAD = "payload-of-f";

const Tiny = struct {
    tree: support.Tree,
    root: usize,
    a: usize,
    sib_b: usize,
    b: usize,
    y: usize,
    c: usize,
    d: usize,
    e: usize,
    f: usize,
};

/// root/{a,b,z,top.txt}; a/{b,y,sib.txt}; a/b/{c,x,note.txt}; a/b/c/{d,w};
/// a/b/c/d/{e,v}; a/b/c/d/e/{f,g,h}.
fn buildTiny(omit_index_for: ?usize) Tiny {
    var t = support.Tree.init(&nodes, &image, &names, &payloads);
    const root = t.addDir(null, "root");
    const a = t.addDir(root, "a");
    const sib_b = t.addDir(root, "b");
    _ = t.addDir(root, "z");
    _ = t.addFile(root, "top.txt", "top");
    const b = t.addDir(a, "b");
    const y = t.addDir(a, "y");
    _ = t.addFile(a, "sib.txt", "sibling");
    const c = t.addDir(b, "c");
    _ = t.addDir(b, "x");
    _ = t.addFile(b, "note.txt", "note");
    const d = t.addDir(c, "d");
    _ = t.addDir(c, "w");
    const e = t.addDir(d, "e");
    _ = t.addDir(d, "v");
    _ = t.addFile(e, "g", "payload-of-g");
    _ = t.addFile(e, "h", "payload-of-h");
    const f = t.addFile(e, "f", F_PAYLOAD);
    t.omit_index_for = omit_index_for;
    t.finish() catch unreachable;
    return .{ .tree = t, .root = root, .a = a, .sib_b = sib_b, .b = b, .y = y, .c = c, .d = d, .e = e, .f = f };
}

fn openWalker(t: *const Tiny, rec: *support.Recorder) !walk.Walker {
    rec.inner = .{ .bytes = t.tree.image[0..t.tree.image_len] };
    rec.reset();
    return walk.Walker.init(t.tree.image[0..t.tree.image_len], rec.reader());
}

test "walks to a depth-6 target and reports its location" {
    const tiny = buildTiny(null);
    var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
    const w = try openWalker(&tiny, &rec);

    const loc = try w.lookup("a/b/c/d/e/f");
    try testing.expectEqual(index.Kind.file, loc.kind);
    try testing.expectEqualStrings("f", loc.name);
    try testing.expectEqual(@as(u32, F_PAYLOAD.len), loc.size);

    // The reported location is the target's own File Header position.
    const node = tiny.tree.nodes[tiny.f];
    try testing.expectEqual(@as(u32, @intCast(node.abs / support.SECTOR - support.FS_HEADER_SECTOR)), loc.buffer_address);
    try testing.expectEqual(@as(u32, @intCast(node.abs % support.SECTOR)), loc.buffer_offset);
    try testing.expectEqual(@as(u16, 1), loc.volume_set_sequence);

    const st = try w.stat("a/b/c/d/e/f");
    try testing.expectEqual(index.Kind.file, st.kind);
    try testing.expectEqual(@as(u32, F_PAYLOAD.len), st.size);

    // Leading '/', '.' and '..' normalize away; the empty path is the root.
    _ = try w.lookup("/a/./b/c/d/../d/e/f");
    try testing.expectEqual(index.Kind.directory, (try w.stat("")).kind);
}

test "resolve honours expect and trailing slash (ENOTDIR / EISDIR)" {
    const tiny = buildTiny(null);
    var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
    const w = try openWalker(&tiny, &rec);

    try testing.expectError(error.IsDir, w.resolve("a/b/c/d/e", .file));
    try testing.expectError(error.NotDir, w.resolve("a/b/c/d/e/f", .directory));
    try testing.expectError(error.NotDir, w.lookup("a/b/c/d/e/f/")); // trailing slash on a file
    try testing.expectError(error.NotDir, w.lookup("a/b/c/d/e/f/g")); // file in a path position
    try testing.expectError(error.NotFound, w.lookup("a/b/c/d/e/nope"));
    try testing.expectError(error.Invalid, w.lookup("a/../../x")); // '..' escaping the root
    _ = try w.resolve("a/b/c/d/e/", .directory); // trailing slash on a directory is fine
}

test "the walker never reads pak_bytes directly" {
    const tiny = buildTiny(null);
    // Decoy of the same length, different content: if the walker touched it,
    // the walk would fail; the reader serves the real bytes.
    var decoy = [_]u8{0xFF} ** (64 * 1024);
    var rec = support.Recorder{ .inner = .{ .bytes = tiny.tree.image[0..tiny.tree.image_len] } };
    const w = try walk.Walker.init(decoy[0..tiny.tree.image_len], rec.reader());
    const loc = try w.lookup("a/b/c/d/e/f");
    try testing.expectEqualStrings("f", loc.name);
}

test "a directory without a child-index Stream is ENOENT on descent" {
    const t2 = buildTiny(8); // 'c' (see the builder's order) has no index Stream
    var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
    const w = try openWalker(&t2, &rec);
    _ = try w.stat("a/b/c"); // the directory itself resolves…
    try testing.expectError(error.NotFound, w.lookup("a/b/c/d/e/f")); // …its children do not (§11)
}

test "malformed fixtures are rejected with the right codes" {
    // Index entry pointing outside the image: EINVAL before any read (§6.8).
    {
        const tiny = buildTiny(null);
        const listing = tiny.tree.image[@intCast(tiny.tree.nodes[tiny.e].listing_off)..][0..tiny.tree.nodes[tiny.e].listing_len];
        const entry_off = try findEntryOffset(listing, tiny.tree.nodes[tiny.f].name);
        fields.writeUintLe(listing[entry_off + 10 ..][0..4], 0xFFFF);
        var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
        const w = try openWalker(&tiny, &rec);
        try testing.expectError(error.Invalid, w.lookup("a/b/c/d/e/f"));
    }

    // Corrupted entry kind: the index parser rejects it (§6.7).
    {
        const tiny = buildTiny(null);
        const listing = tiny.tree.image[@intCast(tiny.tree.nodes[tiny.e].listing_off)..][0..tiny.tree.nodes[tiny.e].listing_len];
        const entry_off = try findEntryOffset(listing, tiny.tree.nodes[tiny.f].name);
        listing[entry_off] = 9;
        var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
        const w = try openWalker(&tiny, &rec);
        try testing.expectError(error.Invalid, w.lookup("a/b/c/d/e/f"));
    }

    // A directory whose recorded location sits at the very end of the image:
    // descending into it runs off the end (EIO), never a panic.
    {
        const tiny = buildTiny(null);
        const listing = tiny.tree.image[@intCast(tiny.tree.nodes[tiny.d].listing_off)..][0..tiny.tree.nodes[tiny.d].listing_len];
        const entry_off = try findEntryOffset(listing, tiny.tree.nodes[tiny.e].name);
        const near_end: u32 = @intCast(tiny.tree.image_len - 3);
        fields.writeUintLe(listing[entry_off + 10 ..][0..4], near_end / support.SECTOR - support.FS_HEADER_SECTOR);
        fields.writeUintLe(listing[entry_off + 14 ..][0..4], near_end % support.SECTOR);
        var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
        const w = try openWalker(&tiny, &rec);
        const got = w.lookup("a/b/c/d/e/f");
        try testing.expect(std.meta.isError(got));
        try testing.expect(got == error.Truncated or got == error.Invalid);
    }
}

/// Offset of a named entry inside a listing (test helper).
fn findEntryOffset(listing: []const u8, name: []const u8) !u32 {
    const idx = try index.Index.parse(listing);
    const h = idx.header;
    const want = index.fnv1a64(name);
    var i: u32 = 0;
    while (i < h.slot_count) : (i += 1) {
        const at = h.slot_area_off + 16 * i;
        var tmp: [8]u8 = undefined;
        @memcpy(&tmp, listing[at..][0..8]);
        const hash = fields.readUintLe(&tmp);
        if (hash == want) {
            var t4: [4]u8 = undefined;
            @memcpy(&t4, listing[at + 8 ..][0..4]);
            return @intCast(fields.readUintLe(&t4));
        }
    }
    return error.Missing;
}

test "a single-chunk File resolves to the single variant, and locate walks it" {
    const tiny = buildTiny(null);
    var rec = support.Recorder{ .inner = .{ .bytes = image[0..] } };
    const w = try openWalker(&tiny, &rec);
    const loc = try w.resolve("a/b/c/d/e/f", .file);
    const stream = try w.openData(loc);
    try testing.expectEqual(@as(u32, F_PAYLOAD.len), stream.len);
    switch (stream.location) {
        .single => |one| {
            try testing.expectEqual(@as(u32, F_PAYLOAD.len), one.size);
            // locate: offset 0, inside, and the first byte past the end.
            try testing.expectEqual(
                walk.ChunkPos{ .chunk_index = 0, .offset_in_chunk = 0 },
                try w.locate(stream.location, 0),
            );
            try testing.expectEqual(
                walk.ChunkPos{ .chunk_index = 0, .offset_in_chunk = 3 },
                try w.locate(stream.location, 3),
            );
            try testing.expectEqual(
                walk.ChunkPos{ .chunk_index = 0, .offset_in_chunk = F_PAYLOAD.len },
                try w.locate(stream.location, F_PAYLOAD.len),
            );
            try testing.expectError(error.Invalid, w.locate(stream.location, F_PAYLOAD.len + 1));
        },
        .chunked => return error.ExpectedSingleChunk,
    }
}

// --- 9b: the chunk chain's bounds -----------------------------------------

/// A synthetic image that repeats one continuation chunk at every Buffer
/// stride (§9b MAX_CHUNKS seam). Nothing multi-gigabyte is allocated: the
/// reader materializes each requested range from a one-chunk template, so a
/// chain long enough to trip the cap is still walkable in a unit test.
const SyntheticChain = struct {
    template: []const u8,
    /// Chunk 0's File Space offset: the phase every Buffer repeats from, since
    /// a Buffer opens with its header and then the chunk that lives in it.
    first_off: u64,
    stride: u64,
    image_len: u64,
    reads: usize = 0,
    max_read: u64 = 0,

    fn reader(self: *SyntheticChain) res.block.BlockReader {
        return .{ .ctx = @ptrCast(self), .vtable = &vtable };
    }

    const vtable = res.block.BlockReader.VTable{ .read = readImpl };

    fn readImpl(ctx: *const anyopaque, offset: u64, len: usize) res.block.Error![]const u8 {
        // The ctx was `@ptrCast`ed from a mutable pointer, so discarding the
        // const here is sound; the reader's counters are how it proves it
        // really walked the chain and never left the image.
        const c: *const SyntheticChain = @alignCast(@ptrCast(ctx));
        const self: *SyntheticChain = @constCast(c);
        if (offset > self.image_len or len > self.image_len - offset) return error.Truncated;
        self.reads += 1;
        self.max_read = @max(self.max_read, offset + len);
        // Every Buffer is the same, so a byte's position relative to chunk 0's
        // File Space is all that identifies it.
        if (offset < self.first_off) return error.Truncated;
        const within: usize = @intCast((offset - self.first_off) % self.stride);
        if (within + len > self.template.len) return error.Truncated;
        return self.template[within..][0..len];
    }
};

test "a chain past MAX_CHUNKS is refused without reading past the image" {
    // The writer's own continuation header (13.13). Its length is fixed, so
    // measure it once with the real emitter, then re-emit it with FILE CHUNK
    // SIZE set to "this header plus one payload byte": one byte per chunk is
    // the fewest chunks a chain of this length can possibly have.
    var scratch: [64]u8 = undefined;
    var sw = fields.Writer{ .buf = &scratch };
    try writer.writeContinuationHeader(&sw, 0);
    const cont_len = sw.len;

    var template: [4096]u8 = @splat(0);
    var tw = fields.Writer{ .buf = &template };
    try writer.writeContinuationHeader(&tw, @intCast(cont_len + 1));
    try testing.expectEqual(cont_len, tw.len);
    const stride: u64 = template.len;

    const file_abs: u64 = 512; // one sector in, so buffer_address 0 is legal
    var synth = SyntheticChain{
        .template = &template,
        .first_off = file_abs,
        .stride = stride,
        // Room past the last chunk the cap permits, so the refusal can only
        // come from the cap — never from the image ending.
        .image_len = (@as(u64, walk.MAX_CHUNKS) + 4) * stride,
    };
    const head_bytes: u64 = 111; // any positive head; the walk never reads it
    const total: u32 = walk.MAX_CHUNKS + 1; // one byte per chunk, all claimed

    try testing.expectError(error.Invalid, walk.Walker.walkChainForTest(
        synth.reader(),
        synth.image_len,
        @intCast(stride),
        file_abs,
        0,
        0,
        head_bytes,
        total,
        @intCast(head_bytes + 1),
    ));
    // It really did walk the chain (three reads per continuation), and it
    // stopped at the cap: the largest read served is strictly inside the
    // image, so the refusal cannot have come from running off the end.
    try testing.expect(synth.reads > walk.MAX_CHUNKS);
    try testing.expect(synth.max_read < synth.image_len);
    std.debug.print(
        "9b: chain cap refused after {d} reads; max_read {d} < image_len {d}\n",
        .{ synth.reads, synth.max_read, synth.image_len },
    );
}
