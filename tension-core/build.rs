//! Build script: compile the Zig resource library (tension-res/) and link it
//! into this crate.
//!
//! The reader/writer/VFS live in Zig; this crate only ever calls the C ABI in
//! `tension-res/include/tension_res.h`. The static archive is installed into
//! `tension-res/zig-out/lib/libtension_res.a` by `zig build`, and the link
//! directives below are emitted for every target in this package (the binary
//! and the integration tests alike).
//!
//! Zig is pinned to the 0.16 series (tension-res/build.zig targets that
//! toolchain); a different version is reported as a warning rather than
//! silently accepted, because a mismatch changes the ABI's codegen, not just
//! its taste.
//!
//! The same pattern runs for tension-solver: its Fortran core is built by
//! `tension-solver/build.sh` (which pins the determinism flags) and linked
//! as `libtension_solver.a`, with the Fortran runtime on the link line.

use std::path::PathBuf;
use std::process::Command;

const PINNED_ZIG: &str = "0.16.";
// gfortran is pinned for the same reason: the numerical core's results are
// compiled, and a different compiler is a different contract (DESIGN.md §5).
const PINNED_GFORTRAN: &str = "16.";

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
            "could not run `zig` ({e}) — tension-core links tension-res, so Zig {PINNED_ZIG}x \
             must be on PATH (see tension-res/DESIGN.md §9.2)"
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
    // directives. The recipe pins the determinism flags (DESIGN.md §2); this
    // side supplies the archive and the Fortran runtime it needs.
    let solver_dir = manifest
        .parent()
        .expect("tension-core lives next to tension-solver")
        .join("tension-solver");

    println!("cargo:rerun-if-changed={}", solver_dir.join("build.sh").display());
    println!("cargo:rerun-if-changed={}", solver_dir.join("src").display());
    println!("cargo:rerun-if-changed={}", solver_dir.join("include").display());

    check_gfortran_version();

    let solver_lib = solver_dir.join("build");
    let solver_archive = solver_lib.join("libtension_solver.a");
    // Always rebuild: the recipe is cheap, and an "archive exists" short-cut
    // would let a changed Fortran source link stale objects (cargo reruns this
    // script on a source change, but the archive would already be sitting
    // there). `tension-solver/build.sh` carries the same unconditional-rebuild
    // discipline.
    if cfg!(windows) {
        // Windows has no `sh` guarantee, so the recipe's steps run here; the
        // flags are the pinned set from tension-solver/build.sh (DESIGN.md §2),
        // restated because that file is the Linux entry point.
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
    } else {
        let script = solver_dir.join("build.sh");
        let status = Command::new(&script).status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => panic!("`build.sh` failed in {solver_dir:?} with {s}"),
            Err(e) => panic!(
                "could not run {script:?} ({e}) — tension-core links the solver core, so \
                 gfortran {PINNED_GFORTRAN}x must be on PATH (see tension-solver/DESIGN.md §2)"
            ),
        }
    }

    if !solver_archive.exists() {
        panic!("expected {} after building the solver core", solver_archive.display());
    }
    // MSVC's linker resolves `static=tension_solver` to `tension_solver.lib`. The
    // archive is GNU `ar` format, which link.exe reads (verified with `dumpbin`),
    // so the copy below is only the name MSVC looks for.
    let solver_msvc = solver_lib.join("tension_solver.lib");
    if !solver_msvc.exists() {
        std::fs::copy(&solver_archive, &solver_msvc)
            .expect("copy the solver archive to the name MSVC's linker expects");
    }
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

    // ── the P7 sample plugin ──────────────────────────────────────────────
    //
    // The shim has no plugin load-from-disk (DESIGN.md §11), so the P7
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
    // claims ABI version 2, so the loader's version refusal is proven without a
    // second source file. Neither needs a host symbol — every service arrives
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

    // ── tension-ogre's stub adapter ───────────────────────────────────────
    //
    // The capability ABI's end-to-end fixture (A3b): an AssemblyScript guest
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

fn check_zig_version() {
    let out = match Command::new("zig").arg("version").output() {
        Ok(out) => out,
        Err(_) => return, // the build below reports the failure with more context
    };
    let version = String::from_utf8_lossy(&out.stdout);
    let version = version.trim();
    if !version.starts_with(PINNED_ZIG) {
        println!(
            "cargo:warning=tension-res is pinned to Zig {PINNED_ZIG}x but `zig version` reports \
             {version}; the C ABI is compiled by that toolchain"
        );
    }
}

fn check_gfortran_version() {
    let out = match Command::new("gfortran").arg("--version").output() {
        Ok(out) => out,
        Err(_) => return, // the build below reports the failure with more context
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next().unwrap_or("").trim().to_string();
    if !first.contains(PINNED_GFORTRAN) {
        println!(
            "cargo:warning=tension-solver is pinned to gfortran {PINNED_GFORTRAN}x but \
             `gfortran --version` reports: {first}; the numerical core's results are \
             compiled by that toolchain"
        );
    }
}
