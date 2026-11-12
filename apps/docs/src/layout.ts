// Block layout: turns a page's runs into positioned lines, once.
//
// ## Why this is cached
//
// A page can be scrolled, and every scroll offset redraws. Re-wrapping a page's
// prose per frame would be tens of thousands of advance-table lookups at 60 Hz
// for a layout that cannot have changed — the text, the column width and the fonts
// are all constant while a page is open. So the work is done once, in `build()`,
// when the page is loaded or the pane changes width, and the render loop reads
// arrays.
//
// The cache key is `(page, wrapPx)`. One page is resident; moving to another
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
//     line 0  start=0 len=27 x=40 w=213
//
// ## Wrapping is measured now, not counted
//
// The VGA pass wrapped at a *column count*: every glyph was one cell, so "does
// this line fit" was a comparison of integers and a break was a scan back to a
// space. A proportional face has no column. Inter 14's `i` advances 3.5 px and its
// `W` 10.75, so a line of 80 characters can be anywhere from 280 to 860 pixels
// wide — a column count that keeps the wide line inside the pane wastes half of
// it, and one that fills the pane lets the wide line run over the divider.
//
// So a line is accumulated in **quarter-pixels** from the page's own advance
// table (`FontPage.advanceQ`, the same table the painter reads), and a break is
// where the *pixels* stop fitting. Inline styles pick their own page: a code span
// inside a paragraph is measured in JetBrains Mono's advances and drawn in it, and
// the two agree because both are the same table.
//
// ## Blocks carry their own type size
//
// A heading is Inter 18 and the body is Inter 14, so a line's pitch is a property
// of its *block* (`blockStep`), not a global constant. That is what lets an H1 sit
// 27 px apart from itself while the paragraph below it advances 21 — the old
// single `LINE_STEP` could only make the heading's size a wider advance, which is
// letter-spacing pretending to be a font.

import {
  CODE, fontBook, FontBook, FontPage, FONT_INTER, FONT_MONO, HEADING, LINK, MUTED, NORMAL,
  SIZE_14, SIZE_18,
} from "tension-framework";

import {
  Docs, F_RUNNABLE,
  K_CODE, K_HEADING, K_LIST_ITEM, K_PARAGRAPH, K_QUOTE, K_RULE, K_TABLE,
  S_CODE, S_EMPHASIS, S_LINK, S_PLAIN, S_STRONG,
} from "./format";

/**
 * The widest the text column is ever allowed to get, in pixels.
 *
 * A cap rather than a computed value, and it exists for two independent reasons:
 *
 *   * **Readability.** Prose wider than about 90 characters is hard to track —
 *     the eye loses the line return. At Inter 14 that is roughly this many pixels,
 *     and it is the one place the layout is allowed to waste window width.
 *   * **The record budget.** A glyph is one sprite record, so a line's cost is its
 *     character count. 720 px of Inter 14 is ~95 characters against a 21 px pitch,
 *     so a 900 px-tall pane holds ~43 lines ≈ 4,000 glyphs — the whole of the
 *     renderer's budget. The column is capped so that a page of *prose* costs a
 *     fraction of it; `main.ts` reports the real count in the status bar.
 *
 * What is left over is split evenly, so the column is centred: a text block pinned
 * to the left of a 2560 px window reads as a bug.
 */
export const MAX_MEASURE_PX: i32 = 720;

/** The narrowest column a layout will wrap to, so a narrow pane still wraps. */
export const MIN_MEASURE_PX: i32 = 200;

/** The code block's left inset, in pixels. `main.ts` draws the accent here. */
export const CODE_INSET: i32 = 16;

/** The height of a horizontal rule's own row. */
export const RULE_ROW_H: i32 = 9;

/** Air above the first block, and below the last one. */
const TOP_PAD: i32 = 4;
const BOTTOM_PAD: i32 = 12;

/**
 * The page a block's text is set in.
 *
 * Headings are the larger size, and code — a code *block* or an inline span — is
 * the mono face at the body size. Everything else is body Inter.
 */
export function pageFor(kind: u8, style: u8): FontPage {
  const book: FontBook = fontBook();
  if (kind == K_HEADING) return book.page(FONT_INTER, SIZE_18);
  if (kind == K_CODE || style == S_CODE) return book.page(FONT_MONO, SIZE_14);
  return book.page(FONT_INTER, SIZE_14);
}

/**
 * The weight a style is set in.
 *
 * `strong` and headings are the only bold text, and the atlas bakes bold **only
 * for the heading stripe** (six pairs, not ten). So a strong span is drawn in the
 * heading colour as well — white bold against `#D6D6D6` body — which is the one
 * emphasis this atlas can carry. `colourFor` is where that pairing is decided, and
 * the two functions must agree or the glyph is skipped for a missing stripe.
 */
export function weightFor(kind: u8, style: u8): i32 {
  if (kind == K_HEADING) return 1;
  if (style == S_STRONG) return 1;
  return 0;
}

/**
 * Resolve a style and block kind to the atlas colour.
 *
 * One function, so a paragraph's `strong` span and a code block's prose agree
 * about what "strong" means. Headings ignore inline styles entirely: a bold word
 * inside an H1 would be a distinction the reader cannot make.
 */
export function colourFor(kind: u8, level: u8, style: u8): i32 {
  if (kind == K_HEADING) return HEADING_COLOUR;
  if (kind == K_CODE) return CODE_COLOUR;
  if (kind == K_QUOTE) return MUTED_COLOUR;
  if (style == S_CODE) return CODE_COLOUR;
  if (style == S_LINK) return LINK_COLOUR;
  if (style == S_EMPHASIS) return MUTED_COLOUR;
  // Strong is bold, and the atlas carries bold only in the heading stripe.
  if (style == S_STRONG) return HEADING_COLOUR;
  return NORMAL_COLOUR;
}

/** The page a block's *lines* are set in, ignoring inline styles. */
function blockPage(kind: u8): FontPage {
  return pageFor(kind, S_PLAIN);
}

/** The page a single character is measured and drawn in. */
function charPage(kind: u8, style: u8): FontPage {
  return pageFor(kind, style);
}

/**
 * Space before a block, by kind — what makes a page scannable.
 *
 * Written as fractions of the **body** line step rather than as pixels: the
 * ratios are what the page's rhythm is made of, and they have to survive a change
 * of font size. The pins sit above on the body's grid even when the block itself
 * is set larger, which is what keeps an H1 from pushing its neighbours apart by
 * a step and a half.
 */
function spaceBefore(kind: u8, level: u8, bodyStep: i32): i32 {
  if (kind == K_HEADING) {
    if (level <= 1) return bodyStep * 5 / 4;   // 26 px
    if (level == 2) return bodyStep;           // 21
    if (level == 3) return bodyStep * 3 / 4;   // 15
    return bodyStep * 7 / 12;                  // 12
  }
  if (kind == K_PARAGRAPH) return bodyStep / 2;  // 10
  if (kind == K_CODE) return bodyStep / 2;       // 10
  if (kind == K_LIST_ITEM) return bodyStep / 12; // 1
  if (kind == K_QUOTE) return bodyStep * 5 / 12; // 8
  if (kind == K_RULE) return bodyStep * 7 / 12;  // 12
  return bodyStep / 3;                           // 7
}

/** Left indent in pixels, by block kind. */
function indentFor(kind: u8): i32 {
  if (kind == K_CODE) return CODE_INSET;
  if (kind == K_LIST_ITEM) return CODE_INSET;
  if (kind == K_QUOTE) return CODE_INSET;
  return 0;
}

/**
 * How far a character advances, in quarter-pixels, in its own style's page.
 *
 * The measurement the painter will later reproduce exactly: `Painter.textBytes`
 * accumulates the same table per character, so a line measured here and drawn
 * there is the same width to the quarter-pixel.
 */
function advanceQOf(kind: u8, chars: Uint8Array, styles: Uint8Array, at: i32): i32 {
  const style: u8 = styles[at];
  const code: i32 = chars[at];
  // A control byte (a tab, a stray newline in code) advances like a space: the
  // layout has already decided where the line breaks.
  const c: i32 = code < 32 ? 32 : code;
  return charPage(kind, style).advanceQ(weightFor(kind, style), c);
}

/**
 * The break width for a byte range, honouring word boundaries and **pixels**.
 *
 * Returns the number of characters from `start` that fit in `availPx`, preferring
 * to break at the last space in that run. A single word longer than the line is
 * broken mid-word rather than overflowing — a URL in a code sample is the case, and
 * spilling past the pane would paint over the divider beside it.
 */
export function breakLinePx(kind: u8, chars: Uint8Array, styles: Uint8Array,
                            start: i32, end: i32, availPx: i32): i32 {
  const limitQ: i32 = availPx * 4;
  let q: i32 = 0;
  let i: i32 = start;
  let lastSpace: i32 = -1;
  while (i < end) {
    const c: i32 = chars[i];
    if (c == 32) lastSpace = i;
    const a: i32 = advanceQOf(kind, chars, styles, i);
    if (q + a > limitQ) break;
    q += a;
    i++;
  }
  if (i >= end) {
    // Trim a trailing space so a single-line paragraph does not carry one.
    let n: i32 = end - start;
    while (n > 0 && chars[start + n - 1] == 32) n--;
    return n;
  }
  // The last space inside the run is a break point: everything before it fits and
  // the space itself moves to the next line to be skipped.
  if (lastSpace > start) return lastSpace - start;
  // No space: break where the pixels ran out, but never at zero (a glyph wider
  // than the whole pane would otherwise emit an empty line for ever).
  return i > start ? i - start : 1;
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
   * The pixel width this layout was wrapped at.
   *
   * Stored because the layout is a *cache*: `main.ts` reads it back to size rules
   * and panels to the same width the text was wrapped to, and a stale value there
   * is a rule that stops at the wrong place after a resize.
   */
  wrapPx: i32 = MIN_MEASURE_PX;
  /** Total laid-out height, for clamping the scroll. */
  height: i32 = 0;
  /** The body line step this layout was built with. */
  bodyStep: i32 = 21;

  /** Every character on the page, flattened across runs. */
  chars: Uint8Array = new Uint8Array(0);
  /** The style of each character, parallel to `chars`. */
  styles: Uint8Array = new Uint8Array(0);

  // --- lines ---------------------------------------------------------------
  lineStart: i32[] = [];
  lineLen: i32[] = [];
  lineY: i32[] = [];
  /** The line's width in pixels, from the advance table. */
  lineW: i32[] = [];
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
  /** The block's line pitch: 27 px for an H1, 21 for the body. */
  blockStep: i32[] = [];
  blockFirstLine: i32[] = [];
  blockLineCount: i32[] = [];
  /** A code block's language string (a bundle offset), or 0. */
  blockExtra: i32[] = [];

  get lineCount(): i32 { return this.lineStart.length; }
  get blockCount(): i32 { return this.blockIndex.length; }

  /**
   * Lay out `page` at `wrapPx` pixels of usable width.
   *
   * Two passes over the page's runs: the first counts characters so the buffers
   * are allocated once at their final size, the second fills them. A growable
   * array would double the allocations for the same result.
   */
  build(docs: Docs, page: u32, wrapPx: i32): void {
    const book: FontBook = fontBook();
    const body: FontPage = book.page(FONT_INTER, SIZE_14);

    this.page = page;
    let wrap: i32 = wrapPx < MIN_MEASURE_PX ? MIN_MEASURE_PX : wrapPx;
    this.wrapPx = wrap;
    this.bodyStep = body.lineStep;
    this.lineStart = [];
    this.lineLen = [];
    this.lineY = [];
    this.lineW = [];
    this.lineBlock = [];
    this.blockIndex = [];
    this.blockKind = [];
    this.blockLevel = [];
    this.blockFlags = [];
    this.blockY = [];
    this.blockH = [];
    this.blockStep = [];
    this.blockFirstLine = [];
    this.blockLineCount = [];
    this.blockExtra = [];

    const first: u32 = docs.pageBlockFirst(page);
    const count: u32 = docs.pageBlockCount(page);
    const bodyStep: i32 = body.lineStep;

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
    let y: i32 = TOP_PAD;

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
          // make the painter start a new line mid-paragraph. Code keeps its
          // newlines: there they are the listing's own structure.
          if (kind != K_CODE && (c == 10 || c == 13 || c == 9)) c = 32;
          this.chars[at] = c;
          this.styles[at] = style;
          at++;
        }
      }
      const len: i32 = at - start;

      const step: i32 = blockPage(kind).lineStep;
      const indent: i32 = indentFor(kind);
      // **The width every line of this block may use, in pixels.** The column
      // less the block's own inset — and, because the measurement is per
      // character, a code span inside a paragraph makes its line shorter without
      // the wrap having to know which span it was.
      const avail: i32 = wrap - indent > 0 ? wrap - indent : wrap;

      y += spaceBefore(kind, level, bodyStep);

      const blockSlot: i32 = this.blockIndex.length;
      this.blockIndex.push(<i32>bi);
      this.blockKind.push(kind);
      this.blockLevel.push(level);
      this.blockFlags.push(flags);
      this.blockY.push(y);
      this.blockStep.push(step);
      this.blockExtra.push(<i32>docs.blockExtra(bi));
      this.blockFirstLine.push(this.lineStart.length);

      let lines: i32 = 0;

      if (kind == K_RULE) {
        // A rule is a line of the layout with no text: the renderer draws a 1px
        // bar where a line would be.
        lines = 1;
        this.pushLine(start, 0, y, 0, blockSlot);
        y += RULE_ROW_H;
      } else if (kind == K_CODE) {
        // Code keeps its own line breaks and does not re-wrap at word
        // boundaries — a wrapped shell command is a broken shell command. A line
        // past the column is hard-wrapped at the column, which is the one place a
        // long line is truncated rather than reflowed.
        let s: i32 = start;
        const end: i32 = start + len;
        // Leading blank lines in a fence are noise in a box this small.
        while (s < end && this.chars[s] == 10) s++;
        let e: i32 = end;
        while (e > s && this.chars[e - 1] == 10) e--;

        if (s >= e) {
          this.pushLine(start, 0, y, 0, blockSlot);
          lines = 1;
          y += step;
        }
        while (s < e) {
          let nl: i32 = s;
          while (nl < e && this.chars[nl] != 10) nl++;
          let span: i32 = nl - s;
          let cursor: i32 = s;
          while (span > 0) {
            // Hard wrap: as many characters as fit in the pixel width.
            let take: i32 = 0;
            let q: i32 = 0;
            const limitQ: i32 = avail * 4;
            while (take < span) {
              const a: i32 = advanceQOf(kind, this.chars, this.styles, cursor + take);
              if (q + a > limitQ && take > 0) break;
              q += a;
              take++;
            }
            if (take <= 0) take = 1;
            this.pushLine(cursor, take, y, (q + 3) / 4, blockSlot);
            lines++;
            y += step;
            cursor += take;
            span -= take;
          }
          s = nl + 1;
        }

        // **A runnable block's button gets its own row** — a line with no text,
        // reserved here so the button has somewhere to sit that the layout knows
        // about. It is a real line in the flow: it advances a step, the transcript
        // anchors under it, and the paragraph after the block cannot be drawn on
        // top of it.
        if ((flags & F_RUNNABLE) != 0) {
          this.pushLine(start, 0, y, 0, blockSlot);
          lines++;
          y += step;
        }
      } else {
        // Prose: wrap at word boundaries, measured in pixels.
        let s: i32 = start;
        const end: i32 = start + len;
        while (s < end) {
          const take: i32 = breakLinePx(kind, this.chars, this.styles, s, end, avail);
          if (take <= 0) break;
          let q: i32 = 0;
          for (let i: i32 = 0; i < take; i++) {
            q += advanceQOf(kind, this.chars, this.styles, s + i);
          }
          this.pushLine(s, take, y, (q + 3) / 4, blockSlot);
          lines++;
          y += step;
          s += take;
          // Skip the space the break consumed, so the next line does not start
          // with one.
          while (s < end && this.chars[s] == 32) s++;
        }
        if (lines == 0) {
          // An empty paragraph still occupies a line in the flow.
          this.pushLine(start, 0, y, 0, blockSlot);
          lines = 1;
          y += step;
        }
      }

      this.blockLineCount.push(lines);
      // A code block is drawn inset in its own darker box, so it needs padding at
      // the bottom that plain prose does not.
      const codePad: i32 = kind == K_CODE ? 6 : 0;
      this.blockH.push(y - this.blockY[blockSlot] + codePad);
      if (kind == K_CODE) y += codePad;
    }

    this.height = y + BOTTOM_PAD;
  }

  /** One line, in the four arrays that describe it. */
  private pushLine(start: i32, len: i32, y: i32, w: i32, blockSlot: i32): void {
    this.lineStart.push(start);
    this.lineLen.push(len);
    this.lineY.push(y);
    this.lineW.push(w);
    this.lineBlock.push(blockSlot);
  }

  /** The scroll offset that puts a block at the top of the pane. */
  scrollForBlock(block: i32): i32 {
    for (let i: i32 = 0; i < this.blockIndex.length; i++) {
      if (this.blockIndex[i] == block) return this.blockY[i] - TOP_PAD;
    }
    return 0;
  }

  /**
   * Where a block's transcript panel hangs, in page space.
   *
   * The same expression the draw uses for its anchor (the last line's top plus one
   * step), in page coordinates so a caller can decide how far to scroll before the
   * frame that draws it. `-1` when the block is not on this page.
   */
  anchorForBlock(block: i32): i32 {
    for (let i: i32 = 0; i < this.blockIndex.length; i++) {
      if (this.blockIndex[i] == block) {
        const last: i32 = this.blockFirstLine[i] + this.blockLineCount[i] - 1;
        if (last >= 0 && last < this.lineY.length) {
          return this.lineY[last] + this.blockStep[i] + 5;
        }
        return -1;
      }
    }
    return -1;
  }

  /** The first line at or below `y` — a linear scan, bounded by the line count. */
  firstLineAt(y: i32): i32 {
    for (let i: i32 = 0; i < this.lineStart.length; i++) {
      if (this.lineY[i] + this.blockStep[this.lineBlock[i]] > y) return i;
    }
    return this.lineStart.length;
  }
}

// The atlas colour indices, straight from the theme: `layout.ts` used to keep
// its own copies so it did not have to import the painter, and a copy is how a
// palette drifts.
const NORMAL_COLOUR: i32 = NORMAL;
const MUTED_COLOUR: i32 = MUTED;
const LINK_COLOUR: i32 = LINK;
const CODE_COLOUR: i32 = CODE;
const HEADING_COLOUR: i32 = HEADING;
