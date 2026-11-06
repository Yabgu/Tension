// examples/2d/synthetic/png.mjs — a minimal RGBA PNG encoder.
//
// Node has no PNG writer and the repository does not take an image dependency
// for a test fixture, so this is the 60 lines it takes: IHDR, one IDAT of
// filter-0 scanlines, IEND. It writes 8-bit RGBA, which is what both the
// synthetic pages and the frame dumps are.
//
// This is the same encoder `examples/2d/isometric/test.mjs` carries inline; it
// lives here because the synthetic generator and two runners all need it and
// three copies of a CRC table is how they drift.

import { deflateSync } from 'node:zlib';

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/// `rgba` is `width * height * 4` bytes, rows top to bottom.
export function png(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`png: ${rgba.length} bytes for ${width}x${height}, expected ${width * height * 4}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/// Box-average downscale, for the preview image that travels with a README.
export function downscale(rgba, width, height, factor) {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const at = ((y * factor + dy) * width + x * factor + dx) * 4;
          r += rgba[at]; g += rgba[at + 1]; b += rgba[at + 2]; a += rgba[at + 3];
        }
      }
      const n = factor * factor;
      const to = (y * w + x) * 4;
      out[to] = Math.round(r / n);
      out[to + 1] = Math.round(g / n);
      out[to + 2] = Math.round(b / n);
      out[to + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}
