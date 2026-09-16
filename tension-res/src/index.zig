//! Child-index Stream: writer, parser, and probe — DESIGN.md §6.7.
//!
//! This is the content convention that gives a Source directory File a
//! prunable child index. It is *not* spec structure: ECMA-208 defines the
//! container (a File's Stream, 13.15.7) and the addressing vocabulary reused
//! here — `buffer_address` per 13.4 (sectors counting from the File Set
//! (Sub)Header, first buffer = 1; §11.1 ruling 4) and `buffer_offset` per
//! Figure 24 (bytes from the Buffer's start to a File Header). Every integer
//! is little-endian per 6.1. The layout, its constants and the probe path are
//! specified in DESIGN.md §6.7; constants cite it as `§6.7`.
//!
//! Layout (all offsets stream-relative):
//!
//!   header      32 B   magic "TSIX", version, counts, chunking parameters
//!   chunk table 16 B × M   uniform chunks; positions of each chunk's bytes
//!   slot area   16 B × N   (hash, entry_offset, entry_len), sorted by
//!                          (hash, name) — the binary-search surface
//!   entry area  variable   entries in name order: kind, flags, name_len,
//!                          size, location triple, compression method, name
//!
//! Reader-side invariant: no unit (header, slot, chunk entry, entry) ever
//! straddles a chunk boundary — the writer ends a chunk early instead — so a
//! probe resolves every read to exactly one chunk arithmetically and never
//! searches the chunk table (§6.7 "Chunking rules").
//!
//! Nothing here allocates and nothing panics: malformed input is
//! `error.Invalid` or `error.Truncated` (see `errors.zig`).

const std = @import("std");
const errors = @import("errors.zig");
const fields = @import("fields.zig");
const block = @import("block.zig");

pub const ParseError = errors.ParseError;
/// Writer-side failures (buffer too small, impossible parameters).
pub const Error = errors.ParseError || errors.WriteError;

/// Content magic: bytes `T S I X` in file order (§6.7).
pub const MAGIC: u32 = 0x58495354; // §6.7
pub const FORMAT_VERSION: u16 = 1; // §6.7
pub const HEADER_LEN: u32 = 32; // §6.7
pub const SLOT_LEN: u32 = 16; // §6.7
pub const CHUNK_ENTRY_LEN: u32 = 16; // §6.7
pub const ENTRY_FIXED_LEN: u32 = 20; // §6.7

/// What an entry names: a Source file (FILE TYPE #70 value 4) or a Source
/// directory (value 3). §6.7.
pub const Kind = enum(u8) {
    file = 0,
    directory = 1,
};

/// One child as the packer knows it.
pub const Child = struct {
    /// NS1 name, UTF-8, no path separator (Figure 4/6.15).
    name: []const u8,
    kind: Kind,
    /// Payload bytes for files; 0 for directories.
    size: u32 = 0,
    /// Volume position within the Volume Set, 1-based (4.22).
    volume_set_sequence: u16 = 1,
    /// Where the child's File Header begins: Buffer address (13.4)…
    buffer_address: u32 = 0,
    /// …and bytes from that Buffer's start (Figure 24).
    buffer_offset: u32 = 0,
    /// PKWARE APPNOTE method id; 0 = stored, 8 = Deflate (§8.4). The packer
    /// sets it per File; an entry's flags bit 0 is derived from it (§6.7).
    compression_method: u16 = 0,
};

/// One decoded entry.
pub const Entry = struct {
    kind: Kind,
    flags: u8,
    size: u32,
    volume_set_sequence: u16,
    buffer_address: u32,
    buffer_offset: u32,
    compression_method: u16,
    name: []const u8,
};

pub const Header = struct {
    format_version: u16,
    header_len: u16,
    slot_count: u32,
    chunk_count: u32,
    chunk_payload: u32,
    slot_area_off: u32,
    chunk_table_off: u32,
    entry_area_off: u32,
};

/// Instrumentation for the §6.6/§6.7 working-set accounting.
pub const ProbeStats = struct {
    header_reads: u32 = 0,
    chunk_reads: u32 = 0,
    slot_reads: u32 = 0,
    entry_reads: u32 = 0,
    bytes: u32 = 0,
};

pub const Plan = struct {
    stream_len: u32,
    chunk_count: u32,
    chunk_payload: u32,
};

/// FNV-1a 64-bit over the NS1 name bytes (§6.6/§6.7).
pub fn fnv1a64(bytes: []const u8) u64 {
    var h: u64 = 0xcbf29ce484222325;
    for (bytes) |b| {
        h ^= b;
        h *%= 0x100000001b3;
    }
    return h;
}

fn readU16At(b: []const u8, off: usize) u16 {
    var tmp: [2]u8 = undefined;
    @memcpy(&tmp, b[off .. off + 2]);
    return @intCast(fields.readUintLe(&tmp));
}

fn readU32At(b: []const u8, off: usize) u32 {
    var tmp: [4]u8 = undefined;
    @memcpy(&tmp, b[off .. off + 4]);
    return @intCast(fields.readUintLe(&tmp));
}

fn readU64At(b: []const u8, off: usize) u64 {
    var tmp: [8]u8 = undefined;
    @memcpy(&tmp, b[off .. off + 8]);
    return fields.readUintLe(&tmp);
}

fn putU16(b: []u8, off: usize, v: u16) void {
    fields.writeUintLe(b[off .. off + 2], v);
}

fn putU32(b: []u8, off: usize, v: u32) void {
    fields.writeUintLe(b[off .. off + 4], v);
}

fn putU64(b: []u8, off: usize, v: u64) void {
    fields.writeUintLe(b[off .. off + 8], v);
}

fn entryLen(name_len: usize) u32 {
    return ENTRY_FIXED_LEN + @as(u32, @intCast(name_len));
}

fn chunkCount(stream_len: u32, p: u32) u32 {
    return (stream_len + p - 1) / p;
}

/// The next position at which a unit of `len` bytes may be placed, ending the
/// chunk early (zero filler) when it would not fit (§6.7 "Chunking rules").
fn place(pos: u32, len: u32, p: u32) ParseError!u32 {
    if (len > p) return error.Invalid; // a unit may never exceed a chunk
    const rem = pos % p;
    if (rem + len <= p) return pos;
    return (pos / p + 1) * p;
}

/// Compute the stream length and chunk count for a set of children. Iterates
/// because the chunk table itself occupies stream bytes.
pub fn plan(children: []const Child, chunk_payload: u32) Error!Plan {
    if (chunk_payload == 0 or chunk_payload % 16 != 0) return error.InvalidValue;
    var m: u32 = 1;
    var i: u32 = 0;
    while (true) : (i += 1) {
        if (i > 64) return error.InvalidValue;
        var pos: u32 = HEADER_LEN + CHUNK_ENTRY_LEN * m; // chunk table
        pos += SLOT_LEN * @as(u32, @intCast(children.len)); // slot area
        for (children) |c| {
            if (c.name.len == 0 or c.name.len > 0xFFFF) return error.InvalidValue;
            const len = entryLen(c.name.len);
            pos = try place(pos, len, chunk_payload);
            if (@as(u64, pos) + len > 0xFFFF_FFFF) return error.InvalidValue;
            pos += len;
        }
        const need = pos;
        const m2 = chunkCount(need, chunk_payload);
        if (m2 == m) {
            if (HEADER_LEN + CHUNK_ENTRY_LEN * m > chunk_payload) return error.InvalidValue;
            return .{ .stream_len = need, .chunk_count = m, .chunk_payload = chunk_payload };
        }
        m = m2;
    }
}

fn lessThanChild(children: []const Child, a: u32, b: u32) bool {
    const ha = fnv1a64(children[a].name);
    const hb = fnv1a64(children[b].name);
    if (ha != hb) return ha < hb;
    return std.mem.order(u8, children[a].name, children[b].name) == .lt;
}

fn writeEntry(dst: []u8, c: Child) void {
    @memset(dst, 0);
    dst[0] = @intFromEnum(c.kind);
    dst[1] = if (c.compression_method != 0) 0x01 else 0x00; // §6.7 flags bit0
    putU16(dst, 2, @intCast(c.name.len));
    putU32(dst, 4, c.size);
    putU16(dst, 8, c.volume_set_sequence);
    putU32(dst, 10, c.buffer_address);
    putU32(dst, 14, c.buffer_offset);
    putU16(dst, 18, c.compression_method);
    @memcpy(dst[ENTRY_FIXED_LEN..][0..c.name.len], c.name);
}

/// Serialise a child index. `children` must be sorted by name (entries are
/// written in that order); `order` and `offsets` are caller scratch of at
/// least `children.len` entries each. Chunk physical positions are left zero:
/// the packer fills them with `setChunkPosition` once the stream is placed.
pub fn write(
    children: []const Child,
    order: []u32,
    offsets: []u32,
    out: []u8,
    chunk_payload: u32,
) Error!usize {
    if (order.len < children.len or offsets.len < children.len) return error.InvalidValue;
    const pl = try plan(children, chunk_payload);
    if (out.len < pl.stream_len) return error.NoSpace;
    @memset(out[0..pl.stream_len], 0); // also the inter-chunk filler (§6.7)

    // Header (§6.7).
    putU32(out, 0, MAGIC);
    putU16(out, 4, FORMAT_VERSION);
    putU16(out, 6, HEADER_LEN);
    putU32(out, 8, @intCast(children.len));
    putU32(out, 12, pl.chunk_count);
    putU32(out, 16, pl.chunk_payload);
    putU32(out, 20, HEADER_LEN + CHUNK_ENTRY_LEN * pl.chunk_count);
    putU32(out, 24, HEADER_LEN);
    putU32(out, 28, HEADER_LEN + CHUNK_ENTRY_LEN * pl.chunk_count + SLOT_LEN * @as(u32, @intCast(children.len)));

    // Chunk table: stream offsets and lengths; positions are the packer's job.
    var k: u32 = 0;
    while (k < pl.chunk_count) : (k += 1) {
        const off = k * chunk_payload;
        const len = @min(chunk_payload, pl.stream_len - off);
        putU32(out, HEADER_LEN + CHUNK_ENTRY_LEN * k, off);
        putU32(out, HEADER_LEN + CHUNK_ENTRY_LEN * k + 4, len);
    }

    // Entry placement (identical simulation to `plan`).
    var pos: u32 = HEADER_LEN + CHUNK_ENTRY_LEN * pl.chunk_count + SLOT_LEN * @as(u32, @intCast(children.len));
    for (children, 0..) |c, i| {
        const len = entryLen(c.name.len);
        pos = try place(pos, len, chunk_payload);
        offsets[i] = pos;
        pos += len;
    }
    for (children, 0..) |c, i| {
        const off = offsets[i];
        writeEntry(out[off .. off + entryLen(c.name.len)], c);
    }

    // Slots, sorted by (hash, name).
    for (order[0..children.len], 0..) |*o, i| o.* = @intCast(i);
    std.mem.sort(u32, order[0..children.len], children, lessThanChild);
    for (order[0..children.len], 0..) |ci, i| {
        const c = children[ci];
        const off = HEADER_LEN + CHUNK_ENTRY_LEN * pl.chunk_count + SLOT_LEN * @as(u32, @intCast(i));
        putU64(out, off, fnv1a64(c.name));
        putU32(out, off + 8, offsets[ci]);
        putU32(out, off + 12, entryLen(c.name.len));
    }
    return pl.stream_len;
}

/// Fill in a chunk's physical position once the packer knows it. `header`
/// comes from `parseHeader` (or the same fields the writer just wrote).
pub fn setChunkPosition(out: []u8, header: Header, chunk_index: u32, buffer_address: u32, offset_in_buffer: u32) Error!void {
    if (chunk_index >= header.chunk_count) return error.InvalidValue;
    const at: usize = header.chunk_table_off + CHUNK_ENTRY_LEN * chunk_index;
    if (at + CHUNK_ENTRY_LEN > out.len) return error.NoSpace;
    putU32(out, at + 8, buffer_address);
    putU32(out, at + 12, offset_in_buffer);
}

/// Read and check the 32-byte header out of a buffer that starts at the
/// stream's first byte (§6.7).
pub fn parseHeader(bytes: []const u8) ParseError!Header {
    if (bytes.len < HEADER_LEN) return error.Truncated;
    if (readU32At(bytes, 0) != MAGIC) return error.Invalid;
    const version = readU16At(bytes, 4);
    if (version != FORMAT_VERSION) return error.Invalid;
    const header_len = readU16At(bytes, 6);
    if (header_len != HEADER_LEN) return error.Invalid;
    return .{
        .format_version = version,
        .header_len = header_len,
        .slot_count = readU32At(bytes, 8),
        .chunk_count = readU32At(bytes, 12),
        .chunk_payload = readU32At(bytes, 16),
        .slot_area_off = readU32At(bytes, 20),
        .chunk_table_off = readU32At(bytes, 24),
        .entry_area_off = readU32At(bytes, 28),
    };
}

/// Validate a header plus its (contiguous, chunk-0) chunk table against the
/// stream length. This is the bounded check the hot path runs: it reads the
/// header and the chunk table only, never the slot or entry areas.
pub fn validate(h: Header, stream_len: u32, chunk_table: []const u8) ParseError!void {
    if (h.chunk_payload == 0 or h.chunk_payload % 16 != 0) return error.Invalid;
    if (h.chunk_table_off != HEADER_LEN) return error.Invalid;
    if (h.slot_area_off != HEADER_LEN + CHUNK_ENTRY_LEN * h.chunk_count) return error.Invalid;
    if (h.entry_area_off != h.slot_area_off + SLOT_LEN * h.slot_count) return error.Invalid;
    if (h.entry_area_off > stream_len) return error.Invalid;
    // The header and the whole chunk table live in chunk 0 (§6.7).
    if (HEADER_LEN + CHUNK_ENTRY_LEN * h.chunk_count > h.chunk_payload) return error.Invalid;
    if (h.chunk_count != chunkCount(stream_len, h.chunk_payload)) return error.Invalid;
    if (chunk_table.len < CHUNK_ENTRY_LEN * @as(usize, h.chunk_count)) return error.Truncated;
    var k: u32 = 0;
    while (k < h.chunk_count) : (k += 1) {
        const at = CHUNK_ENTRY_LEN * @as(usize, k);
        const off = readU32At(chunk_table, at);
        const len = readU32At(chunk_table, at + 4);
        if (off != k * h.chunk_payload) return error.Invalid;
        const expect_len = @min(h.chunk_payload, stream_len - off);
        if (len != expect_len) return error.Invalid;
    }
}

/// A contiguous view of one index stream. Structurally validated at parse;
/// slot ordering is *not* verified here (that would read the whole slot area
/// and defeat pruning) — `validate` does that offline.
pub const Index = struct {
    bytes: []const u8,
    header: Header,

    pub fn parse(bytes: []const u8) ParseError!Index {
        const h = try parseHeader(bytes);
        const table_len: usize = CHUNK_ENTRY_LEN * @as(usize, h.chunk_count);
        if (h.chunk_table_off + table_len > bytes.len) return error.Truncated;
        try validate(h, @intCast(bytes.len), bytes[h.chunk_table_off..][0..table_len]);
        return .{ .bytes = bytes, .header = h };
    }

    pub fn read(self: Index, off: u32, len: u32) ParseError![]const u8 {
        if (@as(u64, off) + len > self.bytes.len) return error.Truncated;
        return self.bytes[off..][0..len];
    }

    /// Offline full check: every slot and entry, ordering included. Used by
    /// tests, the packer, and the independent verifier — never on the hot path.
    pub fn validateAll(self: *const Index) ParseError!void {
        const h = self.header;
        var prev_hash: u64 = 0;
        var i: u32 = 0;
        while (i < h.slot_count) : (i += 1) {
            const at = h.slot_area_off + SLOT_LEN * i;
            const hash = readU64At(self.bytes, at);
            const off = readU32At(self.bytes, at + 8);
            const len = readU32At(self.bytes, at + 12);
            if (i > 0 and hash < prev_hash) return error.Invalid; // not sorted
            prev_hash = hash;
            if (off < h.entry_area_off or @as(u64, off) + len > self.bytes.len) return error.Invalid;
            const e = try self.entryAt(off, len);
            if (len != ENTRY_FIXED_LEN + @as(u32, @intCast(e.name.len))) return error.Invalid;
        }
    }

    pub fn entryAt(self: *const Index, off: u32, len: u32) ParseError!Entry {
        if (@as(u64, off) + len > self.bytes.len or len < ENTRY_FIXED_LEN) return error.Truncated;
        return parseEntry(self.bytes[off..][0..len]);
    }

    /// Look up `name` (NS1, exact bytes). Returns null when not present.
    pub fn probe(self: *const Index, name: []const u8, stats: ?*ProbeStats) ParseError!?Entry {
        return probeWith(Index, self.*, self.header, name, stats);
    }

    fn streamLen(self: *const Index) ParseError!u32 {
        return std.math.cast(u32, self.bytes.len) orelse error.Invalid;
    }

    /// The first entry of the entry area (§7.6).
    pub fn firstEntry(self: *const Index) ParseError!?Step {
        return scanStep(Index, self.*, self.header, try self.streamLen(), self.header.entry_area_off);
    }

    /// The entry at stream offset `pos`, or null at the end of the entry area.
    pub fn nextEntry(self: *const Index, pos: u32) ParseError!?Step {
        return scanStep(Index, self.*, self.header, try self.streamLen(), pos);
    }
};

/// The fixed head of an entry: everything but the name bytes.
const EntryHead = struct {
    kind: Kind,
    flags: u8,
    size: u32,
    volume_set_sequence: u16,
    buffer_address: u32,
    buffer_offset: u32,
    compression_method: u16,
    name_len: u16,
};

fn parseEntryHead(head: []const u8) ParseError!EntryHead {
    if (head.len < ENTRY_FIXED_LEN) return error.Truncated;
    const kind_byte = head[0];
    if (kind_byte > 1) return error.Invalid;
    const flags = head[1];
    if (flags & 0xFE != 0) return error.Invalid; // bits 1-7 reserved (§6.7)
    const name_len = readU16At(head, 2);
    if (name_len == 0) return error.Invalid;
    return .{
        .kind = @enumFromInt(kind_byte),
        .flags = flags,
        .size = readU32At(head, 4),
        .volume_set_sequence = readU16At(head, 8),
        .buffer_address = readU32At(head, 10),
        .buffer_offset = readU32At(head, 14),
        .compression_method = readU16At(head, 18),
        .name_len = name_len,
    };
}

fn parseEntry(bytes: []const u8) ParseError!Entry {
    const head = try parseEntryHead(bytes);
    if (@as(usize, head.name_len) > bytes.len - ENTRY_FIXED_LEN) return error.Invalid;
    return entryFrom(head, bytes[ENTRY_FIXED_LEN..][0..head.name_len]);
}

fn entryFrom(head: EntryHead, name: []const u8) Entry {
    return .{
        .kind = head.kind,
        .flags = head.flags,
        .size = head.size,
        .volume_set_sequence = head.volume_set_sequence,
        .buffer_address = head.buffer_address,
        .buffer_offset = head.buffer_offset,
        .compression_method = head.compression_method,
        .name = name,
    };
}

fn isZero4(b: []const u8) bool {
    return b.len >= 4 and b[0] == 0 and b[1] == 0 and b[2] == 0 and b[3] == 0;
}

/// One step of the entry-area scan (§7.6 `readdir`).
pub const Step = struct {
    entry: Entry,
    /// Stream offset just past this entry — where the next step resumes.
    next: u32,
};

/// Walk the entry area in stream order (= NS1 name order, §8.1 invariant 6).
///
/// Filler is recognised the way the writer produces it (§6.7 "Chunking
/// rules"): a unit never straddles a chunk, so a position with fewer than
/// `ENTRY_FIXED_LEN` bytes left in its chunk cannot start one, and the writer
/// zero-fills the bytes it skips. A real entry always has `name_len >= 1`, so
/// an all-zero 4-byte prefix is filler too. Either way the scan resumes at the
/// next chunk boundary — it never parses filler as an entry, and never reads
/// across a chunk boundary.
fn scanStep(comptime R: type, reader: R, h: Header, stream_len: u32, pos: u32) ParseError!?Step {
    const p = h.chunk_payload;
    if (p == 0 or p % 16 != 0) return error.Invalid;
    var at = pos;
    var jumps: u32 = 0;
    while (true) {
        if (at >= stream_len) return null;
        const rem = p - (at % p);
        var filler = rem < ENTRY_FIXED_LEN;
        var head_bytes: []const u8 = &.{};
        if (!filler) {
            head_bytes = try reader.read(at, ENTRY_FIXED_LEN);
            filler = isZero4(head_bytes[0..4]);
        }
        if (filler) {
            jumps += 1;
            if (jumps > h.chunk_count) return error.Invalid;
            const boundary: u64 = @as(u64, at) + rem;
            if (boundary <= at or boundary >= stream_len) return null;
            at = @intCast(boundary);
            continue;
        }
        const head = try parseEntryHead(head_bytes);
        const len: u32 = ENTRY_FIXED_LEN + @as(u32, head.name_len);
        if (@as(u64, at % p) + len > p) return error.Invalid; // a unit never straddles
        const name = try reader.read(at + ENTRY_FIXED_LEN, head.name_len);
        return .{ .entry = entryFrom(head, name), .next = at + len };
    }
}

/// The equal-hash run walk is bounded; a longer run means a malformed or
/// adversarial index (§6.7).
const MAX_RUN_WALK: u32 = 64;

fn probeWith(comptime R: type, reader: R, h: Header, name: []const u8, stats: ?*ProbeStats) ParseError!?Entry {
    if (name.len == 0 or name.len > 0xFFFF) return null;
    const want = fnv1a64(name);
    var lo: usize = 0;
    var hi: usize = h.slot_count;
    while (lo < hi) {
        const mid = lo + (hi - lo) / 2;
        const slot = try readSlot(R, reader, h, mid, stats);
        if (slot.hash < want) {
            lo = mid + 1;
        } else if (slot.hash > want) {
            hi = mid;
        } else {
            // Equal hash: slots are sorted by (hash, name) and names are
            // unique within a directory, so one name comparison picks the
            // only direction worth walking — the common case (a unique
            // 64-bit hash) costs no extra slot read at all.
            const e = try readEntry(R, reader, slot, h, stats);
            if (e.name.len == name.len and std.mem.eql(u8, e.name, name)) return e;
            const go_forward = std.mem.order(u8, e.name, name) == .lt;
            var walked: u32 = 0;
            var i: usize = mid;
            while (true) {
                walked += 1;
                if (walked > MAX_RUN_WALK) return error.Invalid;
                if (go_forward) {
                    i += 1;
                    if (i >= h.slot_count) return null;
                } else {
                    if (i == 0) return null;
                    i -= 1;
                }
                const s = try readSlot(R, reader, h, i, stats);
                if (s.hash != want) return null;
                const ei = try readEntry(R, reader, s, h, stats);
                if (ei.name.len == name.len and std.mem.eql(u8, ei.name, name)) return ei;
            }
        }
    }
    return null;
}

const Slot = struct {
    hash: u64,
    entry_offset: u32,
    entry_len: u32,
};

fn countChunkRead(comptime R: type, h: Header, off: u32, stats: ?*ProbeStats) void {
    // §6.7: reads inside chunk 0 are direct; other reads consult one 16-byte
    // chunk-table entry.
    if (comptime R == ChunkView) {
        if (stats) |s| {
            if (off / h.chunk_payload != 0) {
                s.chunk_reads += 1;
                s.bytes += CHUNK_ENTRY_LEN;
            }
        }
    }
}

fn readSlot(comptime R: type, reader: R, h: Header, index: usize, stats: ?*ProbeStats) ParseError!Slot {
    const off: u32 = h.slot_area_off + SLOT_LEN * @as(u32, @intCast(index));
    const bytes = try reader.read(off, SLOT_LEN);
    countChunkRead(R, h, off, stats);
    if (stats) |s| {
        s.slot_reads += 1;
        s.bytes += @intCast(bytes.len);
    }
    return .{
        .hash = readU64At(bytes, 0),
        .entry_offset = readU32At(bytes, 8),
        .entry_len = readU32At(bytes, 12),
    };
}

fn readEntry(comptime R: type, reader: R, slot: Slot, h: Header, stats: ?*ProbeStats) ParseError!Entry {
    if (slot.entry_len < ENTRY_FIXED_LEN or slot.entry_len > 0xFFFF) return error.Invalid;
    const bytes = try reader.read(slot.entry_offset, slot.entry_len);
    countChunkRead(R, h, slot.entry_offset, stats);
    if (stats) |s| {
        s.entry_reads += 1;
        s.bytes += @intCast(bytes.len);
    }
    return parseEntry(bytes);
}

/// A window over the container that resolves stream offsets through the
/// chunk table (§6.7), fetching every byte through a `BlockReader` (§6.8).
/// This is what the phase-4 walker uses for real paks; `Index` is the
/// contiguous special case.
pub const ChunkView = struct {
    reader: block.BlockReader,
    /// Absolute image offset of the stream's first byte — immediately after
    /// the Stream Header Field Table (10.4, §6.2).
    stream_start: u64,
    stream_len: u32,
    /// Sector size from the Volume Header (`SECTOR SIZE` `#80800E`, 10.1).
    sector_size: u32,
    /// Absolute sector of the File Set Header; `buffer_address` counts from
    /// it (§11.1 ruling 4).
    fs_header_sector: u32,
    header: Header,

    pub fn init(
        reader: block.BlockReader,
        stream_start: u64,
        stream_len: u32,
        sector_size: u32,
        fs_header_sector: u32,
    ) ParseError!ChunkView {
        const header_bytes = try reader.read(stream_start, HEADER_LEN);
        const h = try parseHeader(header_bytes);
        const table_len: usize = CHUNK_ENTRY_LEN * @as(usize, h.chunk_count);
        const table = try reader.read(stream_start + h.chunk_table_off, table_len);
        try validate(h, stream_len, table);
        return .{
            .reader = reader,
            .stream_start = stream_start,
            .stream_len = stream_len,
            .sector_size = sector_size,
            .fs_header_sector = fs_header_sector,
            .header = h,
        };
    }

    pub fn read(self: ChunkView, off: u32, len: u32) ParseError![]const u8 {
        if (len == 0) return &.{};
        const p = self.header.chunk_payload;
        if (@as(u64, off) + len > self.stream_len) return error.Truncated;
        const chunk: u32 = off / p;
        const within: u32 = off % p;
        if (chunk >= self.header.chunk_count) return error.Invalid;
        if (within + len > p) return error.Invalid; // units never straddle (§6.7)
        const base: u64 = if (chunk == 0) self.stream_start else blk: {
            // The chunk table itself is in chunk 0, so its entry's bytes are
            // fetched directly (no mapping needed).
            const at = self.stream_start + self.header.chunk_table_off + CHUNK_ENTRY_LEN * chunk;
            const ent = try self.reader.read(at, CHUNK_ENTRY_LEN);
            const buffer_address = readU32At(ent, 8);
            const offset_in_buffer = readU32At(ent, 12);
            break :blk (@as(u64, self.fs_header_sector) + buffer_address) * self.sector_size + offset_in_buffer;
        };
        return self.reader.read(base + within, len);
    }

    pub fn probe(self: *const ChunkView, name: []const u8, stats: ?*ProbeStats) ParseError!?Entry {
        return probeWith(ChunkView, self.*, self.header, name, stats);
    }

    /// The first entry of the entry area (§7.6).
    pub fn firstEntry(self: *const ChunkView) ParseError!?Step {
        return scanStep(ChunkView, self.*, self.header, self.stream_len, self.header.entry_area_off);
    }

    /// The entry at stream offset `pos`, or null at the end of the entry area.
    pub fn nextEntry(self: *const ChunkView, pos: u32) ParseError!?Step {
        return scanStep(ChunkView, self.*, self.header, self.stream_len, pos);
    }
};
