// The text engine: a byte span in, sprite records out.
//
// ## Why this is not a font library
//
// There is no text verb in the 2D renderer. A character on screen is one sprite
// sampling one cell of `ui.iwi`, and that is the whole mechanism — so this file
// is an index computation with a clip, not a layout system.
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
// the shell are tiled for exactly this reason.
//
// The engine does have a scaled variant in the graph compiler
// (`pipeline_default::scaled_graph`, preset 101) that multiplies `w`/`h` by two
// in the vertex stage and so genuinely upscales — but preset 101 is above
// `PIPE_PRESET_MAX` (99) and `preset()` only ever compiles `default_graph()`, so
// a guest cannot ask for it in this build (`-ENOENT`). Changing that is an
// engine change.
//
// What is left, and what this build does: **bake the atlas at 2x**. `SCALE`
// below is the factor `tools/make-font.mjs` duplicated every pixel by, so a cell
// is 16x32 and a record that samples 16x32 texels paints a 16x32 quad. Nearest
// filtering makes that exactly crisp — each source pixel becomes a 2x2 block,
// with no interpolation to mud the edges.
//
// Records go **down**, not up: a glyph is still one record, and the tiled fills
// (panel backgrounds, rules) step by the cell size, so half as many tiles cover
// the same pixels. Measured on the opening page: 1,646 records at 1x, 801 at 2x.
//
// ## Why text is bytes
//
// Every string in the bundle is ASCII — `tools/bundle.mjs` refuses to build a
// character the font cannot draw, and `tools/verify.mjs` re-checks the whole
// graph. So a character is a `u8` and rendering allocates nothing: a frame draws
// ~2,500 glyphs and none of them creates an object.

import { Canvas, SpriteRecord } from "tension-framework";

// ── the atlas geometry, from `assets/ui.json` ───────────────────────────────
//
// These are the numbers `tools/make-font.mjs` writes. They are constants here
// rather than values read at startup because `memory.data` needs a compile-time
// size and because the formula below is the atlas's definition: a mismatch would
// be a wrong glyph, not a slower frame.

/**
 * The integer factor the atlas is baked at.
 *
 * 2 makes 8x16 cells 16x32 — roughly twice the cap height of the 1x font, which
 * is the difference between "I can read this" and "I have to lean in" on a
 * modern display. It must match `SCALE` in `tools/make-font.mjs`; a mismatch
 * would sample half a glyph rather than fail, so `tools/verify.mjs` checks the
 * baked cell size against this constant's value through `assets/ui.json`.
 *
 * Integer only. A fractional factor would put glyph edges on half pixels, and
 * with `Filter::Nearest` that is not a softer edge — it is a glyph with one row
 * or column dropped, which looks like damage.
 */
export const SCALE: i32 = 2;

export const CELL_W: i32 = 8 * SCALE;
export const CELL_H: i32 = 16 * SCALE;

const GRID_COLS: i32 = 32;
const STRIPE: i32 = 95;          // glyphs per (colour, weight) stripe
const COLOUR_STRIDE: i32 = 190;  // STRIPE * 2 weights
export const GLYPH_CELLS: i32 = 950;
const FIRST_CHAR: i32 = 32;
const LAST_CHAR: i32 = 126;

/** Text colours, in atlas order. `assets/ui.json` names the same five. */
export const NORMAL: i32 = 0;
export const MUTED: i32 = 1;
export const LINK: i32 = 2;
export const CODE: i32 = 3;
export const HEADING: i32 = 4;

export const REGULAR: i32 = 0;
export const BOLD: i32 = 1;

/** Chrome cells: solid blocks the viewer stretches into panels and rules. */
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
 * A cap slightly below it leaves room for the shell's own records and, more
 * importantly, makes the failure *visible*: `dropped` is drawn in the status bar
 * rather than the frame silently losing its tail.
 */
export const MAX_RECORDS: i32 = 4000;

/**
 * How many records a rectangle would cost, so a caller can budget before it
 * draws. `fill` emits exactly this many.
 */
export function tileCost(w: i32, h: i32): i32 {
  if (w <= 0 || h <= 0) return 0;
  const cols: i32 = (w + CELL_W - 1) / CELL_W;
  const rows: i32 = (h + CELL_H - 1) / CELL_H;
  return cols * rows;
}

/** How many records a horizontal rule would cost. */
export function hlineCost(w: i32): i32 {
  return w <= 0 ? 0 : (w + CELL_W - 1) / CELL_W;
}

/** One record's size, fixed at compile time so `memory.data` accepts it. */
const RECORD_BYTES: usize = sizeof<SpriteRecord>();

/**
 * A frame's worth of sprite records, and the rules for filling them.
 *
 * One instance, reused: `reset()` at the top of each frame, `submit()` at the
 * bottom. The buffer is allocated once, so a frame's cost is the records emitted
 * and nothing else.
 */
export class Painter {
  private base: usize = memory.data(<i32>MAX_RECORDS * <i32>RECORD_BYTES, 8);

  /** Records emitted this frame. */
  count: i32 = 0;
  /** Records the clip refused because the budget was full. Drawn as a warning. */
  dropped: i32 = 0;
  /** Draw order. Later is on top, because the host sorts by this. */
  private order: u32 = 0;

  reset(): void {
    this.count = 0;
    this.dropped = 0;
    this.order = 0;
  }

  private view(): @unmanaged [SpriteRecord *] {
    return changetype<@unmanaged [SpriteRecord *]>(this.base);
  }

  /**
   * One sprite, with no clipping.
   *
   * `cell` is an atlas cell index; `cellOrigin` turns it into pixels. Used for
   * the chrome (a stretched 1x1 becomes a panel, a divider, a button box).
   */
  sprite(x: i32, y: i32, w: i32, h: i32, cell: i32): void {
    if (this.count >= MAX_RECORDS) { this.dropped++; return; }
    // A zero- or negative-sized quad is not a draw; skipping it keeps the
    // record count honest.
    if (w <= 0 || h <= 0) return;

    const cellX: i32 = (cell % GRID_COLS) * CELL_W;
    const cellY: i32 = (cell / GRID_COLS) * CELL_H;

    const v = this.view();
    const i = this.count++;
    v[i].x = x;
    v[i].y = y;
    v[i].srcX = <u16>cellX;
    v[i].srcY = <u16>cellY;
    v[i].w = <u16>w;
    v[i].h = <u16>h;
    v[i].tex = 0;
    v[i].sortKey = this.order++;
    v[i].groupId = 0;
    v[i].z = 0;
    v[i].flags = 0;
  }

  /**
   * A filled rectangle, **tiled** from 8x16 cells.
   *
   * A sprite cannot be stretched: the record's `w`/`h` are used for the
   * destination quad *and* for the source texel rect, so a 640x24 fake-panel is
   * a request to sample a 640x24 region of a 256x512 atlas — which clamps to the
   * edge and paints whatever happens to be there. Measured: a stretched cell drew
   * nothing; the same cell at its natural size drew correctly.
   *
   * So a rectangle is ceil(w/8) * ceil(h/16) sprites. That makes the cost
   * explicit, which is the point: `tileCost` lets a caller decide before it draws,
   * and the 4096-record budget is spent where it shows.
   */
  fill(x: i32, y: i32, w: i32, h: i32, cell: i32): void {
    if (w <= 0 || h <= 0) return;
    for (let ty: i32 = 0; ty < h; ty += CELL_H) {
      const th: i32 = h - ty < CELL_H ? h - ty : CELL_H;
      for (let tx: i32 = 0; tx < w; tx += CELL_W) {
        const tw: i32 = w - tx < CELL_W ? w - tx : CELL_W;
        this.sprite(x + tx, y + ty, tw, th, cell);
      }
    }
  }

  /**
   * A one-pixel horizontal rule, tiled in 8-pixel steps.
   *
   * A rule is the cheapest way to divide two regions when no rectangle can be
   * filled: 1280 pixels is 160 records rather than the 7,200 a background would
   * cost.
   */
  hline(x: i32, y: i32, w: i32, cell: i32): void {
    if (w <= 0) return;
    for (let tx: i32 = 0; tx < w; tx += CELL_W) {
      const tw: i32 = w - tx < CELL_W ? w - tx : CELL_W;
      this.sprite(x + tx, y, tw, 1, cell);
    }
  }

  /** A one-pixel vertical rule, tiled in 16-pixel steps. */
  vline(x: i32, y: i32, h: i32, cell: i32): void {
    if (h <= 0) return;
    for (let ty: i32 = 0; ty < h; ty += CELL_H) {
      const th: i32 = h - ty < CELL_H ? h - ty : CELL_H;
      this.sprite(x, y + ty, 1, th, cell);
    }
  }

  /**
   * One character, clipped vertically.
   *
   * The clip is applied by trimming the source rectangle, which works because at
   * this size source and destination are the same pixels — the reason there is no
   * scale parameter. A glyph entirely outside `[clipTop, clipBottom)` emits
   * nothing, so a scrolled page costs only its visible lines.
   */
  private glyph(code: i32, x: i32, y: i32, colour: i32, weight: i32,
                clipTop: i32, clipBottom: i32): void {
    if (code < FIRST_CHAR || code > LAST_CHAR) return;
    if (this.count >= MAX_RECORDS) { this.dropped++; return; }

    // Vertical clip, in whole pixels because source == destination here.
    let destY: i32 = y;
    let srcTop: i32 = 0;
    let destH: i32 = CELL_H;

    if (destY < clipTop) {
      const cut: i32 = clipTop - destY;
      if (cut >= CELL_H) return;
      destY += cut;
      srcTop = cut;
      destH -= cut;
    }
    if (destY + destH > clipBottom) {
      destH = clipBottom - destY;
      if (destH <= 0) return;
    }

    const cell: i32 = colour * COLOUR_STRIDE + weight * STRIPE + (code - FIRST_CHAR);
    const cellX: i32 = (cell % GRID_COLS) * CELL_W;
    const cellY: i32 = (cell / GRID_COLS) * CELL_H;

    const v = this.view();
    const i = this.count++;
    v[i].x = x;
    v[i].y = destY;
    v[i].srcX = <u16>cellX;
    v[i].srcY = <u16>(cellY + srcTop);
    v[i].w = <u16>CELL_W;
    v[i].h = <u16>destH;
    v[i].tex = 0;
    v[i].sortKey = this.order++;
    v[i].groupId = 0;
    v[i].z = 0;
    v[i].flags = 0;
  }

  /**
   * Draw `len` bytes at `ptr`, starting at `x`, on baseline-free top-left
   * coordinates.
   *
   * `advance` is the per-character step in pixels: `CELL_W` for body text, more for a
   * heading that wants air. It does not change the glyph's size — nothing can.
   *
   * Returns the x position after the last character, so a caller can append.
   */
  text(ptr: usize, len: i32, x: i32, y: i32, colour: i32, weight: i32,
       advance: i32, clipTop: i32, clipBottom: i32): i32 {
    let cursor: i32 = x;
    for (let i: i32 = 0; i < len; i++) {
      const code: i32 = load<u8>(ptr + <usize>i);
      // **This function never breaks a line.** `layout.ts` decides where every
      // line starts and how far it runs; a painter that also honoured `\n`
      // would break a line the layout had already placed, which is exactly what
      // produced orphaned words 20 pixels low when a paragraph's source
      // newlines reached here. A control byte is therefore a space, and a tab is
      // four of them.
      if (code == 9) { cursor += advance * 4; continue; }
      if (code < 32) { cursor += advance; continue; }
      this.glyph(code, cursor, y, colour, weight, clipTop, clipBottom);
      cursor += advance;
    }
    return cursor;
  }

  /**
   * Draw one character at a position; used for a caret and for single glyphs.
   */
  char(code: i32, x: i32, y: i32, colour: i32, weight: i32,
       clipTop: i32, clipBottom: i32): void {
    this.glyph(code, x, y, colour, weight, clipTop, clipBottom);
  }

  /** Hand the frame to the canvas. `bucket` is the 2D renderer's z bucket. */
  submit(canvas: Canvas, pipe: i32): i32 {
    if (this.count == 0) return 0;
    return canvas.submit(pipe, this.view(), <u32>this.count, 0);
  }

  /** Whether the budget is exhausted — a caller can stop walking early. */
  get full(): bool {
    return this.count >= MAX_RECORDS;
  }
}

// ── measuring and wrapping ──────────────────────────────────────────────────
//
// Both are pure arithmetic over byte lengths: a glyph advances by `advance`
// whatever it is, because the font is monospace (`CELL_W`, no kerning table, no
// per-glyph widths). That is why wrapping is a character count and not a
// measurement loop.

/** How many characters fit in `pixels` at `advance`. */
export function columnsFor(pixels: i32, advance: i32 = CELL_W): i32 {
  return pixels / advance;
}

/**
 * The break width for a byte range, honouring word boundaries.
 *
 * Returns the number of characters from `start` that belong on the line, never
 * exceeding `maxCols`, and preferring to break at a space. A single word longer
 * than the line is broken mid-word rather than overflowing — a URL in a code
 * sample is the case, and spilling outside the pane would paint over the
 * sidebar.
 */
export function breakAt(ptr: usize, start: i32, end: i32, maxCols: i32): i32 {
  const limit: i32 = start + maxCols;
  if (limit >= end) return end - start;

  // Walk back to the last space at or before the limit.
  for (let i: i32 = limit; i > start; i--) {
    if (load<u8>(ptr + <usize>i) == 32) return i - start;
  }
  return maxCols;
}
