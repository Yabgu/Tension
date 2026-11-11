#!/usr/bin/env node
// Bake `assets/ui.iwi`: the viewer's entire visual vocabulary in one texture.
//
// **Why colour lives in the atlas.** The 2D sprite record has no tint — its
// fields are `x, y, src_x, src_y, w, h, tex, sort_key, group_id, z, flags`, and
// `flags` is explicitly "the graph's to interpret; the adapter assigns no
// meaning to any bit" (`tension-2d/include/tension_2d.h`). The only fragment
// shader samples the texture verbatim, and `shader_compile_raw` answers
// `-ENOSYS` in this build. So a coloured glyph has to *be* a coloured glyph in
// the atlas. That is not a compromise; it is the only design the renderer
// permits, and it costs 512 KiB of VRAM.
//
// **Why bold is baked and not drawn twice.** Drawing a glyph at `x` and `x+1`
// would double its record cost, and the 2D renderer stages at most 4096 records
// per frame across all buckets (`render2d/device.rs:505`). Records are the
// scarce resource; texture memory is not. So the bold weight is the same mask
// dilated one pixel rightward, baked once.
//
// Layout: 256x512 RGBA8, 32 columns x 32 rows of 8x16 cells = 1024 cells.
//
//     cell index = colour * 190 + weight * 95 + (charCode - 32)
//
// which is 5 x 2 x 95 = 950 glyph cells, leaving 74 for chrome. The viewer does
// one multiply and one add to find a glyph, and `assets/ui.json` records the same
// numbers so nothing downstream has to recompute them from this comment.
//
// Usage:  node tools/make-font.mjs [--preview <png>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLYPHS, COLS, ROWS } from './font8x16.mjs';
import { Surface } from './lib/iwi.mjs';
import { encodePng, scaleNearest } from './lib/png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');

const argv = process.argv.slice(2);
let outPath = join(appDir, 'assets', 'ui.iwi');
let previewPath = join(appDir, 'assets', 'ui.preview.png');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outPath = resolve(argv[++i]);
  else if (argv[i] === '--preview') previewPath = resolve(argv[++i]);
  else if (argv[i] === '--no-preview') previewPath = null;
  else {
    process.stderr.write(`make-font: unknown argument '${argv[i]}'\n`);
    process.exit(1);
  }
}

// ── the palette ─────────────────────────────────────────────────────────────
//
// Five text colours the documentation needs, and nothing more. A doc reader
// scrolling for an hour wants low contrast and a stable hierarchy; a sixth
// colour is a decision the layout cannot justify.
//
// The background these were chosen against is `panel` (#141414), below.

const TEXT_COLOURS = [
  { name: 'normal', rgb: [214, 214, 214], use: 'body text' },
  { name: 'muted', rgb: [138, 138, 138], use: 'footnotes, line numbers, the sidebar when unfocused' },
  { name: 'link', rgb: [108, 182, 255], use: 'links and cross-references' },
  { name: 'code', rgb: [197, 233, 141], use: 'inline code and code blocks' },
  { name: 'heading', rgb: [255, 255, 255], use: 'headings, which are also drawn bold' },
];

const WEIGHTS = ['regular', 'bold'];

/** Cells past the glyph stripes: the furniture a text-only UI still needs. */
const CHROME = [
  { name: 'white', rgb: [255, 255, 255], use: 'a 1x1 stretched for dividers, rules and underlines' },
  { name: 'caret', rgb: [235, 235, 235], use: 'the text cursor' },
  { name: 'selection', rgb: [45, 74, 107], use: 'a search hit or a drag selection' },
  { name: 'panel', rgb: [20, 20, 20], use: 'the page background, stretched' },
  { name: 'surface', rgb: [27, 27, 27], use: 'the sidebar and the code-block background' },
  { name: 'divider', rgb: [58, 58, 58], use: 'the 1px line between panes' },
  { name: 'track', rgb: [35, 35, 35], use: 'the scrollbar track' },
  { name: 'thumb', rgb: [90, 90, 90], use: 'the scrollbar thumb' },
  { name: 'underline', rgb: [108, 182, 255], use: 'a 1px rule under a link' },
  { name: 'code_bg', rgb: [24, 26, 24], use: 'the inset behind a code block' },
];

const CELL_W = 8;
const CELL_H = 16;
const GRID_COLS = 32;
const GRID_ROWS = 32;

/**
 * The integer factor every glyph pixel is duplicated by.
 *
 * This is how the font gets bigger. A sprite record cannot be stretched — its
 * `w`/`h` word is the *source* texel rect as well as the destination quad, so a
 * record asking for a 16x32 glyph samples the neighbouring cells instead
 * (`src/text.ts` has the shader). The engine's scaled graph (preset 101) applies
 * the factor in the vertex stage but is above `PIPE_PRESET_MAX` in this build
 * and `preset()` only compiles `default_graph()`, so a guest cannot reach it.
 *
 * So the atlas is baked at the size the viewer draws at: each source pixel
 * becomes a `SCALE x SCALE` block, and nearest filtering keeps it exactly
 * crisp. A glyph is still one record; the *tiled* fills in the shell (panel
 * backgrounds, rules) step by the cell size, so they cost less — measured on the
 * opening page, 1,646 records at 1x and 801 at 2x.
 *
 * Must equal `SCALE` in `src/text.ts`. Integer only: a fractional factor puts
 * glyph edges on half pixels, which with nearest sampling drops a row rather
 * than softening an edge.
 */
const SCALE = Number(process.env.FONT_SCALE ?? 2);
if (!Number.isInteger(SCALE) || SCALE < 1 || SCALE > 4) {
  throw new Error(`make-font: FONT_SCALE must be an integer 1..4, got ${SCALE}`);
}

/** The baked cell size: the source 8x16 upscaled by `SCALE`. */
const BAKED_W = CELL_W * SCALE;
const BAKED_H = CELL_H * SCALE;

const ATLAS_W = BAKED_W * GRID_COLS;   // 512 at scale 2
const ATLAS_H = BAKED_H * GRID_ROWS;   // 1024 at scale 2

const GLYPH_STRIPE = 95;
const COLOUR_STRIDE = GLYPH_STRIPE * WEIGHTS.length; // 190
const GLYPH_CELLS = COLOUR_STRIDE * TEXT_COLOURS.length; // 950

if (GLYPH_CELLS + CHROME.length > GRID_COLS * GRID_ROWS) {
  throw new Error(`make-font: ${GLYPH_CELLS + CHROME.length} cells do not fit in ` +
    `${GRID_COLS * GRID_ROWS}`);
}

/** Cell index → top-left pixel. */
function cellOrigin(index) {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS);
  return { x: col * BAKED_W, y: row * BAKED_H };
}

/**
 * A source mask (8x16) upscaled to the baked cell, nearest-neighbour.
 *
 * Every source pixel becomes a `SCALE x SCALE` block, so the shape is exact and
 * nothing is interpolated. A cell is then blitted at its natural size, which is
 * the only size the sprite record can draw.
 */
function upscaleMask(mask, dilate) {
  const out = new Uint8Array(BAKED_W * BAKED_H);
  for (let py = 0; py < CELL_H; py++) {
    for (let px = 0; px < CELL_W; px++) {
      // Dilation stays a *mask* operation, before upscaling, so the bold weight
      // thickens by one source pixel — two baked pixels — and the clamp that
      // keeps it inside the cell is still measured in source columns.
      // `px > 0` is load-bearing: without it `px - 1` at column 0 reads the
      // **last column of the previous row**, which is a diagonal bleed from a
      // different part of the glyph. That is the same class of bug the column-0
      // assertion at the bottom of this file exists to catch, and it caught it.
      let ink = mask[py * CELL_W + px] ? 1 : 0;
      if (!ink && dilate && px > 0) ink = mask[py * CELL_W + px - 1] ? 1 : 0;
      if (!ink) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        const row = (py * SCALE + dy) * BAKED_W;
        for (let dx = 0; dx < SCALE; dx++) out[row + px * SCALE + dx] = 1;
      }
    }
  }
  return out;
}

/** The atlas cell a (colour, weight, character) triple occupies. */
export function glyphCell(colourIndex, weightIndex, charCode) {
  if (charCode < 32 || charCode > 126) return null;
  return colourIndex * COLOUR_STRIDE + weightIndex * GLYPH_STRIPE + (charCode - 32);
}

// ── bake ────────────────────────────────────────────────────────────────────

const atlas = new Surface(ATLAS_W, ATLAS_H);
let drawn = 0;

for (let colourIndex = 0; colourIndex < TEXT_COLOURS.length; colourIndex++) {
  const colour = TEXT_COLOURS[colourIndex];
  for (let weightIndex = 0; weightIndex < WEIGHTS.length; weightIndex++) {
    // Bold is a one-pixel horizontal dilation of the regular mask, applied
    // *before* the upscale so it thickens by one source pixel (two baked ones)
    // and stays inside the cell. It is baked into its own stripe, so the
    // renderer draws one sprite either way.
    const dilate = weightIndex === 1 ? 1 : 0;
    for (const glyph of GLYPHS) {
      const index = glyphCell(colourIndex, weightIndex, glyph.code);
      const { x, y } = cellOrigin(index);
      atlas.blitMask(x, y, BAKED_W, BAKED_H, upscaleMask(glyph.mask, dilate), colour.rgb);
      drawn++;
    }
  }
}

// Chrome cells. Each is a full baked cell of one colour; a sprite samples one
// texel of it per drawn pixel, which is why a single cell becomes a 1-pixel
// divider or a whole-pane background depending on the record's `w`/`h`. The
// cell size follows `SCALE` so the caret and underline keep their proportions.
const chromeIndex = {};
for (let i = 0; i < CHROME.length; i++) {
  const entry = CHROME[i];
  const index = GLYPH_CELLS + i;
  chromeIndex[entry.name] = index;
  const { x, y } = cellOrigin(index);
  atlas.fillRect(x, y, BAKED_W, BAKED_H, entry.rgb[0], entry.rgb[1], entry.rgb[2], 255);
}

// The caret is drawn *into* its chrome cell, after the fill, so its neighbours
// are not affected: a bar inset from the cell edge, scaled with the cell.
{
  const { x, y } = cellOrigin(chromeIndex.caret);
  atlas.fillRect(x, y, BAKED_W, BAKED_H, 20, 20, 20, 0); // clear
  atlas.fillRect(x + 3 * SCALE, y + 2 * SCALE, 2 * SCALE, 12 * SCALE, 235, 235, 235, 255);
}
// The underline is a rule at the cell's bottom, stretched horizontally. One
// source pixel tall, so it stays a hairline at any scale.
{
  const { x, y } = cellOrigin(chromeIndex.underline);
  atlas.fillRect(x, y, BAKED_W, BAKED_H, 20, 20, 20, 0);
  atlas.fillRect(x, y + BAKED_H - 2, BAKED_W, 1, 108, 182, 255, 255);
}

// ── the invariant the renderer depends on ───────────────────────────────────
//
// A glyph cell's **column 0 must be empty**. That single fact is what guarantees
// two adjacent characters can never touch: cell N's ink ends at column 7 at the
// latest, cell N+1's begins at column 1 at the earliest, so column 0 of the
// second cell is always a clear pixel between them. It is also the invariant the
// bold weight used to break — dilation replicated a column-7 pixel into column
// 8, which *is* column 0 of the next cell, and the last character of one glyph
// appeared as a stray dot at the left edge of the next.
//
// `blitMask` now clamps dilation to its own cell and `font8x16.mjs` refuses a
// table with ink in column 0, so this check should never fire. It stays because
// it is the one assertion that validates the *baked bytes* rather than the
// source table, and a future chrome cell or geometry change could reintroduce
// the overlap without touching either of those.
function assertNoCrossCellInk() {
  const offenders = [];
  for (let index = 0; index < GLYPH_CELLS; index++) {
    const { x, y } = cellOrigin(index);
    let inked = 0;
    for (let py = 0; py < BAKED_H; py++) {
      if (atlas.pixels[((y + py) * ATLAS_W + x) * 4 + 3]) inked++;
    }
    if (inked) {
      const code = index % GLYPH_STRIPE;
      const ch = String.fromCharCode(32 + code);
      offenders.push(`cell ${index} ('${ch}') has ${inked} pixel(s) in column 0`);
    }
  }
  if (offenders.length) {
    throw new Error('make-font: the baked atlas lets glyphs cross their cells, so ' +
      'characters can overlap — check the dilation clamp in blitMask and the ' +
      'column-0 rule in font8x16.mjs:\n  ' + offenders.slice(0, 10).join('\n  '));
  }
}
assertNoCrossCellInk();

const iwi = atlas.toIwi();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, iwi);

// ── the manifest ────────────────────────────────────────────────────────────
//
// The numbers the viewer needs, written next to the image so a reader can see
// them without decoding a comment. A cell index computed from this file and one
// computed from the formula above must agree; `verify.mjs` checks that they do.

writeFileSync(join(dirname(outPath), 'ui.json'), `${JSON.stringify({
  atlas: {
    path: relative(repo, outPath).split('\\').join('/'),
    width: ATLAS_W,
    height: ATLAS_H,
    scale: SCALE,
    cellWidth: BAKED_W,
    cellHeight: BAKED_H,
    columns: GRID_COLS,
    rows: GRID_ROWS,
    bytes: iwi.length,
    format: 'IWI, 4 components RGBA8, interleaved',
  },
  text: {
    glyphFirst: 32,
    glyphLast: 126,
    glyphCount: GLYPH_STRIPE,
    stripe: GLYPH_STRIPE,
    colourStride: COLOUR_STRIDE,
    glyphCells: GLYPH_CELLS,
    // index = colour * colourStride + weight * stripe + (char - 32)
    colours: TEXT_COLOURS.map((c, i) => ({ index: i, name: c.name, rgb: c.rgb, use: c.use })),
    weights: WEIGHTS.map((name, i) => ({ index: i, name, dilate: i === 1 ? 1 : 0 })),
  },
  chrome: Object.fromEntries(CHROME.map((c, i) => [c.name, {
    index: GLYPH_CELLS + i, rgb: c.rgb, use: c.use,
  }])),
  advances: {
    // Monospace: one number, which is the whole reason the layout arithmetic is
    // multiplication instead of a table lookup. This is the *baked* width, so
    // the viewer's `CELL_W` must equal it — `verify.mjs` checks that they agree.
    advance: BAKED_W,
    lineHeight: BAKED_H,
    note: `every glyph advances one baked cell, so a line of N characters is N * ${BAKED_W} pixels wide`,
  },
}, null, 2)}\n`);

// ── preview ─────────────────────────────────────────────────────────────────

if (previewPath) {
  // Render a sample of the atlas at 2x: what a reader on a 2x display sees, and
  // what nearest-neighbour sampling does to it. The sample deliberately uses
  // every glyph so a missing or misplaced cell is visible rather than latent.
  const SAMPLE_COLOUR = 0;   // normal
  const HEADING_COLOUR = 4;  // heading
  const CODE_COLOUR = 3;     // code
  const MUTED_COLOUR = 1;    // muted

  const lines = [
    { text: 'Tension documentation', colour: HEADING_COLOUR, weight: 1, blank: 6 },
    { text: 'abcdefghijklmnopqrstuvwxyz 0123456789', colour: SAMPLE_COLOUR, weight: 0 },
    { text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ .,;:!?', colour: SAMPLE_COLOUR, weight: 0, blank: 6 },
    { text: 'The runtime takes a .wasm and no app config.', colour: SAMPLE_COLOUR, weight: 0 },
    { text: 'print("hello from the docs");', colour: CODE_COLOUR, weight: 0, blank: 6 },
    { text: 'See res_read for the resource verbs ->', colour: MUTED_COLOUR, weight: 0 },
    { text: '! " # $ % & \' ( ) * + , - . / : ; < = > ? @', colour: SAMPLE_COLOUR, weight: 0 },
    { text: '[ \\ ] ^ _ ` { | } ~  gf jp qy,;', colour: SAMPLE_COLOUR, weight: 0 },
  ];

  // Laid out with the **baked** cell size and drawn 1:1, so this image is what
  // the window shows rather than a magnified approximation of it.
  const pad = 4 * SCALE;
  const maxChars = Math.max(...lines.map((l) => l.text.length));
  const width = maxChars * BAKED_W + pad * 2;
  const lineGap = 4 * SCALE;
  const height = pad * 2 + lines.reduce((sum, l) => sum + BAKED_H + (l.blank ?? lineGap) * SCALE, 0);
  const page = new Surface(width, height);
  page.fillRect(0, 0, width, height, 20, 20, 20, 255);

  let cursorY = pad;
  for (const line of lines) {
    let cursorX = pad;
    for (const ch of line.text) {
      const code = ch.charCodeAt(0);
      const index = glyphCell(line.colour, line.weight, code);
      if (index !== null) {
        const src = cellOrigin(index);
        // Copy the baked cell, so the preview shows exactly the atlas bytes.
        const mask = new Uint8Array(BAKED_W * BAKED_H);
        for (let y = 0; y < BAKED_H; y++) {
          for (let x = 0; x < BAKED_W; x++) {
            mask[y * BAKED_W + x] =
              atlas.pixels[((src.y + y) * ATLAS_W + (src.x + x)) * 4 + 3] ? 1 : 0;
          }
        }
        const colour = index >= 0 && index < GLYPH_CELLS
          ? TEXT_COLOURS[line.colour].rgb
          : [255, 255, 255];
        page.blitMask(cursorX, cursorY, BAKED_W, BAKED_H, mask, colour);
      }
      cursorX += BAKED_W;
    }
    cursorY += BAKED_H + (line.blank ?? lineGap) * SCALE;
  }

  // 1:1. The atlas is already baked at the size the viewer draws, so this image
  // is the screen, not a zoom of it.
  const scaled = scaleNearest(width, height, page.pixels, 1);
  mkdirSync(dirname(previewPath), { recursive: true });
  writeFileSync(previewPath, encodePng(scaled.width, scaled.height, scaled.pixels));
}

// ── report ──────────────────────────────────────────────────────────────────

process.stdout.write(
  `make-font: ${drawn} glyph cells (${TEXT_COLOURS.length} colours x ${WEIGHTS.length} weights) ` +
  `+ ${CHROME.length} chrome cells, ${ATLAS_W}x${ATLAS_H}\n` +
  `make-font: ${(iwi.length / 1024).toFixed(1)} KiB -> ${relative(repo, outPath).split('\\').join('/')}\n`,
);
if (previewPath) {
  process.stdout.write(`make-font: preview -> ${relative(repo, previewPath).split('\\').join('/')}\n`);
}
