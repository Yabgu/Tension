//! Pack smoke test: the packer as the runtime sees it.
//!
//! Three paths, all against a real temp tree:
//!   1. the Rust wrapper (`res::pack`) → load the output with `ResourceSet`,
//!   2. the actual `tension-core pack` binary (spawned),
//!   3. determinism: the two outputs are byte-identical, and the fixture's own
//!      source tree reproduces `minimal.sidf` exactly.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tension_core::res::{ResourceSet, Stat};

/// A private directory per test: cargo runs these in parallel in one process,
/// so a shared root would have them packing each other's trees.
fn tmp_root(name: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("pack_smoke")
        .join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp root");
    root
}

fn write_tree(root: &Path) -> PathBuf {
    let src = root.join("assets");
    fs::create_dir_all(src.join("sub/empty")).expect("dirs");
    fs::write(src.join("hello.txt"), "hello\n").expect("hello");
    fs::write(src.join("sub/b.txt"), "bravo-bravo").expect("bravo");
    fs::write(src.join("empty-file.txt"), "").expect("empty");
    src
}

#[test]
fn the_wrapper_packs_and_the_wrapper_reads_back() {
    let root = tmp_root("wrapper");
    let src = write_tree(&root);
    let out = root.join("wrapper.tns");

    let message = tension_core::res::pack(&src, &out).expect("pack");
    assert!(message.contains("packed"), "message: {message}");
    assert!(out.exists());

    let set = ResourceSet::load_file(&out).expect("load");
    assert_eq!(set.read_file("hello.txt").expect("read"), b"hello\n");
    assert_eq!(set.read_file("sub/b.txt").expect("read"), b"bravo-bravo");
    assert_eq!(set.read_file("empty-file.txt").expect("read"), b"");
    assert!(set.is_dir("sub/empty"));
    assert_eq!(set.read_dir("/").expect("listing").len(), 3);
    assert_eq!(set.read_dir("sub/empty").expect("empty listing").len(), 0);

    let hello: Stat = set.stat("hello.txt").expect("stat");
    assert_eq!(hello.size, 6);
    assert!(hello.is_file());
}

#[test]
fn the_cli_packs_the_same_bytes_and_reports_failure_with_a_nonzero_exit() {
    let root = tmp_root("cli");
    let src = write_tree(&root);
    let wrapper_out = root.join("wrapper.tns");
    let cli_out = root.join("cli.tns");
    tension_core::res::pack(&src, &wrapper_out).expect("pack via the wrapper");

    let bin = env!("CARGO_BIN_EXE_tension-core");

    let output = Command::new(bin)
        .arg("pack")
        .arg(&src)
        .arg("-o")
        .arg(&cli_out)
        .output()
        .expect("run tension-core pack");
    assert!(
        output.status.success(),
        "pack failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("packed"), "stdout: {stdout}");

    // Determinism: the same tree through two frontends is the same bytes.
    assert_eq!(
        fs::read(&wrapper_out).expect("wrapper pak"),
        fs::read(&cli_out).expect("cli pak")
    );

    // The CLI's output loads too.
    let set = ResourceSet::load_file(&cli_out).expect("load cli pak");
    assert_eq!(set.read_file("sub/b.txt").expect("read"), b"bravo-bravo");

    // A missing source is a clean failure: message on stderr, exit != 0.
    let bad = Command::new(bin)
        .arg("pack")
        .arg(root.join("does-not-exist"))
        .output()
        .expect("run tension-core pack (bad)");
    assert!(!bad.status.success());
    let stderr = String::from_utf8_lossy(&bad.stderr);
    assert!(stderr.contains("tension-core pack:"), "stderr: {stderr}");
}

#[test]
fn the_fixtures_source_tree_reproduces_the_committed_pak() {
    let root = tmp_root("fixture");
    let src = root.join("assets");
    fs::create_dir_all(&src).expect("dirs");
    fs::write(src.join("hello.txt"), "hello\n").expect("payload");
    let out = root.join("assets.tns");
    tension_core::res::pack(&src, &out).expect("pack");

    let produced = fs::read(&out).expect("packed bytes");
    let committed = fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tension-res")
            .join("test")
            .join("fixtures")
            .join("minimal.sidf"),
    )
    .expect("committed fixture");

    assert_eq!(produced.len(), committed.len(), "pak length differs");
    assert_eq!(produced, committed, "paker output differs from minimal.sidf");
}
