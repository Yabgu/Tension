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

    let status = Command::new("zig")
        .current_dir(&res_dir)
        .args(["build", "-Doptimize=ReleaseSafe"])
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("`zig build -Doptimize=ReleaseSafe` failed in {res_dir:?} with {s}"),
        Err(e) => panic!(
            "could not run `zig` ({e}) — tension-core links tension-res, so Zig {PINNED_ZIG}x \
             must be on PATH (see tension-res/DESIGN.md §9.2)"
        ),
    }

    let lib_dir = res_dir.join("zig-out").join("lib");
    if !lib_dir.join("libtension_res.a").exists() {
        panic!("expected {} after `zig build`", lib_dir.join("libtension_res.a").display());
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

    let solver_lib = solver_dir.join("build");
    if !solver_lib.join("libtension_solver.a").exists() {
        panic!(
            "expected {} after build.sh",
            solver_lib.join("libtension_solver.a").display()
        );
    }
    println!("cargo:rustc-link-search=native={}", solver_lib.display());
    println!("cargo:rustc-link-lib=static=tension_solver");
    println!("cargo:rustc-link-lib=gfortran");
    println!("cargo:rustc-link-lib=m");

    // Test targets link the archive directly. The static library reaches
    // executables through the lib's rlib (rustc bundles static native libs
    // into it), but an integration test that only declares the bind(C)
    // symbols — solver_p1.rs, which deliberately never touches the crate —
    // would not carry the rlib into its link step. These are the same
    // libraries the lib target receives, restated for test link steps; the
    // search path above is already passed to every target.
    println!("cargo:rustc-link-arg-tests=-ltension_solver");
    println!("cargo:rustc-link-arg-tests=-lgfortran");
    println!("cargo:rustc-link-arg-tests=-lm");

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
    let status = Command::new("cc")
        .args(["-std=c99", "-O2", "-fno-fast-math", "-fPIC"])
        .arg("-I")
        .arg(&plugin_include)
        .arg("-c")
        .arg(&plugin_src)
        .arg("-o")
        .arg(&plugin_obj)
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!("compiling {} failed with {s}", plugin_src.display()),
        Err(e) => panic!(
            "could not run `cc` ({e}) — the P7 sample plugin is compiled into the test link"
        ),
    }
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
        match command.arg("-o").arg(&output).status() {
            Ok(status) if status.success() => {}
            Ok(status) => panic!("compiling {} failed with {status}", adapter_src.display()),
            Err(error) => panic!(
                "could not run `cc` ({error}) — the adapter ABI's reference fixture is built \
                 by that toolchain"
            ),
        }
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
    match Command::new("cc")
        .args(["-std=c11", "-O2", "-fPIC", "-shared"])
        .arg("-I")
        .arg(&include)
        .arg(&ogre_stub_src)
        .arg("-o")
        .arg(&ogre_stub)
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => panic!("compiling {} failed with {status}", ogre_stub_src.display()),
        Err(error) => panic!(
            "could not run `cc` ({error}) — the capability ABI's stub fixture is built \
             by that toolchain"
        ),
    }
    println!(
        "cargo:rustc-env=TENSION_OGRE_STUB_ADAPTER={}",
        out_dir.join("libtension_ogre_stub.so").display()
    );
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
