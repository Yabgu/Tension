#!/usr/bin/env node
// Bake real font outlines into the UI atlas: TTF/OTF in, IWI pages + a manifest
// + the guest's metrics table out.
//
// ## Why this replaces the VGA bitmap table
//
// `make-font.mjs` bakes an 8x16 ROM font. It is legible, it is monospace, and it
// is the reason the toolkit is arithmetic instead of measurement — every glyph
// advances one cell, so "does this fit" is a division. A UI toolkit that lays out
// real panels needs real text: proportional advances, a real bold face, and two
// sizes. So this tool takes outlines, rasterizes them at the exact pixel size
// they will be drawn at, and writes the same IWI container the 2D renderer
// already decodes (`tension-core/src/render2d/iwi.rs`).
//
// ## The three constraints that decide everything here
//
// 1. **Nothing is scaled at draw time.** A sprite record carries one `w`/`h`
//    pair and the vertex shader uses it for the destination quad *and* the
//    source texel rect; the sampler is `Filter::Nearest` on all three axes. So a
//    glyph can only be drawn at the size it was baked at. One page per
//    (font, size) is the consequence, not a choice.
//
// 2. **The shader has no tint.** A record samples the atlas verbatim, so a
//    coloured glyph has to *be* a coloured glyph. Every (colour, weight) pair is
//    its own stripe of 95 cells — the same layout `make-font.mjs` uses, so the
//    cell formula the framework already implements (`colour * 190 + weight * 95
//    + code - 32`) is unchanged.
//
// 3. **Anti-aliasing has to be ours.** opentype.js parses and flattens glyph
//    outlines; it does not rasterize. The scanline rasterizer below is adaptive:
//    curves are subdivided until they are flat to 0.2 px, and each pixel row is
//    sampled by four horizontal sub-scanlines with exact fractional span ends.
//    That is what makes 14 px text read as text rather than as stairs, and it is
//    why the alpha channel is coverage rather than a 0/1 mask.
//
// ## Advances are quarter-pixels, and the reason is drift
//
// The painter places a glyph at an integer pixel, so a subpixel advance is not
// *drawable*. But rounding each advance to a whole pixel makes a 40-character
// line up to 20 px narrower than the font asks for, and the error grows with the
// line. So advances are stored in quarter-pixels (`FONT_ADVANCE_UNIT` = 4) and
// the painter rounds the *accumulated* position rather than each step: every
// glyph lands within an eighth of a pixel of where the font puts it, and the
// error never accumulates. It costs one shift per glyph.
//
// ## Usage
//
//     node tools/font/bake-ttf.mjs --spec assets/fonts/fonts.json \
//          --atlas assets --manifest assets/ui.json \
//          --ts ../assembly/ui/fonts.generated.ts
//
// An app bakes its own atlas by copying `assets/fonts/fonts.json`, pointing the
// `file` fields at its own faces, and running this from its own directory.
// Defaults are the app's: `assets/fonts/fonts.json`, `assets/`, `assets/ui.json`,
// `src/ui-fonts.generated.ts`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import opentype from 'opentype.js';

import { Surface } from '../lib/iwi.mjs';
import { encodePng } from '../lib/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

// ── the fixed part of the format ────────────────────────────────────────────

/** The characters every page bakes. ASCII printable, exactly as before. */
const FIRST_CHAR = 32;
const LAST_CHAR = 126;
const GLYPH_COUNT = LAST_CHAR - FIRST_CHAR + 1;   // 95

/** Air around a glyph's ink inside its cell, in pixels. */
const PAD = 1;
/** Horizontal sub-scanlines per pixel row. Four is where 14 px stops staircasing. */
const SUBSAMPLES = 4;
/** Curve flattening tolerance, in pixels. Tighter than a display can show. */
const TOLERANCE = 0.2;
/** Advance quantum: advances are stored in 1/ADVANCE_UNIT of a pixel. */
const ADVANCE_UNIT = 4;

/**
 * The palette, unchanged from `make-font.mjs`.
 *
 * The order *is* the ABI: `NORMAL` is 0 … `HEADING` is 4 in `ui/theme.ts`, and
 * a page's cell index is derived from these indices. Reordering this list is a
 * silent recolouring of every app, so it is listed once, here, and asserted
 * against the manifest at the bottom of this file.
 */
const COLOURS = [
  { index: 0, name: 'normal', rgb: [214, 214, 214], use: 'body text' },
  { index: 1, name: 'muted', rgb: [138, 138, 138], use: 'secondary labels, footnotes' },
  { index: 2, name: 'link', rgb: [108, 182, 255], use: 'links and cross-references' },
  { index: 3, name: 'code', rgb: [197, 233, 141], use: 'inline code and code blocks' },
  { index: 4, name: 'heading', rgb: [255, 255, 255], use: 'headings, which are asked for bold' },
];

const WEIGHTS = [
  { index: 0, name: 'regular' },
  { index: 1, name: 'bold' },
];

/** Solid cells past the glyph stripes, so any page can be used for chrome. */
const CHROME = [
  { name: 'white', rgb: [255, 255, 255], use: 'rules, dividers and underlines' },
  { name: 'caret', rgb: [235, 235, 235], use: 'the text cursor' },
  { name: 'selection', rgb: [45, 74, 107], use: 'a selection or a search hit' },
  { name: 'panel', rgb: [20, 20, 20], use: 'the page background' },
  { name: 'surface', rgb: [26, 27, 30], use: 'the sidebar and the code-block background' },
  { name: 'divider', rgb: [58, 58, 58], use: 'the 1px line between panes' },
  { name: 'track', rgb: [35, 35, 35], use: 'the scrollbar track' },
  { name: 'thumb', rgb: [90, 90, 90], use: 'the scrollbar thumb' },
  { name: 'underline', rgb: [108, 182, 255], use: 'a 1px rule under a link' },
  { name: 'code_bg', rgb: [24, 26, 24], use: 'the inset behind a code block' },
];

/** Cells per stripe: one per baked character. */
const STRIPE = GLYPH_COUNT;

// ── arguments ───────────────────────────────────────────────────────────────

function die(message) {
  process.stderr.write(`bake-ttf: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const opts = {
  spec: 'assets/fonts/fonts.json',
  atlasDir: 'assets',
  manifest: 'assets/ui.json',
  ts: 'src/ui-fonts.generated.ts',
  prefix: 'ui',
  preview: null,
  faces: '.',
};
for (let i = 0; i < argv.length; i++) {
  const take = () => {
    const value = argv[++i];
    if (value === undefined) die(`${argv[i - 1]} needs a value`);
    return value;
  };
  if (argv[i] === '--spec') opts.spec = take();
  else if (argv[i] === '--atlas') opts.atlasDir = take();
  else if (argv[i] === '--manifest') opts.manifest = take();
  else if (argv[i] === '--ts') opts.ts = take();
  else if (argv[i] === '--prefix') opts.prefix = take();
  else if (argv[i] === '--faces') opts.faces = take();
  else if (argv[i] === '--preview') opts.preview = take();
  else if (argv[i] === '--no-preview') opts.preview = null;
  else die(`unknown argument '${argv[i]}'`);
}

const specPath = resolve(process.cwd(), opts.spec);
let spec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
} catch (error) {
  die(`cannot read the spec at ${specPath}: ${error.message}`);
}
if (!spec.faces || !spec.pages || spec.pages.length === 0) {
  die(`${specPath} needs a "faces" object and a non-empty "pages" array`);
}

// ── the stripes ─────────────────────────────────────────────────────────────
//
// A *pair* is one (colour, weight) stripe of 95 cells. The old atlas baked the
// full 5 x 2 cross product because there was no reason not to; there is now,
// because a pair nobody draws is 95 cells of dead VRAM in every page. The list
// is declared by the spec and the painter looks a pair up through a ten-entry
// table, so a page may carry six pairs or ten and the cell arithmetic is the
// same shape either way.
const DEFAULT_PAIRS = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1]];
const PAIRS = (spec.pairs && spec.pairs.length ? spec.pairs : DEFAULT_PAIRS).map(
  ([colour, weight], slot) => {
    if (!COLOURS[colour]) die(`pair ${slot}: colour ${colour} is not in the palette`);
    if (!WEIGHTS[weight]) die(`pair ${slot}: weight ${weight} is not in the palette`);
    return { slot, colour, weight };
  });

/** `colour * 2 + weight` -> stripe slot, or 0xFF when the pair is not baked. */
const PAIR_SLOT = new Array(COLOURS.length * WEIGHTS.length).fill(0xff);
for (const pair of PAIRS) PAIR_SLOT[pair.colour * WEIGHTS.length + pair.weight] = pair.slot;

/** Distinct weights that actually have a stripe. */
const WEIGHTS_USED = [...new Set(PAIRS.map((pair) => pair.weight))].sort((a, b) => a - b);

const GLYPH_CELLS = PAIRS.length * STRIPE;
const CHROME_FIRST = GLYPH_CELLS;

// ── the outline source ──────────────────────────────────────────────────────

/// Parse one face. `opentype.parse` wants the bytes, not a path: `loadSync` is
/// deprecated in the version this tree pins, and it reaches the filesystem on
/// its own terms.
function loadFace(name, entry) {
  // `--faces` is the root a spec's `file` paths are read from. It exists so a
  // *consumer* can name a shared spec (`../../tension-framework/assets/fonts/
  // fonts.json`) without copying the typefaces into its own tree: the spec's
  // paths are written relative to the repository, and the app is not the
  // repository.
  const path = resolve(process.cwd(), opts.faces, entry.file);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    die(`face '${name}': cannot read ${path}: ${error.message}`);
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const font = opentype.parse(buffer);
  if (!font.unitsPerEm) die(`face '${name}': ${path} has no horizontal header`);
  return {
    name,
    path: entry.file,
    weight: entry.weight ?? 0,
    font,
    scale: 1,   // set per page: size / unitsPerEm
    size: 0,
  };
}

const faces = new Map();
for (const [name, entry] of Object.entries(spec.faces)) {
  faces.set(name, loadFace(name, entry));
}

// ── the rasterizer ──────────────────────────────────────────────────────────

/**
 * Flatten a glyph path into closed polygons, in the path's own pixel space.
 *
 * opentype's `Glyph#getPath(x, y, fontSize)` already emits absolute pixel
 * coordinates with y growing downward and the baseline at `y`, so there is no
 * transform to apply here — only curves to turn into segments.
 */
function flatten(path) {
  const polygons = [];
  let current = null;
  let px = 0;
  let py = 0;
  let startX = 0;
  let startY = 0;

  const push = (x, y) => {
    current.push([x, y]);
    px = x;
    py = y;
  };

  for (const command of path.commands) {
    switch (command.type) {
      case 'M':
        if (current && current.length > 2) polygons.push(current);
        current = [[command.x, command.y]];
        px = startX = command.x;
        py = startY = command.y;
        break;
      case 'L':
        push(command.x, command.y);
        break;
      case 'Q':
        flattenQuadratic(current, px, py, command.x1, command.y1, command.x, command.y);
        px = command.x;
        py = command.y;
        break;
      case 'C':
        flattenCubic(current, px, py, command.x1, command.y1, command.x2, command.y2,
                     command.x, command.y);
        px = command.x;
        py = command.y;
        break;
      case 'Z':
        if (current) {
          // Close explicitly: the scanline loop reads `i` and `(i+1) % n`, so a
          // contour whose last point is not its first would invent an edge from
          // the end back to the start — which is right — but only if the two
          // differ. Appending the start makes that edge explicit and keeps the
          // winding arithmetic honest for the one-point case.
          if (px !== startX || py !== startY) current.push([startX, startY]);
          if (current.length > 2) polygons.push(current);
          current = null;
          px = startX;
          py = startY;
        }
        break;
      default:
        die(`unsupported path command '${command.type}'`);
    }
  }
  if (current && current.length > 2) polygons.push(current);
  return polygons;
}

function flattenQuadratic(out, x0, y0, cx, cy, x1, y1) {
  // Flatness: the control point's distance from the chord. A quadratic is within
  // `d/2` of its chord, so `d <= 2 * TOLERANCE` is the subdivision test.
  const dx = x1 - x0;
  const dy = y1 - y0;
  const cross = Math.abs((cx - x0) * dy - (cy - y0) * dx);
  const length = Math.hypot(dx, dy);
  if (length > 0 && cross / length <= 2 * TOLERANCE) {
    out.push([x1, y1]);
    return;
  }
  const mx = (x0 + 2 * cx + x1) / 4;
  const my = (y0 + 2 * cy + y1) / 4;
  flattenQuadratic(out, x0, y0, (x0 + cx) / 2, (y0 + cy) / 2, mx, my);
  flattenQuadratic(out, mx, my, (cx + x1) / 2, (cy + y1) / 2, x1, y1);
}

function flattenCubic(out, x0, y0, c1x, c1y, c2x, c2y, x1, y1) {
  const d1 = Math.abs((c1x - x0) * (y1 - y0) - (c1y - y0) * (x1 - x0));
  const d2 = Math.abs((c2x - x0) * (y1 - y0) - (c2y - y0) * (x1 - x0));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length > 0 && Math.max(d1, d2) / length <= 3 * TOLERANCE) {
    out.push([x1, y1]);
    return;
  }
  const abx = (x0 + c1x) / 2, aby = (y0 + c1y) / 2;
  const bcx = (c1x + c2x) / 2, bcy = (c1y + c2y) / 2;
  const cdx = (c2x + x1) / 2, cdy = (c2y + y1) / 2;
  const abcx = (abx + bcx) / 2, abcy = (aby + bcy) / 2;
  const bcdx = (bcx + cdx) / 2, bcdy = (bcy + cdy) / 2;
  const mx = (abcx + bcdx) / 2, my = (abcy + bcdy) / 2;
  flattenCubic(out, x0, y0, abx, aby, abcx, abcy, mx, my);
  flattenCubic(out, mx, my, bcdx, bcdy, cdx, cdy, x1, y1);
}

/**
 * Rasterize polygons into a coverage buffer, in cell-local coordinates.
 *
 * Nonzero winding, four vertical sub-scanlines per row, exact horizontal
 * coverage at every span end. `originX`/`originY` are the cell's top-left in the
 * path's own space, so the result is indexed `y * cellW + x`.
 */
function rasterize(polygons, originX, originY, cellW, cellH) {
  const coverage = new Float32Array(cellW * cellH);
  if (polygons.length === 0) return coverage;

  // Every edge once, as `{x0,y0,x1,y1}` in cell-local space. Sorting the
  // crossings per sub-scanline is the whole of the algorithm; keeping the edges
  // pre-translated saves the subtraction in the inner loop.
  const edges = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ay = a[1] - originY;
      const by = b[1] - originY;
      if (ay === by) continue;   // horizontal edges never cross a scanline
      edges.push({ ax: a[0] - originX, ay, bx: b[0] - originX, by });
    }
  }

  const weight = 1 / SUBSAMPLES;
  const crossings = [];

  for (let row = 0; row < cellH; row++) {
    for (let s = 0; s < SUBSAMPLES; s++) {
      const sy = row + (s + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (const e of edges) {
        // Half-open in y so a vertex shared by two edges is counted once.
        if ((e.ay <= sy && e.by > sy) || (e.by <= sy && e.ay > sy)) {
          const t = (sy - e.ay) / (e.by - e.ay);
          crossings.push({ x: e.ax + t * (e.bx - e.ax), dir: e.by > e.ay ? 1 : -1 });
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((p, q) => p.x - q.x);

      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i++) {
        winding += crossings[i].dir;
        if (winding === 0) continue;
        addSpan(coverage, row * cellW, cellW, crossings[i].x, crossings[i + 1].x, weight);
      }
    }
  }

  // Clamp: two contours may overlap (a counter inside a bowl), and the sum is
  // linear in coverage, so >1 is possible and 1 is the most a pixel can hold.
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i] > 1) coverage[i] = 1;
  }
  return coverage;
}

/** Add a horizontal span's exact coverage to one row. */
function addSpan(coverage, rowBase, width, xa, xb, weight) {
  let a = xa;
  let b = xb;
  if (b <= a) return;
  if (a < 0) a = 0;
  if (b > width) b = width;
  if (b <= a) return;

  const ia = Math.floor(a);
  const ib = Math.floor(b);
  if (ia === ib) {
    coverage[rowBase + ia] += weight * (b - a);
    return;
  }
  coverage[rowBase + ia] += weight * (ia + 1 - a);
  for (let x = ia + 1; x < ib; x++) coverage[rowBase + x] += weight;
  if (ib < width) coverage[rowBase + ib] += weight * (b - ib);
}

// ── page geometry ───────────────────────────────────────────────────────────

/**
 * Everything a page needs to know about its own text, from the outlines.
 *
 * The cell is the **ink box**, not the line box. Using `hhea` ascent/descent
 * would make a 16x22 cell for 14 px Inter and waste a third of the atlas on
 * empty pixels; the ink of the 95 printable ASCII characters is what must fit,
 * and a line's pitch is declared separately (`lineHeight`), because a pitch is a
 * design decision and an ink box is a measurement.
 */
function measurePage(page) {
  const glyphs = [];   // per code: { code, advQ, x1, y1, x2, y2 } in px, y down
  let minLsb = 0;
  let maxRight = 0;
  let maxAbove = 0;
  let maxBelow = 0;

  for (const weight of WEIGHTS_USED) {
    const { face } = page.weightFaces[weight];
    const scale = page.size / face.font.unitsPerEm;
    for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
      const char = String.fromCharCode(code);
      const glyph = face.font.charToGlyph(char);
      if (!glyph || (glyph.index === 0 && code !== FIRST_CHAR)) {
        die(`face '${face.name}' has no glyph for '${char}' (U+${code.toString(16)})`);
      }
      // `advanceWidth` is in font units and may be fractional; quarter-pixels
      // keep the accumulated error under an eighth of a pixel (see the header).
      const advQ = Math.max(1, Math.round(glyph.advanceWidth * scale * ADVANCE_UNIT));
      glyphs.push({ code, face, advQ, scale });
      if (code === 32) continue;   // space has no ink, and its box is empty

      const box = glyph.getBoundingBox();
      if (!box) continue;
      // y1 is the *bottom* in font units (y up), so above the baseline is `y2`
      // and below it is `-y1`, both positive when measured that way.
      const lsb = box.x1 * scale;
      const right = box.x2 * scale;
      const above = box.y2 * scale;
      const below = -box.y1 * scale;
      if (lsb < minLsb) minLsb = lsb;
      if (right > maxRight) maxRight = right;
      if (above > maxAbove) maxAbove = above;
      if (below > maxBelow) maxBelow = below;
    }
  }

  // A glyph with a negative left side bearing (`j`, `f`) may put ink left of the
  // pen, so the cell's pen origin is pushed right by exactly that much. This is
  // the only place the atlas depends on a glyph's shape rather than its size.
  const penX = PAD + Math.max(0, Math.ceil(-minLsb));
  const baseline = PAD + Math.ceil(maxAbove);
  const cellW = penX + Math.ceil(maxRight) + PAD;
  const cellH = baseline + Math.ceil(maxBelow) + PAD;

  return { glyphs, penX, baseline, cellW, cellH };
}

/**
 * The one texture size every page shares.
 *
 * A pipeline's pages are layers of one `SDL_GPUTexture`, so they must agree on
 * their dimensions (`tension_2d.h`, `set_texture`). Each page then lays its own
 * grid inside that image with its own cell size — only the image is shared.
 * Search the width that minimises the area, because the smallest page is the
 * most atlas a 3 MB repository wants to carry.
 */
function chooseImageSize(pages) {
  let best = null;
  for (let width = 256; width <= 4096; width += 16) {
    let height = 0;
    let feasible = true;
    for (const page of pages) {
      const cols = Math.floor(width / page.geom.cellW);
      if (cols < 1) { feasible = false; break; }
      const rows = Math.ceil(page.cells / cols);
      const needed = rows * page.geom.cellH;
      if (needed > height) height = needed;
    }
    if (!feasible) continue;
    height = Math.ceil(height / 4) * 4;
    if (height > 4096) continue;
    const area = width * height;
    if (!best || area < best.area) best = { width, height, area };
  }
  if (!best) die('no texture size fits every page');
  return best;
}

// ── the pages ───────────────────────────────────────────────────────────────

const pages = spec.pages.map((entry, index) => {
  const faceList = (entry.faces ?? []).map((name) => {
    const face = faces.get(name);
    if (!face) die(`page ${index} names an unknown face '${name}'`);
    return face;
  });
  if (faceList.length === 0) die(`page ${index} names no faces`);
  if (!Number.isInteger(entry.size) || entry.size < 6 || entry.size > 96) {
    die(`page ${index}: size must be an integer 6..96, got ${entry.size}`);
  }

  // Every page bakes both weights: the cell formula is `colour * 190 + weight *
  // 95 + code - 32`, so a missing weight is a missing stripe, not a smaller
  // atlas. A page with one face fills the missing weight from its nearest
  // available face and says so in the manifest, rather than leaving a hole a
  // caller discovers as blank bold text.
  const byWeight = new Map();
  for (const face of faceList) byWeight.set(face.weight, face);
  const facesForWeight = WEIGHTS.map((weight) => {
    const face = byWeight.get(weight.index);
    if (face) return { face, synthesised: false };
    const fallback = faceList[0];
    return { face: fallback, synthesised: true };
  });

  const page = {
    index,
    font: entry.font ?? 'ui',
    size: entry.size,
    lineHeight: entry.lineHeight ?? Math.round(entry.size * 1.5),
    faceList: facesForWeight.map((f) => f.face),
    weightFaces: facesForWeight,
    cells: GLYPH_CELLS + CHROME.length,
  };
  page.geom = measurePage(page);
  return page;
});

const image = chooseImageSize(pages);

for (const page of pages) {
  const { cellW, cellH } = page.geom;
  page.cols = Math.floor(image.width / cellW);
  page.rows = Math.floor(image.height / cellH);
  if (page.cols * page.rows < page.cells) {
    die(`page ${page.index} (${page.font} ${page.size}px) needs ${page.cells} cells, ` +
        `a ${image.width}x${image.height} image at ${cellW}x${cellH} holds ` +
        `${page.cols * page.rows}`);
  }
}

// ── bake ────────────────────────────────────────────────────────────────────

/**
 * One page's image, plus the per-glyph count of inked pixels.
 *
 * The count is not decoration: it is the assertion that the rasterizer drew
 * something. A wrong `unitsPerEm` scale, a `getPath` called with the wrong
 * baseline, or a coverage buffer indexed transposed all produce a *plausible*
 * atlas of blank cells, and none of them throws.
 */
function bakePage(page) {
  const surface = new Surface(image.width, image.height);
  const inked = new Map();   // code -> non-zero alpha pixels, any stripe
  const { cellW, cellH, penX, baseline } = page.geom;

  const cellOrigin = (cell) => ({
    x: (cell % page.cols) * cellW,
    y: Math.floor(cell / page.cols) * cellH,
  });

  for (const weight of WEIGHTS_USED) {
    const { face } = page.weightFaces[weight];
    // Only the pairs at this weight need blitting; the mask is rasterized once
    // and stamped per stripe, so five colours of one weight cost one raster.
    const stripes = PAIRS.filter((pair) => pair.weight === weight);

    for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
      if (code === 32) { inked.set(code, 0); continue; }
      const glyph = face.font.charToGlyph(String.fromCharCode(code));

      // Rasterize in the frame of the first stripe's cell for this weight; the
      // origin only sets the sampling grid, and every stripe shares it.
      const first = cellOrigin(stripes[0].slot * STRIPE + (code - FIRST_CHAR));
      // The pen sits at the cell's pen origin and the baseline at the cell's
      // baseline: the ink then lands at `penX + lsb` across and `baseline -
      // ascent` down, which is what the painter assumes when it puts the cell's
      // top-left at the text position.
      const path = glyph.getPath(first.x + penX, first.y + baseline, page.size);
      const coverage = rasterize(flatten(path), first.x, first.y, cellW, cellH);

      let inkedPixels = 0;
      for (let i = 0; i < coverage.length; i++) if (coverage[i] > 0.02) inkedPixels++;
      inked.set(code, Math.max(inked.get(code) ?? 0, inkedPixels));

      for (const pair of stripes) {
        const rgb = COLOURS[pair.colour].rgb;
        const origin = cellOrigin(pair.slot * STRIPE + (code - FIRST_CHAR));
        for (let row = 0; row < cellH; row++) {
          for (let col = 0; col < cellW; col++) {
            const alpha = coverage[row * cellW + col];
            if (alpha <= 0) continue;
            const at = ((origin.y + row) * image.width + origin.x + col) * 4;
            surface.pixels[at] = rgb[0];
            surface.pixels[at + 1] = rgb[1];
            surface.pixels[at + 2] = rgb[2];
            // Coverage, not 255: the blend state is src-alpha/one-minus, so a
            // grey edge is a partially covered pixel, which is the whole of why
            // this rasterizer exists.
            surface.pixels[at + 3] = Math.round(alpha * 255);
          }
        }
      }
    }
  }

  // The chrome cells: solid, alpha 255, one per colour, after the glyph stripes.
  CHROME.forEach((entry, index) => {
    const origin = cellOrigin(CHROME_FIRST + index);
    surface.fillRect(origin.x, origin.y, cellW, cellH,
                     entry.rgb[0], entry.rgb[1], entry.rgb[2], 255);
  });

  // The invariant that catches the geometry bugs the ink count cannot: with a
  // 1 px pad, no glyph may have ink on the outermost ring of its cell. Ink there
  // is ink that the *next* cell owns, i.e. a cell one pixel too small.
  for (const [code, count] of inked) {
    if (count === 0 && code !== 32) {
      die(`page ${page.index}: '${String.fromCharCode(code)}' rasterized to nothing`);
    }
  }

  return { surface, inked };
}

// ── output ──────────────────────────────────────────────────────────────────

const atlasDir = resolve(process.cwd(), opts.atlasDir);
mkdirSync(atlasDir, { recursive: true });
mkdirSync(dirname(resolve(process.cwd(), opts.manifest)), { recursive: true });
mkdirSync(dirname(resolve(process.cwd(), opts.ts)), { recursive: true });

const files = [];
const baked = [];

for (const page of pages) {
  const { surface, inked } = bakePage(page);

  // The pad invariant, checked on the baked pixels rather than on the geometry:
  // the outer ring of every glyph cell must be empty.
  const { cellW, cellH } = page.geom;
  for (let cell = 0; cell < GLYPH_CELLS; cell++) {
    const ox = (cell % page.cols) * cellW;
    const oy = Math.floor(cell / page.cols) * cellH;
    let edge = 0;
    for (let x = 0; x < cellW; x++) {
      if (surface.pixels[((oy) * image.width + ox + x) * 4 + 3]) edge++;
      if (surface.pixels[((oy + cellH - 1) * image.width + ox + x) * 4 + 3]) edge++;
    }
    for (let y = 0; y < cellH; y++) {
      if (surface.pixels[((oy + y) * image.width + ox) * 4 + 3]) edge++;
      if (surface.pixels[((oy + y) * image.width + ox + cellW - 1) * 4 + 3]) edge++;
    }
    if (edge > 0) {
      die(`page ${page.index}: cell ${cell} has ${edge} inked edge pixel(s) — ` +
          `the cell is a pixel too small for its ink`);
    }
  }

  const name = `${opts.prefix}.${page.index}.iwi`;
  const path = join(atlasDir, name);
  writeFileSync(path, surface.toIwi());
  files.push(name);

  if (opts.preview) {
    const previewDir = resolve(process.cwd(), opts.preview);
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(join(previewDir, `${opts.prefix}.${page.index}.png`),
                  encodePng(image.width, image.height, surface.pixels));
  }

  baked.push({ page, inked });
}

// ── the manifest ────────────────────────────────────────────────────────────

const manifest = {
  version: 2,
  atlas: {
    width: image.width,
    height: image.height,
    pages: pages.length,
    files: files.map((name) => `assets/${name}`),
    format: 'IWI, 4 components RGBA8, interleaved',
    note: 'one texture per page; every page shares these dimensions because a ' +
          'pipeline binds its pages as layers of one texture array',
  },
  text: {
    glyphFirst: FIRST_CHAR,
    glyphLast: LAST_CHAR,
    glyphCount: GLYPH_COUNT,
    stripe: STRIPE,
    glyphCells: GLYPH_CELLS,
    chromeFirst: CHROME_FIRST,
    advanceUnit: 1 / ADVANCE_UNIT,
    advanceNote: `advances are in 1/${ADVANCE_UNIT} px; the painter rounds the ` +
                 'accumulated position, never the step',
    pairNote: 'cell = pairSlot[colour * 2 + weight] * stripe + (code - glyphFirst)',
    pairs: PAIRS.map((pair) => ({
      slot: pair.slot,
      colour: pair.colour,
      colourName: COLOURS[pair.colour].name,
      weight: pair.weight,
      weightName: WEIGHTS[pair.weight].name,
    })),
    pairSlots: PAIR_SLOT.map((slot) => (slot === 0xff ? null : slot)),
    colours: COLOURS,
    weights: WEIGHTS,
  },
  chrome: Object.fromEntries(CHROME.map((entry, index) => [
    entry.name,
    { index: CHROME_FIRST + index, rgb: entry.rgb, use: entry.use },
  ])),
  pages: baked.map(({ page }) => ({
    slot: page.index,
    font: page.font,
    size: page.size,
    file: `assets/${opts.prefix}.${page.index}.iwi`,
    sources: page.weightFaces.map(({ face, synthesised }) => ({
      file: face.path,
      weight: face.weight,
      synthesisedBold: synthesised || undefined,
    })),
    cell: { w: page.geom.cellW, h: page.geom.cellH },
    grid: { cols: page.cols, rows: page.rows },
    glyphCells: GLYPH_CELLS,
    chromeFirst: CHROME_FIRST,
    pairSlots: PAIR_SLOT.map((slot) => (slot === 0xff ? null : slot)),
    baseline: page.geom.baseline,
    penX: page.geom.penX,
    lineHeight: page.lineHeight,
    advances: WEIGHTS.map((_, weight) => {
      const out = [];
      const { face } = page.weightFaces[weight];
      const scale = page.size / face.font.unitsPerEm;
      for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
        const glyph = face.font.charToGlyph(String.fromCharCode(code));
        out.push(Math.max(1, Math.round(glyph.advanceWidth * scale * ADVANCE_UNIT)));
      }
      return out;
    }),
  })),
};

writeFileSync(resolve(process.cwd(), opts.manifest), JSON.stringify(manifest, null, 2) + '\n');

// ── the guest's table ───────────────────────────────────────────────────────
//
// TensionScript has no JSON parser — `apps/docs/src/format.ts` says so and ships
// a 25-line extractor that reads ten integers out of a fixed shape. A 95-entry
// advance table per weight per page is not ten integers, so the metrics reach
// the guest as **generated source**: compile-time constants, no parser, no
// allocation, and emitted by the same run that wrote the atlas so the two cannot
// disagree about what exists.

const ts = [];
const push = (line = '') => ts.push(line);
const numberArray = (name, type, values, perLine = 16) => {
  push(`/** ${name} */`);
  push(`export const ${name}: ${type}[] = [`);
  for (let i = 0; i < values.length; i += perLine) {
    push('  ' + values.slice(i, i + perLine).join(', ') + ',');
  }
  push('];');
  push();
};

push('// Generated by tension-framework/tools/font/bake-ttf.mjs — do not edit.');
push('//');
push('// The atlas\'s metrics, as constants. TensionScript cannot parse JSON, so the');
push('// manifest (`ui.json`) is the contract and the verifier\'s reference, and this');
push('// file is what the guest actually reads. Both come out of one bake.');
push();
push(`export const FONT_PAGE_COUNT: i32 = ${pages.length};`);
push(`export const FONT_ATLAS_WIDTH: i32 = ${image.width};`);
push(`export const FONT_ATLAS_HEIGHT: i32 = ${image.height};`);
push(`export const FONT_FIRST: i32 = ${FIRST_CHAR};`);
push(`export const FONT_LAST: i32 = ${LAST_CHAR};`);
push(`export const FONT_GLYPHS: i32 = ${GLYPH_COUNT};`);
push(`export const FONT_STRIPE: i32 = ${STRIPE};`);
push(`export const FONT_GLYPH_CELLS: i32 = ${GLYPH_CELLS};`);
push(`export const FONT_CHROME_FIRST: i32 = ${CHROME_FIRST};`);
push(`export const FONT_PAIRS: i32 = ${PAIRS.length};`);
push(`/** Weights the advance table is laid out by, baked or synthesised. */`);
push(`export const FONT_WEIGHTS: i32 = ${WEIGHTS.length};`);
push(`/** Advances are in 1/FONT_ADVANCE_UNIT of a pixel. */`);
push(`export const FONT_ADVANCE_UNIT: i32 = ${ADVANCE_UNIT};`);
push();
push('/// `colour * 2 + weight` -> stripe slot, or -1 when that pair is not baked.');
push('/// The array is `COLOURS * WEIGHTS` long, so a caller may index it with the');
push('/// same two numbers it uses for `Painter` colours and weights.');
push(`export const FONT_PAIR_SLOT: i32[] = [${PAIR_SLOT.map((s) => (s === 0xff ? -1 : s)).join(', ')}];`);
push();

// FontId and SizeId are the app's names for "which page"; the baker cannot know
// them, so it emits the numbers and the app's `FontBook` names them.
const fontIds = [...new Set(pages.map((p) => p.font))];
const sizeIds = [...new Set(pages.map((p) => p.size))].sort((a, b) => a - b);
push(`/** The distinct font families this atlas carries, in page order. */`);
push(`export const FONT_FAMILIES: string[] = [${fontIds.map((f) => JSON.stringify(f)).join(', ')}];`);
push(`/** The distinct pixel sizes this atlas carries, ascending. */`);
push(`export const FONT_SIZES: i32[] = [${sizeIds.join(', ')}];`);
push();

const ident = (name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
push('/// `FontId` values, by family name. A caller indexes `FontBook` with these.');
for (let i = 0; i < fontIds.length; i++) {
  push(`export const FONT_${ident(fontIds[i])}: i32 = ${i};`);
}
push();
push('/// `SizeId` values, by pixel size. A caller indexes `FontBook` with these.');
for (let i = 0; i < sizeIds.length; i++) {
  push(`export const SIZE_${sizeIds[i]}: i32 = ${i};`);
}
push();

numberArray('FONT_SLOT', 'i32', pages.map((p) => p.index));
numberArray('FONT_FAMILY', 'i32', pages.map((p) => fontIds.indexOf(p.font)));
numberArray('FONT_SIZE', 'i32', pages.map((p) => sizeIds.indexOf(p.size)));
numberArray('FONT_CELL_W', 'i32', pages.map((p) => p.geom.cellW));
numberArray('FONT_CELL_H', 'i32', pages.map((p) => p.geom.cellH));
numberArray('FONT_GRID_COLS', 'i32', pages.map((p) => p.cols));
numberArray('FONT_BASELINE', 'i32', pages.map((p) => p.geom.baseline));
numberArray('FONT_LINE_HEIGHT', 'i32', pages.map((p) => p.lineHeight));

// The advance table is page-major, weight-major, then glyph: page * weights * 95.
const advanceOffset = [];
const advances = [];
for (const page of pages) {
  for (let weight = 0; weight < WEIGHTS.length; weight++) {
    advanceOffset.push(advances.length);
    const { face } = page.weightFaces[weight];
    const scale = page.size / face.font.unitsPerEm;
    for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
      const glyph = face.font.charToGlyph(String.fromCharCode(code));
      advances.push(Math.max(1, Math.round(glyph.advanceWidth * scale * ADVANCE_UNIT)));
    }
  }
}
numberArray('FONT_ADV_OFFSET', 'i32', advanceOffset);
numberArray('FONT_ADVANCES', 'u8', advances, 24);
push(`/** One atlas file per page, as the volume spells them. */`);
push(`export const FONT_ATLAS: string[] = [${files.map((f) => JSON.stringify('/' + f)).join(', ')}];`);
push();

writeFileSync(resolve(process.cwd(), opts.ts), ts.join('\n'));

// ── report ──────────────────────────────────────────────────────────────────

const pixelsPerPage = image.width * image.height * 4;
process.stdout.write(
  `bake-ttf: ${pages.length} page(s) at ${image.width}x${image.height} ` +
  `(${(pixelsPerPage / 1024 / 1024).toFixed(2)} MiB each, ` +
  `${(pixelsPerPage * pages.length / 1024 / 1024).toFixed(2)} MiB total)\n`);
for (const { page } of baked) {
  process.stdout.write(
    `  page ${page.index}: ${page.font} ${page.size}px  ` +
    `cell ${page.geom.cellW}x${page.geom.cellH}  ` +
    `grid ${page.cols}x${page.rows} (${page.cols * page.rows} cells, ${page.cells} used)  ` +
    `baseline ${page.geom.baseline}  line ${page.lineHeight}\n`);
}
process.stdout.write(`  atlas   ${files.join(', ')}\n`);
process.stdout.write(`  manifest ${opts.manifest}\n`);
process.stdout.write(`  guest    ${opts.ts}\n`);
