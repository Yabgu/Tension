//! Safe Rust wrapper over the tension-res C ABI
//! (`tension-res/include/tension_res.h`).
//!
//! This module is the crate's FFI boundary: every `unsafe` block in the
//! resource subsystem lives here, and everything above it works with plain
//! Rust types. The rules the wrapper enforces, in the type system where it
//! can:
//!
//! * **The handle always outlives its uses.** `ResourceSet` owns the raw
//!   handle and frees it in `Drop`; a `Fd` borrows the set, so an fd cannot
//!   outlive the resource set that produced it.
//! * **Borrowed bytes outlive the handle.** `ResourceSet<'a>` carries the
//!   lifetime of the bytes it serves, so `load_borrowed(&bytes)` cannot
//!   outlive `bytes`. The one place a set serves memory it owns
//!   (`load_from_vec`) stores the `Vec` in the same struct and never touches
//!   it again — the heap buffer a `Vec` points at is stable while the `Vec`
//!   lives, so the borrow stays valid and the drop order is fixed by
//!   `Drop::drop` running before the field is released.
//! * **Errors are values.** Every call returns `Result<_, Errno>`; the errno
//!   values are the C header's table. No call can panic on malformed pak
//!   content — the Zig side converts every parse failure to a negative errno.

use std::fmt;
use std::marker::PhantomData;
use std::path::Path;

/// The 12-byte record the host ABI reports (`tension_res_stat`, DESIGN.md §7.4).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stat {
    /// 0 = file, 1 = directory.
    pub kind: u32,
    /// Payload bytes for a file, 0 for a directory.
    pub size: u32,
    /// Bit 0: the payload is compressed. Bits 1-31 are reserved.
    pub flags: u32,
}

impl Stat {
    /// `kind == 1`: a directory.
    pub fn is_dir(&self) -> bool {
        self.kind == KIND_DIRECTORY
    }

    /// `kind == 0`: a file.
    pub fn is_file(&self) -> bool {
        self.kind == KIND_FILE
    }

    /// `flags` bit 0: the payload is stored compressed.
    pub fn is_compressed(&self) -> bool {
        self.flags & FLAG_COMPRESSED != 0
    }
}

pub const KIND_FILE: u32 = 0;
pub const KIND_DIRECTORY: u32 = 1;
pub const FLAG_COMPRESSED: u32 = 1;

/// A negative POSIX errno as reported by the C ABI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Errno(pub i32);

impl Errno {
    pub fn code(self) -> i32 {
        self.0
    }
}

impl fmt::Display for Errno {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match -self.0 {
            2 => "ENOENT",
            5 => "EIO",
            9 => "EBADF",
            12 => "ENOMEM",
            20 => "ENOTDIR",
            21 => "EISDIR",
            22 => "EINVAL",
            24 => "EMFILE",
            38 => "ENOSYS",
            _ => "unknown",
        };
        write!(f, "{} ({name}: {})", self.0, self.describe())
    }
}

impl Errno {
    fn describe(self) -> &'static str {
        match -self.0 {
            2 => "no such path (or no pak loaded)",
            5 => "malformed input, truncated structure, or unsupported payload codec",
            9 => "bad file descriptor",
            12 => "out of memory",
            20 => "not a directory",
            21 => "is a directory",
            22 => "invalid argument or malformed structure",
            24 => "too many open files",
            38 => "not implemented in this build",
            _ => "unknown error",
        }
    }
}

impl std::error::Error for Errno {}

/// Loading a pak can fail before the ABI is reached (reading the file) or at
/// it (the blob is not a readable volume).
#[derive(Debug)]
pub enum LoadError {
    Io(std::io::Error),
    Abi(Errno),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::Io(e) => write!(f, "reading the pak failed: {e}"),
            LoadError::Abi(e) => write!(f, "loading the pak failed: {e}"),
        }
    }
}

impl std::error::Error for LoadError {}

impl From<Errno> for LoadError {
    fn from(e: Errno) -> Self {
        LoadError::Abi(e)
    }
}

impl From<std::io::Error> for LoadError {
    fn from(e: std::io::Error) -> Self {
        LoadError::Io(e)
    }
}

/// One child of a listing: the raw NS1 name plus its stat record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub stat: Stat,
}

impl DirEntry {
    pub fn is_dir(&self) -> bool {
        self.stat.is_dir()
    }
}

// ---------------------------------------------------------------------------
// The C ABI (tension-res/include/tension_res.h)
// ---------------------------------------------------------------------------

/// The opaque handle. C never dereferences it and neither do we.
#[repr(C)]
pub struct TensionRes {
    _private: [u8; 0],
}

extern "C" {
    fn tension_res_load(
        bytes: *const u8,
        len: usize,
        out: *mut *mut TensionRes,
        err: *mut std::ffi::c_char,
        errcap: usize,
    ) -> i32;
    fn tension_res_load_borrowed(
        bytes: *const u8,
        len: usize,
        out: *mut *mut TensionRes,
        err: *mut std::ffi::c_char,
        errcap: usize,
    ) -> i32;
    fn tension_res_free(res: *mut TensionRes);
    fn tension_res_open(res: *const TensionRes, path: *const u8, path_len: usize) -> i32;
    fn tension_res_read(res: *const TensionRes, fd: i32, dst: *mut u8, len: usize) -> i32;
    fn tension_res_seek(res: *const TensionRes, fd: i32, off: i64, whence: i32) -> i64;
    fn tension_res_tell(res: *const TensionRes, fd: i32) -> i64;
    fn tension_res_stat_path(
        res: *const TensionRes,
        path: *const u8,
        path_len: usize,
        out: *mut Stat,
    ) -> i32;
    fn tension_res_stat_fd(res: *const TensionRes, fd: i32, out: *mut Stat) -> i32;
    fn tension_res_readdir(
        res: *const TensionRes,
        path: *const u8,
        path_len: usize,
        index: u32,
        name: *mut u8,
        name_cap: usize,
        out: *mut Stat,
    ) -> i32;
    fn tension_res_close(res: *const TensionRes, fd: i32) -> i32;
    fn tension_res_pack(
        dir: *const std::ffi::c_char,
        out: *const std::ffi::c_char,
        err: *mut std::ffi::c_char,
        errcap: usize,
    ) -> i32;
}

/// Pack a source directory into an ECMA-208 volume (the build-time tool; the
/// runtime never calls this). Returns the ABI's summary message on success.
///
/// This is the one place a Rust caller reaches the writer, and it goes through
/// the same `tension_res_pack` the `tension-core pack` subcommand uses.
pub fn pack(source_dir: &Path, out: &Path) -> Result<String, LoadError> {
    let src = std::ffi::CString::new(path_bytes(source_dir).as_ref())
        .map_err(|_| LoadError::Abi(Errno(-22)))?;
    let dst = std::ffi::CString::new(path_bytes(out).as_ref())
        .map_err(|_| LoadError::Abi(Errno(-22)))?;
    let mut msg = [0u8; 256];
    let rc = unsafe {
        tension_res_pack(
            src.as_ptr(),
            dst.as_ptr(),
            msg.as_mut_ptr().cast(),
            msg.len(),
        )
    };
    let end = msg.iter().position(|b| *b == 0).unwrap_or(msg.len());
    let text = String::from_utf8_lossy(&msg[..end]).into_owned();
    if rc == 0 {
        Ok(text)
    } else {
        Err(LoadError::Abi(Errno(rc)))
    }
}

#[cfg(unix)]
fn path_bytes(p: &Path) -> std::borrow::Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;
    p.as_os_str().as_bytes().into()
}

#[cfg(not(unix))]
fn path_bytes(p: &Path) -> std::borrow::Cow<'_, [u8]> {
    p.to_string_lossy().into_owned().into_bytes().into()
}

/// Whether a load copies the blob (owned) or borrows the caller's bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ownership {
    Copied,
    Borrowed,
    /// Borrowed from a `Vec` this struct keeps alive.
    BorrowedFromOwned,
}

/// A loaded pak: the C handle plus what keeps its bytes valid.
///
/// `'a` is the lifetime of the bytes a borrowed set serves; an owned or copied
/// set is `ResourceSet<'static>` because it depends on nothing outside itself.
pub struct ResourceSet<'a> {
    handle: *mut TensionRes,
    ownership: Ownership,
    /// Present only for `BorrowedFromOwned`: the buffer the handle points at.
    /// Nothing may mutate it, and `Drop` frees the handle first.
    backing: Option<Vec<u8>>,
    _lifetime: PhantomData<&'a [u8]>,
}

// The handle is used from one thread at a time by construction (the wasm host
// is single-threaded and `Fd` borrows the set), but nothing in the Zig side is
// thread-affine; the raw pointer is safe to move between threads.
unsafe impl Send for ResourceSet<'_> {}
unsafe impl Sync for ResourceSet<'_> {}

impl ResourceSet<'static> {
    /// Copy the blob into the handle: `bytes` may be dropped immediately.
    pub fn load(bytes: &[u8]) -> Result<Self, Errno> {
        match load_raw(bytes.as_ptr(), bytes.len(), false) {
            Load::Handle(handle) => Ok(ResourceSet {
                handle,
                ownership: Ownership::Copied,
                backing: None,
                _lifetime: PhantomData,
            }),
            Load::Failed(errno) => Err(errno),
        }
    }

    /// Take ownership of `bytes` and let the handle borrow them: one copy of
    /// the pak in the process, no self-reference in the caller.
    pub fn load_from_vec(bytes: Vec<u8>) -> Result<Self, Errno> {
        if bytes.is_empty() {
            return Err(Errno(-22));
        }
        match load_raw(bytes.as_ptr(), bytes.len(), true) {
            Load::Handle(handle) => Ok(ResourceSet {
                handle,
                ownership: Ownership::BorrowedFromOwned,
                backing: Some(bytes),
                _lifetime: PhantomData,
            }),
            Load::Failed(errno) => Err(errno),
        }
    }

    /// Read a pak from disk and take ownership of its bytes (1× memory).
    pub fn load_file(path: impl AsRef<Path>) -> Result<Self, LoadError> {
        let bytes = std::fs::read(path)?;
        Ok(Self::load_from_vec(bytes)?)
    }
}

impl<'a> ResourceSet<'a> {
    /// Borrow the caller's bytes: the handle does not copy, so `bytes` must
    /// outlive the returned set — which is exactly what `'a` says.
    pub fn load_borrowed(bytes: &'a [u8]) -> Result<Self, Errno> {
        match load_raw(bytes.as_ptr(), bytes.len(), true) {
            Load::Handle(handle) => Ok(ResourceSet {
                handle,
                ownership: Ownership::Borrowed,
                backing: None,
                _lifetime: PhantomData,
            }),
            Load::Failed(errno) => Err(errno),
        }
    }

    // -- path-addressed calls ---------------------------------------------

    /// Stat a path (`/`-rooted, POSIX separators, case-sensitive).
    pub fn stat(&self, path: &str) -> Result<Stat, Errno> {
        let mut out = Stat::default();
        let rc = unsafe {
            tension_res_stat_path(self.handle, path.as_ptr(), path.len(), &mut out as *mut Stat)
        };
        if rc == 0 {
            Ok(out)
        } else {
            Err(Errno(rc))
        }
    }

    /// Whether the path resolves to anything.
    pub fn exists(&self, path: &str) -> bool {
        self.stat(path).is_ok()
    }

    /// Whether the path resolves to a directory.
    pub fn is_dir(&self, path: &str) -> bool {
        self.stat(path).map(|s| s.is_dir()).unwrap_or(false)
    }

    /// Open a file. The returned `Fd` closes on drop.
    pub fn open(&self, path: &str) -> Result<Fd<'_, 'a>, Errno> {
        Ok(Fd {
            set: self,
            fd: self.open_fd(path)?,
        })
    }

    /// One step of a directory listing, by ordinal (NS1 byte order).
    pub fn read_dir_at(&self, path: &str, index: u32) -> Result<Option<DirEntry>, Errno> {
        let mut stat = Stat::default();
        let mut name = vec![0u8; 256];
        loop {
            let rc = unsafe {
                tension_res_readdir(
                    self.handle,
                    path.as_ptr(),
                    path.len(),
                    index,
                    name.as_mut_ptr(),
                    name.len(),
                    &mut stat as *mut Stat,
                )
            };
            if rc < 0 {
                return Err(Errno(rc));
            }
            if rc == 0 {
                return Ok(None);
            }
            let len = rc as usize;
            if len > name.len() {
                name.resize(len, 0); // the header's size-probe convention
                continue;
            }
            let raw = String::from_utf8_lossy(&name[..len]).into_owned();
            return Ok(Some(DirEntry { name: raw, stat }));
        }
    }

    /// Every child of a directory, in the order the pak stores them (NS1 byte
    /// order — the packer's invariant, §8.1).
    pub fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>, Errno> {
        let mut out = Vec::new();
        let mut index: u32 = 0;
        while let Some(entry) = self.read_dir_at(path, index)? {
            out.push(entry);
            index += 1;
        }
        Ok(out)
    }

    /// Read a whole file.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>, Errno> {
        let stat = self.stat(path)?;
        if stat.is_dir() {
            return Err(Errno(-21)); // EISDIR, as the ABI would say
        }
        let mut fd = self.open(path)?;
        let mut out = Vec::with_capacity(stat.size as usize);
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = fd.read(&mut chunk)?;
            if n == 0 {
                return Ok(out);
            }
            out.extend_from_slice(&chunk[..n]);
        }
    }

    // -- fd-addressed calls (what the `tension::res` imports use) ----------

    /// Open a file and return the raw fd (the caller owns it).
    pub fn open_fd(&self, path: &str) -> Result<i32, Errno> {
        let fd = unsafe { tension_res_open(self.handle, path.as_ptr(), path.len()) };
        if fd >= 0 {
            Ok(fd)
        } else {
            Err(Errno(fd))
        }
    }

    /// Read into `dst`; `Ok(0)` is end of file.
    pub fn read_fd(&self, fd: i32, dst: &mut [u8]) -> Result<usize, Errno> {
        let rc = unsafe { tension_res_read(self.handle, fd, dst.as_mut_ptr(), dst.len()) };
        if rc < 0 {
            Err(Errno(rc))
        } else {
            Ok(rc as usize)
        }
    }

    /// Seek; `whence` is 0 = SET, 1 = CUR, 2 = END.
    pub fn seek_fd(&self, fd: i32, off: i64, whence: i32) -> Result<i64, Errno> {
        let rc = unsafe { tension_res_seek(self.handle, fd, off, whence) };
        if rc < 0 {
            Err(Errno(rc as i32))
        } else {
            Ok(rc)
        }
    }

    /// Current position of an open fd.
    pub fn tell_fd(&self, fd: i32) -> Result<i64, Errno> {
        let rc = unsafe { tension_res_tell(self.handle, fd) };
        if rc < 0 {
            Err(Errno(rc as i32))
        } else {
            Ok(rc)
        }
    }

    /// Stat an open fd — byte-identical to `stat` on the same file (§7.4).
    pub fn stat_fd(&self, fd: i32) -> Result<Stat, Errno> {
        let mut out = Stat::default();
        let rc = unsafe { tension_res_stat_fd(self.handle, fd, &mut out as *mut Stat) };
        if rc == 0 {
            Ok(out)
        } else {
            Err(Errno(rc))
        }
    }

    /// Close an fd (idempotent for in-range fds).
    pub fn close_fd(&self, fd: i32) -> Result<(), Errno> {
        let rc = unsafe { tension_res_close(self.handle, fd) };
        if rc == 0 {
            Ok(())
        } else {
            Err(Errno(rc))
        }
    }

    /// How this set keeps its bytes: for diagnostics and tests.
    pub fn ownership_label(&self) -> &'static str {
        match self.ownership {
            Ownership::Copied => "copied",
            Ownership::Borrowed => "borrowed",
            Ownership::BorrowedFromOwned => "borrowed-from-owned",
        }
    }

    /// Whether the handle owns (and will free) the bytes it serves.
    pub fn owns_backing(&self) -> bool {
        self.backing.is_some()
    }
}

impl Drop for ResourceSet<'_> {
    fn drop(&mut self) {
        // Free the handle first: for `BorrowedFromOwned` it points into
        // `backing`, which is released (as a field) after this body runs.
        unsafe { tension_res_free(self.handle) };
    }
}

impl fmt::Debug for ResourceSet<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResourceSet")
            .field("ownership", &self.ownership_label())
            .finish_non_exhaustive()
    }
}

/// An open file. Closes on drop; borrows the set, so it cannot outlive it.
pub struct Fd<'s, 'a> {
    set: &'s ResourceSet<'a>,
    fd: i32,
}

impl Fd<'_, '_> {
    pub fn raw(&self) -> i32 {
        self.fd
    }

    pub fn read(&mut self, dst: &mut [u8]) -> Result<usize, Errno> {
        self.set.read_fd(self.fd, dst)
    }

    pub fn seek(&mut self, off: i64, whence: i32) -> Result<i64, Errno> {
        self.set.seek_fd(self.fd, off, whence)
    }

    pub fn tell(&self) -> Result<i64, Errno> {
        self.set.tell_fd(self.fd)
    }

    pub fn stat(&self) -> Result<Stat, Errno> {
        self.set.stat_fd(self.fd)
    }

    pub fn read_all(&mut self) -> Result<Vec<u8>, Errno> {
        let size = self.stat()?.size as usize;
        let mut out = Vec::with_capacity(size);
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = self.read(&mut chunk)?;
            if n == 0 {
                return Ok(out);
            }
            out.extend_from_slice(&chunk[..n]);
        }
    }
}

impl fmt::Debug for Fd<'_, '_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Fd").field("fd", &self.fd).finish()
    }
}

impl Drop for Fd<'_, '_> {
    fn drop(&mut self) {
        let _ = self.set.close_fd(self.fd);
    }
}

// ---------------------------------------------------------------------------
// the one unsafe entry point
// ---------------------------------------------------------------------------

enum Load {
    Handle(*mut TensionRes),
    Failed(Errno),
}

/// Call one of the load entry points, capturing the ABI's error message into
/// the returned errno's description on the way out.
fn load_raw(bytes: *const u8, len: usize, borrow: bool) -> Load {
    let mut handle: *mut TensionRes = std::ptr::null_mut();
    let mut msg = [0u8; 256];
    let rc = unsafe {
        if borrow {
            tension_res_load_borrowed(
                bytes,
                len,
                &mut handle,
                msg.as_mut_ptr().cast(),
                msg.len(),
            )
        } else {
            tension_res_load(bytes, len, &mut handle, msg.as_mut_ptr().cast(), msg.len())
        }
    };
    if rc == 0 && !handle.is_null() {
        Load::Handle(handle)
    } else {
        if !msg.is_empty() {
            let end = msg.iter().position(|b| *b == 0).unwrap_or(msg.len());
            let text = String::from_utf8_lossy(&msg[..end]);
            if !text.is_empty() {
                eprintln!("[tension-core] pak load failed: {}", text);
            }
        }
        Load::Failed(Errno(if rc == 0 { -22 } else { rc }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_layout_matches_the_header() {
        assert_eq!(std::mem::size_of::<Stat>(), 12);
        assert_eq!(std::mem::align_of::<Stat>(), 4);
    }

    #[test]
    fn errno_display_names_the_code() {
        assert!(Errno(-2).to_string().starts_with("-2 (ENOENT"));
        assert!(Errno(-22).to_string().contains("EINVAL"));
    }

    #[test]
    fn loading_garbage_fails_with_an_errno() {
        let garbage = vec![0u8; 4096];
        assert!(matches!(ResourceSet::load(&garbage), Err(Errno(-22))));
        assert!(matches!(
            ResourceSet::load_from_vec(garbage),
            Err(Errno(-22))
        ));
    }

    #[test]
    fn empty_input_is_rejected_before_the_abi() {
        assert!(matches!(ResourceSet::load_from_vec(Vec::new()), Err(Errno(-22))));
    }
}
