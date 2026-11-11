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

/// The 12-byte record the host ABI reports (`tension_res_stat`, `tension-res/DESIGN.md` §7.4).
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
            28 => "ENOSPC",
            30 => "EROFS",
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
            28 => "the buffer is smaller than what is being written",
            30 => "read-only: the path leaves the writable root",
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

    /// The bytes this set owns, when it owns them.
    ///
    /// `Some` for a set built by `load_from_vec` or `load_file`, `None` for a
    /// copied or borrowed one — a copied set has no image in the process and a
    /// borrowed one belongs to its caller, so neither can hand out a pointer.
    ///
    /// This exists for one caller: `res_mount` must give an adapter the volume
    /// image so the adapter can parse it over the *same* bytes rather than
    /// reading the disk a second time. The slice is stable for the set's life
    /// (`backing` is a heap allocation nothing mutates or moves), which is what
    /// makes it safe to hand out while the set is alive.
    pub fn bytes(&self) -> Option<&[u8]> {
        self.backing.as_deref()
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
                // A resource the guest asked for should have loaded: the
                // failure is a warning on the `core` logger, so it shares the
                // one layout (and `--log-format=json` stays JSON).
                crate::logging::log(
                    crate::logging::Level::Warn,
                    "core",
                    &format!("pak load failed: {text}"),
                );
            }
        }
        Load::Failed(Errno(if rc == 0 { -22 } else { rc }))
    }
}

// ── the mount table ───────────────────────────────────────────────────────

/// One mount: a pak's bytes and the prefix guest paths reach them under.
///
/// **This is the single mount table's entry type.** It holds both the `--res`
/// paks (prefix `""`, one flat merged namespace, which is what they always
/// were) and the volumes a guest mounts with `tension::res.mount`. Making them
/// one type is what stops "mounted" meaning two things: before this, the Ogre
/// capability kept a second table with its own resolution rule and its own file
/// reader, so one volume had to be handed to the host *and* to the adapter to be
/// visible to both.
pub struct Mount {
    /// `""` for a flat `--res` pak; otherwise a name with no trailing slash. A
    /// mount under `"resources"` answers for `resources/models/x.mesh` and for
    /// nothing else — `resources-old` is a different name.
    pub prefix: String,
    pub set: ResourceSet<'static>,
}

impl Mount {
    /// A `--res` pak: no prefix, so it answers for every path it contains.
    pub fn flat(set: ResourceSet<'static>) -> Self {
        Self {
            prefix: String::new(),
            set,
        }
    }

    /// The path inside this pak that `path` names, or `None` when this mount
    /// does not answer for it.
    ///
    /// A guest may write a leading `/` or not (`res_read_file("/docs.bin")` and
    /// `res_read_file("models/x.ozz")` are both in this tree), so the prefix is
    /// matched against the path with the slash removed and the remainder is
    /// handed to the library, which accepts both forms.
    pub fn relative<'p>(&self, path: &'p str) -> Option<&'p str> {
        if self.prefix.is_empty() {
            return Some(path);
        }
        let trimmed = path.strip_prefix('/').unwrap_or(path);
        let rest = trimmed.strip_prefix(self.prefix.as_str())?;
        // The boundary matters: mount `resources` does not answer for
        // `resources-old/x`, and the bare prefix names a directory, not a file.
        rest.strip_prefix('/')
    }
}

/// Every volume the session can read: `--res` paks first, then whatever a guest
/// or a capability mounted.
///
/// Shared by `Arc<Mutex<_>>` between the store (which serves the
/// `tension::res` verbs) and the adapter host (which serves
/// [`tension_core_api::res_volume_bytes`] so a capability's worker thread can
/// parse the same image). One table, two views of it, one set of rules.
pub struct MountTable {
    entries: Vec<Mount>,
}

impl Default for MountTable {
    fn default() -> Self {
        Self::new()
    }
}

impl MountTable {
    pub fn new() -> Self {
        Self { entries: Vec::new() }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// One mount by its index — which is also what a guest fd's high bits name.
    pub fn get(&self, index: usize) -> Option<&Mount> {
        self.entries.get(index)
    }

    /// Every mounted set, for the load-time conflict check.
    pub fn sets(&self) -> Vec<&ResourceSet<'static>> {
        self.entries.iter().map(|mount| &mount.set).collect()
    }

    /// Append a `--res` pak and answer its index.
    pub fn push_flat(&mut self, set: ResourceSet<'static>) -> usize {
        let index = self.entries.len();
        self.entries.push(Mount::flat(set));
        index
    }

    /// Whether `prefix` is already taken.
    pub fn has_prefix(&self, prefix: &str) -> bool {
        self.entries.iter().any(|mount| mount.prefix == prefix)
    }

    /// The index of the mount under `prefix`, if there is one.
    pub fn index_of(&self, prefix: &str) -> Option<usize> {
        self.entries
            .iter()
            .position(|mount| mount.prefix == prefix)
    }

    /// Mount `path` under `prefix`, reading and parsing the volume.
    ///
    /// The one implementation of what mounting *means*: validate the name, read
    /// the file once, parse it with this library. Every caller — the guest's
    /// `res.mount`, the Ogre adapter's deprecated `mount_tns`, and the
    /// adapter-facing volume slot — reaches it here, so the rules cannot drift
    /// between them.
    ///
    /// Refusals: `-EINVAL` for an empty or path-shaped prefix or an empty path,
    /// `-EEXIST` for a prefix already mounted, `-ENOENT` for a file that is not
    /// there, `-EIO` for a volume that does not parse.
    pub fn mount(&mut self, prefix: &str, path: &str) -> Result<usize, Errno> {
        // A prefix is a *name*: it is matched against one leading path segment,
        // so it must not spell one itself. `resources/` and `resources` would
        // otherwise be two mounts shadowing each other's answers.
        if prefix.is_empty() || path.is_empty() {
            return Err(Errno(-22)); // EINVAL
        }
        if prefix.starts_with('/') || prefix.ends_with('/') || prefix.contains("//") {
            return Err(Errno(-22)); // EINVAL
        }
        if self.has_prefix(prefix) {
            return Err(Errno(-17)); // EEXIST
        }
        let set = ResourceSet::load_file(path).map_err(|error| match error {
            LoadError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => Errno(-2), // ENOENT
            LoadError::Abi(errno) => errno,
            _ => Errno(-5), // EIO
        })?;
        let index = self.entries.len();
        self.entries.push(Mount {
            prefix: prefix.to_string(),
            set,
        });
        Ok(index)
    }

    /// Resolution: the **most specific** mount that answers wins, and among
    /// equally specific ones the earliest.
    ///
    /// Specificity is prefix length, which gives all three rules this table
    /// needs in one comparison:
    ///
    ///   * a mount under `"resources"` beats a flat pak for `resources/x.mesh`,
    ///     because 10 > 0;
    ///   * two `--res` paks are both flat, so load order decides (§7.2's
    ///     first-match rule, unchanged);
    ///   * a mount that does not answer for the path at all (`relative` is
    ///     `None`) is skipped without being tried, so it cannot report a
    ///     misleading error.
    ///
    /// `-ENOENT` from every candidate stays `-ENOENT`; any other failure is
    /// reported rather than masked, so a malformed path is never disguised as a
    /// miss.
    pub fn resolve<T>(
        &self,
        path: &str,
        mut f: impl FnMut(&ResourceSet<'static>, &str) -> Result<T, Errno>,
    ) -> Result<(usize, T), Errno> {
        // Specificity order. A `Vec` is deliberate rather than an array: the
        // table is a handful of entries and `open` is not a per-frame call, so
        // the allocation is cheaper than the arithmetic that would avoid it.
        let mut order: Vec<usize> = (0..self.entries.len()).collect();
        order.sort_by_key(|&index| (std::cmp::Reverse(self.entries[index].prefix.len()), index));

        let mut first_error: Option<Errno> = None;
        for index in order {
            let mount = &self.entries[index];
            let Some(relative) = mount.relative(path) else {
                continue;
            };
            match f(&mount.set, relative) {
                Ok(value) => return Ok((index, value)),
                Err(e) if e.code() != -2 => first_error = first_error.or(Some(e)),
                Err(_) => {}
            }
        }
        Err(first_error.unwrap_or(Errno(-2)))
    }
}

// ── the writable root ──────────────────────────────────────────────────────

/// A directory outside the paks that a guest may write files into.
///
/// **Why this exists at all.** `tension::res` has been read-only since it was
/// written: a pak is a packed archive, and there is no verb that changes one.
/// An editor cannot save a document through it, and "the runtime has no write"
/// is a fine property for a *container* but not for a *platform*.
///
/// **Why writes do not go into the paks.** A pak is immutable by design — the
/// host memory-maps it, several sets merge into one namespace, and an archive
/// that a guest can append to is an archive whose offsets can move under the
/// code reading it. So a write lands on the real filesystem, under one root the
/// host chose, and the pak namespace stays what it was: the read side.
///
/// **The sandbox is the point.** A guest is arbitrary code. Every path is
/// resolved against the root and refused unless it stays inside it, by three
/// rules that cover the three ways out:
///
/// * `..` and `.` are refused as components rather than normalized away. A path
///   that says `..` is a path that is trying to leave, and a normalizer that
///   silently rewrote it would be the thing that let it.
/// * absolute paths and drive-qualified paths are refused, so there is no second
///   root to escape to.
/// * the *parent* directory is canonicalized and compared against the canonical
///   root before the file is created, which is what catches a symlink inside the
///   root pointing out of it. A target that is itself a symlink is refused
///   rather than followed.
///
/// A refusal is `-EROFS`, not `-EACCES`: nothing about the file's permissions is
/// being tested, and the guest needs to tell "the sandbox said no" from "the
/// disk said no" — the first is a bug in its own path handling, the second is
/// the user's problem.
pub struct WriteRoot {
    root: std::path::PathBuf,
}

impl WriteRoot {
    /// Take `root` as the write sandbox, canonicalized once.
    ///
    /// Canonicalizing here rather than per call is what makes the parent check
    /// a prefix comparison instead of a string game: both sides of the
    /// comparison came out of the same resolver.
    pub fn new(root: impl AsRef<std::path::Path>) -> Result<Self, Errno> {
        let root = std::fs::canonicalize(root.as_ref()).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Errno(-2), // ENOENT
            _ => Errno(-5),                            // EIO
        })?;
        if !root.is_dir() {
            return Err(Errno(-20)); // ENOTDIR
        }
        Ok(Self { root })
    }

    /// The root itself, for a log line or a test.
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// The components of a guest path, or `-EROFS` if it may not leave the root.
    fn components(path: &str) -> Result<Vec<&str>, Errno> {
        if path.is_empty() || path.contains('\0') {
            return Err(Errno(-22)); // EINVAL: nothing to name
        }
        if path.starts_with('/') {
            return Err(Errno(-30)); // EROFS: an absolute path names another root
        }
        // A backslash is a separator on one platform and a legal character on
        // the others; accepting it as either is how `..\\..` gets through a
        // check written for `/`.
        if path.contains('\\') {
            return Err(Errno(-30));
        }
        // A drive letter or a UNC prefix: same reasoning as the leading slash.
        if path.len() >= 2 && path.as_bytes()[1] == b':' {
            return Err(Errno(-30));
        }
        let mut parts = Vec::new();
        for part in path.split('/') {
            if part.is_empty() || part == "." || part == ".." {
                return Err(Errno(-30));
            }
            parts.push(part);
        }
        Ok(parts)
    }

    /// The absolute path `guest_path` names, refused unless it stays in the root.
    pub fn resolve(&self, guest_path: &str) -> Result<std::path::PathBuf, Errno> {
        let parts = Self::components(guest_path)?;
        let mut full = self.root.clone();
        for part in parts {
            full.push(part);
        }
        Ok(full)
    }

    /// Write `bytes` to `guest_path`, creating parent directories.
    ///
    /// Returns the number of bytes written. The atomicity note matters for the
    /// case this exists for: an editor saving a document writes a temporary file
    /// beside the target and renames it, so a crash mid-save leaves the old
    /// document rather than half of the new one.
    pub fn write(&self, guest_path: &str, bytes: &[u8]) -> Result<u32, Errno> {
        let target = self.resolve(guest_path)?;

        // The parent must exist (or be creatable) *and* still be inside the
        // root once the filesystem has resolved any symlinks in it.
        let parent = target.parent().ok_or(Errno(-22))?;
        std::fs::create_dir_all(parent).map_err(|_| Errno(-5))?;
        let real_parent = std::fs::canonicalize(parent).map_err(|_| Errno(-5))?;
        if !real_parent.starts_with(&self.root) {
            return Err(Errno(-30)); // a symlink in the parent chain left the root
        }

        // A target that is already a symlink is refused rather than followed:
        // following it would write wherever it points, which the parent check
        // above cannot see.
        if let Ok(metadata) = std::fs::symlink_metadata(&target) {
            if metadata.file_type().is_symlink() {
                return Err(Errno(-30));
            }
            if metadata.is_dir() {
                return Err(Errno(-21)); // EISDIR
            }
        }

        let real_target = real_parent.join(target.file_name().ok_or(Errno(-22))?);
        std::fs::write(&real_target, bytes).map_err(|_| Errno(-5))?;
        Ok(bytes.len() as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory under the system temp dir, removed by the caller.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tension-wres-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the temp dir is creatable");
        dir
    }
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

    // ── the write sandbox ──────────────────────────────────────────────────

    #[test]
    fn write_root_refuses_every_way_out() {
        let dir = scratch("escape");
        let root = WriteRoot::new(&dir).expect("a directory is a valid root");

        // The three escapes, as the guest would spell them.
        assert_eq!(root.resolve("../escape.txt").unwrap_err().code(), -30);
        assert_eq!(root.resolve("a/../../b.txt").unwrap_err().code(), -30);
        assert_eq!(root.resolve("./a.txt").unwrap_err().code(), -30);
        assert_eq!(root.resolve("/etc/passwd").unwrap_err().code(), -30);
        assert_eq!(root.resolve("C:/temp/x.txt").unwrap_err().code(), -30);
        assert_eq!(root.resolve("..\\..\\x.txt").unwrap_err().code(), -30);
        assert_eq!(root.resolve("").unwrap_err().code(), -22);

        // And the one that must work.
        let inside = root.resolve("docs/page.md").expect("a relative path stays in");
        assert!(inside.starts_with(root.root()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_root_writes_and_creates_parents() {
        let dir = scratch("write");
        let root = WriteRoot::new(&dir).expect("a directory is a valid root");

        let written = root.write("nested/deeper/doc.tns", b"hello").expect("a write inside the root");
        assert_eq!(written, 5);
        let read = std::fs::read(directory(&dir).join("nested/deeper/doc.tns"));
        assert_eq!(read.expect("the file exists"), b"hello");

        // Overwriting is a write, not an append: the second call is the file.
        root.write("nested/deeper/doc.tns", b"bye").expect("a rewrite");
        let again = std::fs::read(directory(&dir).join("nested/deeper/doc.tns")).unwrap();
        assert_eq!(again, b"bye");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The dir itself, canonicalized: on macOS `/var` is a symlink to
    /// `/private/var`, and a test that compared raw paths would fail there for
    /// a reason unrelated to the sandbox.
    fn directory(path: &std::path::Path) -> std::path::PathBuf {
        std::fs::canonicalize(path).expect("the temp dir resolves")
    }

    #[test]
    fn write_root_refuses_a_directory_target() {
        let dir = scratch("isdir");
        let root = WriteRoot::new(&dir).expect("a directory is a valid root");
        std::fs::create_dir_all(directory(&dir).join("taken")).unwrap();
        assert_eq!(root.write("taken", b"x").unwrap_err().code(), -21);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn write_root_refuses_a_symlink_that_leaves() {
        let outside = scratch("outside");
        let dir = scratch("link");
        let root = WriteRoot::new(&dir).expect("a directory is a valid root");

        // A symlink inside the root pointing at a directory outside it. The
        // parent check is what must catch this: the path itself looks relative.
        let link = directory(&dir).join("link");
        std::os::unix::fs::symlink(directory(&outside), &link).expect("a symlink is creatable");
        assert_eq!(root.write("link/escaped.txt", b"x").unwrap_err().code(), -30);
        assert!(!directory(&outside).join("escaped.txt").exists());

        // And a symlink as the *target* is refused rather than followed.
        let file_link = directory(&dir).join("target-link");
        std::os::unix::fs::symlink(directory(&outside).join("x.txt"), &file_link).unwrap();
        assert_eq!(root.write("target-link", b"x").unwrap_err().code(), -30);

        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
