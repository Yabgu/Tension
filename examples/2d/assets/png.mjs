// examples/2d/assets/png.mjs — RGBA8 PNG encode and decode, no dependencies.
//
// The 2D examples need to read a tileset and write a screenshot, and Node ships
// zlib but not PNG. This is the ~200 lines that closes the gap: encode (IHDR,
// one IDAT of filter-0 scanlines, IEND) and decode (parse chunks, inflate,
// undo the five PNG filters).
//
// Deliberately narrow: 8-bit RGBA, no interlacing, no palette, no 16-bit. That
// is every image in this tree, because `build-tileset.mjs` writes them and the
// adapter's `screenshot` reads back RGBA8. A PNG outside that subset is refused
// with a message naming what was found, rather than decoded into noise.
//
// **Why not ImageMagick.** The isometric build used to shell out to `magick` to
// crop and convert, which put an optional system package on the critical path of
// a test suite — and gave a different answer on ImageMagick 6 and 7. A decoder
// that is 120 lines and checked into the repository is smaller than the class of
// "works on my machine" it removes.
//
// SPDX-License-Identifier: MIT

import { deflateSync, inflateSync } from 'node:zlib';

// ── CRC-32, the PNG chunk checksum ──────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.alloc(4 + data.length);
  body.write(type, 0, 'latin1');
  data.copy(body, 4);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── encode ──────────────────────────────────────────────────────────────────

/// `rgba` is `width * height * 4` bytes, rows top to bottom, straight (not
/// premultiplied) alpha — which is what a `screenshot` readback already is.
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: ${rgba.length} bytes for ${width}x${height}, expected ${width * height * 4}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  // One filter byte per scanline. Filter 0 keeps the encoder honest: every byte
  // here is the pixel byte, so a diff of two PNGs is a diff of two images.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── decode ──────────────────────────────────────────────────────────────────

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/// Decode an 8-bit RGBA PNG. Returns `{ width, height, rgba }`.
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('decodePng: not a PNG (signature mismatch)');
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];

  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const dataStart = at + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new Error(`decodePng: ${type} chunk runs past the file`);
    if (crc32(buf, at + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) {
      throw new Error(`decodePng: ${type} chunk has a bad CRC`);
    }
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colourType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    at = dataEnd + 4;
  }

  if (colourType !== 6 || bitDepth !== 8) {
    throw new Error(
      `decodePng: this reader takes 8-bit RGBA (colour type 6), found ` +
      `colour type ${colourType} at ${bitDepth} bits`,
    );
  }
  if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
  if (width === 0 || height === 0) throw new Error('decodePng: zero-sized image');

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`decodePng: ${raw.length} inflated bytes, expected ${(stride + 1) * height}`);
  }

  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const a = x >= bpp ? rgba[dst + x - bpp] : 0;
      const b = y > 0 ? rgba[prev + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[prev + x - bpp] : 0;
      let out;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + a; break;
        case 2: out = value + b; break;
        case 3: out = value + ((a + b) >> 1); break;
        case 4: out = value + paeth(a, b, c); break;
        default: throw new Error(`decodePng: unknown scanline filter ${filter} on row ${y}`);
      }
      rgba[dst + x] = out & 0xff;
    }
  }
  return { width, height, rgba };
}

/// Box-average downscale, for the README preview that must stay small.
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
          // Weight colour by alpha so a transparent neighbour does not darken
          // the average toward the "colour" of nothing.
          const alpha = rgba[at + 3];
          r += rgba[at] * alpha;
          g += rgba[at + 1] * alpha;
          b += rgba[at + 2] * alpha;
          a += alpha;
        }
      }
      const to = (y * w + x) * 4;
      if (a === 0) continue;
      out[to] = Math.round(r / a);
      out[to + 1] = Math.round(g / a);
      out[to + 2] = Math.round(b / a);
      out[to + 3] = Math.round(a / (factor * factor));
    }
  }
  return { width: w, height: h, rgba: out };
}
