// Block layout: turns a page's runs into positioned lines, once.
//
// ## Why this is cached
//
// A page can be scrolled, and every scroll offset redraws. Re-wrapping a page's
// prose per frame would be ~15,000 character comparisons at 60 Hz for a layout
// that cannot have changed — the text, the column width and the font are all
// constant while a page is open. So the work is done once, in `build()`, when the
// page is loaded, and the render loop reads arrays.
//
// The cache key is the page index. One page is resident; moving to another
// rebuilds. That is the whole policy, and it is enough because a reader looks at
// one page at a time.
//
// ## The shape
//
// A page's text is flattened into two parallel byte arrays — one character per
// entry, and the style that character is drawn in — and blocks reference ranges
// in them. Lines then reference ranges in the characters. Nothing is a String,
// so nothing allocates per frame, and the renderer is a walk over `lineStart`,
// `lineLen` and `lineY`.
//
//     chars   "The runtime takes a .wasm"
//     styles  000000011111111110000000000   (S_CODE for the code span)
//     line 0  start=0 len=27 y=40
//
// ## No scaling, so no per-line size
//
// Every glyph is 8x16 (`text.ts` explains why the record cannot scale one). A
// line therefore differs from another only by indent, spacing, colour and
// weight. Headings get a wider advance and a rule beneath, which reads as a
// heading without pretending to be a larger font.

import { CELL_H, CELL_W, columnsFor } from "./text";
import {
  Docs, F_RUNNABLE,
  K_CODE, K_HEADING, K_LIST_ITEM, K_PARAGRAPH, K_QUOTE, K_RULE, K_TABLE,
  S_CODE, S_EMPHASIS, S_LINK, S_PLAIN, S_STRONG,
} from "./format";

/** Vertical rhythm, in pixels. One line of body text is `LINE_STEP`. */
export const LINE_STEP: i32 = 24;
/** The content column, in characters. 80 columns at 8px is 640px — the classic
 *  measure, and exactly what the 1019px main pane affords beside its margin. */
export const CONTENT_COLS: i32 = 80;

/** The code block's left inset, in pixels. `main.ts` draws the accent here. */
export const CODE_INSET: i32 = 16;

/**
 * The gutter a runnable block reserves for its button, in characters.
 *
 * The "Run (recorded)" button sits to the right of a runnable block's first
 * line. Reserving its width here — rather than hoping no code line is long
 * enough — is what makes "the code never runs under the button" a property of
 * the layout instead of a property of today's examples. 20 columns is 160px,
 * which is the button plus a margin.
 */
export const RUN_GUTTER_COLS: i32 = 20;

/** Space before a block, by kind — what makes a page scannable. */
function spaceBefore(kind: u8, level: u8): i32 {
  if (kind == K_HEADING) {
    if (level <= 1) return 30;
    if (level == 2) return 24;
    if (level == 3) return 18;
    return 14;
  }
  if (kind == K_PARAGRAPH) return 12;
  if (kind == K_CODE) return 12;
  if (kind == K_LIST_ITEM) return 2;
  if (kind == K_QUOTE) return 10;
  if (kind == K_RULE) return 14;
  return 8;
}

/**
 * One page, laid out.
 *
 * Arrays rather than an array of records: every field is read in the render loop
 * and a struct-per-line would make each access a load plus arithmetic, where a
 * flat i32 array is one load.
 */
export class PageLayout {
  /** The page this layout describes; -1 when empty. */
  page: i32 = -1;
  /** Total laid-out height, for clamping the scroll. */
  height: i32 = 0;

  /** Every character on the page, flattened across runs. */
  chars: Uint8Array = new Uint8Array(0);
  /** The style of each character, parallel to `chars`. */
  styles: Uint8Array = new Uint8Array(0);

  // --- lines ---------------------------------------------------------------
  lineStart: i32[] = [];
  lineLen: i32[] = [];
  lineY: i32[] = [];
  /** The block a line belongs to, so the renderer can ask for its kind. */
  lineBlock: i32[] = [];

  // --- blocks --------------------------------------------------------------
  /** Global block index (into `Docs`), in page order. */
  blockIndex: i32[] = [];
  blockKind: u8[] = [];
  blockLevel: u8[] = [];
  blockFlags: u8[] = [];
  blockY: i32[] = [];
  blockH: i32[] = [];
  blockFirstLine: i32[] = [];
  blockLineCount: i32[] = [];
  /** A code block's language string (a bundle offset), or 0. */
  blockExtra: i32[] = [];

  get lineCount(): i32 { return this.lineStart.length; }
  get blockCount(): i32 { return this.blockIndex.length; }

  /**
   * Lay out `page`.
   *
   * Two passes over the page's runs: the first counts characters so the buffers
   * are allocated once at their final size, the second fills them. A growable
   * array would double the allocations for the same result.
   */
  build(docs: Docs, page: u32): void {
    this.page = page;
    this.lineStart = [];
    this.lineLen = [];
    this.lineY = [];
    this.lineBlock = [];
    this.blockIndex = [];
    this.blockKind = [];
    this.blockLevel = [];
    this.blockFlags = [];
    this.blockY = [];
    this.blockH = [];
    this.blockFirstLine = [];
    this.blockLineCount = [];
    this.blockExtra = [];

    const first: u32 = docs.pageBlockFirst(page);
    const count: u32 = docs.pageBlockCount(page);

    // ── pass 1: size the character buffer ──────────────────────────────────
    let total: i32 = 0;
    for (let b: u32 = 0; b < count; b++) {
      const bi: u32 = first + b;
      const rf: u32 = docs.blockRunFirst(bi);
      const rc: u32 = docs.blockRunCount(bi);
      for (let r: u32 = 0; r < rc; r++) total += <i32>docs.runTextLen(rf + r);
    }
    this.chars = new Uint8Array(total);
    this.styles = new Uint8Array(total);

    // ── pass 2: fill, then wrap ────────────────────────────────────────────
    let at: i32 = 0;
    let y: i32 = 16; // top padding inside the content column

    for (let b: u32 = 0; b < count; b++) {
      const bi: u32 = first + b;
      const kind: u8 = docs.blockKind(bi);
      const level: u8 = docs.blockLevel(bi);
      const flags: u8 = docs.blockFlags(bi);

      // Copy the block's runs into the flat arrays.
      const start: i32 = at;
      const rf: u32 = docs.blockRunFirst(bi);
      const rc: u32 = docs.blockRunCount(bi);
      for (let r: u32 = 0; r < rc; r++) {
        const len: i32 = <i32>docs.runTextLen(rf + r);
        const ptr: usize = docs.runTextPtr(rf + r);
        const style: u8 = docs.runStyle(rf + r);
        for (let i: i32 = 0; i < len; i++) {
          let c: u8 = load<u8>(ptr + <usize>i);
          // **A soft line break in the Markdown is a space in the flow.**
          // The source wraps its paragraphs at ~80 columns, so a run's text
          // carries the newlines the author typed. They are not breaks in the
          // rendered page — the pane re-wraps — and passing one through would
          // make `Painter.text` start a new line mid-paragraph, which reads as
          // an orphaned word 20 pixels low. Code keeps its newlines: there they
          // are the listing's own structure.
          if (kind != K_CODE && (c == 10 || c == 13 || c == 9)) c = 32;
          this.chars[at] = c;
          this.styles[at] = style;
          at++;
        }
      }
      const len: i32 = at - start;

      const indent: i32 = indentFor(kind, level);
      // **The width every line of this block may use.**
      //
      // Prose gets the whole column less its indent. Code gets the whole column
      // less the inset — and, when the block is runnable, less the button's
      // gutter too, so a long listing is wrapped before it can reach the
      // button sitting beside its first line.
      let cols: i32 = CONTENT_COLS - indent / CELL_W;
      if (kind == K_CODE && (flags & F_RUNNABLE) != 0) {
        cols -= RUN_GUTTER_COLS;
      }

      y += spaceBefore(kind, level);

      const blockSlot: i32 = this.blockIndex.length;
      this.blockIndex.push(<i32>bi);
      this.blockKind.push(kind);
      this.blockLevel.push(level);
      this.blockFlags.push(flags);
      this.blockY.push(y);
      this.blockExtra.push(<i32>docs.blockExtra(bi));
      this.blockFirstLine.push(this.lineStart.length);

      let lines: i32 = 0;

      if (kind == K_RULE) {
        // A rule is a line of the layout with no text: the renderer draws a
        // 1px bar where a line would be.
        lines = 1;
        this.lineStart.push(start);
        this.lineLen.push(0);
        this.lineY.push(y);
        this.lineBlock.push(blockSlot);
        y += 8;
      } else if (kind == K_CODE) {
        // Code keeps its own line breaks and does not re-wrap at word
        // boundaries — a wrapped shell command is a broken shell command. A
        // line past the column is hard-wrapped at the column, which is the one
        // place a long line is truncated rather than reflowed.
        let s: i32 = start;
        const end: i32 = start + len;
        // Leading blank lines in a fence are noise in a box this small.
        while (s < end && this.chars[s] == 10) s++;
        let e: i32 = end;
        while (e > s && this.chars[e - 1] == 10) e--;

        if (s >= e) {
          this.lineStart.push(start);
          this.lineLen.push(0);
          this.lineY.push(y);
          this.lineBlock.push(blockSlot);
          lines = 1;
          y += LINE_STEP;
        }
        while (s < e) {
          let nl: i32 = s;
          while (nl < e && this.chars[nl] != 10) nl++;
          let span: i32 = nl - s;
          let cursor: i32 = s;
          while (span > 0) {
            const take: i32 = span > cols ? cols : span;
            this.lineStart.push(cursor);
            this.lineLen.push(take);
            this.lineY.push(y);
            this.lineBlock.push(blockSlot);
            lines++;
            y += LINE_STEP;
            cursor += take;
            span -= take;
          }
          s = nl + 1;
        }
      } else {
        // Prose: wrap at word boundaries.
        let s: i32 = start;
        const end: i32 = start + len;
        while (s < end) {
          const take: i32 = breakLine(this.chars, s, end, cols);
          if (take <= 0) break;
          this.lineStart.push(s);
          this.lineLen.push(take);
          this.lineY.push(y);
          this.lineBlock.push(blockSlot);
          lines++;
          y += LINE_STEP;
          s += take;
          // Skip the space the break consumed, so the next line does not start
          // with one.
          while (s < end && this.chars[s] == 32) s++;
        }
        if (lines == 0) {
          // An empty paragraph still occupies a line in the flow.
          this.lineStart.push(start);
          this.lineLen.push(0);
          this.lineY.push(y);
          this.lineBlock.push(blockSlot);
          lines = 1;
          y += LINE_STEP;
        }
      }

      this.blockLineCount.push(lines);
      // A code block is drawn inset in its own darker box, so it needs padding
      // at the bottom that plain prose does not.
      this.blockH.push(y - this.blockY[blockSlot] + (kind == K_CODE ? 12 : 0));
      if (kind == K_CODE) y += 12;
    }

    this.height = y + 24; // bottom padding
  }

  /** The scroll offset that puts a block at the top of the pane. */
  scrollForBlock(block: i32): i32 {
    for (let i: i32 = 0; i < this.blockIndex.length; i++) {
      if (this.blockIndex[i] == block) return this.blockY[i] - 16;
    }
    return 0;
  }

  /** The first line at or below `y` — a linear scan, bounded by ~40 lines. */
  firstLineAt(y: i32): i32 {
    for (let i: i32 = 0; i < this.lineStart.length; i++) {
      if (this.lineY[i] + LINE_STEP > y) return i;
    }
    return this.lineStart.length;
  }
}

/** Left indent in pixels, by block kind and heading level. */
function indentFor(kind: u8, level: u8): i32 {
  if (kind == K_CODE) return 16;
  if (kind == K_LIST_ITEM) return 16;
  if (kind == K_QUOTE) return 16;
  return 0;
}

/**
 * How many characters to put on this line.
 *
 * The rule is one comparison, and it is worth stating exactly, because the
 * obvious alternatives are both wrong:
 *
 *   * **The candidate line is `chars[start .. limit)`, where `limit = start +
 *     cols`.** So a line may hold exactly `cols` characters; index `limit` is
 *     the first one that does not fit.
 *   * **Breaking at a space returns `i - start`, which excludes the space.**
 *     The caller then skips the spaces it lands on, so a break never leaves a
 *     leading space on the next line and never counts the space twice.
 *   * **A space at `limit` itself is a valid break.** It yields `cols`, the
 *     widest line that fits, and the space moves to the next line to be
 *     skipped. Rejecting it — scanning from `limit - 1` — would shorten every
 *     line by up to one word for no reason.
 *
 * A word longer than the column is broken mid-word rather than allowed to
 * spill: spilling would paint over the sidebar or the pane's edge, and a long
 * token in a docs page is normal (`tension_adapter.h`, a URL).
 */
function breakLine(chars: Uint8Array, start: i32, end: i32, cols: i32): i32 {
  const limit: i32 = start + cols;
  if (limit >= end) {
    // Trim a trailing space so a single-line paragraph does not carry one.
    let n: i32 = end - start;
    while (n > 0 && chars[start + n - 1] == 32) n--;
    return n;
  }
  for (let i: i32 = limit; i > start; i--) {
    if (chars[i] == 32) return i - start;
  }
  return cols;
}

/**
 * Resolve a style and block kind to the atlas colour and weight.
 *
 * One function, so a paragraph's `strong` span and a code block's prose agree
 * about what "strong" means. Headings ignore inline styles entirely: a bold
 * word inside an H2 would be a distinction the reader cannot make.
 */
export function colourFor(kind: u8, level: u8, style: u8): i32 {
  if (kind == K_HEADING) return HEADING_COLOUR;
  if (kind == K_CODE) return CODE_COLOUR;
  if (kind == K_QUOTE) return MUTED_COLOUR;
  if (style == S_CODE) return CODE_COLOUR;
  if (style == S_LINK) return LINK_COLOUR;
  if (style == S_EMPHASIS) return MUTED_COLOUR;
  return NORMAL_COLOUR;
}

/**
 * The weight for a style and block kind.
 *
 * `strong`, a heading, and a list item's leading bullet are the only bold text.
 * The bold weight is baked into the atlas as a separate stripe, so it costs the
 * same one record as regular text.
 */
export function weightFor(kind: u8, style: u8): i32 {
  if (kind == K_HEADING) return 1;
  if (style == S_STRONG) return 1;
  return 0;
}

/** The per-character advance: headings get air, everything else is 8px. */
export function advanceFor(kind: u8, level: u8): i32 {
  if (kind != K_HEADING) return CELL_W;
  if (level <= 1) return CELL_W + 3;
  if (level == 2) return CELL_W + 1;
  return CELL_W;
}

// The atlas colour indices, named here so `layout.ts` does not import `text.ts`
// for four constants.
const NORMAL_COLOUR: i32 = 0;
const MUTED_COLOUR: i32 = 1;
const LINK_COLOUR: i32 = 2;
const CODE_COLOUR: i32 = 3;
const HEADING_COLOUR: i32 = 4;
