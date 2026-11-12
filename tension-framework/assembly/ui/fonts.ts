// Fonts as data: one page of a baked atlas, and the book that indexes them.
//
// ## Why this is not a font library
//
// There is still no text verb in the 2D renderer. A character is one sprite
// sampling one cell, and that is the whole mechanism — so a "font" here is the
// table a painter needs to turn a code point into a record: a cell size, a grid,
// a stripe slot and an advance. `tools/font/bake-ttf.mjs` produces those numbers
// from real outlines; this file is how the guest reads them.
//
// ## Why the numbers are generated source and not a data file
//
// TensionScript has no JSON parser (`apps/docs/src/format.ts` ships a 25-line
// extractor for ten integers and says why a real parser is the wrong trade). A
// 95-entry advance table per weight per page is not ten integers. So the baker
// writes `fonts.generated.ts` — compile-time constants in the guest's own source
// — and `ui.json` remains the human-readable contract the verifier checks the
// baked bytes against. Both come out of one run, so they cannot disagree about
// what exists.
//
// ## Why advances are quarter-pixels
//
// A painter places a glyph at an integer pixel; there is no subpixel position to
// be had with nearest sampling. Rounding each advance to a whole pixel would put
// a forty-character line up to twenty pixels away from what the font asks for,
// and the error grows with the line. So the table is in 1/4 px and `Painter`
// rounds the *accumulated* position: every glyph lands within an eighth of a
// pixel of where the outline says, and nothing accumulates.

import { Canvas } from "../2d/canvas";
import { Theme } from "./theme";
import {
  FONT_ADVANCES, FONT_ADV_OFFSET, FONT_ATLAS, FONT_ATLAS_HEIGHT, FONT_ATLAS_WIDTH,
  FONT_BASELINE, FONT_CELL_H, FONT_CELL_W, FONT_CHROME_FIRST, FONT_FAMILIES, FONT_FAMILY,
  FONT_FIRST, FONT_GLYPHS, FONT_GRID_COLS, FONT_LAST, FONT_LINE_HEIGHT, FONT_MONO,
  FONT_PAGE_COUNT, FONT_PAIR_SLOT, FONT_PAIRS, FONT_INTER, FONT_SIZE, FONT_SIZES, FONT_SLOT,
  FONT_STRIPE, FONT_WEIGHTS, SIZE_14, SIZE_18,
} from "./fonts.generated";

/**
 * The generated constants, re-exported for a caller that indexes the book.
 *
 * A `FontPage` is looked up by `(FontId, SizeId)`, and those are numbers only the
 * bake knows: `FONT_INTER`/`FONT_MONO` and `SIZE_14`/`SIZE_18` come from
 * `fonts.generated.ts`, so a UI never spells a page index by hand.
 */
export {
  FONT_ATLAS, FONT_ATLAS_HEIGHT, FONT_ATLAS_WIDTH, FONT_FAMILIES, FONT_FIRST, FONT_GLYPHS,
  FONT_INTER, FONT_LAST, FONT_MONO, FONT_PAGE_COUNT, FONT_PAIRS, FONT_SIZE, FONT_SIZES,
  FONT_SLOT, FONT_STRIPE, SIZE_14, SIZE_18,
};

/** Advances are in `1 / FONT_ADVANCE_UNIT` of a pixel. @see the header. */
export const ADVANCE_UNIT: i32 = 4;

/**
 * The chrome cells, by *name*, inside a page's grid.
 *
 * A `Theme`'s `CHROME_*` constants are absolute cell indices in the default
 * atlas (950..959). A page's chrome sits at `page.chromeFirst + index`, so the
 * index is the stable thing and the cell is derived: `page.chromeCell(Chrome.Panel)`.
 */
export const enum Chrome {
  White = 0,
  Caret = 1,
  Selection = 2,
  Panel = 3,
  Surface = 4,
  Divider = 5,
  Track = 6,
  Thumb = 7,
  Underline = 8,
  CodeBg = 9,
}

/**
 * One baked (font, size) page: a `Theme` plus what only a font has.
 *
 * Inheriting `Theme` rather than holding one is deliberate — every painter verb
 * takes a `Theme` for its grid arithmetic, and a page *is* a grid. The extra
 * fields are the three things a proportional font needs and a bitmapped cell
 * does not: a baseline inside the cell, a line pitch, and advances.
 */
export class FontPage extends Theme {
  /** `FontId`: which family this page belongs to. */
  family: i32;
  /** `SizeId`: which of the book's pixel sizes this is. */
  sizeIndex: i32;
  /** The size in pixels the outlines were rasterized at. Not a scalable value. */
  sizePx: i32;
  /**
   * Where the baseline sits inside the cell, measured from the cell's top.
   *
   * The painter draws a glyph by putting the cell's top-left at the text
   * position, so this is what makes a line's letters share a baseline without
   * the caller doing any arithmetic.
   */
  baseline: i32;
  /** Where this page's advance table starts: `weight * glyphs` steps from here. */
  advanceBase: i32;

  constructor(page: i32) {
    const size: i32 = FONT_SIZES[FONT_SIZE[page]];
    // A padding unit that grows with the type but slowly: 2 px at 14 and 18,
    // 3 px at 24. Integer arithmetic, because a half-pixel pad is a half-pixel
    // gap in a panel that was measured in whole pixels.
    const spacing: i32 = (size + 4) / 8 >= 1 ? (size + 4) / 8 : 1;
    super(
      1,                          // no bake factor: outlines are drawn 1:1
      FONT_CELL_W[page], FONT_CELL_H[page], FONT_GRID_COLS[page],
      FONT_STRIPE, FONT_STRIPE * 2, FONT_CHROME_FIRST,
      FONT_FIRST, FONT_LAST,
      FONT_SLOT[page], spacing, FONT_LINE_HEIGHT[page],
    );
    this.family = FONT_FAMILY[page];
    this.sizeIndex = FONT_SIZE[page];
    this.sizePx = size;
    this.baseline = FONT_BASELINE[page];
    this.advanceBase = FONT_ADV_OFFSET[page * FONT_WEIGHTS];
  }

  /**
   * The stripe slot a (colour, weight) pair occupies, or -1 when it is not
   * baked.
   *
   * A page carries only the pairs the bake declared — six in the default atlas,
   * not the ten a full cross product would be — so asking for `(link, bold)`
   * when the spec did not bake it is a **missing stripe**, not a recolour. -1
   * makes `Painter` skip the glyph rather than sample the neighbouring one.
   */
  pairSlot(colour: i32, weight: i32): i32 {
    const at: i32 = colour * 2 + weight;
    if (at < 0 || at >= FONT_PAIR_SLOT.length) return -1;
    return FONT_PAIR_SLOT[at];
  }

  /** The cell a (colour, weight, code) triple occupies, or -1. */
  cellOf(colour: i32, weight: i32, code: i32): i32 {
    if (code < this.firstChar || code > this.lastChar) return -1;
    const slot: i32 = this.pairSlot(colour, weight);
    if (slot < 0) return -1;
    return slot * FONT_STRIPE + (code - this.firstChar);
  }

  /**
   * The advance for one code, in quarter-pixels.
   *
   * A code outside the baked range — a UTF-8 continuation byte, a CP-1252 quote,
   * anything the atlas does not carry — advances like a **space**, not like
   * nothing. Zero would overlap the following glyph on top of it, which turns a
   * missing character into a garbled word; a space leaves a gap where the
   * character is. The glyph itself still does not draw (`cellOf` answers -1),
   * because inventing a box would be a worse lie.
   */
  advanceQ(weight: i32, code: i32): i32 {
    const at: i32 = code >= this.firstChar && code <= this.lastChar
      ? code : this.firstChar;   // firstChar is the space, by construction
    return FONT_ADVANCES[this.advanceBase + weight * FONT_GLYPHS + (at - this.firstChar)];
  }

  /** The advance for one code, in pixels. Lossy: measure a line, not a glyph. */
  advancePx(weight: i32, code: i32): i32 {
    return (this.advanceQ(weight, code) + ADVANCE_UNIT - 1) / ADVANCE_UNIT;
  }

  /** A chrome cell's index inside this page's grid. */
  chromeCell(index: i32): i32 {
    return FONT_CHROME_FIRST + index;
  }
}

/**
 * The pages one atlas carries, indexed by `(FontId, SizeId)`.
 *
 * `FONT_PAGE_COUNT` is 3 in the default atlas and the lookup is a linear scan
 * over three — a table would be a second structure to keep in step with the
 * generated one for no measurable gain.
 */
export class FontBook {
  pages: FontPage[];

  constructor() {
    this.pages = new Array<FontPage>(FONT_PAGE_COUNT);
    for (let i: i32 = 0; i < FONT_PAGE_COUNT; i++) this.pages[i] = new FontPage(i);
  }

  get count(): i32 {
    return this.pages.length;
  }

  /**
   * The page for a family and size, or page 0 when the atlas does not carry
   * that combination.
   *
   * A fallback rather than a null: a UI that asks for `(mono, 18)` and gets
   * Inter 14 draws *something* legible in the wrong face, which is a bug report;
   * a null would be a trap in every caller.
   */
  page(family: i32, sizeIndex: i32): FontPage {
    for (let i: i32 = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.family == family && p.sizeIndex == sizeIndex) return p;
    }
    return this.pages[0];
  }

  /**
   * A line's width in pixels, from the advance table.
   *
   * Rounded up, so a caller that uses the answer as a layout width never clips
   * the last glyph by a pixel.
   */
  measure(page: FontPage, weight: i32, chars: Uint8Array, start: i32, len: i32): i32 {
    let q: i32 = 0;
    const end: i32 = start + len;
    for (let i: i32 = start; i < end; i++) {
      const code: i32 = chars[i];
      // A control byte advances like a space: the layout already decided where
      // the line breaks, and a painter that also honoured `\n` would break a
      // line twice (`Painter.text` has the long version of this).
      q += page.advanceQ(weight, code < 32 ? 32 : code);
    }
    return (q + ADVANCE_UNIT - 1) / ADVANCE_UNIT;
  }

  /** `measure` for a string, for a widget sizing itself from its label. */
  measureText(page: FontPage, weight: i32, text: string): i32 {
    let q: i32 = 0;
    for (let i: i32 = 0; i < text.length; i++) {
      const code: i32 = text.charCodeAt(i);
      q += page.advanceQ(weight, code < 32 ? 32 : code);
    }
    return (q + ADVANCE_UNIT - 1) / ADVANCE_UNIT;
  }
}

/** The process's one book, built on first use. */
let sharedBook: FontBook | null = null;

/** The default book: the pages `assets/ui.*.iwi` were baked into. */
export function fontBook(): FontBook {
  if (sharedBook == null) sharedBook = new FontBook();
  return sharedBook!;
}

/**
 * Upload every page of the atlas and bind it to its slot, then index them.
 *
 * One call because the three things must agree: the file the bake wrote, the
 * slot the record names, and the page the book hands out. A caller that bound
 * two of three pages gets a frame with one face missing, which looks like a
 * broken font rather than like a missing texture.
 *
 * Returns 0, or the first negative errno the canvas answered.
 */
export function loadFontBook(canvas: Canvas, pipe: i32): i32 {
  const book = fontBook();
  for (let i: i32 = 0; i < book.pages.length; i++) {
    const page = book.pages[i];
    const texture: i32 = canvas.loadTextureFromRes(FONT_ATLAS[page.slot]);
    if (texture <= 0) return texture;
    const bound: i32 = canvas.bindTexture(pipe, page.slot, texture);
    if (bound != 0) return bound;
  }
  return 0;
}
