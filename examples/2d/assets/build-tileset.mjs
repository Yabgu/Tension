#!/usr/bin/env node
// examples/2d/assets/build-tileset.mjs — draw the 2D examples' tileset.
//
// Writes `tileset.png`: three 128x128 pages side by side, a 16px grid, 8x8
// cells per page. Committed, because it is ours — see LICENSE.md beside it.
// Nothing here is derived from anyone else's art, so there is no attribution to
// carry and no host to fetch from.
//
// # Size is derived, not chosen
//
// An earlier version drew the same few dozen tiles onto 1024x1024 pages, which
// wasted 90% of every page and 12 MB of texture memory. Pages are now 128px:
// 64 cells each, packed by `pack()` from the pieces registered below, and the
// build asserts that each page is at least `MIN_DENSITY` full. A tile added
// without a page to hold it is a build failure, not a gap.
//
// # Why generate rather than download
//
// 1. **The tests assert exact pixels.** An expected colour read off a
//    downloaded PNG is a function of an opaque binary; a colour read off a
//    sheet whose palette is a constant here is a fact you can check by reading.
// 2. **A committed binary with a licence header is a liability.** CC0 art is
//    freely redistributable, and this could have been an OpenGameArt pack — but
//    then the repository depends on someone else's upload staying where it is,
//    and on the licence claim being true. Drawing it makes both moot.
//
// Output is deterministic: fixed seeds, no `Math.random`. Regenerating an
// unchanged script produces identical bytes.
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
export const GRID = 8;                  // cells per page edge
export const PAGE = TILE * GRID;        // 128
export const PAGE_COUNT = 3;
export const SHEET_W = PAGE * PAGE_COUNT; // 384: three pages across
export const SHEET_H = PAGE;

/// The fraction of each page that must be covered by a piece. A page under this
/// is a page with a hole in it, which is what this constant exists to catch.
const MIN_DENSITY = 0.7;

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
  water:      [ 62, 122, 178],
  waterLight: [ 90, 154, 208],
  waterDark:  [ 44,  94, 142],
  gold:       [240, 197,  74],
  goldDark:   [186, 143,  42],
  gem:        [ 96, 208, 196],
  gemDark:    [ 56, 156, 146],
  potion:     [204,  74, 116],
  potionDark: [156,  48,  84],
  paper:      [226, 218, 198],
  paperDark:  [186, 176, 154],
  wood:       [150, 110,  68],
  woodDark:   [110,  78,  48],
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

function ellipse(c, cx, cy, rx, ry, colour) {
  for (let dy = -ry; dy <= ry; dy++) {
    const t = 1 - (dy * dy) / (ry * ry);
    if (t < 0) continue;
    const half = Math.floor(rx * Math.sqrt(t));
    hline(c, cx - half, cy + dy, half * 2 + 1, colour);
  }
}

/// Flip a rectangle in place, for the second side-facing character.
function mirrorX(c, ox, oy, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < Math.floor(w / 2); x++) {
      const a = ((oy + y) * c.w + ox + x) * 4;
      const b = ((oy + y) * c.w + ox + w - 1 - x) * 4;
      for (let k = 0; k < 4; k++) {
        const t = c.data[a + k];
        c.data[a + k] = c.data[b + k];
        c.data[b + k] = t;
      }
    }
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

// ── the pieces, as declarations ─────────────────────────────────────────────
//
// Every piece names its page and its size in cells. `pack()` places them, so
// there are no coordinates in this file to get wrong, and a piece that does not
// fit is an error rather than an overlap.

const PIECES = [];

function put(page, name, cw, ch, draw) {
  PIECES.push({ name, page, cw, ch, draw });
}

// ── page 0: terrain, as autotiles ───────────────────────────────────────────
//
// Every material is drawn as a 16-variant autotile set. A mask bit says "the
// neighbour on this side is the same material", so variant `0b1111` is an
// interior tile and variant `0` is a single isolated tile with edges all round.
// Sixteen variants per material is what lets a map drawn from these tiles have
// outlines instead of a checkerboard of identical squares — and it fills a page
// with tiles that are all different, rather than one swatch repeated.

const MATERIALS = {
  grass: { base: PALETTE.grass, light: PALETTE.grassLight, dark: PALETTE.grassDark, edge: PALETTE.grassDark },
  dirt:  { base: PALETTE.dirt,  light: PALETTE.dirtLight,  dark: PALETTE.dirtDark,  edge: PALETTE.dirtDark },
  stone: { base: PALETTE.stone, light: PALETTE.stoneLight, dark: PALETTE.stoneDark, edge: PALETTE.stoneDark },
};

const MAT_NAMES = Object.keys(MATERIALS);

/// The noise pattern for one material. Same seed per material, so every variant
/// of that material has the same texture in its interior and only the edges
/// differ — which is what makes two variants tile seamlessly against each other.
function materialBase(c, ox, oy, name, seed) {
  const m = MATERIALS[name];
  const r = rng(seed);
  rect(c, ox, oy, TILE, TILE, m.base);
  for (let i = 0; i < 30; i++) {
    const x = ox + Math.floor(r() * TILE);
    const y = oy + Math.floor(r() * TILE);
    hline(c, x, y, r() < 0.4 ? 2 : 1, r() < 0.5 ? m.light : m.dark);
  }
  if (name === 'stone') {
    // Mortar lines, so the material reads as masonry rather than gravel.
    hline(c, ox, oy + 5, TILE, m.dark);
    hline(c, ox, oy + 11, TILE, m.dark);
    vline(c, ox + 7, oy, 5, m.dark);
    vline(c, ox + 3, oy + 6, 5, m.dark);
    vline(c, ox + 11, oy + 12, 4, m.dark);
  }
  if (name === 'grass') {
    for (let i = 0; i < 5; i++) {
      const x = ox + 1 + Math.floor(r() * (TILE - 2));
      const y = oy + 3 + Math.floor(r() * (TILE - 7));
      vline(c, x, y, 2, PALETTE.grassBlade);
      plot(c, x + 1, y + 1, m.light);
    }
  }
}

/// One autotile variant. `mask` bits: 1 = north neighbour matches, 2 = east,
/// 4 = south, 8 = west.
function autotile(c, ox, oy, name, mask, seed) {
  const m = MATERIALS[name];
  materialBase(c, ox, oy, name, seed);
  const edge = m.edge;
  const rim = m.light;

  // A missing neighbour gets a two-pixel edge: a bright rim just inside the
  // boundary, then the darker border. That is the shading convention almost
  // every 16px tileset uses, and it is why an interior tile next to an edge
  // tile reads as continuing ground.
  if (!(mask & 1)) {
    hline(c, ox, oy, TILE, edge);
    hline(c, ox, oy + 1, TILE, rim);
  }
  if (!(mask & 4)) {
    hline(c, ox, oy + TILE - 1, TILE, edge);
    hline(c, ox, oy + TILE - 2, TILE, rim);
  }
  if (!(mask & 8)) {
    vline(c, ox, oy, TILE, edge);
    vline(c, ox + 1, oy, TILE, rim);
  }
  if (!(mask & 2)) {
    vline(c, ox + TILE - 1, oy, TILE, edge);
    vline(c, ox + TILE - 2, oy, TILE, rim);
  }

  // Corners, where two edges meet: a single dark pixel rounds the join so an
  // isolated tile does not look like a square with a border drawn on.
  if (!(mask & 1) && !(mask & 8)) plot(c, ox, oy, edge);
  if (!(mask & 1) && !(mask & 2)) plot(c, ox + TILE - 1, oy, edge);
  if (!(mask & 4) && !(mask & 8)) plot(c, ox, oy + TILE - 1, edge);
  if (!(mask & 4) && !(mask & 2)) plot(c, ox + TILE - 1, oy + TILE - 1, edge);
}

/// A decoration drawn on top of an interior tile: flowers, tufts, pebbles,
/// cracks. `kind` picks the motif, so sixteen decorations are four motifs on
/// four substrates rather than sixteen bespoke drawings.
function decoration(c, ox, oy, name, kind, seed) {
  materialBase(c, ox, oy, name, seed);
  const r = rng(seed ^ (kind * 7919));
  // Every decoration keeps a one-pixel margin so it tiles without clipping.
  const x0 = 2;
  const y0 = 3;
  const w = TILE - 4;
  const h = TILE - 6;

  switch (kind) {
    case 0: { // flowers
      const petals = [[236, 116, 140], [246, 226, 108], [206, 158, 236]];
      for (let i = 0; i < 3; i++) {
        const x = ox + x0 + Math.floor(r() * w);
        const y = oy + y0 + Math.floor(r() * h);
        vline(c, x, y + 1, 2, MATERIALS[name].dark);
        plot(c, x, y, petals[i]);
        plot(c, x - 1, y, petals[i]);
        plot(c, x + 1, y, petals[i]);
        plot(c, x, y + 1, PALETTE.glowCore);
      }
      break;
    }
    case 1: { // tufts
      for (let i = 0; i < 5; i++) {
        const x = ox + x0 + Math.floor(r() * w);
        const y = oy + y0 + Math.floor(r() * h);
        vline(c, x, y, 3, MATERIALS.grass.base);
        plot(c, x, y - 1, PALETTE.grassBlade);
        plot(c, x + 1, y + 1, MATERIALS.grass.dark);
      }
      break;
    }
    case 2: { // pebbles
      for (let i = 0; i < 4; i++) {
        const x = ox + x0 + Math.floor(r() * (w - 2));
        const y = oy + y0 + Math.floor(r() * (h - 2));
        hline(c, x, y, 2, MATERIALS[name].light);
        plot(c, x, y + 1, MATERIALS[name].dark);
      }
      break;
    }
    default: { // cracks
      let x = ox + x0 + Math.floor(r() * w);
      let y = oy + y0;
      for (let i = 0; i < 6; i++) {
        plot(c, x, y, MATERIALS[name].dark);
        x += r() < 0.5 ? 1 : -1;
        y += 1;
        if (x < ox + 1) x = ox + 1;
        if (x > ox + TILE - 2) x = ox + TILE - 2;
        if (y > oy + TILE - 2) break;
      }
      break;
    }
  }
}

// Three materials, sixteen variants each: 48 cells.
for (const [mi, name] of MAT_NAMES.entries()) {
  for (let mask = 0; mask < 16; mask++) {
    put(0, `${name}${mask.toString().padStart(2, '0')}`, 1, 1,
      (c, ox, oy) => autotile(c, ox, oy, name, mask, 0x9e11 + mi * 977));
  }
}
// Four decorated variants per material: 12 cells, then four spare decorations
// on grass to fill the page.
for (const [mi, name] of MAT_NAMES.entries()) {
  for (let kind = 0; kind < 4; kind++) {
    put(0, `${name}_deco${kind}`, 1, 1,
      (c, ox, oy) => decoration(c, ox, oy, name, kind, 0x51de + mi * 313));
  }
}
for (let kind = 0; kind < 4; kind++) {
  put(0, `grass_extra${kind}`, 1, 1,
    (c, ox, oy) => decoration(c, ox, oy, 'grass', kind, 0x77aa + kind));
}

// ── page 1: props ───────────────────────────────────────────────────────────
//
// Trees first (they are multi-cell, so they need the large gaps), then
// everything that stands on the ground. Each prop is drawn bottom-aligned
// inside its cell so `sort_key = y + h` is its base, which is the rule the
// scene uses for every static.

function conifer(c, ox, oy, seed, tone) {
  const r = rng(seed);
  const mid = 16; // centre column, in local pixels
  const shade = tone === 0
    ? { dark: PALETTE.leafDark, base: PALETTE.leaf, light: PALETTE.leafLight, pale: PALETTE.leafPale }
    : { dark: PALETTE.leafDark, base: PALETTE.leafDark, light: PALETTE.leaf, pale: PALETTE.leafLight };

  rect(c, ox + mid - 3, oy + 34, 6, 30, PALETTE.trunk);
  vline(c, ox + mid - 3, oy + 34, 30, PALETTE.trunkLight);
  vline(c, ox + mid + 2, oy + 34, 30, PALETTE.trunkDark);
  hline(c, ox + mid - 5, oy + 62, 3, PALETTE.trunkDark);
  hline(c, ox + mid + 3, oy + 62, 3, PALETTE.trunkDark);

  const tier = (apexY, baseY, half) => {
    for (let y = apexY; y <= baseY; y++) {
      const t = (y - apexY) / (baseY - apexY);
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

  for (let i = 0; i < 40; i++) {
    plot(c, ox + mid - 14 + Math.floor(r() * 29), oy + 4 + Math.floor(r() * 40), shade.dark, 140);
  }
}

/// A broadleaf: a trunk plus three overlapping ellipses, so it is a different
/// silhouette from the conifer rather than a recolour.
function broadleaf(c, ox, oy, seed) {
  const r = rng(seed);
  rect(c, ox + 13, oy + 24, 6, 24, PALETTE.trunk);
  vline(c, ox + 13, oy + 24, 24, PALETTE.trunkLight);
  vline(c, ox + 18, oy + 24, 24, PALETTE.trunkDark);
  hline(c, ox + 10, oy + 47, 5, PALETTE.trunkDark);
  hline(c, ox + 17, oy + 47, 5, PALETTE.trunkDark);
  ellipse(c, ox + 16, oy + 16, 15, 11, PALETTE.leaf);
  ellipse(c, ox + 10, oy + 12, 9, 7, PALETTE.leafLight);
  ellipse(c, ox + 22, oy + 14, 9, 7, PALETTE.leafDark);
  ellipse(c, ox + 16, oy + 11, 7, 5, PALETTE.leafPale);
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 12;
    plot(c, ox + 16 + Math.cos(a) * d, oy + 14 + Math.sin(a) * d * 0.75,
      r() < 0.5 ? PALETTE.leafDark : PALETTE.leafPale);
  }
}

function deadTree(c, ox, oy, seed) {
  const r = rng(seed);
  rect(c, ox + 14, oy + 20, 4, 28, PALETTE.trunk);
  vline(c, ox + 14, oy + 20, 28, PALETTE.trunkLight);
  // three bare limbs, each a two-segment elbow
  const limb = (x, y, dx, dy) => {
    for (let i = 0; i < 6; i++) { plot(c, ox + x + i * dx, oy + y + i * dy, PALETTE.trunk); }
    for (let i = 0; i < 4; i++) { plot(c, ox + x + 6 * dx + i * dy, oy + y + 6 * dy + i * dx, PALETTE.trunkDark); }
  };
  limb(14, 24, -1, -1);
  limb(16, 18, 1, -1);
  limb(15, 12, -1, -1);
  for (let i = 0; i < 6; i++) {
    plot(c, ox + 12 + Math.floor(r() * 8), oy + 24 + Math.floor(r() * 22), PALETTE.trunkDark);
  }
  hline(c, ox + 11, oy + 47, 5, PALETTE.trunkDark);
  hline(c, ox + 17, oy + 47, 4, PALETTE.trunkDark);
}

function bush(c, ox, oy, seed, hue) {
  const r = rng(seed);
  const base = hue === 0 ? PALETTE.leaf : PALETTE.leafLight;
  const dark = hue === 0 ? PALETTE.leafDark : PALETTE.leaf;
  const light = hue === 0 ? PALETTE.leafLight : PALETTE.leafPale;
  ellipse(c, ox + 8, oy + 10, 7, 5, base);
  ellipse(c, ox + 5, oy + 7, 4, 3, base);
  ellipse(c, ox + 11, oy + 8, 4, 3, base);
  ellipse(c, ox + 8, oy + 8, 4, 2, light);
  for (let i = 0; i < 10; i++) {
    plot(c, ox + 2 + Math.floor(r() * 12), oy + 5 + Math.floor(r() * 9), r() < 0.5 ? dark : light);
  }
  hline(c, ox + 4, oy + 13, 8, dark);
}

function rock(c, ox, oy, seed, size) {
  const r = rng(seed);
  const w = size === 0 ? 5 : size === 1 ? 6 : 7;
  const h = size === 0 ? 3 : size === 1 ? 4 : 5;
  ellipse(c, ox + 8, oy + 12, w, h, PALETTE.stone);
  ellipse(c, ox + 7, oy + 11, w - 2, h - 1, PALETTE.stone);
  hline(c, ox + 8 - w + 2, oy + 12 - h + 1, w, PALETTE.stoneLight);
  hline(c, ox + 8 - w, oy + 12 + h - 1, w * 2, PALETTE.stoneDark);
  for (let i = 0; i < 6; i++) {
    plot(c, ox + 8 - w + 1 + Math.floor(r() * (w * 2 - 2)), oy + 12 - h + 2 + Math.floor(r() * (h * 2 - 3)), PALETTE.stoneDark);
  }
}

function fenceH(c, ox, oy) {
  for (const x of [2, 7, 12]) {
    rect(c, ox + x, oy + 4, 2, 10, PALETTE.trunk);
    vline(c, ox + x, oy + 4, 10, PALETTE.trunkLight);
    plot(c, ox + x, oy + 3, PALETTE.trunkDark);
  }
  hline(c, ox + 2, oy + 7, 12, PALETTE.trunk);
  hline(c, ox + 2, oy + 11, 12, PALETTE.trunkDark);
}

function fenceV(c, ox, oy) {
  rect(c, ox + 6, oy + 1, 3, 14, PALETTE.trunk);
  vline(c, ox + 6, oy + 1, 14, PALETTE.trunkLight);
  hline(c, ox + 2, oy + 5, 12, PALETTE.trunk);
  hline(c, ox + 2, oy + 10, 12, PALETTE.trunkDark);
  plot(c, ox + 7, oy, PALETTE.trunkDark);
}

function fenceCorner(c, ox, oy) {
  rect(c, ox + 6, oy + 1, 3, 14, PALETTE.trunk);
  vline(c, ox + 6, oy + 1, 14, PALETTE.trunkLight);
  hline(c, ox + 6, oy + 7, 9, PALETTE.trunk);
  hline(c, ox + 2, oy + 7, 5, PALETTE.trunk);
  hline(c, ox + 6, oy + 11, 9, PALETTE.trunkDark);
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

function log(c, ox, oy) {
  rect(c, ox + 1, oy + 9, 14, 5, PALETTE.trunk);
  hline(c, ox + 1, oy + 9, 14, PALETTE.trunkLight);
  hline(c, ox + 1, oy + 13, 14, PALETTE.trunkDark);
  ellipse(c, ox + 14, oy + 11, 1, 2, PALETTE.trunkLight);
  for (let i = 0; i < 4; i++) plot(c, ox + 3 + i * 3, oy + 11, PALETTE.trunkDark);
}

function crate(c, ox, oy) {
  rect(c, ox + 2, oy + 3, 12, 11, PALETTE.wood);
  rect(c, ox + 2, oy + 3, 12, 1, PALETTE.trunk);
  rect(c, ox + 2, oy + 13, 12, 1, PALETTE.woodDark);
  rect(c, ox + 2, oy + 3, 1, 11, PALETTE.trunk);
  rect(c, ox + 13, oy + 3, 1, 11, PALETTE.woodDark);
  for (let i = 0; i < 9; i++) plot(c, ox + 4 + i, oy + 5 + i, PALETTE.woodDark);
}

function barrel(c, ox, oy) {
  rect(c, ox + 3, oy + 4, 10, 10, PALETTE.wood);
  vline(c, ox + 3, oy + 4, 10, PALETTE.trunkLight);
  vline(c, ox + 12, oy + 4, 10, PALETTE.woodDark);
  hline(c, ox + 3, oy + 4, 10, PALETTE.trunk);
  hline(c, ox + 3, oy + 13, 10, PALETTE.woodDark);
  hline(c, ox + 3, oy + 7, 10, PALETTE.metalDark);
  hline(c, ox + 3, oy + 11, 10, PALETTE.metalDark);
}

function signPost(c, ox, oy) {
  rect(c, ox + 7, oy + 6, 2, 8, PALETTE.trunk);
  rect(c, ox + 2, oy + 2, 12, 6, PALETTE.wood);
  rect(c, ox + 2, oy + 2, 12, 1, PALETTE.trunk);
  rect(c, ox + 2, oy + 7, 12, 1, PALETTE.woodDark);
  hline(c, ox + 4, oy + 4, 3, PALETTE.woodDark);
  hline(c, ox + 8, oy + 5, 4, PALETTE.woodDark);
}

function lantern(c, ox, oy) {
  vline(c, ox + 6, oy + 0, 3, PALETTE.metal);
  vline(c, ox + 9, oy + 0, 3, PALETTE.metal);
  hline(c, ox + 6, oy, 4, PALETTE.metal);
  plot(c, ox + 6, oy, PALETTE.metalDark);
  plot(c, ox + 9, oy, PALETTE.metalDark);
  rect(c, ox + 3, oy + 3, 10, 2, PALETTE.metal);
  hline(c, ox + 3, oy + 3, 10, PALETTE.metalLight);
  rect(c, ox + 4, oy + 5, 8, 1, PALETTE.metalDark);
  ellipse(c, ox + 8, oy + 9, 6, 5, PALETTE.glowEdge);
  rect(c, ox + 4, oy + 6, 8, 6, PALETTE.glass);
  rect(c, ox + 6, oy + 7, 4, 4, PALETTE.glowCore);
  vline(c, ox + 4, oy + 6, 6, PALETTE.metalDark);
  vline(c, ox + 11, oy + 6, 6, PALETTE.metalDark);
  rect(c, ox + 3, oy + 12, 10, 2, PALETTE.metal);
  hline(c, ox + 3, oy + 12, 10, PALETTE.metalLight);
  rect(c, ox + 2, oy + 14, 12, 1, PALETTE.metalDark);
}

function lampPost(c, ox, oy) {
  rect(c, ox + 7, oy + 1, 2, 13, PALETTE.metal);
  vline(c, ox + 7, oy + 1, 13, PALETTE.metalLight);
  ellipse(c, ox + 8, oy + 4, 4, 3, PALETTE.glowEdge);
  rect(c, ox + 6, oy + 2, 4, 4, PALETTE.glass);
  rect(c, ox + 7, oy + 3, 2, 2, PALETTE.glowCore);
  rect(c, ox + 5, oy + 14, 6, 1, PALETTE.metalDark);
}

function mushroom(c, ox, oy, seed) {
  const r = rng(seed);
  materialBase(c, ox, oy, 'grass', 0x1313);
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

function well(c, ox, oy) {
  // roof posts
  vline(c, ox + 3, oy + 8, 12, PALETTE.trunk);
  vline(c, ox + 28, oy + 8, 12, PALETTE.trunk);
  // roof
  for (let i = 0; i < 12; i++) hline(c, ox + 2 + i, oy + 2 + i, 30 - i * 2, PALETTE.trunkDark);
  hline(c, ox + 1, oy + 13, 30, PALETTE.trunk);
  // stone ring
  rect(c, ox + 4, oy + 20, 24, 11, PALETTE.stone);
  rect(c, ox + 4, oy + 20, 24, 1, PALETTE.stoneLight);
  rect(c, ox + 4, oy + 30, 24, 1, PALETTE.stoneDark);
  for (let i = 0; i < 6; i++) vline(c, ox + 6 + i * 4, oy + 21, 9, PALETTE.stoneDark);
  // water
  rect(c, ox + 7, oy + 24, 18, 5, PALETTE.water);
  hline(c, ox + 7, oy + 24, 18, PALETTE.waterLight);
}

function bench(c, ox, oy) {
  rect(c, ox + 2, oy + 7, 28, 3, PALETTE.wood);
  hline(c, ox + 2, oy + 7, 28, PALETTE.trunkLight);
  hline(c, ox + 2, oy + 9, 28, PALETTE.woodDark);
  vline(c, ox + 5, oy + 10, 4, PALETTE.woodDark);
  vline(c, ox + 26, oy + 10, 4, PALETTE.woodDark);
  vline(c, ox + 5, oy + 4, 3, PALETTE.wood);
  vline(c, ox + 26, oy + 4, 3, PALETTE.wood);
}

function table(c, ox, oy) {
  rect(c, ox + 3, oy + 6, 26, 3, PALETTE.wood);
  hline(c, ox + 3, oy + 6, 26, PALETTE.trunkLight);
  hline(c, ox + 3, oy + 8, 26, PALETTE.woodDark);
  vline(c, ox + 5, oy + 9, 6, PALETTE.woodDark);
  vline(c, ox + 26, oy + 9, 6, PALETTE.woodDark);
  // a mug and a plate, so the table is set rather than empty
  rect(c, ox + 8, oy + 3, 3, 3, PALETTE.metalLight);
  ellipse(c, ox + 20, oy + 5, 3, 1, PALETTE.paper);
}

function chest(c, ox, oy) {
  rect(c, ox + 2, oy + 6, 12, 8, PALETTE.wood);
  rect(c, ox + 2, oy + 3, 12, 4, PALETTE.woodDark);
  hline(c, ox + 2, oy + 3, 12, PALETTE.trunk);
  rect(c, ox + 7, oy + 7, 2, 3, PALETTE.gold);
  hline(c, ox + 2, oy + 9, 12, PALETTE.goldDark);
}

function statue(c, ox, oy) {
  rect(c, ox + 5, oy + 22, 6, 9, PALETTE.stone);
  rect(c, ox + 3, oy + 30, 10, 2, PALETTE.stoneDark);
  ellipse(c, ox + 8, oy + 8, 4, 4, PALETTE.stone);
  rect(c, ox + 5, oy + 12, 6, 10, PALETTE.stone);
  hline(c, ox + 4, oy + 21, 8, PALETTE.stoneLight);
  vline(c, ox + 5, oy + 12, 9, PALETTE.stoneLight);
  vline(c, ox + 10, oy + 12, 9, PALETTE.stoneDark);
}

function cauldron(c, ox, oy) {
  ellipse(c, ox + 8, oy + 10, 6, 4, PALETTE.metalDark);
  rect(c, ox + 3, oy + 8, 11, 5, PALETTE.metalDark);
  hline(c, ox + 3, oy + 8, 11, PALETTE.metal);
  ellipse(c, ox + 8, oy + 8, 5, 2, [120, 190, 120]);
  vline(c, ox + 4, oy + 13, 2, PALETTE.metalDark);
  vline(c, ox + 12, oy + 13, 2, PALETTE.metalDark);
}

function pot(c, ox, oy) {
  ellipse(c, ox + 8, oy + 10, 4, 4, [186, 108, 76]);
  rect(c, ox + 5, oy + 6, 7, 2, [206, 128, 92]);
  hline(c, ox + 5, oy + 6, 7, [150, 82, 56]);
}

function bucket(c, ox, oy) {
  rect(c, ox + 4, oy + 8, 8, 6, PALETTE.wood);
  hline(c, ox + 4, oy + 8, 8, PALETTE.woodDark);
  hline(c, ox + 4, oy + 13, 8, PALETTE.woodDark);
  for (let i = 0; i < 5; i++) plot(c, ox + 4 + i, oy + 6 + Math.floor(i / 2), PALETTE.metalDark);
  for (let i = 0; i < 5; i++) plot(c, ox + 11 - i, oy + 6 + Math.floor(i / 2), PALETTE.metalDark);
}

function torch(c, ox, oy) {
  rect(c, ox + 7, oy + 7, 2, 8, PALETTE.trunk);
  vline(c, ox + 7, oy + 7, 8, PALETTE.trunkLight);
  ellipse(c, ox + 8, oy + 4, 3, 3, PALETTE.glowEdge);
  ellipse(c, ox + 8, oy + 3, 2, 2, PALETTE.glowCore);
  plot(c, ox + 8, oy, [255, 120, 60]);
  rect(c, ox + 6, oy + 14, 4, 1, PALETTE.metalDark);
}

// Trees: 2x4 and 2x3 cells.
put(1, 'tree', 2, 4, (c, ox, oy) => conifer(c, ox, oy, 0x5eed, 0));
put(1, 'tree_dark', 2, 4, (c, ox, oy) => conifer(c, ox, oy, 0x5eee, 1));
put(1, 'tree_broad', 2, 3, (c, ox, oy) => broadleaf(c, ox, oy, 0x2b1e));
put(1, 'tree_dead', 2, 3, (c, ox, oy) => deadTree(c, ox, oy, 0x3c2d));

// Standing props: one cell each.
put(1, 'bush', 1, 1, (c, ox, oy) => bush(c, ox, oy, 0x1234, 0));
put(1, 'bush_light', 1, 1, (c, ox, oy) => bush(c, ox, oy, 0x1235, 1));
put(1, 'rock', 1, 1, (c, ox, oy) => rock(c, ox, oy, 0x4321, 1));
put(1, 'rock_small', 1, 1, (c, ox, oy) => rock(c, ox, oy, 0x4322, 0));
put(1, 'rock_large', 1, 1, (c, ox, oy) => rock(c, ox, oy, 0x4323, 2));
put(1, 'fence', 1, 1, fenceH);
put(1, 'fence_v', 1, 1, fenceV);
put(1, 'fence_corner', 1, 1, fenceCorner);
put(1, 'stump', 1, 1, (c, ox, oy) => stump(c, ox, oy, 0xabcd));
put(1, 'log', 1, 1, log);
put(1, 'crate', 1, 1, crate);
put(1, 'barrel', 1, 1, barrel);
put(1, 'sign', 1, 1, signPost);
put(1, 'lantern', 1, 1, lantern);
put(1, 'lamp', 1, 1, lampPost);
put(1, 'mushroom', 1, 1, (c, ox, oy) => mushroom(c, ox, oy, 0x9911));
put(1, 'chest', 1, 1, chest);
put(1, 'cauldron', 1, 1, cauldron);
put(1, 'pot', 1, 1, pot);
put(1, 'bucket', 1, 1, bucket);
put(1, 'torch', 1, 1, torch);

// Furniture: two cells wide.
put(1, 'bench', 2, 1, bench);
put(1, 'table', 2, 1, table);
// Structures.
put(1, 'well', 2, 2, well);
put(1, 'statue', 1, 2, statue);

// ── page 2: the character and a set of icons ────────────────────────────────
//
// The character is four facings of three layers. Back and front are drawn from
// the same skeleton with different features; the side view is drawn once and
// mirrored, because a profile is symmetric in structure even when it is not in
// pixels.

/// One facing's body. `facing` is 'back' | 'front' | 'side'.
function charBody(c, ox, oy, facing, shirt, shirtLight, shirtDark) {
  const S = PALETTE;
  // head: 6 wide, 4 wide at the crown and chin
  spans(c, ox, oy, [
    [ 2, 6,  9, S.skinLight],
    [ 3, 5, 10, S.skin],
  ]);
  rect(c, ox + 5, oy + 4, 6, 5, S.skin);
  hline(c, ox + 6, oy + 5, 2, S.skinLight);
  vline(c, ox + 10, oy + 4, 5, S.skinDark);
  spans(c, ox, oy, [[10, 6, 9, S.skin]]);

  if (facing === 'front') {
    // eyes and a mouth: the difference between a back view and a face
    plot(c, ox + 6, oy + 6, S.skinDark);
    plot(c, ox + 9, oy + 6, S.skinDark);
    plot(c, ox + 7, oy + 8, S.skinDark);
    plot(c, ox + 8, oy + 8, S.skinDark);
  } else if (facing === 'side') {
    // one eye, near the silhouette's edge, and a nose bump
    plot(c, ox + 9, oy + 6, S.skinDark);
    plot(c, ox + 10, oy + 7, S.skin);
    plot(c, ox + 10, oy + 8, S.skinDark);
  }

  // neck
  spans(c, ox, oy, [[11, 7, 8, S.skinDark]]);
  // shoulders and torso
  spans(c, ox, oy, [
    [12, 5, 10, shirtLight],
    [13, 4, 11, shirt],
  ]);
  rect(c, ox + 4, oy + 14, 8, 8, shirt);
  vline(c, ox + 11, oy + 14, 8, shirtDark);
  vline(c, ox + 4, oy + 14, 8, shirtLight);
  spans(c, ox, oy, [[22, 5, 10, shirtDark]]);

  if (facing === 'side') {
    // one arm forward, one behind: a profile does not show both shoulders
    vline(c, ox + 5, oy + 14, 7, shirtLight);
    vline(c, ox + 11, oy + 14, 7, shirtDark);
    vline(c, ox + 5, oy + 21, 2, S.skin);
  } else {
    vline(c, ox + 3, oy + 14, 7, shirt);
    vline(c, ox + 12, oy + 14, 7, shirtDark);
    vline(c, ox + 3, oy + 21, 2, S.skin);
    vline(c, ox + 12, oy + 21, 2, S.skinDark);
  }

  // legs
  if (facing === 'side') {
    rect(c, ox + 5, oy + 23, 5, 5, S.trousers);
    vline(c, ox + 5, oy + 23, 5, S.trousersLt);
    rect(c, ox + 5, oy + 28, 6, 2, S.boot);
  } else {
    rect(c, ox + 4, oy + 23, 4, 5, S.trousers);
    rect(c, ox + 8, oy + 23, 4, 5, S.trousers);
    vline(c, ox + 4, oy + 23, 5, S.trousersLt);
    vline(c, ox + 11, oy + 23, 5, S.shadow);
    rect(c, ox + 4, oy + 28, 4, 2, S.boot);
    rect(c, ox + 8, oy + 28, 4, 2, S.boot);
  }
  spans(c, ox, oy, [[30, 4, 11, S.shadow]]);
}

/// The hair. A back view is solid from crown to nape; a front view is a fringe.
/// The falls reach y=18 so they lie over the backpack's top rows — that overlap
/// is the pixel the composite probe reads, and a style that stopped at the neck
/// would make "which layer is on top" unaskable.
function charHair(c, ox, oy, facing, long) {
  const S = PALETTE;
  spans(c, ox, oy, [
    [ 1, 6,  9, S.hairLight],
    [ 2, 5, 10, S.hair],
    [ 3, 4, 11, S.hair],
  ]);
  hline(c, ox + 6, oy + 1, 3, S.hairLight);
  hline(c, ox + 4, oy + 4, 2, S.hairLight);
  vline(c, ox + 7, oy + 1, 2, S.hairLight);

  if (facing === 'front') {
    // A fringe over the brow and two side locks: the whole point of a front
    // view is that the face is visible, so this stops at y=5 rather than
    // covering the head the way the back view's solid mass does.
    rect(c, ox + 4, oy + 4, 8, 2, S.hair);
    hline(c, ox + 4, oy + 4, 8, S.hairLight);
    rect(c, ox + 4, oy + 6, 1, 8, S.hair);
    rect(c, ox + 11, oy + 6, 1, 8, S.hair);
  } else {
    // The back of the head is hair from crown to nape, tapering into the two
    // falls. Drawn as a full-width block the whole way down it read as a
    // second tree trunk beside the first; the taper is what makes it a head.
    rect(c, ox + 4, oy + 4, 8, 8, S.hair);
    spans(c, ox, oy, [[12, 5, 10, S.hair], [13, 5, 10, S.hair]]);
    vline(c, ox + 6, oy + 5, 7, S.hairLight);
    plot(c, ox + 9, oy + 7, S.hairLight);
    plot(c, ox + 9, oy + 10, S.hairLight);
  }

  const depth = long ? 5 : 5;
  for (const [x0, x1] of [[4, 5], [10, 11]]) {
    rect(c, ox + x0, oy + 14, x1 - x0 + 1, depth, S.hair);
    vline(c, ox + x0, oy + 14, depth, S.hairLight);
  }
}

/// The backpack: straps, a lid, and a body inset from the silhouette so the
/// arms stay visible. Drawn from y=13, which is what puts its top rows under
/// the hair.
function charPack(c, ox, oy) {
  const S = PALETTE;
  vline(c, ox + 5, oy + 11, 4, S.packDark);
  vline(c, ox + 10, oy + 11, 4, S.packDark);
  spans(c, ox, oy, [
    [15, 5, 10, S.packLight],
    [16, 4, 11, S.pack],
  ]);
  rect(c, ox + 4, oy + 17, 8, 7, S.pack);
  vline(c, ox + 4, oy + 17, 7, S.packLight);
  vline(c, ox + 11, oy + 17, 7, S.packDark);
  spans(c, ox, oy, [[24, 5, 10, S.packDark]]);
  hline(c, ox + 4, oy + 21, 8, S.packDark);
  rect(c, ox + 7, oy + 18, 2, 2, S.packLight);
}

const FACINGS = ['back', 'front', 'side', 'side_r'];
const SHIRTS = {
  blue: [PALETTE.shirt, PALETTE.shirtLight, PALETTE.shirtDark],
  red: [[176, 74, 68], [204, 98, 90], [134, 52, 48]],
};

for (const [si, shirtName] of Object.keys(SHIRTS).entries()) {
  const [s, sl, sd] = SHIRTS[shirtName];
  for (const facing of FACINGS) {
    const suffix = si === 0 ? (facing === 'back' ? '' : `_${facing}`) : `_${shirtName}` +
      (facing === 'back' ? '' : `_${facing}`);
    const mirrored = facing === 'side_r';
    const base = mirrored ? 'side' : facing;

    put(2, `body${suffix}`, 1, 2, (c, ox, oy) => {
      charBody(c, ox, oy, base, s, sl, sd);
      if (mirrored) mirrorX(c, ox, oy, TILE, 32);
    });
    if (si === 0) {
      put(2, `hair${suffix}`, 1, 2, (c, ox, oy) => {
        charHair(c, ox, oy, base, false);
        if (mirrored) mirrorX(c, ox, oy, TILE, 32);
      });
      put(2, `backpack${suffix}`, 1, 2, (c, ox, oy) => {
        charPack(c, ox, oy);
        if (mirrored) mirrorX(c, ox, oy, TILE, 32);
      });
    }
  }
}

// ── icons ───────────────────────────────────────────────────────────────────
//
// Sixteen 16x16 pickups. Small, but they make the third page dense and they are
// a second, independent check that a page can hold many unrelated sprites.

/// Icons take `(c, ox, oy)` like every other draw function — the earlier
/// version took a single origin and used it for both axes, which drew every
/// icon at `(x, x)` and put all sixteen off the page.
const ICONS = {
  coin: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 8, 5, 5, PALETTE.gold);
    ellipse(c, ox + 8, oy + 8, 3, 3, PALETTE.goldDark);
    plot(c, ox + 8, oy + 6, PALETTE.gold);
  },
  gem: (c, ox, oy) => {
    spans(c, ox, oy, [
      [4, 7, 8, PALETTE.gem], [5, 5, 10, PALETTE.gem], [6, 4, 11, PALETTE.gem],
      [7, 5, 10, PALETTE.gemDark], [8, 6, 9, PALETTE.gemDark],
    ]);
    plot(c, ox + 6, oy + 5, [200, 255, 250]);
  },
  potion: (c, ox, oy) => {
    rect(c, ox + 6, oy + 8, 4, 6, PALETTE.potion);
    rect(c, ox + 6, oy + 5, 4, 3, PALETTE.potion);
    hline(c, ox + 5, oy + 4, 6, PALETTE.potionDark);
    plot(c, ox + 7, oy + 9, [255, 200, 220]);
  },
  key: (c, ox, oy) => {
    ellipse(c, ox + 6, oy + 6, 3, 3, PALETTE.gold);
    ellipse(c, ox + 6, oy + 6, 1, 1, PALETTE.paper);
    rect(c, ox + 8, oy + 6, 5, 2, PALETTE.gold);
    vline(c, ox + 10, oy + 8, 2, PALETTE.gold);
    vline(c, ox + 13, oy + 8, 2, PALETTE.gold);
  },
  sword: (c, ox, oy) => {
    for (let i = 0; i < 8; i++) plot(c, ox + 4 + i, oy + 11 - i, PALETTE.stoneLight);
    for (let i = 0; i < 8; i++) plot(c, ox + 5 + i, oy + 11 - i, PALETTE.stone);
    hline(c, ox + 3, oy + 11, 5, PALETTE.gold);
    rect(c, ox + 2, oy + 12, 3, 2, PALETTE.woodDark);
  },
  shield: (c, ox, oy) => {
    spans(c, ox, oy, [
      [3, 5, 10, PALETTE.metal], [4, 4, 11, PALETTE.metal],
      [5, 4, 11, PALETTE.metalLight], [6, 4, 11, PALETTE.metal],
      [7, 5, 10, PALETTE.metal], [8, 6, 9, PALETTE.metalDark],
    ]);
    vline(c, ox + 8, oy + 4, 5, PALETTE.gold);
  },
  heart: (c, ox, oy) => {
    ellipse(c, ox + 6, oy + 7, 3, 3, [220, 70, 90]);
    ellipse(c, ox + 10, oy + 7, 3, 3, [220, 70, 90]);
    spans(c, ox, oy, [
      [8, 4, 12, [220, 70, 90]], [9, 5, 11, [220, 70, 90]],
      [10, 6, 10, [220, 70, 90]], [11, 7, 9, [220, 70, 90]],
    ]);
  },
  star: (c, ox, oy) => {
    // Five points, drawn as a filled pentagram: a centre disc and five spokes.
    ellipse(c, ox + 8, oy + 8, 2, 2, PALETTE.gold);
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      for (let d = 1; d <= 4; d++) {
        plot(c, ox + 8 + Math.cos(a) * d, oy + 8 + Math.sin(a) * d, PALETTE.gold);
      }
    }
  },
  scroll: (c, ox, oy) => {
    rect(c, ox + 4, oy + 4, 8, 8, PALETTE.paper);
    hline(c, ox + 4, oy + 4, 8, PALETTE.paperDark);
    hline(c, ox + 4, oy + 11, 8, PALETTE.paperDark);
    hline(c, ox + 5, oy + 6, 6, PALETTE.paperDark);
    hline(c, ox + 5, oy + 8, 5, PALETTE.paperDark);
  },
  boot: (c, ox, oy) => {
    rect(c, ox + 5, oy + 4, 4, 6, PALETTE.trunk);
    rect(c, ox + 5, oy + 10, 7, 2, PALETTE.trunkDark);
    hline(c, ox + 5, oy + 4, 4, PALETTE.trunkLight);
  },
  ring: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 9, 4, 4, PALETTE.gold);
    ellipse(c, ox + 8, oy + 9, 2, 2, PALETTE.shadow);
    plot(c, ox + 7, oy + 4, PALETTE.gem);
    plot(c, ox + 8, oy + 4, PALETTE.gem);
    plot(c, ox + 9, oy + 4, PALETTE.gem);
    plot(c, ox + 8, oy + 3, PALETTE.gem);
  },
  map: (c, ox, oy) => {
    rect(c, ox + 3, oy + 4, 10, 8, PALETTE.paper);
    for (let i = 0; i < 8; i++) {
      plot(c, ox + 4 + i, oy + 6 + Math.round(Math.sin(i) * 2) + 1, PALETTE.paperDark);
    }
    plot(c, ox + 10, oy + 6, [200, 70, 70]);
  },
  bomb: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 9, 5, 5, PALETTE.metalDark);
    ellipse(c, ox + 6, oy + 7, 2, 2, PALETTE.metal);
    vline(c, ox + 10, oy + 3, 3, PALETTE.trunk);
    plot(c, ox + 11, oy + 2, PALETTE.glowEdge);
  },
  apple: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 9, 4, 4, [198, 66, 60]);
    plot(c, ox + 6, oy + 8, [230, 120, 110]);
    vline(c, ox + 8, oy + 4, 2, PALETTE.leafDark);
    plot(c, ox + 9, oy + 4, PALETTE.leaf);
  },
  book: (c, ox, oy) => {
    rect(c, ox + 3, oy + 4, 10, 8, [120, 70, 140]);
    rect(c, ox + 3, oy + 4, 1, 8, [90, 50, 108]);
    hline(c, ox + 5, oy + 6, 6, PALETTE.paper);
    hline(c, ox + 5, oy + 8, 6, PALETTE.paper);
  },
  torch: (c, ox, oy) => {
    rect(c, ox + 7, oy + 8, 2, 5, PALETTE.trunk);
    ellipse(c, ox + 8, oy + 5, 3, 3, PALETTE.glowEdge);
    ellipse(c, ox + 8, oy + 4, 2, 2, PALETTE.glowCore);
  },

  // A second set, so the page holds as many unrelated sprites as it can. These
  // are the shapes a game notices are missing first: weapons, loot and props
  // that are not furniture.
  arrow: (c, ox, oy) => {
    for (let i = 0; i < 9; i++) plot(c, ox + 3 + i, oy + 12 - i, PALETTE.trunkLight);
    for (let i = 0; i < 3; i++) { plot(c, ox + 4 + i, oy + 12 - i, PALETTE.stoneDark); }
    plot(c, ox + 11, oy + 3, PALETTE.stoneLight);
    plot(c, ox + 10, oy + 3, PALETTE.stoneLight);
    plot(c, ox + 11, oy + 4, PALETTE.stoneLight);
    plot(c, ox + 3, oy + 13, PALETTE.leafPale);
    plot(c, ox + 2, oy + 12, PALETTE.leafPale);
    plot(c, ox + 4, oy + 14, PALETTE.leafPale);
  },
  axe: (c, ox, oy) => {
    vline(c, ox + 6, oy + 4, 9, PALETTE.trunk);
    vline(c, ox + 7, oy + 4, 9, PALETTE.trunkDark);
    spans(c, ox, oy, [
      [3, 8, 12, PALETTE.stoneLight], [4, 7, 12, PALETTE.stone],
      [5, 8, 12, PALETTE.stone], [6, 9, 12, PALETTE.stoneDark],
    ]);
  },
  hammer: (c, ox, oy) => {
    vline(c, ox + 7, oy + 5, 8, PALETTE.trunk);
    rect(c, ox + 4, oy + 3, 8, 4, PALETTE.metal);
    hline(c, ox + 4, oy + 3, 8, PALETTE.metalLight);
    hline(c, ox + 4, oy + 6, 8, PALETTE.metalDark);
  },
  pickaxe: (c, ox, oy) => {
    vline(c, ox + 7, oy + 5, 8, PALETTE.trunk);
    for (let i = 0; i < 5; i++) {
      plot(c, ox + 5 + i, oy + 4 + Math.abs(2 - i) * -1 + 1, PALETTE.metal);
      plot(c, ox + 9 + (i - 2), oy + 3 + i, PALETTE.metal);
    }
    hline(c, ox + 5, oy + 6, 6, PALETTE.metalLight);
  },
  bow: (c, ox, oy) => {
    for (let i = 0; i < 9; i++) {
      const t = (i / 8) * Math.PI;
      plot(c, ox + 4 + Math.sin(t) * 5, oy + 3 + i, PALETTE.trunk);
    }
    for (let i = 0; i < 9; i++) plot(c, ox + 9, oy + 3 + i, PALETTE.paper);
  },
  crown: (c, ox, oy) => {
    spans(c, ox, oy, [
      [5, 4, 11, PALETTE.gold], [6, 4, 11, PALETTE.gold],
      [7, 4, 11, PALETTE.goldDark], [8, 4, 11, PALETTE.gold],
    ]);
    plot(c, ox + 4, oy + 4, PALETTE.gold); plot(c, ox + 4, oy + 3, PALETTE.gold);
    plot(c, ox + 8, oy + 3, PALETTE.gold); plot(c, ox + 8, oy + 4, PALETTE.gold);
    plot(c, ox + 11, oy + 3, PALETTE.gold); plot(c, ox + 11, oy + 4, PALETTE.gold);
    plot(c, ox + 8, oy + 6, PALETTE.gem);
  },
  skull: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 7, 5, 4, PALETTE.paper);
    rect(c, ox + 6, oy + 10, 5, 3, PALETTE.paper);
    plot(c, ox + 6, oy + 7, PALETTE.shadow); plot(c, ox + 10, oy + 7, PALETTE.shadow);
    plot(c, ox + 8, oy + 9, PALETTE.shadow);
  },
  bell: (c, ox, oy) => {
    spans(c, ox, oy, [
      [4, 7, 8, PALETTE.gold], [5, 6, 9, PALETTE.gold], [6, 5, 10, PALETTE.gold],
      [7, 5, 10, PALETTE.gold], [8, 4, 11, PALETTE.goldDark],
    ]);
    plot(c, ox + 8, oy + 10, PALETTE.goldDark);
    plot(c, ox + 8, oy + 3, PALETTE.goldDark);
  },
  feather: (c, ox, oy) => {
    for (let i = 0; i < 8; i++) {
      plot(c, ox + 5 + i, oy + 10 - i, PALETTE.paper);
      plot(c, ox + 6 + i, oy + 10 - i, PALETTE.paperDark);
    }
    vline(c, ox + 5, oy + 11, 2, PALETTE.metalDark);
  },
  fish: (c, ox, oy) => {
    ellipse(c, ox + 7, oy + 8, 4, 3, [120, 160, 190]);
    spans(c, ox, oy, [[6, 11, 13, [120, 160, 190]], [7, 11, 13, [120, 160, 190]], [8, 11, 12, [120, 160, 190]]]);
    plot(c, ox + 5, oy + 7, PALETTE.shadow);
  },
  bread: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 8, 5, 3, [198, 150, 90]);
    hline(c, ox + 5, oy + 6, 6, [226, 186, 130]);
    plot(c, ox + 6, oy + 8, [160, 116, 66]);
    plot(c, ox + 9, oy + 8, [160, 116, 66]);
  },
  cheese: (c, ox, oy) => {
    spans(c, ox, oy, [[6, 4, 11, PALETTE.gold], [7, 4, 11, PALETTE.gold], [8, 5, 11, PALETTE.goldDark]]);
    plot(c, ox + 6, oy + 7, PALETTE.goldDark);
    plot(c, ox + 9, oy + 6, PALETTE.goldDark);
  },
  compass: (c, ox, oy) => {
    ellipse(c, ox + 8, oy + 8, 5, 5, PALETTE.metal);
    ellipse(c, ox + 8, oy + 8, 3, 3, PALETTE.paper);
    plot(c, ox + 8, oy + 5, [200, 70, 70]);
    plot(c, ox + 8, oy + 6, [200, 70, 70]);
    plot(c, ox + 8, oy + 10, PALETTE.metalDark);
  },
  hourglass: (c, ox, oy) => {
    hline(c, ox + 5, oy + 4, 6, PALETTE.wood);
    hline(c, ox + 5, oy + 11, 6, PALETTE.wood);
    spans(c, ox, oy, [
      [5, 7, 8, PALETTE.glass], [6, 6, 9, PALETTE.gold], [7, 7, 8, PALETTE.gold],
      [8, 7, 8, PALETTE.paper], [9, 6, 9, PALETTE.paper], [10, 7, 8, PALETTE.paper],
    ]);
  },
  crystal: (c, ox, oy) => {
    spans(c, ox, oy, [
      [3, 8, 8, PALETTE.gem], [4, 7, 9, PALETTE.gem], [5, 6, 10, PALETTE.gem],
      [6, 6, 10, PALETTE.gemDark], [7, 6, 10, PALETTE.gem],
      [8, 6, 10, PALETTE.gemDark], [9, 7, 9, PALETTE.gemDark], [10, 8, 8, PALETTE.gemDark],
    ]);
    plot(c, ox + 7, oy + 5, [220, 255, 250]);
  },
  bone: (c, ox, oy) => {
    for (let i = 0; i < 7; i++) plot(c, ox + 5 + i, oy + 10 - Math.floor(i / 2), PALETTE.paper);
    ellipse(c, ox + 4, oy + 10, 1, 1, PALETTE.paper);
    ellipse(c, ox + 4, oy + 11, 1, 1, PALETTE.paper);
    ellipse(c, ox + 12, oy + 7, 1, 1, PALETTE.paper);
    ellipse(c, ox + 12, oy + 8, 1, 1, PALETTE.paper);
  },
};

for (const [name, draw] of Object.entries(ICONS)) {
  put(2, `icon_${name}`, 1, 1, draw);
}

// ── packing ─────────────────────────────────────────────────────────────────
//
// First-fit, row-major, tallest first. Sorting by height before scanning keeps
// the tall pieces (the 2x4 trees) from leaving a 1-cell column that nothing can
// fill. No coordinates are written by hand anywhere: `LAYOUT` below is the
// packer's output, not its input.

function pack() {
  const occupancy = Array.from({ length: PAGE_COUNT }, () =>
    Array.from({ length: GRID }, () => new Array(GRID).fill(null)));

  // Tallest first, then widest, then registration order — stable within a size
  // so the output does not depend on sort implementation details.
  const order = PIECES
    .map((piece, index) => ({ piece, index }))
    .sort((a, b) =>
      b.piece.ch - a.piece.ch ||
      b.piece.cw - a.piece.cw ||
      a.index - b.index);

  const free = (page, x, y, cw, ch) => {
    for (let dy = 0; dy < ch; dy++) {
      for (let dx = 0; dx < cw; dx++) {
        if (occupancy[page][y + dy][x + dx] !== null) return false;
      }
    }
    return true;
  };

  const placed = new Map();
  for (const { piece } of order) {
    let spot = null;
    for (let y = 0; !spot && y + piece.ch <= GRID; y++) {
      for (let x = 0; x + piece.cw <= GRID; x++) {
        if (!free(piece.page, x, y, piece.cw, piece.ch)) continue;
        spot = { x, y };
        break;
      }
    }
    if (!spot) {
      throw new Error(
        `build-tileset: \`${piece.name}\` (${piece.cw}x${piece.ch} cells) does not fit ` +
        `on page ${piece.page}; that page holds ${GRID}x${GRID}. Grow GRID, add a page, ` +
        `or drop a tile — do not ship a sheet with a hole where it should be.`,
      );
    }
    for (let dy = 0; dy < piece.ch; dy++) {
      for (let dx = 0; dx < piece.cw; dx++) {
        occupancy[piece.page][spot.y + dy][spot.x + dx] = piece.name;
      }
    }
    placed.set(piece.name, { page: piece.page, x: spot.x * TILE, y: spot.y * TILE,
                             w: piece.cw * TILE, h: piece.ch * TILE });
  }
  return { placed, occupancy };
}

const { placed, occupancy } = pack();

/// Each page's fill fraction, for the report and the assertion.
const density = occupancy.map((grid) =>
  grid.flat().filter((cell) => cell !== null).length / (GRID * GRID));

// ── the layout table ────────────────────────────────────────────────────────

/// Where every piece lives, in *sheet* pixels. Named pieces are the packer's
/// output; aliases below point several names at one rect so the scene can ask
/// for `grass0` without a second copy of the same tile.
export const LAYOUT = {
  ...Object.fromEntries(placed),
  // The scene's ground variety: four grass tiles that differ, so a 6x6 field
  // is not one swatch repeated 36 times.
  grass0: placed.get('grass15'),
  grass1: placed.get('grass_deco0'),
  grass2: placed.get('grass_deco1'),
  grass3: placed.get('grass_extra0'),
};

/// `LAYOUT` values are page-local, because a record's `tex` already names the
/// page. The packer works in sheet coordinates, so convert once here rather
/// than in every consumer.
for (const [name, rect] of Object.entries(LAYOUT)) {
  LAYOUT[name] = { ...rect, x: rect.x + rect.page * PAGE };
}

// ── draw ────────────────────────────────────────────────────────────────────

export function drawSheet() {
  const sheet = canvas(SHEET_W, SHEET_H);
  for (const piece of PIECES) {
    const cell = placed.get(piece.name);
    const ox = cell.page * PAGE + cell.x;
    const oy = cell.y;
    piece.draw(sheet, ox, oy);
  }
  return sheet;
}

/// Per-page fill fractions, keyed by page index. Exported so a caller can print
/// them without re-deriving the packer.
export function pageDensity() {
  return density.slice();
}

// ── main ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  let out = here;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i]);
  }

  const sparse = density
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d < MIN_DENSITY);
  if (sparse.length) {
    console.error(
      'build-tileset: page(s) ' +
      sparse.map(({ d, i }) => `${i} at ${(d * 100).toFixed(0)}%`).join(', ') +
      ` are under the ${(MIN_DENSITY * 100).toFixed(0)}% fill floor. Add tiles, or ` +
      'shrink GRID — a page that is mostly transparent wastes texture memory and ' +
      'reads as an unfinished asset.',
    );
    process.exit(1);
  }

  mkdirSync(out, { recursive: true });
  const sheet = drawSheet();
  const file = join(out, 'tileset.png');
  writeFileSync(file, encodePng(sheet.w, sheet.h, sheet.data));
  console.log(
    `build-tileset: ${file} ${sheet.w}x${sheet.h}, ${PIECES.length} pieces, ` +
    `${PAGE_COUNT} pages of ${PAGE}px`,
  );
  console.log(
    'build-tileset: fill ' +
    density.map((d, i) => `page${i} ${(d * 100).toFixed(0)}%`).join(', ') +
    ` (floor ${(MIN_DENSITY * 100).toFixed(0)}%)`,
  );
}
