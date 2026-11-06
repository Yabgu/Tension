#!/usr/bin/env node
// examples/2d/assets/build-tileset.mjs — draw the 2D examples' tileset.
//
// Writes `tileset.png`: 3072x1024 RGBA, a 16px grid, three 1024px pages across.
// Committed, because it is ours — see LICENSE.md beside it. Nothing here is
// derived from anyone else's art, so there is no attribution to carry and no
// host to fetch from.
//
// # Why generate rather than download
//
// Two reasons, and only the second is about licensing.
//
// 1. **The tests assert exact pixels.** A scene that renders a painted tileset
//    can only assert "the colour I read off that tile at build time", which is
//    what `examples/2d/isometric/build.mjs` does. That works, but it makes the
//    expected value a function of an opaque binary. Art this file draws has a
//    known palette, so `PALETTE` below and the assertion are the same fact.
// 2. **A committed binary with a licence header is a liability.** CC0 art is
//    freely redistributable, and this could have been an OpenGameArt pack — but
//    then the repository depends on someone else's upload staying where it is,
//    and on the licence claim being true. Drawing it makes both moot.
//
// The output is deterministic: same bytes on every run, from fixed seeds. That
// is the property that lets the LAYOUT table be a contract rather than a hope.
//
// Usage:
//   node examples/2d/assets/build-tileset.mjs [--out <dir>]
//
// SPDX-License-Identifier: MIT

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ── the sheet ───────────────────────────────────────────────────────────────

export const TILE = 16;
export const PAGE = 1024;
export const PAGE_COUNT = 3;
export const SHEET_W = PAGE * PAGE_COUNT; // 3072: three pages across, one row
export const SHEET_H = PAGE;

/// The palette. Every colour the scene asserts on is one of these, so a test
/// can name `PALETTE.leaf` and a pixel can be compared against it without
/// either side holding a copy of the other's literal.
export const PALETTE = {
  grass:      [ 74, 143,  60],
  grassLight: [ 95, 168,  75],
  grassDark:  [ 53, 112,  44],
  grassBlade: [124, 196,  94],

  path:       [179, 154, 114],
  pathLight:  [201, 177, 138],
  pathDark:   [143, 122,  88],

  dirt:       [134, 106,  74],
  dirtLight:  [158, 128,  92],
  dirtDark:   [104,  80,  56],

  stone:      [138, 141, 148],
  stoneLight: [166, 169, 176],
  stoneDark:  [104, 107, 114],

  leafDark:   [ 30,  92,  51],
  leaf:       [ 47, 125,  68],
  leafLight:  [ 69, 156,  88],
  leafPale:   [ 96, 180, 110],

  trunk:      [107,  74,  47],
  trunkLight: [135,  96,  61],
  trunkDark:  [ 77,  52,  33],

  metal:      [ 59,  63,  74],
  metalLight: [ 92,  98, 112],
  metalDark:  [ 39,  42,  50],
  glass:      [255, 215,  94],
  glowCore:   [255, 243, 176],
  glowEdge:   [242, 169,  59],

  skin:       [217, 160, 111],
  skinLight:  [234, 185, 140],
  skinDark:   [176, 124,  80],
  hair:       [ 74,  47,  32],
  hairLight:  [107,  69,  46],
  pack:       [ 58,  92, 204],
  packLight:  [ 85, 120, 224],
  packDark:   [ 42,  68, 153],
  shirt:      [ 88, 142, 176],
  shirtLight: [112, 168, 200],
  shirtDark:  [ 64, 108, 138],
  trousers:   [ 60,  68,  92],
  trousersLt: [ 78,  88, 116],
  boot:       [ 58,  44,  34],
  shadow:     [ 46,  34,  26],
};

// ── a tiny raster ───────────────────────────────────────────────────────────

export function canvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) };
}

function plot(c, x, y, colour, alpha = 255) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const at = (y * c.w + x) * 4;
  if (alpha >= 255) {
    c.data[at] = colour[0];
    c.data[at + 1] = colour[1];
    c.data[at + 2] = colour[2];
    c.data[at + 3] = 255;
    return;
  }
  // Source-over, straight alpha. Only used for the needle break-up and the
  // lantern glow; every opaque pixel above is a straight write, so the palette
  // is exact where a test compares against it.
  const sa = alpha / 255;
  const da = c.data[at + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  for (let k = 0; k < 3; k++) {
    c.data[at + k] = Math.round((colour[k] * sa + c.data[at + k] * da * (1 - sa)) / oa);
  }
  c.data[at + 3] = Math.round(oa * 255);
}

function rect(c, x, y, w, h, colour, alpha = 255) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) plot(c, x + dx, y + dy, colour, alpha);
  }
}

function hline(c, x, y, w, colour) {
  for (let dx = 0; dx < w; dx++) plot(c, x + dx, y, colour);
}

function vline(c, x, y, h, colour) {
  for (let dy = 0; dy < h; dy++) plot(c, x, y + dy, colour);
}

/// A list of `[y, x0, x1, colour]` spans. Pixel art is shaped, not filled: a
/// silhouette that is nearly right reads as a rectangle, so the characters and
/// the props are tables of rows.
function spans(c, ox, oy, rows) {
  for (const [y, x0, x1, colour] of rows) hline(c, ox + x0, oy + y, x1 - x0 + 1, colour);
}

/// A filled ellipse, by integer scanlines — chunky edges, in the way pixel art
/// wants, rather than antialiased ones.
function ellipse(c, cx, cy, rx, ry, colour) {
  for (let dy = -ry; dy <= ry; dy++) {
    const t = 1 - (dy * dy) / (ry * ry);
    if (t < 0) continue;
    const half = Math.floor(rx * Math.sqrt(t));
    hline(c, cx - half, cy + dy, half * 2 + 1, colour);
  }
}

/// A seeded PRNG (mulberry32). Deterministic across platforms and Node
/// versions, which `Math.random()` is not — and the output bytes are the
/// contract.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── terrain tiles ───────────────────────────────────────────────────────────

/// Grass: a base, dithering both ways, and a few blades. The dither is what
/// stops a 16px tile reading as a flat swatch when it repeats.
function grassTile(c, ox, oy, seed) {
  const r = rng(seed);
  rect(c, ox, oy, TILE, TILE, PALETTE.grass);
  // Dashes, not lone pixels: a single speck reads as dirt rather than grass.
  for (let i = 0; i < 26; i++) {
    const x = ox + Math.floor(r() * TILE);
    const y = oy + Math.floor(r() * TILE);
    const colour = r() < 0.5 ? PALETTE.grassLight : PALETTE.grassDark;
    hline(c, x, y, r() < 0.4 ? 2 : 1, colour);
  }
  for (let i = 0; i < 4; i++) {
    const x = ox + 1 + Math.floor(r() * (TILE - 2));
    const y = oy + 4 + Math.floor(r() * (TILE - 8));
    vline(c, x, y, 2 + (r() < 0.5 ? 1 : 0), PALETTE.grassBlade);
    plot(c, x + 1, y + 1, PALETTE.grassLight);
  }
}

function pathTile(c, ox, oy, seed) {
  const r = rng(seed);
  rect(c, ox, oy, TILE, TILE, PALETTE.path);
  for (let i = 0; i < 22; i++) {
    const x = ox + Math.floor(r() * TILE);
    const y = oy + Math.floor(r() * TILE);
    plot(c, x, y, r() < 0.5 ? PALETTE.pathLight : PALETTE.pathDark);
    if (r() < 0.35) plot(c, x + 1, y, PALETTE.pathDark);
  }
}

function dirtTile(c, ox, oy, seed) {
  const r = rng(seed);
  rect(c, ox, oy, TILE, TILE, PALETTE.dirt);
  for (let i = 0; i < 20; i++) {
    plot(c, ox + Math.floor(r() * TILE), oy + Math.floor(r() * TILE),
      r() < 0.5 ? PALETTE.dirtLight : PALETTE.dirtDark);
  }
}

function stoneTile(c, ox, oy, seed) {
  const r = rng(seed);
  rect(c, ox, oy, TILE, TILE, PALETTE.stone);
  // Mortar lines, then wear.
  hline(c, ox, oy + 5, TILE, PALETTE.stoneDark);
  hline(c, ox, oy + 11, TILE, PALETTE.stoneDark);
  vline(c, ox + 7, oy, 5, PALETTE.stoneDark);
  vline(c, ox + 3, oy + 6, 5, PALETTE.stoneDark);
  vline(c, ox + 11, oy + 12, 4, PALETTE.stoneDark);
  for (let i = 0; i < 12; i++) {
    plot(c, ox + Math.floor(r() * TILE), oy + Math.floor(r() * TILE), PALETTE.stoneLight);
  }
}

/// Flowers: grass plus three blooms, each a three-pixel head on a stem.
function flowersTile(c, ox, oy, seed) {
  grassTile(c, ox, oy, seed);
  const r = rng(seed ^ 0x5eed);
  const petals = [[236, 116, 140], [246, 226, 108], [206, 158, 236]];
  for (let i = 0; i < 3; i++) {
    const x = ox + 2 + Math.floor(r() * (TILE - 4));
    const y = oy + 3 + Math.floor(r() * (TILE - 7));
    vline(c, x, y + 1, 3, PALETTE.grassDark);
    plot(c, x, y, petals[i]);
    plot(c, x - 1, y, petals[i]);
    plot(c, x + 1, y, petals[i]);
    plot(c, x, y + 1, PALETTE.glowCore);
  }
}

// ── props ───────────────────────────────────────────────────────────────────

/// A conifer, 32x64, drawn in one piece and sliced by the example into crown
/// and trunk at y=32.
///
/// Three overlapping tiers, widest at the bottom, each shaded left-lit: light
/// on the left third, dark on the right, so a flat fill does not read as a blob.
function conifer(c, ox, oy, seed, tone = 0) {
  const r = rng(seed);
  const mid = 16; // the trunk's centre column, in tile-local x

  const shade = tone === 0
    ? { dark: PALETTE.leafDark, base: PALETTE.leaf, light: PALETTE.leafLight, pale: PALETTE.leafPale }
    : { dark: PALETTE.leafDark, base: PALETTE.leafDark, light: PALETTE.leaf, pale: PALETTE.leafLight };

  // Trunk first, so the foliage overlaps it.
  rect(c, ox + mid - 3, oy + 34, 6, 30, PALETTE.trunk);
  vline(c, ox + mid - 3, oy + 34, 30, PALETTE.trunkLight);
  vline(c, ox + mid + 2, oy + 34, 30, PALETTE.trunkDark);
  // Roots, so the tree sits rather than standing on a line.
  hline(c, ox + mid - 5, oy + 62, 3, PALETTE.trunkDark);
  hline(c, ox + mid + 3, oy + 62, 3, PALETTE.trunkDark);

  /// One tier: a triangle from `apexY` (half-width 1) to `baseY` (half-width
  /// `half`). Rows are drawn independently so the shading follows the shape.
  const tier = (apexY, baseY, half) => {
    for (let y = apexY; y <= baseY; y++) {
      const t = (y - apexY) / (baseY - apexY);
      // Jagged edges: every third row loses a pixel, which is what makes a fir
      // read as needles rather than a cone.
      const jitter = y % 3 === 0 ? 1 : 0;
      const w = Math.max(1, Math.round(1 + t * (half - 1)) - jitter);
      const x0 = mid - w;
      const x1 = mid + w;
      for (let x = x0; x <= x1; x++) {
        const rel = (x - x0) / Math.max(1, x1 - x0);
        let colour = shade.base;
        if (rel < 0.28) colour = shade.light;
        else if (rel > 0.72) colour = shade.dark;
        plot(c, ox + x, oy + y, colour);
      }
      if (y % 4 === 0) plot(c, ox + x0 + 1, oy + y, shade.pale);
    }
  };

  tier(0, 20, 9);
  tier(14, 32, 13);
  tier(26, 44, 15);

  // Needle break-up inside the canopy, so it is not a flat fill.
  for (let i = 0; i < 40; i++) {
    const x = mid - 14 + Math.floor(r() * 29);
    const y = 4 + Math.floor(r() * 40);
    plot(c, ox + x, oy + y, shade.dark, 140);
  }
}

/// A camping lantern, 16x16. The glow is an ellipse behind the glass rather
/// than a bloom pass — the renderer has no additive blending yet (§7).
function lantern(c, ox, oy) {
  // handle
  vline(c, ox + 6, oy + 0, 3, PALETTE.metal);
  vline(c, ox + 9, oy + 0, 3, PALETTE.metal);
  hline(c, ox + 6, oy, 4, PALETTE.metal);
  plot(c, ox + 6, oy, PALETTE.metalDark);
  plot(c, ox + 9, oy, PALETTE.metalDark);

  // cap
  rect(c, ox + 3, oy + 3, 10, 2, PALETTE.metal);
  hline(c, ox + 3, oy + 3, 10, PALETTE.metalLight);
  rect(c, ox + 4, oy + 5, 8, 1, PALETTE.metalDark);

  // glow, behind the glass
  ellipse(c, ox + 8, oy + 9, 6, 5, PALETTE.glowEdge);
  ellipse(c, ox + 8, oy + 9, 4, 3, PALETTE.glowEdge);

  // glass
  rect(c, ox + 4, oy + 6, 8, 6, PALETTE.glass);
  rect(c, ox + 6, oy + 7, 4, 4, PALETTE.glowCore);
  vline(c, ox + 4, oy + 6, 6, PALETTE.metalDark);
  vline(c, ox + 11, oy + 6, 6, PALETTE.metalDark);
  hline(c, ox + 5, oy + 6, 6, PALETTE.glowCore);

  // base
  rect(c, ox + 3, oy + 12, 10, 2, PALETTE.metal);
  hline(c, ox + 3, oy + 12, 10, PALETTE.metalLight);
  rect(c, ox + 2, oy + 14, 12, 1, PALETTE.metalDark);
}

function bush(c, ox, oy, seed) {
  const r = rng(seed);
  ellipse(c, ox + 8, oy + 10, 7, 5, PALETTE.leaf);
  ellipse(c, ox + 5, oy + 7, 4, 3, PALETTE.leaf);
  ellipse(c, ox + 11, oy + 8, 4, 3, PALETTE.leaf);
  ellipse(c, ox + 8, oy + 8, 4, 2, PALETTE.leafLight);
  for (let i = 0; i < 10; i++) {
    const x = ox + 2 + Math.floor(r() * 12);
    const y = oy + 5 + Math.floor(r() * 9);
    plot(c, x, y, r() < 0.5 ? PALETTE.leafDark : PALETTE.leafPale);
  }
  hline(c, ox + 4, oy + 13, 8, PALETTE.leafDark);
}

function rock(c, ox, oy, seed) {
  const r = rng(seed);
  ellipse(c, ox + 8, oy + 10, 6, 4, PALETTE.stone);
  ellipse(c, ox + 7, oy + 8, 4, 3, PALETTE.stone);
  hline(c, ox + 4, oy + 6, 5, PALETTE.stoneLight);
  plot(c, ox + 4, oy + 7, PALETTE.stoneLight);
  hline(c, ox + 3, oy + 12, 10, PALETTE.stoneDark);
  for (let i = 0; i < 8; i++) {
    plot(c, ox + 3 + Math.floor(r() * 10), oy + 7 + Math.floor(r() * 5), PALETTE.stoneDark);
  }
}

function stump(c, ox, oy, seed) {
  const r = rng(seed);
  ellipse(c, ox + 8, oy + 11, 6, 4, PALETTE.trunk);
  ellipse(c, ox + 8, oy + 9, 6, 3, PALETTE.trunkLight);
  ellipse(c, ox + 8, oy + 9, 3, 2, PALETTE.trunk);
  for (let i = 0; i < 6; i++) {
    plot(c, ox + 3 + Math.floor(r() * 10), oy + 8 + Math.floor(r() * 6), PALETTE.trunkDark);
  }
}

function mushroom(c, ox, oy, seed) {
  grassTile(c, ox, oy, seed);
  const r = rng(seed ^ 0x1313);
  for (let i = 0; i < 3; i++) {
    const x = ox + 3 + Math.floor(r() * 10);
    const y = oy + 5 + Math.floor(r() * 6);
    rect(c, x, y + 2, 1, 2, PALETTE.glowCore);
    ellipse(c, x, y + 1, 2, 1, [198, 72, 74]);
    plot(c, x - 1, y, [198, 72, 74]);
    plot(c, x + 1, y, [198, 72, 74]);
    plot(c, x, y, [236, 116, 118]);
  }
}

function fence(c, ox, oy) {
  for (const x of [2, 7, 12]) {
    rect(c, ox + x, oy + 4, 2, 10, PALETTE.trunk);
    vline(c, ox + x, oy + 4, 10, PALETTE.trunkLight);
    plot(c, ox + x, oy + 3, PALETTE.trunkDark);
  }
  hline(c, ox + 2, oy + 7, 12, PALETTE.trunk);
  hline(c, ox + 2, oy + 11, 12, PALETTE.trunkDark);
}

function signPost(c, ox, oy) {
  rect(c, ox + 7, oy + 6, 2, 8, PALETTE.trunk);
  rect(c, ox + 2, oy + 2, 12, 6, PALETTE.trunkLight);
  rect(c, ox + 2, oy + 2, 12, 1, PALETTE.trunk);
  rect(c, ox + 2, oy + 7, 12, 1, PALETTE.trunkDark);
  hline(c, ox + 4, oy + 4, 3, PALETTE.trunkDark);
  hline(c, ox + 8, oy + 5, 4, PALETTE.trunkDark);
}

function crate(c, ox, oy) {
  rect(c, ox + 2, oy + 3, 12, 11, PALETTE.trunkLight);
  rect(c, ox + 2, oy + 3, 12, 1, PALETTE.trunk);
  rect(c, ox + 2, oy + 13, 12, 1, PALETTE.trunkDark);
  rect(c, ox + 2, oy + 3, 1, 11, PALETTE.trunk);
  rect(c, ox + 13, oy + 3, 1, 11, PALETTE.trunkDark);
  for (let i = 0; i < 9; i++) plot(c, ox + 4 + i, oy + 5 + i, PALETTE.trunkDark);
}

// ── the character: three 16x32 layers at one world position ─────────────────

/// The body. Legs end at y=30 with one row of shadow — the `feet_offset` the
/// scene's sort key subtracts is the ground contact below the hip.
function charBody(c, ox, oy) {
  const S = PALETTE;
  // head: 6 wide for six rows, 4 wide at the crown and the chin
  spans(c, ox, oy, [
    [ 2, 6,  9, S.skinLight],
    [ 3, 5, 10, S.skin],
  ]);
  rect(c, ox + 5, oy + 4, 6, 5, S.skin);
  hline(c, ox + 6, oy + 5, 2, S.skinLight);
  vline(c, ox + 10, oy + 4, 5, S.skinDark);
  spans(c, ox, oy, [[10, 6, 9, S.skin]]);
  // neck
  spans(c, ox, oy, [[11, 7, 8, S.skinDark]]);
  // shoulders and torso
  spans(c, ox, oy, [
    [12, 5, 10, S.shirtLight],
    [13, 4, 11, S.shirt],
  ]);
  rect(c, ox + 4, oy + 14, 8, 8, S.shirt);
  vline(c, ox + 11, oy + 14, 8, S.shirtDark);
  vline(c, ox + 4, oy + 14, 8, S.shirtLight);
  spans(c, ox, oy, [[22, 5, 10, S.shirtDark]]);
  // arms: one column each side, hands at the bottom
  vline(c, ox + 3, oy + 14, 7, S.shirt);
  vline(c, ox + 12, oy + 14, 7, S.shirtDark);
  vline(c, ox + 3, oy + 21, 2, S.skin);
  vline(c, ox + 12, oy + 21, 2, S.skinDark);
  // legs
  rect(c, ox + 4, oy + 23, 4, 5, S.trousers);
  rect(c, ox + 8, oy + 23, 4, 5, S.trousers);
  vline(c, ox + 4, oy + 23, 5, S.trousersLt);
  vline(c, ox + 11, oy + 23, 5, S.shadow);
  // boots
  rect(c, ox + 4, oy + 28, 4, 2, S.boot);
  rect(c, ox + 8, oy + 28, 4, 2, S.boot);
  spans(c, ox, oy, [[30, 5, 10, S.shadow]]);
}

/// The hair. A back view means the whole back of the head is hair, so the cap
/// is solid from y=1 to y=13 and only the *falls* narrow below that. An earlier
/// version left a gap between two falls and showed skin through it, which is
/// what a face looks like — from the wrong side.
///
/// The falls reach y=18 so they lie over the backpack's top rows. That overlap
/// is the pixel the composite probe reads; hair that stopped at the neck would
/// make "which layer is on top" unaskable.
function charHair(c, ox, oy) {
  const S = PALETTE;
  spans(c, ox, oy, [
    [ 1, 6,  9, S.hairLight],
    [ 2, 5, 10, S.hair],
    [ 3, 4, 11, S.hair],
  ]);
  rect(c, ox + 4, oy + 4, 8, 10, S.hair); // solid back of the head, y=4..13
  hline(c, ox + 6, oy + 1, 3, S.hairLight);
  hline(c, ox + 4, oy + 4, 2, S.hairLight);
  vline(c, ox + 7, oy + 1, 2, S.hairLight);
  // a light streak down the back, so ten rows of flat brown are not a slab
  vline(c, ox + 6, oy + 5, 8, S.hairLight);
  plot(c, ox + 9, oy + 7, S.hairLight);
  plot(c, ox + 9, oy + 11, S.hairLight);
  // the falls, past the shoulders
  for (const [x0, x1] of [[4, 5], [10, 11]]) {
    rect(c, ox + x0, oy + 14, x1 - x0 + 1, 5, S.hair);
    vline(c, ox + x0, oy + 14, 5, S.hairLight);
  }
}

/// The backpack: straps over the shoulders, a lid, and a body that covers the
/// torso from y=15. Deliberately inset from the body's silhouette (x4..11, not
/// x3..12) so the arms stay visible either side — a pack as wide as the figure
/// reads as a blue box with legs.
function charBackpack(c, ox, oy) {
  const S = PALETTE;
  // straps first, so the pack overlaps their lower ends
  vline(c, ox + 5, oy + 11, 4, S.packDark);
  vline(c, ox + 10, oy + 11, 4, S.packDark);
  // lid
  spans(c, ox, oy, [
    [15, 5, 10, S.packLight],
    [16, 4, 11, S.pack],
  ]);
  // body
  rect(c, ox + 4, oy + 17, 8, 7, S.pack);
  vline(c, ox + 4, oy + 17, 7, S.packLight);
  vline(c, ox + 11, oy + 17, 7, S.packDark);
  spans(c, ox, oy, [[24, 5, 10, S.packDark]]);
  // a strap across the middle and a buckle
  hline(c, ox + 4, oy + 21, 8, S.packDark);
  rect(c, ox + 7, oy + 18, 2, 2, S.packLight);
}

// ── the sheet ───────────────────────────────────────────────────────────────

/// Where every piece of art lives. This table is the contract: the example's
/// build reads it, and nothing else knows a coordinate.
///
/// Page 0 is terrain and the tree, page 1 is props and the lantern, page 2 is
/// the character. Three pages is not decoration — the multi-atlas test needs
/// the scene to sample three array layers in one frame.
export const LAYOUT = {
  // page 0 — terrain, tree
  grass0:   { page: 0, x: 0,   y: 0,  w: 16, h: 16 },
  grass1:   { page: 0, x: 16,  y: 0,  w: 16, h: 16 },
  grass2:   { page: 0, x: 32,  y: 0,  w: 16, h: 16 },
  grass3:   { page: 0, x: 48,  y: 0,  w: 16, h: 16 },
  path0:    { page: 0, x: 64,  y: 0,  w: 16, h: 16 },
  path1:    { page: 0, x: 80,  y: 0,  w: 16, h: 16 },
  flowers:  { page: 0, x: 96,  y: 0,  w: 16, h: 16 },
  dirt:     { page: 0, x: 112, y: 0,  w: 16, h: 16 },
  stone:    { page: 0, x: 0,   y: 16, w: 16, h: 16 },

  tree:     { page: 0, x: 128, y: 16, w: 32, h: 64 },
  bush:     { page: 0, x: 160, y: 16, w: 16, h: 16 },
  rock:     { page: 0, x: 176, y: 16, w: 16, h: 16 },
  fence:    { page: 0, x: 192, y: 16, w: 16, h: 16 },
  stump:    { page: 0, x: 208, y: 16, w: 16, h: 16 },

  // page 1 — props, lantern
  lantern:  { page: 1, x: 1024, y: 0, w: 16, h: 16 },
  crate:    { page: 1, x: 1040, y: 0, w: 16, h: 16 },
  sign:     { page: 1, x: 1056, y: 0, w: 16, h: 16 },
  mushroom: { page: 1, x: 1072, y: 0, w: 16, h: 16 },
  tree2:    { page: 1, x: 1088, y: 0, w: 32, h: 64 },

  // page 2 — the character, three layers side by side
  body:     { page: 2, x: 2048, y: 0, w: 16, h: 32 },
  hair:     { page: 2, x: 2064, y: 0, w: 16, h: 32 },
  backpack: { page: 2, x: 2080, y: 0, w: 16, h: 32 },
};

export function drawSheet() {
  const c = canvas(SHEET_W, SHEET_H);
  const at = (name) => LAYOUT[name];

  const g = at('grass0'); grassTile(c, g.x, g.y, 0x9e11);
  for (const [i, name] of ['grass1', 'grass2', 'grass3'].entries()) {
    const p = at(name);
    grassTile(c, p.x, p.y, 0x9e11 + i * 977);
  }
  for (const [i, name] of ['path0', 'path1'].entries()) {
    const p = at(name);
    pathTile(c, p.x, p.y, 0x2f13 + i * 313);
  }
  const fl = at('flowers'); flowersTile(c, fl.x, fl.y, 0x77aa);
  const d = at('dirt'); dirtTile(c, d.x, d.y, 0x1d77);
  const st = at('stone'); stoneTile(c, st.x, st.y, 0x3c31);

  const tr = at('tree'); conifer(c, tr.x, tr.y, 0x5eed, 0);
  const tr2 = at('tree2'); conifer(c, tr2.x, tr2.y, 0x5eee, 1);
  const b = at('bush'); bush(c, b.x, b.y, 0x1234);
  const rk = at('rock'); rock(c, rk.x, rk.y, 0x4321);
  const fe = at('fence'); fence(c, fe.x, fe.y);
  const sp = at('stump'); stump(c, sp.x, sp.y, 0xabcd);

  const la = at('lantern'); lantern(c, la.x, la.y);
  const cr = at('crate'); crate(c, cr.x, cr.y);
  const si = at('sign'); signPost(c, si.x, si.y);
  const mu = at('mushroom'); mushroom(c, mu.x, mu.y, 0x9911);

  const bo = at('body'); charBody(c, bo.x, bo.y);
  const ha = at('hair'); charHair(c, ha.x, ha.y);
  const ba = at('backpack'); charBackpack(c, ba.x, ba.y);

  return c;
}

// ── main ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  let out = here;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i]);
  }
  mkdirSync(out, { recursive: true });
  const sheet = drawSheet();
  const file = join(out, 'tileset.png');
  writeFileSync(file, encodePng(sheet.w, sheet.h, sheet.data));
  console.log(
    `build-tileset: ${file} ${sheet.w}x${sheet.h}, ` +
    `${Object.keys(LAYOUT).length} pieces, ${PAGE_COUNT} pages of ${PAGE}px`,
  );
}
