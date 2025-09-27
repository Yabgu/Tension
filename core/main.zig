const std = @import("std");
const engine = @import("engine.zig");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var game_engine = try engine.Engine.init(allocator);
    defer game_engine.deinit();

    try game_engine.run();
}