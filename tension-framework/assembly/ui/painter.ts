// Sprite records in, from a byte span of ASCII: the whole of "drawing text".
//
// ## Why this is not a font library
//
// There is no text verb in the 2D renderer. A character on screen is one sprite
// sampling one cell of an atlas, and that is the whole mechanism — so this file
// is an index computation with a clip, not a layout system. `flow.ts` owns where
// lines go; this owns which pixels each glyph occupies.
//
// ## Why text is bytes
//
// A UI atlas is ASCII by construction — `apps/docs/tools/bundle.mjs` refuses to
// build a docs character the font cannot draw, and the same rule applies to any
// game that bakes its own. So a character is a `u8` and rendering allocates
// nothing: a frame draws ~2,500 glyphs and none of them creates an object.
//
// A game with a different alphabet overrides `theme.firstChar`/`lastChar` and
// bakes the cells it needs; the arithmetic below is the same.

import { Canvas } from "../2d/canvas";
import { RecordBuffer } from "../2d/buffers";
import {
  CELL_H, CELL_W, DEFAULT_THEME, MAX_RECORDS, Theme,
} from "./theme";

/**
 * A frame's worth of sprite records, and the rules for filling them.
 *
 * One instance, reused: `reset()` at the top of each frame, `submit()` at the
 * bottom. The buffer is allocated once, so a frame's cost is the records emitted
 * and nothing else.
 *
 * ## The clip
 *
 * `setClip` installs a rectangle that every draw is trimmed to — that is what
 * keeps a scrolling panel from painting over the pane beside it, and it is the
 * one thing the documentation viewer could do without because it only ever
 * clipped vertically by hand. A glyph straddling the edge is trimmed by
 * shortening its **source** rect, which works because at this size source and
 * destination are the same pixels; the reason there is no scale parameter is the
 * one `theme.ts` explains.
 */
export class Painter {
  private buf: RecordBuffer;
  private order: u32 = 0;
  /** The atlas this painter draws from. */
  theme: Theme;

  // --- the clip, in destination pixels -------------------------------------
  private clipX0: i32 = -0x7FFFFFFF;
  private clipY0: i32 = -0x7FFFFFFF;
  private clipX1: i32 = 0x7FFFFFFF;
  private clipY1: i32 = 0x7FFFFFFF;

  constructor(theme: Theme = DEFAULT_THEME, capacity: i32 = MAX_RECORDS) {
    this.theme = theme;
    this.buf = RecordBuffer.create(capacity > 0 ? capacity : MAX_RECORDS);
  }

  /** Records emitted this frame — read from the buffer, not tracked beside it. */
  get count(): i32 {
    return this.buf.count;
  }

  /** Records the clip refused because the budget was full. */
  get dropped(): i32 {
    return this.buf.dropped;
  }

  /** Whether the budget is exhausted — a caller can stop walking early. */
  get full(): bool {
    return this.buf.full();
  }

  /**
   * Restrict every subsequent draw to this rectangle.
   *
   * Replaced, not intersected: a caller that wants nesting composes the
   * intersection itself, which is one `max`/`min` per edge and reads better than
   * a stack nobody pops.
   */
  setClip(x: i32, y: i32, w: i32, h: i32): void {
    this.clipX0 = x;
    this.clipY0 = y;
    this.clipX1 = x + (w > 0 ? w : 0);
    this.clipY1 = y + (h > 0 ? h : 0);
  }

  /** Remove the clip; the next draw is bounded only by the canvas. */
  clearClip(): void {
    this.clipX0 = -0x7FFFFFFF;
    this.clipY0 = -0x7FFFFFFF;
    this.clipX1 = 0x7FFFFFFF;
    this.clipY1 = 0x7FFFFFFF;
  }

  reset(): void {
    this.buf.reset();
    this.order = 0;
  }

  /**
   * One sprite, with no clipping.
   *
   * `cell` is an atlas cell index; the theme turns it into pixels. Used for the
   * chrome (a stretched 1x1 becomes a panel, a divider, a button box).
   */
  sprite(x: i32, y: i32, w: i32, h: i32, cell: i32): void {
    // A zero- or negative-sized quad is not a draw; skipping it keeps the record
    // count honest. The budget needs no check here: `push` refuses and counts a
    // refusal itself, so there is one place that decides what "full" means and
    // one place that reports it.
    if (w <= 0 || h <= 0) return;

    const cellX: i32 = (cell % this.theme.gridCols) * this.theme.cellW;
    const cellY: i32 = (cell / this.theme.gridCols) * this.theme.cellH;

    this.buf.push(x, y, <u16>cellX, <u16>cellY, <u16>w, <u16>h, 0, this.order++, 0, 0);
  }

  /**
   * A filled rectangle, **tiled** from cells.
   *
   * A sprite cannot be stretched (`theme.ts`), so a rectangle is
   * `ceil(w/cellW) * ceil(h/cellH)` sprites. That makes the cost explicit, which
   * is the point: `tileCost` lets a caller decide before it draws, and the
   * 4096-record budget is spent where it shows.
   */
  fill(x: i32, y: i32, w: i32, h: i32, cell: i32): void {
    if (w <= 0 || h <= 0) return;
    const cw: i32 = this.theme.cellW;
    const ch: i32 = this.theme.cellH;
    const yEnd: i32 = y + h < this.clipY1 ? y + h : this.clipY1;
    const xEnd: i32 = x + w < this.clipX1 ? x + w : this.clipX1;
    for (let ty: i32 = y; ty < yEnd; ty += ch) {
      const th: i32 = yEnd - ty < ch ? yEnd - ty : ch;
      for (let tx: i32 = x; tx < xEnd; tx += cw) {
        const tw: i32 = xEnd - tx < cw ? xEnd - tx : cw;
        this.sprite(tx, ty, tw, th, cell);
      }
    }
  }

  /**
   * A one-pixel horizontal rule, tiled in cell-width steps.
   *
   * A rule is the cheapest way to divide two regions when no rectangle can be
   * filled: 1280 pixels is 160 records rather than the 7,200 a background costs.
   */
  hline(x: i32, y: i32, w: i32, cell: i32): void {
    if (w <= 0 || y < this.clipY0 || y >= this.clipY1) return;
    let x0: i32 = x < this.clipX0 ? this.clipX0 : x;
    const x1: i32 = x + w < this.clipX1 ? x + w : this.clipX1;
    const cw: i32 = this.theme.cellW;
    for (let tx: i32 = x0; tx < x1; tx += cw) {
      const tw: i32 = x1 - tx < cw ? x1 - tx : cw;
      this.sprite(tx, y, tw, 1, cell);
    }
  }

  /** A one-pixel vertical rule, tiled in cell-height steps. */
  vline(x: i32, y: i32, h: i32, cell: i32): void {
    if (h <= 0 || x < this.clipX0 || x >= this.clipX1) return;
    const y0: i32 = y < this.clipY0 ? this.clipY0 : y;
    const y1: i32 = y + h < this.clipY1 ? y + h : this.clipY1;
    const ch: i32 = this.theme.cellH;
    for (let ty: i32 = y0; ty < y1; ty += ch) {
      const th: i32 = y1 - ty < ch ? y1 - ty : ch;
      this.sprite(x, ty, 1, th, cell);
    }
  }

  /**
   * One character, clipped in both axes.
   *
   * The clip is applied by trimming the source rectangle, which works because at
   * this size source and destination are the same pixels — the reason there is
   * no scale parameter. A glyph entirely outside emits nothing, so a scrolled
   * page costs only its visible lines.
   */
  glyph(code: i32, x: i32, y: i32, colour: i32, weight: i32,
        clipTop: i32, clipBottom: i32): void {
    const theme = this.theme;
    if (code < theme.firstChar || code > theme.lastChar) return;

    // The effective vertical band: the per-call suggestion and the painter's own
    // clip, whichever is narrower.
    let bandTop: i32 = clipTop > this.clipY0 ? clipTop : this.clipY0;
    let bandBottom: i32 = clipBottom < this.clipY1 ? clipBottom : this.clipY1;
    if (bandTop < this.clipY0) bandTop = this.clipY0;
    if (bandBottom > this.clipY1) bandBottom = this.clipY1;

    // Horizontal: whole-cell skip, then a trim at each edge.
    let destX: i32 = x;
    let srcLeft: i32 = 0;
    let destW: i32 = theme.cellW;
    if (destX < this.clipX0) {
      const cut: i32 = this.clipX0 - destX;
      if (cut >= destW) return;
      destX += cut;
      srcLeft = cut;
      destW -= cut;
    }
    const xLimit: i32 = this.clipX1 < x + theme.cellW ? this.clipX1 : x + theme.cellW;
    if (destX + destW > xLimit) destW = xLimit - destX;
    if (destW <= 0) return;

    // Vertical: the same trim, from the caller's band.
    let destY: i32 = y;
    let srcTop: i32 = 0;
    let destH: i32 = theme.cellH;
    if (destY < bandTop) {
      const cut: i32 = bandTop - destY;
      if (cut >= destH) return;
      destY += cut;
      srcTop = cut;
      destH -= cut;
    }
    if (destY + destH > bandBottom) destH = bandBottom - destY;
    if (destH <= 0) return;

    const cell: i32 = colour * theme.colourStride + weight * theme.stripe +
                      (code - theme.firstChar);
    const cellX: i32 = (cell % theme.gridCols) * theme.cellW + srcLeft;
    const cellY: i32 = (cell / theme.gridCols) * theme.cellH + srcTop;

    this.buf.push(destX, destY, <u16>cellX, <u16>cellY, <u16>destW, <u16>destH, 0,
                  this.order++, 0, 0);
  }

  /**
   * Draw `len` bytes at `ptr`, starting at `x`, on top-left coordinates.
   *
   * `advance` is the per-character step in pixels: `theme.cellW` for body text,
   * more for a heading that wants air. It does not change the glyph's size —
   * nothing can.
   *
   * Returns the x position after the last character, so a caller can append.
   */
  text(ptr: usize, len: i32, x: i32, y: i32, colour: i32, weight: i32,
       advance: i32, clipTop: i32, clipBottom: i32): i32 {
    let cursor: i32 = x;
    for (let i: i32 = 0; i < len; i++) {
      const code: i32 = load<u8>(ptr + <usize>i);
      // **This function never breaks a line.** `flow.ts` decides where every line
      // starts and how far it runs; a painter that also honoured `\n` would break
      // a line the layout had already placed, which is exactly what produced
      // orphaned words 20 pixels low when a paragraph's source newlines reached
      // here. A control byte is therefore a space, and a tab is four of them.
      if (code == 9) { cursor += advance * 4; continue; }
      if (code < 32) { cursor += advance; continue; }
      this.glyph(code, cursor, y, colour, weight, clipTop, clipBottom);
      cursor += advance;
    }
    return cursor;
  }

  /** `text` for a byte array, which is what a caller usually has. */
  textBytes(chars: Uint8Array, start: i32, len: i32, x: i32, y: i32, colour: i32,
            weight: i32, advance: i32, clipTop: i32, clipBottom: i32): i32 {
    let cursor: i32 = x;
    const end: i32 = start + len;
    for (let i: i32 = start; i < end; i++) {
      const code: i32 = chars[i];
      if (code == 9) { cursor += advance * 4; continue; }
      if (code < 32) { cursor += advance; continue; }
      this.glyph(code, cursor, y, colour, weight, clipTop, clipBottom);
      cursor += advance;
    }
    return cursor;
  }

  /** Draw one character at a position; used for a caret and for single glyphs. */
  char(code: i32, x: i32, y: i32, colour: i32, weight: i32,
       clipTop: i32, clipBottom: i32): void {
    this.glyph(code, x, y, colour, weight, clipTop, clipBottom);
  }

  /** Hand the frame to the canvas. `bucket` is the 2D renderer's z bucket. */
  submit(canvas: Canvas, pipe: i32, bucket: i32 = 0): i32 {
    if (this.buf.count == 0) return 0;
    return canvas.submit(pipe, this.buf, bucket);
  }
}
