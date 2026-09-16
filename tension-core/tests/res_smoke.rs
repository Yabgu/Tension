//! Resource smoke test: the Rust wrapper over the tension-res C ABI, driven
//! against the committed minimal fixture.
//!
//! The fixture path is resolved at compile time from `CARGO_MANIFEST_DIR`, so
//! the test does not depend on the working directory.
//!
//! Covered: owned load, borrowed load, vec-owning load, load_file, the read
//! flow (`stat`/`open`/`read`/`seek`/`tell`/`stat_fd`/`close`), listings, and
//! that malformed input comes back as an errno rather than a panic.

use std::path::PathBuf;

use tension_core::res::{DirEntry, Errno, LoadError, ResourceSet, Stat};

const FIXTURE: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tension-res/test/fixtures/minimal.sidf"));

const PAYLOAD: &str = "hello\n";
const CHILD: &str = "hello.txt";

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tension-res")
        .join("test")
        .join("fixtures")
        .join("minimal.sidf")
}

/// The flow every load variant must support.
fn exercise(set: &ResourceSet<'_>) {
    // stat "/" — a directory with no payload.
    let root = set.stat("/").expect("root stats");
    assert!(root.is_dir());
    assert_eq!(root.kind, 1);
    assert_eq!(root.size, 0);
    assert_eq!(root.flags, 0);
    assert!(set.exists("/"));
    assert!(set.is_dir("/"));

    // readdir "/" — one child, raw name, sizes from the entry.
    let entries = set.read_dir("/").expect("root lists");
    assert_eq!(entries.len(), 1);
    let entry: &DirEntry = &entries[0];
    assert_eq!(entry.name, CHILD);
    assert!(entry.stat.is_file());
    assert_eq!(entry.stat.size, PAYLOAD.len() as u32);
    assert!(!entry.stat.is_compressed());
    assert!(set.read_dir_at("/", 1).expect("past the end").is_none());

    // open / read / tell / seek / stat_fd / close.
    let mut file = set.open("hello.txt").expect("open");
    assert!(file.raw() >= 1);
    assert_eq!(file.tell().unwrap(), 0);
    let mut buf = [0u8; 6];
    assert_eq!(file.read(&mut buf).unwrap(), 6);
    assert_eq!(&buf, PAYLOAD.as_bytes());
    assert_eq!(file.tell().unwrap(), 6);
    assert_eq!(file.read(&mut buf).unwrap(), 0, "EOF");

    assert_eq!(file.seek(0, 0).unwrap(), 0); // SET
    assert_eq!(file.read(&mut buf[..3]).unwrap(), 3);
    assert_eq!(&buf[..3], b"hel");
    assert_eq!(file.seek(2, 1).unwrap(), 5); // CUR
    assert_eq!(file.seek(0, 2).unwrap(), 6); // END
    assert_eq!(file.seek(-2, 2).unwrap(), 4);
    assert_eq!(file.read(&mut buf).unwrap(), 2);
    assert_eq!(&buf[..2], b"o\n");

    // stat_fd agrees with stat, byte for byte.
    let by_fd: Stat = file.stat().expect("stat_fd");
    let by_path = set.stat(CHILD).expect("stat");
    assert_eq!(by_fd, by_path);
    assert!(by_fd.is_file());
    assert_eq!(by_fd.size, PAYLOAD.len() as u32);
    drop(file); // closes

    // Whole-file read, and the same bytes through the fd API.
    assert_eq!(set.read_file("hello.txt").unwrap(), PAYLOAD.as_bytes());

    // Errors are errnos, not panics.
    assert_eq!(set.open("nope.txt").unwrap_err().code(), -2);
    assert_eq!(set.open("/").unwrap_err().code(), -21);
    assert_eq!(set.stat("../escape").unwrap_err().code(), -22);
    assert_eq!(set.read_dir("hello.txt").unwrap_err().code(), -20);
    assert_eq!(set.read_dir("nope").unwrap_err().code(), -2);
    assert_eq!(set.read_file("/").unwrap_err().code(), -21);
}

#[test]
fn owned_load_copies_and_reads_the_fixture() {
    let set = ResourceSet::load(FIXTURE).expect("owned load");
    assert_eq!(set.ownership_label(), "copied");
    assert!(!set.owns_backing());
    exercise(&set);
}

#[test]
fn borrowed_load_serves_the_callers_bytes() {
    let bytes: Vec<u8> = FIXTURE.to_vec();
    let set = ResourceSet::load_borrowed(&bytes).expect("borrowed load");
    assert_eq!(set.ownership_label(), "borrowed");
    // The set borrows `bytes`; both are alive here — that is what the lifetime
    // parameter is for.
    exercise(&set);
    assert_eq!(bytes.len(), FIXTURE.len());
}

#[test]
fn vec_owning_load_keeps_one_copy() {
    let bytes = std::fs::read(fixture_path()).expect("fixture readable");
    let len = bytes.len();
    let set = ResourceSet::load_from_vec(bytes).expect("vec load");
    assert_eq!(set.ownership_label(), "borrowed-from-owned");
    assert!(set.owns_backing());
    assert_eq!(len, FIXTURE.len());
    exercise(&set);
}

#[test]
fn load_file_reads_from_disk() {
    let set = ResourceSet::load_file(fixture_path()).expect("load_file");
    assert!(set.owns_backing());
    exercise(&set);
}

#[test]
fn malformed_and_missing_input_are_errors() {
    let garbage = vec![0u8; 8192];
    match ResourceSet::load(&garbage) {
        Err(e) => assert_eq!(e.code(), -22),
        Ok(_) => panic!("garbage loaded as a volume"),
    }
    match ResourceSet::load_borrowed(&garbage) {
        Err(e) => assert_eq!(e.code(), -22),
        Ok(_) => panic!("garbage loaded as a volume"),
    }

    let missing = fixture_path().with_file_name("does-not-exist.sidf");
    assert!(matches!(ResourceSet::load_file(missing), Err(LoadError::Io(_))));

    assert!(matches!(ResourceSet::load(&[]), Err(Errno(-22))));
    assert!(matches!(ResourceSet::load_borrowed(&[]), Err(Errno(-22))));
    assert!(matches!(ResourceSet::load_from_vec(Vec::new()), Err(Errno(-22))));
}

#[test]
fn two_sets_are_independent() {
    let a = ResourceSet::load(FIXTURE).expect("a");
    let b = ResourceSet::load_from_vec(FIXTURE.to_vec()).expect("b");
    let mut fa = a.open("hello.txt").expect("a opens");
    let mut fb = b.open("hello.txt").expect("b opens");
    let mut buf = [0u8; 3];
    assert_eq!(fa.read(&mut buf).unwrap(), 3);
    assert_eq!(fa.tell().unwrap(), 3);
    assert_eq!(fb.tell().unwrap(), 0, "separate fd tables");
    assert_eq!(fb.read(&mut buf).unwrap(), 3);
    assert_eq!(buf, *b"hel");
}
