const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // The library module: the C ABI is the library's entire product, so the
    // compilation root is `c_api.zig` itself. Zig analyses declarations lazily,
    // and a module rooted at `root.zig` (which only *names* `c_api`) would emit
    // an archive with the ABI's `export fn`s never reached — an empty library
    // that links but cannot resolve a single symbol.
    const res_mod = b.createModule(.{
        .root_source_file = b.path("src/c_api.zig"),
        .target = target,
        .optimize = optimize,
        // Position-independent: the Rust host links a PIE, and an absolute
        // 32-bit relocation from a non-PIC archive cannot be linked into one.
        .pic = true,
    });

    const lib = b.addLibrary(.{
        .name = "tension_res",
        .root_module = res_mod,
        .linkage = .static,
    });
    // A static library does not bundle compiler-rt by default, and the Rust
    // host links with a plain `cc` — so `__zig_probe_stack` (and friends) would
    // be undefined at the final link. Bundle it: the archive must be
    // self-contained, because the linker on the other side is not Zig.
    lib.bundle_compiler_rt = true;
    b.installArtifact(lib);

    // The Zig-facing module: the whole of `src/` rooted at `root.zig`, with no
    // C ABI. Tooling that parses the format in-process (the fixture generator)
    // imports this one; the installable artifact is the C ABI above.
    const zig_mod = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Unit tests (`zig build test`): one aggregating root at the package root
    // so that tests inside src/*.zig and test/*.zig all belong to the same
    // module (tests are only collected from the test root's own module).
    const test_mod = b.createModule(.{
        .root_source_file = b.path("tests.zig"),
        .target = target,
        .optimize = optimize,
    });
    const unit_tests = b.addTest(.{ .root_module = test_mod });
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);


    // The packer's CLI (`zig build` also installs zig-out/bin/tension-pack):
    // a thin frontend over the same `writer.pack` the C ABI exposes.
    const pack_cli_mod = b.createModule(.{
        .root_source_file = b.path("src/bin/tension-pack.zig"),
        .target = target,
        .optimize = optimize,
    });
    pack_cli_mod.addImport("tension_res", zig_mod);
    const pack_cli = b.addExecutable(.{ .name = "tension-pack", .root_module = pack_cli_mod });
    b.installArtifact(pack_cli);

    // Prune report (`zig build prune-report`): the phase-4 measurement table.
    const report_mod = b.createModule(.{
        .root_source_file = b.path("prune_report.zig"),
        .target = target,
        .optimize = optimize,
    });
    const report = b.addExecutable(.{ .name = "prune-report", .root_module = report_mod });
    const run_report = b.addRunArtifact(report);
    const report_step = b.step("prune-report", "Print the phase-4 pruning measurement table");
    report_step.dependOn(&run_report.step);

    // Fixture generator (`zig build fixture`): rewrites test/fixtures/minimal.sidf.
    const gen_mod = b.createModule(.{
        .root_source_file = b.path("test/fixtures/generate.zig"),
        .target = target,
        .optimize = optimize,
    });
    gen_mod.addImport("tension_res", zig_mod);
    const gen = b.addExecutable(.{ .name = "generate-fixture", .root_module = gen_mod });
    const run_gen = b.addRunArtifact(gen);
    const fixture_step = b.step("fixture", "Regenerate test/fixtures/minimal.sidf");
    fixture_step.dependOn(&run_gen.step);
}
