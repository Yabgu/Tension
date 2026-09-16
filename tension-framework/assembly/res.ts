// Guest-side bindings for the Tension resource host ABI (`tension::res`).
//
// The guest imports these functions from the host under the wasm module name
// `tension::res`; tension-core implements them over the ECMA-208 (SIDF) pak
// reader. Paths cross as UTF-8 bytes with an explicit pointer and length, the
// same convention as `tension::io arg`; stat records are 12 bytes
// {kind: u32, size: u32, flags: u32}; every error is a negative POSIX errno.
//
// The split this file implements (DESIGN.md §7):
//
//   * the VFS is strict — a path that does not resolve returns -ENOENT,
//     including every path when no pak is loaded;
//   * the framework is lenient — -ENOENT becomes `null` for stat/open, `[]`
//     for listings, `false` for existence, -1 for sizes;
//   * `readdir` hands back the child's raw NS1 name; the `/` suffix that marks
//     a directory is added here, for the game author, and nowhere else.
//
// Nothing here throws: errors are null / -1 / false / empty, matching the rest
// of the framework.

@external("tension::res", "res_open")
declare function hostResOpen(pathPtr: usize, pathLen: i32): i32;

@external("tension::res", "res_close")
declare function hostResClose(fd: i32): i32;

@external("tension::res", "res_read")
declare function hostResRead(fd: i32, ptr: usize, len: i32): i32;

@external("tension::res", "res_seek")
declare function hostResSeek(fd: i32, off: i64, whence: i32): i64;

@external("tension::res", "res_tell")
declare function hostResTell(fd: i32): i64;

@external("tension::res", "res_stat")
declare function hostResStat(pathPtr: usize, pathLen: i32, outPtr: usize): i32;

@external("tension::res", "res_stat_fd")
declare function hostResStatFd(fd: i32, outPtr: usize): i32;

@external("tension::res", "res_readdir")
declare function hostResReaddir(
  pathPtr: usize,
  pathLen: i32,
  index: i32,
  namePtr: usize,
  nameCap: i32,
  outPtr: usize,
): i32;

/** `RES_SEEK_SET`: seek from the start of the file. */
export const RES_SEEK_SET: i32 = 0;
/** `RES_SEEK_CUR`: seek from the current position. */
export const RES_SEEK_CUR: i32 = 1;
/** `RES_SEEK_END`: seek from the end of the file. */
export const RES_SEEK_END: i32 = 2;

/** The stat record's `kind` for a file. */
export const RES_KIND_FILE: u32 = 0;
/** The stat record's `kind` for a directory. */
export const RES_KIND_DIRECTORY: u32 = 1;
/** `flags` bit 0: the File's payload is stored compressed (Deflate) and
 * `read` expands it transparently — the guest always sees expanded bytes. */
export const RES_FLAG_COMPRESSED: u32 = 1;

const ENOENT: i32 = -2;

/** One child of a listed directory, as the game sees it. */
export class ResEntry {
  /** The child's name; directories carry a trailing `/`. */
  name: string;
  /** Whether the child is a directory. */
  isDir: bool;
  /** The payload size in bytes (0 for a directory). Always the *expanded*
   * size: a compressed File reads back at this length. */
  size: i32;
  /** Whether the File is stored compressed. `read` expands it either way;
   * this is how a game can tell that it is paying decode time for the bytes. */
  isCompressed: bool;

  constructor(name: string, isDir: bool, size: i32, isCompressed: bool = false) {
    this.name = name;
    this.isDir = isDir;
    this.size = size;
    this.isCompressed = isCompressed;
  }

  /** The child's path relative to `parent`, ready to pass to the API. */
  pathIn(parent: string): string {
    if (parent.length > 0 && parent.charAt(parent.length - 1) == "/") {
      return parent + this.name;
    }
    return parent.length == 0 ? this.name : parent + "/" + this.name;
  }
}

/** The 12-byte host stat record, decoded. */
class StatRecord {
  kind: u32 = 0;
  size: u32 = 0;
  flags: u32 = 0;

  get isDir(): bool {
    return this.kind == RES_KIND_DIRECTORY;
  }

  get isCompressed(): bool {
    return (this.flags & RES_FLAG_COMPRESSED) != 0;
  }
}

const statBuf = new ArrayBuffer(12);

function loadStat(): StatRecord {
  const out = new StatRecord();
  out.kind = load<u32>(changetype<usize>(statBuf));
  out.size = load<u32>(changetype<usize>(statBuf) + 4);
  out.flags = load<u32>(changetype<usize>(statBuf) + 8);
  return out;
}

function statOf(path: string): StatRecord | null {
  const bytes = String.UTF8.encode(path);
  if (hostResStat(changetype<usize>(bytes), i32(bytes.byteLength), changetype<usize>(statBuf)) != 0) {
    return null;
  }
  return loadStat();
}

function statOfFd(fd: i32): StatRecord | null {
  if (hostResStatFd(fd, changetype<usize>(statBuf)) != 0) return null;
  return loadStat();
}

/**
 * The child at `index` of the directory at `path`, or `null` past the end.
 * Names come back raw; `isDir` is what marks a directory.
 */
function readdirAt(path: string, index: i32): ResEntry | null {
  const bytes = String.UTF8.encode(path);
  let name = new ArrayBuffer(64);
  while (true) {
    const n = hostResReaddir(
      changetype<usize>(bytes),
      i32(bytes.byteLength),
      index,
      changetype<usize>(name),
      i32(name.byteLength),
      changetype<usize>(statBuf),
    );
    if (n < 0) return null; // -ENOENT / -ENOTDIR / -EINVAL: no such listing
    if (n == 0) return null; // past the last child
    if (n > name.byteLength) {
      name = new ArrayBuffer(n); // the size-probe convention: grow and retry
      continue;
    }
    const stat = loadStat();
    return new ResEntry(
      String.UTF8.decode(name.slice(0, n)),
      stat.isDir,
      i32(stat.size),
      stat.isCompressed,
    );
  }
  return null;
}

function hasPak(): bool {
  // No pak loaded is not a special case: every path misses, so stat("/") is
  // the cheapest probe (strict VFS, §7.2).
  return statOf("/") != null;
}

/**
 * Stat a path. Returns `null` when the path does not resolve — including every
 * path when no pak is loaded.
 */
export function resStat(path: string): ResEntry | null {
  const stat = statOf(path);
  if (stat == null) return null;
  const name = path.length > 0 ? path : "/";
  return new ResEntry(name, stat.isDir, i32(stat.size), stat.isCompressed);
}

/** Whether the path resolves. `false` for anything that does not. */
export function resExists(path: string): bool {
  return statOf(path) != null;
}

/** Whether the path is a directory. `false` when it does not resolve. */
export function resIsDir(path: string): bool {
  const stat = statOf(path);
  return stat != null && stat.isDir;
}

/** The payload size of a file, or -1 when the path is not a file. */
export function resSize(path: string): i32 {
  const stat = statOf(path);
  if (stat == null || stat.isDir) return -1;
  return i32(stat.size);
}

/**
 * The children of a directory, in the order the pak stores them (NS1 byte
 * order), with `/` appended to directory names. `[]` for a missing directory,
 * for a file, or when no pak is loaded.
 */
export function resEntries(path: string = "/"): ResEntry[] {
  const out = new Array<ResEntry>();
  if (!hasPak()) return out;
  let index: i32 = 0;
  while (true) {
    const entry = readdirAt(path, index);
    if (entry == null) break;
    if (entry.isDir) entry.name += "/";
    out.push(entry);
    index += 1;
  }
  return out;
}

/** The child names of a directory, as `resEntries` reports them. */
export function resList(path: string = "/"): string[] {
  const entries = resEntries(path);
  const names = new Array<string>(entries.length);
  for (let i = 0; i < entries.length; i++) names[i] = entries[i].name;
  return names;
}

/**
 * Read a whole file. `null` when the path does not resolve, is a directory, or
 * the payload cannot be read (a compressed payload reports -EIO until the
 * codecs land).
 */
export function resReadFile(path: string): Uint8Array | null {
  const file = ResFile.open(path);
  if (file == null) return null;
  const bytes = file.readAll();
  file.close();
  return bytes;
}

/** Read a whole file as UTF-8 text. `null` when the read fails. */
export function resReadText(path: string): string | null {
  // Reads through an ArrayBuffer and decodes by pointer + length, the same
  // idiom `io.readLine` uses — no typed-array views in the decode path.
  const file = ResFile.open(path);
  if (file == null) return null;
  const size = file.size();
  if (size < 0) {
    file.close();
    return null;
  }
  const buf = new ArrayBuffer(size > 0 ? size : 1);
  const n = file.readRaw(changetype<usize>(buf), size);
  file.close();
  if (n < 0) return null;
  return String.UTF8.decodeUnsafe(changetype<usize>(buf), n);
}

/** An open file inside a pak. Close it when done; `read`/`seek` return -1 after that. */
export class ResFile {
  private fd: i32;

  private constructor(fd: i32) {
    this.fd = fd;
  }

  /**
   * Open a file. Returns `null` when the path does not resolve, is a
   * directory (-EISDIR), or the fd table is full (-EMFILE).
   */
  static open(path: string): ResFile | null {
    const bytes = String.UTF8.encode(path);
    const fd = hostResOpen(changetype<usize>(bytes), i32(bytes.byteLength));
    if (fd < 1) return null;
    return new ResFile(fd);
  }

  /** The underlying host handle (for diagnostics; the guest never needs it). */
  rawFd(): i32 {
    return this.fd;
  }

  /** Whether this handle is still open. */
  isOpen(): bool {
    return this.fd >= 1;
  }

  /** Read into `buf`; returns the byte count, 0 at end of file, -1 on error. */
  read(buf: Uint8Array): i32 {
    if (this.fd < 1) return -1;
    const n = hostResRead(this.fd, buf.dataStart, i32(buf.byteLength));
    return n < 0 ? -1 : n;
  }

  /** Read at most `len` bytes into raw memory; the primitive both readers use. */
  readRaw(ptr: usize, len: i32): i32 {
    if (this.fd < 1) return -1;
    const n = hostResRead(this.fd, ptr, len);
    return n < 0 ? -1 : n;
  }

  /** Read the rest of the file. An empty array when the read fails. */
  readAll(): Uint8Array {
    const size = this.size();
    const out = new Uint8Array(size > 0 ? size : 0);
    if (this.fd < 1) return out;
    const chunk = new ArrayBuffer(4096);
    let written = 0;
    while (written < out.length) {
      const want: i32 = min<i32>(4096, out.length - written);
      const n = hostResRead(this.fd, changetype<usize>(chunk), want);
      if (n <= 0) break;
      const view = Uint8Array.wrap(chunk, 0, n);
      for (let i = 0; i < n; i++) out[written + i] = view[i];
      written += n;
    }
    return written == out.length ? out : out.slice(0, written);
  }

  /** Seek; `whence` is `RES_SEEK_SET` / `RES_SEEK_CUR` / `RES_SEEK_END`. Returns the new position or -1. */
  seek(offset: i32, whence: i32 = RES_SEEK_SET): i32 {
    if (this.fd < 1) return -1;
    const pos = hostResSeek(this.fd, i64(offset), whence);
    return pos < 0 ? -1 : i32(pos);
  }

  /** The current position, or -1 when closed. */
  tell(): i32 {
    if (this.fd < 1) return -1;
    const pos = hostResTell(this.fd);
    return pos < 0 ? -1 : i32(pos);
  }

  /** The file's payload size, or -1 when closed. */
  size(): i32 {
    if (this.fd < 1) return -1;
    const stat = statOfFd(this.fd);
    if (stat == null) return -1;
    return i32(stat.size);
  }

  /** Close the handle. Idempotent: closing twice is not an error. */
  close(): void {
    if (this.fd < 1) return;
    hostResClose(this.fd);
    this.fd = -1;
  }
}
