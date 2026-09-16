//! Shared support for the phase-4 walker tests: a deterministic tree builder
//! that emits a structurally valid flat SIDF volume, an instrumented
//! `BlockReader`, and the byte/page metrics the pruning assertions need.
//!
//! Layout model (test-only, documented): sector 0 = Volume Header FT, sector
//! 1 = File Set Header FT, then a Buffer Header FT and the root directory's
//! File; every other node follows back to back. File locations use §11.1
//! ruling 4 (`buffer_address` counts from the File Set Header, first = 1) with
//! `sector_size = 512`, so a node at image offset `abs` has
//! `buffer_address = abs / 512 - 1`, `buffer_offset = abs % 512`.

const std = @import("std");
const res = @import("../src/root.zig");
const fields = res.fields;
const metadata = res.metadata;
const index = res.index;
const block = res.block;

pub const SECTOR: usize = 512;
pub const FS_HEADER_SECTOR: u32 = 1;
pub const CHUNK_PAYLOAD: u32 = 4096;
pub const MAX_CHILDREN: usize = 8 * 1024;

pub const Node = struct {
    name: []const u8,
    kind: index.Kind,
    parent: u32,
    first_child: u32 = 0,
    child_count: u32 = 0,
    payload: []const u8 = &.{},
    abs: u64 = 0,
    record_len: u32 = 0,
    listing_off: u64 = 0,
    listing_len: u32 = 0,
};

pub const Tree = struct {
    nodes: []Node,
    count: usize = 0,
    image: []u8,
    image_len: usize = 0,
    names: []u8,
    names_len: usize = 0,
    payloads: []u8,
    payloads_len: usize = 0,
    /// Optional: a node whose File Data carries no child-index Stream (§11).
    omit_index_for: ?usize = null,

    pub fn init(nodes: []Node, image: []u8, names: []u8, payloads: []u8) Tree {
        return .{ .nodes = nodes, .image = image, .names = names, .payloads = payloads };
    }

    fn reserveName(self: *Tree, name: []const u8) []const u8 {
        if (self.names_len + name.len > self.names.len) @panic("names arena full");
        const out = self.names[self.names_len .. self.names_len + name.len];
        @memcpy(out, name);
        self.names_len += name.len;
        return out;
    }

    fn reservePayload(self: *Tree, payload: []const u8) []const u8 {
        if (self.payloads_len + payload.len > self.payloads.len) @panic("payload arena full");
        const out = self.payloads[self.payloads_len .. self.payloads_len + payload.len];
        @memcpy(out, payload);
        self.payloads_len += payload.len;
        return out;
    }

    pub fn addDir(self: *Tree, parent: ?usize, name: []const u8) usize {
        const id = self.count;
        self.nodes[id] = .{
            .name = self.reserveName(name),
            .kind = .directory,
            .parent = if (parent) |p| @intCast(p) else std.math.maxInt(u32),
        };
        if (parent) |p| self.attach(p, id);
        self.count += 1;
        return id;
    }

    pub fn addFile(self: *Tree, parent: usize, name: []const u8, payload: []const u8) usize {
        const id = self.count;
        self.nodes[id] = .{
            .name = self.reserveName(name),
            .kind = .file,
            .parent = @intCast(parent),
            .payload = self.reservePayload(payload),
        };
        self.attach(parent, id);
        self.count += 1;
        return id;
    }

    fn attach(self: *Tree, parent: usize, child: usize) void {
        const p = &self.nodes[parent];
        if (p.child_count == 0) {
            p.first_child = @intCast(child);
        } else {
            std.debug.assert(child == p.first_child + p.child_count); // children stay contiguous
        }
        p.child_count += 1;
    }

    pub fn children(self: *const Tree, node: usize) []const Node {
        const n = &self.nodes[node];
        return self.nodes[n.first_child .. n.first_child + n.child_count];
    }

    fn listingLen(self: *Tree, node: usize) !u32 {
        var scratch_children: [MAX_CHILDREN]index.Child = undefined;
        const count = try self.fillChildren(node, &scratch_children, false);
        const plan = try index.plan(scratch_children[0..count], CHUNK_PAYLOAD);
        return plan.stream_len;
    }

    /// `located = false` is for pass 1 (only lengths matter there, and the
    /// children's offsets are not assigned yet).
    fn fillChildren(self: *Tree, node: usize, out: *[MAX_CHILDREN]index.Child, located: bool) !usize {
        const kids = self.children(node);
        for (kids, 0..) |*kid, i| {
            var buffer_address: u32 = 0;
            var buffer_offset: u32 = 0;
            if (located) {
                if (kid.abs / SECTOR < FS_HEADER_SECTOR) return error.BadLocation;
                buffer_address = @intCast(kid.abs / SECTOR - FS_HEADER_SECTOR);
                buffer_offset = @intCast(kid.abs % SECTOR);
            }
            out[i] = .{
                .name = kid.name,
                .kind = kid.kind,
                .size = @intCast(kid.payload.len),
                .volume_set_sequence = 1,
                .buffer_address = buffer_address,
                .buffer_offset = buffer_offset,
            };
        }
        return kids.len;
    }

    /// Layout all nodes and write the volume. Root goes first (the walker's
    /// §6.5 root convention); every other node follows in insertion order.
    pub fn finish(self: *Tree) !void {
        var w = fields.Writer{ .buf = self.image };
        try writeVolumeHeader(&w);
        try padTo(&w, SECTOR);
        try writeFileSetHeader(&w);
        try padTo(&w, 2 * SECTOR);

        var buffer_header_scratch: [256]u8 = undefined;
        var bw = fields.Writer{ .buf = &buffer_header_scratch };
        try writeBufferHeader(&bw);
        try w.append(buffer_header_scratch[0..bw.len]);

        // Pass 1: assign offsets. Record sizes are analytic and asserted in
        // pass 2, so any drift fails loudly.
        var pos: usize = w.len;
        for (self.nodes[0..self.count], 0..) |*n, id| {
            const is_dir = n.kind == .directory;
            const listing_len: u32 = if (is_dir) try self.listingLen(id) else 0;
            // Record bytes: FH 14 + FI (40 + n; #813F is a 2-byte FID) +
            // File Data header 6 + Path (13 + n) + Characteristics
            // (8 dir / 6 file) + Stream header 18 + payload + Stream trailer
            // 6 + File trailer 6.
            const base: usize = if (is_dir) 111 else 109;
            const payload_len: usize = if (is_dir) listing_len else n.payload.len;
            const with_stream = !(is_dir and self.omit_index_for == id);
            // A directory without an index Stream has neither the Stream
            // Header FT (18) nor the Stream Trailer FT (6) nor a payload.
            n.record_len = @intCast(if (with_stream)
                base + 2 * n.name.len + payload_len
            else
                (base - 24) + 2 * n.name.len);
            n.abs = pos;
            pos += n.record_len;
            if (is_dir) {
                n.listing_len = listing_len;
                // Everything before the stream payload: FH 14 + FI (40 + n) +
                // File Data header 6 + Path (13 + n) + Characteristics 8 +
                // Stream Header 18 = 99 + 2n. Verified in pass 2.
                n.listing_off = n.abs + 99 + 2 * n.name.len;
            }
        }
        if (pos > self.image.len) return error.ImageTooSmall;

        // Pass 2: write each record (with the real listing) and verify sizes.
        var children_scratch: [MAX_CHILDREN]index.Child = undefined;
        var order: [MAX_CHILDREN]u32 = undefined;
        var offsets: [MAX_CHILDREN]u32 = undefined;
        for (self.nodes[0..self.count], 0..) |*n, id| {
            const is_dir = n.kind == .directory;
            var listing_bytes: []const u8 = &.{};
            if (is_dir and self.omit_index_for != id) {
                const count = try self.fillChildren(id, &children_scratch, true);
                const listing = self.image[@intCast(n.listing_off)..][0..n.listing_len];
                const written = try index.write(children_scratch[0..count], order[0..count], offsets[0..count], listing, CHUNK_PAYLOAD);
                if (written != n.listing_len) return error.ListingSizeMismatch;
                // The listing is contiguous in the image, so every chunk's
                // physical position is known here (§6.7).
                const hdr = try index.parseHeader(listing);
                var k: u32 = 0;
                while (k < hdr.chunk_count) : (k += 1) {
                    const abs = n.listing_off + @as(u64, k) * CHUNK_PAYLOAD;
                    const buf_addr: u32 = @intCast(abs / SECTOR - FS_HEADER_SECTOR);
                    const buf_off: u32 = @intCast(abs % SECTOR);
                    try index.setChunkPosition(listing, hdr, k, buf_addr, buf_off);
                }
                listing_bytes = listing;
            }
            const with_stream = !(is_dir and self.omit_index_for == id);
            var nw = fields.Writer{ .buf = self.image[@intCast(n.abs)..] };
            const payload_off = try writeRecord(&nw, n, listing_bytes, with_stream);
            if (nw.len != n.record_len) return error.RecordSizeMismatch;
            if (with_stream and is_dir and @as(u64, payload_off) != n.listing_off - n.abs) return error.ListingOffsetMismatch;
        }
        self.image_len = pos;
    }

    /// Resolve a path the way the walker does: relative to the root
    /// directory File (the root's own name is not a path component).
    pub fn find(self: *const Tree, path: []const u8) ?usize {
        var current: usize = 0;
        var i: usize = 0;
        while (i < path.len) {
            var j = i;
            while (j < path.len and path[j] != '/') : (j += 1) {}
            const comp = path[i..j];
            if (comp.len != 0 and !std.mem.eql(u8, comp, ".")) {
                var found: ?usize = null;
                for (self.children(current), self.nodes[current].first_child..) |kid, k| {
                    if (std.mem.eql(u8, kid.name, comp)) found = k;
                }
                current = found orelse return null;
            }
            i = j + 1;
        }
        return current;
    }
};

fn writeRecord(w: *fields.Writer, node: *const Node, listing: []const u8, with_stream: bool) !usize {
    const is_dir = node.kind == .directory;
    try w.tableHeader(fields.FILE_HEADER);
    try w.field(fields.FILE_CHUNK_SIZE, &.{ 0, 0, 0, 0 });
    const chunk_pos = w.len - 4;
    try w.field(fields.FILE_TYPE, &.{if (is_dir)
        @intFromEnum(metadata.FileType.source_directory)
    else
        @intFromEnum(metadata.FileType.file)});
    try w.tableEnd(fields.FILE_HEADER);

    try w.tableHeader(fields.FILE_INFORMATION);
    try w.field(fields.ATTRIBUTES, &.{ 0, 0, 0, 0 });
    try w.field(fields.PARENT, &.{if (is_dir) 1 else 0});
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{if (node.parent == std.math.maxInt(u32)) 1 else 0});
    try w.field(fields.CREATOR_NAME_SPACE, &.{ 1, 0, 0, 0 });
    const stream_size: u32 = @intCast(if (is_dir) listing.len else node.payload.len);
    var tmp4: [4]u8 = undefined;
    fields.writeUintLe(&tmp4, stream_size);
    try w.field(fields.DATA_STREAM_SIZE, &tmp4);
    try w.field(fields.NAME_SPACE, &.{1});
    try w.field(fields.PATH_NAME, node.name);
    try w.tableEnd(fields.FILE_INFORMATION);

    try w.tableHeader(if (is_dir) fields.SOURCE_DIRECTORY_HEADER else fields.SOURCE_FILE_HEADER);
    try w.tableEnd(if (is_dir) fields.SOURCE_DIRECTORY_HEADER else fields.SOURCE_FILE_HEADER);

    try w.tableHeader(fields.PATH);
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{0});
    try w.field(fields.NAME_SPACE, &.{1});
    try w.field(fields.PATH_NAME, node.name);
    try w.tableEnd(fields.PATH);

    try w.tableHeader(fields.CHARACTERISTICS);
    if (is_dir) try w.bitsField(fields.SOURCE_DIRECTORY, 1);
    try w.tableEnd(fields.CHARACTERISTICS);

    var payload_off: usize = 0;
    if (with_stream) {
        try w.tableHeader(fields.STREAM_HEADER);
        try w.field(fields.STREAM_TYPE, &.{0}); // Data (Annex C #2B)
        try w.field(fields.STREAM_FORMAT, &.{0}); // Clear data (Annex C #2C)
        try w.field(fields.STREAM_SIZE, &tmp4);
        try w.tableEnd(fields.STREAM_HEADER);
        payload_off = w.len;
        if (is_dir) {
            // The listing was written into the image at this exact offset
            // before the record, so advance over it instead of copying it
            // onto itself.
            try w.skip(listing.len);
        } else {
            try w.append(node.payload);
        }
        try w.tableHeader(fields.STREAM_TRAILER);
        try w.tableEnd(fields.STREAM_TRAILER);
    }

    try w.tableHeader(if (is_dir) fields.SOURCE_DIRECTORY_TRAILER else fields.SOURCE_FILE_TRAILER);
    try w.tableEnd(if (is_dir) fields.SOURCE_DIRECTORY_TRAILER else fields.SOURCE_FILE_TRAILER);

    fields.patchUintLe(w.buf, chunk_pos, w.len, 4);
    return payload_off;
}

fn padTo(w: *fields.Writer, end: usize) !void {
    while (w.len < end) try w.appendByte(0);
}

fn writeVolumeHeader(w: *fields.Writer) !void {
    try w.tableHeader(fields.VOLUME_HEADER);
    try w.field(fields.OFFSET_TO_END, &.{ 0, 0 });
    try w.field(fields.FORMAT_NAME, "SIDF");
    try w.field(fields.FORMAT_VERSION, &.{ 1, 0, 0, 0 });
    var tmp4: [4]u8 = undefined;
    fields.writeUintLe(&tmp4, SECTOR);
    try w.field(fields.SECTOR_SIZE, &tmp4);
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.VOLUME_SET_TIME, &zero_ts);
    try w.field(fields.VOLUME_TIME, &zero_ts);
    try w.field(fields.VOLUME_SET_LABEL, "PRUNE");
    try w.field(fields.VOLUME_SET_SEQUENCE, &.{ 1, 0 });
    try w.bitsField(fields.VOLUME_INDEX_REQUIRED, 0);
    try w.bitsField(fields.FILE_MARK_USAGE, 0);
    try w.tableEnd(fields.VOLUME_HEADER);
}

fn writeFileSetHeader(w: *fields.Writer) !void {
    try w.tableHeader(fields.FILE_SET_HEADER);
    try w.field(fields.OFFSET_TO_END, &.{ 0, 0 });
    try w.field(fields.FILE_SET_ID, &.{ 0x54, 0x45, 0x4E, 0x53 });
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try w.field(fields.FILE_SET_LABEL, "PRUNE");
    try w.bitsField(fields.FILE_SET_INDEX_PRESENT, 0);
    var tmp4: [4]u8 = undefined;
    fields.writeUintLe(&tmp4, 4096);
    try w.field(fields.BUFFER_SIZE, &tmp4);
    try w.field(fields.SOURCE_NAME_TYPE, &.{1});
    try w.field(fields.SOURCE_NAME, "PRUNE");
    try w.field(fields.SOURCE_OPERATING_SYSTEM, "PRUNE");
    try w.field(fields.SOURCE_OPERATING_SYSTEM_VERSION, "1");
    try w.tableEnd(fields.FILE_SET_HEADER);
}

fn writeBufferHeader(w: *fields.Writer) !void {
    try w.tableHeader(fields.BUFFER_HEADER);
    try w.field(fields.OFFSET_TO_END, &.{ 0, 0 });
    try w.field(fields.BUFFER_TYPE, &.{1}); // File (Annex C #60)
    var tmp4: [4]u8 = undefined;
    fields.writeUintLe(&tmp4, 4096);
    try w.field(fields.BUFFER_SIZE, &tmp4);
    try w.field(fields.BUFFER_SEQUENCE, &.{ 1, 0, 0, 0 });
    try w.field(fields.BUFFER_ADDRESS, &.{ 1, 0, 0, 0 });
    try w.field(fields.UNUSED_IN_THIS_BUFFER, &.{ 0, 0, 0, 0 });
    try w.field(fields.FILE_SET_ID, &.{ 0x54, 0x45, 0x4E, 0x53 });
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try w.tableEnd(fields.BUFFER_HEADER);
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

pub const Range = struct { off: u64, len: u64 };

pub const MAX_LOG: usize = 8192;

pub const Recorder = struct {
    inner: block.SliceReader,
    log: [MAX_LOG]Range = undefined,
    count: usize = 0,
    overflow: bool = false,

    pub fn reader(self: *Recorder) block.BlockReader {
        return .{ .ctx = @ptrCast(self), .vtable = &vtable };
    }

    const vtable = block.BlockReader.VTable{ .read = readImpl };

    fn readImpl(ctx: *const anyopaque, offset: u64, len: usize) block.Error![]const u8 {
        const self: *Recorder = @alignCast(@ptrCast(@constCast(ctx)));
        if (self.count < MAX_LOG) {
            self.log[self.count] = .{ .off = offset, .len = len };
            self.count += 1;
        } else {
            self.overflow = true;
        }
        return self.inner.blockReader().read(offset, len);
    }

    pub fn reset(self: *Recorder) void {
        self.count = 0;
        self.overflow = false;
    }
};

pub const Metrics = struct {
    /// Sum of all requested lengths (with duplicates).
    bytes_total: u64 = 0,
    /// Union of requested byte ranges (the working set).
    bytes_distinct: u64 = 0,
    /// Distinct 8 KiB pages touched.
    pages: u32 = 0,
    /// Distinct ranges after merging.
    ranges: u32 = 0,
};

/// Compute metrics from the recorder's log; `scratch` must hold MAX_LOG ranges
/// and `page_bits` `image_len / page_size` bits rounded up to u64 words.
pub fn measure(rec: *const Recorder, page_size: usize, page_bits: []u64, scratch: []Range) Metrics {
    var m = Metrics{};
    @memset(page_bits, 0);
    if (scratch.len < rec.count) @panic("scratch too small");
    for (rec.log[0..rec.count]) |r| {
        m.bytes_total += r.len;
        const first = r.off / page_size;
        const last = (r.off + r.len - 1) / page_size;
        var p = first;
        while (p <= last) : (p += 1) {
            const word: usize = @intCast(p / 64);
            const bit: u6 = @intCast(p % 64);
            if (word < page_bits.len) page_bits[word] |= @as(u64, 1) << bit;
        }
        // copy into scratch
    }
    @memcpy(scratch[0..rec.count], rec.log[0..rec.count]);
    std.mem.sort(Range, scratch[0..rec.count], {}, lessThanRange);
    var i: usize = 0;
    while (i < rec.count) {
        var j = i + 1;
        var end = scratch[i].off + scratch[i].len;
        while (j < rec.count and scratch[j].off <= end) : (j += 1) {
            end = @max(end, scratch[j].off + scratch[j].len);
        }
        m.bytes_distinct += end - scratch[i].off;
        m.ranges += 1;
        i = j;
    }
    for (page_bits) |w| m.pages += @popCount(w);
    return m;
}

fn lessThanRange(_: void, a: Range, b: Range) bool {
    return a.off < b.off;
}

/// Number of recorded ranges that intersect `siblings` (sorted, disjoint).
pub fn siblingHits(rec: *const Recorder, siblings: []const Range, scratch: []Range) u32 {
    var hits: u32 = 0;
    if (scratch.len < rec.count) @panic("scratch too small");
    @memcpy(scratch[0..rec.count], rec.log[0..rec.count]);
    std.mem.sort(Range, scratch[0..rec.count], {}, lessThanRange);
    var s: usize = 0;
    for (scratch[0..rec.count]) |r| {
        const r_end = r.off + r.len;
        while (s < siblings.len and siblings[s].off + siblings[s].len <= r.off) s += 1;
        var k = s;
        while (k < siblings.len and siblings[k].off < r_end) : (k += 1) {
            hits += 1;
        }
    }
    return hits;
}

/// Ranges of every node that is not on `path` (records and listings).
/// Returned in ascending order; the caller sizes `out` generously.
pub fn siblingRanges(tree: *const Tree, path: []const usize, out: []Range) []Range {
    var n: usize = 0;
    for (tree.nodes[0..tree.count], 0..) |node, id| {
        var on_path = false;
        for (path) |p| {
            if (p == id) on_path = true;
        }
        if (on_path) continue;
        const rec_end = node.abs + node.record_len;
        if (node.kind == .directory and node.listing_len > 0) {
            out[n] = .{ .off = node.abs, .len = node.listing_off - node.abs };
            n += 1;
            out[n] = .{ .off = node.listing_off, .len = node.listing_len };
            n += 1;
        } else {
            out[n] = .{ .off = node.abs, .len = rec_end - node.abs };
            n += 1;
        }
    }
    return out[0..n];
}

// ---------------------------------------------------------------------------
// Fixture builders (the phase-4 shapes from the brief)
// ---------------------------------------------------------------------------

pub const Buffers = struct {
    nodes: []Node,
    image: []u8,
    names: []u8,
    payloads: []u8,
};

pub const LETTERS = "abcdefghijklmnopqrstuvwxyz";
pub const CHAIN_TARGET_PAYLOAD = "PRUNE-PAYLOAD";

fn writeIntName(buf: []u8, prefix: []const u8, value: usize, digits: usize) []const u8 {
    var i: usize = 0;
    while (i < prefix.len) : (i += 1) buf[i] = prefix[i];
    var v = value;
    var j = digits;
    while (j > 0) {
        j -= 1;
        buf[prefix.len + j] = '0' + @as(u8, @intCast(v % 10));
        v /= 10;
    }
    return buf[0 .. prefix.len + digits];
}

/// Large fixture: 26-ary levels 1-3 (18 279 directories), five files under
/// each level-3 directory (87 880 files), and the chain a/b/c/d/e/f with
/// 500 / 500 / 5 000 fillers — about 112 000 entries in total.
///
/// Children of a directory must be created consecutively (the builder asserts
/// it), so directories are created level by level first and files are added
/// afterwards, one parent's children in one run.
pub fn buildLarge(b: Buffers) !Tree {
    var t = Tree.init(b.nodes, b.image, b.names, b.payloads);
    var nbuf: [32]u8 = undefined;

    // Phase A: directories, level by level (siblings stay contiguous).
    const root = t.addDir(null, "root");
    var l1: [26]usize = undefined;
    for (0..26) |i| l1[i] = t.addDir(root, LETTERS[i..][0..1]);
    var l2: [26][26]usize = undefined;
    for (0..26) |i| {
        for (0..26) |j| l2[i][j] = t.addDir(l1[i], LETTERS[j..][0..1]);
    }
    var l3: [26][26][26]usize = undefined;
    for (0..26) |i| {
        for (0..26) |j| {
            for (0..26) |k| l3[i][j][k] = t.addDir(l2[i][j], LETTERS[k..][0..1]);
        }
    }

    // Phase B: files. a/b/c is the deepest 26-ary directory on the chain.
    const chain_c = l3[0][1][2];
    const chain_d = t.addDir(chain_c, "d"); // name order: d < f000 < g000
    for (0..5) |m| _ = t.addFile(chain_c, writeIntName(&nbuf, "f", m, 3), "");
    for (0..500) |m| _ = t.addFile(chain_c, writeIntName(&nbuf, "g", m, 3), "");
    for (0..26) |i| {
        for (0..26) |j| {
            for (0..26) |k| {
                if (i == 0 and j == 1 and k == 2) continue;
                for (0..5) |m| _ = t.addFile(l3[i][j][k], writeIntName(&nbuf, "f", m, 3), "");
            }
        }
    }
    const chain_e = t.addDir(chain_d, "e");
    for (0..500) |m| _ = t.addFile(chain_d, writeIntName(&nbuf, "g", m, 3), "");
    _ = t.addFile(chain_e, "f", CHAIN_TARGET_PAYLOAD);
    for (0..5_000) |m| _ = t.addFile(chain_e, writeIntName(&nbuf, "g", m, 4), "");

    try t.finish();
    return t;
}

/// Small twin, "same shape": 26 level-1 directories, 26 level-2 directories
/// under each, one file per level-2 directory, and the same a/b/c/d/e/f chain
/// with five fillers per chain level — about 1 400 entries.
pub fn buildSmall(b: Buffers) !Tree {
    var t = Tree.init(b.nodes, b.image, b.names, b.payloads);
    var nbuf: [32]u8 = undefined;

    const root = t.addDir(null, "root");
    var l1: [26]usize = undefined;
    for (0..26) |i| l1[i] = t.addDir(root, LETTERS[i..][0..1]);
    var l2: [26][26]usize = undefined;
    for (0..26) |i| {
        for (0..26) |j| l2[i][j] = t.addDir(l1[i], LETTERS[j..][0..1]);
    }

    // The chain lives under a/b (i = 0, j = 1).
    const chain_ab = l2[0][1];
    const chain_c = t.addDir(chain_ab, "c"); // "c" < "data"
    const chain_d = t.addDir(chain_c, "d"); // "d" < "data"
    _ = t.addFile(chain_c, "data", "");
    _ = t.addFile(chain_d, "data", "");
    const chain_e = t.addDir(chain_d, "e"); // "data" < "e" < "g000"
    for (0..5) |m| _ = t.addFile(chain_d, writeIntName(&nbuf, "g", m, 3), "");
    _ = t.addFile(chain_e, "data", "");
    _ = t.addFile(chain_e, "f", CHAIN_TARGET_PAYLOAD);
    for (0..5) |m| _ = t.addFile(chain_e, writeIntName(&nbuf, "g", m, 4), "");

    for (0..26) |i| {
        for (0..26) |j| {
            if (i == 0 and j == 1) continue;
            _ = t.addFile(l2[i][j], "data", "");
        }
    }

    try t.finish();
    return t;
}

/// A deterministic keystream for test payloads that must stay *stored*.
///
/// The size and chunk tests assert that Files of 8/20/100 MiB span more chunks
/// than the per-open cache holds, which is only true while Deflate cannot
/// shrink their payload (§8.4's threshold). A repeating pattern — the obvious
/// choice for a test payload — collapses to almost nothing and would silently
/// stop covering the uncached path. This is a splitmix-style mixer of the
/// byte's offset: cheap, deterministic, and incompressible in practice.
pub fn keystreamByte(i: u64) u8 {
    var x: u64 = i *% 0x9E3779B97F4A7C15 +% 0x2545F4914F6CDD1D;
    x ^= x >> 33;
    x *%= 0xFF51AFD7ED558CCD;
    x ^= x >> 33;
    x *%= 0xC4CEB9FE1A85EC53;
    x ^= x >> 33;
    return @truncate(x);
}

pub fn fillKeystream(buf: []u8, off: u64) void {
    for (buf, 0..) |*b, k| b.* = keystreamByte(off + k);
}
