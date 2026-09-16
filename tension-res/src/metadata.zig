//! ECMA-208 (SIDF) structural parsers: Field Tables above the field layer.
//!
//! Each parser takes a byte slice that begins at a Field Table's first Field
//! and returns a struct plus the table's consumed length. All Field Tables
//! open with their own FID carrying the Resynchronization Pattern and close
//! with the same FID carrying "CRC value or empty" (10.5); `Table` owns that
//! framing so the parsers only see the fields in between.
//!
//! Mandatory-field lists come from the clause that defines each table, and
//! every check carries its citation. Nothing here allocates, nothing panics:
//! malformed input is `error.Invalid` (structural) or `error.Truncated`
//! (input ends inside a structure), per `errors.zig`.

const std = @import("std");
const errors = @import("errors.zig");
const fields = @import("fields.zig");

pub const ParseError = errors.ParseError;

/// A 12-byte Timestamp (clause 7, Figure 5): RBP 0 is a 16-bit type/time-zone
/// value, RBP 2 a 16-bit year, RBP 4..11 are single bytes (month, day, hour,
/// minute, second, centisecond, hundreds of microseconds, microseconds).
/// Fields may carry a longer timestamp — the timestamp comes first and any
/// remaining bytes are NULL (clause 7) — so `decode` accepts >= 12 bytes and
/// ignores the tail. "If the Year field has the value 0 the Timestamp shall
/// be ignored" (clause 7), exposed as `isIgnored`.
pub const Timestamp = struct {
    type_and_tz: u16,
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    centisecond: u8,
    hundreds_of_us: u8,
    microseconds: u8,

    pub const encoded_len: usize = 12;

    pub fn decode(data: []const u8) ParseError!Timestamp {
        if (data.len < encoded_len) return error.Truncated;
        return .{
            .type_and_tz = @intCast(fields.readUintLe(data[0..2])),
            .year = @intCast(fields.readUintLe(data[2..4])),
            .month = data[4],
            .day = data[5],
            .hour = data[6],
            .minute = data[7],
            .second = data[8],
            .centisecond = data[9],
            .hundreds_of_us = data[10],
            .microseconds = data[11],
        };
    }

    pub fn encode(self: Timestamp) [encoded_len]u8 {
        var out: [encoded_len]u8 = undefined;
        fields.writeUintLe(out[0..2], self.type_and_tz);
        fields.writeUintLe(out[2..4], self.year);
        out[4] = self.month;
        out[5] = self.day;
        out[6] = self.hour;
        out[7] = self.minute;
        out[8] = self.second;
        out[9] = self.centisecond;
        out[10] = self.hundreds_of_us;
        out[11] = self.microseconds;
        return out;
    }

    pub fn isIgnored(self: Timestamp) bool {
        return self.year == 0;
    }
};

/// The little-endian integer reader is used for every numeric field (6.1).
const readUintLe = fields.readUintLe;

fn require(cond: bool) ParseError!void {
    if (!cond) return error.Invalid;
}

/// A Field Table reader: validates the opening Field (10.5) and stops at the
/// closing Field that repeats the table's FID.
pub const Table = struct {
    cursor: fields.Cursor,
    header_fid: fields.Fid,
    finished: bool = false,

    pub fn init(data: []const u8, header_fid: fields.Fid) ParseError!Table {
        var c = fields.Cursor{ .buf = data };
        const first = (try fields.nextField(&c)) orelse return error.Truncated;
        if (!first.fid.eql(header_fid)) return error.Invalid;
        // The first Field's Data part is the Resynchronization Pattern (10.5).
        if (first.data.len != 2 or !std.mem.eql(u8, first.data, &fields.RESYNC_BYTES)) {
            return error.Invalid;
        }
        return .{ .cursor = c, .header_fid = header_fid };
    }

    /// The next non-closing Field, or null once the table ends. The closing
    /// Field must be the last one (10.5: the table's FID "shall not appear
    /// elsewhere in the Field Table").
    pub fn next(self: *Table) ParseError!?fields.Field {
        if (self.finished) return null;
        const f = (try fields.nextField(&self.cursor)) orelse return error.Truncated;
        if (f.fid.eql(self.header_fid)) {
            // Closing Field: "CRC value or empty" (10.5). It terminates the
            // table; any following bytes belong to the enclosing structure
            // (Blank Space padding, the next table, ...), so they are not
            // this reader's business. `consumed` tells the caller where the
            // table ended.
            self.finished = true;
            return null;
        }
        return f;
    }
};

// ---------------------------------------------------------------------------
// Volume Header Field Table (13.1, Figure 17)
// ---------------------------------------------------------------------------

/// Mandatory (13.1): FORMAT VERSION, SECTOR SIZE, VOLUME SET TIME,
/// VOLUME TIME, VOLUME SET LABEL, VOLUME SET SEQUENCE, VOLUME INDEX
/// REQUIRED, FILE MARK USAGE (plus the framing FIDs VOLUME HEADER and
/// OFFSET TO END, handled by `Table`).
pub const VolumeHeader = struct {
    format_name: ?[4]u8 = null,
    format_version: ?u32 = null,
    sector_size: ?u32 = null,
    volume_set_time: ?Timestamp = null,
    volume_time: ?Timestamp = null,
    volume_set_label: ?[]const u8 = null,
    volume_set_sequence: ?u16 = null,
    volume_index_required: ?u8 = null,
    file_mark_usage: ?u8 = null,
    file_mark_interval: ?u64 = null,
    consumed: usize = 0,
};

pub fn parseVolumeHeader(data: []const u8) ParseError!VolumeHeader {
    var t = try Table.init(data, fields.VOLUME_HEADER);
    var out = VolumeHeader{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.FORMAT_NAME)) {
            var name: [4]u8 = undefined;
            if (f.data.len != 4) return error.Invalid;
            @memcpy(&name, f.data);
            out.format_name = name;
        } else if (f.fid.eql(fields.FORMAT_VERSION)) {
            out.format_version = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.SECTOR_SIZE)) {
            out.sector_size = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.VOLUME_SET_TIME)) {
            out.volume_set_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.VOLUME_TIME)) {
            out.volume_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.VOLUME_SET_LABEL)) {
            out.volume_set_label = f.data;
        } else if (f.fid.eql(fields.VOLUME_SET_SEQUENCE)) {
            out.volume_set_sequence = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.VOLUME_INDEX_REQUIRED)) {
            out.volume_index_required = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.FILE_MARK_USAGE)) {
            out.file_mark_usage = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.FILE_MARK_INTERVAL)) {
            out.file_mark_interval = readUintLe(f.data);
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.format_version != null);
    try require(out.sector_size != null);
    try require(out.volume_set_time != null);
    try require(out.volume_time != null);
    try require(out.volume_set_label != null);
    try require(out.volume_set_sequence != null);
    try require(out.volume_index_required != null);
    try require(out.file_mark_usage != null);
    return out;
}

// ---------------------------------------------------------------------------
// File Set Header Field Table (13.7, Figure 22)
// ---------------------------------------------------------------------------

/// Mandatory (13.7): FILE SET ID, FILE SET TIME, FILE SET LABEL,
/// FILE SET INDEX PRESENT, BUFFER SIZE, SOURCE NAME TYPE, SOURCE NAME,
/// SOURCE OPERATING SYSTEM, SOURCE OPERATING SYSTEM VERSION (plus framing).
pub const FileSetHeader = struct {
    file_set_id: ?u32 = null,
    file_set_time: ?Timestamp = null,
    file_set_label: ?[]const u8 = null,
    file_set_index_present: ?u8 = null,
    buffer_size: ?u32 = null,
    source_name_type: ?u64 = null,
    source_name: ?[]const u8 = null,
    source_os: ?[]const u8 = null,
    source_os_version: ?[]const u8 = null,
    consumed: usize = 0,
};

pub fn parseFileSetHeader(data: []const u8) ParseError!FileSetHeader {
    var t = try Table.init(data, fields.FILE_SET_HEADER);
    var out = FileSetHeader{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.FILE_SET_ID)) {
            out.file_set_id = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.FILE_SET_TIME)) {
            out.file_set_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.FILE_SET_LABEL)) {
            out.file_set_label = f.data;
        } else if (f.fid.eql(fields.FILE_SET_INDEX_PRESENT)) {
            out.file_set_index_present = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.BUFFER_SIZE)) {
            out.buffer_size = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.SOURCE_NAME_TYPE)) {
            out.source_name_type = readUintLe(f.data);
        } else if (f.fid.eql(fields.SOURCE_NAME)) {
            out.source_name = f.data;
        } else if (f.fid.eql(fields.SOURCE_OPERATING_SYSTEM)) {
            out.source_os = f.data;
        } else if (f.fid.eql(fields.SOURCE_OPERATING_SYSTEM_VERSION)) {
            out.source_os_version = f.data;
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.file_set_id != null);
    try require(out.file_set_time != null);
    try require(out.file_set_label != null);
    try require(out.file_set_index_present != null);
    try require(out.buffer_size != null);
    try require(out.source_name_type != null);
    try require(out.source_name != null);
    try require(out.source_os != null);
    try require(out.source_os_version != null);
    return out;
}

// ---------------------------------------------------------------------------
// Buffer Header Field Table (13.4, Figure 20)
// ---------------------------------------------------------------------------

/// Mandatory (13.4): BUFFER TYPE, BUFFER SIZE, BUFFER SEQUENCE, UNUSED IN
/// THIS BUFFER (plus framing). Conditional: BUFFER ADDRESS when the type is
/// File; FILE SET ID and FILE SET TIME when the type is File or File Set
/// (Sub)Index.
pub const BufferHeader = struct {
    buffer_type: ?u8 = null,
    buffer_size: ?u32 = null,
    buffer_sequence: ?u32 = null,
    buffer_address: ?u32 = null,
    unused: ?u64 = null,
    file_set_id: ?u32 = null,
    file_set_time: ?Timestamp = null,
    consumed: usize = 0,
};

pub const BufferType = enum(u8) {
    implementation_use = 0,
    file = 1,
    file_set_index = 2,
    file_set_subindex = 3,
    volume_index = 4,
    volume_subindex = 5,
};

pub fn parseBufferHeader(data: []const u8) ParseError!BufferHeader {
    var t = try Table.init(data, fields.BUFFER_HEADER);
    var out = BufferHeader{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.BUFFER_TYPE)) {
            out.buffer_type = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.BUFFER_SIZE)) {
            out.buffer_size = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.BUFFER_SEQUENCE)) {
            out.buffer_sequence = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.BUFFER_ADDRESS)) {
            out.buffer_address = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.UNUSED_IN_THIS_BUFFER)) {
            out.unused = readUintLe(f.data);
        } else if (f.fid.eql(fields.FILE_SET_ID)) {
            out.file_set_id = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.FILE_SET_TIME)) {
            out.file_set_time = try Timestamp.decode(f.data);
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.buffer_type != null);
    try require(out.buffer_size != null);
    try require(out.buffer_sequence != null);
    try require(out.unused != null);
    // Annex C #60: "No other value shall be recorded."
    const kind = out.buffer_type.?;
    try require(kind <= 5);
    if (kind == @intFromEnum(BufferType.file)) {
        try require(out.buffer_address != null);
    }
    if (kind >= @intFromEnum(BufferType.file) and kind <= @intFromEnum(BufferType.file_set_subindex)) {
        try require(out.file_set_id != null);
        try require(out.file_set_time != null);
    }
    return out;
}

// ---------------------------------------------------------------------------
// File Header Field Table (13.12, Figure 25)
// ---------------------------------------------------------------------------

/// Mandatory per the normative text of 13.12: FILE HEADER, FILE CHUNK SIZE,
/// FILE TYPE. NOTE: Figure 25 marks FILE TYPE "No" (optional); the two
/// sources disagree and this parser follows the section text. Recorded as an
/// ambiguity item in the phase-2 report.
pub const FileHeader = struct {
    file_chunk_size: ?u64 = null,
    file_type: ?u8 = null,
    consumed: usize = 0,
};

pub const FileType = enum(u8) {
    reserved = 0,
    implementation_use = 1,
    logical_volume = 2,
    source_directory = 3,
    file = 4,
    transaction_set = 5,
};

pub fn parseFileHeader(data: []const u8) ParseError!FileHeader {
    var t = try Table.init(data, fields.FILE_HEADER);
    var out = FileHeader{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.FILE_CHUNK_SIZE)) {
            out.file_chunk_size = readUintLe(f.data);
        } else if (f.fid.eql(fields.FILE_TYPE)) {
            out.file_type = @intCast(readUintLe(f.data));
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.file_chunk_size != null);
    try require(out.file_type != null);
    // Annex C #70: "No other values shall be recorded."
    try require(out.file_type.? <= @intFromEnum(FileType.transaction_set));
    return out;
}

// ---------------------------------------------------------------------------
// File Information Field Table (13.14, Figure 27)
// ---------------------------------------------------------------------------

pub const NamespaceEntry = struct {
    name_space: u32,
    path_name: []const u8,
    name_positions: []const u8 = &.{},
    separator_positions: []const u8 = &.{},
};

/// Mandatory (13.14): PARENT, PATH FULLY QUALIFIED, and at least one
/// NAME SPACE + PATH NAME iteration (plus framing).
pub const FileInformation = struct {
    parent: ?u8 = null,
    path_fully_qualified: ?u8 = null,
    attributes: ?[]const u8 = null,
    data_stream_size: ?u64 = null,
    total_stream_size: ?u64 = null,
    creator_name_space: ?u32 = null,
    access_time: ?Timestamp = null,
    creation_time: ?Timestamp = null,
    modified_time: ?Timestamp = null,
    first_name_space: ?u32 = null,
    first_path_name: ?[]const u8 = null,
    consumed: usize = 0,
};

pub fn parseFileInformation(data: []const u8) ParseError!FileInformation {
    var t = try Table.init(data, fields.FILE_INFORMATION);
    var out = FileInformation{};
    var pending_ns: ?u32 = null;
    while (try t.next()) |f| {
        if (f.fid.eql(fields.PARENT)) {
            out.parent = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.PATH_FULLY_QUALIFIED)) {
            out.path_fully_qualified = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.ATTRIBUTES)) {
            out.attributes = f.data;
        } else if (f.fid.eql(fields.DATA_STREAM_SIZE)) {
            out.data_stream_size = readUintLe(f.data);
        } else if (f.fid.eql(fields.TOTAL_STREAM_SIZE)) {
            out.total_stream_size = readUintLe(f.data);
        } else if (f.fid.eql(fields.CREATOR_NAME_SPACE)) {
            out.creator_name_space = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.ACCESS_TIME)) {
            out.access_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.CREATION_TIME)) {
            out.creation_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.MODIFIED_TIME)) {
            out.modified_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.NAME_SPACE)) {
            pending_ns = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.PATH_NAME)) {
            const ns = pending_ns orelse return error.Invalid; // PATH NAME must follow NAME SPACE (13.14)
            if (out.first_path_name == null) {
                out.first_name_space = ns;
                out.first_path_name = f.data;
            }
            pending_ns = null;
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.parent != null);
    try require(out.path_fully_qualified != null);
    try require(out.first_path_name != null);
    return out;
}

/// Iterates every NAME SPACE + PATH NAME iteration of a File Information
/// Field Table (13.14's four-level Iterated Field Set), in recorded order.
pub const NamespaceIter = struct {
    table: Table,
    pending_ns: ?u32 = null,
    pending_positions: []const u8 = &.{},
    pending_separators: []const u8 = &.{},

    pub fn init(data: []const u8) ParseError!NamespaceIter {
        return .{ .table = try Table.init(data, fields.FILE_INFORMATION) };
    }

    pub fn next(self: *NamespaceIter) ParseError!?NamespaceEntry {
        while (try self.table.next()) |f| {
            if (f.fid.eql(fields.NAME_SPACE)) {
                self.pending_ns = @intCast(readUintLe(f.data));
            } else if (f.fid.eql(fields.NAME_POSITIONS)) {
                self.pending_positions = f.data;
            } else if (f.fid.eql(fields.SEPARATOR_POSITIONS)) {
                self.pending_separators = f.data;
            } else if (f.fid.eql(fields.PATH_NAME)) {
                const ns = self.pending_ns orelse return error.Invalid;
                const e = NamespaceEntry{
                    .name_space = ns,
                    .path_name = f.data,
                    .name_positions = self.pending_positions,
                    .separator_positions = self.pending_separators,
                };
                self.pending_ns = null;
                self.pending_positions = &.{};
                self.pending_separators = &.{};
                return e;
            }
        }
        return null;
    }
};

// ---------------------------------------------------------------------------
// Path Field Table (13.15.1, Figure 28)
// ---------------------------------------------------------------------------

/// Mandatory (13.15.1): PATH FULLY QUALIFIED and at least one
/// NAME SPACE + PATH NAME iteration (plus framing).
pub const PathTable = struct {
    path_fully_qualified: ?u8 = null,
    first_name_space: ?u32 = null,
    first_path_name: ?[]const u8 = null,
    consumed: usize = 0,
};

pub fn parsePathTable(data: []const u8) ParseError!PathTable {
    var t = try Table.init(data, fields.PATH);
    var out = PathTable{};
    var pending_ns: ?u32 = null;
    while (try t.next()) |f| {
        if (f.fid.eql(fields.PATH_FULLY_QUALIFIED)) {
            out.path_fully_qualified = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.NAME_SPACE)) {
            pending_ns = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.PATH_NAME)) {
            const ns = pending_ns orelse return error.Invalid;
            if (out.first_path_name == null) {
                out.first_name_space = ns;
                out.first_path_name = f.data;
            }
            pending_ns = null;
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.path_fully_qualified != null);
    try require(out.first_path_name != null);
    return out;
}

// ---------------------------------------------------------------------------
// Characteristics Field Table (13.15.2, Figure 29)
// ---------------------------------------------------------------------------

/// Only CHARACTERISTICS is mandatory (13.15.2); the rest are optional
/// attribute fields, each Bit Data.
pub const Characteristics = struct {
    source_directory: ?u8 = null,
    read_only: ?u8 = null,
    hidden: ?u8 = null,
    system: ?u8 = null,
    shareable: ?u8 = null,
    creation_time: ?Timestamp = null,
    modified_time: ?Timestamp = null,
    consumed: usize = 0,
};

pub fn parseCharacteristics(data: []const u8) ParseError!Characteristics {
    var t = try Table.init(data, fields.CHARACTERISTICS);
    var out = Characteristics{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.SOURCE_DIRECTORY)) {
            out.source_directory = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.READ_ONLY)) {
            out.read_only = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.HIDDEN)) {
            out.hidden = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.SYSTEM)) {
            out.system = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.SHAREABLE)) {
            out.shareable = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.CREATION_TIME)) {
            out.creation_time = try Timestamp.decode(f.data);
        } else if (f.fid.eql(fields.MODIFIED_TIME)) {
            out.modified_time = try Timestamp.decode(f.data);
        }
    }
    out.consumed = t.cursor.pos;
    return out;
}

// ---------------------------------------------------------------------------
// Stream Header / Trailer Field Tables (13.15.7.1, 13.15.7.2)
// ---------------------------------------------------------------------------

/// Annex C #2B: "No other values shall be recorded."
pub const StreamType = enum(u8) {
    data = 0,
    resource = 1,
    ftam = 2,
    extended_attributes = 10,
    alternate_data = 11,
    security_data = 12,
    link_data = 13,
};

/// Annex C #2C: "No other values shall be recorded."
pub const StreamFormat = enum(u8) {
    clear_data = 0,
    sparse = 1,
    compressed = 2,
    delta_block = 3,
    delta_extent = 4,
};

/// Mandatory (13.15.7.1): STREAM TYPE, STREAM FORMAT, STREAM SIZE (plus
/// framing). Conditional: STREAM COMPRESS TYPE and STREAM EXPANDED SIZE for
/// compressed streams; STREAM EXPANDED SIZE, BLOCK SIZE and BLOCK MAP for
/// sparse and delta block streams; the delta fields for delta streams.
pub const StreamHeader = struct {
    stream_type: ?u8 = null,
    stream_format: ?u8 = null,
    stream_size: ?u64 = null,
    stream_type_sequence: ?u16 = null,
    compress_type: ?[]const u8 = null,
    expanded_size: ?u64 = null,
    block_size: ?u64 = null,
    block_map: ?[]const u8 = null,
    consumed: usize = 0,
};

pub fn parseStreamHeader(data: []const u8) ParseError!StreamHeader {
    var t = try Table.init(data, fields.STREAM_HEADER);
    var out = StreamHeader{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.STREAM_TYPE)) {
            out.stream_type = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.STREAM_FORMAT)) {
            out.stream_format = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.STREAM_SIZE)) {
            out.stream_size = readUintLe(f.data);
        } else if (f.fid.eql(fields.STREAM_TYPE_SEQUENCE)) {
            out.stream_type_sequence = @intCast(readUintLe(f.data));
        } else if (f.fid.eql(fields.STREAM_COMPRESS_TYPE)) {
            out.compress_type = f.data;
        } else if (f.fid.eql(fields.STREAM_EXPANDED_SIZE)) {
            out.expanded_size = readUintLe(f.data);
        } else if (f.fid.eql(fields.BLOCK_SIZE)) {
            out.block_size = readUintLe(f.data);
        } else if (f.fid.eql(fields.BLOCK_MAP)) {
            out.block_map = f.data;
        }
    }
    out.consumed = t.cursor.pos;
    try require(out.stream_type != null);
    try require(out.stream_format != null);
    try require(out.stream_size != null);
    const st = out.stream_type.?;
    const sf = out.stream_format.?;
    // Annex C #2B lists 0..13 (3..9 "Reserved, no meaning") and says "No
    // other values shall be recorded"; #2C lists 0..4 likewise.
    try require(st <= 13);
    try require(sf <= 4);
    if (sf == @intFromEnum(StreamFormat.compressed)) {
        try require(out.compress_type != null);
        try require(out.expanded_size != null);
    }
    if (sf == @intFromEnum(StreamFormat.sparse) or sf == @intFromEnum(StreamFormat.delta_block)) {
        try require(out.expanded_size != null);
        try require(out.block_size != null);
        try require(out.block_map != null);
    }
    return out;
}

/// STREAM TRAILER is the only mandatory Field (13.15.7.2).
pub const StreamTrailer = struct {
    stream_invalid: ?u8 = null,
    stream_crc: ?[]const u8 = null,
    consumed: usize = 0,
};

pub fn parseStreamTrailer(data: []const u8) ParseError!StreamTrailer {
    var t = try Table.init(data, fields.STREAM_TRAILER);
    var out = StreamTrailer{};
    while (try t.next()) |f| {
        if (f.fid.eql(fields.STREAM_IS_INVALID)) {
            out.stream_invalid = f.bits orelse return error.Invalid;
        } else if (f.fid.eql(fields.STREAM_CRC)) {
            out.stream_crc = f.data;
        }
    }
    out.consumed = t.cursor.pos;
    return out;
}
