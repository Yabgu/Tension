#!/usr/bin/env node
// examples/2d/isometric/build.mjs — tileset in, textures and a scene table out.
//
// # What changed and why
//
// This used to slice LimeZu's *Modern exteriors* pack: parse a `.tsx` for the
// geometry, locate a lantern by byte-searching the sheet, and refuse to run if
// the art was not on the machine. The art was third-party, so it could not be
// committed, so the example exited 77 for everyone without it — including CI.
//
// The tileset is now `examples/2d/assets/tileset.png`, drawn by
// `examples/2d/assets/build-tileset.mjs` and committed. Same three pages, same
// multi-atlas proof, same composite and depth assertions, no host to reach.
//
// # Probes are computed, not typed
//
// The old build read each expected colour off the source image at a coordinate
// chosen by hand. That is still what happens, but the *coordinate* is now found
// by simulating the frame: every probe is a pixel where the record that should
// win really is on top, verified with the same `(sort_key, group_id, z)` order
// the adapter sorts with. A probe that no longer means what it says fails the
// build, not the GPU test three steps later.
//
// Outputs (all gitignored except where noted):
//   assets/textures/{tileset_p0,tileset_p1,character}.iwi
//   src/scene.generated.ts   the guest's constants
//   scene.json               the runner's expectations
//
// SPDX-License-Identifier: MIT

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from '../assets/png.mjs';
import { LAYOUT, PAGE, PAGE_COUNT } from '../assets/build-tileset.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const RUNNER = 'build-isometric';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

// ── 1. the sheet ────────────────────────────────────────────────────────────

const TILESET = join(here, '..', 'assets', 'tileset.png');
let sheet;
try {
  sheet = decodePng(readFileSync(TILESET));
} catch (error) {
  die(`cannot read ${TILESET}: ${error.message}\n  regenerate it: node examples/2d/assets/build-tileset.mjs`);
}
if (sheet.width !== PAGE * PAGE_COUNT || sheet.height !== PAGE) {
  die(`${TILESET} is ${sheet.width}x${sheet.height}, expected ${PAGE * PAGE_COUNT}x${PAGE}`);
}

// Three 1024px pages across, which is the slicing the multi-atlas case exists
// for: the sheet is wider than the largest texture the pipeline can hold.
const pages = [];
for (let i = 0; i < PAGE_COUNT; i++) {
  const page = Buffer.alloc(PAGE * PAGE * 4);
  for (let y = 0; y < PAGE; y++) {
    const from = (y * sheet.width + i * PAGE) * 4;
    sheet.rgba.copy(page, y * PAGE * 4, from, from + PAGE * 4);
  }
  pages.push(page);
}

/// The page-local rect for a named piece. The LAYOUT table stores sheet
/// coordinates; a record wants page-local ones, because `tex` already names the
/// page and the shader has no idea the sheet was ever wider.
function piece(name) {
  const p = LAYOUT[name];
  if (!p) die(`LAYOUT has no piece named ${name}`);
  return { ...p, x: p.x - p.page * PAGE };
}

// ── 2. the scene, as records ────────────────────────────────────────────────

const CANVAS = { w: 320, h: 180 };
// The ground is centred: 6x6 of 16px is 96, so 112 either side in a 320 canvas.
const GROUND_ORIGIN = { x: 112, y: 44 };
const GROUND_COLS = 6;
const GROUND_ROWS = 6;

// The trunk slice must begin *below* the composite probe, or the probe
// pixel is covered by the tree and the composite assertion tests the wrong
// record. TREE_AT.y + 32 > CHAR_AT.y + 16 is that constraint, written down.
const TREE_AT = { x: 144, y: 48 };       // 32x64, sliced at 32
const TREE_SLICE_H = 32;
const TREE_BASE_Y = TREE_AT.y + 64;      // 104
const TREE_CROWN_SORT = TREE_BASE_Y - TREE_SLICE_H; // 72
const TREE_TRUNK_SORT = TREE_BASE_Y;                // 104

// Beside the trunk, not behind it: the trunk's art is 6px wide at the tree's
// centre, so a character centred on the tree would be a head above a brown bar.
// Overlapping the crown's left half but not the trunk (which starts 13px in),
// so 'character in front of the crown' and 'trunk in front of the character'
// are two different pixels.
const CHAR_AT = { x: 136, y: 62 };       // 16x32
const CHAR_FEET_Y = CHAR_AT.y + 32;      // 94
const CHAR_SORT = CHAR_FEET_Y - 2;       // 92: feet_offset 2
const CHAR_GROUP = 200;

// The lantern's centre lands on the character's legs, so "the lantern draws in
// front of the character" is a claim about two records that both cover the
// pixel. A lantern in empty space would prove nothing and its revert test would
// have no colour to name.
const LANTERN_AT = { x: 134, y: 78 };    // 16x16
const LANTERN_SORT = LANTERN_AT.y + 16;  // 96
const LANTERN_SORT_WRONG = CHAR_SORT - 10; // 82, what the revert test asks for

/// Props, so the frame is a scene rather than a tree on a mat. Each sorts by
/// its own base, which is the same rule the tree's slices use.
const PROPS = [
  { name: 'bush', at: { x: 120, y: 60 } },
  { name: 'rock', at: { x: 192, y: 84 } },
  { name: 'fence', at: { x: 120, y: 104 } },
  { name: 'mushroom', at: { x: 184, y: 116 } },
];

// The texture-array slot a piece lives on is its page index, and it is read
// from the layout rather than written here: the tree used to be on page 0 and
// moved to page 1 when the sheet was repacked, and a hardcoded slot turned that
// into a frame of the wrong art instead of a build error.
const SLOT_TILESET_A = 0; // terrain
const SLOT_TILESET_B = 1; // trees, props, lantern
const SLOT_CHARACTER = 2; // the character layers

/// The slot a named piece must be sampled from.
function slotFor(name) {
  const p = LAYOUT[name];
  if (!p) die(`LAYOUT has no piece named ${name}`);
  return p.page;
}

const GRASS = ['grass0', 'grass1', 'grass2', 'grass3'].map(piece);
const TREE = piece('tree');
const LANTERN = piece('lantern');
const BODY = piece('body');
const HAIR = piece('hair');
const BACKPACK = piece('backpack');

/// One `sprite` record, as the guest will write it.
/// `slot` is the texture-array page; `srcX`/`srcY` are page-local.
function record(label, slot, src, x, y, sortKey, groupId = 0, z = 0) {
  return { label, slot, srcX: src.x, srcY: src.y, w: src.w, h: src.h, x, y, sortKey, groupId, z };
}

/// The z column each layer uses, indexed by facing. Back (0): the pack is on
/// the back, so it draws last. Front (1): the body is nearest.
const Z_TABLE = {
  body: [0, 2, 0, 0, 0, 0, 0, 0],
  hair: [1, 1, 0, 0, 0, 0, 0, 0],
  backpack: [2, 0, 0, 0, 0, 0, 0, 0],
};

/// Every record the guest submits, in submission order. `facing` picks the
/// composite's z column; nothing else changes between the two frames.
function sceneRecords(facing, options = {}) {
  const out = [];

  for (let j = 0; j < GROUND_ROWS; j++) {
    for (let i = 0; i < GROUND_COLS; i++) {
      const grass = GRASS[(i * 3 + j * 5) % GRASS.length];
      out.push(record('ground', slotFor('grass0'), grass,
        GROUND_ORIGIN.x + i * 16, GROUND_ORIGIN.y + j * 16, 0));
    }
  }

  out.push(record('crown', slotFor('tree'),
    { ...TREE, h: TREE_SLICE_H }, TREE_AT.x, TREE_AT.y, TREE_CROWN_SORT));
  out.push(record('trunk', slotFor('tree'),
    { ...TREE, y: TREE.y + TREE_SLICE_H, h: TREE_SLICE_H },
    TREE_AT.x, TREE_AT.y + TREE_SLICE_H,
    options.noSlice ? TREE_CROWN_SORT : TREE_TRUNK_SORT));

  const zBody = options.swapComposite ? Z_TABLE.backpack[facing] : Z_TABLE.body[facing];
  const zPack = options.swapComposite ? Z_TABLE.body[facing] : Z_TABLE.backpack[facing];
  const group = options.breakGroup ? CHAR_GROUP + 1 : CHAR_GROUP;
  out.push(record('body', slotFor('body'), BODY, CHAR_AT.x, CHAR_AT.y, CHAR_SORT, CHAR_GROUP, zBody));
  out.push(record('hair', slotFor('hair'), HAIR, CHAR_AT.x, CHAR_AT.y, CHAR_SORT, CHAR_GROUP, Z_TABLE.hair[facing]));
  out.push(record('backpack', slotFor('backpack'), BACKPACK, CHAR_AT.x, CHAR_AT.y, CHAR_SORT, group, zPack));

  out.push(record('lantern', slotFor('lantern'), LANTERN, LANTERN_AT.x, LANTERN_AT.y,
    options.lanternBehind ? LANTERN_SORT_WRONG : LANTERN_SORT));

  for (const prop of PROPS) {
    const art = piece(prop.name);
    out.push(record(prop.name, slotFor(prop.name), art, prop.at.x, prop.at.y, prop.at.y + art.h));
  }

  return out;
}

// ── 3. the frame, simulated ─────────────────────────────────────────────────

/// The page pixels a record samples, or `null` where it is transparent.
function sample(rec, screenX, screenY) {
  const lx = screenX - rec.x;
  const ly = screenY - rec.y;
  if (lx < 0 || ly < 0 || lx >= rec.w || ly >= rec.h) return null;
  const page = pages[rec.slot];
  const at = ((rec.srcY + ly) * PAGE + rec.srcX + lx) * 4;
  if (page[at + 3] === 0) return null;
  return [page[at], page[at + 1], page[at + 2]];
}

/// The records that cover a screen pixel, back to front.
///
/// This is the adapter's order — `(sort_key, group_id, z)` ascending, ties kept
/// in submission order — written out so the build can ask "what will actually
/// be visible here?" without a GPU. If this and the renderer disagree, the
/// pixel assertions fail, which is the point of computing the probes rather
/// than typing them.
function stackAt(records, screenX, screenY) {
  const covered = [];
  records.forEach((rec, index) => {
    const colour = sample(rec, screenX, screenY);
    if (colour) covered.push({ rec, colour, index });
  });
  covered.sort((a, b) => {
    if (a.rec.sortKey !== b.rec.sortKey) return a.rec.sortKey - b.rec.sortKey;
    if (a.rec.groupId !== b.rec.groupId) return a.rec.groupId - b.rec.groupId;
    if (a.rec.z !== b.rec.z) return a.rec.z - b.rec.z;
    return a.index - b.index;
  });
  return covered;
}

function topmost(records, x, y) {
  const stack = stackAt(records, x, y);
  return stack.length ? stack[stack.length - 1] : null;
}

const back = sceneRecords(0);
const front = sceneRecords(1);

// The multi-atlas claim, checked before a GPU sees it: the frame must sample
// every page of the array. A scene that quietly collapsed onto two pages would
// still render, and would still pass the per-page pixel probes — one of them
// would simply be reading a page nothing else uses.
{
  const used = new Set(back.map((r) => r.slot));
  const missing = [...Array(PAGE_COUNT).keys()].filter((page) => !used.has(page));
  if (missing.length) {
    die(`the scene samples ${used.size} of ${PAGE_COUNT} pages; page(s) ${missing.join(', ')} ` +
        `would go unbound, so the multi-atlas proof is gone. Move a piece onto those pages.`);
  }
}

/// Find a pixel where `predicate` holds **and** the record that ends up on top
/// is the one the probe is about.
///
/// The second half is what makes a probe an assertion rather than a coordinate.
/// "The composite probe is at the character's centre" is only meaningful if the
/// backpack really is drawn there; if the tree's trunk happens to cover that
/// pixel, the probe would be testing the trunk and the assertion would pass for
/// the wrong reason. Failing to find such a pixel is a build error, which is
/// the honest outcome: the scene no longer demonstrates what it claims.
function findProbe(label, rect, near, predicate) {
  let best = null;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (!predicate(x, y)) continue;
      const top = topmost(back, x, y);
      if (!top || top.rec.label !== label) continue;
      const d = Math.abs(x - near.x) + Math.abs(y - near.y);
      if (best === null || d < best.d) best = { x, y, d, top };
    }
  }
  return best;
}

// The composite probe: a pixel where all three character layers are opaque with
// three distinct colours, and the backpack wins the sort. Distinct because a
// pixel where two layers share a colour cannot tell their z values apart, which
// is exactly what the composite assertion is for.
const composite = findProbe(
  'backpack',
  { x: CHAR_AT.x, y: CHAR_AT.y, w: 16, h: 32 },
  { x: CHAR_AT.x + 8, y: CHAR_AT.y + 16 },
  (x, y) => {
    const colours = ['body', 'hair', 'backpack']
      .map((name) => sample(back.find((r) => r.label === name), x, y))
      .filter((c) => c !== null);
    if (colours.length !== 3) return false;
    return new Set(colours.map((c) => c.join(','))).size === 3;
  },
);
if (!composite) {
  die('no pixel shows all three character layers, distinct, with the backpack on top');
}

// The crown probe: crown and character both opaque, character on top. That is
// where "the character draws over the crown" is a statement about two records.
const crown = findProbe(
  'body',
  { x: TREE_AT.x, y: TREE_AT.y, w: TREE.w, h: TREE_SLICE_H },
  { x: TREE_AT.x + TREE.w / 2, y: TREE_AT.y + TREE_SLICE_H / 2 },
  (x, y) => {
    const crownRec = back.find((r) => r.label === 'crown');
    const bodyRec = back.find((r) => r.label === 'body');
    return sample(crownRec, x, y) !== null && sample(bodyRec, x, y) !== null;
  },
);
if (!crown) die('no pixel shows the character over the crown');

// The lantern probe: lantern and character both opaque, lantern on top. A
// lantern over empty ground would prove nothing, and its revert test would have
// no colour to name.
const lanternProbe = findProbe(
  'lantern',
  { x: LANTERN_AT.x, y: LANTERN_AT.y, w: 16, h: 16 },
  { x: LANTERN_AT.x + 8, y: LANTERN_AT.y + 8 },
  (x, y) => {
    const lanternRec = back.find((r) => r.label === 'lantern');
    if (sample(lanternRec, x, y) === null) return false;
    return ['body', 'hair', 'backpack']
      .some((name) => sample(back.find((r) => r.label === name), x, y) !== null);
  },
);
if (!lanternProbe) die('the lantern covers no character pixel, so it is in front of nothing');

// ── 4. the expected colours, read off the pixels ────────────────────────────

const PAGE_A_PROBE = { x: GROUND_ORIGIN.x + 8, y: GROUND_ORIGIN.y + 8 };

function must(records, x, y, what) {
  const top = topmost(records, x, y);
  if (!top) die(`probe ${what} (${x},${y}) is covered by nothing`);
  return top;
}

const compositeBack = composite.top;
const compositeFront = must(front, composite.x, composite.y, 'composite/front');
const crownBack = crown.top;
const crownFront = must(front, crown.x, crown.y, 'crown/front');
const lanternTop = lanternProbe.top;
const pageATop = must(back, PAGE_A_PROBE.x, PAGE_A_PROBE.y, 'pageA');

// What the composite looks like facing front: the body must win, or the z table
// is not doing what the facing switch claims.
if (compositeFront.rec.label !== 'body') {
  die(`composite probe: facing front shows \`${compositeFront.rec.label}\`, expected the body`);
}
// What the character shows at the lantern's pixel — the colour the revert test
// expects once the lantern is asked to sort behind.
const lanternBehind = (() => {
  const behind = sceneRecords(0, { lanternBehind: true });
  const top = topmost(behind, lanternProbe.x, lanternProbe.y);
  if (!top || top.rec.label === 'lantern') die('the lantern-behind revert test changes nothing');
  return top.colour;
})();

// ── 5. write the textures ───────────────────────────────────────────────────

function iwi(rgba, width, height) {
  const header = Buffer.alloc(74);
  header.write('IWI1', 0, 'latin1');
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt8(0, 12);     // colorSpace: sRGB
  header.writeUInt16LE(4, 13);  // componentCount
  header.writeUInt16LE(32, 15); // bitsPerPixel
  header.writeUInt8(0, 17);     // storageLayout: interleaved
  for (let i = 0; i < 4; i++) {
    const at = 18 + i * 6;
    header.writeUInt8(i + 1, at);    // semantics R,G,B,A
    header.writeUInt8(2, at + 1);    // componentClass UNORM
    header.writeUInt16LE(i * 8, at + 2);
    header.writeUInt16LE(8, at + 4);
  }
  header.writeBigUInt64LE(BigInt(width) * BigInt(height) * 4n, 66);
  return Buffer.concat([header, rgba]);
}

const OUT_TEXTURES = join(here, 'assets', 'textures');
mkdirSync(OUT_TEXTURES, { recursive: true });

// Page `i` is uploaded to array slot `i`; a record's `tex` is the page it
// samples, so slot and page are the same number and there is nothing to keep
// in sync. Names are what a human reads in the log.
const pageFiles = [
  { slot: 0, name: 'tileset_p0.iwi', bytes: pages[0] },
  { slot: 1, name: 'tileset_p1.iwi', bytes: pages[1] },
  { slot: 2, name: 'character.iwi', bytes: pages[2] },
];
for (const page of pageFiles) {
  const blob = iwi(page.bytes, PAGE, PAGE);
  writeFileSync(join(OUT_TEXTURES, page.name), blob);
  page.size = blob.length;
}
console.log(
  `${RUNNER}: ${sheet.width}x${sheet.height} -> ${PAGE_COUNT} pages of ${PAGE}px, ` +
  `${pageFiles.map((p) => `${p.name} ${(p.size / 1048576).toFixed(2)} MB`).join(', ')}`,
);

// ── 6. write the scene table ────────────────────────────────────────────────

function rgb(colour) {
  return `[${colour.join(', ')}]`;
}

const propRecords = back.filter((r) => PROPS.some((p) => p.name === r.label));

const scene = `// Generated by examples/2d/isometric/build.mjs — do not edit.
//
// The page table, the sprite table, and the colours the test asserts against.
// Every colour here was read off examples/2d/assets/tileset.png at build time,
// so it cannot drift from the art: change the art and this file changes.
//
// Flat scalars rather than objects: TensionScript infers an object literal's
// type narrowly and property access on it does not survive, so a scene table
// shaped like a JavaScript config object compiles to "property does not exist
// on type 'auto'" fifty times over.

export const CANVAS_WIDTH: u32 = ${CANVAS.w};
export const CANVAS_HEIGHT: u32 = ${CANVAS.h};

/** Texture-array slots. One pipeline, three pages — the multi-atlas case. */
// Every slot is the page its piece was packed onto. Written from the layout
// rather than as literals, because the tree moved pages once already and a
// stale constant samples the right rectangle from the wrong texture.
export const SLOT_TILESET_A: i32 = ${slotFor('tree')};
export const SLOT_TILESET_B: i32 = ${slotFor('lantern')};
export const SLOT_CHARACTER: i32 = ${slotFor('body')};

export const PAGE_FILES: string[] = ${JSON.stringify(pageFiles.map((p) => `textures/${p.name}`))};
export const PAGE_SLOTS: i32[] = ${JSON.stringify(pageFiles.map((p) => p.slot))};

/** The \`sprite\` record layout this scene writes. */
export const RECORD_SIZE: u32 = 28;

/** How many records one frame submits. Emitted rather than counted in the
 *  guest, so adding a prop here cannot overflow the guest's buffer. */
export const RECORD_COUNT: i32 = ${back.length};

/** The ground's source rectangles, one per cell, in row-major order. Four grass
 *  variants across a 6x6 field, so the tiling does not read as one tile
 *  repeated 36 times. */
export const GROUND_SRC_XS: i32[] = ${JSON.stringify(back.filter((r) => r.label === 'ground').map((r) => r.srcX))};
export const GROUND_SRC_YS: i32[] = ${JSON.stringify(back.filter((r) => r.label === 'ground').map((r) => r.srcY))};

/** Props, as parallel arrays: bpos, slot, rect, position, sort. Parallel rather
 *  than an array of records because TensionScript has no record array yet
 *  (AS100, a value type in a type argument). */
export const PROP_COUNT: i32 = ${PROPS.length};
export const PROP_SLOT: i32[] = ${JSON.stringify(propRecords.map((r) => r.slot))};
export const PROP_SRC_X: i32[] = ${JSON.stringify(propRecords.map((r) => r.srcX))};
export const PROP_SRC_Y: i32[] = ${JSON.stringify(propRecords.map((r) => r.srcY))};
export const PROP_W: i32[] = ${JSON.stringify(propRecords.map((r) => r.w))};
export const PROP_H: i32[] = ${JSON.stringify(propRecords.map((r) => r.h))};
export const PROP_X: i32[] = ${JSON.stringify(propRecords.map((r) => r.x))};
export const PROP_Y: i32[] = ${JSON.stringify(propRecords.map((r) => r.y))};
export const PROP_SORT: i32[] = ${JSON.stringify(propRecords.map((r) => r.sortKey))};

// ground
export const GROUND_SLOT: i32 = ${slotFor('grass0')};
export const GROUND_SRC_X: i32 = ${GRASS[0].x};
export const GROUND_SRC_Y: i32 = ${GRASS[0].y};

// the tree, in two slices
export const TREE_SLICE_W: i32 = ${TREE.w};
export const TREE_CROWN_SRC_X: i32 = ${TREE.x};
export const TREE_CROWN_SRC_Y: i32 = ${TREE.y};
export const TREE_TRUNK_SRC_Y: i32 = ${TREE.y + TREE_SLICE_H};

// the lantern
export const LANTERN_SLOT: i32 = ${slotFor('lantern')};
export const LANTERN_SRC_X: i32 = ${LANTERN.x};
export const LANTERN_SRC_Y: i32 = ${LANTERN.y};

// the character: three layers side by side on one page
export const CHAR_SLOT: i32 = ${slotFor('body')};
export const CHAR_BODY_SRC_X: i32 = ${BODY.x};
export const CHAR_HAIR_SRC_X: i32 = ${HAIR.x};
export const CHAR_BACKPACK_SRC_X: i32 = ${BACKPACK.x};
export const CHAR_SRC_Y: i32 = 0;
export const CHAR_W: i32 = ${BODY.w};
export const CHAR_H: i32 = ${BODY.h};

// world placement
export const GROUND_ORIGIN_X: i32 = ${GROUND_ORIGIN.x};
export const GROUND_ORIGIN_Y: i32 = ${GROUND_ORIGIN.y};
export const GROUND_COLS: i32 = ${GROUND_COLS};
export const GROUND_ROWS: i32 = ${GROUND_ROWS};

export const TREE_X: i32 = ${TREE_AT.x};
export const TREE_Y: i32 = ${TREE_AT.y};
export const TREE_HEIGHT: i32 = ${TREE.h};
export const TREE_SLICE_H: i32 = ${TREE_SLICE_H};
export const TREE_CROWN_SORT: u32 = ${TREE_CROWN_SORT};
export const TREE_TRUNK_SORT: u32 = ${TREE_TRUNK_SORT};

export const CHAR_X: i32 = ${CHAR_AT.x};
export const CHAR_Y: i32 = ${CHAR_AT.y};
export const CHAR_SORT: u32 = ${CHAR_SORT};
export const CHAR_GROUP: u16 = ${CHAR_GROUP};

export const LANTERN_X: i32 = ${LANTERN_AT.x};
export const LANTERN_Y: i32 = ${LANTERN_AT.y};
export const LANTERN_SORT: u32 = ${LANTERN_SORT};
/** What the sort is supposed to be; the revert test asks the guest for the
 *  wrong one on purpose (\`--lantern-behind\`) and the assertion must fail. */
export const LANTERN_SORT_WRONG: u32 = ${LANTERN_SORT_WRONG};

// ── the probes, and the colours each must show ──────────────────────────────
//
// Screen coordinates. \`back\`/\`front\` are the two z assignments: the art is
// the same, only the composite order changes, which is what the composite test
// is about.

export const PROBE_COMPOSITE_X: i32 = ${composite.x};
export const PROBE_COMPOSITE_Y: i32 = ${composite.y};
export const COMPOSITE_BACK: u8[] = ${rgb(compositeBack.colour)};   // backpack z=2 wins
export const COMPOSITE_FRONT: u8[] = ${rgb(compositeFront.colour)}; // body z=2 wins

export const PROBE_CROWN_X: i32 = ${crown.x};
export const PROBE_CROWN_Y: i32 = ${crown.y};
export const CROWN_BACK: u8[] = ${rgb(crownBack.colour)};
export const CROWN_FRONT: u8[] = ${rgb(crownFront.colour)};

export const PROBE_LANTERN_X: i32 = ${lanternProbe.x};
export const PROBE_LANTERN_Y: i32 = ${lanternProbe.y};
export const LANTERN_COLOUR: u8[] = ${rgb(lanternTop.colour)};

/** One pixel per page, all in one frame: the multi-atlas proof. */
export const PROBE_PAGE_A_X: i32 = ${PAGE_A_PROBE.x};
export const PROBE_PAGE_A_Y: i32 = ${PAGE_A_PROBE.y};
`;
writeFileSync(join(here, 'src', 'scene.generated.ts'), scene);

writeFileSync(join(here, 'scene.json'), JSON.stringify({
  canvas: CANVAS,
  pageFiles: pageFiles.map((p) => `textures/${p.name}`),
  pageSlots: pageFiles.map((p) => p.slot),
  pages: PAGE_COUNT,
  pageSize: PAGE,
  tileset: { width: sheet.width, height: sheet.height, page: PAGE, pages: PAGE_COUNT },
  source: 'examples/2d/assets/tileset.png',
  probes: {
    composite,
    crown,
    lantern: lanternProbe,
    pageA: PAGE_A_PROBE,
  },
  expect: {
    compositeBack: compositeBack.colour,
    compositeFront: compositeFront.colour,
    crownBack: crownBack.colour,
    crownFront: crownFront.colour,
    lantern: lanternTop.colour,
    lanternBehind,
    pageA: pageATop.colour,
    pageB: lanternTop.colour,
    pageC: compositeBack.colour,
  },
}, null, 2));

console.log(`${RUNNER}: wrote src/scene.generated.ts`);
console.log(
  `${RUNNER}: tree slices sort ${TREE_CROWN_SORT} / ${TREE_TRUNK_SORT}, ` +
  `character ${CHAR_SORT}, lantern ${LANTERN_SORT}`,
);
console.log(
  `${RUNNER}: probes composite (${composite.x},${composite.y}) crown ` +
  `(${crown.x},${crown.y}) lantern (${lanternProbe.x},${lanternProbe.y})`,
);
