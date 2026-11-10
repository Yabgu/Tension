#!/usr/bin/env node
// Regenerate assets/sprites.iwi — the starter's four-cell sprite sheet.
//
// Committed as bytes because a project's art is not a build step, and generated
// by a script because a 12 KB binary nobody can regenerate is a 12 KB binary
// nobody can change. Run it after editing the palette below:
//
//   node tools/make-atlas.mjs
//
// The format is IWI, the one container the 2D renderer's decoder accepts: a
// 74-byte header and interleaved 8-bit components. Three components, not four,
// because a sprite sheet that never uses alpha does not need a fourth channel
// and the decoder expands 24-bit to RGBA8 itself.
//
// The header layout is `tension-core/src/render2d/iwi.rs`'s, and it is written
// field by field — the component records land at offsets 18, 24, 30 … with a
// `u16` at an odd offset, so it cannot be a struct with natural alignment.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CELL = 32;
const CELLS = 4;

/** The four cells, in sheet order. Edit these to restyle the starter. */
const PALETTE = [
  { name: 'red', rgb: [220, 60, 60] },
  { name: 'green', rgb: [70, 190, 100] },
  { name: 'blue', rgb: [70, 120, 220] },
  { name: 'yellow', rgb: [230, 190, 60] },
];

/** A darker version of a colour, for the 3-pixel inset border. */
function shade([r, g, b], factor) {
  return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)];
}

const width = CELL * CELLS;
const height = CELL;
const pixels = Buffer.alloc(width * height * 3);

for (let cell = 0; cell < CELLS; cell++) {
  const { rgb } = PALETTE[cell];
  const edge = shade(rgb, 0.55);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      // The border makes the sprite's edges visible against a dark background,
      // which is what makes the bounce read as a bounce rather than as a colour
      // sliding around.
      const inset = x < 3 || y < 3 || x >= CELL - 3 || y >= CELL - 3;
      const [r, g, b] = inset ? edge : rgb;
      const at = ((y * width) + cell * CELL + x) * 3;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
    }
  }
}

const header = Buffer.alloc(74);
header.write('IWI1', 0, 'ascii');
header.writeUInt32LE(width, 4);
header.writeUInt32LE(height, 8);
header[12] = 0; // colorSpace: sRGB
header.writeUInt16LE(3, 13); // componentCount
header.writeUInt16LE(24, 15); // bitsPerPixel
header[17] = 0; // storageLayout: interleaved

// Three component descriptors, in R, G, B order: semantic 1/2/3, class UNORM
// (2), bitOffset i*8, bitWidth 8. The five reserved slots stay zero.
for (let i = 0; i < 3; i++) {
  const at = 18 + i * 6;
  header[at] = i + 1;
  header[at + 1] = 2;
  header.writeUInt16LE(i * 8, at + 2);
  header.writeUInt16LE(8, at + 4);
}
header.writeBigUInt64LE(BigInt(pixels.length), 66);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sprites.iwi');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, pixels]));
console.log(`wrote ${out} — ${width}x${height}, ${CELLS} cells, ${74 + pixels.length} bytes`);
