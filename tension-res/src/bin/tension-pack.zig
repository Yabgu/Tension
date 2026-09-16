//! tension-pack — the packer's command line frontend (DESIGN.md §8.2).
//!
//!     tension-pack <source-dir> [-o output.tns] [-v]
//!     tension-pack --help
//!     tension-pack --version
//!
//! The default output path is `<source-dir>.tns`. `-v` reports every directory
//! as it is walked. Exit codes: 0 packed, 1 the pack failed, 2 bad usage.
//!
//! This binary links the same `writer.pack` that `tension_res_pack` (the C ABI)
//! exposes — one implementation, two frontends; there is no second packer.

const std = @import("std");
const res = @import("tension_res");

const USAGE =
    \\usage: tension-pack <source-dir> [-o output.tns] [-v]
    \\
    \\  -o <PATH>     write the pak here (default: <source-dir>.tns)
    \\  -v, --verbose report every directory as it is walked
    \\  -h, --help    print this help
    \\  --version     print the version
    \\
    \\The source directory becomes the pak's root directory File; its children
    \\are packed in NS1 byte order, with the layout of DESIGN.md §8.2.
    \\
;

fn emit(io: std.Io, bytes: []const u8) void {
    var buf: [4096]u8 = undefined;
    var w = std.Io.File.stdout().writer(io, &buf);
    w.interface.writeAll(bytes) catch {};
    w.interface.flush() catch {};
}

const Verbose = struct {
    count: usize = 0,

    fn onDir(ctx: *anyopaque, path: []const u8, children: usize) void {
        const self: *Verbose = @alignCast(@ptrCast(ctx));
        self.count += 1;
        std.debug.print("pack: {s} ({d} children)\n", .{ path, children });
    }

    fn progress(self: *Verbose) res.writer.Progress {
        return .{ .ctx = @ptrCast(self), .on_directory = onDir };
    }
};

pub fn main(init: std.process.Init) !u8 {
    const a = init.arena.allocator();
    const io = init.io;
    const argv = std.process.Args.toSlice(init.minimal.args, a) catch {
        std.debug.print("tension-pack: could not read the command line\n", .{});
        return 1;
    };

    var source: ?[]const u8 = null;
    var out_path: ?[]const u8 = null;
    var verbose = false;

    var i: usize = 1;
    while (i < argv.len) : (i += 1) {
        const arg = argv[i];
        if (std.mem.eql(u8, arg, "-h") or std.mem.eql(u8, arg, "--help")) {
            emit(io, USAGE);
            return 0;
        }
        if (std.mem.eql(u8, arg, "--version")) {
            emit(io, "tension-pack 0.1.0 (ECMA-208 SIDF packer)\n");
            return 0;
        }
        if (std.mem.eql(u8, arg, "-v") or std.mem.eql(u8, arg, "--verbose")) {
            verbose = true;
            continue;
        }
        if (std.mem.eql(u8, arg, "-o")) {
            i += 1;
            if (i >= argv.len) {
                std.debug.print("tension-pack: -o needs a path\n\n{s}", .{USAGE});
                return 2;
            }
            out_path = argv[i];
            continue;
        }
        if (std.mem.startsWith(u8, arg, "-o=")) {
            out_path = arg[3..];
            continue;
        }
        if (arg.len > 1 and arg[0] == '-') {
            std.debug.print("tension-pack: unknown option `{s}`\n\n{s}", .{ arg, USAGE });
            return 2;
        }
        if (source != null) {
            std.debug.print("tension-pack: only one source directory is packed at a time\n\n{s}", .{USAGE});
            return 2;
        }
        source = arg;
    }

    const src = source orelse {
        std.debug.print("tension-pack: missing <source-dir>\n\n{s}", .{USAGE});
        return 2;
    };
    const dest = out_path orelse try std.fmt.allocPrint(a, "{s}.tns", .{src});

    var hook = Verbose{};
    const stats = res.writer.pack(a, src, dest, if (verbose) hook.progress() else null) catch |e| {
        std.debug.print("tension-pack: {s}: {s}\n", .{ src, @errorName(e) });
        return 1;
    };

    if (verbose) {
        std.debug.print(
            "pack: {d} directories, {d} files, {d} bytes -> {s}\n",
            .{ stats.directories, stats.files, stats.bytes, dest },
        );
    } else {
        emit(io, try std.fmt.allocPrint(a, "packed {s} -> {s} ({d} bytes, {d} files, {d} directories)\n", .{
            src, dest, stats.bytes, stats.files, stats.directories,
        }));
    }
    return 0;
}
