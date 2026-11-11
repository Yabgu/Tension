#!/usr/bin/env node
// emit-boxes.mjs — Compile-time texture atlas generator for stiff-boxes example.
//
// Generates a 1024x1024 RGBA8 IWI1 texture atlas containing:
//   - 6 box styles x 32 rotation angles (64x64 tiles) with anti-aliasing, bevels, rivets & braces
//   - Platform tiles (steel tread, industrial hazard, stone slab)
//   - Ramp surfaces with diagonal grip treads
//   - Structural wall frames and background panels
//
// The output file is written to `assets/textures/boxes.iwi` and packed into the .tns volume.
// At runtime, the guest loads the texture from the mounted volume without any runtime generation.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'assets', 'textures');
mkdirSync(outDir, { recursive: true });

const ATLAS_SIZE = 1024;
const TILE_SIZE = 64;
const ROTATIONS = 32;

function iwi(rgba, width, height) {
  const header = Buffer.alloc(74);
  header.write('IWI1', 0, 'latin1');
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt8(0, 12);      // colorSpace: sRGB
  header.writeUInt16LE(4, 13);   // componentCount
  header.writeUInt16LE(32, 15);  // bitsPerPixel
  header.writeUInt8(0, 17);      // storageLayout: interleaved
  for (let i = 0; i < 4; i++) {
    const at = 18 + i * 6;
    header.writeUInt8(i + 1, at);   // semantics R,G,B,A (1, 2, 3, 4)
    header.writeUInt8(2, at + 1);   // componentClass UNORM
    header.writeUInt16LE(i * 8, at + 2);
    header.writeUInt16LE(8, at + 4);
  }
  header.writeBigUInt64LE(BigInt(width) * BigInt(height) * 4n, 66);
  return Buffer.concat([header, rgba]);
}

// 1024x1024 RGBA buffer
const atlas = Buffer.alloc(ATLAS_SIZE * ATLAS_SIZE * 4, 0);

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= ATLAS_SIZE || y < 0 || y >= ATLAS_SIZE) return;
  const idx = (y * ATLAS_SIZE + x) * 4;
  atlas[idx] = r;
  atlas[idx + 1] = g;
  atlas[idx + 2] = b;
  atlas[idx + 3] = a;
}

// Helper: draw source sprite onto 64x64 buffer, then sample rotated
function createRotatedTiles(drawBase, startRow) {
  const base = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4, 0);
  drawBase(base);

  for (let r = 0; r < ROTATIONS; r++) {
    const angle = (r * 2.0 * Math.PI) / ROTATIONS;
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);

    const tileCol = r % 16;
    const tileRow = startRow + Math.floor(r / 16);
    const originX = tileCol * TILE_SIZE;
    const originY = tileRow * TILE_SIZE;

    const cx = 32.0;
    const cy = 32.0;

    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const dx = px - cx + 0.5;
        const dy = py - cy + 0.5;

        const sx = cx + dx * cosA - dy * sinA;
        const sy = cy + dx * sinA + dy * cosA;

        // Bilinear sample from base
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;

        if (x0 >= 0 && x0 + 1 < TILE_SIZE && y0 >= 0 && y0 + 1 < TILE_SIZE) {
          const idx00 = (y0 * TILE_SIZE + x0) * 4;
          const idx10 = (y0 * TILE_SIZE + (x0 + 1)) * 4;
          const idx01 = ((y0 + 1) * TILE_SIZE + x0) * 4;
          const idx11 = ((y0 + 1) * TILE_SIZE + (x0 + 1)) * 4;

          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;

          const red = Math.round(base[idx00] * w00 + base[idx10] * w10 + base[idx01] * w01 + base[idx11] * w11);
          const green = Math.round(base[idx00 + 1] * w00 + base[idx10 + 1] * w10 + base[idx01 + 1] * w01 + base[idx11 + 1] * w11);
          const blue = Math.round(base[idx00 + 2] * w00 + base[idx10 + 2] * w10 + base[idx01 + 2] * w01 + base[idx11 + 2] * w11);
          const alpha = Math.round(base[idx00 + 3] * w00 + base[idx10 + 3] * w10 + base[idx01 + 3] * w01 + base[idx11 + 3] * w11);

          if (alpha > 0) {
            setPixel(originX + px, originY + py, red, green, blue, alpha);
          }
        }
      }
    }
  }
}

// ── Box Styles ──────────────────────────────────────────────────────────

// Type 0: Wooden Crate (40x40 body)
createRotatedTiles((buf) => {
  const hw = 20, hh = 20, cx = 32, cy = 32;
  for (let y = cy - hh; y <= cy + hh; y++) {
    for (let x = cx - hw; x <= cx + hw; x++) {
      const idx = (y * TILE_SIZE + x) * 4;
      const isEdge = x === cx - hw || x === cx + hw || y === cy - hh || y === cy + hh;
      const isCorner = (x <= cx - hw + 3 || x >= cx + hw - 3) && (y <= cy - hh + 3 || y >= cy + hh - 3);
      const isDiag1 = Math.abs((x - cx) - (y - cy)) <= 1;
      const isDiag2 = Math.abs((x - cx) + (y - cy)) <= 1;

      if (isCorner) {
        buf[idx] = 110; buf[idx+1] = 115; buf[idx+2] = 125; buf[idx+3] = 255; // steel corner brackets
      } else if (isEdge) {
        buf[idx] = 90; buf[idx+1] = 55; buf[idx+2] = 25; buf[idx+3] = 255;   // dark wood frame
      } else if (isDiag1 || isDiag2) {
        buf[idx] = 150; buf[idx+1] = 95; buf[idx+2] = 45; buf[idx+3] = 255;  // wood brace
      } else {
        const grain = ((x * 7 + y * 13) % 20) - 10;
        buf[idx] = 196 + grain; buf[idx+1] = 135 + grain; buf[idx+2] = 66 + grain; buf[idx+3] = 255; // cedar plank
      }
    }
  }
}, 0);

// Type 1: Reinforced Steel Box (40x40 body)
createRotatedTiles((buf) => {
  const hw = 20, hh = 20, cx = 32, cy = 32;
  for (let y = cy - hw; y <= cy + hw; y++) {
    for (let x = cx - hw; x <= cx + hw; x++) {
      const idx = (y * TILE_SIZE + x) * 4;
      const isEdge = x === cx - hw || x === cx + hw || y === cy - hh || y === cy + hh;
      const isBolt = ((x === cx - hw + 2 || x === cx + hw - 2) && (y === cy - hh + 2 || y === cy + hh - 2));

      if (isBolt) {
        buf[idx] = 230; buf[idx+1] = 235; buf[idx+2] = 245; buf[idx+3] = 255; // polished steel rivet
      } else if (isEdge) {
        buf[idx] = 50; buf[idx+1] = 60; buf[idx+2] = 75; buf[idx+3] = 255;    // dark steel border
      } else {
        const plate = ((x + y) % 6 === 0) ? 15 : 0;
        buf[idx] = 95 + plate; buf[idx+1] = 110 + plate; buf[idx+2] = 130 + plate; buf[idx+3] = 255;
      }
    }
  }
}, 2);

// Type 2: Golden Cargo Container (40x40 body)
createRotatedTiles((buf) => {
  const hw = 20, hh = 20, cx = 32, cy = 32;
  for (let y = cy - hh; y <= cy + hh; y++) {
    for (let x = cx - hw; x <= cx + hw; x++) {
      const idx = (y * TILE_SIZE + x) * 4;
      const isEdge = x === cx - hw || x === cx + hw || y === cy - hh || y === cy + hh;
      const isCenter = Math.abs(x - cx) <= 8 && Math.abs(y - cy) <= 8;

      if (isEdge) {
        buf[idx] = 180; buf[idx+1] = 120; buf[idx+2] = 20; buf[idx+3] = 255;  // bronze/gold frame
      } else if (isCenter) {
        buf[idx] = 255; buf[idx+1] = 225; buf[idx+2] = 100; buf[idx+3] = 255; // gold core
      } else {
        const rib = (x % 4 === 0) ? 20 : 0;
        buf[idx] = 226 + rib; buf[idx+1] = 160 + rib; buf[idx+2] = 40 + rib; buf[idx+3] = 255;
      }
    }
  }
}, 4);

// Type 3: Chiseled Stone Block (40x40 body)
createRotatedTiles((buf) => {
  const hw = 20, hh = 20, cx = 32, cy = 32;
  for (let y = cy - hh; y <= cy + hh; y++) {
    for (let x = cx - hw; x <= cx + hw; x++) {
      const idx = (y * TILE_SIZE + x) * 4;
      const isEdge = x === cx - hw || x === cx + hw || y === cy - hh || y === cy + hh;
      if (isEdge) {
        buf[idx] = 60; buf[idx+1] = 65; buf[idx+2] = 75; buf[idx+3] = 255;
      } else {
        const grain = ((x * 11 + y * 17) % 25) - 12;
        buf[idx] = 140 + grain; buf[idx+1] = 145 + grain; buf[idx+2] = 155 + grain; buf[idx+3] = 255;
      }
    }
  }
}, 6);

// Type 4: Terracotta Brick Crate (40x40 body)
createRotatedTiles((buf) => {
  const hw = 20, hh = 20, cx = 32, cy = 32;
  for (let y = cy - hh; y <= cy + hh; y++) {
    for (let x = cx - hw; x <= cx + hw; x++) {
      const idx = (y * TILE_SIZE + x) * 4;
      const isEdge = x === cx - hw || x === cx + hw || y === cy - hh || y === cy + hh;
      const isMortar = (y % 7 === 0) || ((x + (Math.floor(y / 7) % 2) * 6) % 12 === 0);
      if (isEdge) {
        buf[idx] = 110; buf[idx+1] = 30; buf[idx+2] = 20; buf[idx+3] = 255;
      } else if (isMortar) {
        buf[idx] = 220; buf[idx+1] = 215; buf[idx+2] = 205; buf[idx+3] = 255;
      } else {
        const grain = ((x * 5 + y * 7) % 18) - 9;
        buf[idx] = 197 + grain; buf[idx+1] = 65 + grain; buf[idx+2] = 45 + grain; buf[idx+3] = 255;
      }
    }
  }
}, 8);

// Type 5: Sci-Fi Energy Box (40x40 body)
createRotatedTiles((buf) => {
  const hw = 20, hh = 20, cx = 32, cy = 32;
  for (let y = cy - hh; y <= cy + hh; y++) {
    for (let x = cx - hw; x <= cx + hw; x++) {
      const idx = (y * TILE_SIZE + x) * 4;
      const isEdge = x === cx - hw || x === cx + hw || y === cy - hh || y === cy + hh;
      const distCenter = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (isEdge) {
        buf[idx] = 15; buf[idx+1] = 23; buf[idx+2] = 42; buf[idx+3] = 255;  // deep dark navy
      } else if (distCenter <= 6) {
        buf[idx] = 220; buf[idx+1] = 250; buf[idx+2] = 255; buf[idx+3] = 255; // cyan reactor glow
      } else if (distCenter <= 12) {
        buf[idx] = 14; buf[idx+1] = 165; buf[idx+2] = 233; buf[idx+3] = 255; // bright cyan
      } else {
        buf[idx] = 30; buf[idx+1] = 58; buf[idx+2] = 88; buf[idx+3] = 255;   // tech metallic
      }
    }
  }
}, 10);

// ── Static Environment Tiles (Row 12) ────────────────────────────────────

// Ground Steel Plate: Tile (0, 12)
const groundX = 0, groundY = 12 * TILE_SIZE;
for (let y = 0; y < TILE_SIZE; y++) {
  for (let x = 0; x < TILE_SIZE; x++) {
    const isBorder = (y < 3) || (x === 0 || x === TILE_SIZE - 1);
    const isTread = (x + y) % 8 < 2;
    if (isBorder) {
      setPixel(groundX + x, groundY + y, 40, 48, 60, 255);
    } else if (isTread) {
      setPixel(groundX + x, groundY + y, 95, 108, 128, 255);
    } else {
      setPixel(groundX + x, groundY + y, 70, 80, 95, 255);
    }
  }
}

// Ramp Grip Surface: Tile (1, 12)
const rampX = 64, rampY = 12 * TILE_SIZE;
for (let y = 0; y < TILE_SIZE; y++) {
  for (let x = 0; x < TILE_SIZE; x++) {
    const isStripe = ((x - y) + 128) % 16 < 8;
    if (isStripe) {
      setPixel(rampX + x, rampY + y, 220, 180, 30, 255); // safety yellow
    } else {
      setPixel(rampX + x, rampY + y, 35, 40, 48, 255);   // industrial black
    }
  }
}

// Wall Border Beam: Tile (2, 12)
const wallX = 128, wallY = 12 * TILE_SIZE;
for (let y = 0; y < TILE_SIZE; y++) {
  for (let x = 0; x < TILE_SIZE; x++) {
    const isRivet = (x === 8 || x === TILE_SIZE - 9) && (y % 16 === 8);
    const isLip = x < 4 || x >= TILE_SIZE - 4;
    if (isRivet) {
      setPixel(wallX + x, wallY + y, 210, 220, 235, 255);
    } else if (isLip) {
      setPixel(wallX + x, wallY + y, 50, 60, 75, 255);
    } else {
      setPixel(wallX + x, wallY + y, 75, 85, 100, 255);
    }
  }
}

// Background Grid Pattern: Tile (3, 12)
const bgX = 192, bgY = 12 * TILE_SIZE;
for (let y = 0; y < TILE_SIZE; y++) {
  for (let x = 0; x < TILE_SIZE; x++) {
    const isLine = (x === 0 || y === 0);
    if (isLine) {
      setPixel(bgX + x, bgY + y, 30, 36, 50, 255);
    } else {
      setPixel(bgX + x, bgY + y, 18, 22, 32, 255);
    }
  }
}

// Write the packed IWI1 file
const iwiBuffer = iwi(atlas, ATLAS_SIZE, ATLAS_SIZE);
const outPath = join(outDir, 'boxes.iwi');
writeFileSync(outPath, iwiBuffer);
console.log(`emit-boxes: wrote ${iwiBuffer.length} bytes to ${outPath}`);
