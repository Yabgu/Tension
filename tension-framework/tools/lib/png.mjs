// A minimal RGBA8 PNG encoder, for build-time previews.
//
// The repository has no image dependency and this is not worth adding one for:
// PNG's uncompressed-of-a-filtered-scanline form is a header, a zlib stream and
// a CRC per chunk. `zlib` is in Node already.
//
// **This is not the shipping path.** The 2D renderer decodes IWI, not PNG
// (`tension-core/src/render2d/iwi.rs` is explicit that PNG is `-ENOSYS`). The
// only reason this exists is so a human — or a reviewer looking at a rendered
// file — can *see* the font at build time instead of trusting 95 strings that
// each claim to be 16 rows.

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The CRC table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encode RGBA8 pixels as a PNG.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgba `width * height * 4` bytes, top-left origin
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  // Every scanline is prefixed with a filter byte. Filter 0 (None) keeps this
  // simple; the previews are small and compress well enough without prediction.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Scale an RGBA raster by an integer factor, with no interpolation.
 *
 * Nearest-neighbour is the point: it is what the 2D renderer's sampler does, so
 * an integer-scaled preview shows exactly what a reader will see.
 */
export function scaleNearest(width, height, rgba, factor) {
  const outW = width * factor;
  const outH = height * factor;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor(x / factor);
      const from = (sy * width + sx) * 4;
      const to = (y * outW + x) * 4;
      out[to] = rgba[from];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from + 2];
      out[to + 3] = rgba[from + 3];
    }
  }
  return { width: outW, height: outH, pixels: out };
}
