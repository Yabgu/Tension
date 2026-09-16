//! C ABI tests (phase 6): the boundary over the committed minimal fixture.
//!
//! The fixture is embedded at compile time, so the test is independent of the
//! working directory (`@embedFile` resolves next to this source file).
//!
//! Flow under test: load → stat "/" → readdir "/" → open "hello.txt" → read 6
//! → "hello\n" → seek/tell → stat_fd → close → free, for both load variants.

const std = @import("std");
const res = @import("../src/root.zig");
const c_api = res.c_api;
const tension_res = c_api.tension_res;
const Stat = c_api.Stat;
const testing = std.testing;

const FIXTURE = @embedFile("fixtures/minimal.sidf");
const PAYLOAD = "hello\n";
const CHILD = "hello.txt";

const ENOENT: i32 = -2;
const EBADF: i32 = -9;
const EINVAL: i32 = -22;
const ENOSYS: i32 = -38;

fn openFixture(borrowed: bool, err: []u8) !*tension_res {
    var handle: ?*tension_res = null;
    const rc = if (borrowed)
        c_api.tension_res_load_borrowed(FIXTURE.ptr, FIXTURE.len, &handle, err.ptr, err.len)
    else
        c_api.tension_res_load(FIXTURE.ptr, FIXTURE.len, &handle, err.ptr, err.len);
    if (rc != 0) {
        std.debug.print("load failed: {d} {s}\n", .{ rc, err });
        return error.LoadFailed;
    }
    return handle orelse error.NoHandle;
}

fn exercise(handle: *tension_res) !void {
    // stat "/" — the root is a directory.
    var rec: Stat = undefined;
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_stat(handle, "/", 1, &rec));
    try testing.expectEqual(@as(u32, 1), rec.kind);
    try testing.expectEqual(@as(u32, 0), rec.size);
    try testing.expectEqual(@as(u32, 0), rec.flags);

    // readdir "/" — one child, raw name (no suffix), reported by kind.
    var name: [64]u8 = undefined;
    const n = c_api.tension_res_readdir(handle, "/", 1, 0, name[0..].ptr, name.len, &rec);
    try testing.expectEqual(@as(i32, CHILD.len), n);
    try testing.expectEqualStrings(CHILD, name[0..@intCast(n)]);
    try testing.expectEqual(@as(u32, 0), rec.kind); // a file
    try testing.expectEqual(@as(u32, PAYLOAD.len), rec.size);
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_readdir(handle, "/", 1, 1, name[0..].ptr, name.len, &rec));
    // A size probe writes nothing and still reports the length.
    try testing.expectEqual(@as(i32, CHILD.len), c_api.tension_res_readdir(handle, "/", 1, 0, null, 0, &rec));

    // open / read / tell / seek / stat_fd.
    const fd = c_api.tension_res_open(handle, "hello.txt", CHILD.len);
    try testing.expect(fd >= 1);
    var buf: [64]u8 = undefined;
    try testing.expectEqual(@as(i64, 0), c_api.tension_res_tell(handle, fd));
    try testing.expectEqual(@as(i32, PAYLOAD.len), c_api.tension_res_read(handle, fd, buf[0..].ptr, PAYLOAD.len));
    try testing.expectEqualStrings(PAYLOAD, buf[0..PAYLOAD.len]);
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_read(handle, fd, buf[0..].ptr, buf.len)); // EOF
    try testing.expectEqual(@as(i64, 0), c_api.tension_res_seek(handle, fd, 0, 0));
    try testing.expectEqual(@as(i64, 6), c_api.tension_res_seek(handle, fd, 0, 2)); // END
    try testing.expectEqual(@as(i64, 4), c_api.tension_res_seek(handle, fd, -2, 1)); // CUR
    try testing.expectEqual(@as(i32, 2), c_api.tension_res_read(handle, fd, buf[0..].ptr, buf.len));
    try testing.expectEqualStrings("o\n", buf[0..2]);
    var by_fd: Stat = undefined;
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_stat_fd(handle, fd, &by_fd));
    try testing.expectEqual(rec.kind, by_fd.kind);
    try testing.expectEqual(rec.size, by_fd.size);
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_close(handle, fd));
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_close(handle, fd)); // idempotent
    try testing.expectEqual(EBADF, c_api.tension_res_read(handle, fd, buf[0..].ptr, buf.len));
    try testing.expectEqual(@as(i64, EBADF), c_api.tension_res_tell(handle, fd));

    // Errors, not crashes: missing path, directory open, bad whence, bad fd.
    try testing.expectEqual(ENOENT, c_api.tension_res_open(handle, "nope", 4));
    try testing.expectEqual(@as(i32, -21), c_api.tension_res_open(handle, "/", 1));
    try testing.expectEqual(@as(i64, EINVAL), c_api.tension_res_seek(handle, 1, 0, 9));
    try testing.expectEqual(EBADF, c_api.tension_res_close(handle, 0));

    // Path boundary: NUL bytes are a malformed path, an over-long claim is too.
    try testing.expectEqual(EINVAL, c_api.tension_res_open(handle, "a\x00b", 3));
    try testing.expectEqual(EINVAL, c_api.tension_res_open(handle, "hello.txt", c_api.PATH_MAX + 1));
    // The empty path is the root, not an error.
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_stat(handle, null, 0, &rec));
    try testing.expectEqual(@as(u32, 1), rec.kind);
}

test "the C ABI drives the fixture end to end (owned load)" {
    var err: [128]u8 = undefined;
    const handle = try openFixture(false, &err);
    defer c_api.tension_res_free(handle);
    try exercise(handle);
}

test "the C ABI drives the fixture end to end (borrowed load)" {
    var err: [128]u8 = undefined;
    const handle = try openFixture(true, &err);
    defer c_api.tension_res_free(handle);
    try exercise(handle);
    // The borrowed handle serves the caller's bytes, not a copy.
    try testing.expect(handle.served.ptr == FIXTURE.ptr);
}

test "owned and borrowed handles are independent at the same time" {
    var err: [128]u8 = undefined;
    const a = try openFixture(false, &err);
    defer c_api.tension_res_free(a);
    const b = try openFixture(true, &err);
    defer c_api.tension_res_free(b);
    try testing.expect(a != b);
    try testing.expect(a.owned != null);
    try testing.expect(b.owned == null);
    // Interleaved use: separate fd tables (so both handles can hand out the
    // same fd number) and separate readdir cursors.
    const fa = c_api.tension_res_open(a, CHILD, CHILD.len);
    const fb = c_api.tension_res_open(b, CHILD, CHILD.len);
    try testing.expect(fa >= 1 and fb >= 1);
    try testing.expectEqual(fa, fb); // per-handle tables, not a global one
    var buf: [8]u8 = undefined;
    try testing.expectEqual(@as(i32, 3), c_api.tension_res_read(a, fa, buf[0..].ptr, 3));
    try testing.expectEqual(@as(i64, 3), c_api.tension_res_tell(a, fa));
    try testing.expectEqual(@as(i64, 0), c_api.tension_res_tell(b, fb));
    var rec: Stat = undefined;
    var name: [32]u8 = undefined;
    try testing.expectEqual(@as(i32, CHILD.len), c_api.tension_res_readdir(b, "/", 1, 0, name[0..].ptr, name.len, &rec));
    try testing.expectEqual(@as(i32, CHILD.len), c_api.tension_res_readdir(a, "/", 1, 0, name[0..].ptr, name.len, &rec));
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_close(a, fa));
    try testing.expectEqual(@as(i32, 0), c_api.tension_res_close(b, fb));
}

test "truncation: load fails when the structures it reads are damaged" {
    var err: [128]u8 = undefined;
    // 100 bytes: the Volume Header parses (or not), but the File Set Header at
    // sector 1 is unreachable — a load-time failure.
    var h: ?*tension_res = null;
    try testing.expect(c_api.tension_res_load(FIXTURE.ptr, 100, &h, err[0..].ptr, err.len) < 0);
    try testing.expect(h == null);

    // Every cut either fails to load, or loads a handle whose root still
    // answers. A cut inside the root's index Stream (which `init` parses) must
    // fail; a cut inside trailing blank space is invisible to a reader that
    // validates what it reads and nothing more (DESIGN.md §6.8) — the damage
    // surfaces at read time, never as a panic and never as a wrong answer.
    var cut: usize = 200;
    var failed: usize = 0;
    var loaded: usize = 0;
    while (cut < FIXTURE.len) : (cut += 997) {
        var handle: ?*tension_res = null;
        const rc = c_api.tension_res_load(FIXTURE.ptr, cut, &handle, err[0..].ptr, err.len);
        if (rc == 0) {
            const got = handle orelse return error.NullHandle;
            var rec: Stat = undefined;
            try testing.expectEqual(@as(i32, 0), c_api.tension_res_stat(got, "/", 1, &rec));
            try testing.expectEqual(@as(u32, 1), rec.kind);
            c_api.tension_res_free(got);
            loaded += 1;
        } else {
            try testing.expect(handle == null);
            failed += 1;
        }
    }
    std.debug.print("c_api: truncation sweep over {d} cuts: {d} rejected, {d} readable\n", .{ failed + loaded, failed, loaded });
    try testing.expect(failed > 0);

    // Freeing NULL is a no-op (the header promises it).
    c_api.tension_res_free(null);

    // The packer is wired to the writer now: a missing source is -ENOENT with
    // a message, and a null argument is -EINVAL. (The real packing path is
    // covered by writer_test.zig.)
    var msg: [128]u8 = undefined;
    const out_path: [*:0]const u8 = "out.tns";
    const missing_src: [*:0]const u8 = "no-such-source-dir";
    try testing.expectEqual(ENOENT, c_api.tension_res_pack(missing_src, out_path, msg[0..].ptr, msg.len));
    try testing.expect(msg[0] != 0);
    try testing.expectEqual(EINVAL, c_api.tension_res_pack(null, out_path, msg[0..].ptr, msg.len));
}
