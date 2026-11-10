// The `docs.bin` wire format, in one place.
//
// The guest that reads this has no JSON parser and no allocator worth spending
// on a DOM, so the format is flat, little-endian, 4-byte aligned throughout, and
// every text reference is `(offset, length)` into one shared string blob. A
// reader does typed loads at fixed offsets and never walks a tree of objects.
//
// **Why the layout is duplicated here rather than generated.** The same reason
// `packages/cli/schema` is hand-written next to its validator: the writer is a
// Node build tool and the reader is TensionScript, and no generator spans the
// two. What keeps them honest is `tools/verify.mjs`, which reads this file with
// the same offsets the guest will use, and `tools/test-format.mjs`, which
// refuses a layout the constants below no longer describe.
//
// Alignment rule: every section starts on a 4-byte boundary, and every record is
// a multiple of 4 bytes. The guest reads a u32 at a multiple of 4, which wasm
// requires; a section that began at an odd offset would fault rather than
// misread, so the writer pads and the reader does not have to know.

/** Magic, and the version a reader must refuse. Both live in the header. */
export const MAGIC = 'TNDOC1\u0000\u0000';
export const VERSION = 1;

/** The fixed header, before any section. */
export const HEADER_BYTES = 72;

/** Header field offsets. A reader names these; it never adds. */
export const H = {
  magic: 0,
  version: 8,
  flags: 12,
  pageCount: 16,
  blockCount: 20,
  runCount: 24,
  sectionCount: 28,
  tocCount: 32,
  stringBytes: 36,
  stringsOffset: 40,
  pagesOffset: 44,
  blocksOffset: 48,
  runsOffset: 52,
  sectionsOffset: 56,
  tocOffset: 60,
  sourceSha: 64,
  reserved: 68,
};

/**
 * Records. Each size is a multiple of 4, so a section of them stays aligned
 * however many precede it.
 */
export const PAGE_BYTES = 28;
export const P = {
  titleOffset: 0,
  titleLength: 4,
  pathOffset: 8,
  pathLength: 12,
  blockFirst: 16,
  blockCount: 20,
  flags: 24,
};

export const BLOCK_BYTES = 24;
export const B = {
  kind: 0,
  flags: 1,
  level: 2,
  reserved: 3,
  runFirst: 4,
  runCount: 8,
  page: 12,
  line: 16,
  extra: 20,
};

export const RUN_BYTES = 12;
export const R = {
  style: 0,
  /** Three reserved bytes, so `textOffset` lands on a 4-byte boundary. */
  textOffset: 4,
  textLength: 8,
};

export const SECTION_BYTES = 20;
export const S = {
  titleOffset: 0,
  titleLength: 4,
  page: 8,
  blockFirst: 12,
  blockCount: 16,
};

export const TOC_BYTES = 16;
export const T = {
  titleOffset: 0,
  titleLength: 4,
  page: 8,
  depth: 12,
};

/** A `toc` entry with no page: a group heading, not a link. */
export const TOC_NO_PAGE = 0xffffffff;

/** Block kinds. The viewer switches on these; the numbers are the ABI. */
export const KIND = {
  heading: 1,
  paragraph: 2,
  code: 3,
  listItem: 4,
  quote: 5,
  rule: 6,
  table: 7,
};

/** Inline run styles. */
export const STYLE = {
  plain: 0,
  strong: 1,
  emphasis: 2,
  code: 3,
  link: 4,
};

/** Block flags. */
export const BLOCK_FLAG = {
  /** A code block the reader may "run" (its transcript is recorded). */
  runnable: 1 << 0,
  /** Produced from generated sources (the TSDoc reference), not hand-written. */
  generated: 1 << 1,
  /** A heading that opens a new section. */
  sectionStart: 1 << 2,
};

/** Page flags. */
export const PAGE_FLAG = {
  generated: 1 << 0,
};

/**
 * The string interner.
 *
 * Deduplication matters more than it looks: a table of contents repeats every
 * title that also appears as a heading, and the search index repeats every term
 * it has seen. Interning once keeps `docs.bin` from carrying the same sentence
 * in three sections.
 *
 * Ordering is insertion order, which makes the output stable across runs for a
 * given input — a rebuild with no content change produces identical bytes.
 */
export class Strings {
  constructor() {
    this.chunks = [];
    this.byText = new Map();
    this.bytes = 0;
  }

  /**
   * Intern `text` and return `{offset, length}`.
   *
   * `\u0000` is refused rather than escaped: a NUL inside a string would make
   * every length-prefixed reader downstream wrong, and no document has one.
   */
  add(text) {
    if (text.includes('\u0000')) {
      throw new Error('docs.bin: a string may not contain U+0000');
    }
    const existing = this.byText.get(text);
    if (existing) return existing;

    const buf = Buffer.from(text, 'utf8');
    const entry = { offset: this.bytes, length: buf.length };
    this.byText.set(text, entry);
    this.chunks.push(buf);
    this.bytes += buf.length;
    return entry;
  }

  /** The blob, padded so the next section starts 4-byte aligned. */
  toBuffer() {
    const raw = Buffer.concat(this.chunks);
    const pad = (4 - (raw.length % 4)) % 4;
    return pad ? Buffer.concat([raw, Buffer.alloc(pad)]) : raw;
  }

  /** The padded byte length, which is what the header records. */
  get paddedBytes() {
    return this.bytes + ((4 - (this.bytes % 4)) % 4);
  }
}

/** Read a `{offset, length}` pair back out of a blob. Used by the verifier. */
export function readString(blob, offset, length) {
  return blob.subarray(offset, offset + length).toString('utf8');
}

/**
 * Little-endian writers over a list of slice buffers.
 *
 * A growable buffer per section is simpler with a plain array of small
 * allocations than with a precomputed size, and these files are a megabyte at
 * most — but it is worth writing in one idiom so the offsets cannot disagree
 * with the field sizes above.
 */
export class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  u8(value) {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(value & 0xff, 0);
    this._push(b);
    return this;
  }

  u16(value) {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(value & 0xffff, 0);
    this._push(b);
    return this;
  }

  u32(value) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(value >>> 0, 0);
    this._push(b);
    return this;
  }

  raw(buf) {
    this._push(buf);
    return this;
  }

  zero(count) {
    if (count > 0) this._push(Buffer.alloc(count));
    return this;
  }

  /** Pad to a 4-byte boundary. Returns how many bytes were added. */
  align() {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) this.zero(pad);
    return pad;
  }

  _push(buf) {
    this.parts.push(buf);
    this.length += buf.length;
    return buf.length;
  }

  toBuffer() {
    return Buffer.concat(this.parts, this.length);
  }
}
