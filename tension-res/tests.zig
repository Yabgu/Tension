//! Aggregating test root for `zig build test`.
//!
//! Zig runs test declarations only for files it analyses in the test root's
//! own module, so this file lives at the package root (making `src/` and
//! `test/` both reachable), forces the library's declarations to be analysed
//! (`refAllDeclsRecursive` — that is what pulls in the `test` blocks written
//! inside `src/*.zig`), and then includes the two test suites.
const std = @import("std");
const res = @import("src/root.zig");

test {
    std.testing.refAllDecls(res);
    _ = @import("test/fields_test.zig");
    _ = @import("test/metadata_test.zig");
    _ = @import("test/index_test.zig");
    _ = @import("test/walk_test.zig");
    _ = @import("test/prune_test.zig");
    _ = @import("test/vfs_test.zig");
    _ = @import("test/c_api_test.zig");
    _ = @import("test/writer_test.zig");
    _ = @import("test/size_test.zig");
}
