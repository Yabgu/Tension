//! The packer — DESIGN.md §8.2.
//!
//! A build-time tool: it walks a source directory, lays out an ECMA-208 (SIDF)
//! volume, and writes it. The runtime never comes through here.
//!
//! Three passes, because the format does not allow fewer: FILE CHUNK SIZE
//! (13.12) and BUFFER SIZE (13.7) are fields whose values are only known once
//! the layout exists, and a directory's child-index Stream contains its
//! children's physical positions. So: walk → plan (measure, place, patch) →
//! write (emit, patch, verify).
//!
//! Byte-identity with `test/fixtures/generate.zig` is a test, not an accident:
//! this module mirrors that generator's tables, field order, widths, padding
//! and conventions exactly (see §8.2), so packing the fixture's source tree
//! reproduces `minimal.sidf` byte for byte.

const std = @import("std");
const errors = @import("errors.zig");
const fields = @import("fields.zig");
const metadata = @import("metadata.zig");
const index = @import("index.zig");
const flate = std.compress.flate;

/// 10.1: SECTOR SIZE is 2^(n+8); 512 is what this packer records.
pub const SECTOR: usize = 512;
/// Floor for BUFFER SIZE (13.7).
pub const MIN_BUFFER: usize = 2048;
/// Sanity bound for BUFFER SIZE. Payloads larger than this are not refused —
/// they span Buffers (§8.3); only a *header* extent this large is an error.
pub const MAX_BUFFER: usize = 16 * 1024 * 1024;
/// Upper bound on a single File's chunk count (§8.3). With a 512-byte Buffer
/// that is a 2 GiB File; the tighter limit is DATA STREAM SIZE's 4-byte field.
pub const MAX_CHUNKS: usize = 4096 * 1024;

/// Recursion cap, so a symlink cycle is an error rather than a hang.
pub const MAX_DEPTH: usize = 64;
/// 13.3 Blank Space FT: header (6) + OFFSET TO END (4) + closing field (4).
const BLANK_OVERHEAD: usize = 14;
/// 13.7 FILE SET ID, "TENS" as recorded by the fixture generator.
pub const FILE_SET_ID: u32 = 0x54454E53;
const LABEL = "TENSION";
const SOURCE_OS = "TENSION";
const SOURCE_OS_VERSION = "0.1.0";
/// §8.2: the child-index Stream's chunk payload starts here and doubles.
pub const INDEX_CHUNK_MIN: u32 = 512;
pub const INDEX_CHUNK_MAX: u32 = 65536;
/// NS1 names are length-limited by the index format (u16) and by the walker.
pub const MAX_NAME: usize = 0xFFFF;

pub const PackError = error{
    /// The image buffer handed to `writeLayout` was too small — a layout bug,
    /// so it reports the same way a violated invariant does.
    NoSpace,
    NotFound,
    NotDir,
    IsDir,
    AccessDenied,
    OutOfMemory,
    InvalidValue,
    NameTooLong,
    TooDeep,
    IoRead,
    IoWrite,
    Truncated,
    Invalid,
};

/// The ABI mapping for a pack failure (§7.7's table, plus EACCES).
pub fn errnoFor(e: PackError) i32 {
    return switch (e) {
        error.NotFound => errors.ENOENT,
        error.NotDir => errors.ENOTDIR,
        error.IsDir => errors.EISDIR,
        error.AccessDenied => -13, // EACCES
        error.OutOfMemory => errors.ENOMEM,
        error.InvalidValue, error.NameTooLong, error.TooDeep, error.NoSpace => errors.EINVAL,
        error.IoRead, error.IoWrite, error.Truncated, error.Invalid => errors.EIO,
    };
}

pub const Kind = enum { file, directory };

pub const Node = struct {
    /// NS1 basename, exactly as it appears in the source directory.
    name: []const u8,
    /// Where the bytes live now (a file's payload is streamed from here).
    source_path: []const u8,
    kind: Kind,
    parent: u32,
    first_child: u32 = 0,
    child_count: u32 = 0,
    /// Payload bytes: a file's length, a directory's index Stream length.
    /// For a compressed File this stays the *expanded* size — it is what the
    /// child-index entry records (§6.7) and what the guest sees.
    size: u64 = 0,
    // -- compression (§8.4) --
    /// Payload bytes as stored: the Deflate stream's length when `method` is
    /// 8, otherwise `size`. Everything that measures or plans a File's bytes
    /// in the volume uses this, never `size`.
    stored_size: u64 = 0,
    /// PKWARE method id: 0 stored, 8 Deflate (APPNOTE). Mirrors the Data
    /// Stream's STREAM COMPRESS TYPE (#8005, 13.15.7.1).
    method: u16 = 0,
    /// The Deflate stream itself, kept from the pass that decided compression
    /// until the write pass emits it.
    compressed: ?[]u8 = null,
    // -- layout (§8.2) --
    record_len: u32 = 0,
    file_off: u64 = 0,
    buffer_index: u32 = 0,
    /// Fixed record bytes before the payload (File Header FT … Stream Header
    /// FT) and after it (Stream Trailer FT, Source file/directory Trailer FT).
    head_len: u32 = 0,
    tail_len: u32 = 0,
    /// Multi-chunk Files (§8.3): one entry per chunk, in order. Empty for the
    /// single-chunk Files that make up all but the largest payloads.
    chunks: []Chunk = &.{},
    /// The location pair a child-index entry records (§11.1 ruling 4): the
    /// sector that holds this File's File Header (counted from the File Set
    /// Header, first = 1) and the byte offset inside that sector. The reader
    /// reconstructs the absolute position as
    /// `(1 + buffer_address) * SECTOR + buffer_offset`, so these two must be
    /// derived from `file_off` together — never from a Buffer-relative
    /// offset, which folds whole sectors into the wrong field.
    buffer_address: u32 = 0,
    buffer_offset: u32 = 0,
    // -- child index (directories) --
    index_bytes: []u8 = &.{},
    index_len: u32 = 0,
    index_chunk_payload: u32 = 0,
    /// Stream offsets of each child's entry, in the child order.
    index_offsets: []u32 = &.{},
    /// Absolute offset of the index Stream's first byte inside the record.
    index_file_off: u32 = 0,
};

/// One chunk of a multi-chunk File (§8.3). Chunk 0 is the File Header FT with
/// FILE CHUNK SIZE (13.12); every later chunk opens its Buffer with a File
/// Continuation Header FT carrying FILE CHUNK SIZE (13.13).
pub const Chunk = struct {
    /// File Space bytes recorded in this chunk — the value of FILE CHUNK SIZE.
    chunk_size: u32,
    /// Payload bytes this chunk carries.
    payload_len: u32,
    file_off: u64,
    buffer_index: u32,
    buffer_address: u32,
    buffer_offset: u32,
};

pub const BufferInfo = struct {
    start: u64,
    used: u32,
};

pub const Layout = struct {
    buffer_size: u32,
    buffer_count: u32,
    fs_header_sectors: u32,
    trailer_off: u64,
    image_len: u64,
    buffers: []BufferInfo,
};

pub const Tree = struct {
    alloc: std.mem.Allocator,
    nodes: []Node,
    count: usize = 0,
    /// Node ids in placement order (pre-order, children in NS1 order).
    order: []u32 = &.{},
    order_len: usize = 0,
};

pub const Stats = struct {
    files: usize = 0,
    directories: usize = 0,
    bytes: u64 = 0,
};

/// Progress sink for the verbose frontend; `tension_res_pack` passes none.
pub const Progress = struct {
    ctx: *anyopaque,
    on_directory: *const fn (ctx: *anyopaque, path: []const u8, children: usize) void,

};

// ---------------------------------------------------------------------------
// 1. Walk
// ---------------------------------------------------------------------------

/// Traverse `source_dir` into a tree. Symlinks are resolved at pack time (a
/// dangling one is `error.NotFound`); non-regular files are skipped.
pub fn walkSource(alloc: std.mem.Allocator, source_dir: []const u8) PackError!Tree {
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    return walkSourceWith(alloc, threaded.io(), source_dir, null);
}

pub fn walkSourceWith(
    alloc: std.mem.Allocator,
    io: std.Io,
    source_dir: []const u8,
    progress: ?Progress,
) PackError!Tree {
    var tree = Tree{ .alloc = alloc, .nodes = try alloc.alloc(Node, 16) };
    const base = std.fs.path.basename(source_dir);
    if (base.len == 0 or base.len > MAX_NAME) return error.NameTooLong;
    const root_name = try dupe(alloc, base);
    const root_path = try dupe(alloc, source_dir);
    _ = try walkDir(&tree, io, root_path, root_name, null, 0, progress);
    tree.order = try alloc.alloc(u32, tree.count);
    tree.order_len = 0;
    try preorder(&tree, 0);
    return tree;
}

fn preorder(tree: *Tree, id: u32) PackError!void {
    tree.order[tree.order_len] = id;
    tree.order_len += 1;
    const n = &tree.nodes[id];
    var i: u32 = 0;
    while (i < n.child_count) : (i += 1) try preorder(tree, n.first_child + i);
}

/// `walkDir` adds the directory's own node; `walkChildren` fills it in. The
/// split matters: a child directory must be added *once*, by its parent, and
/// then recursed into — adding it again in the recursion would double every
/// subtree.
fn walkDir(
    tree: *Tree,
    io: std.Io,
    path: []const u8,
    name: []const u8,
    parent: ?u32,
    depth: usize,
    progress: ?Progress,
) PackError!u32 {
    const id = try addNode(tree, .{
        .name = name,
        .source_path = path,
        .kind = .directory,
        .parent = parent orelse 0,
    });
    try walkChildren(tree, io, id, path, depth, progress);
    return id;
}

fn walkChildren(
    tree: *Tree,
    io: std.Io,
    dir_id: u32,
    path: []const u8,
    depth: usize,
    progress: ?Progress,
) PackError!void {
    if (depth > MAX_DEPTH) return error.TooDeep;

    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch |e| return mapFsError(e);
    defer dir.close(io);

    // Collect the children first: they must be added consecutively (§8.2),
    // and in NS1 byte order (§8.1 invariant 6). The arena owns the list.
    var kids: std.ArrayList(Child) = .empty;
    var it = dir.iterate();
    while (it.next(io) catch |e| return mapFsError(e)) |entry| {
        const stat = dir.statFile(io, entry.name, .{}) catch |e| return mapFsError(e);
        const kind: Kind = switch (stat.kind) {
            .file => .file,
            .directory => .directory,
            // Symlinks are already resolved by statFile; anything else here is
            // not a regular file or directory, so it is skipped (§8.2).
            else => continue,
        };
        try kids.append(tree.alloc, .{
            .name = try dupe(tree.alloc, entry.name),
            .kind = kind,
            .size = if (kind == .file) stat.size else 0,
            .path = try joinPath(tree.alloc, path, entry.name),
        });
    }
    std.mem.sort(Child, kids.items, {}, lessThanChild);
    if (progress) |p| p.on_directory(p.ctx, path, kids.items.len);

    const ids = try tree.alloc.alloc(u32, kids.items.len);
    for (kids.items, 0..) |kid, i| {
        ids[i] = try addNode(tree, .{
            .name = kid.name,
            .source_path = kid.path,
            .kind = kid.kind,
            .parent = dir_id,
            .size = kid.size,
        });
    }
    // Recurse only after every direct child has an id, so children stay
    // contiguous (the reader's descent uses first_child/child_count).
    for (kids.items, 0..) |kid, i| {
        if (kid.kind == .directory) {
            try walkChildren(tree, io, ids[i], kid.path, depth + 1, progress);
        }
    }
}

const Child = struct {
    name: []const u8,
    path: []const u8,
    kind: Kind,
    size: u64,
};

fn lessThanChild(_: void, a: Child, b: Child) bool {
    return std.mem.lessThan(u8, a.name, b.name);
}

fn addNode(tree: *Tree, node: Node) PackError!u32 {
    if (tree.count == tree.nodes.len) {
        tree.nodes = try tree.alloc.realloc(tree.nodes, tree.nodes.len * 2 + 16);
    }
    const id: u32 = @intCast(tree.count);
    tree.nodes[id] = node;
    if (node.parent != id and tree.count > 0 and node.parent < tree.count) {
        const p = &tree.nodes[node.parent];
        if (p.child_count == 0) p.first_child = id;
        p.child_count += 1;
    }
    tree.count += 1;
    return id;
}

fn dupe(alloc: std.mem.Allocator, bytes: []const u8) PackError![]const u8 {
    const out = try alloc.alloc(u8, bytes.len);
    @memcpy(out, bytes);
    return out;
}

fn joinPath(alloc: std.mem.Allocator, dir: []const u8, name: []const u8) PackError![]const u8 {
    const sep: usize = if (dir.len > 0 and dir[dir.len - 1] == '/') 0 else 1;
    const out = try alloc.alloc(u8, dir.len + sep + name.len);
    @memcpy(out[0..dir.len], dir);
    if (sep == 1) out[dir.len] = '/';
    @memcpy(out[dir.len + sep ..], name);
    return out;
}

// ---------------------------------------------------------------------------
// 2. Plan
// ---------------------------------------------------------------------------

pub fn planLayout(alloc: std.mem.Allocator, tree: *Tree) PackError!Layout {
    if (tree.count == 0) return error.InvalidValue;

    // (a) Child-index Streams, with placeholder locations (§6.7).
    for (tree.nodes[0..tree.count]) |*n| {
        if (n.kind != .directory) continue;
        try buildIndex(alloc, tree, n);
    }

    // (b) Record lengths: write each record with an empty payload and add the
    // payload length, so a File Space is measured without materialising it.
    // The same measurement yields a directory's index Stream offset inside the
    // record, which the chunk-position patch below needs.
    var scratch = try alloc.alloc(u8, 256);
    for (tree.nodes[0..tree.count]) |*n| {
        const need = 256 + 2 * n.name.len;
        if (need > scratch.len) scratch = try alloc.realloc(scratch, need);
        const m = try measureRecord(scratch, n);
        const payload: usize = if (n.kind == .directory) n.index_len else @intCast(n.stored_size);
        // 13.14 DATA STREAM SIZE and 13.12/13.13 FILE CHUNK SIZE are 4-byte
        // counts, so a File's payload must fit in one.
        if (@as(u64, m.len) + payload > 0xFFFF_FFFF) return error.InvalidValue;
        n.record_len = @intCast(m.len + payload);
        if (n.kind == .directory) n.index_file_off = m.payload_off;
        n.head_len = m.payload_off;
        n.tail_len = @intCast(m.len - m.payload_off);
    }

    // (c) Buffer size: uniform, a sector multiple, big enough for the largest
    // File Space plus its Buffer Header and the closing Blank Space (§8.2).
    var bh_scratch: [256]u8 = undefined;
    var bh_w = fields.Writer{ .buf = &bh_scratch };
    try writeBufferHeader(&bh_w, MIN_BUFFER, 1, 1, 0);
    const bh_len = bh_w.len;

    // §8.3: a Buffer must hold a chunk's headers plus as much payload as fits,
    // so the sizing requirement is the *header* extent of the largest File —
    // never its payload. A payload that does not fit simply spans Buffers.
    var max_needed_record: usize = 0;
    for (tree.nodes[0..tree.count]) |n| {
        // Directories never span Buffers, so their whole record must fit. A
        // file only needs room for a chunk's headers plus some payload — any
        // payload that does not fit becomes another chunk (§8.3).
        const headers = @as(usize, n.head_len) + n.tail_len;
        const need = if (n.kind == .directory) @as(usize, n.record_len) else headers + BLANK_OVERHEAD;
        max_needed_record = @max(max_needed_record, need);
    }
    const needed = max_needed_record + bh_len + BLANK_OVERHEAD;
    if (needed > MAX_BUFFER) return error.InvalidValue;
    var buffer_size: usize = MIN_BUFFER;
    while (buffer_size < needed) buffer_size *= 2;
    if (buffer_size % SECTOR != 0) buffer_size = (buffer_size / SECTOR + 1) * SECTOR;

    // (d) Placement, in the tree's order (§8.2).
    var buffers: std.ArrayList(BufferInfo) = .empty;
    const buf_start: u64 = @as(u64, 2) * SECTOR; // the File Set Header occupies 1 sector
    var current: ?usize = null;
    var previous_was_directory = true; // the root starts the first Buffer
    var i: usize = 0;
    while (i < tree.order_len) : (i += 1) {
        const n = &tree.nodes[tree.order[i]];

        // §8.3: a leaf File too large for one Buffer becomes a chain of chunks,
        // each of which starts a fresh Buffer.
        // A single-chunk File must leave its Buffer with either no room at all
        // (exactly full — nothing for a Blank Space FT to record, 13.3) or
        // room for one. Sizes in between only exist as multi-chunk, so they
        // are the 9a.5 refusal.
        // A File that cannot leave its Buffer either exactly full or with room
        // for a Blank Space FT (13.3) only exists as a multi-chunk File: it
        // spans Buffers. (9a.5's refusal lived here; 9c removed it once the VFS
        // could read a chain — §8.3.)
        const need: u64 = @as(u64, bh_len) + n.record_len;
        const must_chunk = n.kind == .file and need != buffer_size and
            need + BLANK_OVERHEAD > buffer_size;
        if (must_chunk) {
            n.chunks = try planChunks(alloc, n, buffer_size, bh_len, continuationLen());
            const base = buffers.items.len;
            for (n.chunks) |chunk| {
                try buffers.append(alloc, .{
                    .start = buf_start + @as(u64, buffers.items.len) * buffer_size,
                    .used = @intCast(bh_len),
                });
                _ = chunk;
            }
            var k: usize = 0;
            while (k < n.chunks.len) : (k += 1) {
                const b = &buffers.items[base + k];
                const at = b.used; // the chunk starts right after the Buffer Header FT
                n.chunks[k].buffer_index = @intCast(base + k);
                n.chunks[k].file_off = b.start + at;
                n.chunks[k].buffer_address = @intCast(n.chunks[k].file_off / SECTOR - 1);
                n.chunks[k].buffer_offset = @intCast(n.chunks[k].file_off % SECTOR);
                b.used += n.chunks[k].chunk_size;
            }
            // The chain's first chunk is where a child-index entry points.
            n.file_off = n.chunks[0].file_off;
            n.buffer_address = n.chunks[0].buffer_address;
            n.buffer_offset = n.chunks[0].buffer_offset;
            n.buffer_index = n.chunks[0].buffer_index;
            for (n.chunks) |chunk| {
                if (buffers.items[chunk.buffer_index].used > buffer_size) return error.InvalidValue;
            }
            previous_was_directory = false;
            current = null; // the next File starts its own Buffer
            continue;
        }

        // §8.2: a Source directory File always starts a new Buffer and is the
        // only File in it — `previous_was_directory` is what keeps leaf Files
        // from being packed after one.
        const fresh = current == null or previous_was_directory or
            @as(u64, buffers.items[current.?].used) + n.record_len + BLANK_OVERHEAD > buffer_size;
        if (fresh) {
            // `used` counts the Buffer Header from the start: it is part of the
            // Buffer (13.4), and UNUSED IN THIS BUFFER is what is left after
            // the Files and their Blank Space.
            try buffers.append(alloc, .{
                .start = buf_start + @as(u64, buffers.items.len) * buffer_size,
                .used = @intCast(bh_len),
            });
            current = buffers.items.len - 1;
        }
        previous_was_directory = n.kind == .directory;
        const b = &buffers.items[current.?];
        n.buffer_index = @intCast(current.?);
        n.file_off = b.start + b.used;
        n.buffer_address = @intCast(n.file_off / SECTOR - 1);
        n.buffer_offset = @intCast(n.file_off % SECTOR);
        b.used += n.record_len;
    }
    const buffer_count: u32 = @intCast(buffers.items.len);
    const trailer_off = buf_start + @as(u64, buffer_count) * buffer_size;
    const image_len = trailer_off + SECTOR;

    // (e) Patch: index chunk positions and every child's location.
    for (tree.nodes[0..tree.count]) |*n| {
        if (n.kind != .directory) continue;
        const h = try index.parseHeader(n.index_bytes);
        var k: u32 = 0;
        while (k < h.chunk_count) : (k += 1) {
            const abs = n.file_off + n.index_file_off + @as(u64, k) * h.chunk_payload;
            try index.setChunkPosition(n.index_bytes, h, k, @intCast(abs / SECTOR - 1), @intCast(abs % SECTOR));
        }
        var c: u32 = 0;
        while (c < n.child_count) : (c += 1) {
            const kid = tree.nodes[n.first_child + c];
            const at: usize = n.index_offsets[c];
            fields.writeUintLe(n.index_bytes[at + 10 ..][0..4], kid.buffer_address);
            fields.writeUintLe(n.index_bytes[at + 14 ..][0..4], kid.buffer_offset);
        }
    }

    return .{
        .buffer_size = @intCast(buffer_size),
        .buffer_count = buffer_count,
        .fs_header_sectors = 1,
        .trailer_off = trailer_off,
        .image_len = image_len,
        .buffers = buffers.items,
    };
}

/// Split a leaf File's payload into chunks (§8.3). Pure function of the payload
/// size and the Buffer size: fill every non-final chunk to the Buffer, letting
/// the last chunk take the remainder plus the File's trailers, and always leave
/// room for the closing Blank Space FT (13.3) — so a chunk's buffer either ends
/// exactly at its data or has at least `BLANK_OVERHEAD` bytes to fill.
pub fn planChunks(
    alloc: std.mem.Allocator,
    n: *const Node,
    buffer_size: usize,
    bh_len: usize,
    cont_len: usize,
) PackError![]Chunk {
    var list: std.ArrayList(Chunk) = .empty;
    const payload = n.stored_size;
    if (payload > 0xFFFF_FFFF) return error.InvalidValue;
    const bh_bytes: u64 = @intCast(bh_len);
    const buf_bytes: u64 = @intCast(buffer_size);
    const tail: u64 = n.tail_len;

    var remaining: u64 = payload;
    var first = true;
    var guard: usize = 0;
    while (true) {
        guard += 1;
        if (guard > MAX_CHUNKS) return error.InvalidValue;
        const header_len: u64 = if (first) n.head_len else cont_len;
        const capacity = buf_bytes - bh_bytes - header_len;
        if (capacity == 0) return error.InvalidValue;
        if (remaining + tail + BLANK_OVERHEAD <= capacity) {
            try list.append(alloc, .{
                .chunk_size = @intCast(header_len + remaining + tail),
                .payload_len = @intCast(remaining),
                .file_off = 0,
                .buffer_index = 0,
                .buffer_address = 0,
                .buffer_offset = 0,
            });
            break;
        }
        // Not the last chunk: fill this Buffer with payload. A Buffer must end
        // either exactly at its data or with room for a Blank Space FT (13.3,
        // BLANK_OVERHEAD) — never with 1..BLANK_OVERHEAD-1 bytes left, which no
        // Blank Space FT can describe and `padWithBlankSpace` refuses. So a
        // fill that would leave such a gap stops short by that much, and the
        // final chunk takes those bytes along with the trailers.
        //
        // Filling the Buffer *exactly* is left alone: the trailers then open a
        // payload-less chunk of their own, which the chain walk accepts (§8.3),
        // and which is what keeps an exactly-Buffer-sized File single-chunk.
        var take = @min(capacity, remaining);
        if (take < capacity and capacity - take < BLANK_OVERHEAD) {
            if (capacity <= BLANK_OVERHEAD) return error.InvalidValue;
            take = capacity - BLANK_OVERHEAD;
        }
        if (take == 0) return error.InvalidValue;
        try list.append(alloc, .{
            .chunk_size = @intCast(header_len + take),
            .payload_len = @intCast(take),
            .file_off = 0,
            .buffer_index = 0,
            .buffer_address = 0,
            .buffer_offset = 0,
        });
        remaining -= take;
        first = false;
    }
    return list.items;
}

/// The File Continuation Header FT's length (13.13): FILE CONTINUATION HEADER
/// + FILE CHUNK SIZE + the closing FILE CONTINUATION HEADER.
fn continuationLen() usize {
    var scratch: [64]u8 = undefined;
    var w = fields.Writer{ .buf = &scratch };
    w.tableHeader(fields.FILE_CONTINUATION_HEADER) catch return 0;
    w.field(fields.FILE_CHUNK_SIZE, &.{ 0, 0, 0, 0 }) catch return 0;
    w.tableEnd(fields.FILE_CONTINUATION_HEADER) catch return 0;
    return w.len;
}

/// A chunk's File Continuation Header FT (13.13), recorded immediately after
/// the Buffer Header FT. Public because the tests build chains with the
/// writer's own emission path rather than a hand-rolled copy of the layout.
pub fn writeContinuationHeader(w: *fields.Writer, chunk_size: u32) PackError!void {
    try w.tableHeader(fields.FILE_CONTINUATION_HEADER);
    try w.field(fields.FILE_CHUNK_SIZE, &u32bytes(chunk_size));
    try w.tableEnd(fields.FILE_CONTINUATION_HEADER);
}

fn buildIndex(alloc: std.mem.Allocator, tree: *Tree, n: *Node) PackError!void {
    const children = try alloc.alloc(index.Child, n.child_count);
    var i: u32 = 0;
    while (i < n.child_count) : (i += 1) {
        const kid = tree.nodes[n.first_child + i];
        children[i] = .{
            .name = kid.name,
            .kind = if (kid.kind == .directory) .directory else .file,
            .size = if (kid.kind == .file) @intCast(kid.size) else 0,
            // §8.4: the entry's half of the compression record — the method id
            // the runtime reads without opening the stream. `index.zig` derives
            // the entry's flags bit 0 from it, so a stored File gets 0/0.
            .compression_method = if (kid.kind == .file) kid.method else 0,
            .volume_set_sequence = 1,
            .buffer_address = 0, // patched in step (e)
            .buffer_offset = 0,
        };
    }

    // §8.1 invariant 1 / §8.2: grow the chunk payload until `plan` accepts it.
    var payload = INDEX_CHUNK_MIN;
    var plan: index.Plan = undefined;
    while (true) {
        if (index.plan(children, payload)) |ok| {
            plan = ok;
            break;
        } else |e| {
            if (e != error.InvalidValue) return error.InvalidValue;
            payload *= 2; // §8.2 growth rule
            if (payload > INDEX_CHUNK_MAX) return error.InvalidValue;
        }
    }

    const bytes = try alloc.alloc(u8, plan.stream_len);
    const order = try alloc.alloc(u32, n.child_count);
    const offsets = try alloc.alloc(u32, n.child_count);
    _ = index.write(children, order, offsets, bytes, payload) catch return error.InvalidValue;
    n.index_bytes = bytes;
    n.index_len = plan.stream_len;
    n.index_chunk_payload = payload;
    n.index_offsets = offsets;
}

// ---------------------------------------------------------------------------
// 3. Write
// ---------------------------------------------------------------------------

pub fn writeLayout(tree: *Tree, layout: Layout, image: []u8, io: std.Io) PackError!void {
    if (image.len < layout.image_len) return error.InvalidValue;
    var w = fields.Writer{ .buf = image };

    try writeVolumeHeader(&w);
    try padWithBlankSpace(&w, SECTOR);
    try writeFileSetHeader(&w, layout.buffer_size);
    try padWithBlankSpace(&w, 2 * SECTOR);

    var bi: usize = 0;
    while (bi < layout.buffer_count) : (bi += 1) {
        const b = layout.buffers[bi];
        const unused: u32 = @intCast(@as(u64, layout.buffer_size) - b.used);
        var bw = fields.Writer{ .buf = image[@intCast(b.start)..] };
        try writeBufferHeader(&bw, layout.buffer_size, @intCast(bi + 1), @intCast(b.start / SECTOR - 1), unused);
        if (bw.len != bhLen()) return error.InvalidValue;
    }
    // File Spaces, in placement order (each already knows its own offset).
    var i: usize = 0;
    while (i < tree.order_len) : (i += 1) {
        const n = &tree.nodes[tree.order[i]];
        if (n.kind == .file and n.chunks.len > 0) {
            try writeChunkedFile(image, n, io);
            continue;
        }
        var nw = fields.Writer{ .buf = image[@intCast(n.file_off)..] };
        const patch = try writeFileHeader(&nw, if (n.kind == .directory)
            @intFromEnum(metadata.FileType.source_directory)
        else
            @intFromEnum(metadata.FileType.file));
        // §8.2: the root records PARENT/PFQ = 1/1, everything else 0/0 — the
        // fixture generator's convention, kept byte for byte.
        const is_root = n == &tree.nodes[0];
        try writeFileInformation(
            &nw,
            if (is_root) 1 else 0,
            if (is_root) 1 else 0,
            n.name,
            if (n.kind == .directory) n.index_len else @intCast(n.stored_size),
        );
        if (n.kind == .directory) {
            _ = try writeDirectoryData(&nw, n.index_bytes, n.name, if (is_root) 1 else 0);
        } else {
            try writeFileData(&nw, io, n);
        }
        if (nw.len != n.record_len) return error.Invalid;
        fields.patchUintLe(image, @intCast(n.file_off + patch), nw.len, 4);
    }
    // Blank space fills the rest of every buffer.
    var bj: usize = 0;
    while (bj < layout.buffer_count) : (bj += 1) {
        const b = layout.buffers[bj];
        // A full Buffer has no room for a Blank Space FT (13.3) — and needs
        // none: blank space is what is left over.
        if (b.used == layout.buffer_size) continue;
        var bw = fields.Writer{ .buf = image[@intCast(b.start)..] };
        try bw.skip(b.used);
        try padWithBlankSpace(&bw, layout.buffer_size);
    }

    var tw = fields.Writer{ .buf = image[@intCast(layout.trailer_off)..] };
    try writeFileSetTrailer(&tw);
    try padWithBlankSpace(&tw, SECTOR);
    if (@as(u64, layout.trailer_off) + tw.len != layout.image_len) return error.Invalid;
}

/// The whole tool: walk, plan, write, and put the bytes on disk.
pub fn pack(
    alloc: std.mem.Allocator,
    source_dir: []const u8,
    out_path: []const u8,
    progress: ?Progress,
) PackError!Stats {
    var arena_state = std.heap.ArenaAllocator.init(alloc);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var tree = try walkSourceWith(a, io, source_dir, progress);
    try compressPayloads(a, io, &tree);
    const layout = try planLayout(a, &tree);
    const image = try a.alloc(u8, @intCast(layout.image_len));
    try writeLayout(&tree, layout, image, io);

    std.Io.Dir.cwd().writeFile(io, .{ .sub_path = out_path, .data = image }) catch |e| return mapFsError(e);

    var stats = Stats{ .bytes = layout.image_len };
    for (tree.nodes[0..tree.count]) |n| {
        switch (n.kind) {
            .file => stats.files += 1,
            .directory => stats.directories += 1,
        }
    }
    return stats;
}

// ---------------------------------------------------------------------------
// Tables (mirrors test/fixtures/generate.zig, byte for byte)
// ---------------------------------------------------------------------------

const OtePatch = struct { pos: usize };

/// OFFSET TO END ("bytes from start of next Field to start of last Field",
/// 13.1/13.3/13.4/13.7/13.9) is only known once the table is complete.
fn writeOte(w: *fields.Writer) PackError!OtePatch {
    try w.field(fields.OFFSET_TO_END, &.{ 0, 0 });
    return .{ .pos = w.len - 2 };
}

fn endTable(w: *fields.Writer, header: fields.Fid, ote: OtePatch) PackError!void {
    const closing_start = w.len;
    try w.tableEnd(header);
    const value = closing_start - (ote.pos + 2);
    if (value > 0xFFFF) return error.InvalidValue;
    fields.patchUintLe(w.buf, ote.pos, value, 2);
}

/// Blank Space Field Table (13.3) to `end`: BLANK SPACE, OFFSET TO END, NULL
/// Fields, BLANK SPACE.
fn padWithBlankSpace(w: *fields.Writer, end: usize) PackError!void {
    if (end < w.len or end - w.len < BLANK_OVERHEAD) return error.InvalidValue;
    const remain = end - w.len;
    try w.tableHeader(fields.BLANK_SPACE);
    const ote = try writeOte(w);
    var i: usize = BLANK_OVERHEAD;
    while (i < remain) : (i += 1) try w.appendByte(fields.NULL_BYTE);
    try endTable(w, fields.BLANK_SPACE, ote);
}

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

fn writeVolumeHeader(w: *fields.Writer) PackError!void {
    try w.tableHeader(fields.VOLUME_HEADER);
    const ote = try writeOte(w);
    try w.field(fields.FORMAT_NAME, "SIDF"); // Annex C: the 4 bytes S I D F
    try w.field(fields.FORMAT_VERSION, &.{ 1, 0, 0, 0 }); // Annex C: B0 major, B1 minor
    try w.field(fields.SECTOR_SIZE, &u32bytes(@intCast(SECTOR))); // 10.1
    const zero_ts = [_]u8{0} ** 16; // clause 7: year 0 -> timestamp ignored
    try w.field(fields.VOLUME_SET_TIME, &zero_ts);
    try w.field(fields.VOLUME_TIME, &zero_ts);
    try w.field(fields.VOLUME_SET_LABEL, LABEL);
    try w.field(fields.VOLUME_SET_SEQUENCE, &u16bytes(1)); // Fixed, 2 bytes
    try w.bitsField(fields.VOLUME_INDEX_REQUIRED, 0); // Bit Data
    try w.bitsField(fields.FILE_MARK_USAGE, 0); // Bit Data: no file marks
    try endTable(w, fields.VOLUME_HEADER, ote);
}

fn writeFileSetHeader(w: *fields.Writer, buffer_size: u32) PackError!void {
    try w.tableHeader(fields.FILE_SET_HEADER);
    const ote = try writeOte(w);
    try w.field(fields.FILE_SET_ID, &u32bytes(FILE_SET_ID)); // Fixed, 4 bytes
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try w.field(fields.FILE_SET_LABEL, LABEL);
    try w.bitsField(fields.FILE_SET_INDEX_PRESENT, 0);
    try w.field(fields.BUFFER_SIZE, &u32bytes(buffer_size));
    try w.field(fields.SOURCE_NAME_TYPE, &.{0x01}); // NS1 (Figure 4)
    try w.field(fields.SOURCE_NAME, SOURCE_OS);
    try w.field(fields.SOURCE_OPERATING_SYSTEM, SOURCE_OS);
    try w.field(fields.SOURCE_OPERATING_SYSTEM_VERSION, SOURCE_OS_VERSION);
    try endTable(w, fields.FILE_SET_HEADER, ote);
}

fn writeFileSetTrailer(w: *fields.Writer) PackError!void {
    try w.tableHeader(fields.FILE_SET_TRAILER);
    const ote = try writeOte(w);
    try w.field(fields.FILE_SET_ID, &u32bytes(FILE_SET_ID));
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try w.field(fields.FILE_SET_LABEL, LABEL);
    try w.field(fields.SOURCE_NAME_TYPE, &.{0x01});
    try w.field(fields.SOURCE_NAME, SOURCE_OS);
    try w.field(fields.SOURCE_OPERATING_SYSTEM, SOURCE_OS);
    try w.field(fields.SOURCE_OPERATING_SYSTEM_VERSION, SOURCE_OS_VERSION);
    try endTable(w, fields.FILE_SET_TRAILER, ote);
}

/// Buffer Header FT (13.4). `unused` is the Blank Space byte count that fills
/// the rest of this Buffer.
fn writeBufferHeader(
    w: *fields.Writer,
    buffer_size: u32,
    sequence: u32,
    address: u32,
    unused: u32,
) PackError!void {
    try w.tableHeader(fields.BUFFER_HEADER);
    const ote = try writeOte(w);
    try w.field(fields.BUFFER_TYPE, &.{@intFromEnum(metadata.BufferType.file)});
    try w.field(fields.BUFFER_SIZE, &u32bytes(buffer_size));
    try w.field(fields.BUFFER_SEQUENCE, &u32bytes(sequence));
    try w.field(fields.BUFFER_ADDRESS, &u32bytes(address));
    try w.field(fields.UNUSED_IN_THIS_BUFFER, &u32bytes(unused));
    try w.field(fields.FILE_SET_ID, &u32bytes(FILE_SET_ID));
    const zero_ts = [_]u8{0} ** 16;
    try w.field(fields.FILE_SET_TIME, &zero_ts);
    try endTable(w, fields.BUFFER_HEADER, ote);
}

/// The Buffer Header's length does not depend on its values, so the layout can
/// measure it before it knows the buffer size.
fn bhLen() usize {
    var scratch: [256]u8 = undefined;
    var w = fields.Writer{ .buf = &scratch };
    writeBufferHeader(&w, MIN_BUFFER, 1, 1, 0) catch return 0;
    return w.len;
}

/// File Header FT (13.12). Returns the offset of FILE CHUNK SIZE's data so the
/// caller can patch in the whole-file byte count once it is known.
fn writeFileHeader(w: *fields.Writer, file_type: u8) PackError!usize {
    try w.tableHeader(fields.FILE_HEADER);
    try w.field(fields.FILE_CHUNK_SIZE, &u32bytes(0));
    const pos = w.len - 4;
    try w.field(fields.FILE_TYPE, &.{file_type}); // Fixed, 1 byte
    try w.tableEnd(fields.FILE_HEADER);
    return pos;
}

/// File Information FT (13.14).
fn writeFileInformation(
    w: *fields.Writer,
    parent: u8,
    pfq: u8,
    name: []const u8,
    data_stream_size: u32,
) PackError!void {
    try w.tableHeader(fields.FILE_INFORMATION);
    // ATTRIBUTES #81F2FE is FID-fixed at 4 bytes (Annex A); Annex C calls it
    // Variable — see §11.1's conflict list.
    try w.field(fields.ATTRIBUTES, &.{ 0, 0, 0, 0 });
    try w.field(fields.PARENT, &.{parent}); // Fixed, 1 byte
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{pfq}); // Fixed, 1 byte
    try w.field(fields.CREATOR_NAME_SPACE, &u32bytes(0x01)); // Fixed, 4 bytes, NS1
    try w.field(fields.DATA_STREAM_SIZE, &u32bytes(data_stream_size));
    try w.field(fields.NAME_SPACE, &.{0x01}); // NS1 (Figure 4)
    try w.field(fields.PATH_NAME, name);
    try w.tableEnd(fields.FILE_INFORMATION);
}

/// The Data Stream's Stream Header FT (13.15.7.1). §8.4: a compressed File
/// says so here as well as in the child-index entry — STREAM FORMAT = 2
/// (compressed data, 13.15.7.4), STREAM COMPRESS TYPE (#8005) = the PKWARE
/// method id, STREAM EXPANDED SIZE (#8006) = the expanded size — so a reader
/// that knows only the standard can decode it. A stored File carries FORMAT 0
/// and needs neither field. The File Space records `stream_size`, the *stored*
/// bytes, either way.
fn writeStreamHeader(
    w: *fields.Writer,
    stream_size: u32,
    method: u16,
    expanded_size: u32,
) PackError!void {
    try w.tableHeader(fields.STREAM_HEADER);
    try w.field(fields.STREAM_TYPE, &.{@intFromEnum(metadata.StreamType.data)});
    if (method == 0) {
        try w.field(fields.STREAM_FORMAT, &.{@intFromEnum(metadata.StreamFormat.clear_data)});
    } else {
        try w.field(fields.STREAM_FORMAT, &.{@intFromEnum(metadata.StreamFormat.compressed)});
    }
    try w.field(fields.STREAM_SIZE, &u32bytes(stream_size));
    if (method != 0) {
        try w.field(fields.STREAM_COMPRESS_TYPE, &u16bytes(method));
        try w.field(fields.STREAM_EXPANDED_SIZE, &u32bytes(expanded_size));
    }
    try w.tableEnd(fields.STREAM_HEADER);
}

fn writePathTable(w: *fields.Writer, pfq: u8, name: []const u8) PackError!void {
    try w.tableHeader(fields.PATH);
    try w.field(fields.PATH_FULLY_QUALIFIED, &.{pfq});
    try w.field(fields.NAME_SPACE, &.{0x01});
    try w.field(fields.PATH_NAME, name);
    try w.tableEnd(fields.PATH);
}

/// Source directory File Data (13.15.4). Returns the offset of the index
/// Stream's payload inside the record.
fn writeDirectoryData(
    w: *fields.Writer,
    index_stream: []const u8,
    name: []const u8,
    pfq: u8,
) PackError!usize {
    try w.tableHeader(fields.SOURCE_DIRECTORY_HEADER); // 13.15.4.1
    try w.tableEnd(fields.SOURCE_DIRECTORY_HEADER);
    try writePathTable(w, pfq, name);
    try w.tableHeader(fields.CHARACTERISTICS); // 13.15.2
    try w.bitsField(fields.SOURCE_DIRECTORY, 1);
    try w.tableEnd(fields.CHARACTERISTICS);
    try writeStreamHeader(w, @intCast(index_stream.len), 0, 0); // index Streams are stored (§8.4)
    const offset = w.len;
    try w.append(index_stream);
    try w.tableHeader(fields.STREAM_TRAILER); // 13.15.7.2
    try w.tableEnd(fields.STREAM_TRAILER);
    try w.tableHeader(fields.SOURCE_DIRECTORY_TRAILER); // 13.15.4.2
    try w.tableEnd(fields.SOURCE_DIRECTORY_TRAILER);
    return offset;
}

/// Source file File Data (13.15.5): the payload is streamed from disk.
fn writeFileData(w: *fields.Writer, io: std.Io, n: *const Node) PackError!void {
    try w.tableHeader(fields.SOURCE_FILE_HEADER); // 13.15.5.1
    try w.tableEnd(fields.SOURCE_FILE_HEADER);
    try writePathTable(w, 0, n.name);
    try w.tableHeader(fields.CHARACTERISTICS); // the mandatory field only
    try w.tableEnd(fields.CHARACTERISTICS);
    try writeStreamHeader(w, @intCast(n.stored_size), n.method, @intCast(n.size));
    try appendStored(w, io, n, 0, @intCast(n.stored_size));
    try w.tableHeader(fields.STREAM_TRAILER);
    try w.tableEnd(fields.STREAM_TRAILER);
    try w.tableHeader(fields.SOURCE_FILE_TRAILER); // 13.15.5.2
    try w.tableEnd(fields.SOURCE_FILE_TRAILER);
}

/// A multi-chunk File (§8.3): chunk 0 carries the File Header FT (13.12) and
/// the File Data's opening tables; every later chunk opens its Buffer with a
/// File Continuation Header FT (13.13); the last chunk closes the File Data
/// with the Stream Trailer and Source file Trailer.
pub fn writeChunkedFile(image: []u8, n: *const Node, io: std.Io) PackError!void {
    var w = fields.Writer{ .buf = image[@intCast(n.file_off)..] };
    const patch = try writeFileHeader(&w, @intFromEnum(metadata.FileType.file));
    try writeFileInformation(&w, 0, 0, n.name, @intCast(n.stored_size));
    // 13.15.5.1: the File Data opens with the Source file Header FT. It must be
    // here for the chunked head to match what `measureRecord` measured — the
    // mismatch is a 6-byte error that only shows up as a layout assertion.
    try w.tableHeader(fields.SOURCE_FILE_HEADER);
    try w.tableEnd(fields.SOURCE_FILE_HEADER);
    try writePathTable(&w, 0, n.name);
    try w.tableHeader(fields.CHARACTERISTICS);
    try w.tableEnd(fields.CHARACTERISTICS);
    try writeStreamHeader(&w, @intCast(n.stored_size), n.method, @intCast(n.size));
    // FILE CHUNK SIZE in the File Header FT (13.12): this chunk's File Space.
    fields.patchUintLe(image, @intCast(n.file_off + patch), n.chunks[0].chunk_size, 4);
    try appendStored(&w, io, n, 0, n.chunks[0].payload_len);
    if (w.len != n.chunks[0].chunk_size) return error.Invalid;

    var payload_off: u64 = n.chunks[0].payload_len;
    var k: usize = 1;
    while (k < n.chunks.len) : (k += 1) {
        const c = n.chunks[k];
        var cw = fields.Writer{ .buf = image[@intCast(c.file_off)..] };
        try writeContinuationHeader(&cw, c.chunk_size);
        try appendStored(&cw, io, n, payload_off, c.payload_len);
        payload_off += c.payload_len;
        if (k + 1 == n.chunks.len) {
            try cw.tableHeader(fields.STREAM_TRAILER); // 13.15.7.2
            try cw.tableEnd(fields.STREAM_TRAILER);
            try cw.tableHeader(fields.SOURCE_FILE_TRAILER); // 13.15.5.2
            try cw.tableEnd(fields.SOURCE_FILE_TRAILER);
        }
        if (cw.len != c.chunk_size) return error.Invalid;
    }
}

/// Emit `len` bytes of a File's *stored* payload starting at `offset`: from the
/// Deflate buffer when there is one, otherwise straight from the source File
/// (streamed, §8.2).
fn appendStored(w: *fields.Writer, io: std.Io, n: *const Node, offset: u64, len: u32) PackError!void {
    if (n.compressed) |bytes| {
        if (offset + len > bytes.len) return error.Truncated;
        try w.append(bytes[@intCast(offset)..][0..len]);
        return;
    }
    try appendPayloadRange(w, io, n.source_path, offset, len);
}

/// §8.4: decide compression for every File before anything is measured or
/// planned, so chunking and the layout see the bytes that will actually be
/// stored. A File is compressed iff Deflate at level 6 (PKWARE method 8, raw
/// Deflate — no zlib wrapper) shrinks it by more than 10%:
///
///     compressed * 10 <= expanded * 9   and   compressed < expanded
///
/// Directory index Streams are never compressed. The decision is a pure
/// function of the payload and the pinned level, so the same tree packs to the
/// same bytes twice.
fn compressPayloads(a: std.mem.Allocator, io: std.Io, tree: *Tree) PackError!void {
    for (tree.nodes[0..tree.count]) |*n| {
        if (n.kind == .directory) {
            n.stored_size = n.index_len;
            continue;
        }
        n.stored_size = n.size;
        n.method = 0;
        const bytes = (try deflateFile(a, io, n.source_path, n.size)) orelse continue;
        const expanded = n.size;
        const stored: u64 = bytes.len;
        if (stored < expanded and stored * 10 <= expanded * 9) {
            n.compressed = bytes;
            n.method = 8; // PKWARE APPNOTE method 8: Deflate
            n.stored_size = stored;
        } else {
            a.free(bytes);
        }
    }
}

/// Deflate one File's payload, streamed from disk so a large File is never held
/// twice. Returns null when the payload cannot be compressed at all (empty, or
/// the codec declined); the caller then stores it.
fn deflateFile(a: std.mem.Allocator, io: std.Io, path: []const u8, size: u64) PackError!?[]u8 {
    if (size == 0) return null;
    const file = std.Io.Dir.cwd().openFile(io, path, .{}) catch |e| return mapFsError(e);
    defer file.close(io);
    // The output writer must start with a real buffer: `Compress.init`
    // asserts it holds at least 8 bytes (its bit writer fills a block first).
    var sink = std.Io.Writer.Allocating.initCapacity(a, 64 * 1024) catch return error.OutOfMemory;
    errdefer sink.deinit();
    var window: [flate.max_window_len]u8 = undefined;
    var c = flate.Compress.init(&sink.writer, &window, .raw, flate.Compress.Options.level_6) catch return null;
    var buf: [64 * 1024]u8 = undefined;
    var off: u64 = 0;
    while (off < size) {
        const want: usize = @intCast(@min(@as(u64, buf.len), size - off));
        const got = std.Io.File.readPositionalAll(file, io, buf[0..want], off) catch |e| return mapFsError(e);
        if (got == 0) return error.Truncated; // the source shrank under us
        c.writer.writeAll(buf[0..got]) catch return null;
        off += got;
    }
    flate.Compress.finish(&c) catch return null;
    return try sink.toOwnedSlice();
}

fn appendPayload(w: *fields.Writer, io: std.Io, source_path: []const u8, size: u64) PackError!void {
    try appendPayloadRange(w, io, source_path, 0, @intCast(size));
}

fn appendPayloadRange(
    w: *fields.Writer,
    io: std.Io,
    source_path: []const u8,
    offset: u64,
    len: u32,
) PackError!void {
    if (len == 0) return;
    const file = std.Io.Dir.cwd().openFile(io, source_path, .{}) catch |e| return mapFsError(e);
    defer file.close(io);
    var chunk: [64 * 1024]u8 = undefined;
    var done: u64 = 0;
    while (done < len) {
        const want: usize = @intCast(@min(@as(u64, chunk.len), @as(u64, len) - done));
        const n = std.Io.File.readPositionalAll(file, io, chunk[0..want], offset + done) catch |e| return mapFsError(e);
        if (n == 0) return error.Truncated; // the source shrank under us
        try w.append(chunk[0..n]);
        done += n;
    }
}

const Measure = struct {
    /// Fixed overhead: the record's length with an empty payload.
    len: usize,
    /// Where the payload starts inside the record (directories: the child
    /// index Stream; files: the Data Stream).
    payload_off: u32 = 0,
};

/// Measure a record by writing it with an empty payload: the result is the
/// fixed overhead, and the caller adds the payload length.
fn measureRecord(scratch: []u8, n: *const Node) PackError!Measure {
    var w = fields.Writer{ .buf = scratch };
    _ = try writeFileHeader(&w, if (n.kind == .directory)
        @intFromEnum(metadata.FileType.source_directory)
    else
        @intFromEnum(metadata.FileType.file));
    try writeFileInformation(&w, 0, 0, n.name, 0);
    var payload_off: u32 = 0;
    if (n.kind == .directory) {
        // The measurement is of the *root* shape (pfq=1) or a child shape
        // (pfq=0); both are the same length, and the root's is what the
        // fixture uses, so measure with 1 to match `writeLayout`.
        payload_off = @intCast(try writeDirectoryData(&w, &.{}, n.name, 1));
    } else {
        // The measurement must mirror `writeFileData` exactly, including the
        // empty SOURCE FILE HEADER table — a missing table here is a 6-byte
        // undercount that only shows up as a layout assertion later.
        try w.tableHeader(fields.SOURCE_FILE_HEADER);
        try w.tableEnd(fields.SOURCE_FILE_HEADER);
        try writePathTable(&w, 0, n.name);
        try w.tableHeader(fields.CHARACTERISTICS);
        try w.tableEnd(fields.CHARACTERISTICS);
        try writeStreamHeader(&w, 0, n.method, @intCast(n.size));
        // The payload begins here: everything before this point is the head,
        // everything after is the trailers. §8.3's chunking needs the two
        // separated — a File whose `head_len` is 0 plans a first chunk that is
        // short by exactly its head, which only shows up as a layout assertion.
        payload_off = @intCast(w.len);
        try w.tableHeader(fields.STREAM_TRAILER);
        try w.tableEnd(fields.STREAM_TRAILER);
        try w.tableHeader(fields.SOURCE_FILE_TRAILER);
        try w.tableEnd(fields.SOURCE_FILE_TRAILER);
    }
    if (w.len > 0xFFFF_FFFF) return error.InvalidValue;
    return .{ .len = w.len, .payload_off = payload_off };
}

fn mapFsError(e: anyerror) PackError {
    return switch (e) {
        error.FileNotFound => error.NotFound,
        error.NotDir => error.NotDir,
        error.IsDir => error.IsDir,
        error.AccessDenied, error.PermissionDenied => error.AccessDenied,
        error.OutOfMemory => error.OutOfMemory,
        error.NameTooLong => error.NameTooLong,
        else => error.IoRead,
    };
}

// ---------------------------------------------------------------------------
// Tests that need no filesystem
// ---------------------------------------------------------------------------

const testing = std.testing;

test "the buffer header length is stable" {
    try testing.expectEqual(bhLen(), bhLen());
    try testing.expect(bhLen() > 0 and bhLen() < 256);
}
