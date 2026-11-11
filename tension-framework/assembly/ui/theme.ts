// What a UI atlas is, in numbers.
//
// ## Why the theme is data and not a set of `const`s a guest edits
//
// Everything below describes **one baked texture**: a grid of cells, a colour and
// weight stripe inside it, and the handful of solid cells that panels and rules
// are tiled from. A renderer needs all of it to turn a character into a record,
// and a game that ships its own atlas needs the same arithmetic with different
// numbers. So the numbers live in a value a `Painter` is constructed with, and
// `DEFAULT_THEME` is the atlas this repository bakes (`tools/font/make-font.mjs`).
//
// ## Why the scale is in the atlas and not in the record
//
// The sprite record has **one** `w`/`h` pair, and the vertex shader uses it for
// both the destination quad and the source texel rect:
//
//     a_position_w  = (r_words[3] >> 0)  & 0xFFFF   // destination
//     a_texcoord0_w = (r_words[3] >> 0)  & 0xFFFF   // source, same word
//     px  = position + corner * a_position_w
//     uv  = (texcoord0 + corner * a_texcoord0_w) / u_tex_size
//
// So a record **cannot be stretched**: emitting an 8x16 glyph with `w = 16` asks
// the sampler for a 16x32 region of the atlas, which is the neighbouring cells —
// not a bigger glyph. Measured during 2.2b: a stretched chrome cell drew
// *nothing*, and the same cell at its natural size drew correctly; the panels in
// this toolkit are tiled for exactly this reason.
//
// The engine does have a scaled variant in the graph compiler
// (`pipeline_default::scaled_graph`, preset 101) that multiplies `w`/`h` by two
// in the vertex stage and so genuinely upscales — but preset 101 is above
// `PIPE_PRESET_MAX` (99) and `preset()` only ever compiles `default_graph()`, so a
// guest cannot ask for it in this build (`-ENOENT`). Changing that is an engine
// change.
//
// What is left, and what this build does: **bake the atlas at 2x**. `SCALE`
// below is the factor `tools/font/make-font.mjs` duplicated every pixel by, so a
// cell is 16x32 and a record that samples 16x32 texels paints a 16x32 quad.
// Nearest filtering makes that exactly crisp — each source pixel becomes a 2x2
// block, with no interpolation to mud the edges.
//
// Records go **down**, not up: a glyph is still one record, and the tiled fills
// (panel backgrounds, rules) step by the cell size, so half as many tiles cover
// the same pixels. Measured on the documentation viewer's opening page: 1,646
// records at 1x, 801 at 2x.

/**
 * The integer factor the default atlas is baked at.
 *
 * 2 makes 8x16 cells 16x32 — roughly twice the cap height of the 1x font, which
 * is the difference between "I can read this" and "I have to lean in" on a
 * modern display. It must match `SCALE` in `tools/font/make-font.mjs`; a
 * mismatch would sample half a glyph rather than fail, so the atlas's own
 * `ui.json` carries the baked size and `apps/docs/tools/verify.mjs` compares it
 * against this constant.
 *
 * Integer only. A fractional factor would put glyph edges on half pixels, and
 * with `Filter::Nearest` that is not a softer edge — it is a glyph with one row
 * or column dropped, which looks like damage.
 */
export const SCALE: i32 = 2;

/**
 * The cell's width in source pixels: **9**, not 8.
 *
 * The ROM glyphs fill all eight of their columns, because VGA text mode's
 * 80-column cell is nine dots wide and the hardware supplies the ninth as
 * spacing (`tools/font/font8x16.mjs` has the detail). At an 8-pixel advance one
 * glyph's column 0 would touch its neighbour's column 7. The ninth column is
 * blank in the atlas for every glyph, which is what makes that impossible — and
 * it is asserted on the baked bytes by `tools/font/make-font.mjs`.
 */
export const CELL_W: i32 = 9 * SCALE;
export const CELL_H: i32 = 16 * SCALE;

/** Cells across the atlas grid, and the stripe a (colour, weight) pair occupies. */
export const GRID_COLS: i32 = 32;
export const STRIPE: i32 = 95;          // glyphs per (colour, weight) stripe
export const COLOUR_STRIDE: i32 = 190;  // STRIPE * 2 weights
export const GLYPH_CELLS: i32 = 950;
export const FIRST_CHAR: i32 = 32;
export const LAST_CHAR: i32 = 126;

/** Text colours, in atlas order. `ui.json` names the same five. */
export const NORMAL: i32 = 0;
export const MUTED: i32 = 1;
export const LINK: i32 = 2;
export const CODE: i32 = 3;
export const HEADING: i32 = 4;

export const REGULAR: i32 = 0;
export const BOLD: i32 = 1;

/** Chrome cells: solid blocks that panels and rules are tiled from. */
export const CHROME_WHITE: i32 = 950;
export const CHROME_CARET: i32 = 951;
export const CHROME_SELECTION: i32 = 952;
export const CHROME_PANEL: i32 = 953;
export const CHROME_SURFACE: i32 = 954;
export const CHROME_DIVIDER: i32 = 955;
export const CHROME_TRACK: i32 = 956;
export const CHROME_THUMB: i32 = 957;
export const CHROME_UNDERLINE: i32 = 958;
export const CHROME_CODE_BG: i32 = 959;

/**
 * The record budget for one frame.
 *
 * The renderer stages 4096 records **across all buckets** — not per bucket
 * (`render2d/device.rs`: the check sums every bucket's length before comparing).
 * A cap slightly below it leaves room for a shell's own records and, more
 * importantly, makes the failure *visible*: a caller can draw `dropped` rather
 * than losing the tail of the frame silently.
 */
export const MAX_RECORDS: i32 = 4000;

/**
 * One atlas's geometry — what a `Painter` needs to turn a character into a
 * record.
 *
 * The default is the atlas this repository bakes, so a caller that has its own
 * texture passes its own numbers and gets the same painter. Fields rather than a
 * lookup, because the painter reads `cellW`/`cellH` on every glyph.
 */
export class Theme {
  /** The integer bake factor. Only used to derive the fields below. */
  scale: i32;
  cellW: i32;
  cellH: i32;
  gridCols: i32;
  stripe: i32;
  colourStride: i32;
  glyphCells: i32;
  firstChar: i32;
  lastChar: i32;

  constructor(scale: i32, cellW: i32, cellH: i32, gridCols: i32, stripe: i32,
              colourStride: i32, glyphCells: i32, firstChar: i32, lastChar: i32) {
    this.scale = scale;
    this.cellW = cellW;
    this.cellH = cellH;
    this.gridCols = gridCols;
    this.stripe = stripe;
    this.colourStride = colourStride;
    this.glyphCells = glyphCells;
    this.firstChar = firstChar;
    this.lastChar = lastChar;
  }
}

/** The atlas this build ships: 5 colours x 2 weights x 95 glyphs + chrome. */
export const DEFAULT_THEME: Theme = new Theme(
  SCALE, CELL_W, CELL_H, GRID_COLS, STRIPE, COLOUR_STRIDE, GLYPH_CELLS, FIRST_CHAR, LAST_CHAR,
);

/**
 * How many records a rectangle would cost, so a caller can budget before it
 * draws. `Painter.fill` emits exactly this many.
 */
export function tileCost(w: i32, h: i32, theme: Theme = DEFAULT_THEME): i32 {
  if (w <= 0 || h <= 0) return 0;
  const cols: i32 = (w + theme.cellW - 1) / theme.cellW;
  const rows: i32 = (h + theme.cellH - 1) / theme.cellH;
  return cols * rows;
}

/** How many records a horizontal rule would cost. */
export function hlineCost(w: i32, theme: Theme = DEFAULT_THEME): i32 {
  return w <= 0 ? 0 : (w + theme.cellW - 1) / theme.cellW;
}
