//! `zig build prune-report` — the phase-4 measurement table: for each probe
//! path, the bytes the walker read (total and distinct), the 8 KiB pages those
//! bytes touched, and whether any byte fell inside a sibling's ranges.

const std = @import("std");
const res = @import("src/root.zig");
const support = @import("test/prune_support.zig");
const walk = res.walk;

const PAGE_SIZE: usize = 8192;

var big_nodes: [120_000]support.Node = undefined;
var big_image: [26 * 1024 * 1024]u8 = undefined;
var big_names: [2 * 1024 * 1024]u8 = undefined;
var big_payloads: [2 * 1024 * 1024]u8 = undefined;
var big_siblings: [2 * 120_000]support.Range = undefined;

var small_nodes: [4_000]support.Node = undefined;
var small_image: [2 * 1024 * 1024]u8 = undefined;
var small_names: [256 * 1024]u8 = undefined;
var small_payloads: [256 * 1024]u8 = undefined;

var page_bits: [4096]u64 = undefined;
var scratch: [support.MAX_LOG]support.Range = undefined;

const Row = struct {
    fixture: []const u8,
    path: []const u8,
    bytes_total: u64,
    bytes_distinct: u64,
    pages: u32,
    sibling_hits: u32,
    result: []const u8,
};

fn run(tree: *const support.Tree, rec: *support.Recorder, path: []const u8) Row {
    rec.inner = .{ .bytes = tree.image[0..tree.image_len] };
    rec.reset();
    var row = Row{
        .fixture = "",
        .path = path,
        .bytes_total = 0,
        .bytes_distinct = 0,
        .pages = 0,
        .sibling_hits = 0,
        .result = "ok",
    };
    const w = walk.Walker.init(tree.image[0..tree.image_len], rec.reader()) catch |e| {
        row.result = @errorName(e);
        const m = support.measure(rec, PAGE_SIZE, &page_bits, &scratch);
        row.bytes_total = m.bytes_total;
        row.bytes_distinct = m.bytes_distinct;
        row.pages = m.pages;
        return row;
    };
    if (w.lookup(path)) |loc| {
        row.result = if (loc.kind == .directory) "dir" else "file";
    } else |e| {
        row.result = @errorName(e);
    }
    const m = support.measure(rec, PAGE_SIZE, &page_bits, &scratch);
    row.bytes_total = m.bytes_total;
    row.bytes_distinct = m.bytes_distinct;
    row.pages = m.pages;
    return row;
}

fn siblingHitsFor(tree: *const support.Tree, rec: *const support.Recorder, path_ids: []const usize, ranges: []support.Range) u32 {
    const sib = support.siblingRanges(tree, path_ids, ranges);
    return support.siblingHits(rec, sib, &scratch);
}

pub fn main() !void {
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

    std.debug.print("fixture  path                 bytes_total  distinct   pages  sib_hits  result\n", .{});
    std.debug.print("-------  -----------------  -----------  --------  -----  --------  --------\n", .{});

    var r = run(&small, &rec, "/a/b/c/d/e/f");
    printRow("small", r, 0);
    r = run(&small, &rec, "/a/b");
    printRow("small", r, 0);

    r = run(&big, &rec, "/a/b");
    printRow("large", r, 0);
    r = run(&big, &rec, "/a/b/c/d/e/f/absent");
    printRow("large", r, 0);

    // The target lookup runs last so its recorded log is the one inspected.
    r = run(&big, &rec, "/a/b/c/d/e/f");
    var path_ids: [8]usize = undefined;
    const paths = [_][]const u8{ "", "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f" };
    var n: usize = 0;
    for (paths) |p| {
        path_ids[n] = big.find(p) orelse break;
        n += 1;
    }
    const hits = siblingHitsFor(&big, &rec, path_ids[0..n], &big_siblings);
    printRow("large", r, hits);

    // Diagnostics: the first few recorded ranges that land in sibling bytes.
    {
        const sib = support.siblingRanges(&big, path_ids[0..n], &big_siblings);
        var shown: usize = 0;
        for (rec.log[0..rec.count]) |rr| {
            const r_end = rr.off + rr.len;
            for (sib) |sr| {
                if (sr.off < r_end and rr.off < sr.off + sr.len) {
                    if (shown < 8) {
                        std.debug.print("  overlap: read off={d} len={d} vs sibling off={d} len={d}\n", .{ rr.off, rr.len, sr.off, sr.len });
                        shown += 1;
                    }
                    break;
                }
            }
        }
        std.debug.print("  (total recorded ranges: {d})\n", .{rec.count});
    }

    std.debug.print("\nlarge fixture: {d} bytes, {d} nodes (built at test time, deterministic)\n", .{ big.image_len, big.count });
    std.debug.print("small fixture: {d} bytes, {d} nodes\n", .{ small.image_len, small.count });
    std.debug.print("sibling ranges checked: {d}\n", .{support.siblingRanges(&big, path_ids[0..n], &big_siblings).len});
}

fn printRow(fixture: []const u8, r: Row, sibling_hits: u32) void {
    std.debug.print("{s: <7}  {s: <19}  {d: >11}  {d: >8}  {d: >5}  {d: >8}  {s}\n", .{
        fixture, r.path, r.bytes_total, r.bytes_distinct, r.pages, sibling_hits, r.result,
    });
}
