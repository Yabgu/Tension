// What a UI atlas is, in numbers.
//
// ## Why this is data and not a set of `const`s a guest edits
//
// Everything below describes **one baked texture**: a grid of cells, a colour and
// weight stripe inside it, and the handful of solid cells that panels and rules are
// tiled from. A renderer needs all of it to turn a character into a record, and a
// game that ships its own atlas needs the same arithmetic with different numbers. So
// the numbers live in a value a `Painter` is constructed with, and the value the
// toolkit actually uses is a `FontPage` (`fonts.ts`) — one page per (family, size),
// straight out of `tools/font/bake-ttf.mjs`.
//
// ## Why there is no scale factor any more
//
// The VGA pass had one: the ROM glyphs were baked at 2x (`SCALE`), and that constant
// was the atlas's geometry, the toolkit's `CELL_W`, and the reason `px()` existed.
// Real outlines are baked at the size they are drawn at, so "how many device pixels
// one source pixel became" is 1 for every page and there is nothing to spell. A page
// carries its own cell, its own grid and its own line pitch instead, which is what
// lets a 14 px body and an 18 px heading be different faces rather than one face at
// two sizes.
//
// What survives from that pass, and still governs every draw:
//
// A sprite record has **one** `w`/`h` pair, and the vertex shader uses it for both
// the destination quad and the source texel rect:
//
//     a_position_w  = (r_words[3] >> 0)  & 0xFFFF   // destination
//     a_texcoord0_w = (r_words[3] >> 0)  & 0xFFFF   // source, same word
//     px  = position + corner * a_position_w
//     uv  = (texcoord0 + corner * a_texcoord0_w) / u_tex_size
//
// So a record **cannot be stretched**: asking for a 20x21 glyph with `w = 40` asks
// the sampler for the neighbouring cells, not for a bigger glyph. Panels are tiled
// from cells, a glyph is drawn at the size it was baked at, and `tileCost` is how a
// caller budgets before it draws.
//
// Records go down with type size, not up: a 14 px page's cell is smaller than the
// old 2x VGA cell, so the same panel costs more tiles and each line of prose costs
// one record per glyph. Measured on the documentation viewer's opening page at
// 1280x720: ~2,200 records, of the 4,096 a frame may stage.

/** Text colours, in atlas order. `ui.json` names the same five. */
export const NORMAL: i32 = 0;
export const MUTED: i32 = 1;
export const LINK: i32 = 2;
export const CODE: i32 = 3;
export const HEADING: i32 = 4;

export const REGULAR: i32 = 0;
export const BOLD: i32 = 1;

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
 * One atlas's geometry — what a `Painter` needs to turn a character into a record.
 *
 * The fields are set by the bake, not chosen: a `FontPage` fills them from
 * `fonts.generated.ts`, and an app with its own atlas fills them from its own
 * manifest. Fields rather than a lookup, because the painter reads `cellW`/`cellH`
 * on every glyph.
 */
export class Theme {
  /**
   * How many device pixels one source pixel became.
   *
   * Always 1 for a page of real outlines — kept because a hand-built bitmap atlas
   * may still be upscaled, and `spacing` defaults to it when nothing else is given.
   */
  scale: i32;
  cellW: i32;
  cellH: i32;
  gridCols: i32;
  stripe: i32;
  colourStride: i32;
  glyphCells: i32;
  firstChar: i32;
  lastChar: i32;

  /**
   * The texture page a record from this atlas samples.
   *
   * A record's `tex` field is the page of the pipeline's texture array, and
   * `set_texture` is what gives it meaning. One page per (family, size) is what
   * lets three faces live in one pipeline instead of three.
   */
  slot: i32;

  /**
   * A padding unit in device pixels, and the space between lines.
   *
   * Both used to be module constants derived from the one global cell, which was
   * fine while there was one font. A 14 px UI font and an 18 px one want different
   * padding, so they live here: `theme.pad(n)` and `theme.lineStep` are the
   * per-theme spelling.
   */
  spacing: i32;
  lineStep: i32;

  constructor(scale: i32, cellW: i32, cellH: i32, gridCols: i32, stripe: i32,
              colourStride: i32, glyphCells: i32, firstChar: i32, lastChar: i32,
              slot: i32 = 0, spacing: i32 = 0, lineStep: i32 = 0) {
    this.scale = scale;
    this.cellW = cellW;
    this.cellH = cellH;
    this.gridCols = gridCols;
    this.stripe = stripe;
    this.colourStride = colourStride;
    this.glyphCells = glyphCells;
    this.firstChar = firstChar;
    this.lastChar = lastChar;
    this.slot = slot;
    this.spacing = spacing > 0 ? spacing : (scale > 0 ? scale : 1);
    this.lineStep = lineStep > 0 ? lineStep : cellH + 4 * this.spacing;
  }

  /** `n` padding units in device pixels, for a layout that wants to breathe. */
  pad(n: i32): i32 {
    return n * this.spacing;
  }
}

/**
 * How many records a rectangle would cost, so a caller can budget before it
 * draws. `Painter.fill` emits exactly this many.
 */
export function tileCost(w: i32, h: i32, theme: Theme): i32 {
  if (w <= 0 || h <= 0) return 0;
  const cols: i32 = (w + theme.cellW - 1) / theme.cellW;
  const rows: i32 = (h + theme.cellH - 1) / theme.cellH;
  return cols * rows;
}

/** How many records a horizontal rule would cost. */
export function hlineCost(w: i32, theme: Theme): i32 {
  return w <= 0 ? 0 : (w + theme.cellW - 1) / theme.cellW;
}
