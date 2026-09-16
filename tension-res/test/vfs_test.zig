//! VFS tests (phase 5): path normalization, the fd table, stat/stat_fd,
//! readdir, and the error table of DESIGN.md §7 — against real packed volumes
//! built by the same layout code the prune tests use.
//!
//! Fixtures are file-scope statics (the volume bytes must outlive the walker);
//! every test rebuilds the tree it uses.

const std = @import("std");
const res = @import("../src/root.zig");
const support = @import("prune_support.zig");
const walk = res.walk;
const index = res.index;
const fields = res.fields;
const vfs_mod = res.vfs;
const writer = res.writer;
const Vfs = vfs_mod.Vfs;
const StatRecord = vfs_mod.StatRecord;
const KIND_FILE = vfs_mod.KIND_FILE;
const KIND_DIRECTORY = vfs_mod.KIND_DIRECTORY;
const FLAG_COMPRESSED = vfs_mod.FLAG_COMPRESSED;
const testing = std.testing;
const io = testing.io;

/// The emitted errno constants, spelled out so the tests pin the ABI table.
const ENOENT: i32 = -2;
const EIO: i32 = -5;
const EBADF: i32 = -9;
const ENOTDIR: i32 = -20;
const EISDIR: i32 = -21;
const EINVAL: i32 = -22;
const EMFILE: i32 = -24;

// --- fixture buffers --------------------------------------------------------

var nodes: [64]support.Node = undefined;
var image: [128 * 1024]u8 = undefined;
var names: [4096]u8 = undefined;
var payloads: [4096]u8 = undefined;

var big_nodes: [512]support.Node = undefined;
var big_image: [128 * 1024]u8 = undefined;
var big_names: [8192]u8 = undefined;
var big_payloads: [8192]u8 = undefined;

var nodes2: [16]support.Node = undefined;
var image2: [32 * 1024]u8 = undefined;
var names2: [512]u8 = undefined;
var payloads2: [512]u8 = undefined;

const P_GAMMA = "gamma-payload";
const P_HELLO = "hello, world!";
const P_ONE = "one-payload";
const P_DEEP = "deep-payload";
const P_TWO = "two!";
const P_ZZ = "zz-payload";

const Fx = struct {
    tree: support.Tree,
    root: usize,
    alpha: usize,
    beta: usize,
    nested: usize,
    gamma: usize,
};

/// root/{alpha/, beta/, gamma.txt, hello.txt}; alpha/{nested/, one.txt};
/// alpha/nested/{deep.txt}; beta/{two.txt} — every directory's children are
/// created in NS1 byte order, which is the packer's listing order (§8.1
/// invariant 6).
fn buildFx(omit_index_for: ?usize) !Fx {
    var t = support.Tree.init(&nodes, &image, &names, &payloads);
    const root = t.addDir(null, "root");
    const alpha = t.addDir(root, "alpha");
    const beta = t.addDir(root, "beta");
    const gamma = t.addFile(root, "gamma.txt", P_GAMMA);
    _ = t.addFile(root, "hello.txt", P_HELLO);
    const nested = t.addDir(alpha, "nested");
    _ = t.addFile(alpha, "one.txt", P_ONE);
    _ = t.addFile(nested, "deep.txt", P_DEEP);
    _ = t.addFile(beta, "two.txt", P_TWO);
    t.omit_index_for = omit_index_for;
    try t.finish();
    return .{ .tree = t, .root = root, .alpha = alpha, .beta = beta, .nested = nested, .gamma = gamma };
}

fn buildFx2() !support.Tree {
    var t = support.Tree.init(&nodes2, &image2, &names2, &payloads2);
    const root = t.addDir(null, "root");
    _ = t.addFile(root, "zz.txt", P_ZZ);
    try t.finish();
    return t;
}

/// `n000`..`n255`: fixed width so insertion order is NS1 byte order.
fn buildBig(children: usize) !support.Tree {
    var t = support.Tree.init(&big_nodes, &big_image, &big_names, &big_payloads);
    const root = t.addDir(null, "root");
    var nbuf: [8]u8 = undefined;
    var i: usize = 0;
    while (i < children) : (i += 1) {
        nbuf[0] = 'n';
        var v = i;
        var j: usize = 4;
        while (j > 1) {
            j -= 1;
            nbuf[j] = '0' + @as(u8, @intCast(v % 10));
            v /= 10;
        }
        _ = t.addFile(root, nbuf[0..4], "0123456789");
    }
    try t.finish();
    return t;
}

// --- harness ----------------------------------------------------------------

/// A one-pak VFS with its `SliceReader`, walker and pak array pinned in place
/// (the walker's reader holds a pointer to the reader, so nothing may move).
const Harness = struct {
    sr: res.block.SliceReader,
    pak: walk.Walker,
    paks: [1]walk.Walker,
    vfs: Vfs,
};

fn openHarness(h: *Harness, img: []const u8) !void {
    h.sr = .{ .bytes = img };
    h.pak = try walk.Walker.init(img, h.sr.blockReader());
    h.paks = .{h.pak};
    h.vfs = Vfs.init(&h.paks, testing.allocator);
}

fn openHarnessRec(h: *Harness, img: []const u8, rec: *support.Recorder) !void {
    rec.inner = .{ .bytes = img };
    rec.reset();
    h.sr = .{ .bytes = img };
    h.pak = try walk.Walker.init(img, rec.reader());
    h.paks = .{h.pak};
    h.vfs = Vfs.init(&h.paks, testing.allocator);
}

fn expectStat(vfs: *Vfs, path: []const u8, kind: u32, size: u32, flags: u32) !void {
    var rec: StatRecord = undefined;
    try testing.expectEqual(@as(i32, 0), vfs.stat(path, &rec));
    try testing.expectEqual(kind, rec.kind);
    try testing.expectEqual(size, rec.size);
    try testing.expectEqual(flags, rec.flags);
}

fn statErrno(vfs: *Vfs, path: []const u8) i32 {
    var rec: StatRecord = undefined;
    return vfs.stat(path, &rec);
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
        if (fields.readUintLe(&tmp) == want) {
            var t4: [4]u8 = undefined;
            @memcpy(&t4, listing[at + 8 ..][0..4]);
            return @intCast(fields.readUintLe(&t4));
        }
    }
    return error.Missing;
}

// --- path rules (§7.1) ------------------------------------------------------

test "path normalization: separators, dots, leading slash, empty path" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    try expectStat(vfs, "alpha/one.txt", KIND_FILE, P_ONE.len, 0);
    try expectStat(vfs, "/alpha/one.txt", KIND_FILE, P_ONE.len, 0);
    try expectStat(vfs, "alpha//one.txt", KIND_FILE, P_ONE.len, 0);
    try expectStat(vfs, "alpha/./one.txt", KIND_FILE, P_ONE.len, 0);
    try expectStat(vfs, "alpha/nested/../one.txt", KIND_FILE, P_ONE.len, 0);
    try expectStat(vfs, "alpha/nested/../nested/deep.txt", KIND_FILE, P_DEEP.len, 0);
    try expectStat(vfs, "alpha/", KIND_DIRECTORY, 0, 0);
    try expectStat(vfs, "", KIND_DIRECTORY, 0, 0);
    try expectStat(vfs, "/", KIND_DIRECTORY, 0, 0);
    try expectStat(vfs, "alpha/nested/", KIND_DIRECTORY, 0, 0);

    // Case-sensitive: no folding, no namespace fallback (§7.1).
    try testing.expectEqual(ENOENT, statErrno(vfs, "ALPHA/one.txt"));
    try testing.expectEqual(ENOENT, statErrno(vfs, "Alpha/Nested/deep.txt"));
    try testing.expectEqual(ENOENT, statErrno(vfs, "alpha/one.TXT"));
    try testing.expectEqual(ENOENT, statErrno(vfs, "alpha/nope"));
    try testing.expectEqual(ENOENT, statErrno(vfs, "one.txt")); // not at the root
    try testing.expectEqual(ENOTDIR, statErrno(vfs, "alpha/one.txt/extra")); // file in a path position
}

test "path errors: escape is -EINVAL, trailing slash on a file is -ENOTDIR" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    try testing.expectEqual(EINVAL, statErrno(vfs, ".."));
    try testing.expectEqual(EINVAL, statErrno(vfs, "../escape"));
    try testing.expectEqual(EINVAL, statErrno(vfs, "alpha/../../x"));
    try testing.expectEqual(EINVAL, statErrno(vfs, "a\x00b"));
    try testing.expectEqual(EINVAL, statErrno(vfs, "alpha/\x00nested"));
    try testing.expectEqual(ENOTDIR, statErrno(vfs, "alpha/one.txt/"));
    try testing.expectEqual(ENOTDIR, statErrno(vfs, "alpha/one.txt/extra"));

    // The same codes through `open`, where a directory is -EISDIR (§7.7).
    try testing.expectEqual(EISDIR, vfs.open("alpha"));
    try testing.expectEqual(EISDIR, vfs.open("alpha/"));
    try testing.expectEqual(EISDIR, vfs.open(""));
    try testing.expectEqual(ENOTDIR, vfs.open("alpha/one.txt/"));
    try testing.expectEqual(ENOTDIR, vfs.open("alpha/one.txt/extra"));
    try testing.expectEqual(ENOENT, vfs.open("alpha/nope"));
    try testing.expectEqual(EINVAL, vfs.open("../escape"));
}

// --- the fd table (§7.3, §7.5) ----------------------------------------------

test "fd lifecycle: read, seek SET/CUR/END, tell, close, idempotence" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    const fd = vfs.open("hello.txt");
    try testing.expect(fd >= 1);
    var buf: [64]u8 = undefined;

    try testing.expectEqual(@as(i64, 0), vfs.tell(fd));
    try testing.expectEqual(@as(i32, 5), vfs.read(fd, buf[0..5]));
    try testing.expectEqualStrings("hello", buf[0..5]);
    try testing.expectEqual(@as(i64, 5), vfs.tell(fd));

    try testing.expectEqual(@as(i64, 1), vfs.seek(fd, 1, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i32, 5), vfs.read(fd, buf[0..5]));
    try testing.expectEqualStrings("ello,", buf[0..5]);

    try testing.expectEqual(@as(i64, 8), vfs.seek(fd, 2, vfs_mod.SEEK_CUR));
    try testing.expectEqual(@as(i64, P_HELLO.len), vfs.seek(fd, 0, vfs_mod.SEEK_END));
    try testing.expectEqual(@as(i32, 0), vfs.read(fd, &buf)); // end of file

    try testing.expectEqual(@as(i64, 1), vfs.seek(fd, -12, vfs_mod.SEEK_END));
    try testing.expectEqual(@as(i32, 5), vfs.read(fd, buf[0..5]));
    try testing.expectEqualStrings("ello,", buf[0..5]); // a short read only at EOF (§7.5)

    // A whole-file read, then the EOF behaviour of an over-seek.
    try testing.expectEqual(@as(i64, 0), vfs.seek(fd, 0, vfs_mod.SEEK_SET));
    const n = vfs.read(fd, &buf);
    try testing.expectEqual(@as(i32, P_HELLO.len), n);
    try testing.expectEqualStrings(P_HELLO, buf[0..@intCast(n)]);
    try testing.expectEqual(@as(i32, 0), vfs.read(fd, &buf));
    try testing.expectEqual(@as(i64, 100), vfs.seek(fd, 100, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i32, 0), vfs.read(fd, &buf));

    // A negative result and an unknown whence are -EINVAL (§7.5).
    try testing.expectEqual(@as(i64, EINVAL), vfs.seek(fd, -1, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i64, EINVAL), vfs.seek(fd, -101, vfs_mod.SEEK_CUR));
    try testing.expectEqual(@as(i64, EINVAL), vfs.seek(fd, 0, 9));

    // close is idempotent; every use after close is -EBADF.
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));
    try testing.expectEqual(EBADF, vfs.read(fd, &buf));
    try testing.expectEqual(@as(i64, EBADF), vfs.seek(fd, 0, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i64, EBADF), vfs.tell(fd));
    var rec: StatRecord = undefined;
    try testing.expectEqual(EBADF, vfs.statFd(fd, &rec));
}

test "two opens of one file have independent cursors" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    const a = vfs.open("gamma.txt");
    const b = vfs.open("gamma.txt");
    try testing.expect(a != b);

    var buf: [64]u8 = undefined;
    try testing.expectEqual(@as(i32, 4), vfs.read(a, buf[0..4]));
    try testing.expectEqualStrings("gamm", buf[0..4]);
    try testing.expectEqual(@as(i64, 4), vfs.tell(a));
    try testing.expectEqual(@as(i64, 0), vfs.tell(b));
    try testing.expectEqual(@as(i32, P_GAMMA.len), vfs.read(b, &buf));
    try testing.expectEqualStrings(P_GAMMA, buf[0..P_GAMMA.len]);
    try testing.expectEqual(@as(i64, 4), vfs.tell(a));
    try testing.expectEqual(@as(i32, 0), vfs.close(a));
    // Closing one handle leaves the other's cursor where it was (b is at EOF).
    try testing.expectEqual(@as(i64, P_GAMMA.len), vfs.tell(b));
    try testing.expectEqual(@as(i32, 0), vfs.read(b, buf[0..4]));
    try testing.expectEqual(@as(i64, 0), vfs.seek(b, 0, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i32, P_GAMMA.len), vfs.read(b, &buf));
    try testing.expectEqual(@as(i32, 0), vfs.close(b));
}

test "stat and stat_fd agree, and the fd table fills up as -EMFILE" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    const fd = vfs.open("gamma.txt");
    var by_path: StatRecord = undefined;
    var by_fd: StatRecord = undefined;
    try testing.expectEqual(@as(i32, 0), vfs.stat("gamma.txt", &by_path));
    try testing.expectEqual(@as(i32, 0), vfs.statFd(fd, &by_fd));
    try testing.expectEqual(by_path.kind, by_fd.kind);
    try testing.expectEqual(by_path.size, by_fd.size);
    try testing.expectEqual(by_path.flags, by_fd.flags);
    try testing.expectEqual(@as(u32, P_GAMMA.len), by_fd.size);
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));

    // Fill the table, then prove exhaustion and reuse (§7.3).
    var fds: [vfs_mod.MAX_FDS]i32 = undefined;
    for (&fds) |*slot| slot.* = vfs.open("hello.txt");
    for (fds) |one| try testing.expect(one >= 1);
    try testing.expectEqual(EMFILE, vfs.open("hello.txt"));
    try testing.expectEqual(@as(i32, 0), vfs.close(fds[7]));
    const again = vfs.open("hello.txt");
    try testing.expect(again >= 1);
    try testing.expectEqual(@as(i32, 0), vfs.close(again));
    for (fds, 0..) |one, i| {
        if (i != 7) try testing.expectEqual(@as(i32, 0), vfs.close(one));
    }
}

// --- readdir (§7.6) ---------------------------------------------------------

test "readdir lists every child in name order, raw names" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    var name: [64]u8 = undefined;
    var rec: StatRecord = undefined;

    const want = [_][]const u8{ "alpha", "beta", "gamma.txt", "hello.txt" };
    const kinds = [_]u32{ KIND_DIRECTORY, KIND_DIRECTORY, KIND_FILE, KIND_FILE };
    const sizes = [_]u32{ 0, 0, P_GAMMA.len, P_HELLO.len };
    for (want, 0..) |w, i| {
        const got = vfs.readdir("/", @intCast(i), &name, &rec);
        try testing.expectEqual(@as(i32, @intCast(w.len)), got);
        try testing.expectEqualStrings(w, name[0..@intCast(got)]);
        try testing.expectEqual(kinds[i], rec.kind);
        try testing.expectEqual(sizes[i], rec.size);
    }
    try testing.expectEqual(@as(i32, 0), vfs.readdir("/", want.len, &name, &rec));
    try testing.expectEqual(@as(i32, 0), vfs.readdir("/", 999, &name, &rec));

    // The same listing through the empty path and a subdirectory.
    try testing.expectEqual(@as(i32, 5), vfs.readdir("", 0, &name, &rec));
    try testing.expectEqualStrings("alpha", name[0..5]);
    try testing.expectEqual(@as(i32, 6), vfs.readdir("alpha", 0, &name, &rec));
    try testing.expectEqualStrings("nested", name[0..6]);
    try testing.expectEqual(KIND_DIRECTORY, rec.kind);
    try testing.expectEqual(@as(i32, 7), vfs.readdir("alpha", 1, &name, &rec));
    try testing.expectEqualStrings("one.txt", name[0..7]);
    try testing.expectEqual(@as(i32, 0), vfs.readdir("alpha", 2, &name, &rec));
    try testing.expectEqual(@as(i32, 8), vfs.readdir("alpha/nested", 0, &name, &rec));
    try testing.expectEqualStrings("deep.txt", name[0..8]);

    // Ascending order really is NS1 byte order.
    var prev: [64]u8 = undefined;
    var prev_len: usize = 0;
    var i: u32 = 0;
    while (true) : (i += 1) {
        const got = vfs.readdir("/", i, &name, &rec);
        if (got == 0) break;
        const len: usize = @intCast(got);
        if (i > 0) {
            const ord = std.mem.order(u8, prev[0..prev_len], name[0..len]);
            try testing.expect(ord == .lt);
        }
        @memcpy(prev[0..len], name[0..len]);
        prev_len = len;
    }
}

test "readdir name buffer follows the arg convention (min written, full length returned)" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;
    var name: [64]u8 = undefined;
    var rec: StatRecord = undefined;

    // cap 0 is a pure size probe…
    try testing.expectEqual(@as(i32, 5), vfs.readdir("/", 0, name[0..0], &rec));
    try testing.expectEqual(KIND_DIRECTORY, rec.kind);
    // …and the probe/write pair does not have to restart the scan.
    try testing.expectEqual(@as(i32, 5), vfs.readdir("/", 0, &name, &rec));
    try testing.expectEqualStrings("alpha", name[0..5]);

    // A short buffer writes what fits and still reports the full length.
    try testing.expectEqual(@as(i32, 5), vfs.readdir("/", 0, name[0..3], &rec));
    try testing.expectEqualStrings("alp", name[0..3]);
    try testing.expectEqual(@as(i32, 9), vfs.readdir("/", 3, name[0..9], &rec));
    try testing.expectEqualStrings("hello.txt", name[0..9]);
    try testing.expectEqual(@as(i32, 9), vfs.readdir("/", 3, name[0..4], &rec));
    try testing.expectEqualStrings("hell", name[0..4]);

    // Out-of-order and repeated access stays correct (cache misses rescan).
    try testing.expectEqual(@as(i32, 7), vfs.readdir("alpha", 1, &name, &rec));
    try testing.expectEqualStrings("one.txt", name[0..7]);
    try testing.expectEqual(@as(i32, 5), vfs.readdir("/", 0, &name, &rec));
    try testing.expectEqualStrings("alpha", name[0..5]);
    try testing.expectEqual(@as(i32, 7), vfs.readdir("alpha", 1, &name, &rec));
    try testing.expectEqualStrings("one.txt", name[0..7]);
    try testing.expectEqual(@as(i32, 8), vfs.readdir("alpha/nested", 0, &name, &rec));
    try testing.expectEqualStrings("deep.txt", name[0..8]);
}

test "readdir on a file is -ENOTDIR; on a missing path -ENOENT" {
    const fx = try buildFx(null);
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;
    var name: [64]u8 = undefined;
    var rec: StatRecord = undefined;

    try testing.expectEqual(ENOTDIR, vfs.readdir("gamma.txt", 0, &name, &rec));
    try testing.expectEqual(ENOTDIR, vfs.readdir("alpha/one.txt", 0, &name, &rec));
    try testing.expectEqual(ENOENT, vfs.readdir("alpha/nope", 0, &name, &rec));
    try testing.expectEqual(ENOENT, vfs.readdir("nope", 0, &name, &rec));
    try testing.expectEqual(ENOTDIR, vfs.readdir("alpha/one.txt/x", 0, &name, &rec)); // file in a path position
    try testing.expectEqual(EINVAL, vfs.readdir("../escape", 0, &name, &rec));
}

test "a directory without a child index stats but does not enumerate" {
    const fx = try buildFx(1); // node 1 = alpha: no child-index Stream (§11)
    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;
    var name: [64]u8 = undefined;
    var rec: StatRecord = undefined;

    try expectStat(vfs, "alpha", KIND_DIRECTORY, 0, 0);
    try testing.expectEqual(ENOENT, vfs.readdir("alpha", 0, &name, &rec));
    try testing.expectEqual(EISDIR, vfs.open("alpha"));
    try testing.expectEqual(ENOENT, statErrno(vfs, "alpha/one.txt"));
    try testing.expectEqual(ENOENT, statErrno(vfs, "alpha/nested")); // its entry lived in alpha's listing
    try testing.expectEqual(ENOENT, statErrno(vfs, "alpha/nested/deep.txt"));
    // Sibling directories are untouched by the omission.
    try expectStat(vfs, "beta", KIND_DIRECTORY, 0, 0);
    try expectStat(vfs, "beta/two.txt", KIND_FILE, P_TWO.len, 0);
}

test "ascending enumeration costs one step; a random index rescans" {
    const children = 256;
    const t = try buildBig(children);
    var rec = support.Recorder{ .inner = .{ .bytes = big_image[0..t.image_len] } };
    var h: Harness = undefined;
    try openHarnessRec(&h, big_image[0..t.image_len], &rec);
    const vfs = &h.vfs;
    var name: [64]u8 = undefined;
    var out: StatRecord = undefined;

    var page_bits: [(128 * 1024 / 8192) + 2]u64 = undefined;
    var scratch: [support.MAX_LOG]support.Range = undefined;

    // Ascending pass, one recorder segment per step.
    var total_step_bytes: u64 = 0;
    var max_step_bytes: u64 = 0;
    var seen: usize = 0;
    var i: u32 = 0;
    while (true) : (i += 1) {
        rec.reset();
        const n = vfs.readdir("/", i, &name, &out);
        if (n == 0) break;
        const m = support.measure(&rec, 8192, &page_bits, &scratch);
        total_step_bytes += m.bytes_total;
        max_step_bytes = @max(max_step_bytes, m.bytes_total);
        try testing.expect(n > 0);
        seen += 1;
    }
    try testing.expectEqual(@as(usize, children), seen);
    std.debug.print(
        "vfs: ascending readdir of {d} children: total {d} B, worst step {d} B\n",
        .{ children, total_step_bytes, max_step_bytes },
    );
    // A cached step re-reads only the listing bytes it walks; a per-step
    // rescan would be quadratic in the ordinal.
    try testing.expect(max_step_bytes < 1024);
    try testing.expect(total_step_bytes < 512 * children);

    // Index 0 is the first entry, so it is O(1) even with a cold cache.
    rec.reset();
    try testing.expectEqual(@as(i32, 4), vfs.readdir("/", 0, &name, &out));
    try testing.expectEqualStrings("n000", name[0..4]);
    const near = support.measure(&rec, 8192, &page_bits, &scratch);
    try testing.expect(near.bytes_total < 512);

    // A distant index with the cache parked elsewhere rescans the listing from
    // the entry area's first byte — the O(index) access §7.6 documents.
    rec.reset();
    const far = children - 56;
    try testing.expectEqual(@as(i32, 4), vfs.readdir("/", @intCast(far), &name, &out));
    const miss = support.measure(&rec, 8192, &page_bits, &scratch);
    std.debug.print(
        "vfs: cold readdir index {d} of {d} children: {d} B (entry 0: {d} B)\n",
        .{ far, children, miss.bytes_total, near.bytes_total },
    );
    try testing.expect(miss.bytes_total > (far * 20) / 2);
}

// --- robustness (§11) -------------------------------------------------------

test "a malformed location is -EINVAL and never a panic" {
    const fx = try buildFx(null);
    const listing = image[@intCast(fx.tree.nodes[fx.root].listing_off)..][0..fx.tree.nodes[fx.root].listing_len];
    const entry_off = try findEntryOffset(listing, "gamma.txt");
    fields.writeUintLe(listing[entry_off + 10 ..][0..4], 0xFFFF); // buffer_address past the image

    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    // `stat` reads the index entry only (§7.4), so a corrupt location is
    // invisible to it; `open` resolves the File and must reject it (§6.8).
    var rec: StatRecord = undefined;
    try testing.expectEqual(@as(i32, 0), vfs.stat("gamma.txt", &rec));
    try testing.expectEqual(@as(u32, P_GAMMA.len), rec.size);
    try testing.expectEqual(EINVAL, vfs.open("gamma.txt"));
    try testing.expectEqual(ENOTDIR, vfs.open("hello.txt/")); // trailing slash on a file

    // The rest of the volume is unaffected.
    try expectStat(vfs, "hello.txt", KIND_FILE, P_HELLO.len, 0);
    const ok = vfs.open("hello.txt");
    try testing.expect(ok >= 1);
    try testing.expectEqual(@as(i32, 0), vfs.close(ok));
}

test "a truncated image is an errno from Walker.init, not a panic" {
    const fx = try buildFx(null);
    var sr = res.block.SliceReader{ .bytes = image[0..fx.tree.image_len] };
    // The reader, not the length argument, is what serves the bytes: truncate
    // it and the walker must fail with an errno instead of reading garbage.
    sr.bytes = image[0..96];
    try testing.expect(std.meta.isError(walk.Walker.init(image[0..96], sr.blockReader())));
    sr.bytes = image[0..0];
    try testing.expect(std.meta.isError(walk.Walker.init(image[0..0], sr.blockReader())));
    // Mid-record truncation: the header parses, the File Set Header does not.
    sr.bytes = image[0..600];
    try testing.expect(std.meta.isError(walk.Walker.init(image[0..600], sr.blockReader())));
}

test "a compressed entry stats, opens, and reads -EIO for that file only" {
    const fx = try buildFx(null);
    const listing = image[@intCast(fx.tree.nodes[fx.root].listing_off)..][0..fx.tree.nodes[fx.root].listing_len];
    const entry_off = try findEntryOffset(listing, "gamma.txt");
    fields.writeUintLe(listing[entry_off + 18 ..][0..2], 8); // method 8 = Deflate (PKWARE)

    var h: Harness = undefined;
    try openHarness(&h, image[0..fx.tree.image_len]);
    const vfs = &h.vfs;

    try expectStat(vfs, "gamma.txt", KIND_FILE, P_GAMMA.len, FLAG_COMPRESSED);
    const fd = vfs.open("gamma.txt");
    try testing.expect(fd >= 1);
    var buf: [64]u8 = undefined;
    try testing.expectEqual(EIO, vfs.read(fd, &buf));
    var rec: StatRecord = undefined;
    try testing.expectEqual(@as(i32, 0), vfs.statFd(fd, &rec));
    try testing.expectEqual(FLAG_COMPRESSED, rec.flags);
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));

    // The rest of the volume is unaffected.
    try expectStat(vfs, "hello.txt", KIND_FILE, P_HELLO.len, 0);
    const ok = vfs.open("hello.txt");
    try testing.expectEqual(@as(i32, P_HELLO.len), vfs.read(ok, &buf));
    try testing.expectEqual(@as(i32, 0), vfs.close(ok));
}

test "the VFS reaches bytes only through the BlockReader" {
    const fx = try buildFx(null);
    var decoy = [_]u8{0xFF} ** (128 * 1024);
    var sr = res.block.SliceReader{ .bytes = image[0..fx.tree.image_len] };
    const pak = try walk.Walker.init(decoy[0..fx.tree.image_len], sr.blockReader());
    var paks = [_]walk.Walker{pak};
    var vfs = Vfs.init(&paks, testing.allocator);

    const fd = vfs.open("alpha/nested/deep.txt");
    try testing.expect(fd >= 1);
    var buf: [64]u8 = undefined;
    const n = vfs.read(fd, &buf);
    try testing.expectEqual(@as(i32, P_DEEP.len), n);
    try testing.expectEqualStrings(P_DEEP, buf[0..@intCast(n)]);
    try testing.expectEqual(@as(i32, 0), vfs.close(fd));

    var name: [64]u8 = undefined;
    var rec: StatRecord = undefined;
    try testing.expectEqual(@as(i32, 6), vfs.readdir("alpha", 0, &name, &rec));
    try testing.expectEqualStrings("nested", name[0..6]);
}

test "pak set: first match wins, misses fall through, precise failures surface" {
    const fx = try buildFx(null);
    const t2 = try buildFx2();
    var s1 = res.block.SliceReader{ .bytes = image[0..fx.tree.image_len] };
    var s2 = res.block.SliceReader{ .bytes = image2[0..t2.image_len] };
    var paks = [_]walk.Walker{
        try walk.Walker.init(image[0..fx.tree.image_len], s1.blockReader()),
        try walk.Walker.init(image2[0..t2.image_len], s2.blockReader()),
    };
    var vfs = Vfs.init(&paks, testing.allocator);

    var rec: StatRecord = undefined;
    try testing.expectEqual(@as(i32, 0), vfs.stat("gamma.txt", &rec)); // pak 1
    try testing.expectEqual(@as(u32, P_GAMMA.len), rec.size);
    try testing.expectEqual(@as(i32, 0), vfs.stat("zz.txt", &rec)); // pak 2, after a miss
    try testing.expectEqual(@as(u32, P_ZZ.len), rec.size);
    try testing.expectEqual(ENOENT, statErrno(&vfs, "nothing-anywhere"));
    try testing.expectEqual(EINVAL, statErrno(&vfs, "../escape"));

    var name: [64]u8 = undefined;
    try testing.expectEqual(@as(i32, 5), vfs.readdir("/", 0, &name, &rec)); // pak 1's root
    try testing.expectEqualStrings("alpha", name[0..5]);
    try testing.expectEqual(ENOENT, vfs.readdir("nope", 0, &name, &rec));
}

// --- 9c: chunked Files, read and seek across Buffers (§8.3) ------------------

/// See size_test.zig: an incompressible payload, so these Files stay stored and
/// the chunk boundaries the tests reason about are real (§8.4).
fn patternByte(i: usize) u8 {
    return support.keystreamByte(i);
}

fn fillPatternAt(buf: []u8, off: usize) void {
    support.fillKeystream(buf, off);
}

fn readFileAll(alloc: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = try std.Io.Dir.cwd().openFile(io, path, .{});
    defer file.close(io);
    const st = try file.stat(io);
    const buf = try alloc.alloc(u8, @intCast(st.size));
    var off: u64 = 0;
    while (off < buf.len) {
        const n = try std.Io.File.readPositionalAll(file, io, buf[@intCast(off)..], off);
        if (n == 0) break;
        off += n;
    }
    return buf[0..@intCast(off)];
}

/// A source tree in a temp dir and the pak packed from it — the VFS tests need
/// a *real* chain, so they go through the packer rather than a hand-built
/// fixture (§8.3).
const Packed = struct {
    tmp: std.testing.TmpDir,
    alloc: std.mem.Allocator,
    src: []const u8,
    out: []const u8,
    image: []u8 = &.{},

    fn init(alloc: std.mem.Allocator, sub: []const u8) !Packed {
        var p = Packed{ .tmp = std.testing.tmpDir(.{}), .alloc = alloc, .src = &.{}, .out = &.{} };
        p.src = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/{s}", .{ p.tmp.sub_path, sub });
        p.out = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/out.tns", .{p.tmp.sub_path});
        return p;
    }

    fn deinit(self: *Packed) void {
        self.alloc.free(self.image);
        self.alloc.free(self.src);
        self.alloc.free(self.out);
        self.tmp.cleanup();
    }

    /// Write one File of the pattern, pack the tree, and hold the pak bytes.
    /// Callable twice: the second call replaces the File and repacks.
    fn packOne(self: *Packed, name: []const u8, len: usize) !void {
        self.tmp.dir.createDirPath(io, "assets") catch |e| switch (e) {
            error.PathAlreadyExists => {},
            else => return e,
        };
        const payload = try self.alloc.alloc(u8, len);
        defer self.alloc.free(payload);
        fillPatternAt(payload, 0);
        var sub: [256]u8 = undefined;
        const sub_path = try std.fmt.bufPrint(&sub, "assets/{s}", .{name});
        try self.tmp.dir.writeFile(io, .{ .sub_path = sub_path, .data = payload });
        _ = try writer.pack(self.alloc, self.src, self.out, null);
        self.alloc.free(self.image);
        self.image = try readFileAll(self.alloc, self.out);
    }
};

/// The File offset each chunk starts at, discovered through the walker (§8.3):
/// the offsets at which `locate` moves to the next chunk. Chunk 0 starts at 0.
fn chunkStarts(
    alloc: std.mem.Allocator,
    wk: *const walk.Walker,
    file: walk.FileLocation,
    total: u32,
    count: u32,
) ![]u32 {
    const starts = try alloc.alloc(u32, count);
    starts[0] = 0;
    var found: u32 = 1;
    var off: u32 = 0;
    var here: u32 = 0;
    while (off < total and found < count) : (off += 1) {
        const q = try wk.locate(file, off);
        if (q.chunk_index != here) {
            starts[found] = off;
            found += 1;
            here = q.chunk_index;
        }
    }
    if (found != count) return error.ChainNotWalked;
    return starts;
}

/// Resolve a File's chain through the walker so the test can bound its reads.
fn chainOf(wk: *const walk.Walker, path: []const u8) !walk.Chain {
    const loc = try wk.resolve(path, .file);
    const stream = try wk.openData(loc);
    return switch (stream.location) {
        .chunked => |c| c,
        .single => error.ExpectedChunked,
    };
}

test "VFS reads across a chunk boundary" {
    const alloc = testing.allocator;
    var p = try Packed.init(alloc, "assets");
    defer p.deinit();
    const len: usize = 6000;
    try p.packOne("big.bin", len);

    var h: Harness = undefined;
    try openHarness(&h, p.image);
    const chain = try chainOf(&h.pak, "big.bin");
    try testing.expect(chain.chunk_count >= 2);
    const starts = try chunkStarts(alloc, &h.pak, .{ .chunked = chain }, chain.total_size, chain.chunk_count);
    defer alloc.free(starts);

    var expected: [len]u8 = undefined;
    fillPatternAt(&expected, 0);

    const fd = h.vfs.open("big.bin");
    try testing.expect(fd >= 1);
    // The last byte of chunk 0 and three of chunk 1, in one read.
    const at = starts[1] - 1;
    try testing.expectEqual(@as(i64, at), h.vfs.seek(fd, at, vfs_mod.SEEK_SET));
    var buf: [4]u8 = undefined;
    try testing.expectEqual(@as(i32, 4), h.vfs.read(fd, &buf));
    try testing.expectEqualSlices(u8, expected[at..][0..4], &buf);
    try testing.expectEqual(@as(i64, at + 4), h.vfs.tell(fd));
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
}

test "VFS reads a request spanning three chunks" {
    const alloc = testing.allocator;
    var p = try Packed.init(alloc, "assets");
    defer p.deinit();
    const len: usize = 6000;
    try p.packOne("big.bin", len);

    var h: Harness = undefined;
    try openHarness(&h, p.image);
    const chain = try chainOf(&h.pak, "big.bin");
    try testing.expect(chain.chunk_count >= 3);
    const starts = try chunkStarts(alloc, &h.pak, .{ .chunked = chain }, chain.total_size, chain.chunk_count);
    defer alloc.free(starts);

    var expected: [len]u8 = undefined;
    fillPatternAt(&expected, 0);

    // From the middle of chunk 0 into chunk 2: two boundaries in one call.
    const from: u32 = 2;
    const to: u32 = starts[2] + 1;
    const buf = try alloc.alloc(u8, to - from);
    defer alloc.free(buf);

    const fd = h.vfs.open("big.bin");
    try testing.expectEqual(@as(i64, from), h.vfs.seek(fd, from, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i32, @intCast(buf.len)), h.vfs.read(fd, buf));
    try testing.expectEqualSlices(u8, expected[from..to], buf);
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
}

test "VFS reads the last byte and reports end of file" {
    const alloc = testing.allocator;
    var p = try Packed.init(alloc, "assets");
    defer p.deinit();
    const len: usize = 6000;
    try p.packOne("big.bin", len);

    var h: Harness = undefined;
    try openHarness(&h, p.image);
    const chain = try chainOf(&h.pak, "big.bin");

    const fd = h.vfs.open("big.bin");
    const last = chain.total_size - 1;
    try testing.expectEqual(@as(i64, last), h.vfs.seek(fd, last, vfs_mod.SEEK_SET));
    var one: [1]u8 = undefined;
    try testing.expectEqual(@as(i32, 1), h.vfs.read(fd, &one));
    try testing.expectEqual(patternByte(last), one[0]);

    // At end of file a read is 0 bytes, not an error (§7.5).
    try testing.expectEqual(@as(i64, chain.total_size), h.vfs.seek(fd, chain.total_size, vfs_mod.SEEK_SET));
    try testing.expectEqual(@as(i32, 0), h.vfs.read(fd, &one));
    try testing.expectEqual(@as(i64, chain.total_size), h.vfs.tell(fd));
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
}

test "the chunk cache is per open: a cold seek walks, a warm seek does not" {
    const alloc = testing.allocator;
    var p = try Packed.init(alloc, "assets");
    defer p.deinit();
    const len: usize = 6000;
    try p.packOne("big.bin", len);

    var h: Harness = undefined;
    var rec: support.Recorder = undefined;
    try openHarnessRec(&h, p.image, &rec);
    const chain = try chainOf(&h.pak, "big.bin");
    try testing.expect(chain.chunk_count >= 4);

    const fd = h.vfs.open("big.bin");
    rec.reset(); // measure the seeks, not the open

    // Cold: the first navigation materializes the chain — block reads happen.
    const cold_at = chain.total_size - 5;
    try testing.expectEqual(@as(i64, cold_at), h.vfs.seek(fd, cold_at, vfs_mod.SEEK_SET));
    const cold = rec.count;
    var buf: [3]u8 = undefined;
    try testing.expectEqual(@as(i32, 3), h.vfs.read(fd, &buf));
    try testing.expectEqual(patternByte(cold_at), buf[0]);

    // Warm: the cache is in the handle, so a second seek walks nothing.
    rec.reset();
    const warm_at = chain.total_size - 9;
    try testing.expectEqual(@as(i64, warm_at), h.vfs.seek(fd, warm_at, vfs_mod.SEEK_SET));
    const warm = rec.count;
    try testing.expectEqual(@as(i32, 2), h.vfs.read(fd, buf[0..2]));
    try testing.expectEqual(patternByte(warm_at), buf[0]);
    try testing.expectEqual(patternByte(warm_at + 1), buf[1]);

    try testing.expect(cold > 0);
    try testing.expectEqual(@as(usize, 0), warm);
    std.debug.print("9c: cold seek {d} block reads, warm seek {d}\n", .{ cold, warm });
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
}

test "two handles on one File share no cache, and closing one spares the other" {
    const alloc = testing.allocator;
    var p = try Packed.init(alloc, "assets");
    defer p.deinit();
    const len: usize = 6000;
    try p.packOne("big.bin", len);

    var h: Harness = undefined;
    try openHarness(&h, p.image);
    const chain = try chainOf(&h.pak, "big.bin");
    const starts = try chunkStarts(alloc, &h.pak, .{ .chunked = chain }, chain.total_size, chain.chunk_count);
    defer alloc.free(starts);

    const fd1 = h.vfs.open("big.bin");
    const fd2 = h.vfs.open("big.bin");
    try testing.expect(fd1 != fd2);
    try testing.expect(fd1 >= 1 and fd2 >= 1);

    // Each handle materializes its own cache.
    const at1 = starts[1] + 1;
    try testing.expectEqual(@as(i64, at1), h.vfs.seek(fd1, at1, vfs_mod.SEEK_SET));
    const at2 = starts[1] + 2;
    try testing.expectEqual(@as(i64, at2), h.vfs.seek(fd2, at2, vfs_mod.SEEK_SET));
    var b1: [2]u8 = undefined;
    try testing.expectEqual(@as(i32, 2), h.vfs.read(fd1, &b1));
    try testing.expectEqual(patternByte(at1), b1[0]);
    try testing.expectEqual(patternByte(at1 + 1), b1[1]);

    // Closing the first frees only its own: the second still reads correctly.
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd1));
    try testing.expectEqual(@as(i32, EBADF), h.vfs.read(fd1, &b1));
    try testing.expectEqual(@as(i64, at2), h.vfs.seek(fd2, at2, vfs_mod.SEEK_SET));
    var b2: [3]u8 = undefined;
    try testing.expectEqual(@as(i32, 3), h.vfs.read(fd2, &b2));
    try testing.expectEqual(patternByte(at2), b2[0]);
    try testing.expectEqual(patternByte(at2 + 1), b2[1]);
    try testing.expectEqual(patternByte(at2 + 2), b2[2]);
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd2));
}

test "a chain past the cache cap is re-walked per navigation, never cached" {
    const alloc = testing.allocator;
    var p = try Packed.init(alloc, "assets");
    defer p.deinit();

    // Measure this pak's chunk payload on a small File, then size the big File
    // to need more chunks than the cache cap allows (§8.3).
    try p.packOne("probe.bin", 6000);
    {
        var h: Harness = undefined;
        try openHarness(&h, p.image);
        const chain = try chainOf(&h.pak, "probe.bin");
        const starts = try chunkStarts(alloc, &h.pak, .{ .chunked = chain }, chain.total_size, chain.chunk_count);
        defer alloc.free(starts);
        try testing.expect(chain.chunk_count >= 3);
        // Chunk 0 carries less than a continuation (its head is longer), so the
        // continuation's payload is what sizes the chain: one chunk 0, then
        // MAX_FILE_CHUNKS + 1 chunks' worth of payload past the cap.
        const first_payload: usize = starts[1];
        const cont_payload: usize = starts[2] - starts[1];
        const big: usize = first_payload + (@as(usize, vfs_mod.MAX_FILE_CHUNKS) + 2) * cont_payload;
        try p.packOne("huge.bin", big);
    }

    var h: Harness = undefined;
    try openHarness(&h, p.image);
    const chain = try chainOf(&h.pak, "huge.bin");
    try testing.expect(chain.chunk_count > vfs_mod.MAX_FILE_CHUNKS);

    const fd = h.vfs.open("huge.bin");
    try testing.expect(fd >= 1);
    // The policy: too long to cache, so nothing is held for this handle.
    try testing.expect(h.vfs.fds[@intCast(fd - 1)].spans == null);

    // Reading deep in the File still returns the right bytes — the walker is
    // re-walked per navigation, which is the documented cost.
    const at: u32 = 1; // one byte into chunk 0, then jump far
    try testing.expectEqual(@as(i64, at), h.vfs.seek(fd, at, vfs_mod.SEEK_SET));
    var one: [1]u8 = undefined;
    try testing.expectEqual(@as(i32, 1), h.vfs.read(fd, &one));
    try testing.expectEqual(patternByte(at), one[0]);

    const far: u32 = chain.total_size - 2;
    try testing.expectEqual(@as(i64, far), h.vfs.seek(fd, far, vfs_mod.SEEK_SET));
    var tail: [2]u8 = undefined;
    try testing.expectEqual(@as(i32, 2), h.vfs.read(fd, &tail));
    try testing.expectEqual(patternByte(far), tail[0]);
    try testing.expectEqual(patternByte(far + 1), tail[1]);
    try testing.expect(h.vfs.fds[@intCast(fd - 1)].spans == null);
    try testing.expectEqual(@as(i32, 0), h.vfs.close(fd));
}
