// The IWI writer: the one container the 2D renderer's decoder accepts.
//
// `tension-core/src/render2d/iwi.rs` parses a 74-byte header and interleaved
// 8-bit components. That file's tests build the same header inline; this is the
// build-time writer for the docs UI's atlas, and it replaces the copy that grew
// up in the starter template's `tools/make-atlas.mjs`.
//
// The header is written field by field rather than as a struct because it is a
// *packed* C layout: `componentCount` is a `u16` at offset 13, `bitsPerPixel` a
// `u16` at 15, and each component record at 18+ is `u8, u8, u16, u16` — several
// fields sit on odd offsets. Nothing in Node would align them the way C does,
// and TensionScript's `@abi.align` refuses to lower alignment for the same
// reason (`TS6408`). The byte stores are the honest spelling.
//
// **Four components, not three.** The starter's sprite sheet is opaque RGB. A
// font is not: a glyph pixel is either ink or nothing, and the panel behind it
// has to show through the nothing. The decoder expands 3-component input to
// RGBA8 with alpha 255, which is exactly the wrong answer here, so the alpha has
// to survive the file.

const HEADER_BYTES = 74;

/** Component semantics, from ImageViewer's `ImageColorSemantic`. */
const SEMANTIC = { red: 1, green: 2, blue: 3, alpha: 4 };

/**
 * Encode an RGBA8 raster as IWI.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgba  `width * height * 4` bytes, top-left origin
 * @returns {Buffer}
 */
export function encodeIwiRgba(width, height, rgba) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodeIwi: expected ${expected} bytes of RGBA, got ${rgba.length}`);
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('IWI1', 0, 'ascii');
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header[12] = 0; // colorSpace: sRGB
  header.writeUInt16LE(4, 13); // componentCount
  header.writeUInt16LE(32, 15); // bitsPerPixel
  header[17] = 0; // storageLayout: interleaved

  // Four component descriptors: {semantic u8, class u8, bitOffset u16, bitWidth u16}.
  // Class 2 is UNORM — an unsigned normalized integer, which is what 8-bit
  // colour is.
  const components = [SEMANTIC.red, SEMANTIC.green, SEMANTIC.blue, SEMANTIC.alpha];
  for (let i = 0; i < components.length; i++) {
    const at = 18 + i * 6;
    header[at] = components[i];
    header[at + 1] = 2;
    header.writeUInt16LE(i * 8, at + 2);
    header.writeUInt16LE(8, at + 4);
  }
  // The remaining four slots stay zero: no more components, and a reader that
  // walks `componentCount` never reaches them.
  header.writeBigUInt64LE(BigInt(rgba.length), 66);

  return Buffer.concat([header, Buffer.from(rgba)]);
}

/**
 * A tiny raster surface for building atlas cells.
 *
 * The font baker writes 8x16 cells by the thousand, and every one is opaque in
 * some pixels and transparent in the rest; an explicit `blit` over a `setPixel`
 * is what keeps that loop readable and impossible to get off by one.
 */
export class Surface {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
  }

  /**
   * Fill a rectangle with an RGBA colour.
   *
   * Clipped rather than refused: a chrome cell stretched to the edge of the
   * atlas is a normal write, and a caller that computes one pixel too many
   * should not be a build failure.
   */
  fillRect(x, y, w, h, r, g, b, a = 255) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const at = (py * this.width + px) * 4;
        this.pixels[at] = r;
        this.pixels[at + 1] = g;
        this.pixels[at + 2] = b;
        this.pixels[at + 3] = a;
      }
    }
  }

  /** Copy an 8-bit mask into a rectangle, using `colour` for set bits. */
  blitMask(x, y, w, h, mask, colour, { dilate = 0 } = {}) {
    for (let py = 0; py < h; py++) {
      const row = py * w;
      for (let px = 0; px < w; px++) {
        // A source bit is ink when the byte's bit is set; the mask is one byte
        // per pixel for clarity, not a packed bitmap.
        if (!mask[row + px]) continue;
        // `dilate` replicates the pixel rightward — the bold weight, baked here
        // rather than drawn twice at render time, because every extra draw is a
        // record and 4096 records is a hard per-frame cap.
        //
        // **Clamped to the mask's own width, not the surface.** A wide glyph
        // (m, w, M, W reach column 7) dilated rightward would write column 8 —
        // which is column 0 of the *next* atlas cell, i.e. the left edge of the
        // following character. That is a real corruption and it was there:
        // measured on the previous table, 44 bold cells carried stray pixels in
        // column 0, each one a neighbour's overflow. Bold may thicken a glyph
        // inside its cell and never outside it.
        for (let d = 0; d <= dilate && px + d < w; d++) {
          const tx = x + px + d;
          const ty = y + py;
          if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
          const at = (ty * this.width + tx) * 4;
          this.pixels[at] = colour[0];
          this.pixels[at + 1] = colour[1];
          this.pixels[at + 2] = colour[2];
          this.pixels[at + 3] = colour[3] ?? 255;
        }
      }
    }
  }

  toIwi() {
    return encodeIwiRgba(this.width, this.height, this.pixels);
  }
}
