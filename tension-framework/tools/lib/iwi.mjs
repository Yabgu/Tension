// The IWI writer: the one container the 2D renderer's decoder accepts.
//
// The format authority is ImageViewer's `src/format/IwiFile.h`. Node cannot
// call that C ABI without a native addon, so this file mirrors the layout —
// but the *reader* side does call it (`tension-core/src/render2d/iwi.rs`), which
// means the framework/example tests are a cross-check of this writer against
// the authoritative parser rather than two copies agreeing with each other.
//
// The header on disk (`IwiFile.h`):
//
//    0   4  magic "IWI1"          16  4  storage flags (0 = interleaved)
//    4   4  width                20  4  row stride (0 = tightly packed)
//    8   4  height               24  8  payload encoding (zero = raw)
//   12   4  metaBytes            32  1  colorSpace (0 = sRGB)
//                               33  1  reserved
//                               34  2  componentCount
//                               36  *  N x 6-byte component records
//
// A component record is `{semantic u8, class u8, bitOffset u16, bitWidth u16}`.
// Pixels follow the table (and any metadata), tightly packed and interleaved.
//
// **Four components, not three.** The starter's sprite sheet is opaque RGB. A
// font is not: a glyph pixel is either ink or nothing, and the panel behind it
// has to show through the nothing. The decoder expands 3-component input to
// RGBA8 with alpha 255, which is exactly the wrong answer here, so the alpha has
// to survive the file.

/** `IWI_FILE_BASE_HEADER_BYTES`: the fixed prefix and the component-table offset. */
export const IWI_BASE_HEADER_BYTES = 36;
/** `IWI_FILE_COMPONENT_BYTES`: one component record's stride. */
export const IWI_COMPONENT_BYTES = 6;

/** Component semantics, from ImageViewer's `IWComponentSemantic`. */
const SEMANTIC = { red: 1, green: 2, blue: 3, alpha: 4 };
/** `IW_COMPONENT_CLASS_UNORM` — an unsigned normalized 8-bit sample. */
const COMPONENT_CLASS_UNORM = 2;

function encodeIwi(width, height, components, pixels) {
  const pixelBytes = width * height * components.length;
  if (pixels.length !== pixelBytes) {
    throw new Error(
      `encodeIwi: expected ${pixelBytes} bytes of ${components.length}-component pixels, ` +
      `got ${pixels.length}`,
    );
  }

  const header = Buffer.alloc(
    IWI_BASE_HEADER_BYTES + components.length * IWI_COMPONENT_BYTES,
  );
  header.write('IWI1', 0, 'ascii');
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  // metaBytes = 0 (12), storage flags = 0 (16), stride = 0 (20),
  // payloadEncoding = zero, i.e. "raw" (24..31).
  header[32] = 0; // colorSpace: sRGB
  header[33] = 0; // reserved
  header.writeUInt16LE(components.length, 34);

  for (let i = 0; i < components.length; i++) {
    const at = IWI_BASE_HEADER_BYTES + i * IWI_COMPONENT_BYTES;
    header[at] = components[i];
    header[at + 1] = COMPONENT_CLASS_UNORM;
    header.writeUInt16LE(i * 8, at + 2);
    header.writeUInt16LE(8, at + 4);
  }

  return Buffer.concat([header, Buffer.from(pixels)]);
}

/**
 * Encode an RGBA8 raster as IWI.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgba  `width * height * 4` bytes, top-left origin
 * @returns {Buffer}
 */
export function encodeIwiRgba(width, height, rgba) {
  return encodeIwi(
    width,
    height,
    [SEMANTIC.red, SEMANTIC.green, SEMANTIC.blue, SEMANTIC.alpha],
    rgba,
  );
}

/**
 * Read the header `IwiFile.h` defines, for a verifier that needs the geometry.
 *
 * Grammar and policy belong to the C implementation; this is only the field
 * walk a build script does before it hands the bytes to the renderer.
 *
 * @param {Buffer|Uint8Array} bytes
 */
export function readIwiHeader(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < IWI_BASE_HEADER_BYTES) {
    throw new Error(`readIwiHeader: ${buf.length} bytes is shorter than the header`);
  }
  if (buf.subarray(0, 4).toString('ascii') !== 'IWI1') {
    throw new Error('readIwiHeader: not an IWI container (magic mismatch)');
  }
  const width = buf.readUInt32LE(4);
  const height = buf.readUInt32LE(8);
  const metaBytes = buf.readUInt32LE(12);
  const componentCount = buf.readUInt16LE(34);
  const pixelOffset = IWI_BASE_HEADER_BYTES + componentCount * IWI_COMPONENT_BYTES + metaBytes;

  let bitsPerPixel = 0;
  for (let i = 0; i < componentCount; i++) {
    bitsPerPixel += buf.readUInt16LE(IWI_BASE_HEADER_BYTES + i * IWI_COMPONENT_BYTES + 4);
  }

  return {
    width,
    height,
    componentCount,
    bitsPerPixel,
    colorSpace: bytes[32],
    metaBytes,
    pixelOffset,
    pixelBytes: Math.ceil((width * height * bitsPerPixel) / 8),
  };
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
