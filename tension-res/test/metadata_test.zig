//! Structural parser tests, phase 2a/2b: hand-authored Field Tables taken
//! from the standard's figures, plus a smoke test over the generated minimal
//! volume fixture.
//!
//! Every byte array below is written out explicitly so the test shows the
//! exact wire form (FID bytes, Data Length bytes, little-endian values per
//! 6.1) rather than hiding it behind a builder.

const std = @import("std");
const res = @import("../src/root.zig");
const fields = res.fields;
const metadata = res.metadata;
const index = res.index;
const testing = std.testing;

const minimal_sidf = @embedFile("fixtures/minimal.sidf");

// ---------------------------------------------------------------------------
// Timestamp (clause 7, Figure 5)
// ---------------------------------------------------------------------------

test "timestamp decodes the clause 7 layout little-endian" {
    // RBP 0 type/tz = 1, RBP 2 year = 2026, RBP 4 month = 9, RBP 5 day = 16,
    // RBP 6 hour = 23, RBP 7 minute = 59, RBP 8 second = 22, then 0s.
    const bytes = [_]u8{ 0x01, 0x00, 0xEA, 0x07, 9, 16, 23, 59, 22, 0, 0, 0 };
    const ts = try metadata.Timestamp.decode(&bytes);
    try testing.expectEqual(@as(u16, 1), ts.type_and_tz);
    try testing.expectEqual(@as(u16, 2026), ts.year);
    try testing.expectEqual(@as(u8, 9), ts.month);
    try testing.expectEqual(@as(u8, 16), ts.day);
    try testing.expect(!ts.isIgnored());
    try testing.expectEqualSlices(u8, &bytes, &ts.encode());
}

test "timestamp longer than 12 bytes ignores the NULL tail (clause 7)" {
    const bytes = [_]u8{ 0x00, 0x00, 0xE8, 0x07, 1, 2, 3, 4, 5, 6, 7, 8, 0x00, 0x00, 0x00, 0x00 };
    const ts = try metadata.Timestamp.decode(&bytes);
    try testing.expectEqual(@as(u16, 2024), ts.year);
    try testing.expectEqual(@as(u8, 8), ts.microseconds);
    try testing.expectError(error.Truncated, metadata.Timestamp.decode(bytes[0..11]));
}

test "a zero year means the timestamp is ignored (clause 7)" {
    const bytes = [_]u8{0} ** 12;
    const ts = try metadata.Timestamp.decode(&bytes);
    try testing.expect(ts.isIgnored());
}

// ---------------------------------------------------------------------------
// Stream Header / Trailer Field Tables (13.15.7.1, 13.15.7.2)
// ---------------------------------------------------------------------------

test "stream header table parses from literal bytes (Figure 38)" {
    // STREAM HEADER, STREAM TYPE = Data, STREAM FORMAT = Clear data,
    // STREAM SIZE = 6 (little-endian), closing STREAM HEADER.
    const bytes = [_]u8{
        0x1D, 0x02, 0xA5, 0x5A,
        0x2B, 0x01, 0x00,
        0x2C, 0x01, 0x00,
        0x20, 0x04, 0x06, 0x00, 0x00, 0x00,
        0x1D, 0x00,
    };
    const h = try metadata.parseStreamHeader(&bytes);
    try testing.expectEqual(@as(?u8, 0), h.stream_type);
    try testing.expectEqual(@as(?u8, 0), h.stream_format);
    try testing.expectEqual(@as(?u64, 6), h.stream_size);
    try testing.expectEqual(@as(usize, bytes.len), h.consumed);
}

test "compressed stream without STREAM COMPRESS TYPE is rejected (13.15.7.1)" {
    var buf: [64]u8 = undefined;
    var w = fields.Writer{ .buf = &buf };
    try w.tableHeader(fields.STREAM_HEADER);
    try w.field(fields.STREAM_TYPE, &.{0}); // Data
    try w.field(fields.STREAM_FORMAT, &.{2}); // Compressed
    try w.field(fields.STREAM_SIZE, &.{ 0x10, 0, 0, 0 });
    try w.tableEnd(fields.STREAM_HEADER);
    try testing.expectError(error.Invalid, metadata.parseStreamHeader(buf[0..w.len]));
}

test "stream trailer carries the invalid bit and CRC (13.15.7.2)" {
    var buf: [64]u8 = undefined;
    var w = fields.Writer{ .buf = &buf };
    try w.tableHeader(fields.STREAM_TRAILER);
    try w.bitsField(fields.STREAM_IS_INVALID, 0);
    try w.field(fields.STREAM_CRC, &.{ 0x39, 0x26, 0xF4, 0xCB });
    try w.tableEnd(fields.STREAM_TRAILER);
    const t = try metadata.parseStreamTrailer(buf[0..w.len]);
    try testing.expectEqual(@as(?u8, 0), t.stream_invalid);
    try testing.expectEqual(@as(usize, 4), t.stream_crc.?.len);
}

// ---------------------------------------------------------------------------
// Buffer Header Field Table (13.4)
// ---------------------------------------------------------------------------

fn buildBufferHeader(buf: []u8, type_byte: u8, with_address: bool) usize {
    var w = fields.Writer{ .buf = buf };
    w.tableHeader(fields.BUFFER_HEADER) catch unreachable;
    w.field(fields.OFFSET_TO_END, &.{ 0, 0 }) catch unreachable;
    w.field(fields.BUFFER_TYPE, &.{type_byte}) catch unreachable;
    w.field(fields.BUFFER_SIZE, &.{ 0x00, 0x08, 0, 0 }) catch unreachable;
    w.field(fields.BUFFER_SEQUENCE, &.{ 0x01, 0x00 }) catch unreachable;
    if (with_address) w.field(fields.BUFFER_ADDRESS, &.{ 0x01, 0, 0, 0 }) catch unreachable;
    w.field(fields.UNUSED_IN_THIS_BUFFER, &.{ 0, 0, 0, 0 }) catch unreachable;
    w.field(fields.FILE_SET_ID, &.{ 0x54, 0x45, 0x4E, 0x53 }) catch unreachable;
    w.field(fields.FILE_SET_TIME, &([_]u8{0} ** 16)) catch unreachable;
    w.tableEnd(fields.BUFFER_HEADER) catch unreachable;
    return w.len;
}

test "buffer header requires BUFFER ADDRESS for File buffers (13.4)" {
    var buf: [128]u8 = undefined;
    const n = buildBufferHeader(&buf, @intFromEnum(metadata.BufferType.file), true);
    const h = try metadata.parseBufferHeader(buf[0..n]);
    try testing.expectEqual(@as(?u8, 1), h.buffer_type);
    try testing.expectEqual(@as(?u32, 1), h.buffer_address);
    // The four bytes 54 45 4E 53 read little-endian (6.1).
    try testing.expectEqual(@as(?u32, 0x534E4554), h.file_set_id);
}

test "buffer header rejects File buffers without BUFFER ADDRESS (13.4)" {
    var buf: [128]u8 = undefined;
    const n = buildBufferHeader(&buf, @intFromEnum(metadata.BufferType.file), false);
    try testing.expectError(error.Invalid, metadata.parseBufferHeader(buf[0..n]));
}

test "buffer header rejects unknown BUFFER TYPE values (Annex C #60)" {
    var buf: [128]u8 = undefined;
    const n = buildBufferHeader(&buf, 6, false);
    try testing.expectError(error.Invalid, metadata.parseBufferHeader(buf[0..n]));
}

// ---------------------------------------------------------------------------
// File Header / File Information / Path / Characteristics (13.12-13.15)
// ---------------------------------------------------------------------------

test "file header requires FILE CHUNK SIZE and FILE TYPE (13.12)" {
    var buf: [64]u8 = undefined;
    var w = fields.Writer{ .buf = &buf };
    try w.tableHeader(fields.FILE_HEADER);
    try w.field(fields.FILE_CHUNK_SIZE, &.{ 0x88, 0x00, 0, 0 });
    try w.field(fields.FILE_TYPE, &.{@intFromEnum(metadata.FileType.source_directory)});
    try w.tableEnd(fields.FILE_HEADER);
    const h = try metadata.parseFileHeader(buf[0..w.len]);
    try testing.expectEqual(@as(?u8, 3), h.file_type);
    try testing.expectEqual(@as(?u64, 136), h.file_chunk_size);

    // Without FILE TYPE the normative text of 13.12 is violated. (Figure 25
    // marks the field optional; the conflict is reported, and the parser
    // follows the section text.)
    var buf2: [64]u8 = undefined;
    var w2 = fields.Writer{ .buf = &buf2 };
    try w2.tableHeader(fields.FILE_HEADER);
    try w2.field(fields.FILE_CHUNK_SIZE, &.{ 1, 0, 0, 0 });
    try w2.tableEnd(fields.FILE_HEADER);
    try testing.expectError(error.Invalid, metadata.parseFileHeader(buf2[0..w2.len]));

    // Annex C #70: "No other values shall be recorded."
    var buf3: [64]u8 = undefined;
    var w3 = fields.Writer{ .buf = &buf3 };
    try w3.tableHeader(fields.FILE_HEADER);
    try w3.field(fields.FILE_CHUNK_SIZE, &.{ 1, 0, 0, 0 });
    try w3.field(fields.FILE_TYPE, &.{9});
    try w3.tableEnd(fields.FILE_HEADER);
    try testing.expectError(error.Invalid, metadata.parseFileHeader(buf3[0..w3.len]));
}

fn buildFileInformation(buf: []u8, parent: u8, pfq: u8, name: []const u8) usize {
    var w = fields.Writer{ .buf = buf };
    w.tableHeader(fields.FILE_INFORMATION) catch unreachable;
    w.field(fields.PARENT, &.{parent}) catch unreachable;
    w.field(fields.PATH_FULLY_QUALIFIED, &.{pfq}) catch unreachable;
    w.field(fields.DATA_STREAM_SIZE, &.{ 0x5B, 0, 0, 0 }) catch unreachable;
    w.field(fields.NAME_SPACE, &.{0x01}) catch unreachable; // NS1 (Figure 4)
    w.field(fields.PATH_NAME, name) catch unreachable;
    w.tableEnd(fields.FILE_INFORMATION) catch unreachable;
    return w.len;
}

test "file information parses the directory form and its namespace set (13.14)" {
    var buf: [256]u8 = undefined;
    const n = buildFileInformation(&buf, 1, 1, "assets");
    const fi = try metadata.parseFileInformation(buf[0..n]);
    try testing.expectEqual(@as(?u8, 1), fi.parent);
    try testing.expectEqual(@as(?u8, 1), fi.path_fully_qualified);
    try testing.expectEqual(@as(?u32, 1), fi.first_name_space.?);
    try testing.expectEqualStrings("assets", fi.first_path_name.?);
    try testing.expectEqual(@as(?u64, 91), fi.data_stream_size);

    var it = try metadata.NamespaceIter.init(buf[0..n]);
    const first = (try it.next()).?;
    try testing.expectEqualStrings("assets", first.path_name);
    try testing.expectEqual(@as(?metadata.NamespaceEntry, null), try it.next());
}

test "file information without a directory tag is rejected (13.14)" {
    // PATH NAME before NAME SPACE violates the iterated-set rule in 13.14.
    var buf: [128]u8 = undefined;
    var w = fields.Writer{ .buf = &buf };
    try w.tableHeader(fields.FILE_INFORMATION);
    try w.field(fields.PARENT, &.{0});
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{0});
    try w.field(fields.PATH_NAME, "hello.txt");
    try w.tableEnd(fields.FILE_INFORMATION);
    try testing.expectError(error.Invalid, metadata.parseFileInformation(buf[0..w.len]));
}

test "path table and characteristics parse their bit-data attributes (13.15.1, 13.15.2)" {
    var pbuf: [128]u8 = undefined;
    var pw = fields.Writer{ .buf = &pbuf };
    try pw.tableHeader(fields.PATH);
    try pw.field(fields.PATH_FULLY_QUALIFIED, &.{0});
    try pw.field(fields.NAME_SPACE, &.{0x01});
    try pw.field(fields.PATH_NAME, "hello.txt");
    try pw.tableEnd(fields.PATH);
    const path = try metadata.parsePathTable(pbuf[0..pw.len]);
    try testing.expectEqual(@as(?u8, 0), path.path_fully_qualified);
    try testing.expectEqualStrings("hello.txt", path.first_path_name.?);

    var cbuf: [128]u8 = undefined;
    var cw = fields.Writer{ .buf = &cbuf };
    try cw.tableHeader(fields.CHARACTERISTICS);
    try cw.bitsField(fields.SOURCE_DIRECTORY, 1);
    try cw.bitsField(fields.READ_ONLY, 0);
    try cw.tableEnd(fields.CHARACTERISTICS);
    const ch = try metadata.parseCharacteristics(cbuf[0..cw.len]);
    try testing.expectEqual(@as(?u8, 1), ch.source_directory);
    try testing.expectEqual(@as(?u8, 0), ch.read_only);
}

// ---------------------------------------------------------------------------
// Framing failures (10.5)
// ---------------------------------------------------------------------------

test "framing violations are errors, never panics" {
    var buf: [64]u8 = undefined;

    // Wrong header FID.
    var w = fields.Writer{ .buf = &buf };
    try w.tableHeader(fields.PATH);
    try w.tableEnd(fields.PATH);
    try testing.expectError(error.Invalid, metadata.parseVolumeHeader(buf[0..w.len]));

    // Bad resynchronization pattern (10.5, 6.23).
    var buf2: [64]u8 = undefined;
    var w2 = fields.Writer{ .buf = &buf2 };
    try w2.field(fields.PATH, &.{ 0x5A, 0xA5 });
    try w2.tableEnd(fields.PATH);
    try testing.expectError(error.Invalid, metadata.parsePathTable(buf2[0..w2.len]));

    // Bytes after the closing Field are not part of the table: the table is
    // terminated by its closing FID (10.5) and `consumed` says where it
    // ended. This is what lets a parser read a table out of a larger buffer
    // (a Buffer Data Space, a sector with Blank Space padding, ...).
    var buf3: [64]u8 = undefined;
    var w3 = fields.Writer{ .buf = &buf3 };
    try w3.tableHeader(fields.PATH);
    try w3.field(fields.PATH_FULLY_QUALIFIED, &.{1});
    try w3.field(fields.NAME_SPACE, &.{1});
    try w3.field(fields.PATH_NAME, "x");
    try w3.tableEnd(fields.PATH);
    const table_len = w3.len;
    try w3.appendByte(0x00);
    const path3 = try metadata.parsePathTable(buf3[0..w3.len]);
    try testing.expectEqual(table_len, path3.consumed);
    try testing.expectEqualStrings("x", path3.first_path_name.?);

    // Truncation.
    var buf4: [64]u8 = undefined;
    var w4 = fields.Writer{ .buf = &buf4 };
    try w4.tableHeader(fields.PATH);
    try w4.field(fields.PATH_FULLY_QUALIFIED, &.{1});
    try testing.expectError(error.Truncated, metadata.parsePathTable(buf4[0..w4.len]));
}

// ---------------------------------------------------------------------------
// Phase 2b: the generated minimal volume
// ---------------------------------------------------------------------------

test "minimal fixture volume parses end to end" {
    const sector: usize = 512;

    const vh = try metadata.parseVolumeHeader(minimal_sidf[0..]);
    try testing.expectEqual(@as(?u32, 512), vh.sector_size);
    try testing.expectEqualStrings("SIDF", vh.format_name.?[0..4]);
    try testing.expectEqualStrings("TENSION", vh.volume_set_label.?);
    try testing.expectEqual(@as(?u16, 1), vh.volume_set_sequence);
    try testing.expectEqual(@as(?u8, 0), vh.file_mark_usage);
    try testing.expect(vh.volume_set_time.?.isIgnored());

    const fsh = try metadata.parseFileSetHeader(minimal_sidf[sector..]);
    try testing.expectEqual(@as(?u32, 2048), fsh.buffer_size);
    try testing.expectEqual(@as(?u8, 0), fsh.file_set_index_present);
    try testing.expectEqualStrings("TENSION", fsh.file_set_label.?);

    // First File Buffer (10.6): Buffer Header FT immediately followed by the
    // root directory File Space.
    const buf1 = 2 * sector;
    const bh = try metadata.parseBufferHeader(minimal_sidf[buf1..]);
    try testing.expectEqual(@as(?u8, @intFromEnum(metadata.BufferType.file)), bh.buffer_type);
    try testing.expectEqual(@as(?u32, 1), bh.buffer_address);
    try testing.expect(bh.unused.? > 0);

    const dir_file = buf1 + bh.consumed;
    const dh = try metadata.parseFileHeader(minimal_sidf[dir_file..]);
    try testing.expectEqual(@as(?u8, @intFromEnum(metadata.FileType.source_directory)), dh.file_type);
    try testing.expect(dh.file_chunk_size.? > 0);

    const di = try metadata.parseFileInformation(minimal_sidf[dir_file + dh.consumed ..]);
    try testing.expectEqual(@as(?u8, 1), di.parent);
    try testing.expectEqualStrings("assets", di.first_path_name.?);

    // Second File Buffer: the child file.
    const buf2 = buf1 + 2048;
    const bh2 = try metadata.parseBufferHeader(minimal_sidf[buf2..]);
    try testing.expectEqual(@as(?u32, 5), bh2.buffer_address);
    const child_file = buf2 + bh2.consumed;
    const ch = try metadata.parseFileHeader(minimal_sidf[child_file..]);
    try testing.expectEqual(@as(?u8, @intFromEnum(metadata.FileType.file)), ch.file_type);
    const ci = try metadata.parseFileInformation(minimal_sidf[child_file + ch.consumed ..]);
    try testing.expectEqual(@as(?u8, 0), ci.parent);
    try testing.expectEqual(@as(?u8, 0), ci.path_fully_qualified);
    try testing.expectEqualStrings("hello.txt", ci.first_path_name.?);
    try testing.expectEqual(@as(?u64, 6), ci.data_stream_size);

    // Walk the directory File's File Data (13.15.4) to its index Stream and
    // probe it (DESIGN.md §6.7).
    var at = dir_file + dh.consumed + di.consumed;
    at += try tableLen(minimal_sidf[at..], fields.SOURCE_DIRECTORY_HEADER);
    const path = try metadata.parsePathTable(minimal_sidf[at..]);
    try testing.expectEqualStrings("assets", path.first_path_name.?);
    at += path.consumed;
    const chars = try metadata.parseCharacteristics(minimal_sidf[at..]);
    try testing.expectEqual(@as(?u8, 1), chars.source_directory);
    at += chars.consumed;
    const stream = try metadata.parseStreamHeader(minimal_sidf[at..]);
    try testing.expectEqual(@as(?u8, 0), stream.stream_type);
    try testing.expectEqual(@as(?u8, 0), stream.stream_format);
    at += stream.consumed;

    const idx = try index.Index.parse(minimal_sidf[at..][0..@intCast(stream.stream_size.?)]);
    try idx.validateAll();
    const hit = (try idx.probe("hello.txt", null)) orelse return error.IndexMiss;
    try testing.expectEqual(index.Kind.file, hit.kind);
    try testing.expectEqual(@as(u32, 6), hit.size);
    try testing.expectEqual(@as(u16, 1), hit.volume_set_sequence);
    try testing.expectEqual(@as(u32, 5), hit.buffer_address); // buffer 2, FS header at sector 1
    try testing.expectEqual(@as(u32, 62), hit.buffer_offset); // its File Header offset
    try testing.expect((try idx.probe("missing.txt", null)) == null);
}

/// Length of a Field Table, from its closing Field (10.5): what the walker
/// needs to step from one table to the next.
fn tableLen(data: []const u8, fid: fields.Fid) !usize {
    var t = try metadata.Table.init(data, fid);
    while (try t.next()) |_| {}
    return t.cursor.pos;
}
