// The bytes an animation runtime archive is made of, read one field at a time.
// Compatible with ozz-animation's runtime archive format (MIT,
// github.com/guillaumeblanc/ozz-animation). That names the format, not this code.

//
// An animation archive is a flat little-endian byte stream and nothing else: a leading
// endianness byte, a NUL-terminated tag that names the type, a `u32` version,
// then the object's fields in the order its `Save` writes them. There is no
// size field, no chunking, and no self-description beyond the tag — so a parser
// is a sequence of reads, and the only way to know it is right is that it ends
// exactly at the last byte (`bytesConsumed == file length`, which the tests
// assert on every fixture).
//
// Two deliberate properties:
//
//   * **Little-endian only.** The format allows the writer to pick, and wasm32
//     is little-endian, so a big-endian archive is refused rather than
//     byte-swapped. The format's own packer takes `--endian=little`, and refusing is
//     the honest failure: a big-endian skeleton parses as a plausible-looking
//     skeleton with a joint count in the hundreds of millions.
//   * **No throws.** A parse that goes wrong sets `error` once and leaves the
//     rest of the reads as no-ops, so a caller can inspect the failure instead
//     of trapping. AS with `--runtime stub` has no exception unwinding worth
//     relying on, and a guest parsing a resource it was handed should not die
//     on a truncated file.
//
// Reads go through `load<T>` on the array's data pointer rather than through
// bounds-checked indexing: the `need()` in front of every read is the bounds
// check, and it is the one that can report a byte offset in its message.

/// The reader's data pointer, recomputed per read. `StaticArray<u8>`'s data
/// begins at the object, which is what `changetype<usize>` gives.
export class Reader {
  readonly bytes: StaticArray<u8>;
  /** The archive's length in bytes; reads never cross it. */
  readonly length: i32;
  /** The next byte to read. After a successful parse this is the file's length. */
  offset: i32 = 0;
  /** `""` while the parse is well; the first failure's message otherwise. */
  error: string = "";
  /** Where the failure was noticed, or -1. */
  errorAt: i32 = -1;

  constructor(bytes: StaticArray<u8>) {
    this.bytes = bytes;
    this.length = bytes.length;
  }

  /** Whether nothing has failed yet. */
  get ok(): bool {
    return this.error.length == 0;
  }

  /** Bytes left between `offset` and the end. */
  get remaining(): i32 {
    return this.length - this.offset;
  }

  /** Records the first failure; later ones do not overwrite it. */
  fail(why: string): void {
    if (this.error.length == 0) {
      this.error = why;
      this.errorAt = this.offset;
    }
  }

  /** Whether `count` more bytes can be read. Records the failure when not. */
  need(count: i32): bool {
    if (count < 0 || this.offset + count > this.length) {
      this.fail(
        "read of " + count.toString() + " byte(s) at offset " + this.offset.toString() +
          " runs past the archive's " + this.length.toString() + " bytes",
      );
      return false;
    }
    return true;
  }

  u8(): u8 {
    if (!this.need(1)) return 0;
    const value = load<u8>(changetype<usize>(this.bytes) + this.offset);
    this.offset += 1;
    return value;
  }

  u16(): u16 {
    if (!this.need(2)) return 0;
    const value = load<u16>(changetype<usize>(this.bytes) + this.offset);
    this.offset += 2;
    return value;
  }

  i16(): i16 {
    if (!this.need(2)) return 0;
    const value = load<i16>(changetype<usize>(this.bytes) + this.offset);
    this.offset += 2;
    return value;
  }

  u32(): u32 {
    if (!this.need(4)) return 0;
    const value = load<u32>(changetype<usize>(this.bytes) + this.offset);
    this.offset += 4;
    return value;
  }

  i32(): i32 {
    if (!this.need(4)) return 0;
    const value = load<i32>(changetype<usize>(this.bytes) + this.offset);
    this.offset += 4;
    return value;
  }

  f32(): f32 {
    if (!this.need(4)) return 0;
    const value = load<f32>(changetype<usize>(this.bytes) + this.offset);
    this.offset += 4;
    return value;
  }

  /** Steps over `count` bytes without reading them. The GV4 iframe cache is
   * skipped this way: it is a seek accelerator, and nothing in it is needed to
   * parse the keys or to find which key belongs to which track. */
  skip(count: i32): void {
    if (this.need(count)) this.offset += count;
  }

  /**
   * The archive's first byte. the reference implementation's `Endianness` is `{ kBigEndian,
   * kLittleEndian }`, so this is `1` for every archive the packer writes with
   * `--endian=little` or on a little-endian host.
   */
  readEndianness(): bool {
    const first = this.u8();
    if (!this.ok) return false;
    if (first != 1) {
      this.fail(
        "the archive's endianness byte is " + first.toString() +
          ", not 1: this parser reads little-endian archives only (pack with --endian=little)",
      );
      return false;
    }
    return true;
  }

  /** The NUL-terminated tag: `ozz-skeleton` or `ozz-animation`. Compared as
   * text, so a mismatched type is named in the message rather than decoded. */
  readTag(expected: string): bool {
    const start = this.offset;
    while (this.offset < this.length &&
           load<u8>(changetype<usize>(this.bytes) + this.offset) != 0) {
      this.offset += 1;
    }
    if (this.offset >= this.length) {
      this.fail("the archive tag is not NUL-terminated");
      return false;
    }
    const found = String.UTF8.decodeUnsafe(
      changetype<usize>(this.bytes) + start,
      <usize>(this.offset - start),
      false,
    );
    this.offset += 1; // the NUL
    if (found != expected) {
      this.fail("this archive's tag is \"" + found + "\", not \"" + expected + "\"");
      return false;
    }
    return true;
  }

  /** The type's version. Each version is a different byte layout — the reference
   * loader accepts exactly one per type (`if (_version != 7)`) — so anything
   * else is refused before a field is read under the wrong interpretation. */
  readVersion(expected: u32): bool {
    const found = this.u32();
    if (!this.ok) return false;
    if (found != expected) {
      this.fail(
        "version " + found.toString() + " is not supported: this parser reads version " +
          expected.toString() + " (the reference loader refuses it too)",
      );
      return false;
    }
    return true;
  }
}
