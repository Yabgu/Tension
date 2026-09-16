//! Phase 4's load-bearing test: the five pruning assertions on the ~112 000
//! entry fixture and its ~1 400 entry twin.
//!
//! Measurement discipline: fixture generation happens before the measured
//! lookup; only the `BlockReader` calls made by `Walker.lookup` are recorded.

const std = @import("std");
const res = @import("../src/root.zig");
const support = @import("prune_support.zig");
const walk = res.walk;
const fields = res.fields;
const metadata = res.metadata;
const testing = std.testing;

const PAGE_SIZE: usize = 8192;

// Large fixture workspaces (statics: these are tens of MB).
var big_nodes: [120_000]support.Node = undefined;
var big_image: [26 * 1024 * 1024]u8 = undefined;
var big_names: [2 * 1024 * 1024]u8 = undefined;
var big_payloads: [2 * 1024 * 1024]u8 = undefined;
var big_siblings: [2 * 120_000]support.Range = undefined;

// Small twin.
var small_nodes: [4_000]support.Node = undefined;
var small_image: [2 * 1024 * 1024]u8 = undefined;
var small_names: [256 * 1024]u8 = undefined;
var small_payloads: [256 * 1024]u8 = undefined;

// Instrumentation scratch.
var page_bits: [4096]u64 = undefined; // up to 32 MiB at 8 KiB pages
var scratch: [support.MAX_LOG]support.Range = undefined;

const Outcome = struct {
    metrics: support.Metrics = .{},
    err: ?walk.WalkError = null,
    loc: walk.Location = undefined,
    ok: bool = false,
};

fn runLookup(tree: *const support.Tree, rec: *support.Recorder, path: []const u8) Outcome {
    var out = Outcome{};
    rec.inner = .{ .bytes = tree.image[0..tree.image_len] };
    rec.reset();
    const w = walk.Walker.init(tree.image[0..tree.image_len], rec.reader()) catch |e| {
        out.err = e;
        out.metrics = support.measure(rec, PAGE_SIZE, &page_bits, &scratch);
        return out;
    };
    const loc = w.lookup(path) catch |e| {
        out.err = e;
        out.metrics = support.measure(rec, PAGE_SIZE, &page_bits, &scratch);
        return out;
    };
    out.loc = loc;
    out.ok = true;
    out.metrics = support.measure(rec, PAGE_SIZE, &page_bits, &scratch);
    return out;
}

fn ceilLog2(n: usize) u32 {
    var bits: u32 = 0;
    var x: usize = 1;
    while (x < n) : (x *= 2) bits += 1;
    return bits;
}

fn collectPathIds(tree: *const support.Tree, paths: []const []const u8, out: []usize) usize {
    var n: usize = 0;
    for (paths) |p| {
        out[n] = tree.find(p) orelse return n;
        n += 1;
    }
    return n;
}

fn tableEnd(data: []const u8, fid: fields.Fid) !usize {
    var t = try metadata.Table.init(data, fid);
    while (try t.next()) |_| {}
    return t.cursor.pos;
}

/// The payload Stream bytes of a File record (test-side, direct image access).
fn payloadAt(image: []const u8, file_abs: usize) ![]const u8 {
    var at = file_abs;
    at += try tableEnd(image[at..], fields.FILE_HEADER);
    at += try tableEnd(image[at..], fields.FILE_INFORMATION);
    at += try tableEnd(image[at..], fields.SOURCE_FILE_HEADER);
    at += try tableEnd(image[at..], fields.PATH);
    at += try tableEnd(image[at..], fields.CHARACTERISTICS);
    const sh = try metadata.parseStreamHeader(image[at..]);
    at += sh.consumed;
    return image[at..][0..@intCast(sh.stream_size.?)];
}

test "the five pruning assertions" {
    var big = try support.buildLarge(.{
        .nodes = &big_nodes,
        .image = &big_image,
        .names = &big_names,
        .payloads = &big_payloads,
    });
    var small = try support.buildSmall(.{
        .nodes = &small_nodes,
        .image = &small_image,
        .names = &small_names,
        .payloads = &small_payloads,
    });

    var rec = support.Recorder{ .inner = .{ .bytes = big_image[0..] } };

    // Measure (big6 last so its log is the one we inspect for siblings).
    const big2 = runLookup(&big, &rec, "/a/b");
    const small6 = runLookup(&small, &rec, "/a/b/c/d/e/f");
    const big6 = runLookup(&big, &rec, "/a/b/c/d/e/f");

    std.debug.print(
        "prune: large target  bytes_total={d} distinct={d} pages={d}\n" ++
            "prune: large /a/b     bytes_total={d} distinct={d} pages={d}\n" ++
            "prune: small target  bytes_total={d} distinct={d} pages={d}\n",
        .{
            big6.metrics.bytes_total,     big6.metrics.bytes_distinct,   big6.metrics.pages,
            big2.metrics.bytes_total,     big2.metrics.bytes_distinct,   big2.metrics.pages,
            small6.metrics.bytes_total,   small6.metrics.bytes_distinct, small6.metrics.pages,
        },
    );

    // Assertion #5 first: the walk must be right before its cost matters.
    try testing.expect(big6.ok);
    try testing.expect(small6.ok);
    try testing.expectEqualStrings("f", big6.loc.name);
    try testing.expectEqual(@as(u32, support.CHAIN_TARGET_PAYLOAD.len), big6.loc.size);
    const target_node = big.find("/a/b/c/d/e/f").?;
    const target_abs: usize = @intCast(big.nodes[target_node].abs);
    const payload = try payloadAt(big.image[0..big.image_len], target_abs);
    try testing.expectEqualStrings(support.CHAIN_TARGET_PAYLOAD, payload);
    var hash: u64 = 0xcbf29ce484222325;
    for (payload) |byte| {
        hash ^= byte;
        hash *%= 0x100000001b3;
    }
    std.debug.print("prune: assertion #5 payload {d} bytes, fnv1a64=0x{X:0>16}\n", .{ payload.len, hash });

    // Assertion #1: working set bound (≤ 64 KiB).
    std.debug.print("prune: assertion #1 distinct bytes {d} (bound 65536)\n", .{big6.metrics.bytes_distinct});
    try testing.expect(big6.metrics.bytes_distinct <= 64 * 1024);

    // Assertion #2: no sibling bytes (strict).
    var path_ids: [8]usize = undefined;
    const path = [_][]const u8{ "", "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f" };
    const n_path = collectPathIds(&big, &path, &path_ids);
    try testing.expectEqual(@as(usize, 7), n_path);
    const sib = support.siblingRanges(&big, path_ids[0..n_path], &big_siblings);
    const hits = support.siblingHits(&rec, sib, &scratch);
    std.debug.print("prune: assertion #2 sibling ranges {d}, hits {d}\n", .{ sib.len, hits });
    try testing.expectEqual(@as(u32, 0), hits);

    // Assertion #3 (amended 2026-09-16, log-slack form):
    // pages(large) <= pages(small) + (ceilLog2 N_large - ceilLog2 N_small) + 2.
    const n_large: usize = big.children(big.find("/a/b/c/d/e").?).len;
    const n_small: usize = small.children(small.find("/a/b/c/d/e").?).len;
    const log_slack: u32 = ceilLog2(n_large) - ceilLog2(n_small);
    const page_bound: u32 = small6.metrics.pages + log_slack + 2;
    std.debug.print(
        "prune: assertion #3 pages large {d} vs small {d} + log slack {d} + 2 = {d}\n",
        .{ big6.metrics.pages, small6.metrics.pages, log_slack, page_bound },
    );
    try testing.expect(big6.metrics.pages <= page_bound);

    // Assertion #4: depth proportionality (depth 6 ≈ 3× depth 2).
    const ratio = @as(f64, @floatFromInt(big6.metrics.bytes_distinct)) /
        @as(f64, @floatFromInt(@max(big2.metrics.bytes_distinct, 1)));
    std.debug.print("prune: assertion #4 depth-6/depth-2 byte ratio {d:.2}\n", .{ratio});
    try testing.expect(ratio >= 2.0 and ratio <= 5.0); // amended 2026-09-16
    try testing.expect(big6.metrics.bytes_distinct < big.image_len / 100);
}
