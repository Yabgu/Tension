//! Build script: compile the Zig resource library (tension-res/) and link it
//! into this crate.
//!
//! The reader/writer/VFS live in Zig; this crate only ever calls the C ABI in
//! `tension-res/include/tension_res.h`. The static archive is installed into
//! `tension-res/zig-out/lib/libtension_res.a` by `zig build`, and the link
//! directives below are emitted for every target in this package (the binary
//! and the integration tests alike).
//!
//! Zig has a **floor, not a pin**: 0.16 is the oldest series that builds
//! tension-res, and every later series is accepted. A newer toolchain is a
//! deliberate choice — the resource source is kept building on it (0.18 removed
//! `**`, `Allocator.dupeZ` and `std.fmt.bufPrintZ`, none of which this tree
//! uses any more). A version *older* than the floor is the exception: it warns
//! and the build continues, because the Zig compiler is the real gate (the
//! resource source uses APIs 0.16 introduced, so an older compiler refuses the
//! source itself with a better message than this check can give).
//! `TENSION_ALLOW_UNPINNED=1` acknowledges a below-floor toolchain: it silences
//! the warning for whichever floor is involved.
//!
//! The same pattern runs for tension-solver: its Fortran core is built by
//! the recipe below (which pins the determinism flags) and linked
//! as `libtension_solver.a`, with the Fortran runtime on the link line.
//! gfortran has a floor too — 14.0, for the same reason: the numerical core's
//! results are compiled, and a different compiler is a different contract
//! (`tension-solver/DESIGN.md` §5).

use std::path::PathBuf;
use std::process::Command;

/// The oldest Zig that builds `tension-res`: this series **and every later one**
/// are accepted. Compare with [`version_at_least`], which reads only major.minor
/// so a dev build's suffix (`0.18.0-dev.131+41f885830`) compares as 0.18.
const MIN_ZIG: (u64, u64) = (0, 16);
/// The oldest gfortran whose numerical results this tree accepts, for the same
/// reason the Zig floor exists: the solver's core is compiled, and a different
/// compiler is a different contract (`tension-solver/DESIGN.md` §5). 14.0 is the floor that
/// covers the distributions this tree is built on; newer series are welcome.
const MIN_GFORTRAN: (u64, u64) = (14, 0);

fn main() {
    let manifest = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"),
    );
    let res_dir = manifest
        .parent()
        .expect("tension-core lives next to tension-res")
        .join("tension-res");

    println!("cargo:rerun-if-changed={}", res_dir.join("build.zig").display());
    println!("cargo:rerun-if-changed={}", res_dir.join("src").display());
    println!("cargo:rerun-if-changed={}", res_dir.join("include").display());

    // **The build record, written by the build** (DL42, I100).
    //
    // "./check" asked "is this binary current?" by comparing a content digest of the
    // sources against a record — and the record was written by a *wrapper*
    // (`scripts/build-native.mjs`, `scripts/rebuild.mjs`), so a bare `cargo build
    // --release` produced a current binary with a stale record. Measured three times
    // (DL41 §7): the record predated the source commit, the later rebuild was a bare
    // cargo build, and `--check` read 7/9 for a tree that was in fact current.
    //
    // **The fix is placement, not bookkeeping.** build.rs runs exactly when its inputs
    // change, so it is the one step that cannot be skipped by building the crate: it
    // writes the record beside the artifact it describes, for whichever profile cargo
    // is building. Nothing else writes it.
    record::write(&manifest);

    check_zig_version();

    let target = std::env::var("TARGET").unwrap_or_default();
    let mut zig_cmd = Command::new("zig");
    zig_cmd.current_dir(&res_dir).args(["build", "-Doptimize=ReleaseSafe"]);
    if target.contains("windows-msvc") {
        zig_cmd.arg("-Dtarget=x86_64-windows-msvc");
    }
    let status = zig_cmd.status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("`zig build -Doptimize=ReleaseSafe` failed in {res_dir:?} with {s}"),
        Err(e) => panic!(
            "could not run `zig` ({e}) — tension-core links tension-res, so Zig {}.{} or \
             newer must be on PATH (see tension-res/DESIGN.md §9.2)",
            MIN_ZIG.0, MIN_ZIG.1
        ),
    }

    let lib_dir = res_dir.join("zig-out").join("lib");
    let res_a = lib_dir.join("libtension_res.a");
    let res_lib = lib_dir.join("tension_res.lib");
    if !res_a.exists() && res_lib.exists() {
        let _ = std::fs::copy(&res_lib, &res_a);
    }
    if !res_a.exists() && !res_lib.exists() {
        panic!("expected {} after `zig build`", res_a.display());
    }
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=tension_res");

    // ── tension-solver: the Fortran numerical core ────────────────────────
    //
    // The same shape as the tension-res block above: the subsystem's own
    // recipe builds its archive, and this script runs it and emits the link
    // directives. The recipe pins the determinism flags (`tension-solver/DESIGN.md` §2); this
    // side supplies the archive and the Fortran runtime it needs.
    let solver_dir = manifest
        .parent()
        .expect("tension-core lives next to tension-solver")
        .join("tension-solver");

    println!("cargo:rerun-if-changed={}", solver_dir.join("src").display());
    println!("cargo:rerun-if-changed={}", solver_dir.join("include").display());

    check_gfortran_version();

    let solver_lib = solver_dir.join("build");
    let solver_archive = solver_lib.join("libtension_solver.a");
    // Always rebuild: the recipe is cheap, and an "archive exists" short-cut
    // would let a changed Fortran source link stale objects (cargo reruns this
    // script on a source change, but the archive would already be sitting there).
    //
    // The recipe runs here, on every platform. It used to live in
    // `tension-solver/build.sh` on Unix and be restated inline on Windows, which
    // meant two copies of the pinned flags (`tension-solver/DESIGN.md` §2) and a shell the build
    // otherwise does not need. One copy, no shell.
    {
        let out = &solver_lib;
        let _ = std::fs::create_dir_all(out);
        let fflags = [
            "-O2",
            "-fno-fast-math",
            "-fPIC",
            "-std=f2023",
            "-Wall",
            "-Wextra",
            "-Wno-compare-reals",
            "-Wno-unused-dummy-argument",
        ];
        let erk = solver_dir.join("src").join("tension_solver_erk.f90");
        let sym = solver_dir.join("src").join("tension_solver_symplectic.f90");
        let imp = solver_dir.join("src").join("tension_solver_implicit.f90");
        let c_src = solver_dir.join("src").join("tension_solver.c");
        let erk_o = out.join("tension_solver_erk.o");
        let sym_o = out.join("tension_solver_symplectic.o");
        let imp_o = out.join("tension_solver_implicit.o");
        let c_o = out.join("tension_solver.o");

        for (src, obj) in [(&erk, &erk_o), (&sym, &sym_o), (&imp, &imp_o)] {
            let mut command = Command::new("gfortran");
            command
                .args(fflags)
                .arg("-J").arg(out)
                .arg("-I").arg(out)
                .arg("-c").arg(src)
                .arg("-o").arg(obj);
            prefer_tool_own_dir(&mut command, "gfortran");
            run_or_panic(command, &format!("compiling Fortran source {}", src.display()));
        }
        let mut command = Command::new("gcc");
        command
            .args(["-std=c99", "-O2", "-fno-fast-math", "-fPIC"])
            .arg("-I").arg(solver_dir.join("include"))
            .arg("-c").arg(&c_src)
            .arg("-o").arg(&c_o);
        prefer_tool_own_dir(&mut command, "gcc");
        run_or_panic(command, &format!("compiling C source {}", c_src.display()));
        let mut command = Command::new("ar");
        command
            .args(["rcs"])
            .arg(&solver_archive)
            .args([&erk_o, &sym_o, &imp_o, &c_o]);
        prefer_tool_own_dir(&mut command, "ar");
        run_or_panic(command, &format!("archiving {}", solver_archive.display()));
    }

    if !solver_archive.exists() {
        panic!("expected {} after building the solver core", solver_archive.display());
    }
    // MSVC's linker resolves `static=tension_solver` to `tension_solver.lib`. The
    // archive is GNU `ar` format, which link.exe reads (verified with `dumpbin`),
    // so the copy below is only the name MSVC looks for. It is copied on every
    // build rather than only when absent: the recipe above always rebuilds the
    // archive, so an `exists()` guard would leave this name holding a previous
    // revision's objects while the link still succeeds — a stale-archive failure
    // no compile or unit test would show. On Unix the file is inert (the linker
    // reads `libtension_solver.a`), so doing it unconditionally costs a copy and
    // keeps one code path.
    let solver_msvc = solver_lib.join("tension_solver.lib");
    std::fs::copy(&solver_archive, &solver_msvc)
        .expect("copy the solver archive to the name MSVC's linker expects");
    println!("cargo:rustc-link-search=native={}", solver_lib.display());
    println!("cargo:rustc-link-lib=static=tension_solver");

    if target.contains("msvc") {
        // The Fortran core and its C shim are compiled by gfortran/gcc, whose
        // objects name the C runtime's printf family directly. UCRT moved those
        // out of the default import libraries and into legacy_stdio_definitions,
        // so the host must ask for it explicitly.
        println!("cargo:rustc-link-lib=legacy_stdio_definitions");
        // Test targets link the archive directly: a test that never touches
        // this crate's rlib (solver_p1/p4) — or every ogre_* probe, which links
        // midpoint.o — does not inherit the native lib through the rlib, so
        // name the archive for those link steps. link.exe takes the archive
        // path as an input file; `-ltension_solver` is not an option it knows.
        //
        // It goes last, after the archive: link.exe searches libraries in
        // order and does not revisit one already scanned, so the `-l` form
        // above (which rustc places before the inputs) would not satisfy the
        // printf references the archive introduces.
        println!("cargo:rustc-link-arg-tests={}", solver_archive.display());
        println!("cargo:rustc-link-arg-tests=legacy_stdio_definitions.lib");
    } else {
        println!("cargo:rustc-link-lib=gfortran");
        println!("cargo:rustc-link-lib=m");

        // The same restatement for a linker that speaks `-l`: these are the
        // libraries the lib target receives, repeated for test link steps that
        // do not carry the rlib.
        println!("cargo:rustc-link-arg-tests=-ltension_solver");
        println!("cargo:rustc-link-arg-tests=-lgfortran");
        println!("cargo:rustc-link-arg-tests=-lm");
    }

    // ── ImageViewer's .iwi format library ─────────────────────────────────
    //
    // The container grammar lives once, in ImageViewer's `src/format/IwiFile.*`,
    // and every reader in this tree goes through its C ABI. Compile that one
    // translation unit here rather than letting each consumer grow a parser:
    // the header on disk has already changed once, and every hand copy of it
    // had to change with it.
    //
    // The ABI is `extern "C"` and the implementation uses only libc — measured
    // with `nm -u`: `memcpy` and `free`, nothing else. That is what lets the
    // archive cross the MSVC-host / MinGW-compiler boundary the same way
    // `libtension_solver.a` does. `-fno-exceptions`, `-fno-rtti`,
    // `-fno-stack-protector` and `-fno-asynchronous-unwind-tables` are the
    // reason: with them the object names no C++ runtime, no libgcc helper and
    // no unwinder symbol. No `-Wall` either — the file is upstream's, and its
    // warnings are for upstream to fix, not for a build log here to repeat.
    let imageviewer = manifest
        .parent()
        .expect("tension-core lives next to third_party")
        .join("third_party")
        .join("ImageViewer");
    let iwi_source = imageviewer.join("src").join("format").join("IwiFile.cpp");
    let iwi_header = imageviewer.join("src").join("format").join("IwiFile.h");
    let plugin_header = imageviewer
        .join("src")
        .join("imageviewer")
        .join("ImagePluginDef.h");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    if !iwi_source.exists() {
        panic!(
            "{} is missing — initialise the submodule with `git submodule update --init \
             third_party/ImageViewer`",
            iwi_source.display()
        );
    }
    println!("cargo:rerun-if-changed={}", iwi_source.display());
    println!("cargo:rerun-if-changed={}", iwi_header.display());
    println!("cargo:rerun-if-changed={}", plugin_header.display());

    // A GNU-compatible driver on every platform, matching the rest of this
    // tree's C++ targets (`scripts/build-2d.mjs`, `scripts/build-native.mjs`).
    // `TENSION_CXX` names a different one when a machine needs it.
    let cxx = std::env::var("TENSION_CXX")
        .or_else(|_| std::env::var("CXX"))
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "g++".to_string()
            } else {
                "c++".to_string()
            }
        });
    let iwi_obj = out_dir.join("iw_iwi_file.o");
    let mut command = Command::new(&cxx);
    command
        .args([
            "-std=c++17",
            "-O2",
            "-fPIC",
            "-fno-exceptions",
            "-fno-rtti",
            "-fno-stack-protector",
            "-fno-asynchronous-unwind-tables",
        ])
        .arg("-I")
        .arg(imageviewer.join("src").join("format"))
        .arg("-I")
        .arg(imageviewer.join("src").join("imageviewer"))
        .arg("-c")
        .arg(&iwi_source)
        .arg("-o")
        .arg(&iwi_obj);
    prefer_tool_own_dir(&mut command, &cxx);
    run_or_panic(
        command,
        &format!("compiling ImageViewer's IWI format library {}", iwi_source.display()),
    );

    let iwi_archive = out_dir.join("libiw_iwi_file.a");
    let _ = std::fs::remove_file(&iwi_archive);
    let mut ar = Command::new("ar");
    ar.args(["rcs"]).arg(&iwi_archive).arg(&iwi_obj);
    prefer_tool_own_dir(&mut ar, "ar");
    run_or_panic(
        ar,
        &format!("archiving ImageViewer's format library into {}", iwi_archive.display()),
    );
    if target.contains("msvc") {
        // `-liwi_iwi_file` resolves to `iw_iwi_file.lib` under link.exe. The
        // archive is GNU `ar` format, which link.exe reads (the solver archive
        // is linked the same way).
        std::fs::copy(&iwi_archive, out_dir.join("iw_iwi_file.lib"))
            .expect("copy the IwiFile archive to the name MSVC's linker expects");
    }
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=iw_iwi_file");

    // ── the P7 sample plugin ──────────────────────────────────────────────
    //
    // The shim has no plugin load-from-disk (`tension-solver/DESIGN.md` §11), so the P7
    // tests exercise the real example source by compiling it straight into
    // the test binaries: one canonical midpoint.c, built twice — once here
    // for the tests, once by the example's own Makefile for its .so.
    let plugin_src = manifest
        .parent()
        .expect("tension-core lives next to examples")
        .join("examples")
        .join("plugins")
        .join("midpoint")
        .join("midpoint.c");
    println!("cargo:rerun-if-changed={}", plugin_src.display());
    let plugin_include = manifest
        .parent()
        .expect("tension-core lives next to tension-solver")
        .join("tension-solver")
        .join("include");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let plugin_obj = out_dir.join("tension_plugin_midpoint.o");
    let mut command = Command::new("cc");
    command
        .args(["-std=c99", "-O2", "-fno-fast-math", "-fPIC"])
        .arg("-I")
        .arg(&plugin_include)
        .arg("-c")
        .arg(&plugin_src)
        .arg("-o")
        .arg(&plugin_obj);
    prefer_tool_own_dir(&mut command, "cc");
    run_or_panic(
        command,
        &format!("compiling the P7 sample plugin {}", plugin_src.display()),
    );
    println!("cargo:rustc-link-arg-tests={}", plugin_obj.display());

    // ---- the adapter ABI's reference fixture ------------------------------
    // One C file, built twice: the reference adapter and a twin whose vtable
    // claims one version past the current one, so the loader's version refusal
    // is proven without a second source file. Neither needs a host symbol — every service arrives
    // through the core API table — which is the property that makes dlopen safe
    // with no -rdynamic.
    let adapter_src = manifest.join("tests").join("support").join("echo_adapter.c");
    let adapter_header = manifest.join("include").join("tension_adapter.h");
    println!("cargo:rerun-if-changed={}", adapter_src.display());
    println!("cargo:rerun-if-changed={}", adapter_header.display());
    let include = manifest.join("include");
    for (name, define) in [
        ("libtension_echo.so", None),
        ("libtension_echo_badabi.so", Some("-DECHO_BAD_ABI_VERSION=1")),
        // C4.1c: the same source with a layout hash the host will refuse.
        ("libtension_echo_badlayout.so", Some("-DECHO_BAD_LAYOUT_HASH=1")),
        // The pre-C4 ABI-version-1 shape: 72 bytes, no `layout_hash`, so the
        // version gate must refuse it before offset 72 is read (C4c amendment).
        ("libtension_echo_v1.so", Some("-DECHO_OLD_V1=1")),
    ] {
        let output = out_dir.join(name);
        let mut command = Command::new("cc");
        command
            .args(["-std=c11", "-O2", "-fPIC", "-shared"])
            .arg("-I")
            .arg(&include)
            .arg(&adapter_src);
        if let Some(define) = define {
            command.arg(define);
        }
        command.arg("-o").arg(&output);
        prefer_tool_own_dir(&mut command, "cc");
        run_or_panic(
            command,
            &format!("compiling the adapter fixture {}", adapter_src.display()),
        );
    }
    println!(
        "cargo:rustc-env=TENSION_ECHO_ADAPTER={}",
        out_dir.join("libtension_echo.so").display()
    );
    println!(
        "cargo:rustc-env=TENSION_ECHO_BADABI_ADAPTER={}",
        out_dir.join("libtension_echo_badabi.so").display()
    );
    println!(
        "cargo:rustc-env=TENSION_ECHO_BADLAYOUT_ADAPTER={}",
        out_dir.join("libtension_echo_badlayout.so").display()
    );
    println!(
        "cargo:rustc-env=TENSION_ECHO_V1_ADAPTER={}",
        out_dir.join("libtension_echo_v1.so").display()
    );

    // ── tension-ogre's stub adapter ───────────────────────────────────────
    //
    // The capability ABI's end-to-end fixture (A3b): a TensionScript guest
    // calls the `ogre` namespace, a stub adapter behind it answers, and the
    // session delivers the completion. It links no OGRE-Next — this is the
    // shape of the capability, not a renderer.
    let ogre_stub_src = manifest.join("tests").join("support").join("ogre_stub_adapter.c");
    println!("cargo:rerun-if-changed={}", ogre_stub_src.display());
    println!("cargo:rerun-if-changed={}", adapter_header.display());
    let ogre_stub = out_dir.join("libtension_ogre_stub.so");
    let mut command = Command::new("cc");
    command
        .args(["-std=c11", "-O2", "-fPIC", "-shared"])
        .arg("-I")
        .arg(&include)
        .arg(&ogre_stub_src)
        .arg("-o")
        .arg(&ogre_stub);
    prefer_tool_own_dir(&mut command, "cc");
    run_or_panic(
        command,
        &format!("compiling the capability stub {}", ogre_stub_src.display()),
    );
    println!(
        "cargo:rustc-env=TENSION_OGRE_STUB_ADAPTER={}",
        out_dir.join("libtension_ogre_stub.so").display()
    );

    // ── the teardown probe adapter (C3) ───────────────────────────────────
    //
    // A capability whose `shutdown`/`destroy` record their own invocation to a
    // file, so `adapter_teardown.rs` can prove the host tears an adapter down
    // even when the guest traps. It registers nothing and needs no service.
    let teardown_probe_src = manifest
        .join("tests")
        .join("support")
        .join("teardown_probe_adapter.c");
    println!("cargo:rerun-if-changed={}", teardown_probe_src.display());
    println!("cargo:rerun-if-changed={}", adapter_header.display());
    let teardown_probe = out_dir.join("libtension_teardown_probe.so");
    let mut command = Command::new("cc");
    command
        .args(["-std=c11", "-O2", "-fPIC", "-shared"])
        .arg("-I")
        .arg(&include)
        .arg(&teardown_probe_src)
        .arg("-o")
        .arg(&teardown_probe);
    prefer_tool_own_dir(&mut command, "cc");
    run_or_panic(
        command,
        &format!("compiling the teardown probe {}", teardown_probe_src.display()),
    );
    println!(
        "cargo:rustc-env=TENSION_TEARDOWN_PROBE_ADAPTER={}",
        teardown_probe.display()
    );

    // ── the logging ABI's C harness ────────────────────────────────────────
    //
    // A C object that calls `tension_log` / `tension_log_structured`, linked
    // into the `log_ffi` integration test. Compiling it here is what proves the
    // host's exported symbols are resolvable from C, not just from Rust; the
    // test then asserts the records reached the sink.
    let log_harness_src = manifest
        .join("tests")
        .join("support")
        .join("log_harness.c");
    let logger_header = manifest.join("include").join("tension_logger.h");
    println!("cargo:rerun-if-changed={}", log_harness_src.display());
    println!("cargo:rerun-if-changed={}", logger_header.display());
    let log_harness_obj = out_dir.join("tension_log_harness.o");
    let mut command = Command::new("cc");
    command
        .args(["-std=c11", "-O2", "-fPIC"])
        .arg("-I")
        .arg(&include)
        .arg("-c")
        .arg(&log_harness_src)
        .arg("-o")
        .arg(&log_harness_obj);
    prefer_tool_own_dir(&mut command, "cc");
    run_or_panic(
        command,
        &format!("compiling the log harness {}", log_harness_src.display()),
    );
    // A static archive, not the bare object. `rustc-link-arg-tests` applies to
    // *every* test target, and on MSVC a command-line object is always linked:
    // tests that never touch this crate's rlib (the solver probes) then fail with
    // `unresolved external symbol tension_log`. An archive is only searched when
    // a symbol is needed, so the harness reaches `log_ffi` — the one test that
    // declares `log_harness_emit` — and nothing else.
    let log_harness_lib = out_dir.join("libtension_log_harness.a");
    let _ = std::fs::remove_file(&log_harness_lib);
    let mut ar = Command::new("ar");
    ar.args(["rcs"]).arg(&log_harness_lib).arg(&log_harness_obj);
    prefer_tool_own_dir(&mut ar, "ar");
    run_or_panic(
        ar,
        &format!("archiving the log harness into {}", log_harness_lib.display()),
    );
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-arg-tests={}", log_harness_lib.display());

    // ── llama.cpp build-info support for MinGW/Windows ─────────────────────
    if std::env::var("CARGO_FEATURE_AI").is_ok() {
        if let Some(build_dir) = out_dir.parent().and_then(|p| p.parent()) {
            if let Ok(entries) = std::fs::read_dir(build_dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with("llama-cpp-sys-2-") {
                        let common_dir = entry.path().join("out").join("build").join("common");
                        if common_dir.join("libllama-common-base.a").exists() {
                            println!("cargo:rustc-link-search=native={}", common_dir.display());
                            println!("cargo:rustc-link-lib=static=llama-common-base");
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// The build record: **what this binary was built from**, written by the build.
///
/// # Why it lives here (DL42, I100)
///
/// The record used to be written by a wrapper script, so `cargo build --release` on
/// its own left a current binary beside a record that named older sources. That is
/// not a bookkeeping slip: `--check`'s whole question is "was this artifact built
/// from these sources?", and a record a round can forget to write answers it wrongly
/// in the direction that hides staleness. Three rounds in a row hit it (DL41 §7).
///
/// # One definition of the digest
///
/// The *canonical form* used to be defined once, in JavaScript
/// (`scripts/lib/build-record.mjs`), which meant the writer and the checker were the
/// same language. Moving the writer into the build would have duplicated the rule in
/// Rust — so the rule changed shape instead: the record now carries **one sha256 per
/// input file**, and `--check` verifies those directly rather than recomputing an
/// aggregate. A per-file digest is the same algorithm on both sides (sha256 of a
/// file, nothing else), so there is no canonical *form* left for two languages to
/// disagree about. The aggregate is still written, for a reader who wants one short
/// label, but nothing depends on it.
///
/// # The input set
///
/// The same set `--check` enumerates: every `.rs` under `tension-core/src`, every
/// `.zig` under `tension-res/src`, `Cargo.toml` and this script. It is emitted as a
/// `cargo:rerun-if-changed` for each file, which is also what makes a `.rs` edit
/// re-run this script — cargo's package-wide default is off as soon as a script emits
/// any `rerun-if-changed`, and this one always has.
mod record {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Writes `<profile>/tension-core.build.json` beside the artifact cargo is
    /// building, and asks cargo to re-run this script when any input changes.
    pub fn write(manifest: &Path) {
        let repo = match manifest.parent() {
            Some(repo) => repo,
            None => return,
        };
        let inputs = collect(repo);
        // **Before the early exits below**, so cargo always re-runs on an input edit
        // even if writing the record fails on an unusual layout.
        for rel in &inputs {
            println!("cargo:rerun-if-changed={}", repo.join(rel).display());
        }
        let Some(profile) = profile_dir() else { return };
        // `CARGO_CFG_WINDOWS`, not `cfg!(windows)`: the artifact's name belongs to
        // the *target*, and this script may be cross-compiling.
        let windows = std::env::var("CARGO_CFG_WINDOWS").is_ok();
        let artifact = profile.join(if windows { "tension-core.exe" } else { "tension-core" });
        let mut per_file: Vec<String> = Vec::new();
        let mut stream = String::new();
        for rel in &inputs {
            let Ok(bytes) = fs::read(repo.join(rel)) else { return };
            let digest = sha256_hex(&bytes);
            per_file.push(format!(
                "    {{ \"path\": {}, \"sha256\": {} }}",
                json(rel),
                json(&digest)
            ));
            stream.push_str(rel);
            stream.push('\0');
            stream.push_str(&digest);
            stream.push('\n');
        }
        let aggregate = sha256_hex(stream.as_bytes());
        let built = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let body = format!(
            "{{\n  \"format\": 2,\n  \"inputs\": {},\n  \"inputFiles\": {},\n  \
             \"profile\": {},\n  \"artifact\": {},\n  \"built_unix\": {},\n  \
             \"inputsDescription\": \"tension-core/src/**/*.rs, tension-res/src/**/*.zig, Cargo.toml, build.rs\",\n  \
             \"files\": [\n{}\n  ]\n}}\n",
            json(&aggregate),
            inputs.len(),
            json(&profile_name(&profile)),
            json(&artifact.display().to_string()),
            built,
            per_file.join(",\n")
        );
        let _ = fs::write(format!("{}.build.json", artifact.display()), body);
    }

    /// The input set, repo-relative and sorted the way `--check` enumerates it.
    fn collect(repo: &Path) -> Vec<String> {
        let mut out = Vec::new();
        walk(repo, "tension-core/src", &mut out, |name| name.ends_with(".rs"));
        walk(repo, "tension-res/src", &mut out, |name| name.ends_with(".zig"));
        for rel in ["tension-core/Cargo.toml", "tension-core/build.rs"] {
            if repo.join(rel).is_file() {
                out.push(rel.to_string());
            }
        }
        out.sort();
        out
    }

    fn walk(repo: &Path, rel: &str, out: &mut Vec<String>, include: fn(&str) -> bool) {
        let Ok(entries) = fs::read_dir(repo.join(rel)) else { return };
        let mut names: Vec<_> = entries.flatten().collect();
        names.sort_by_key(|entry| entry.file_name());
        for entry in names {
            let child = format!("{rel}/{}", entry.file_name().to_string_lossy());
            let path = repo.join(&child);
            if path.is_dir() {
                walk(repo, &child, out, include);
            } else if path.is_file() && include(&entry.file_name().to_string_lossy()) {
                out.push(child);
            }
        }
    }

    /// `target/<profile>` — the directory the artifact is written to.
    ///
    /// **Found by name, not by counting**, because the depth is not a promise:
    /// `OUT_DIR` is `<target>/<profile>/build/<pkg>-<hash>/out` for a package with
    /// no `links` key, and a counting rule (`ancestors().nth(3)`) put the record in
    /// `target/<profile>/build/` — measured, first run (DL42). So: the nearest
    /// ancestor named `build`, and the artifact directory is its parent.
    fn profile_dir() -> Option<PathBuf> {
        let out = PathBuf::from(std::env::var("OUT_DIR").ok()?);
        out.ancestors()
            .find(|dir| dir.file_name().map(|name| name == "build").unwrap_or(false))
            .and_then(|build| build.parent())
            .map(|dir| dir.to_path_buf())
    }

    fn profile_name(profile: &Path) -> String {
        profile
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// A JSON string literal. Only paths and hex digests go through this, so the
    /// escapes are the two that can occur.
    fn json(text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 2);
        out.push('"');
        for ch in text.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    // ── sha256 (FIPS 180-4) ─────────────────────────────────────────────────
    //
    // Hand-written rather than pulled in: a build dependency for `tension-core`
    // would be a Cargo.toml change for one function, and this script already links
    // C and Fortran toolchains — it does not need a Rust crate to hash a file. The
    // constants are the standard first-32-bits-of-the-fractional-parts table.

    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    pub fn sha256_hex(input: &[u8]) -> String {
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];
        let bit_len = (input.len() as u64).wrapping_mul(8);
        let mut message = input.to_vec();
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&bit_len.to_be_bytes());

        for chunk in message.chunks(64) {
            let mut w = [0u32; 64];
            for (index, word) in chunk.chunks(4).enumerate() {
                w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
            }
            for index in 16..64 {
                let s0 = w[index - 15].rotate_right(7)
                    ^ w[index - 15].rotate_right(18)
                    ^ (w[index - 15] >> 3);
                let s1 = w[index - 2].rotate_right(17)
                    ^ w[index - 2].rotate_right(19)
                    ^ (w[index - 2] >> 10);
                w[index] = w[index - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[index - 7])
                    .wrapping_add(s1);
            }
            let mut v = h;
            for index in 0..64 {
                let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
                let ch = (v[4] & v[5]) ^ ((!v[4]) & v[6]);
                let temp1 = v[7]
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[index])
                    .wrapping_add(w[index]);
                let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
                let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
                let temp2 = s0.wrapping_add(maj);
                v[7] = v[6];
                v[6] = v[5];
                v[5] = v[4];
                v[4] = v[3].wrapping_add(temp1);
                v[3] = v[2];
                v[2] = v[1];
                v[1] = v[0];
                v[0] = temp1.wrapping_add(temp2);
            }
            for index in 0..8 {
                h[index] = h[index].wrapping_add(v[index]);
            }
        }
        let mut hex = String::with_capacity(64);
        for word in h {
            hex.push_str(&format!("{word:08x}"));
        }
        hex
    }
}

/// On Windows the MSYS2 compilers can fail silently — exit status 1 with no
/// diagnostics — when an earlier PATH entry shadows one of their own DLLs, as
/// happens when a Visual Studio environment sits ahead of UCRT64. Re-running
/// the tool with its own directory first on the child's PATH makes it
/// self-consistent. A no-op off Windows.
#[cfg(windows)]
fn prefer_tool_own_dir(command: &mut Command, tool: &str) {
    let Some(path) = std::env::var_os("PATH") else { return };
    let executable = format!("{tool}.exe");
    for dir in std::env::split_paths(&path) {
        if dir.join(&executable).is_file() {
            let mut combined = dir.into_os_string();
            combined.push(";");
            combined.push(&path);
            command.env("PATH", combined);
            return;
        }
    }
}

#[cfg(not(windows))]
fn prefer_tool_own_dir(_command: &mut Command, _tool: &str) {}

/// Run a command and, on failure, panic with the tool's own diagnostics — a
/// bare exit status loses the one line that says what actually went wrong.
fn run_or_panic(mut command: Command, what: &str) {
    match command.output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => panic!(
            "{what} failed with {}:\n{}{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        ),
        Err(error) => panic!("could not run `{what}`: {error}"),
    }
}

/// Whether a version string's major.minor is at least `min` (major, minor).
/// Only the leading two numeric components are read: `0.16.0`,
/// `0.18.0-dev.131+41f885830` and `16.0.0-dev.1` all parse, and anything
/// non-numeric is not a version we can compare, so it is treated as older than
/// the floor (which warns rather than refusing).
fn version_at_least(version: &str, min: (u64, u64)) -> bool {
    let mut parts = version.trim().split('.');
    let leading_digits = |part: Option<&str>| -> Option<u64> {
        let part = part?;
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() { None } else { digits.parse().ok() }
    };
    match (leading_digits(parts.next()), leading_digits(parts.next())) {
        (Some(major), Some(minor)) => (major, minor) >= min,
        _ => false,
    }
}

fn check_zig_version() {
    let out = match Command::new("zig").arg("version").output() {
        Ok(out) => out,
        Err(_) => return, // the build below reports the failure with more context
    };
    let version = String::from_utf8_lossy(&out.stdout);
    let version = version.trim();
    if version_at_least(version, MIN_ZIG) {
        return;
    }
    let (min_major, min_minor) = MIN_ZIG;
    // The exception, not a refusal: the Zig compiler is the real gate. The
    // resource source uses APIs 0.16 introduced, so a genuinely too-old
    // compiler fails there with a better message than this check can give —
    // which is why an older version warns and the build continues rather than
    // stopping here.
    println!(
        "cargo:warning=tension-res requires Zig {min_major}.{min_minor} or newer; installed is \
         {version}. Upgrade Zig, or set TENSION_ALLOW_UNPINNED=1 to build anyway."
    );
}

fn check_gfortran_version() {
    let out = match Command::new("gfortran").arg("--version").output() {
        Ok(out) => out,
        Err(_) => return, // the build below reports the failure with more context
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next().unwrap_or("").trim().to_string();
    // The banner is `GNU Fortran (Debian 14.2.0-19) 14.2.0`: the trailing token
    // is the version, and the parenthesised one is the distributor's build.
    let version = first.split_whitespace().last().unwrap_or("");
    let (min_major, min_minor) = MIN_GFORTRAN;
    if version_at_least(version, MIN_GFORTRAN) {
        return;
    }
    // The same rule as the Zig floor: the compiler is the real gate, so a newer
    // series builds without comment and an older one warns rather than stops.
    // `TENSION_ALLOW_UNPINNED=1` acknowledges a below-floor toolchain and
    // silences the warning; the build continues either way.
    if unpinned_allowed() {
        println!(
            "cargo:warning=tension-solver is built with gfortran {version}, below the \
             {min_major}.{min_minor} floor — TENSION_ALLOW_UNPINNED=1 is set, so the below-floor \
             toolchain is acknowledged"
        );
    } else {
        println!(
            "cargo:warning=tension-solver requires gfortran {min_major}.{min_minor} or newer; \
             installed is {version} ('{first}'). The build continues, but the numerical core's \
             results are compiled by that toolchain (`tension-solver/DESIGN.md` §5). Upgrade gfortran, or set \
             TENSION_ALLOW_UNPINNED=1 to acknowledge."
        );
    }
}

/// The escape hatch for the two version pins above. A machine that must build
/// with what it has — a distro Zig or a system gfortran on a CI image
/// that does not stock the pinned toolchain — sets `TENSION_ALLOW_UNPINNED=1`
/// and the pins demote from a refusal to a `cargo:warning`.
fn unpinned_allowed() -> bool {
    matches!(std::env::var("TENSION_ALLOW_UNPINNED").as_deref(), Ok("1"))
}
