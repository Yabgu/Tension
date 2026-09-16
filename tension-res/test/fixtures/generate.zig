//! Minimal ECMA-208 (SIDF) volume generator — phase 2b.
//!
//! Emits `test/fixtures/minimal.sidf`: one volume, one file set, one Source
//! directory File carrying a child-index Stream (the §5.5 convention), and
//! one child File whose payload is a Data Stream. This is a deliberate subset
//! of the phase-7 packer; its job is to give phases 3 and 4 a committed,
//! spec-conformant image to parse.
//!
//! Layout (all offsets in bytes; SECTOR = 512 per 10.1, BUFFER = 2048):
//!
//!   sector 0        Volume Header FT (13.1) + Blank Space (13.3) padding
//!   sector 1        File Set Header FT (13.7) + Blank Space padding
//!   sectors 2..5    Buffer 1 (13.4): header + root directory File Space (10.6)
//!   sectors 6..9    Buffer 2: header + child File Space
//!   sector 10       File Set Trailer FT (13.9) + Blank Space padding
//!
//! Determinism: every field width is fixed by this file, every timestamp is
//! the all-zero "ignored" form of clause 7, and no random value is written,
//! so two runs must produce byte-identical output (checked with `cmp`).
//!
//! The directory's index Stream payload is the final §6.7 encoding, written
//! by `res.index`; this generator patches the child's physical location and
//! chunk 0's position once the layout is known.

const std = @import("std");
const res = @import("tension_res");
const fields = res.fields;
const metadata = res.metadata;
const index = res.index;

pub const SECTOR: usize = 512;
pub const BUFFER: usize = 2048;
pub const OUT_PATH = "test/fixtures/minimal.sidf";

/// The File Set ID is a 4-byte value chosen by the originating system (13.7).
const FILE_SET_ID: u32 = 0x54454E53; // "TENS" as bytes 54 45 4E 53

const PAYLOAD = "hello\n";
const CHILD_NAME = "hello.txt";
const ROOT_NAME = "assets";

const VH_END = SECTOR;
const FSH_END = 2 * SECTOR;
const BUF1_OFF = FSH_END;
const BUF1_END = BUF1_OFF + BUFFER;
const BUF2_OFF = BUF1_END;
const BUF2_END = BUF2_OFF + BUFFER;
const TRAILER_OFF = BUF2_END;
pub const IMAGE_LEN = TRAILER_OFF + SECTOR;

fn u16bytes(v: u16) [2]u8 {
    var b: [2]u8 = undefined;
    fields.writeUintLe(&b, v);
    return b;
}

fn u32bytes(v: u32) [4]u8 {
    var b: [4]u8 = undefined;
    fields.writeUintLe(&b, v);
    return b;
}

fn u64bytes(v: u64) [8]u8 {
    var b: [8]u8 = undefined;
    fields.writeUintLe(&b, v);
    return b;
}

const OtePatch = struct { pos: usize };

/// OFFSET TO END is mandatory in several tables; its value ("Bytes from start
/// of next Field to start of last Field", 13.1/13.3/13.4/13.7/13.9) is only
/// known once the table is complete, so write a placeholder and patch it in
/// `endTable`.
fn writeOte(w: *fields.Writer) !OtePatch {
    try w.field(fields.OFFSET_TO_END, &.{ 0, 0 });
    return .{ .pos = w.len - 2 };
}

fn endTable(w: *fields.Writer, header: fields.Fid, ote: OtePatch) !void {
    const closing_start = w.len;
    try w.tableEnd(header);
    const value = closing_start - (ote.pos + 2);
    if (value > 0xFFFF) return error.ValueTooLarge;
    fields.patchUintLe(w.buf, ote.pos, value, 2);
}

/// Pad to `end` with a Blank Space Field Table (13.3): BLANK SPACE, OFFSET TO
/// END, NULL Fields, BLANK SPACE.
fn padWithBlankSpace(w: *fields.Writer, end: usize) !void {
    const remain = end - w.len;
    const overhead = 6 + 4 + 4; // header field + OFFSET TO END + closing field
    if (remain < overhead) return error.NotEnoughRoomForBlankSpace;
    try w.tableHeader(fields.BLANK_SPACE);
    const ote = try writeOte(w);
    var i: usize = overhead;
    while (i < remain) : (i += 1) try w.appendByte(fields.NULL_BYTE);
    try endTable(w, fields.BLANK_SPACE, ote);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

fn writeVolumeHeader(w: *fields.Writer) !void {
    try w.tableHeader(fields.VOLUME_HEADER);
    const ote = try writeOte(w);
    try w.field(fields.FORMAT_NAME, "SIDF"); // Annex C: the 4 bytes S I D F
    try w.field(fields.FORMAT_VERSION, &.{ 1, 0, 0, 0 }); // Annex C: B0 major, B1 minor, ...
    try w.field(fields.SECTOR_SIZE, &u32bytes(SECTOR)); // 10.1: 2^(n+8), 512 valid
    const zero_ts = [_]u8{0} ** 16; // clause 7: year 0 -> timestamp ignored
    try w.field(fields.VOLUME_SET_TIME, &zero_ts);
    try w.field(fields.VOLUME_TIME, &zero_ts);
    try w.field(fields.VOLUME_SET_LABEL, "TENSION");
    try w.field(fields.VOLUME_SET_SEQUENCE, &u16bytes(1)); // Fixed, 2 bytes (Annex C #80F100)
    try w.bitsField(fields.VOLUME_INDEX_REQUIRED, 0); // Bit Data (Annex C #80802F)
    try w.bitsField(fields.FILE_MARK_USAGE, 0); // Bit Data (Annex C #808020): no file marks
    try endTable(w, fields.VOLUME_HEADER, ote);
}

fn writeFileSetHeader(w: *fields.Writer) !void {
    try w.tableHeader(fields.FILE_SET_HEADER);
    const ote = try writeOte(w);
    try w.field(fields.FILE_SET_ID, &u32bytes(FILE_SET_ID)); // Fixed, 4 bytes (Annex C #8072)
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try w.field(fields.FILE_SET_LABEL, "TENSION");
    try w.bitsField(fields.FILE_SET_INDEX_PRESENT, 0); // Bit Data (Annex C #80802D)
    try w.field(fields.BUFFER_SIZE, &u32bytes(BUFFER));
    try w.field(fields.SOURCE_NAME_TYPE, &.{0x01}); // NS1 (Figure 4)
    try w.field(fields.SOURCE_NAME, "TENSION");
    try w.field(fields.SOURCE_OPERATING_SYSTEM, "TENSION");
    try w.field(fields.SOURCE_OPERATING_SYSTEM_VERSION, "0.1.0");
    try endTable(w, fields.FILE_SET_HEADER, ote);
}

fn writeFileSetTrailer(w: *fields.Writer) !void {
    try w.tableHeader(fields.FILE_SET_TRAILER);
    const ote = try writeOte(w);
    try w.field(fields.FILE_SET_ID, &u32bytes(FILE_SET_ID));
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try w.field(fields.FILE_SET_LABEL, "TENSION");
    try w.field(fields.SOURCE_NAME_TYPE, &.{0x01});
    try w.field(fields.SOURCE_NAME, "TENSION");
    try w.field(fields.SOURCE_OPERATING_SYSTEM, "TENSION");
    try w.field(fields.SOURCE_OPERATING_SYSTEM_VERSION, "0.1.0");
    try endTable(w, fields.FILE_SET_TRAILER, ote);
}

/// Buffer Header FT (13.4). `unused` is the Blank Space byte count that will
/// follow, so it is computed by the caller before the buffer is written.
fn writeBufferHeader(w: *fields.Writer, sequence: u32, address: u32, unused: u32) !void {
    try w.tableHeader(fields.BUFFER_HEADER);
    const ote = try writeOte(w);
    try w.field(fields.BUFFER_TYPE, &.{@intFromEnum(metadata.BufferType.file)}); // Fixed, 1 byte
    try w.field(fields.BUFFER_SIZE, &u32bytes(BUFFER));
    try w.field(fields.BUFFER_SEQUENCE, &u32bytes(sequence));
    try w.field(fields.BUFFER_ADDRESS, &u32bytes(address));
    try w.field(fields.UNUSED_IN_THIS_BUFFER, &u32bytes(unused));
    try w.field(fields.FILE_SET_ID, &u32bytes(FILE_SET_ID));
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try endTable(w, fields.BUFFER_HEADER, ote);
}

/// File Header FT (13.12). Returns the offset of the FILE CHUNK SIZE data so
/// the caller can patch in the whole-file byte count once it is known.
fn writeFileHeader(w: *fields.Writer, file_type: u8) !usize {
    try w.tableHeader(fields.FILE_HEADER);
    try w.field(fields.FILE_CHUNK_SIZE, &u32bytes(0));
    const pos = w.len - 4;
    try w.field(fields.FILE_TYPE, &.{file_type}); // Fixed, 1 byte (Annex C #70)
    try w.tableEnd(fields.FILE_HEADER);
    return pos;
}

/// File Information FT (13.14). One NS1 iteration; the child's already-seen
/// directory supplies the path prefix because PATH FULLY QUALIFIED is 0 there
/// (13.14's requirement, by reference to 13.10).
fn writeFileInformation(w: *fields.Writer, parent: u8, pfq: u8, name: []const u8, data_stream_size: u32) !void {
    try w.tableHeader(fields.FILE_INFORMATION);
    // ATTRIBUTES #81F2FE is FID-fixed at 4 bytes (Annex A) even though
    // Annex C describes it as Variable — see the phase-2 conflict report.
    try w.field(fields.ATTRIBUTES, &.{ 0, 0, 0, 0 });
    try w.field(fields.PARENT, &.{parent}); // Fixed, 1 byte (Annex C #81F0FD)
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{pfq}); // Fixed, 1 byte (Annex C #50)
    try w.field(fields.CREATOR_NAME_SPACE, &u32bytes(0x01)); // Fixed, 4 bytes: NS1
    try w.field(fields.DATA_STREAM_SIZE, &u32bytes(data_stream_size));
    try w.field(fields.NAME_SPACE, &.{0x01}); // NS1 (Figure 4)
    try w.field(fields.PATH_NAME, name);
    try w.tableEnd(fields.FILE_INFORMATION);
}

fn writeStreamHeader(w: *fields.Writer, stream_size: u32) !void {
    try w.tableHeader(fields.STREAM_HEADER);
    try w.field(fields.STREAM_TYPE, &.{@intFromEnum(metadata.StreamType.data)}); // Annex C #2B: 0 = Data
    try w.field(fields.STREAM_FORMAT, &.{@intFromEnum(metadata.StreamFormat.clear_data)}); // Annex C #2C: 0 = Clear
    try w.field(fields.STREAM_SIZE, &u32bytes(stream_size));
    try w.tableEnd(fields.STREAM_HEADER);
}

/// Source directory File Data (13.15.4). Returns the offset of the index
/// Stream's payload inside the file being written.
fn writeDirectoryData(w: *fields.Writer, index_stream: []const u8) !usize {
    try w.tableHeader(fields.SOURCE_DIRECTORY_HEADER); // 13.15.4.1
    try w.tableEnd(fields.SOURCE_DIRECTORY_HEADER);

    try w.tableHeader(fields.PATH); // Path FT (13.15.1)
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{1});
    try w.field(fields.NAME_SPACE, &.{0x01});
    try w.field(fields.PATH_NAME, ROOT_NAME);
    try w.tableEnd(fields.PATH);

    try w.tableHeader(fields.CHARACTERISTICS); // Characteristics FT (13.15.2)
    try w.bitsField(fields.SOURCE_DIRECTORY, 1);
    try w.tableEnd(fields.CHARACTERISTICS);

    try writeStreamHeader(w, @intCast(index_stream.len));
    const offset = w.len;
    try w.append(index_stream);
    try w.tableHeader(fields.STREAM_TRAILER); // 13.15.7.2
    try w.tableEnd(fields.STREAM_TRAILER);

    try w.tableHeader(fields.SOURCE_DIRECTORY_TRAILER); // 13.15.4.2
    try w.tableEnd(fields.SOURCE_DIRECTORY_TRAILER);
    return offset;
}

/// Source file File Data (13.15.5). Returns the offset of the payload.
fn writeChildData(w: *fields.Writer, payload: []const u8) !usize {
    try w.tableHeader(fields.SOURCE_FILE_HEADER); // 13.15.5.1
    try w.tableEnd(fields.SOURCE_FILE_HEADER);

    try w.tableHeader(fields.PATH);
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{0});
    try w.field(fields.NAME_SPACE, &.{0x01});
    try w.field(fields.PATH_NAME, CHILD_NAME);
    try w.tableEnd(fields.PATH);

    try w.tableHeader(fields.CHARACTERISTICS); // no attributes: only the mandatory CHARACTERISTICS field
    try w.tableEnd(fields.CHARACTERISTICS);

    try writeStreamHeader(w, @intCast(payload.len));
    const offset = w.len;
    try w.append(payload);
    try w.tableHeader(fields.STREAM_TRAILER);
    try w.tableEnd(fields.STREAM_TRAILER);

    try w.tableHeader(fields.SOURCE_FILE_TRAILER); // 13.15.5.2
    try w.tableEnd(fields.SOURCE_FILE_TRAILER);
    return offset;
}


// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/// Write the minimal volume into `image`; returns its length in bytes.
pub fn generate(image: []u8) !usize {
    // 1. Build the two Files into scratch buffers first: their sizes decide
    //    the Buffer padding, and the index Stream is patched once the physical
    //    layout is known.
    // The child-index Stream (§6.7), with physical positions left zero: they
    // are patched once the layout is known. One child, one chunk.
    var index_buf: [512]u8 = undefined;
    var index_children = [_]index.Child{.{
        .name = CHILD_NAME,
        .kind = .file,
        .size = PAYLOAD.len,
    }};
    var index_order: [1]u32 = undefined;
    var index_offsets: [1]u32 = undefined;
    const index_len = try index.write(&index_children, &index_order, &index_offsets, &index_buf, 512);
    const index_len_u32: u32 = @intCast(index_len);

    // Pass 1 measures the directory file with a zeroed placeholder of the
    // same length, so the stream's physical position is known before the real
    // bytes are written.
    var dir_buf: [1024]u8 = undefined;
    var placeholder = [_]u8{0} ** 512;
    var dir_w = fields.Writer{ .buf = &dir_buf };
    _ = try writeFileHeader(&dir_w, @intFromEnum(metadata.FileType.source_directory));
    try writeFileInformation(&dir_w, 1, 1, ROOT_NAME, index_len_u32);
    const idx_file_off = try writeDirectoryData(&dir_w, placeholder[0..index_len]);

    var child_buf: [1024]u8 = undefined;
    var child_w = fields.Writer{ .buf = &child_buf };
    const child_chunk_patch = try writeFileHeader(&child_w, @intFromEnum(metadata.FileType.file));
    try writeFileInformation(&child_w, 0, 0, CHILD_NAME, PAYLOAD.len);
    _ = try writeChildData(&child_w, PAYLOAD);
    fields.patchUintLe(&child_buf, child_chunk_patch, child_w.len, 4);

    // 2. Measure the buffer header (its length does not depend on its values).
    var bh_scratch: [256]u8 = undefined;
    var bh_w = fields.Writer{ .buf = &bh_scratch };
    try writeBufferHeader(&bh_w, 1, 1, 0);
    const bh_len = bh_w.len;

    // 3. Physical positions (10.1: absolute Sector Numbers from the Volume
    //    start; 13.4: BUFFER ADDRESS counts sectors from the File Set Header).
    const dir_file_img_off = BUF1_OFF + bh_len;
    const index_img_off = dir_file_img_off + idx_file_off;
    const child_file_img_off = BUF2_OFF + bh_len;

    const fs_header_sector: u32 = 1; // the File Set Header's sector (§11.1 ruling 4)
    const index_buffer_address: u32 = @intCast(index_img_off / SECTOR - fs_header_sector);
    const index_offset: u32 = @intCast(index_img_off % SECTOR);
    const child_buffer_address: u32 = @intCast(child_file_img_off / SECTOR - fs_header_sector);
    const child_offset: u32 = @intCast(child_file_img_off % SECTOR);

    // Patch chunk 0's position and the child entry's location (§6.7: entry
    // offsets +10 buffer_address, +14 buffer_offset).
    const index_header = try index.parseHeader(&index_buf);
    try index.setChunkPosition(&index_buf, index_header, 0, index_buffer_address, index_offset);
    const entry_at: usize = @intCast(index_offsets[0]);
    fields.writeUintLe(index_buf[entry_at + 10 ..][0..4], child_buffer_address);
    fields.writeUintLe(index_buf[entry_at + 14 ..][0..4], child_offset);

    // Pass 2: rebuild the directory file with the patched index.
    var dir_w2 = fields.Writer{ .buf = &dir_buf };
    const dir_chunk_patch2 = try writeFileHeader(&dir_w2, @intFromEnum(metadata.FileType.source_directory));
    try writeFileInformation(&dir_w2, 1, 1, ROOT_NAME, index_len_u32);
    const idx_file_off2 = try writeDirectoryData(&dir_w2, index_buf[0..index_len]);
    if (idx_file_off2 != idx_file_off) return error.LayoutChanged;
    // (the FILE CHUNK SIZE patch for pass 2)
    fields.patchUintLe(&dir_buf, dir_chunk_patch2, dir_w2.len, 4);

    // 4. Assemble the image.
    var w = fields.Writer{ .buf = image };
    try writeVolumeHeader(&w);
    try padWithBlankSpace(&w, VH_END);

    try writeFileSetHeader(&w);
    try padWithBlankSpace(&w, FSH_END);

    try writeBufferHeader(&w, 1, 1, @intCast(BUFFER - (bh_len + dir_w.len)));
    try w.append(dir_buf[0..dir_w.len]);
    try padWithBlankSpace(&w, BUF1_END);

    try writeBufferHeader(&w, 2, 5, @intCast(BUFFER - (bh_len + child_w.len)));
    try w.append(child_buf[0..child_w.len]);
    try padWithBlankSpace(&w, BUF2_END);

    try writeFileSetTrailer(&w);
    try padWithBlankSpace(&w, IMAGE_LEN);
    return w.len;
}

pub fn main() !void {
    var image: [IMAGE_LEN]u8 = undefined;
    const n = try generate(&image);
    // Zig 0.16 file APIs take an explicit Io instance.
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = OUT_PATH, .data = image[0..n] });
    std.debug.print("wrote {s}: {d} bytes\n", .{ OUT_PATH, n });
}
