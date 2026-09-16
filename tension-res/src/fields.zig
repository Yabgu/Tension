//! Field-layer primitives for ECMA-208 (SIDF), 1st edition, December 1994.
//!
//! Everything in a SIDF volume except Stream payloads is expressed in Fields
//! (10.4), and every Field is `FID + optional Data Length + optional Data`
//! (10.4, Figure 11). This module owns that layer: the FID byte encoding
//! (Annex A), the three Data Length formats (Annex B), Field Table framing
//! (10.5), the resynchronization pattern (6.23), and the ITU X.25 CRC
//! (clause 9). It knows nothing about volumes, files or streams — that is
//! `metadata.zig`.
//!
//! Two recording rules from the standard shape every byte here:
//!
//! * Numbers inside Field data are recorded **least significant byte first**
//!   (6.1), so all integer codecs in this file are little-endian.
//! * A FID whose bit structure implies a fixed data length has **no** Data
//!   Length part; every other FID carries one (10.4, Annex A, Annex B).

const std = @import("std");
const errors = @import("errors.zig");

pub const ParseError = errors.ParseError;
pub const WriteError = errors.WriteError;

/// The Resynchronization Pattern is the two-byte Byte Sequence #A55A (6.23).
/// It is stored in the first Field of every Field Table (10.5). The notation
/// is a byte sequence, like FIDs, so the bytes are A5 5A in written order.
pub const RESYNC_BYTES = [2]u8{ 0xA5, 0x5A };

/// The NULL Field is the single byte #00; it has no length part and no data,
/// and is used as Blank Space filler (10.4.1).
pub const NULL_BYTE: u8 = 0x00;

/// A Field Identifier: the byte sequence's value plus its byte length
/// (Annex A.1: "a sequence of one to four bytes").
pub const Fid = struct {
    code: u32,
    len: u3,

    /// The FID's bytes, most significant first, as Annex A writes them:
    /// #808000 is the three bytes 80 80 00 and #01 is the byte 01.
    pub fn bytes(self: Fid) [4]u8 {
        var out = [4]u8{ 0, 0, 0, 0 };
        var v = self.code;
        var i: usize = @as(usize, self.len);
        while (i > 0) {
            i -= 1;
            out[i] = @intCast(v & 0xFF);
            v >>= 8;
        }
        return out;
    }

    pub fn eql(self: Fid, other: Fid) bool {
        return self.code == other.code and self.len == other.len;
    }
};

/// A FID value with its length derived from the value's magnitude — valid
/// because Annex A never encodes a leading zero byte.
pub fn fid(code: u32) Fid {
    if (code <= 0xFF) return .{ .code = code, .len = 1 };
    if (code <= 0xFFFF) return .{ .code = code, .len = 2 };
    if (code <= 0xFF_FFFF) return .{ .code = code, .len = 3 };
    return .{ .code = code, .len = 4 };
}

/// The byte length of a FID, from its first byte (Annex A.2-A.5):
/// b7=0 -> 1 byte; b7=1,b6=0 -> 2 bytes, or 3 when the second byte has b7=1
/// (Case A); b7=1,b6=1 -> 3 bytes, or 4 when the third byte has b7=1.
pub fn fidLen(first: u8, second: ?u8, third: ?u8) ParseError!u3 {
    if (first & 0x80 == 0) return 1;
    if (first & 0x40 == 0) {
        const b1 = second orelse return error.Truncated;
        return if (b1 & 0x80 == 0) 2 else 3;
    }
    const b2 = third orelse return error.Truncated;
    return if (b2 & 0x80 != 0) 4 else 3;
}

/// Read a FID at the start of `data` (Annex A).
pub fn readFid(data: []const u8) ParseError!Fid {
    if (data.len == 0) return error.Truncated;
    const first = data[0];
    const second: ?u8 = if (data.len > 1) data[1] else null;
    const third: ?u8 = if (data.len > 2) data[2] else null;
    const n = try fidLen(first, second, third);
    const n_usize: usize = @as(usize, n);
    if (data.len < n_usize) return error.Truncated;
    var code: u32 = 0;
    for (data[0..n_usize]) |b| code = (code << 8) | b;
    return .{ .code = code, .len = n };
}

/// The data width a FID implies, or null when the Data Length part is
/// present (Annex A.2-A.5, "Fixed Data Length"). The fixed widths are 2^N
/// where N is taken from the FID's low three bits of the byte that carries
/// the "1 1 1 ..." / b6=1 pattern.
pub fn fixedLen(f: Fid) ?u32 {
    const b = f.bytes();
    switch (f.len) {
        1 => {
            // A.2: b6=1 -> fixed, N = b2..b0.
            if (b[0] & 0x40 != 0) return @as(u32, 1) << @intCast(b[0] & 0x07);
            return null;
        },
        2 => {
            // A.3: the second byte is interpreted as for 1-byte FIDs.
            if (b[1] & 0x40 != 0) return @as(u32, 1) << @intCast(b[1] & 0x07);
            return null;
        },
        3 => {
            if (b[0] & 0x40 == 0) {
                // A.4 Case A: bits b6,b5,b4 of the second byte all ONE.
                if ((b[1] & 0x70) == 0x70) return @as(u32, 1) << @intCast(b[1] & 0x07);
                return null;
            }
            // A.4 Case B: the third byte is interpreted as for 1-byte FIDs.
            if (b[2] & 0x40 != 0) return @as(u32, 1) << @intCast(b[2] & 0x07);
            return null;
        },
        4 => {
            // A.5: the third byte is interpreted as Case A of the 3-byte FIDs.
            if ((b[2] & 0x70) == 0x70) return @as(u32, 1) << @intCast(b[2] & 0x07);
            return null;
        },
        else => return null,
    }
}

/// One Field: its FID, its data bytes, and — for Bit Data fields (Annex B.3)
/// — the bits carried in the Data Length part, which has no Data part.
pub const Field = struct {
    fid: Fid,
    data: []const u8,
    bits: ?u8 = null,
};

/// A bounds-checked reader over a byte slice. Never panics.
pub const Cursor = struct {
    buf: []const u8,
    pos: usize = 0,

    pub fn remaining(self: *const Cursor) usize {
        return self.buf.len - self.pos;
    }

    pub fn take(self: *Cursor, n: usize) ParseError![]const u8 {
        if (self.pos > self.buf.len or n > self.buf.len - self.pos) return error.Truncated;
        const out = self.buf[self.pos .. self.pos + n];
        self.pos += n;
        return out;
    }
};

/// Read one Field (Annex B for the three Data Length formats).
pub fn nextField(c: *Cursor) ParseError!?Field {
    if (c.remaining() == 0) return null;
    const f = try readFid(c.buf[c.pos..]);
    c.pos += @as(usize, f.len);
    // 10.4.1: the NULL Field is only its single-byte FID #00 — no Data
    // Length part, no Data part (it is used as Blank Space filler).
    if (f.len == 1 and f.code == 0) return Field{ .fid = f, .data = &.{} };
    if (fixedLen(f)) |w| {
        // Fixed-width FIDs carry no Data Length part (10.4).
        return Field{ .fid = f, .data = try c.take(@intCast(w)) };
    }
    const lead = (try c.take(1))[0];
    if (lead & 0x80 == 0) {
        // B.1 Direct: one byte, 0..127.
        return Field{ .fid = f, .data = try c.take(lead) };
    }
    if (lead & 0xC0 == 0x80) {
        // B.2 Indirect: b1b0 = N, then 2^N bytes of length, LSB first.
        const nbytes: usize = @as(usize, 1) << @intCast(lead & 0x03);
        const len = readUintLe(try c.take(nbytes));
        return Field{ .fid = f, .data = try c.take(@intCast(len)) };
    }
    // B.3 Bit Data: the bits live in the Data Length part; no Data part.
    return Field{ .fid = f, .data = &.{}, .bits = lead & 0x3F };
}

/// Little-endian integer reader (6.1) over 1..8 bytes.
pub fn readUintLe(data: []const u8) u64 {
    var v: u64 = 0;
    var scale: u64 = 1;
    var i: usize = 0;
    while (i < data.len and i < 8) : (i += 1) {
        v += @as(u64, data[i]) * scale;
        scale *%= 256; // wraps after the 8th byte; the value is unused then
    }
    return v;
}

/// Little-endian integer writer (6.1); writes exactly `out.len` bytes.
pub fn writeUintLe(out: []u8, value: u64) void {
    var v = value;
    for (out) |*b| {
        b.* = @intCast(v & 0xFF);
        v >>= 8;
    }
}

/// Patch a little-endian integer into an existing buffer (OFFSET TO END and
/// similar fields are written as placeholders, then patched).
pub fn patchUintLe(buf: []u8, pos: usize, value: u64, width: usize) void {
    writeUintLe(buf[pos .. pos + width], value);
}

/// Append-only writer over a caller-owned buffer. No allocation, no panics.
pub const Writer = struct {
    buf: []u8,
    len: usize = 0,

    pub fn append(self: *Writer, bytes: []const u8) WriteError!void {
        if (self.len > self.buf.len or bytes.len > self.buf.len - self.len) return error.NoSpace;
        @memcpy(self.buf[self.len .. self.len + bytes.len], bytes);
        self.len += bytes.len;
    }

    /// Advance past bytes that are already in place (used when a caller
    /// assembles a region in place, e.g. a directory listing already written
    /// into the destination buffer).
    pub fn skip(self: *Writer, n: usize) WriteError!void {
        if (self.len > self.buf.len or n > self.buf.len - self.len) return error.NoSpace;
        self.len += n;
    }

    pub fn appendByte(self: *Writer, b: u8) WriteError!void {
        if (self.len >= self.buf.len) return error.NoSpace;
        self.buf[self.len] = b;
        self.len += 1;
    }

    /// The Data Length part, chosen to be the shortest form that fits
    /// (Annex B.1 for 0..127, Annex B.2 otherwise).
    pub fn length(self: *Writer, n: usize) WriteError!void {
        if (n <= 127) {
            try self.appendByte(@intCast(n));
            return;
        }
        if (n <= 0xFF) {
            try self.appendByte(0x80); // N = 0 -> one length byte follows
            try self.appendByte(@intCast(n));
            return;
        }
        if (n <= 0xFFFF) {
            try self.appendByte(0x81); // N = 1 -> two length bytes follow
            var tmp: [2]u8 = undefined;
            writeUintLe(&tmp, n);
            try self.append(&tmp);
            return;
        }
        try self.appendByte(0x82); // N = 2 -> four length bytes follow
        var tmp: [4]u8 = undefined;
        writeUintLe(&tmp, n);
        try self.append(&tmp);
    }

    /// Write one Field (10.4). Fixed-width FIDs must get exactly their width.
    pub fn field(self: *Writer, f: Fid, data: []const u8) WriteError!void {
        const fb = f.bytes();
        try self.append(fb[0..@as(usize, f.len)]);
        if (fixedLen(f)) |w| {
            if (data.len != w) return error.InvalidValue;
        } else {
            try self.length(data.len);
        }
        try self.append(data);
    }

    /// Write one Bit Data Field (Annex B.3): the value lives in the length byte.
    pub fn bitsField(self: *Writer, f: Fid, value: u8) WriteError!void {
        const fb = f.bytes();
        try self.append(fb[0..@as(usize, f.len)]);
        if (fixedLen(f) != null) return error.InvalidValue;
        try self.appendByte(0xC0 | (value & 0x3F));
    }

    /// The first Field of a Field Table: the table's own FID with the
    /// Resynchronization Pattern as data (10.5, 6.23).
    pub fn tableHeader(self: *Writer, f: Fid) WriteError!void {
        try self.field(f, &RESYNC_BYTES);
    }

    /// The last Field of a Field Table: the same FID with empty data, i.e.
    /// "CRC value or empty" without a CRC (10.5).
    pub fn tableEnd(self: *Writer, f: Fid) WriteError!void {
        try self.field(f, &.{});
    }
};

/// ITU Rec. X.25 CRC-32 as required by clause 9: polynomial
/// x32+x26+x23+x22+x16+x12+x11+x10+x8+x7+x5+x4+x2+x+1, seed -1, 32-bit output,
/// reflected like the X.25/ISO-HDLC form (6.1: least significant bit first in
/// the CRC data input and output).
pub fn crc32(data: []const u8) u32 {
    var crc: u32 = 0xFFFF_FFFF;
    for (data) |byte| {
        crc ^= byte;
        var i: u4 = 0;
        while (i < 8) : (i += 1) {
            const mask: u32 = @as(u32, 0) -% (crc & 1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    return crc ^ 0xFFFF_FFFF;
}

/// Scan for the resynchronization pattern #A55A (6.23), returning the offset
/// of the next occurrence at or after `from`.
pub fn findResync(data: []const u8, from: usize) ?usize {
    if (from >= data.len) return null;
    var i = from;
    while (i + 1 < data.len) : (i += 1) {
        if (data[i] == RESYNC_BYTES[0] and data[i + 1] == RESYNC_BYTES[1]) return i;
    }
    return null;
}

// ---------------------------------------------------------------------------
// FID constants
// ---------------------------------------------------------------------------
// The block below is generated by tools/extract_spec.py from the pinned
// standard's Annex D (and, for four fields Annex D omits, from the normative
// text named in each line's comment). Do not edit by hand.

// --- BEGIN GENERATED: FID constants (tools/extract_spec.py) ---
//
// Transcribed from the pinned standard. Each entry's comment names the
// annex it came from. The numeric value is the FID's byte sequence read
// as a big-endian integer (#808000 = bytes 80 80 00; #01 = byte 01),
// which is exactly the notation Annex A uses for FID structure.

pub const OFFSET_TO_END = Fid{ .code = 0x01, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_NAME = Fid{ .code = 0x02, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_OPERATING_SYSTEM = Fid{ .code = 0x03, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_OPERATING_SYSTEM_VERSION = Fid{ .code = 0x04, .len = 1 };  // Annex D; Annex C data length: Variable
pub const BUFFER_HEADER = Fid{ .code = 0x05, .len = 1 };  // Annex D; Annex C data length: Variable
pub const BUFFER_SIZE = Fid{ .code = 0x06, .len = 1 };  // Annex D; Annex C data length: Variable
pub const BUFFER_SEQUENCE = Fid{ .code = 0x07, .len = 1 };  // Annex D; Annex C data length: Variable
pub const BUFFER_ADDRESS = Fid{ .code = 0x08, .len = 1 };  // Annex D; Annex C data length: Variable
pub const FILE_HEADER = Fid{ .code = 0x09, .len = 1 };  // Annex D; Annex C data length: Variable
pub const FILE_CHUNK_SIZE = Fid{ .code = 0x0B, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_DIRECTORY_HEADER = Fid{ .code = 0x0C, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_DIRECTORY_TRAILER = Fid{ .code = 0x0D, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_FILE_HEADER = Fid{ .code = 0x0E, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_FILE_TRAILER = Fid{ .code = 0x0F, .len = 1 };  // Annex D; Annex C data length: Variable
pub const PATH = Fid{ .code = 0x10, .len = 1 };  // Annex D; Annex C data length: Variable
pub const NAME_SPACE = Fid{ .code = 0x11, .len = 1 };  // Annex D; Annex C data length: Variable
pub const PATH_NAME = Fid{ .code = 0x12, .len = 1 };  // Annex D; Annex C data length: Variable
pub const CHARACTERISTICS = Fid{ .code = 0x13, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SOURCE_DIRECTORY = Fid{ .code = 0x14, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const HIDDEN = Fid{ .code = 0x15, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const NEEDS_ARCHIVE = Fid{ .code = 0x16, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const READ_ONLY = Fid{ .code = 0x17, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const SHAREABLE = Fid{ .code = 0x18, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const SYSTEM = Fid{ .code = 0x19, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const EA_KEY = Fid{ .code = 0x1B, .len = 1 };  // Annex D
pub const STREAM_HEADER = Fid{ .code = 0x1D, .len = 1 };  // Annex D; Annex C data length: Variable
pub const STREAM_TRAILER = Fid{ .code = 0x1E, .len = 1 };  // Annex D; Annex C data length: Variable
pub const STREAM_NAME = Fid{ .code = 0x1F, .len = 1 };  // Annex D
pub const STREAM_SIZE = Fid{ .code = 0x20, .len = 1 };  // Annex D; Annex C data length: Variable
pub const STREAM_IS_INVALID = Fid{ .code = 0x21, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const STREAM_CRC = Fid{ .code = 0x22, .len = 1 };  // Annex D; Annex C data length: Variable
pub const BLOCK_SIZE = Fid{ .code = 0x24, .len = 1 };  // Annex D; Annex C data length: Variable
pub const BLOCK_MAP = Fid{ .code = 0x25, .len = 1 };  // Annex D; Annex C data length: Variable
pub const NAME_POSITIONS = Fid{ .code = 0x27, .len = 1 };  // Annex D; Annex C data length: Variable
pub const SEPARATOR_POSITIONS = Fid{ .code = 0x28, .len = 1 };  // Annex D; Annex C data length: Variable
pub const EXCLUSION_OPTIONS = Fid{ .code = 0x29, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const STREAM_TYPE = Fid{ .code = 0x2B, .len = 1 };  // Annex D; Annex C data length: Variable
pub const STREAM_FORMAT = Fid{ .code = 0x2C, .len = 1 };  // Annex D; Annex C data length: Variable
pub const NEEDS_ARCHIVE_CHARACTERISTICS = Fid{ .code = 0x2D, .len = 1 };  // Annex D; Annex C data length: Bit Data
pub const ACCESS_TIME = Fid{ .code = 0x44, .len = 1 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const PATH_FULLY_QUALIFIED = Fid{ .code = 0x50, .len = 1 };  // Annex D; Annex C data length: Fixed, 1 byte
pub const ARCHIVE_TIME = Fid{ .code = 0x54, .len = 1 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const BUFFER_TYPE = Fid{ .code = 0x60, .len = 1 };  // Annex D; Annex C data length: Fixed, 1 byte
pub const STREAM_TYPE_SEQUENCE = Fid{ .code = 0x61, .len = 1 };  // Annex D; Annex C data length: Fixed, 2 bytes
pub const CREATION_TIME = Fid{ .code = 0x64, .len = 1 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const FILE_TYPE = Fid{ .code = 0x70, .len = 1 };  // Annex D; Annex C data length: Fixed, 1 byte
pub const MODIFIED_TIME = Fid{ .code = 0x74, .len = 1 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const UNUSED_IN_THIS_BUFFER = Fid{ .code = 0x8000, .len = 2 };  // Annex D; Annex C data length: Variable
pub const FILE_CONTINUATION_HEADER = Fid{ .code = 0x8001, .len = 2 };  // Annex D; Annex C data length: Variable
pub const AUTHENTICATION = Fid{ .code = 0x8002, .len = 2 };  // Annex D; Annex C data length: Variable
pub const STREAM_COMPRESS_TYPE = Fid{ .code = 0x8005, .len = 2 };  // Annex D; Annex C data length: Variable
pub const STREAM_EXPANDED_SIZE = Fid{ .code = 0x8006, .len = 2 };  // Annex D; Annex C data length: Variable
pub const BUFFER_CRC = Fid{ .code = 0x8008, .len = 2 };  // Annex D; Annex C data length: Variable
pub const SOURCE_NAME_TYPE = Fid{ .code = 0x8009, .len = 2 };  // Annex D; Annex C data length: Variable
pub const DELTA_EXTENT_OFFSET = Fid{ .code = 0x800A, .len = 2 };  // Annex D; Annex C data length: Variable
pub const DELTA_EXTENT_OLD_SIZE = Fid{ .code = 0x800B, .len = 2 };  // Annex D; Annex C data length: Variable
pub const DELTA_BASE_TIME = Fid{ .code = 0x8044, .len = 2 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const FORMAT_VERSION = Fid{ .code = 0x8062, .len = 2 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const FILE_SET_ID = Fid{ .code = 0x8072, .len = 2 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const DO_NOT_COMPRESS_FILE = Fid{ .code = 0x8115, .len = 2 };  // Annex D; Annex C data length: Bit Data
pub const COMPRESS_FILE_IMMEDIATE = Fid{ .code = 0x8116, .len = 2 };  // Annex D; Annex C data length: Bit Data
pub const TRANSACTIONAL = Fid{ .code = 0x8135, .len = 2 };  // Annex D; Annex C data length: Bit Data
pub const PURGE = Fid{ .code = 0x8136, .len = 2 };  // Annex D; Annex C data length: Bit Data
pub const INHIBITIONS = Fid{ .code = 0x813A, .len = 2 };  // Annex D; Annex C data length: Bit Data
pub const EXECUTE_ONLY = Fid{ .code = 0x813B, .len = 2 };  // Annex D; Annex C data length: Bit Data
pub const FILE_INFORMATION = Fid{ .code = 0x813F, .len = 2 };  // Annex D; Annex C data length: Variable
pub const VOLUME_HEADER = Fid{ .code = 0x808000, .len = 3 };  // Annex D; Annex C data length: Variable
pub const VOLUME_TRAILER = Fid{ .code = 0x808003, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_HEADER = Fid{ .code = 0x808004, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_LABEL = Fid{ .code = 0x808005, .len = 3 };  // Annex D; Annex C data length: Variable
pub const ORIGINATING_SYSTEM_SOFTWARE_NAME = Fid{ .code = 0x808006, .len = 3 };  // Annex D; Annex C data length: Variable
pub const ORIGINATING_SYSTEM_SOFTWARE_TYPE = Fid{ .code = 0x808007, .len = 3 };  // Annex D; Annex C data length: Variable
pub const ORIGINATING_SYSTEM_SOFTWARE_VERSION = Fid{ .code = 0x808008, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_TRAILER = Fid{ .code = 0x808009, .len = 3 };  // Annex D; Annex C data length: Variable
pub const SECTOR_SIZE = Fid{ .code = 0x80800E, .len = 3 };  // Annex D; Annex C data length: Variable
pub const DATABASE_LOCATION_METHOD = Fid{ .code = 0x80800F, .len = 3 };  // Annex D
pub const FILE_SET_INDEX = Fid{ .code = 0x808010, .len = 3 };  // Annex D; Annex C data length: Variable
pub const VOLUME_INDEX = Fid{ .code = 0x808011, .len = 3 };  // Annex D; Annex C data length: Variable
pub const PARTITION_NUMBER = Fid{ .code = 0x808012, .len = 3 };  // Annex D; Annex C data length: Variable
pub const BUFFER_OFFSET = Fid{ .code = 0x808014, .len = 3 };  // Annex D; Annex C data length: Variable
pub const NUMBER_OF_FILE_SETS = Fid{ .code = 0x808015, .len = 3 };  // Annex D; Annex C data length: Variable
pub const NUMBER_OF_DATABASES = Fid{ .code = 0x808016, .len = 3 };  // Annex D
pub const PREVIOUS_MEDIA_INDEX = Fid{ .code = 0x808017, .len = 3 };  // Annex D
pub const DATABASE_NAME = Fid{ .code = 0x808018, .len = 3 };  // Annex D
pub const BLANK_SPACE = Fid{ .code = 0x808019, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_MARK_USAGE = Fid{ .code = 0x808020, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const NUMBER_OF_FILES = Fid{ .code = 0x808021, .len = 3 };  // Annex D; Annex C data length: Variable
pub const TOTAL_FILE_SET_SIZE = Fid{ .code = 0x808022, .len = 3 };  // Annex D; Annex C data length: Variable
pub const RESOURCE_NAME = Fid{ .code = 0x808023, .len = 3 };  // Annex D; Annex C data length: Variable
pub const COMPRESSION_TYPE_RESERVED_FOR_FUTURE_USE = Fid{ .code = 0x808024, .len = 3 };  // Annex D
pub const ENCRYPTION_TYPE_RESERVED_FOR_FUTURE_USE = Fid{ .code = 0x808025, .len = 3 };  // Annex D
pub const VOLUME_LABEL = Fid{ .code = 0x808027, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_MARK_INTERVAL = Fid{ .code = 0x808028, .len = 3 };  // Annex D; Annex C data length: Variable
pub const NEXT_OBJECT_LOCATION = Fid{ .code = 0x808029, .len = 3 };  // Annex D; Annex C data length: Variable
pub const PREV_OBJECT_LOCATION = Fid{ .code = 0x80802A, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_COMMENT = Fid{ .code = 0x80802B, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_INDEX_PRESENT = Fid{ .code = 0x80802D, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const VOLUME_INDEX_REQUIRED = Fid{ .code = 0x80802F, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const VOLUME_SET_LABEL = Fid{ .code = 0x808030, .len = 3 };  // Annex D; Annex C data length: Variable
pub const VOLUME_SUBINDEX = Fid{ .code = 0x808031, .len = 3 };  // Annex D; Annex C data length: Variable
pub const DEVICE_INFO = Fid{ .code = 0x808032, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_SUBINDEX = Fid{ .code = 0x808033, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_INDEX_FIELDS = Fid{ .code = 0x808034, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_CONTINUATION_HEADER = Fid{ .code = 0x808035, .len = 3 };  // Annex D; Annex C data length: Variable
pub const SOURCE_ALIAS = Fid{ .code = 0x808036, .len = 3 };  // Annex D; Annex C data length: Variable
pub const RESOURCE_TYPE = Fid{ .code = 0x808037, .len = 3 };  // Annex D; Annex C data length: Variable
pub const RESOURCE_NAME_SPACE = Fid{ .code = 0x808038, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_ABORTED = Fid{ .code = 0x808039, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const FSH_VOLUME_SET_SEQUENCE = Fid{ .code = 0x80803A, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FSH_PARTITION_NUMBER = Fid{ .code = 0x80803B, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_HEADER_LOCATION = Fid{ .code = 0x80803C, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FST_VOLUME_SET_SEQUENCE = Fid{ .code = 0x80803D, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FST_PARTITION_NUMBER = Fid{ .code = 0x80803E, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_SET_TRAILER_LOCATION = Fid{ .code = 0x80803F, .len = 3 };  // Annex D; Annex C data length: Variable
pub const CHAR_SPEC = Fid{ .code = 0x808040, .len = 3 };  // Annex D; Annex C data length: Variable
pub const VOLUME_SET_ALIAS = Fid{ .code = 0x808041, .len = 3 };  // Annex D; Annex C data length: Variable
pub const VOLUME_INDEX_LOCATION = Fid{ .code = 0x808042, .len = 3 };  // Annex D; Annex C data length: Variable
pub const FILE_IS_INVALID = Fid{ .code = 0x80F003, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const VOLUME_SET_SEQUENCE = Fid{ .code = 0x80F100, .len = 3 };  // Annex D; Annex C data length: Fixed, 2 bytes
pub const MEDIA_USAGE_COUNT = Fid{ .code = 0x80F104, .len = 3 };  // Annex D
pub const VOLUME_SIZE = Fid{ .code = 0x80F201, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const POSIX_FILE_MODE = Fid{ .code = 0x80F203, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const POSIX_GROUP_OWNER_ID = Fid{ .code = 0x80F204, .len = 3 };  // Annex D
pub const POSIX_OWNER_ID = Fid{ .code = 0x80F209, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const POSIX_NUMBER_OF_LINKS = Fid{ .code = 0x80F20D, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const POSIX_RDEVICE = Fid{ .code = 0x80F20E, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const POSIX_FSID = Fid{ .code = 0x80F20F, .len = 3 };  // Annex D
pub const POSIX_FILEID = Fid{ .code = 0x80F210, .len = 3 };  // Annex D
pub const VOLUME_SET_TIME = Fid{ .code = 0x80F400, .len = 3 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const VOLUME_TIME = Fid{ .code = 0x80F401, .len = 3 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const CLOSE_TIME = Fid{ .code = 0x80F402, .len = 3 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const FILE_SET_TIME = Fid{ .code = 0x80F403, .len = 3 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const EXPIRATION_TIME = Fid{ .code = 0x80F404, .len = 3 };  // Annex D; Annex C data length: Fixed, 16 bytes
pub const CANT_COMPRESS_DATA = Fid{ .code = 0x81EFE6, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const REMOTE_DATA_ACCESS = Fid{ .code = 0x81EFE7, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const REMOTE_DATA_INHIBIT = Fid{ .code = 0x81EFE8, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const TRANSACTION_SET_TYPE = Fid{ .code = 0x81EFEE, .len = 3 };  // Annex D; Annex C data length: Variable
pub const TRANSACTION_SET_NAME = Fid{ .code = 0x81EFEF, .len = 3 };  // Annex D
pub const TRANSACTION_SET_TRAILER = Fid{ .code = 0x81EFF2, .len = 3 };  // Annex D; Annex C data length: Variable
pub const TRANSACTION_SET_HEADER = Fid{ .code = 0x81EFF3, .len = 3 };  // Annex D; Annex C data length: Variable
pub const INDEXED = Fid{ .code = 0x81EFF8, .len = 3 };  // Annex D; Annex C data length: Bit Data
pub const SOURCE_VOLUME_TRAILER = Fid{ .code = 0x81EFFB, .len = 3 };  // Annex D; Annex C data length: Variable
pub const SOURCE_VOLUME_HEADER = Fid{ .code = 0x81EFFC, .len = 3 };  // Annex D; Annex C data length: Variable
pub const HEADER_DEBUG_STRING = Fid{ .code = 0x81EFFF, .len = 3 };  // Annex D; Annex C data length: Variable
pub const PARENT = Fid{ .code = 0x81F0FD, .len = 3 };  // Annex D; Annex C data length: Fixed, 1 byte
pub const DELETED_FLAG = Fid{ .code = 0x81F0FE, .len = 3 };  // Annex D; Annex C data length: Fixed, 1 byte
pub const MODIFIED_FLAG = Fid{ .code = 0x81F0FF, .len = 3 };  // Annex D
pub const TOTAL_STREAM_SIZE = Fid{ .code = 0x81F2FA, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const CREATOR_NAME_SPACE = Fid{ .code = 0x81F2FC, .len = 3 };  // Annex D; Annex C data length: Fixed, 4 bytes
pub const ATTRIBUTES = Fid{ .code = 0x81F2FE, .len = 3 };  // Annex D; Annex C data length: Variable
pub const NULL_FIELD = Fid{ .code = 0x00, .len = 1 };  // 10.4.1 (NULL Field is the single byte #00)
pub const FORMAT_NAME = Fid{ .code = 0x8052, .len = 2 };  // Annex C (FORMAT NAME); Annex D lists #8052 as 'see annex E'; Annex C data length: Fixed, 4 bytes
pub const REGISTERED_IDENTIFIER = Fid{ .code = 0x808043, .len = 3 };  // Annex C (REGISTERED IDENTIFIER); absent from Annex D; Annex C data length: Variable
pub const DATA_STREAM_SIZE = Fid{ .code = 0x81F2FB, .len = 3 };  // Figure 27 (13.14); absent from Annex D

// --- END GENERATED ---

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

test "FID byte encoding is Annex A's written order" {
    const one = fid(0x01).bytes();
    try testing.expectEqualSlices(u8, &.{0x01}, one[0..1]);
    const vh = fid(0x808000).bytes();
    try testing.expectEqualSlices(u8, &.{0x80, 0x80, 0x00}, vh[0..3]);
    const attrs = fid(0x81F2FE).bytes();
    try testing.expectEqualSlices(u8, &.{0x81, 0xF2, 0xFE}, attrs[0..3]);
    try testing.expectEqualSlices(u8, &.{0xA5, 0x5A}, &RESYNC_BYTES);
}

test "FID decoding follows the Annex A high-bit structure" {
    // 1-byte: b7 = 0.
    try expectFid(try readFid(&.{0x12}), 0x12, 1);
    // 2-byte: first byte 10xxxxxx, second byte b7 = 0.
    try expectFid(try readFid(&.{ 0x80, 0x05 }), 0x8005, 2);
    // 3-byte Case A: first byte 10xxxxxx, second byte b7 = 1.
    try expectFid(try readFid(&.{ 0x80, 0x80, 0x00 }), 0x808000, 3);
    // 3-byte Case B: first byte 11xxxxxx, third byte b7 = 0.
    try expectFid(try readFid(&.{ 0xC0, 0x01, 0x42 }), 0xC00142, 3);
    // 4-byte: first byte 11xxxxxx, third byte b7 = 1.
    try expectFid(try readFid(&.{ 0xC0, 0x01, 0x80, 0x42 }), 0xC0018042, 4);
    // Truncation is an error, not a panic.
    try testing.expectError(error.Truncated, readFid(&.{}));
    try testing.expectError(error.Truncated, readFid(&.{0x80}));
}

fn expectFid(got: Fid, code: u32, len: u3) !void {
    try testing.expectEqual(code, got.code);
    try testing.expectEqual(len, got.len);
}

test "fixed lengths are implied by the FID bits (Annex A)" {
    // #60 BUFFER TYPE: 1 byte, b6=1, nnn=000 -> 1.
    try testing.expectEqual(@as(?u32, 1), fixedLen(BUFFER_TYPE));
    // #70 FILE TYPE: b6=1, nnn=000 -> 1.
    try testing.expectEqual(@as(?u32, 1), fixedLen(FILE_TYPE));
    // #61 STREAM TYPE SEQUENCE: b6=1, nnn=001 -> 2.
    try testing.expectEqual(@as(?u32, 2), fixedLen(STREAM_TYPE_SEQUENCE));
    // #8072 FILE SET ID: 2-byte FID, second byte 0x72 -> b6=1, nnn=010 -> 4.
    try testing.expectEqual(@as(?u32, 4), fixedLen(FILE_SET_ID));
    // #12 PATH NAME: b6=0 -> variable (Data Length part present).
    try testing.expectEqual(@as(?u32, null), fixedLen(PATH_NAME));
    // #01 OFFSET TO END: variable.
    try testing.expectEqual(@as(?u32, null), fixedLen(OFFSET_TO_END));
}

test "Annex B length formats round-trip" {
    var buf: [1024]u8 = undefined;

    // B.3 Bit Data: the value lives in the Data Length part, no Data part.
    var w = Writer{ .buf = &buf };
    try w.bitsField(FILE_MARK_USAGE, 0b0000_0110);
    var c = Cursor{ .buf = buf[0..w.len] };
    const f = (try nextField(&c)).?;
    try testing.expectEqual(@as(?u8, 0b0000_0110), f.bits);
    try testing.expectEqual(@as(usize, 0), f.data.len);

    // B.1 Direct length.
    w = Writer{ .buf = &buf };
    try w.field(PATH_NAME, "hello.txt");
    c = Cursor{ .buf = buf[0..w.len] };
    try testing.expectEqualStrings("hello.txt", (try nextField(&c)).?.data);

    // B.2 Indirect length: 300 bytes forces the two-byte form (b1b0 = 01).
    var big: [300]u8 = undefined;
    @memset(&big, 0x7A);
    w = Writer{ .buf = &buf };
    try w.field(PATH_NAME, &big);
    try testing.expectEqual(@as(u8, 0x81), buf[1]); // FID byte, then 0x81
    c = Cursor{ .buf = buf[0..w.len] };
    try testing.expectEqual(@as(usize, 300), (try nextField(&c)).?.data.len);

    // Truncated data is an error, not a misread length or a panic.
    var short = Cursor{ .buf = buf[0 .. w.len - 100] };
    try testing.expectError(error.Truncated, nextField(&short));

    // Annex B.3's worked example, decoded from its bytes alone: the first
    // length byte 0x81 says two length bytes follow, and #600A read
    // little-endian (6.1) is 24586.
    const len_bytes = [_]u8{ 0x0A, 0x60 };
    try testing.expectEqual(@as(u64, 24586), readUintLe(&len_bytes));
    const b3_example = [_]u8{ 0x12, 0x81, 0x0A, 0x60 };
    var bc = Cursor{ .buf = &b3_example };
    try testing.expectError(error.Truncated, nextField(&bc)); // 24586 bytes absent
}

test "CRC-32 matches the ITU X.25 check value" {
    // The standard check value for the reflected X.25/IEEE CRC-32.
    try testing.expectEqual(@as(u32, 0xCBF43926), crc32("123456789"));
    try testing.expectEqual(@as(u32, 0x00000000), crc32(""));
}

test "resync scanner finds the pattern" {
    //                    0     1     2     3     4     5     6     7
    const data = [_]u8{ 0x00, 0x11, 0xA5, 0x5A, 0x22, 0xA5, 0xA5, 0x5A };
    try testing.expectEqual(@as(?usize, 2), findResync(&data, 0)); // first A5 5A
    try testing.expectEqual(@as(?usize, 6), findResync(&data, 3)); // overlapping bytes are not a match
    try testing.expectEqual(@as(?usize, null), findResync(&data, 7)); // too late to fit
}
