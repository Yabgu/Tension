//! The path walker (DESIGN.md §6.8): root discovery and per-level descent,
//! with every byte fetched through a `BlockReader` — no direct access to the
//! pak image anywhere in this module.
//!
//! Reading discipline: fields are fetched FID-byte, length-byte, data-byte by
//! data-byte and assembled into a bounded table buffer that the `metadata`
//! parsers then validate. Nothing is over-read, so the pruning property
//! (assertion #2 of the phase-4 test) follows from the read pattern itself
//! rather than from fixture padding.

const std = @import("std");
const errors = @import("errors.zig");
const block = @import("block.zig");
const fields = @import("fields.zig");
const metadata = @import("metadata.zig");
const index = @import("index.zig");

pub const WalkError = error{ NotFound, NotDir, IsDir, Invalid, Truncated };

/// Upper bound on a File's chunk count, mirroring `writer.MAX_CHUNKS`: a chain
/// longer than this is a malformed volume, not a big File (§8.3).
pub const MAX_CHUNKS: u32 = 4096 * 1024;

/// The negative errno for a walk failure (the ABI table of §6.8).
pub fn errnoFor(e: WalkError) i32 {
    return switch (e) {
        error.NotFound => errors.ENOENT,
        error.NotDir => errors.ENOTDIR,
        error.IsDir => errors.EISDIR,
        error.Invalid => errors.EINVAL,
        error.Truncated => errors.EIO,
    };
}

pub const Expect = enum { any, file, directory };

pub const Stat = struct {
    kind: index.Kind,
    size: u32,
};

/// A File's Data stream, resolved to an image range (§7.5). The payload is
/// contiguous and its length is `len`; phase 3/5 paks are Stored
/// (`stream_format` 0, `compress_type` null).
/// One chunk of a multi-chunk File (§8.3): where it starts and how many File
/// Space bytes it records (FILE CHUNK SIZE, 13.12 / 13.13).
pub const ChunkRef = struct {
    buffer_address: u32,
    buffer_offset: u32,
    chunk_size: u32,
};

/// The description of a chunked File's chain. No payload bytes, no cache: the
/// walker returns this and stays stateless (§8.3 "Cache placement").
pub const Chain = struct {
    chunk_count: u32,
    total_size: u32,
    first: ChunkRef,
};

/// One chunk of a chunked File's payload, in absolute image coordinates (§8.3).
/// `payload_len` is payload only: a chain's final chunk does not count its
/// trailers, which are not bytes of the Data Stream.
pub const ChunkSpan = struct {
    payload_abs: u64,
    payload_len: u32,
};

/// What one chain walk yields (§8.3). A full walk yields `chain`; a walk that
/// stopped because it found `query_off`'s chunk yields `pos` instead.
const ChainWalk = struct {
    chain: ?Chain = null,
    pos: ?ChunkPos = null,
};

/// Where a byte offset inside a File lives: which chunk, how far into it, and
/// — for a chunked File — where that chunk's payload is and how long it is, so
/// a reader can copy without a second walk. A single-chunk File reads from its
/// own stream location and leaves the span fields zero.
pub const ChunkPos = struct {
    chunk_index: u32,
    offset_in_chunk: u32,
    payload_abs: u64 = 0,
    payload_len: u32 = 0,
};

pub const Single = struct {
    buffer_address: u32,
    buffer_offset: u32,
    size: u32,
};

/// A data stream's location: one contiguous range, or a chunk chain (§8.3).
/// This is what `openData` returns; the walker caches nothing.
pub const FileLocation = union(enum) {
    single: Single,
    chunked: Chain,
};

pub const DataStream = struct {
    /// Absolute image offset of the first payload byte — immediately after the
    /// Stream Header FT (10.4, §6.2).
    abs: u64,
    /// STREAM SIZE (`#8003`, 13.15.7.1).
    len: u32,
    /// STREAM TYPE / STREAM FORMAT (`#8001`/`#8002`; Annex C #2B/#2C).
    stream_type: u8,
    stream_format: u8,
    /// STREAM COMPRESS TYPE (`#8005`) as the PKWARE APPNOTE method id, or
    /// null for Clear data.
    compress_type: ?u16,
    /// STREAM EXPANDED SIZE (`#8006`, 13.15.7.1): the size a compressed stream
    /// expands to, which the Stream Header must carry when STREAM FORMAT is 2
    /// (compressed data, 13.15.7.4). Null for a stored stream.
    expanded_size: ?u64 = null,
    /// §8.3: which form this File took. `abs` always points at chunk 0's first
    /// payload byte; `len` is always the File's *total* payload, so callers
    /// that bound reads by it stay correct for both forms.
    location: FileLocation = .{ .single = .{ .buffer_address = 0, .buffer_offset = 0, .size = 0 } },
};

pub const Location = struct {
    kind: index.Kind,
    size: u32,
    volume_set_sequence: u16,
    buffer_address: u32,
    buffer_offset: u32,
    compression_method: u16,
    /// The matched NS1 name; a slice of the reader's storage (§6.8).
    name: []const u8,
};

/// The walker keeps only what the descent needs; `image_len` is the sole use
/// of the pak slice — a length, never its bytes (§6.8).
pub const Walker = struct {
    reader: block.BlockReader,
    image_len: u64,
    sector_size: u32,
    /// 13.7 BUFFER SIZE: the uniform Buffer stride the continuation chain walks
    /// by (§8.3).
    buffer_size: u32 = 0,
    fs_header_sector: u32,
    root: index.ChunkView,
    root_abs: u64,
    root_buffer_address: u32,
    root_buffer_offset: u32,

    const MAX_TABLE: usize = 8 * 1024;
    const MAX_FIELDS: usize = 4096;
    const MAX_COMPONENTS: usize = 64;
    const MAX_FILE_DATA_TABLES: usize = 32;

    pub fn init(pak_bytes: []const u8, reader: block.BlockReader) WalkError!Walker {
        var buf: [MAX_TABLE]u8 = undefined;

        // Volume Header Field Table, sector 0 (13.1). SECTOR SIZE is
        // mandatory (#80800E, 10.1: 2^(n+8) bytes).
        var c = Cursor{ .reader = reader, .off = 0 };
        const vh = try readTable(&c, fields.VOLUME_HEADER, &buf);
        const volume = metadata.parseVolumeHeader(vh.bytes) catch |e| return mapParse(e);
        const sector_size = volume.sector_size orelse return error.Invalid;
        if (sector_size < 512 or sector_size > (1 << 22) or (sector_size & (sector_size - 1)) != 0) {
            return error.Invalid;
        }

        // The File Set Header starts at sector 1 (§11.1 layout convention).
        const fs_header_sector: u32 = 1;
        c.off = @as(u64, fs_header_sector) * sector_size;
        const fs_start = c.off;
        const fsh = try readTable(&c, fields.FILE_SET_HEADER, &buf);
        const file_set = metadata.parseFileSetHeader(fsh.bytes) catch |e| return mapParse(e);
        const buffer_size = file_set.buffer_size orelse return error.Invalid;
        if (buffer_size == 0) return error.Invalid;
        const fs_header_sectors = divCeil(fsh.end - fs_start, sector_size);

        // First Buffer of the File Set: Buffer Header FT (13.4) immediately
        // followed by the first File Space (10.6); that File is the root
        // directory (§5.5/§6.5 layout convention).
        c.off = @as(u64, fs_header_sector + fs_header_sectors) * sector_size;
        const bh = try readTable(&c, fields.BUFFER_HEADER, &buf);
        _ = metadata.parseBufferHeader(bh.bytes) catch |e| return mapParse(e);
        const root_abs = bh.end;

        var self = Walker{
            .reader = reader,
            .image_len = pak_bytes.len,
            .sector_size = sector_size,
            .buffer_size = buffer_size,
            .fs_header_sector = fs_header_sector,
            .root = undefined,
            .root_abs = root_abs,
            .root_buffer_address = @intCast(root_abs / sector_size - fs_header_sector),
            .root_buffer_offset = @intCast(root_abs % sector_size),
        };
        self.root = try self.openIndex(root_abs);
        return self;
    }

    /// Resolve a path; `expect` distinguishes open-on-file from open-on-rectory
    /// (DESIGN.md §6.8 error table).
    pub fn resolve(self: *const Walker, path: []const u8, expect: Expect) WalkError!Location {
        var comps: [MAX_COMPONENTS][]const u8 = undefined;
        const norm = try normalize(path, &comps);

        var view = self.root;
        var loc = Location{
            .kind = .directory,
            .size = 0,
            .volume_set_sequence = 1,
            .buffer_address = self.root_buffer_address,
            .buffer_offset = self.root_buffer_offset,
            .compression_method = 0,
            .name = &.{},
        };
        var i: usize = 0;
        while (i < norm.count) : (i += 1) {
            const last = i + 1 == norm.count;
            const component = comps[i];
            const e = (try view.probe(component, null)) orelse return error.NotFound;
            if (last) {
                if (norm.trailing_slash and e.kind != .directory) return error.NotDir;
                switch (expect) {
                    .any => {},
                    .file => if (e.kind != .file) return error.IsDir,
                    .directory => if (e.kind != .directory) return error.NotDir,
                }
                loc = .{
                    .kind = e.kind,
                    .size = e.size,
                    .volume_set_sequence = e.volume_set_sequence,
                    .buffer_address = e.buffer_address,
                    .buffer_offset = e.buffer_offset,
                    .compression_method = e.compression_method,
                    .name = e.name,
                };
                return loc;
            }
            if (e.kind != .directory) return error.NotDir;
            const child_abs = self.locationToAbsolute(e) catch |err| return err;
            view = try self.openIndex(child_abs);
        }
        // Empty path: the root directory itself.
        if (norm.trailing_slash or norm.count == 0) return loc;
        return error.NotFound;
    }

    /// `lookup` additionally proves the leaf's location is inside the image by
    /// fetching one byte there; `stat` stops at name resolution (§6.8).
    pub fn lookup(self: *const Walker, path: []const u8) WalkError!Location {
        const loc = try self.resolve(path, .any);
        const abs = try self.locationAbsOf(loc.buffer_address, loc.buffer_offset, loc.volume_set_sequence);
        // An out-of-image location is EINVAL *before* any read is published
        // (§6.8) — the single use of the pak slice's length.
        if (abs >= self.image_len) return error.Invalid;
        _ = self.reader.read(abs, 1) catch |e| return mapParse(e);
        return loc;
    }

    pub fn stat(self: *const Walker, path: []const u8) WalkError!Stat {
        const loc = try self.resolve(path, .any);
        return .{ .kind = loc.kind, .size = loc.size };
    }

    /// Open a directory File's child-index Stream by path (the VFS's
    /// `readdir`, DESIGN.md §7.6). A file in that position is `NotDir`; a
    /// directory File without an index Stream is `NotFound` (§11).
    pub fn openDir(self: *const Walker, path: []const u8) WalkError!index.ChunkView {
        const loc = try self.resolve(path, .directory);
        const abs = try self.locationAbsOf(loc.buffer_address, loc.buffer_offset, loc.volume_set_sequence);
        if (abs >= self.image_len) return error.Invalid;
        return self.openIndex(abs);
    }

    /// Resolve a located File's Data stream to an image range (the VFS's
    /// `read`, DESIGN.md §7.5). A File with no Data stream is `NotFound` — the
    /// VFS opens it and reports `-EIO` on read (§11); a stream whose format is
    /// not Clear data is returned as-is so that policy stays in the VFS.
    pub fn openData(self: *const Walker, loc: Location) WalkError!DataStream {
        var buf: [MAX_TABLE]u8 = undefined;
        const file_abs = try self.locationAbsOf(loc.buffer_address, loc.buffer_offset, loc.volume_set_sequence);
        if (file_abs >= self.image_len) return error.Invalid;
        var c = Cursor{ .reader = self.reader, .off = file_abs };

        const fh = try readTable(&c, fields.FILE_HEADER, &buf);
        const file_header = metadata.parseFileHeader(fh.bytes) catch |e| return mapParse(e);
        const file_type = file_header.file_type orelse return error.Invalid;
        if (file_type == @intFromEnum(metadata.FileType.source_directory)) return error.IsDir;
        const fi = try readTable(&c, fields.FILE_INFORMATION, &buf);
        _ = metadata.parseFileInformation(fi.bytes) catch |e| return mapParse(e);

        var guard: usize = 0;
        while (true) {
            guard += 1;
            if (guard > MAX_FILE_DATA_TABLES) return error.Invalid;
            const t = try readTable(&c, null, &buf);
            if (t.fid.eql(fields.STREAM_HEADER)) {
                const sh = metadata.parseStreamHeader(t.bytes) catch |e| return mapParse(e);
                const stream_type = sh.stream_type orelse return error.Invalid;
                const stream_format = sh.stream_format orelse return error.Invalid;
                const stream_size = sh.stream_size orelse return error.Invalid;
                if (stream_size > 0xFFFF_FFFF) return error.Invalid;
                if (stream_type == @intFromEnum(metadata.StreamType.data)) {
                    const head_bytes: u64 = t.end - file_abs;
                    const recorded_chunk: u64 = file_header.file_chunk_size orelse return error.Invalid;
                    const total: u32 = @intCast(stream_size);
                    var stream = DataStream{
                        .abs = t.end,
                        .len = total,
                        .stream_type = stream_type,
                        .stream_format = stream_format,
                        .compress_type = try decodeCompressType(sh.compress_type),
                        .expanded_size = sh.expanded_size,
                    };
                    // §8.3: a single-chunk File Space ends with a STREAM TRAILER
                    // FT (13.15.7.2) right after the payload; a chunked one is
                    // followed by the next Buffer's File Continuation Header FT
                    // (13.13). Probing what actually follows is exact, where
                    // comparing FILE CHUNK SIZE against the payload is not.
                    if (try self.singleChunkAt(t.end + stream_size)) {
                        stream.location = .{ .single = .{
                            .buffer_address = loc.buffer_address,
                            .buffer_offset = loc.buffer_offset,
                            .size = total,
                        } };
                        return stream;
                    }
                    stream.location = .{ .chunked = try self.walkChain(
                        file_abs,
                        loc.buffer_address,
                        loc.buffer_offset,
                        head_bytes,
                        total,
                        recorded_chunk,
                    ) };
                    return stream;
                }
                c.off = t.end + stream_size; // skip this stream's payload (13.15.7)
                _ = try readTable(&c, fields.STREAM_TRAILER, &buf);
                continue;
            }
            if (t.fid.eql(fields.SOURCE_FILE_TRAILER) or
                t.fid.eql(fields.SOURCE_DIRECTORY_TRAILER))
            {
                return error.NotFound; // no Data stream at all
            }
        }
    }

    /// Does a STREAM TRAILER FT (13.15.7.2) begin at `at`? The exact test for
    /// "this File Space is complete in its Buffer" (§8.3).
    fn singleChunkAt(self: *const Walker, at: u64) WalkError!bool {
        if (at >= self.image_len) return false;
        var c = Cursor{ .reader = self.reader, .off = at };
        var buf: [MAX_TABLE]u8 = undefined;
        if (readTable(&c, fields.STREAM_TRAILER, &buf)) |_| {
            return true;
        } else |e| switch (e) {
            // The probe is a *negative* test — "does a STREAM TRAILER FT start
            // here?" — so anything that is not a well-formed table is a no:
            // a bogus FID, or a field whose length runs off the image. Both
            // mean "not here"; the caller then walks the chain, which reports
            // loudly if the File really is malformed.
            error.Invalid, error.Truncated => return false,
            else => return e,
        }
    }

    /// The one chain walk (§8.3): chunk 0 is the File Header FT (13.12) with
    /// FILE CHUNK SIZE; every later chunk opens the next Buffer with a File
    /// Continuation Header FT (13.13) carrying FILE CHUNK SIZE. Buffers are
    /// uniform (13.7 BUFFER SIZE), so each continuation starts exactly
    /// `buffer_size` bytes after the previous chunk.
    ///
    /// One walk serves every caller: `openData`/`chainSpans` want the finished
    /// description, and `locate` wants only the chunk holding one offset. So
    /// `spans` (record each chunk's payload extent while walking) and
    /// `query_off` (stop the moment that offset's chunk is known) are both
    /// optional — and mutually exclusive: a `query_off` walk returns as soon as
    /// it can answer, so it neither reaches the last chunk nor checks its
    /// trailer. Only a full walk does that.
    fn walkChainInto(
        self: *const Walker,
        file_off0: u64,
        first_buffer_address: u32,
        first_buffer_offset: u32,
        head_bytes: u64,
        total_size: u32,
        first_chunk_size: u64,
        spans: ?[]ChunkSpan,
        query_off: ?u64,
    ) WalkError!ChainWalk {
        if (first_chunk_size <= head_bytes) return error.Invalid;
        if (spans != null and query_off != null) return error.Invalid;
        const total: u64 = total_size;
        const first = ChunkRef{
            .buffer_address = first_buffer_address,
            .buffer_offset = first_buffer_offset,
            .chunk_size = @intCast(first_chunk_size),
        };
        // `covered` counts payload the chain has accounted for. Chunk 0 carries
        // `first_chunk_size - head_bytes` of it; the walk continues until the
        // whole Data Stream (13.14 DATA STREAM SIZE) is covered.
        var covered: u64 = @min(first_chunk_size - head_bytes, total);
        if (covered == 0 and total != 0) return error.Invalid;
        var chunks: u32 = 1;
        var file_off: u64 = file_off0;
        if (spans) |out| out[0] = .{ .payload_abs = file_off0 + head_bytes, .payload_len = @intCast(covered) };
        if (query_off) |q| {
            if (q < covered) {
                return .{ .pos = .{
                    .chunk_index = 0,
                    .offset_in_chunk = @intCast(q),
                    .payload_abs = file_off0 + head_bytes,
                    .payload_len = @intCast(covered),
                } };
            }
        }
        var last_payload_end: u64 = file_off0 + head_bytes + covered;
        while (covered < total) {
            if (chunks >= MAX_CHUNKS) return error.Invalid;
            file_off += self.buffer_size;
            if (file_off >= self.image_len) return error.Invalid;
            var c = Cursor{ .reader = self.reader, .off = file_off };
            var buf: [MAX_TABLE]u8 = undefined;
            const t = try readTable(&c, fields.FILE_CONTINUATION_HEADER, &buf);
            const header_bytes: u64 = t.end - file_off;
            const fcs = tableUint(t.bytes, fields.FILE_CHUNK_SIZE) orelse return error.Invalid;
            if (fcs <= header_bytes) return error.Invalid;
            // The final chunk's FILE CHUNK SIZE counts its trailers too
            // (§11.1 ruling 7), so cap against what the stream still owes.
            const payload = @min(fcs - header_bytes, total - covered);
            if (payload == 0) return error.Invalid;
            if (spans) |out| {
                // The caller's buffer must fit the whole chain, chunk 0 first.
                if (chunks >= out.len) return error.Invalid;
                out[chunks] = .{ .payload_abs = t.end, .payload_len = @intCast(payload) };
            }
            if (query_off) |q| {
                if (q < covered + payload) {
                    return .{ .pos = .{
                        .chunk_index = chunks,
                        .offset_in_chunk = @intCast(q - covered),
                        .payload_abs = t.end,
                        .payload_len = @intCast(payload),
                    } };
                }
            }
            covered += payload;
            chunks += 1;
            last_payload_end = t.end + payload;
        }
        // The chain's last chunk must close its File Space like any other: a
        // STREAM TRAILER FT follows the payload (13.15.7.2). Without this, a
        // chain that over-claims would pass unnoticed.
        // The last chunk must close the File Data (13.15.7.2), and there are two
        // legal shapes. Either the trailers follow the payload in the same File
        // Space, or the payload ended exactly at its Buffer's end and the
        // trailers open the *next* chunk — a File Space with a File Continuation
        // Header FT whose FILE CHUNK SIZE covers only its own headers and the
        // closing tables, and which carries no payload at all. That second shape
        // is what the packer emits when a chunk fills its Buffer exactly, so the
        // walk must accept it (FILE CHUNK SIZE = "bytes of this File contained
        // in this Buffer", 13.13 — zero is a value).
        if (!try self.singleChunkAt(last_payload_end)) {
            if (!try self.emptyFinalChunk(file_off + self.buffer_size)) return error.Invalid;
            if (spans) |out| {
                if (chunks >= out.len) return error.Invalid;
                out[chunks] = .{ .payload_abs = last_payload_end, .payload_len = 0 };
            }
            chunks += 1;
        }
        // A span buffer that does not match the chain exactly is a caller bug,
        // not a malformed pak; the walk reports it as Invalid all the same.
        if (spans) |out| if (out.len != chunks) return error.Invalid;
        return .{ .chain = .{ .chunk_count = chunks, .total_size = total_size, .first = first } };
    }

    /// The full walk: the File's chain description, with the last chunk's
    /// trailer checked.
    fn walkChain(
        self: *const Walker,
        file_off0: u64,
        first_buffer_address: u32,
        first_buffer_offset: u32,
        head_bytes: u64,
        total_size: u32,
        first_chunk_size: u64,
    ) WalkError!Chain {
        const r = try self.walkChainInto(
            file_off0,
            first_buffer_address,
            first_buffer_offset,
            head_bytes,
            total_size,
            first_chunk_size,
            null,
            null,
        );
        return r.chain orelse error.Invalid; // unreachable: a full walk always has one
    }

    /// §8.3: materialize a chunked File's chain into `out`, which must be
    /// exactly `chunk_count` long. The walker allocates nothing — the caller
    /// owns the buffer (the VFS Handle is the only caller, and it caches the
    /// result per open). A single-chunk File has no chain to record.
    pub fn chainSpans(self: *const Walker, file: FileLocation, out: []ChunkSpan) WalkError!Chain {
        const chain = switch (file) {
            .single => return error.Invalid,
            .chunked => |c| c,
        };
        if (out.len == 0) return error.Invalid;
        const file_abs = try self.locationAbsOf(
            chain.first.buffer_address,
            chain.first.buffer_offset,
            1,
        );
        const head_bytes = try self.chunkHeadBytes(file_abs);
        const r = try self.walkChainInto(
            file_abs,
            chain.first.buffer_address,
            chain.first.buffer_offset,
            head_bytes,
            chain.total_size,
            chain.first.chunk_size,
            out,
            null,
        );
        return r.chain orelse error.Invalid;
    }

    /// TEST-ONLY, §9b MAX_CHUNKS seam. Not part of the module's supported
    /// surface — production code reaches a chain only through `openData` — and
    /// it is never called from the ABI. It exists because the chain-length cap
    /// can only be reached by a chain needing a multi-gigabyte image, and a
    /// unit test cannot fabricate that: this walks a caller-supplied reader
    /// over a caller-supplied image length instead. `file_abs` and the two
    /// Buffer fields must agree (they are one location, in the pak's own
    /// sector-addressing convention, §11.1 ruling 4); `image_len` bounds the
    /// walk exactly as the real pak slice does.
    pub fn walkChainForTest(
        reader: block.BlockReader,
        image_len: u64,
        buffer_size: u32,
        file_abs: u64,
        first_buffer_address: u32,
        first_buffer_offset: u32,
        head_bytes: u64,
        total_size: u32,
        first_chunk_size: u64,
    ) WalkError!Chain {
        const w = Walker{
            .reader = reader,
            .image_len = image_len,
            .sector_size = 512,
            .buffer_size = buffer_size,
            .fs_header_sector = 1,
            .root = undefined, // never consulted: walkChain reads no directories
            .root_abs = 0,
            .root_buffer_address = 0,
            .root_buffer_offset = 0,
        };
        return w.walkChain(
            file_abs,
            first_buffer_address,
            first_buffer_offset,
            head_bytes,
            total_size,
            first_chunk_size,
        );
    }

    /// Is the File Space at `at` a payload-less final chunk (§8.3)? It opens
    /// with a File Continuation Header FT (13.13) and the STREAM TRAILER FT
    /// (13.15.7.2) follows it *immediately* — no bytes of the File in between,
    /// which is exactly what "this chunk carries no payload" means. (FILE CHUNK
    /// SIZE is not the test: by §11.1 ruling 7 it counts the whole File Space,
    /// trailers included, so it is larger than the header alone in every
    /// chunk.)
    fn emptyFinalChunk(self: *const Walker, at: u64) WalkError!bool {
        if (at >= self.image_len) return false;
        var c = Cursor{ .reader = self.reader, .off = at };
        var buf: [MAX_TABLE]u8 = undefined;
        if (readTable(&c, fields.FILE_CONTINUATION_HEADER, &buf)) |_| {
            return self.singleChunkAt(@intCast(c.off));
        } else |e| switch (e) {
            error.Invalid, error.Truncated => return false,
            else => return e,
        }
    }

    /// §8.3: which chunk holds `offset`, and how far into it. Walks the chain
    /// on every call — the walker caches nothing; the VFS Handle does.
    pub fn locate(
        self: *const Walker,
        file: FileLocation,
        offset: u32,
    ) WalkError!ChunkPos {
        switch (file) {
            .single => |s| {
                if (offset > s.size) return error.Invalid;
                return .{ .chunk_index = 0, .offset_in_chunk = offset };
            },
            .chunked => |chain| {
                if (offset >= chain.total_size) return error.Invalid;
                // Chunk 0's payload extent needs its headers, so re-read them
                // here rather than trusting the chain's summary.
                const file_abs = try self.locationAbsOf(
                    chain.first.buffer_address,
                    chain.first.buffer_offset,
                    1,
                );
                const head_bytes = try self.chunkHeadBytes(file_abs);
                const r = try self.walkChainInto(
                    file_abs,
                    chain.first.buffer_address,
                    chain.first.buffer_offset,
                    head_bytes,
                    chain.total_size,
                    chain.first.chunk_size,
                    null,
                    offset,
                );
                return r.pos orelse error.Invalid; // unreachable: a query returns a pos
            },
        }
    }

    /// Bytes from a File Header FT to its Stream's first payload byte.
    fn chunkHeadBytes(self: *const Walker, file_abs: u64) WalkError!u64 {
        var c = Cursor{ .reader = self.reader, .off = file_abs };
        var buf: [MAX_TABLE]u8 = undefined;
        _ = try readTable(&c, fields.FILE_HEADER, &buf);
        _ = try readTable(&c, fields.FILE_INFORMATION, &buf);
        var guard: usize = 0;
        while (true) {
            guard += 1;
            if (guard > MAX_FILE_DATA_TABLES) return error.Invalid;
            const t = try readTable(&c, null, &buf);
            if (t.fid.eql(fields.STREAM_HEADER)) return t.end - file_abs;
            if (t.fid.eql(fields.SOURCE_FILE_TRAILER) or
                t.fid.eql(fields.SOURCE_DIRECTORY_TRAILER)) return error.Invalid;
        }
    }

    fn locationAbsOf(self: *const Walker, buffer_address: u32, buffer_offset: u32, vss: u16) WalkError!u64 {
        if (vss != 1) return error.Invalid; // single-volume paks (phase 4; §9)
        return (@as(u64, self.fs_header_sector) + buffer_address) * self.sector_size + buffer_offset;
    }

    fn locationToAbsolute(self: *const Walker, e: index.Entry) WalkError!u64 {
        const abs = try self.locationAbsOf(e.buffer_address, e.buffer_offset, e.volume_set_sequence);
        // Bounds belong to the reader, but a corrupted index must be rejected
        // before its location is used at all (§6.8).
        if (abs >= self.image_len) return error.Invalid;
        return abs;
    }

    /// Open a directory File's child-index Stream (DESIGN.md §6.8).
    fn openIndex(self: *const Walker, file_abs: u64) WalkError!index.ChunkView {
        var buf: [MAX_TABLE]u8 = undefined;
        var c = Cursor{ .reader = self.reader, .off = file_abs };

        const fh = try readTable(&c, fields.FILE_HEADER, &buf);
        const file_header = metadata.parseFileHeader(fh.bytes) catch |e| return mapParse(e);
        const file_type = file_header.file_type orelse return error.Invalid;
        if (file_type != @intFromEnum(metadata.FileType.source_directory)) return error.NotDir;

        const fi = try readTable(&c, fields.FILE_INFORMATION, &buf);
        _ = metadata.parseFileInformation(fi.bytes) catch |e| return mapParse(e);

        var guard: usize = 0;
        while (true) {
            guard += 1;
            if (guard > MAX_FILE_DATA_TABLES) return error.Invalid;
            const t = try readTable(&c, null, &buf);
            if (t.fid.eql(fields.STREAM_HEADER)) {
                const sh = metadata.parseStreamHeader(t.bytes) catch |e| return mapParse(e);
                const stream_type = sh.stream_type orelse return error.Invalid;
                const stream_format = sh.stream_format orelse return error.Invalid;
                const stream_size = sh.stream_size orelse return error.Invalid;
                if (stream_type == @intFromEnum(metadata.StreamType.data) and
                    stream_format == @intFromEnum(metadata.StreamFormat.clear_data))
                {
                    return index.ChunkView.init(
                        self.reader,
                        t.end,
                        @intCast(stream_size),
                        self.sector_size,
                        self.fs_header_sector,
                    ) catch |e| return mapParse(e);
                }
                // A different stream: skip its payload and trailer (13.15.7).
                c.off = t.end + stream_size;
                _ = try readTable(&c, fields.STREAM_TRAILER, &buf);
                continue;
            }
            if (t.fid.eql(fields.SOURCE_DIRECTORY_TRAILER) or
                t.fid.eql(fields.SOURCE_FILE_TRAILER))
            {
                return error.NotFound; // no child-index Stream (§11)
            }
            // Source directory/file header, Path, Characteristics, anything
            // else: nothing the descent needs; the read already validated it.
        }
    }
};

/// Decode STREAM COMPRESS TYPE (`#8005`, 13.15.7.1) as the PKWARE APPNOTE
/// method id. `null` means the field was absent (Clear data, Annex C #2C).
fn decodeCompressType(data: ?[]const u8) WalkError!?u16 {
    const bytes = data orelse return null;
    if (bytes.len == 0 or bytes.len > 8) return error.Invalid;
    const v = fields.readUintLe(bytes);
    if (v > 0xFFFF) return error.Invalid;
    return @intCast(v);
}

/// The integer value of field `fid` in an already-read Field Table, or null.
fn tableUint(table: []const u8, fid: fields.Fid) ?u64 {
    var c = fields.Cursor{ .buf = table, .pos = 0 };
    while (fields.nextField(&c) catch null) |f| {
        if (f.fid.eql(fid)) return fields.readUintLe(f.data);
    }
    return null;
}

fn divCeil(n: u64, d: u32) u32 {
    return @intCast((n + d - 1) / d);
}

fn mapParse(e: errors.ParseError) WalkError {
    return switch (e) {
        error.Invalid => error.Invalid,
        error.Truncated => error.Truncated,
    };
}

const Cursor = struct {
    reader: block.BlockReader,
    off: u64,

    fn take(self: *Cursor, n: usize) WalkError![]const u8 {
        const bytes = self.reader.read(self.off, n) catch |e| return mapParse(e);
        self.off += n;
        return bytes;
    }
};

const FieldScan = struct {
    fid: fields.Fid,
    /// The field's data — a slice of the assembler buffer.
    data: []const u8,
    /// Bit-data fields carry their value in the length byte (Annex B.3).
    bits: ?u8,
    /// Bytes this field occupied, including FID and length part.
    raw_len: usize,
};

/// Read one Field exactly — never a byte beyond it (10.4; Annex A/B).
fn readField(c: *Cursor, raw: []u8) WalkError!FieldScan {
    var pos: usize = 0;

    const b0 = (try c.take(1))[0];
    if (pos >= raw.len) return error.Invalid;
    raw[pos] = b0;
    pos += 1;

    var fid_bytes: [4]u8 = undefined;
    fid_bytes[0] = b0;
    var need: usize = 1;
    if (b0 & 0x80 != 0) {
        if (b0 & 0x40 == 0) {
            const b1 = (try c.take(1))[0];
            if (pos >= raw.len) return error.Invalid;
            raw[pos] = b1;
            pos += 1;
            fid_bytes[1] = b1;
            need = if (b1 & 0x80 == 0) 2 else 3;
        } else {
            const b1 = (try c.take(1))[0];
            if (pos >= raw.len) return error.Invalid;
            raw[pos] = b1;
            pos += 1;
            const b2 = (try c.take(1))[0];
            if (pos >= raw.len) return error.Invalid;
            raw[pos] = b2;
            pos += 1;
            fid_bytes[1] = b1;
            fid_bytes[2] = b2;
            need = if (b2 & 0x80 != 0) 4 else 3;
        }
    }
    while (pos < need) {
        const b = (try c.take(1))[0];
        if (pos >= raw.len) return error.Invalid;
        raw[pos] = b;
        pos += 1;
        fid_bytes[pos - 1] = b;
    }
    var code: u32 = 0;
    for (fid_bytes[0..need]) |b| code = (code << 8) | b;
    const fid = fields.Fid{ .code = code, .len = @intCast(need) };

    // 10.4.1: the NULL Field is only its FID.
    if (fid.len == 1 and fid.code == 0) {
        return .{ .fid = fid, .data = &.{}, .bits = null, .raw_len = pos };
    }

    if (fields.fixedLen(fid)) |w| {
        const n: usize = @intCast(w);
        const data = try c.take(n);
        if (pos + n > raw.len) return error.Invalid;
        @memcpy(raw[pos .. pos + n], data);
        return .{ .fid = fid, .data = raw[pos .. pos + n], .bits = null, .raw_len = pos + n };
    }

    const lead = (try c.take(1))[0];
    if (pos >= raw.len) return error.Invalid;
    raw[pos] = lead;
    pos += 1;

    if (lead & 0x80 == 0) {
        const n: usize = lead;
        const data = try c.take(n);
        if (pos + n > raw.len) return error.Invalid;
        @memcpy(raw[pos .. pos + n], data);
        return .{ .fid = fid, .data = raw[pos .. pos + n], .bits = null, .raw_len = pos + n };
    }
    if (lead & 0xC0 == 0x80) {
        const nb: usize = @as(usize, 1) << @intCast(lead & 0x03);
        const num = try c.take(nb);
        if (pos + nb > raw.len) return error.Invalid;
        @memcpy(raw[pos .. pos + nb], num);
        pos += nb;
        const len = fields.readUintLe(num);
        if (len > 0xFFFF_FFFF) return error.Invalid;
        const n: usize = @intCast(len);
        const data = try c.take(n);
        if (pos + n > raw.len) return error.Invalid;
        @memcpy(raw[pos .. pos + n], data);
        return .{ .fid = fid, .data = raw[pos .. pos + n], .bits = null, .raw_len = pos + n };
    }
    // Annex B.3: Bit Data — the value is the length byte, no data part.
    return .{ .fid = fid, .data = &.{}, .bits = lead & 0x3F, .raw_len = pos };
}

const TableScan = struct {
    fid: fields.Fid,
    bytes: []u8,
    end: u64,
};

/// Read one Field Table exactly (field by field) and assemble its bytes so the
/// `metadata` parsers can validate it. `expect` fixes the table's FID; `null`
/// takes the first field's FID as the header (10.5).
fn readTable(c: *Cursor, expect: ?fields.Fid, buf: []u8) WalkError!TableScan {
    var len: usize = 0;
    var header_fid: fields.Fid = undefined;
    var n: usize = 0;
    while (true) : (n += 1) {
        if (n > Walker.MAX_FIELDS) return error.Invalid;
        const f = try readField(c, buf[len..]);
        len += f.raw_len;
        if (n == 0) {
            if (expect) |e| {
                if (!f.fid.eql(e)) return error.Invalid;
            }
            header_fid = f.fid;
            // The opening Field carries the Resynchronization Pattern (10.5, 6.23).
            if (f.bits != null or f.data.len != 2 or !std.mem.eql(u8, f.data, &fields.RESYNC_BYTES)) {
                return error.Invalid;
            }
        } else if (f.fid.eql(header_fid)) {
            return .{ .fid = header_fid, .bytes = buf[0..len], .end = c.off };
        }
    }
}

const Normalized = struct {
    count: usize,
    trailing_slash: bool,
};

/// POSIX-style lexical normalization (§6.8): '/' separators, "" and "."
/// skipped, ".." pops and may not escape the root, trailing '/' asserts a
/// directory. NUL bytes and over-long components are rejected.
fn normalize(path: []const u8, comps: *[Walker.MAX_COMPONENTS][]const u8) WalkError!Normalized {
    var count: usize = 0;
    var i: usize = 0;
    while (i < path.len) {
        var j = i;
        while (j < path.len and path[j] != '/') : (j += 1) {}
        const comp = path[i..j];
        if (comp.len == 0 or std.mem.eql(u8, comp, ".")) {
            // skip
        } else if (std.mem.eql(u8, comp, "..")) {
            if (count == 0) return error.Invalid; // would escape the root
            count -= 1;
        } else {
            for (comp) |ch| {
                if (ch == 0) return error.Invalid;
            }
            if (comp.len > 0xFFFF) return error.Invalid;
            if (count == Walker.MAX_COMPONENTS) return error.Invalid;
            comps[count] = comp;
            count += 1;
        }
        i = j + 1;
    }
    return .{
        .count = count,
        .trailing_slash = path.len > 0 and path[path.len - 1] == '/',
    };
}

// ---------------------------------------------------------------------------
// Tests for the pieces that do not need a fixture
// ---------------------------------------------------------------------------

const testing = std.testing;

test "path normalization skips separators and dots, pops .., flags trailing slash" {
    var comps: [Walker.MAX_COMPONENTS][]const u8 = undefined;
    {
        const n = try normalize("a/b/c", &comps);
        try testing.expectEqual(@as(usize, 3), n.count);
        try testing.expectEqualStrings("a", comps[0]);
        try testing.expectEqualStrings("c", comps[2]);
        try testing.expect(!n.trailing_slash);
    }
    {
        const n = try normalize("/a//./b/", &comps);
        try testing.expectEqual(@as(usize, 2), n.count);
        try testing.expect(n.trailing_slash);
    }
    {
        const n = try normalize("a/b/../d", &comps);
        try testing.expectEqual(@as(usize, 2), n.count);
        try testing.expectEqualStrings("d", comps[1]);
    }
    {
        const n = try normalize("a/..", &comps);
        try testing.expectEqual(@as(usize, 0), n.count);
    }
    try testing.expectError(error.Invalid, normalize("..", &comps));
    try testing.expectError(error.Invalid, normalize("a/../..", &comps));
    try testing.expectError(error.Invalid, normalize("a\x00b", &comps));
}

test "walk error codes match the ABI table" {
    try testing.expectEqual(@as(i32, -2), errnoFor(error.NotFound));
    try testing.expectEqual(@as(i32, -20), errnoFor(error.NotDir));
    try testing.expectEqual(@as(i32, -21), errnoFor(error.IsDir));
    try testing.expectEqual(@as(i32, -22), errnoFor(error.Invalid));
    try testing.expectEqual(@as(i32, -5), errnoFor(error.Truncated));
}
