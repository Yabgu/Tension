//! Child-index tests (phase 3): round-trip, probe counts, malformed inputs,
//! determinism, and the multi-chunk mapping.
//!
//! The large cases need several MB, so the workspaces are file-scope statics
//! rather than stack locals.

const std = @import("std");
const res = @import("../src/root.zig");
const index = res.index;
const testing = std.testing;

const MAX_CHILDREN = 100_000;
var names_buf: [MAX_CHILDREN * 8]u8 = undefined;
var children: [MAX_CHILDREN]index.Child = undefined;
var stream_buf: [8 * 1024 * 1024]u8 = undefined;
var order_buf: [MAX_CHILDREN]u32 = undefined;
var offsets_buf: [MAX_CHILDREN]u32 = undefined;
var image_buf: [2 * 1024 * 1024]u8 = undefined;

/// `n0000000`..`n0099999`: fixed width so ascending index = ascending name.
fn makeChildren(n: usize) void {
    for (0..n) |i| {
        const base = i * 8;
        names_buf[base] = 'n';
        var v = i;
        var j: usize = 8;
        while (j > 1) {
            j -= 1;
            names_buf[base + j] = '0' + @as(u8, @intCast(v % 10));
            v /= 10;
        }
        children[i] = .{
            .name = names_buf[base .. base + 8],
            .kind = .file,
            .size = @intCast(i),
            .volume_set_sequence = 1,
            .buffer_address = @intCast(1 + i / 64),
            .buffer_offset = @intCast((i % 64) * 96),
        };
    }
}

fn ceilLog2(n: usize) u32 {
    var bits: u32 = 0;
    var x: usize = 1;
    while (x < n) : (x *= 2) bits += 1;
    return bits;
}

test "roundtrip: every child probes back to what was written" {
    const n = 500;
    makeChildren(n);
    var stream: [64 * 1024]u8 = undefined;
    const len = try index.write(children[0..n], order_buf[0..n], offsets_buf[0..n], &stream, 4096);
    const idx = try index.Index.parse(stream[0..len]);

    for (children[0..n]) |c| {
        const got = try idx.probe(c.name, null);
        try testing.expect(got != null);
        const e = got.?;
        try testing.expectEqual(c.kind, e.kind);
        try testing.expectEqual(c.size, e.size);
        try testing.expectEqual(c.volume_set_sequence, e.volume_set_sequence);
        try testing.expectEqual(c.buffer_address, e.buffer_address);
        try testing.expectEqual(c.buffer_offset, e.buffer_offset);
        try testing.expectEqual(c.compression_method, e.compression_method);
        try testing.expectEqualStrings(c.name, e.name);
    }
    try idx.validateAll();
}

test "probe miss returns null" {
    makeChildren(64);
    var stream: [4096]u8 = undefined;
    const len = try index.write(children[0..64], order_buf[0..64], offsets_buf[0..64], &stream, 4096);
    const idx = try index.Index.parse(stream[0..len]);
    try testing.expect((try idx.probe("nope.txt", null)) == null);
    try testing.expect((try idx.probe("", null)) == null);
}

test "slot reads follow ceil(log2 N) + 1" {
    const sizes = [_]usize{ 1000, 5000, 100_000 };
    for (sizes) |n| {
        makeChildren(n);
        const len = try index.write(children[0..n], order_buf[0..n], offsets_buf[0..n], &stream_buf, 65536);
        const idx = try index.Index.parse(stream_buf[0..len]);
        const bound = ceilLog2(n) + 1;
        var max_reads: u32 = 0;
        var i: usize = 0;
        const stride = 1 + n / 64;
        while (i < n) : (i += stride) {
            var stats = index.ProbeStats{};
            const got = try idx.probe(children[i].name, &stats);
            try testing.expect(got != null);
            if (stats.slot_reads > max_reads) max_reads = stats.slot_reads;
        }
        std.debug.print("N={d}: max slot reads {d} (bound ceil(log2 N)+1 = {d})\n", .{ n, max_reads, bound });
        try testing.expect(max_reads <= bound);
        try testing.expect(max_reads + 1 >= bound); // it really is a search
    }
}

test "malformed indexes are rejected, never panic" {
    const n = 64;
    makeChildren(n);
    var stream: [4096]u8 = undefined;
    const len = try index.write(children[0..n], order_buf[0..n], offsets_buf[0..n], &stream, 4096);
    const good = stream[0..len];
    const h = try index.parseHeader(good);

    // Far too short for a header.
    try testing.expectError(error.Truncated, index.Index.parse(good[0..8]));

    var copy: [4096]u8 = undefined;

    // Bad magic.
    @memcpy(copy[0..len], good);
    copy[0] ^= 0xFF;
    try testing.expectError(error.Invalid, index.Index.parse(copy[0..len]));

    // Chunk table entry inconsistent with the stream length (chunk 0 claims
    // zero bytes).
    @memcpy(copy[0..len], good);
    copy[h.chunk_table_off + 4] = 0;
    copy[h.chunk_table_off + 5] = 0;
    try testing.expectError(error.Invalid, index.Index.parse(copy[0..len]));

    // Entry length larger than the stream.
    @memcpy(copy[0..len], good);
    const slot0 = h.slot_area_off;
    copy[slot0 + 12] = 0xFF;
    copy[slot0 + 13] = 0xFF;
    const idx_bad = try index.Index.parse(copy[0..len]); // structure is fine…
    try testing.expectError(error.Truncated, idx_bad.entryAt(copy[slot0 + 8] | 0, 0xFFFF));
    _ = try idx_bad.probe(children[0].name, null); // …and probing still never panics

    // Hash ordering violated: two adjacent slots swapped. The bounded parse
    // accepts it (it must not read the whole slot area); validateAll, the
    // offline check, catches it.
    @memcpy(copy[0..len], good);
    var tmp: [16]u8 = undefined;
    @memcpy(&tmp, copy[slot0..][0..16]);
    @memcpy(copy[slot0..][0..16], copy[slot0 + 16 ..][0..16]);
    @memcpy(copy[slot0 + 16 ..][0..16], &tmp);
    const idx_swapped = try index.Index.parse(copy[0..len]);
    try testing.expectError(error.Invalid, idx_swapped.validateAll());
}

test "two writes of the same children are byte-identical" {
    const n = 300;
    makeChildren(n);
    var a: [32 * 1024]u8 = undefined;
    var b: [32 * 1024]u8 = undefined;
    const la = try index.write(children[0..n], order_buf[0..n], offsets_buf[0..n], &a, 4096);
    const lb = try index.write(children[0..n], order_buf[0..n], offsets_buf[0..n], &b, 4096);
    try testing.expectEqual(la, lb);
    try testing.expectEqualSlices(u8, a[0..la], b[0..lb]);
}

test "multi-chunk streams resolve through the chunk table" {
    const n = 5000;
    const p: u32 = 4096;
    const gap: usize = 128; // stand-in for a Buffer Header in front of each chunk
    makeChildren(n);
    const len = try index.write(children[0..n], order_buf[0..n], offsets_buf[0..n], &stream_buf, p);
    try testing.expectEqual(@as(usize, len), @min(len, stream_buf.len));
    try testing.expect(len > p); // genuinely multi-chunk
    const h = try index.parseHeader(stream_buf[0..len]);
    try testing.expect(h.chunk_count > 1);

    // Patch the chunk positions first, then copy: sector_size = 1 and
    // fs_header_sector = 0 make (buffer_address, offset_in_buffer) a direct
    // image offset, so this test exercises the mapping arithmetic only.
    const stream_start: usize = 1024;
    var k: u32 = 0;
    while (k < h.chunk_count) : (k += 1) {
        const dst = stream_start + k * (@as(usize, p) + gap);
        try index.setChunkPosition(stream_buf[0..len], h, k, 0, @intCast(dst));
    }
    k = 0;
    while (k < h.chunk_count) : (k += 1) {
        const chunk_off: usize = @as(usize, k) * p;
        const chunk_len: usize = @min(@as(usize, p), len - chunk_off);
        const dst = stream_start + @as(usize, k) * (@as(usize, p) + gap);
        @memcpy(image_buf[dst..][0..chunk_len], stream_buf[chunk_off..][0..chunk_len]);
    }

    const slice_reader = res.block.SliceReader{ .bytes = image_buf[0..] };
    const view = try index.ChunkView.init(slice_reader.blockReader(), stream_start, @intCast(len), 1, 0);
    var max_chunk_reads: u32 = 0;
    var i: usize = 0;
    while (i < n) : (i += 97) {
        var stats = index.ProbeStats{};
        const got = try view.probe(children[i].name, &stats);
        try testing.expect(got != null);
        try testing.expectEqualStrings(children[i].name, got.?.name);
        try testing.expectEqual(children[i].size, got.?.size);
        if (stats.chunk_reads > max_chunk_reads) max_chunk_reads = stats.chunk_reads;
    }
    std.debug.print("multi-chunk: max chunk-table reads {d} over {d} probes\n", .{ max_chunk_reads, (n + 96) / 97 });
    try testing.expect(max_chunk_reads > 0); // the mapping was exercised
    var stats2 = index.ProbeStats{};
    try testing.expect((try view.probe("nope", &stats2)) == null);
}

test "entry-area scan crosses filler, including filler longer than an entry head" {
    // 300-byte names make 320-byte entries, so a chunk end leaves filler that
    // is sometimes shorter than ENTRY_FIXED_LEN (caught arithmetically) and
    // sometimes longer (caught by the all-zero prefix rule, §6.7).
    const n = 30;
    var long_names: [n * 300]u8 = undefined;
    var long_children: [n]index.Child = undefined;
    for (0..n) |i| {
        const base = i * 300;
        var v = i;
        var j: usize = 4;
        long_names[base] = 'k';
        while (j > 1) {
            j -= 1;
            long_names[base + j] = '0' + @as(u8, @intCast(v % 10));
            v /= 10;
        }
        @memset(long_names[base + 4 .. base + 300], 'x');
        long_children[i] = .{
            .name = long_names[base .. base + 300],
            .kind = .file,
            .size = @intCast(i),
            .buffer_address = 1,
            .buffer_offset = @intCast(i * 400),
        };
    }
    var stream: [32 * 1024]u8 = undefined;
    var order: [n]u32 = undefined;
    var offsets: [n]u32 = undefined;
    const len = try index.write(&long_children, &order, &offsets, &stream, 4096);
    const idx = try index.Index.parse(stream[0..len]);

    var pos: u32 = idx.header.entry_area_off;
    var seen: usize = 0;
    var gaps: usize = 0;
    var long_gaps: usize = 0;
    while (true) {
        const step = (try idx.nextEntry(pos)) orelse break;
        try testing.expectEqualStrings(long_children[seen].name, step.entry.name);
        try testing.expectEqual(long_children[seen].size, step.entry.size);
        const unit: u32 = index.ENTRY_FIXED_LEN + @as(u32, @intCast(step.entry.name.len));
        const skipped = (step.next - pos) - unit;
        if (skipped > 0) gaps += 1;
        if (skipped >= 20) long_gaps += 1;
        seen += 1;
        pos = step.next;
    }
    try testing.expectEqual(@as(usize, n), seen);
    try testing.expect(gaps > 0); // chunk-end filler was crossed…
    try testing.expect(long_gaps > 0); // …including runs long enough to be read
}
