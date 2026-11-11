// Readers for the three asset files, mirroring the format the build writes.
//
// The offsets here are `apps/docs/tools/lib/format.mjs`'s, field for field. That
// file is the authority and this one is the reader — two implementations of one
// layout, which is the same arrangement the writer and `verify.mjs` already have
// and the reason a layout mistake fails at build time instead of as a garbled
// page.
//
// ## Text is bytes, not Strings
//
// Every string in the bundle is ASCII: `tools/bundle.mjs` refuses to build a
// character the 95-glyph font cannot draw, and `tools/verify.mjs` re-checks the
// whole graph afterwards. So a character is one byte, and this file reads
// characters with `load<u8>` rather than decoding UTF-8.
//
// That is not a micro-optimisation. Decoding a line is an allocation, and a
// frame draws ~30 lines; at 60 Hz that is 1,800 allocations a second whose only
// purpose would be to be thrown away. Reading bytes makes rendering
// allocation-free, which is the property that keeps the frame time flat.

// ── docs.bin ────────────────────────────────────────────────────────────────

export const DOCS_HEADER_BYTES: u32 = 72;
const H_VERSION: u32 = 8;
const H_PAGE_COUNT: u32 = 16;
const H_BLOCK_COUNT: u32 = 20;
const H_RUN_COUNT: u32 = 24;
const H_SECTION_COUNT: u32 = 28;
const H_TOC_COUNT: u32 = 32;
const H_STRINGS_OFFSET: u32 = 40;
const H_PAGES_OFFSET: u32 = 44;
const H_BLOCKS_OFFSET: u32 = 48;
const H_RUNS_OFFSET: u32 = 52;
const H_SECTIONS_OFFSET: u32 = 56;
const H_TOC_OFFSET: u32 = 60;

const PAGE_BYTES: u32 = 28;
const BLOCK_BYTES: u32 = 24;
const RUN_BYTES: u32 = 12;
const SECTION_BYTES: u32 = 20;
const TOC_BYTES: u32 = 16;

// Block fields.
export const B_KIND: u32 = 0;
export const B_FLAGS: u32 = 1;
export const B_LEVEL: u32 = 2;
const B_RUN_FIRST: u32 = 4;
const B_RUN_COUNT: u32 = 8;
const B_PAGE: u32 = 12;
const B_EXTRA: u32 = 20;

// Run fields.
export const R_STYLE: u32 = 0;
const R_TEXT_OFFSET: u32 = 4;
const R_TEXT_LENGTH: u32 = 8;

/** Block kinds — `format.mjs`'s numbers. */
export const K_HEADING: u8 = 1;
export const K_PARAGRAPH: u8 = 2;
export const K_CODE: u8 = 3;
export const K_LIST_ITEM: u8 = 4;
export const K_QUOTE: u8 = 5;
export const K_RULE: u8 = 6;
export const K_TABLE: u8 = 7;

/** Inline run styles. */
export const S_PLAIN: u8 = 0;
export const S_STRONG: u8 = 1;
export const S_EMPHASIS: u8 = 2;
export const S_CODE: u8 = 3;
export const S_LINK: u8 = 4;

/** Block flags. */
export const F_RUNNABLE: u8 = 1;
export const F_GENERATED: u8 = 2;
export const F_SECTION_START: u8 = 4;

/** A `toc` entry that is a group heading rather than a link. */
export const TOC_NO_PAGE: u32 = 0xffffffff;

/**
 * The documentation bundle, open in place.
 *
 * A reference type because it holds the offsets a frame needs on every draw, and
 * re-deriving them from the header 60 times a second would be the kind of waste
 * that shows up as a stutter nobody attributes to the right place.
 */
export class Docs {
  base: usize = 0;
  /**
   * **The buffer, retained.**
   *
   * `base` is a raw pointer into this array's data, and a pointer is not a
   * reference: without this field the only thing keeping the bytes alive was the
   * local variable in `main.start()`, which is gone by the time the frame loop
   * runs. The GC is then free to reuse that memory — and did, once the 2x atlas
   * made 2.3 MiB of texture and changed the allocation pattern: the transcript
   * index read back as garbage, so the Run button reported "no transcript
   * recorded" for a block that had one.
   *
   * Holding the array here makes the pointer's lifetime the reader's, which is
   * what the pointer always assumed.
   */
  bytes: Uint8Array = new Uint8Array(0);
  stringsAt: usize = 0;
  pagesAt: usize = 0;
  blocksAt: usize = 0;
  runsAt: usize = 0;
  sectionsAt: usize = 0;
  tocAt: usize = 0;

  pageCount: u32 = 0;
  blockCount: u32 = 0;
  runCount: u32 = 0;
  sectionCount: u32 = 0;
  tocCount: u32 = 0;

  /**
   * Open a bundle already in guest memory.
   *
   * Returns `null` only for a buffer too short to hold a header; the reader does
   * not verify the magic or the version, because `tools/verify.mjs` does that at
   * build time and a runtime that re-checks its own build output is checking
   * itself. `main.ts` reports "the bundle is not installed" for the case that
   * actually happens: a missing volume.
   */
  static open(bytes: Uint8Array): Docs {
    const docs = new Docs();
    docs.base = bytes.dataStart;
    docs.bytes = bytes;
    if (<u32>bytes.length < DOCS_HEADER_BYTES) return docs;

    const at = docs.base;
    docs.pageCount = load<u32>(at + H_PAGE_COUNT);
    docs.blockCount = load<u32>(at + H_BLOCK_COUNT);
    docs.runCount = load<u32>(at + H_RUN_COUNT);
    docs.sectionCount = load<u32>(at + H_SECTION_COUNT);
    docs.tocCount = load<u32>(at + H_TOC_COUNT);
    docs.stringsAt = at + load<u32>(at + H_STRINGS_OFFSET);
    docs.pagesAt = at + load<u32>(at + H_PAGES_OFFSET);
    docs.blocksAt = at + load<u32>(at + H_BLOCKS_OFFSET);
    docs.runsAt = at + load<u32>(at + H_RUNS_OFFSET);
    docs.sectionsAt = at + load<u32>(at + H_SECTIONS_OFFSET);
    docs.tocAt = at + load<u32>(at + H_TOC_OFFSET);
    return docs;
  }

  get ok(): bool {
    return this.pageCount > 0;
  }

  // --- pages ---------------------------------------------------------------

  pageTitlePtr(i: u32): usize {
    return this.stringsAt + load<u32>(this.pagesAt + i * PAGE_BYTES + 0);
  }

  pageTitleLen(i: u32): u32 {
    return load<u32>(this.pagesAt + i * PAGE_BYTES + 4);
  }

  pageBlockFirst(i: u32): u32 {
    return load<u32>(this.pagesAt + i * PAGE_BYTES + 16);
  }

  pageBlockCount(i: u32): u32 {
    return load<u32>(this.pagesAt + i * PAGE_BYTES + 20);
  }

  // --- blocks --------------------------------------------------------------

  blockKind(i: u32): u8 {
    return load<u8>(this.blocksAt + i * BLOCK_BYTES + B_KIND);
  }

  blockFlags(i: u32): u8 {
    return load<u8>(this.blocksAt + i * BLOCK_BYTES + B_FLAGS);
  }

  blockLevel(i: u32): u8 {
    return load<u8>(this.blocksAt + i * BLOCK_BYTES + B_LEVEL);
  }

  blockRunFirst(i: u32): u32 {
    return load<u32>(this.blocksAt + i * BLOCK_BYTES + B_RUN_FIRST);
  }

  blockRunCount(i: u32): u32 {
    return load<u32>(this.blocksAt + i * BLOCK_BYTES + B_RUN_COUNT);
  }

  blockPage(i: u32): u32 {
    return load<u32>(this.blocksAt + i * BLOCK_BYTES + B_PAGE);
  }

  /** A list's start number (1 for ordered, 0 for a bullet), or a code
   *  block's language string offset. */
  blockExtra(i: u32): u32 {
    return load<u32>(this.blocksAt + i * BLOCK_BYTES + B_EXTRA);
  }

  // --- runs ----------------------------------------------------------------

  runStyle(r: u32): u8 {
    return load<u8>(this.runsAt + r * RUN_BYTES + R_STYLE);
  }

  runTextPtr(r: u32): usize {
    return this.stringsAt + load<u32>(this.runsAt + r * RUN_BYTES + R_TEXT_OFFSET);
  }

  runTextLen(r: u32): u32 {
    return load<u32>(this.runsAt + r * RUN_BYTES + R_TEXT_LENGTH);
  }

  // --- sections ------------------------------------------------------------

  sectionTitlePtr(i: u32): usize {
    return this.stringsAt + load<u32>(this.sectionsAt + i * SECTION_BYTES + 0);
  }

  sectionTitleLen(i: u32): u32 {
    return load<u32>(this.sectionsAt + i * SECTION_BYTES + 4);
  }

  sectionPage(i: u32): u32 {
    return load<u32>(this.sectionsAt + i * SECTION_BYTES + 8);
  }

  sectionBlockFirst(i: u32): u32 {
    return load<u32>(this.sectionsAt + i * SECTION_BYTES + 12);
  }

  // --- table of contents ---------------------------------------------------

  tocTitlePtr(i: u32): usize {
    return this.stringsAt + load<u32>(this.tocAt + i * TOC_BYTES + 0);
  }

  tocTitleLen(i: u32): u32 {
    return load<u32>(this.tocAt + i * TOC_BYTES + 4);
  }

  tocPage(i: u32): u32 {
    return load<u32>(this.tocAt + i * TOC_BYTES + 8);
  }

  tocDepth(i: u32): u32 {
    return load<u32>(this.tocAt + i * TOC_BYTES + 12);
  }

  /** The block a page's content starts at, for a section's scroll target. */
  blockOfSection(section: u32): u32 {
    return this.sectionBlockFirst(section);
  }
}

// ── search.bin ──────────────────────────────────────────────────────────────

const SEARCH_HEADER_BYTES: u32 = 40;
const TERM_BYTES: u32 = 16;
const POSTING_BYTES: u32 = 12;

/**
 * The inverted index.
 *
 * Terms are compared as **bytes**, never as Strings. The dictionary is sorted
 * and the query arrives as ASCII bytes, so a comparison is a byte loop over two
 * spans in guest memory: no allocation, and the same code serves the binary
 * search and the prefix walk.
 */
export class SearchIndex {
  base: usize = 0;
  /**
   * **The buffer, retained.**
   *
   * `base` is a raw pointer into this array's data, and a pointer is not a
   * reference: without this field the only thing keeping the bytes alive was the
   * local variable in `main.start()`, which is gone by the time the frame loop
   * runs. The GC is then free to reuse that memory — and did, once the 2x atlas
   * made 2.3 MiB of texture and changed the allocation pattern: the transcript
   * index read back as garbage, so the Run button reported "no transcript
   * recorded" for a block that had one.
   *
   * Holding the array here makes the pointer's lifetime the reader's, which is
   * what the pointer always assumed.
   */
  bytes: Uint8Array = new Uint8Array(0);
  stringsAt: usize = 0;
  termsAt: usize = 0;
  postingsAt: usize = 0;

  termCount: u32 = 0;
  postingCount: u32 = 0;

  static open(bytes: Uint8Array): SearchIndex {
    const index = new SearchIndex();
    index.base = bytes.dataStart;
    index.bytes = bytes;
    if (<u32>bytes.length < SEARCH_HEADER_BYTES) return index;

    const at = index.base;
    index.termCount = load<u32>(at + 12);
    index.postingCount = load<u32>(at + 16);
    index.stringsAt = at + load<u32>(at + 28);
    index.termsAt = at + load<u32>(at + 32);
    index.postingsAt = at + load<u32>(at + 36);
    return index;
  }

  get ok(): bool {
    return this.termCount > 0;
  }

  termPtr(i: u32): usize {
    return this.stringsAt + load<u32>(this.termsAt + i * TERM_BYTES + 0);
  }

  termLen(i: u32): u32 {
    return load<u32>(this.termsAt + i * TERM_BYTES + 4);
  }

  termPostFirst(i: u32): u32 {
    return load<u32>(this.termsAt + i * TERM_BYTES + 8);
  }

  termPostCount(i: u32): u32 {
    return load<u32>(this.termsAt + i * TERM_BYTES + 12);
  }

  postingSection(p: u32): u32 {
    return load<u32>(this.postingsAt + p * POSTING_BYTES + 0);
  }

  /** Bit 15 is "appeared in a heading"; the low 15 bits are the count. */
  postingWord(p: u32): u16 {
    return load<u16>(this.postingsAt + p * POSTING_BYTES + 4);
  }

  postingFirstBlock(p: u32): u16 {
    return load<u16>(this.postingsAt + p * POSTING_BYTES + 6);
  }
}

/**
 * Compare a term in the dictionary against a query held in guest memory.
 *
 * Returns <0, 0, >0 in the manner of `memcmp`, over `min(len)` bytes and then by
 * length — which is the ordering the dictionary is sorted by, and therefore the
 * only comparison a binary search may use.
 */
export function compareTermToQuery(termPtr: usize, termLen: u32, queryPtr: usize, queryLen: u32): i32 {
  const shared: u32 = termLen < queryLen ? termLen : queryLen;
  for (let i: u32 = 0; i < shared; i++) {
    const a = load<u8>(termPtr + i);
    const b = load<u8>(queryPtr + i);
    if (a != b) return <i32>a - <i32>b;
  }
  return <i32>termLen - <i32>queryLen;
}

/** Whether a term begins with the query. Both are ASCII byte spans. */
export function termHasPrefix(termPtr: usize, termLen: u32, queryPtr: usize, queryLen: u32): bool {
  if (queryLen > termLen) return false;
  for (let i: u32 = 0; i < queryLen; i++) {
    if (load<u8>(termPtr + i) != load<u8>(queryPtr + i)) return false;
  }
  return true;
}

// ── transcripts.bin ─────────────────────────────────────────────────────────

const TRANSCRIPT_HEADER_BYTES: u32 = 24;
const ENTRY_BYTES: u32 = 24;

/**
 * Recorded output, keyed by block index.
 *
 * A linear scan, not a table: there are two entries today and there will be tens.
 * A hash lookup for tens of entries would be more code than it saves, and the
 * scan runs once per frame at most.
 */
export class Transcripts {
  base: usize = 0;
  /**
   * **The buffer, retained.**
   *
   * `base` is a raw pointer into this array's data, and a pointer is not a
   * reference: without this field the only thing keeping the bytes alive was the
   * local variable in `main.start()`, which is gone by the time the frame loop
   * runs. The GC is then free to reuse that memory — and did, once the 2x atlas
   * made 2.3 MiB of texture and changed the allocation pattern: the transcript
   * index read back as garbage, so the Run button reported "no transcript
   * recorded" for a block that had one.
   *
   * Holding the array here makes the pointer's lifetime the reader's, which is
   * what the pointer always assumed.
   */
  bytes: Uint8Array = new Uint8Array(0);
  count: u32 = 0;
  entriesAt: usize = 0;
  stringsAt: usize = 0;

  static open(bytes: Uint8Array): Transcripts {
    const t = new Transcripts();
    t.base = bytes.dataStart;
    t.bytes = bytes;
    if (<u32>bytes.length < TRANSCRIPT_HEADER_BYTES) return t;
    t.count = load<u32>(t.base + 12);
    // **The entry table starts immediately after the header.** Byte 16 holds the
    // *string blob's* offset, not the table's — reading it as the table offset
    // (which this did at first) points the scan into the transcripts themselves,
    // so every `find` answered -1 and the Run button reported "no transcript
    // recorded" for a block that had one. The blob is `[header][entries][strings]`
    // (`tools/run-examples.mjs`), so both offsets are known without either being
    // derived from the other.
    t.entriesAt = t.base + TRANSCRIPT_HEADER_BYTES;
    t.stringsAt = t.base + load<u32>(t.base + 16);
    return t;
  }

  get ok(): bool {
    return this.count > 0;
  }

  /** The entry index for a block, or -1. */
  find(blockIndex: u32): i32 {
    for (let i: u32 = 0; i < this.count; i++) {
      if (load<u32>(this.entriesAt + i * ENTRY_BYTES + 0) == blockIndex) return <i32>i;
    }
    return -1;
  }

  status(entry: u32): u8 {
    return load<u8>(this.entriesAt + entry * ENTRY_BYTES + 4);
  }

  textPtr(entry: u32): usize {
    return this.stringsAt + load<u32>(this.entriesAt + entry * ENTRY_BYTES + 8);
  }

  textLen(entry: u32): u32 {
    return load<u32>(this.entriesAt + entry * ENTRY_BYTES + 12);
  }

  /** How long the program took when the transcript was recorded. */
  durationMs(entry: u32): u32 {
    return load<u32>(this.entriesAt + entry * ENTRY_BYTES + 20);
  }
}

// ── ui.json ─────────────────────────────────────────────────────────────────

/**
 * Read one number out of the atlas manifest.
 *
 * `ui.json` is JSON and TensionScript has no parser, so this is a **narrow
 * extractor, not a parser**: it finds `"key"` after `from` and reads the integer
 * that follows the colon. That is enough for a file this build generates with a
 * fixed shape, and it refuses (returns `fallback`) rather than guessing when the
 * shape is not what it expects.
 *
 * A general JSON parser would be the wrong trade here: it would be ~150 lines of
 * string and escape handling, compiled into every copy of the viewer, to read
 * ten integers out of a file the same build wrote.
 */
export function jsonNumber(text: string, key: string, fallback: i32, from: i32 = 0): i32 {
  const needle = "\"" + key + "\"";
  const at = text.indexOf(needle, from);
  if (at < 0) return fallback;
  let i = at + needle.length;
  // Past `:` and any whitespace.
  while (i < text.length && text.charCodeAt(i) != 58) i++;
  if (i >= text.length) return fallback;
  i++;
  while (i < text.length && text.charCodeAt(i) == 32) i++;

  let sign: i32 = 1;
  if (i < text.length && text.charCodeAt(i) == 45) { sign = -1; i++; }
  let value: i32 = 0;
  let digits: i32 = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) break;
    value = value * 10 + (c - 48);
    digits++;
    i++;
  }
  return digits == 0 ? fallback : sign * value;
}

/** The character index just past `"key":` in `text`, or -1. */
export function jsonObjectStart(text: string, key: string): i32 {
  const needle = "\"" + key + "\"";
  return text.indexOf(needle);
}
