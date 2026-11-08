// tension-framework/assembly/2d/tileset.ts — tileset pixels to record fields.
//
// A tileset is a *sheet* that arrived as several pages. The adapter binds a
// pipeline's pages to a texture array; a record says which page to sample
// (`tex`) and where on it (`srcX`,`srcY`). Turning a tile coordinate into those
// three numbers is arithmetic the game should not do twice, and getting it wrong
// is invisible — a record that samples the wrong page draws a plausible wrong
// tile.
//
// Pages are laid out **in one row** of the sheet: page *i* covers sheet x in
// [i*pageWidth, (i+1)*pageWidth). That is how a sheet is normally paged, and it
// is what makes `frameForPixel(1872, 144)` able to name page 1 of a 1024-wide
// paging without being told which page the lantern is on.
//
// One tileset is one page size. A game with a 256×256 page and a 512×512 page
// needs two pipelines and two tilesets — an array texture has exactly one size,
// and pretending otherwise here would move pixels inside src rects.

import { Frame } from "./types";
// The one verb this module calls, from the SDK's single declaration site.
// Binding is not the guest's business to repeat per example: a tileset knows
// its pages, so it knows the slots.
import { setTextureRaw } from "./verbs";

export class Tileset {
  private pages: i32[];
  private pageWidth: u32;
  private pageHeight: u32;
  private tileSize: u32;
  /** Pages per sheet row. One row, so this is the page count. */
  private columns: u32;
  /** Named frames, for `Composite.addLayer`. */
  private named: Map<string, Frame>;
  /** False for a degenerate geometry; every lookup then returns an invalid frame. */
  private usable: bool;

  private constructor(pages: i32[], pageWidth: u32, pageHeight: u32, tileSize: u32) {
    this.pages = pages;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.tileSize = tileSize;
    this.columns = <u32>max<i32>(1, pages.length);
    this.named = new Map<string, Frame>();
    this.usable = pageWidth > 0 && pageHeight > 0 && tileSize > 0 && pages.length > 0;
  }

  /**
   * `pages` are texture ids, in slot order — page 0 binds to slot 0, and a
   * frame's `tex` is that slot number.
   *
   * A degenerate geometry yields an unusable tileset rather than a null: every
   * division here is by a caller's number, and a caller that passes zero should
   * get an empty scene and a `isValid()` they can check, not a crash in a frame.
   */
  static load(pages: i32[], pageWidth: u32, pageHeight: u32, tileSize: u32): Tileset {
    return new Tileset(pages, pageWidth, pageHeight, tileSize);
  }

  /** Whether the geometry made sense. Check once, after `load`. */
  isValid(): bool {
    return this.usable;
  }

  /** The texture id bound to a page's slot, for diagnostics. */
  textureAt(page: u32): i32 {
    return page < <u32>this.pages.length ? this.pages[<i32>page] : -1;
  }

  /**
   * The page a sheet coordinate lands on, or -1 when it is outside the sheet.
   * A coordinate past the last page is a caller's bug; answering with the last
   * page would draw the wrong art silently.
   */
  pageFor(px: u32, py: u32): i32 {
    const col = px / this.pageWidth;
    const row = py / this.pageHeight;
    if (row != 0) return -1;            // one row of pages
    if (col >= this.columns) return -1;
    return <i32>col;
  }

  /**
   * A frame at a sheet pixel coordinate. `w`/`h` default to one tile; pass them
   * for art that spans cells (a 32×64 tree on a 16 px grid).
   *
   * This is the hand-picked-tile path: the isometric example names the lantern
   * by the coordinate it was found at, not by a tile index.
   */
  frameForPixel(px: u32, py: u32, w: u32 = 0, h: u32 = 0): Frame {
    if (!this.usable) return Frame.invalid();
    const page = this.pageFor(px, py);
    if (page < 0) return Frame.invalid();
    const localX = px - <u32>page * this.pageWidth;
    const localY = py;                  // one row of pages, so py is local already
    const fw = w == 0 ? this.tileSize : w;
    const fh = h == 0 ? this.tileSize : h;
    if (localX + fw > this.pageWidth || localY + fh > this.pageHeight) return Frame.invalid();
    // `tex` is the *slot*, not the texture id: the shader indexes a texture
    // array. Pages are loaded in slot order, so page index is slot index.
    return new Frame(<u16>page, <u16>localX, <u16>localY, <u16>fw, <u16>fh);
  }

  /**
   * A frame at a tile coordinate on the sheet, `cellsW × cellsH` cells large.
   * `frame(0, 0)` is the sheet's first cell on page 0; a tile past the end of
   * page 0 is on page 1, by the same division `frameForPixel` does.
   */
  frame(tileX: u32, tileY: u32, cellsW: u32 = 1, cellsH: u32 = 1): Frame {
    const w = cellsW * this.tileSize;
    const h = cellsH * this.tileSize;
    return this.frameForPixel(tileX * this.tileSize, tileY * this.tileSize, w, h);
  }

  /**
   * Whether a frame samples a slot this tileset actually binds. A frame from a
   * different tileset would name a slot the pipeline may not have, which the
   * adapter refuses at submit time with an errno and no record name.
   */
  owns(frame: Frame): bool {
    return <i32>frame.tex < this.pages.length;
  }

  /** Give a frame a name, so a composite can name a layer instead of a rect. */
  define(name: string, frame: Frame): void {
    this.named.set(name, frame);
  }

  frameNamed(name: string): Frame {
    return this.named.has(name) ? this.named.get(name) : Frame.invalid();
  }

  hasFrame(name: string): bool {
    return this.named.has(name);
  }

  /**
   * Bind every page to its slot on one pipeline. Returns 0, or the first errno
   * the adapter gave (the adapter's errno, not a re-invented one).
   */
  bind(handle: i32, pipeId: i32, firstSlot: i32 = 0): i32 {
    for (let i: i32 = 0; i < this.pages.length; i++) {
      const slot = firstSlot + i;
      const rc = setTextureRaw(handle, pipeId, slot, this.pages[i]);
      if (rc != 0) return rc;
    }
    return 0;
  }
}
