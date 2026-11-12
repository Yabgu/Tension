#!/usr/bin/env node
// Check that the baked atlas, the manifest and the guest's table agree.
//
// ## Why this exists when the baker already asserts
//
// The baker checks the things it can see: the grid fits, no glyph has ink on its
// cell's outer ring, no glyph rasterized to nothing. What it cannot check is that
// what it *wrote* is what a reader finds — because the three artifacts leave as
// three files, and a stale one is silently wrong:
//
//   ui.N.iwi              the pixels
//   ui.json               the contract and a person's reference
//   fonts.generated.ts    what the guest actually compiles in
//
// A bake that regenerated two of the three is the failure mode. It does not
// throw; it produces a guest that samples cell indices from a grid it no longer
// has, which draws glyphs from neighbouring cells — damage that reads as "the
// font broke" and sends the reader to the rasterizer, the one thing that is fine.
//
// So this compares all three, and the comparisons are of *decoded* values: the
// IWI's own header against the manifest's dimensions, and the manifest's tables
// against the literals the guest compiles in.
//
// Usage:  node tools/font/verify-atlas.mjs [--json assets/ui.json] [--ts …]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const opts = {
  manifest: 'assets/ui.json',
  ts: 'assembly/ui/fonts.generated.ts',
};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--manifest' || argv[i] === '--json') opts.manifest = argv[++i];
  else if (argv[i] === '--ts') opts.ts = argv[++i];
  else {
    process.stderr.write(`verify-atlas: unknown argument '${argv[i]}'\n`);
    process.exit(1);
  }
}

let failures = 0;
let checks = 0;

function ok(message) {
  checks++;
  process.stdout.write(`  ok    ${message}\n`);
}

function fail(message) {
  checks++;
  failures++;
  process.stdout.write(`  FAIL  ${message}\n`);
}

const eq = (what, want, got) => {
  if (want === got) ok(`${what}: ${got}`);
  else fail(`${what}: manifest ${JSON.stringify(want)} != generated ${JSON.stringify(got)}`);
};

// ── the three files ─────────────────────────────────────────────────────────

const manifestPath = resolve(process.cwd(), opts.manifest);
const tsPath = resolve(process.cwd(), opts.ts);

for (const [what, path] of [['manifest', manifestPath], ['generated table', tsPath]]) {
  if (!existsSync(path)) {
    process.stderr.write(`verify-atlas: no ${what} at ${path}\n`);
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const ts = readFileSync(tsPath, 'utf8');

// ── reading the generated literals ──────────────────────────────────────────
//
// A regex, not a parser: the file is machine-written with one `export const`
// per value and no expressions, so the shape is fixed. A number this cannot
// find is reported rather than defaulted — a silent 0 would make every
// comparison below agree with the wrong atlas.
function generatedInt(name) {
  const match = ts.match(new RegExp(`export const ${name}: i32 = (-?\\d+);`));
  if (!match) fail(`the generated table has no ${name}`);
  return match ? Number(match[1]) : NaN;
}

function generatedArray(name) {
  const match = ts.match(
    new RegExp(`export const ${name}: \\w+\\[\\] = \\[([\\s\\S]*?)\\];`));
  if (!match) {
    fail(`the generated table has no ${name}`);
    return [];
  }
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('//'))
    .map((part) => (part.startsWith('"') ? part.slice(1, -1) : Number(part)));
}

function generatedStrings(name) {
  return generatedArray(name).map(String);
}

// ── the images ──────────────────────────────────────────────────────────────

process.stdout.write('\n1. the baked pages\n');

const atlas = manifest.atlas;
const images = [];
for (const page of manifest.pages) {
  const path = resolve(dirname(manifestPath), '..', '..', page.file);
  // `page.file` is written as `assets/ui.N.iwi` relative to the app root, and the
  // manifest lives in `assets/`, so two `..` is the app root. Resolve both ways
  // so a manifest at a different path still works.
  const candidates = [
    resolve(dirname(manifestPath), page.file.replace(/^assets\//, '')),
    resolve(dirname(manifestPath), '..', page.file),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) {
    fail(`page ${page.slot}: no file at ${candidates[0]}`);
    continue;
  }
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 4).toString('ascii') !== 'IWI1') {
    fail(`page ${page.slot}: ${file} is not an IWI container`);
    continue;
  }
  const width = bytes.readUInt32LE(4);
  const height = bytes.readUInt32LE(8);
  const components = bytes.readUInt16LE(13);
  const bitsPerPixel = bytes.readUInt16LE(15);
  const pixelBytes = Number(bytes.readBigUInt64LE(66));

  if (components !== 4 || bitsPerPixel !== 32) {
    fail(`page ${page.slot}: ${components} components at ${bitsPerPixel} bpp — the ` +
         `decoder needs RGBA8`);
  }
  if (width !== atlas.width || height !== atlas.height) {
    fail(`page ${page.slot} is ${width}x${height}; the manifest says ` +
         `${atlas.width}x${atlas.height}. Every page of one pipeline shares the ` +
         `texture's dimensions, so this is not a cosmetic mismatch.`);
  }
  if (bytes.length !== 74 + pixelBytes || pixelBytes !== width * height * 4) {
    fail(`page ${page.slot}: ${bytes.length} bytes does not match ` +
         `${width}x${height}x4 + a 74-byte header`);
  }
  images.push({ page, width, height, pixels: bytes.subarray(74) });
}

if (images.length === manifest.pages.length) {
  ok(`${images.length} page(s) at ${atlas.width}x${atlas.height}, RGBA8, one shared size`);
}

// ── the manifest against the guest's table ──────────────────────────────────

process.stdout.write('\n2. the manifest against fonts.generated.ts\n');

eq('page count', manifest.pages.length, generatedInt('FONT_PAGE_COUNT'));
eq('atlas width', atlas.width, generatedInt('FONT_ATLAS_WIDTH'));
eq('atlas height', atlas.height, generatedInt('FONT_ATLAS_HEIGHT'));
eq('first glyph', manifest.text.glyphFirst, generatedInt('FONT_FIRST'));
eq('last glyph', manifest.text.glyphLast, generatedInt('FONT_LAST'));
eq('glyph count', manifest.text.glyphCount, generatedInt('FONT_GLYPHS'));
eq('stripe', manifest.text.stripe, generatedInt('FONT_STRIPE'));
eq('glyph cells', manifest.text.glyphCells, generatedInt('FONT_GLYPH_CELLS'));
eq('chrome first cell', manifest.text.chromeFirst, generatedInt('FONT_CHROME_FIRST'));
eq('pair count', manifest.text.pairs.length, generatedInt('FONT_PAIRS'));
eq('advance unit', Math.round(1 / manifest.text.advanceUnit), generatedInt('FONT_ADVANCE_UNIT'));

// The pair table: -1 for "not baked", and the same order as the manifest's list.
const slots = generatedArray('FONT_PAIR_SLOT').map(Number);
const wantSlots = manifest.text.pairSlots.map((slot) => (slot === null ? -1 : slot));
if (slots.length !== wantSlots.length || slots.some((v, i) => v !== wantSlots[i])) {
  fail(`pair slots: generated [${slots}] != manifest [${wantSlots}]`);
} else {
  ok(`pair slots: [${slots}] — ${slots.filter((s) => s >= 0).length} baked of ` +
     `${slots.length} (colour x weight)`);
}

// Per-page geometry.
for (let i = 0; i < manifest.pages.length; i++) {
  const page = manifest.pages[i];
  eq(`page ${i} slot`, page.slot, generatedArray('FONT_SLOT')[i]);
  eq(`page ${i} cell width`, page.cell.w, generatedArray('FONT_CELL_W')[i]);
  eq(`page ${i} cell height`, page.cell.h, generatedArray('FONT_CELL_H')[i]);
  eq(`page ${i} grid columns`, page.grid.cols, generatedArray('FONT_GRID_COLS')[i]);
  eq(`page ${i} baseline`, page.baseline, generatedArray('FONT_BASELINE')[i]);
  eq(`page ${i} line height`, page.lineHeight, generatedArray('FONT_LINE_HEIGHT')[i]);

  // The grid must actually hold the stripes plus the chrome.
  const cells = page.grid.cols * page.grid.rows;
  const need = page.glyphCells + Object.keys(manifest.chrome).length;
  if (cells < need) {
    fail(`page ${i}: ${page.grid.cols}x${page.grid.rows} = ${cells} cells, ` +
         `${need} needed (${page.glyphCells} glyph + chrome)`);
  } else {
    ok(`page ${i}: ${cells} cells hold ${need}`);
  }
}

// Advances: the manifest carries them, and the guest compiles them in.
const advances = generatedArray('FONT_ADVANCES').map(Number);
const offsets = generatedArray('FONT_ADV_OFFSET').map(Number);
let advanceChecks = 0;
for (let i = 0; i < manifest.pages.length; i++) {
  const page = manifest.pages[i];
  for (let weight = 0; weight < page.advances.length; weight++) {
    const want = page.advances[weight];
    const offset = offsets[i * 2 + weight];
    const got = advances.slice(offset, offset + want.length);
    if (got.length !== want.length || got.some((v, i2) => v !== want[i2])) {
      fail(`page ${i} weight ${weight}: the advance table disagrees ` +
           `(manifest ${want.slice(0, 8)}…, generated ${got.slice(0, 8)}…)`);
    } else {
      advanceChecks++;
    }
  }
}
if (advanceChecks === manifest.pages.length * 2) {
  ok(`advance tables match for ${advanceChecks} (page, weight) pairs`);
}

// ── the chrome names, in the order the guest's enum uses ────────────────────

process.stdout.write('\n3. the chrome cells\n');

const chromeNames = Object.keys(manifest.chrome);
const enumOrder = ['White', 'Caret', 'Selection', 'Panel', 'Surface', 'Divider',
                   'Track', 'Thumb', 'Underline', 'CodeBg'];
const wantNames = ['white', 'caret', 'selection', 'panel', 'surface', 'divider',
                   'track', 'thumb', 'underline', 'code_bg'];
if (chromeNames.join(',') !== wantNames.join(',')) {
  fail(`the manifest's chrome is [${chromeNames}], the guest's enum expects ` +
       `[${wantNames}] — a reorder silently repaints every panel`);
} else {
  ok(`${chromeNames.length} chrome cells, in the order the guest's \`Chrome\` enum uses ` +
     `(${enumOrder.join(', ')})`);
}
chromeNames.forEach((name, index) => {
  const entry = manifest.chrome[name];
  eq(`chrome '${name}' cell`, manifest.text.chromeFirst + index, entry.index);
});

// ── the pixels themselves ───────────────────────────────────────────────────
//
// The check the others cannot make: that the cell a glyph is *supposed* to be in
// has ink in it. An index computed from a grid that is one column off samples a
// neighbour; only reading the region proves the region is the right one.

process.stdout.write('\n4. the pixels a glyph claims\n');

const sampleChars = [65, 87, 105, 65, 65];   // 'A', 'W', 'i', then any
for (const { page, width, height, pixels } of images) {
  const cellW = page.cell.w;
  const cellH = page.cell.h;
  const cols = page.grid.cols;
  for (const code of sampleChars) {
    const slot = manifest.text.pairSlots[0 * 2 + 0];   // (normal, regular)
    if (slot === null) {
      fail(`page ${page.slot}: (normal, regular) is not baked`);
      break;
    }
    if (code < manifest.text.glyphFirst || code > manifest.text.glyphLast) continue;
    const cell = slot * manifest.text.stripe + (code - manifest.text.glyphFirst);
    const ox = (cell % cols) * cellW;
    const oy = Math.floor(cell / cols) * cellH;
    let inked = 0;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        if (pixels[((oy + y) * width + ox + x) * 4 + 3] > 0) inked++;
      }
    }
    if (inked === 0) {
      fail(`page ${page.slot}: '${String.fromCharCode(code)}' has no ink in cell ${cell} ` +
           `at ${ox},${oy}`);
    } else {
      ok(`page ${page.slot}: '${String.fromCharCode(code)}' cell ${cell} has ` +
         `${inked} inked pixels`);
    }
  }
}

// ── the verdict ─────────────────────────────────────────────────────────────

process.stdout.write('\n');
if (failures > 0) {
  process.stdout.write(`verify-atlas: ${failures} of ${checks} check(s) FAILED\n`);
  process.exit(1);
}
process.stdout.write(`verify-atlas: ${checks} checks passed\n`);
