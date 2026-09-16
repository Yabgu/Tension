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

use std::path::PathBuf;
use std::process::Command;

const PINNED_ZIG: &str = "0.16.";

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
