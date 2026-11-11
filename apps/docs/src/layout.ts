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
// ## One cell size, so no per-line size
//
// Every glyph is `CELL_W x CELL_H` — 16x32, because `text.ts` explains that the
// scale lives in the baked atlas and cannot live in the record. A line therefore
// differs from another only by indent, spacing, colour and weight. Headings get
// a wider advance and a rule beneath, which reads as a heading without
// pretending to be a larger font.
//
// **The vertical rhythm is proportional to `LINE_STEP`, not fixed in pixels.**
// The numbers below are written as fractions of a line so that raising `SCALE`
// keeps the page looking the same rather than merely redrawing it bigger —
// a 30px gap that was 1.25 lines at 24px/line is still 1.25 lines at 40px/line.

// The page's own layout: what a *document* looks like, on top of the toolkit's
// line arithmetic. `PageLayout` knows about blocks, runs and code fences; the
// wrapping, the cell geometry and the vertical rhythm come from `tension-ui`,
// which is where they had to go the moment a second app needed them.
import {
  CELL_H, CELL_W, CODE, DEFAULT_THEME, HEADING, LINE_STEP, LINK, MIN_COLS, MUTED, NORMAL,
  SCALE, breakLine, px,
} from "tension-framework";

import {
  Docs, F_RUNNABLE,
  K_CODE, K_HEADING, K_LIST_ITEM, K_PARAGRAPH, K_QUOTE, K_RULE, K_TABLE,
  S_CODE, S_EMPHASIS, S_LINK, S_PLAIN, S_STRONG,
} from "./format";

/**
 * The widest the text column is ever allowed to get, in characters.
 *
 * A cap rather than a computed value, and it exists for two independent reasons:
 *
 *   * **Readability.** Prose wider than about 80 characters is hard to track —
 *     the eye loses the line return. This is the one place the layout is allowed
 *     to waste window width, and on a 2560px display it does.
 *   * **The record budget.** A glyph is one sprite record, so a line's cost is
 *     its column count. 80 columns against a 1080px-tall window is roughly
 *     80 x 24 = 1,920 records of text, which fits the 4096 the renderer stages
 *     per frame with room for the shell and an open transcript panel.
 *
 * The actual column count is per-window (`PageLayout.cols`) and comes from
 * `main.ts`, which is the only side that knows how wide the window is.
 */
export const MAX_COLS: i32 = 80;

/** The code block's left inset, in pixels. `main.ts` draws the accent here. */
export const CODE_INSET: i32 = 16 * SCALE;

/**
 * Space before a block, by kind — what makes a page scannable.
 *
 * Written as fractions of `LINE_STEP` rather than as pixels: the ratios are what
 * the page's rhythm is made of, and they have to survive a change of `SCALE`.
 * The comment beside each number is the pixel value it had at the 1x cell size.
 */
function spaceBefore(kind: u8, level: u8): i32 {
  if (kind == K_HEADING) {
    if (level <= 1) return LINE_STEP * 5 / 4;   // was 30 against LINE_STEP 24
    if (level == 2) return LINE_STEP;           // was 24
    if (level == 3) return LINE_STEP * 3 / 4;   // was 18
    return LINE_STEP * 7 / 12;                  // was 14
  }
  if (kind == K_PARAGRAPH) return LINE_STEP / 2;  // was 12
  if (kind == K_CODE) return LINE_STEP / 2;       // was 12
  if (kind == K_LIST_ITEM) return LINE_STEP / 12; // was 2
  if (kind == K_QUOTE) return LINE_STEP * 5 / 12; // was 10
  if (kind == K_RULE) return LINE_STEP * 7 / 12;  // was 14
  return LINE_STEP / 3;                           // was 8
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
  /**
   * The column this layout was wrapped at, in characters.
   *
   * Stored because the layout is a *cache*: `main.ts` reads it back to size
   * rules and panels to the same width the text was wrapped to, and a stale
   * value there is a rule that stops at the wrong place after a resize.
   */
  cols: i32 = MIN_COLS;
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
  build(docs: Docs, page: u32, cols: i32): void {
    this.page = page;
    this.cols = cols < MIN_COLS ? MIN_COLS : cols;
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
    let y: i32 = 8 * SCALE; // top padding inside the content column

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
      // **The width every line of this block may use, in characters.**
      //
      // `this.cols` is how many *body* cells fit across the pane. A block that
      // is indented gets fewer, and a block whose characters advance further
      // gets fewer again — so the character count is the column's pixel width
      // less the indent, divided by this block's own advance. Wrapping a heading
      // at `this.cols` would let it run past the pane: at the 2x cell a level-1
      // heading advances 22px per character against 18px for prose, so 80 of
      // those is 1760px in a 1440px column. Dividing by the block's advance is
      // what keeps the widest line inside.
      const advance: i32 = advanceFor(kind, level);
      const cols: i32 = (this.cols * CELL_W - indent) / advance;

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
        y += 4 * SCALE;
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

        // **A runnable block's button gets its own row** — a line with no text,
        // reserved here so the button has somewhere to sit that the layout
        // knows about.
        //
        // It used to sit *beside* the block's first line, with the layout
        // reserving a gutter of the column so no code could reach it. At the 2x
        // cell that gutter was 18 of 56 columns — a third of the width, spent on
        // every line of a code sample to make room for one button — and it began
        // breaking tokens mid-word (`"tension-frame` / `work";`). A row of its
        // own gives the code the whole column back.
        //
        // The row is a real line in the flow: it advances `LINE_STEP`, the
        // transcript anchors under it, and the paragraph after the block cannot
        // be drawn on top of it.
        if ((flags & F_RUNNABLE) != 0) {
          this.lineStart.push(start);
          this.lineLen.push(0);
          this.lineY.push(y);
          this.lineBlock.push(blockSlot);
          lines++;
          y += LINE_STEP;
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
      const codePad: i32 = kind == K_CODE ? 6 * SCALE : 0;
      this.blockH.push(y - this.blockY[blockSlot] + codePad);
      if (kind == K_CODE) y += codePad;
    }

    this.height = y + 12 * SCALE; // bottom padding
  }

  /** The scroll offset that puts a block at the top of the pane. */
  scrollForBlock(block: i32): i32 {
    for (let i: i32 = 0; i < this.blockIndex.length; i++) {
      if (this.blockIndex[i] == block) return this.blockY[i] - 8 * SCALE;
    }
    return 0;
  }

  /**
   * Where a block's transcript panel hangs, in page space.
   *
   * The same expression the draw uses for its anchor (`lineY + LINE_STEP + 10`
   * on the block's last line), in page coordinates so a caller can decide how far
   * to scroll before the frame that draws it. `-1` when the block is not on this
   * page.
   */
  anchorForBlock(block: i32): i32 {
    for (let i: i32 = 0; i < this.blockIndex.length; i++) {
      if (this.blockIndex[i] == block) {
        const last: i32 = this.blockFirstLine[i] + this.blockLineCount[i] - 1;
        if (last >= 0 && last < this.lineY.length) return this.lineY[last] + LINE_STEP + 5 * SCALE;
        return -1;
      }
    }
    return -1;
  }

  /** The first line at or below `y` — a linear scan, bounded by ~40 lines. */
  firstLineAt(y: i32): i32 {
    for (let i: i32 = 0; i < this.lineStart.length; i++) {
      if (this.lineY[i] + LINE_STEP > y) return i;
    }
    return this.lineStart.length;
  }
}

/** Left indent in pixels, by block kind. Two cells' worth, so indented blocks
 *  read as inset at any `SCALE`. */
function indentFor(kind: u8, level: u8): i32 {
  if (kind == K_CODE) return CODE_INSET;
  if (kind == K_LIST_ITEM) return CODE_INSET;
  if (kind == K_QUOTE) return CODE_INSET;
  return 0;
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

/** The per-character advance: headings get air, everything else is one cell. */
export function advanceFor(kind: u8, level: u8): i32 {
  if (kind != K_HEADING) return CELL_W;
  // Letter-spacing, in source pixels, scaled with everything else.
  if (level <= 1) return CELL_W + 3 * SCALE;
  if (level == 2) return CELL_W + 1 * SCALE;
  return CELL_W;
}

// The atlas colour indices, straight from the theme: `layout.ts` used to keep
// its own copies so it did not have to import the painter, and a copy is how a
// palette drifts.
const NORMAL_COLOUR: i32 = NORMAL;
const MUTED_COLOUR: i32 = MUTED;
const LINK_COLOUR: i32 = LINK;
const CODE_COLOUR: i32 = CODE;
const HEADING_COLOUR: i32 = HEADING;
