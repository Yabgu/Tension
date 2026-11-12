// Sprite records in, from a byte span of ASCII: the whole of "drawing text".
//
// ## Why this is not a font library
//
// There is no text verb in the 2D renderer. A character on screen is one sprite
// sampling one cell of an atlas, and that is the whole mechanism — so this file
// is an index computation with a clip, not a layout system. `flow.ts` owns where
// lines go; this owns which pixels each glyph occupies.
//
// ## Two text paths, one trim
//
// A `Theme` describes a fixed-cell atlas: every glyph advances the same number
// of pixels, so the cursor is one addition. A `FontPage` (fonts.ts) describes a
// proportional one: every glyph has its own advance, and the cursor accumulates
// **quarter-pixels** so that rounding to the pixel grid happens once per glyph on
// the accumulated position rather than once per advance. Both paths end in
// `emitGlyph`, which is the only place that knows how to trim a glyph at a clip
// edge — because source and destination are the same pixels, and a trim in one
// axis must move the other in lockstep.
//
// ## Why text is bytes
//
// Rendering allocates nothing: a frame draws thousands of glyphs and none of them
// creates an object. A caller with a `String` encodes it once into a buffer it
// owns (`Bytes`), not once per frame per string — `String.UTF8.encode` returns a
// fresh `ArrayBuffer`, which is exactly the per-frame allocation the retained UI
// exists to remove.
//
// ## The clip stack
//
// `setClip` replaces, which is right for a caller drawing panels in a loop. A
// widget tree nests, so `pushClip`/`popClip` intersect with what is already in
// force, over a fixed stack of eight — deep enough for any sane tree, and an
// array that never grows means a clip cannot allocate mid-frame.

import { Canvas } from "../2d/canvas";
import { RecordBuffer } from "../2d/buffers";
import { FontPage } from "./fonts";
import { Hits } from "./hit";
import { DEFAULT_THEME, MAX_RECORDS, Theme } from "./theme";

/**
 * How deep the clip stack goes.
 *
 * A widget tree is shallow by construction (a pane inside a row inside a
 * window), and a fixed depth is what keeps `pushClip` from allocating anywhere.
 * Past it, `pushClip` still intersects — it just cannot be undone, which is a
 * visible bug in a debug build rather than a silent one.
 */
export const CLIP_DEPTH: i32 = 8;

/**
 * A frame's worth of sprite records, and the rules for filling them.
 *
 * One instance, reused: `reset()` at the top of each frame, `submit()` at the
 * bottom. The buffer is allocated once, so a frame's cost is the records emitted
 * and nothing else.
 */
export class Painter {
  private buf: RecordBuffer;
  private order: u32 = 0;
  /** The atlas this painter draws from when no page is named. */
  theme: Theme;

  // --- the clip, in destination pixels -------------------------------------
  private clipX0: i32 = -0x7FFFFFFF;
  private clipY0: i32 = -0x7FFFFFFF;
  private clipX1: i32 = 0x7FFFFFFF;
  private clipY1: i32 = 0x7FFFFFFF;

  // --- the clip stack ------------------------------------------------------
  private clipDepth: i32 = 0;
  private stackX0: i32[] = new Array<i32>(CLIP_DEPTH);
  private stackY0: i32[] = new Array<i32>(CLIP_DEPTH);
  private stackX1: i32[] = new Array<i32>(CLIP_DEPTH);
  private stackY1: i32[] = new Array<i32>(CLIP_DEPTH);

  /**
   * Where `addHit` records targets, or null when nothing is listening.
   *
   * Held by the painter rather than passed to every draw verb because the point of
   * `addHit` is that the record and the target come from one call: a verb that took
   * a list would be a second argument the caller could mismatch.
   */
  private hitList: Hits | null = null;

  constructor(theme: Theme = DEFAULT_THEME, capacity: i32 = MAX_RECORDS) {
    this.theme = theme;
    this.buf = RecordBuffer.create(capacity > 0 ? capacity : MAX_RECORDS);
  }

  // ── hits ────────────────────────────────────────────────────────────────

  /** Direct `addHit` at `list` until `useHits(null)`. */
  useHits(list: Hits | null): void {
    this.hitList = list;
  }

  /** The list currently receiving targets, for a caller that wants to read it back. */
  hits(): Hits | null {
    return this.hitList;
  }

  /**
   * Record a click target for a rectangle **this painter would draw**.
   *
   * The clip gate is the whole point. `widget.ts`'s `listItem` recorded its target
   * unconditionally — including for a row scrolled out of the pane — so a click in
   * the empty space where a hidden row used to be selected it. Here the target is
   * the **intersection** of the rectangle with the clip, which is exactly what got
   * drawn: a half-scrolled row is clickable in its visible half and nowhere else,
   * and a row entirely outside records nothing at all.
   *
   * The clipping happens whatever the geometry: no clip is in force at frame start,
   * so an unclipped caller behaves as before.
   */
  addHit(x: i32, y: i32, w: i32, h: i32, id: i32, tag: i32 = -1): bool {
    const list: Hits | null = this.hitList;
    if (list == null) return false;
    if (w <= 0 || h <= 0) return false;

    const x0: i32 = x > this.clipX0 ? x : this.clipX0;
    const y0: i32 = y > this.clipY0 ? y : this.clipY0;
    const x1: i32 = x + w < this.clipX1 ? x + w : this.clipX1;
    const y1: i32 = y + h < this.clipY1 ? y + h : this.clipY1;
    if (x1 <= x0 || y1 <= y0) return false;

    return list.add(x0, y0, x1 - x0, y1 - y0, id, tag);
  }

  /** The clip in force, for a caller that needs to reason about it. */
  clipLeft(): i32 {
    return this.clipX0;
  }

  clipTop(): i32 {
    return this.clipY0;
  }

  clipRight(): i32 {
    return this.clipX1;
  }

  clipBottom(): i32 {
    return this.clipY1;
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

  // ── the clip ────────────────────────────────────────────────────────────

  /**
   * Restrict every subsequent draw to this rectangle, replacing any clip.
   *
   * Replaced, not intersected: a caller drawing panels in a loop wants "this
   * panel and no other", and nesting is `pushClip`'s job. Using `setClip` also
   * abandons an open push/pop nest, because a replace and a stack cannot both
   * be true — silently keeping stale saved rectangles would restore a clip that
   * the caller already replaced.
   */
  setClip(x: i32, y: i32, w: i32, h: i32): void {
    this.clipDepth = 0;
    this.clipX0 = x;
    this.clipY0 = y;
    this.clipX1 = x + (w > 0 ? w : 0);
    this.clipY1 = y + (h > 0 ? h : 0);
  }

  /**
   * Intersect the clip with a rectangle, remembering what it was.
   *
   * The intersection is what a nested container needs: a scrolled list inside a
   * pane must be clipped by *both*, and neither rectangle alone is the answer.
   * A zero or negative size produces an empty clip rather than an inverted one,
   * so nothing inside a collapsed container can draw.
   */
  pushClip(x: i32, y: i32, w: i32, h: i32): void {
    if (this.clipDepth < CLIP_DEPTH) {
      const at: i32 = this.clipDepth;
      this.stackX0[at] = this.clipX0;
      this.stackY0[at] = this.clipY0;
      this.stackX1[at] = this.clipX1;
      this.stackY1[at] = this.clipY1;
      this.clipDepth++;
    }
    // Past the depth limit the intersection still applies; it simply cannot be
    // popped back. Bounded memory beats unbounded correctness here.
    const x1: i32 = x + (w > 0 ? w : 0);
    const y1: i32 = y + (h > 0 ? h : 0);
    if (x > this.clipX0) this.clipX0 = x;
    if (y > this.clipY0) this.clipY0 = y;
    if (x1 < this.clipX1) this.clipX1 = x1;
    if (y1 < this.clipY1) this.clipY1 = y1;
  }

  /** Restore the clip `pushClip` replaced. A pop with nothing pushed is a no-op. */
  popClip(): void {
    if (this.clipDepth <= 0) return;
    this.clipDepth--;
    const at: i32 = this.clipDepth;
    this.clipX0 = this.stackX0[at];
    this.clipY0 = this.stackY0[at];
    this.clipX1 = this.stackX1[at];
    this.clipY1 = this.stackY1[at];
  }

  /** How many clips are currently stacked. */
  get clips(): i32 {
    return this.clipDepth;
  }

  /** Remove the clip; the next draw is bounded only by the canvas. */
  clearClip(): void {
    this.clipDepth = 0;
    this.clipX0 = -0x7FFFFFFF;
    this.clipY0 = -0x7FFFFFFF;
    this.clipX1 = 0x7FFFFFFF;
    this.clipY1 = 0x7FFFFFFF;
  }

  reset(): void {
    this.buf.reset();
    this.order = 0;
    this.clearClip();
  }

  // ── chrome ──────────────────────────────────────────────────────────────

  /**
   * One sprite, with no clipping.
   *
   * `cell` is an atlas cell index; `atlas` turns it into pixels and names the
   * texture page the record samples. Used for the chrome (a 1x1 becomes a panel,
   * a divider, a button box).
   */
  sprite(x: i32, y: i32, w: i32, h: i32, cell: i32, atlas: Theme = this.theme): void {
    // A zero- or negative-sized quad is not a draw; skipping it keeps the record
    // count honest. The budget needs no check here: `push` refuses and counts a
    // refusal itself, so there is one place that decides what "full" means and
    // one place that reports it.
    if (w <= 0 || h <= 0) return;

    const cellX: i32 = (cell % atlas.gridCols) * atlas.cellW;
    const cellY: i32 = (cell / atlas.gridCols) * atlas.cellH;

    this.buf.push(x, y, <u16>cellX, <u16>cellY, <u16>w, <u16>h, <u16>atlas.slot,
                  this.order++, 0, 0);
  }

  /**
   * A filled rectangle, **tiled** from cells.
   *
   * A sprite cannot be stretched (`theme.ts`), so a rectangle is
   * `ceil(w/cellW) * ceil(h/cellH)` sprites. That makes the cost explicit, which
   * is the point: `tileCost` lets a caller decide before it draws, and the
   * 4096-record budget is spent where it shows.
   *
   * **Clamped on all four edges.** The clip used to bound only the far side,
   * which meant a fill that started above the clip still emitted — and drew —
   * the rows outside it, so a nested container leaked over its parent. Starting
   * the tiling at the clip's own edge is what makes `pushClip` mean anything for
   * the one draw that covers area.
   */
  fill(x: i32, y: i32, w: i32, h: i32, cell: i32, atlas: Theme = this.theme): void {
    if (w <= 0 || h <= 0) return;
    const x0: i32 = x > this.clipX0 ? x : this.clipX0;
    const y0: i32 = y > this.clipY0 ? y : this.clipY0;
    const xEnd: i32 = x + w < this.clipX1 ? x + w : this.clipX1;
    const yEnd: i32 = y + h < this.clipY1 ? y + h : this.clipY1;
    if (xEnd <= x0 || yEnd <= y0) return;

    const cw: i32 = atlas.cellW;
    const ch: i32 = atlas.cellH;
    for (let ty: i32 = y0; ty < yEnd; ty += ch) {
      const th: i32 = yEnd - ty < ch ? yEnd - ty : ch;
      for (let tx: i32 = x0; tx < xEnd; tx += cw) {
        const tw: i32 = xEnd - tx < cw ? xEnd - tx : cw;
        this.sprite(tx, ty, tw, th, cell, atlas);
      }
    }
  }

  /**
   * A one-pixel horizontal rule, tiled in cell-width steps.
   *
   * A rule is the cheapest way to divide two regions when no rectangle can be
   * filled: 1280 pixels is 160 records rather than the 7,200 a background costs.
   */
  hline(x: i32, y: i32, w: i32, cell: i32, atlas: Theme = this.theme): void {
    if (w <= 0 || y < this.clipY0 || y >= this.clipY1) return;
    const x0: i32 = x < this.clipX0 ? this.clipX0 : x;
    const x1: i32 = x + w < this.clipX1 ? x + w : this.clipX1;
    const cw: i32 = atlas.cellW;
    for (let tx: i32 = x0; tx < x1; tx += cw) {
      const tw: i32 = x1 - tx < cw ? x1 - tx : cw;
      this.sprite(tx, y, tw, 1, cell, atlas);
    }
  }

  /** A one-pixel vertical rule, tiled in cell-height steps. */
  vline(x: i32, y: i32, h: i32, cell: i32, atlas: Theme = this.theme): void {
    if (h <= 0 || x < this.clipX0 || x >= this.clipX1) return;
    const y0: i32 = y < this.clipY0 ? this.clipY0 : y;
    const y1: i32 = y + h < this.clipY1 ? y + h : this.clipY1;
    const ch: i32 = atlas.cellH;
    for (let ty: i32 = y0; ty < y1; ty += ch) {
      const th: i32 = y1 - ty < ch ? y1 - ty : ch;
      this.sprite(x, ty, 1, th, cell, atlas);
    }
  }

  // ── glyphs ──────────────────────────────────────────────────────────────

  /**
   * The one place a glyph becomes a record, for both text paths.
   *
   * The clip is applied by trimming the **source** rectangle, which works because
   * at this size source and destination are the same pixels — the reason there is
   * no scale parameter. A glyph entirely outside emits nothing, so a scrolled
   * page costs only its visible lines. `cell` of -1 is "this atlas does not carry
   * that glyph", which draws nothing rather than sampling a neighbour.
   */
  private emitGlyph(cell: i32, atlas: Theme, x: i32, y: i32,
                    clipTop: i32, clipBottom: i32): void {
    if (cell < 0) return;

    // The effective vertical band: the per-call suggestion and the painter's own
    // clip, whichever is narrower.
    let bandTop: i32 = clipTop > this.clipY0 ? clipTop : this.clipY0;
    let bandBottom: i32 = clipBottom < this.clipY1 ? clipBottom : this.clipY1;
    if (bandTop < this.clipY0) bandTop = this.clipY0;
    if (bandBottom > this.clipY1) bandBottom = this.clipY1;

    // Horizontal: whole-cell skip, then a trim at each edge.
    let destX: i32 = x;
    let srcLeft: i32 = 0;
    let destW: i32 = atlas.cellW;
    if (destX < this.clipX0) {
      const cut: i32 = this.clipX0 - destX;
      if (cut >= destW) return;
      destX += cut;
      srcLeft = cut;
      destW -= cut;
    }
    const xLimit: i32 = this.clipX1 < x + atlas.cellW ? this.clipX1 : x + atlas.cellW;
    if (destX + destW > xLimit) destW = xLimit - destX;
    if (destW <= 0) return;

    // Vertical: the same trim, from the caller's band.
    let destY: i32 = y;
    let srcTop: i32 = 0;
    let destH: i32 = atlas.cellH;
    if (destY < bandTop) {
      const cut: i32 = bandTop - destY;
      if (cut >= destH) return;
      destY += cut;
      srcTop = cut;
      destH -= cut;
    }
    if (destY + destH > bandBottom) destH = bandBottom - destY;
    if (destH <= 0) return;

    const cellX: i32 = (cell % atlas.gridCols) * atlas.cellW + srcLeft;
    const cellY: i32 = (cell / atlas.gridCols) * atlas.cellH + srcTop;

    this.buf.push(destX, destY, <u16>cellX, <u16>cellY, <u16>destW, <u16>destH,
                  <u16>atlas.slot, this.order++, 0, 0);
  }

  /** The cell a (code, colour, weight) occupies in a fixed-cell theme, or -1. */
  private cellOfTheme(code: i32, colour: i32, weight: i32): i32 {
    const theme = this.theme;
    if (code < theme.firstChar || code > theme.lastChar) return -1;
    return colour * theme.colourStride + weight * theme.stripe + (code - theme.firstChar);
  }

  /**
   * One character from the default atlas, clipped in both axes.
   *
   * Kept for callers of a fixed-cell theme; proportional text uses `glyphIn`.
   */
  glyph(code: i32, x: i32, y: i32, colour: i32, weight: i32,
        clipTop: i32, clipBottom: i32): void {
    this.emitGlyph(this.cellOfTheme(code, colour, weight), this.theme, x, y,
                   clipTop, clipBottom);
  }

  /** One character from a baked page; the proportional twin of `glyph`. */
  glyphIn(page: FontPage, code: i32, x: i32, y: i32, colour: i32, weight: i32,
          clipTop: i32, clipBottom: i32): void {
    this.emitGlyph(page.cellOf(colour, weight, code), page, x, y, clipTop, clipBottom);
  }

  /**
   * Draw `len` bytes at `ptr`, starting at `x`, on top-left coordinates.
   *
   * With no page, `advance` is the per-character step in pixels and the theme is
   * the fixed-cell atlas. With a page, `advance` is **ignored** and each glyph's
   * own advance is used, accumulated in quarter-pixels so that the position is
   * rounded once per glyph and never drifts (see `fonts.ts`).
   *
   * Returns the x position after the last character, so a caller can append.
   */
  text(ptr: usize, len: i32, x: i32, y: i32, colour: i32, weight: i32,
       advance: i32, clipTop: i32, clipBottom: i32, page: FontPage | null = null): i32 {
    if (page != null) {
      const spaceQ: i32 = page.advanceQ(weight, 32);
      let cursorQ: i32 = 0;
      for (let i: i32 = 0; i < len; i++) {
        const code: i32 = load<u8>(ptr + <usize>i);
        // This function never breaks a line: `flow.ts` decides where every line
        // starts and how far it runs. A control byte advances like a space, and
        // a tab is four of them.
        if (code == 9) { cursorQ += spaceQ * 4; continue; }
        if (code < 32) { cursorQ += spaceQ; continue; }
        this.emitGlyph(page.cellOf(colour, weight, code), page, x + ((cursorQ + 2) / 4), y,
                       clipTop, clipBottom);
        cursorQ += page.advanceQ(weight, code);
      }
      return x + ((cursorQ + 3) / 4);
    }

    let cursor: i32 = x;
    for (let i: i32 = 0; i < len; i++) {
      const code: i32 = load<u8>(ptr + <usize>i);
      if (code == 9) { cursor += advance * 4; continue; }
      if (code < 32) { cursor += advance; continue; }
      this.glyph(code, cursor, y, colour, weight, clipTop, clipBottom);
      cursor += advance;
    }
    return cursor;
  }

  /** `text` for a byte array, which is what a caller usually has. */
  textBytes(chars: Uint8Array, start: i32, len: i32, x: i32, y: i32, colour: i32,
            weight: i32, advance: i32, clipTop: i32, clipBottom: i32,
            page: FontPage | null = null): i32 {
    if (page != null) {
      const spaceQ: i32 = page.advanceQ(weight, 32);
      let cursorQ: i32 = 0;
      const end: i32 = start + len;
      for (let i: i32 = start; i < end; i++) {
        const code: i32 = chars[i];
        if (code == 9) { cursorQ += spaceQ * 4; continue; }
        if (code < 32) { cursorQ += spaceQ; continue; }
        this.emitGlyph(page.cellOf(colour, weight, code), page, x + ((cursorQ + 2) / 4), y,
                       clipTop, clipBottom);
        cursorQ += page.advanceQ(weight, code);
      }
      return x + ((cursorQ + 3) / 4);
    }

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
       clipTop: i32, clipBottom: i32, page: FontPage | null = null): void {
    if (page != null) {
      this.glyphIn(page, code, x, y, colour, weight, clipTop, clipBottom);
      return;
    }
    this.glyph(code, x, y, colour, weight, clipTop, clipBottom);
  }

  /** Hand the frame to the canvas. `bucket` is the 2D renderer's z bucket. */
  submit(canvas: Canvas, pipe: i32, bucket: i32 = 0): i32 {
    if (this.buf.count == 0) return 0;
    return canvas.submit(pipe, this.buf, bucket);
  }
}
