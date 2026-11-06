#!/usr/bin/env node
// build.mjs — turn the third-party tileset into the pages the isometric scene binds.
//
// Four steps, each the next one's input:
//
//   1. **Slice.** `Modern_Exteriors_Complete_Tileset.png` is 2816x5072 at a
//      16x16 tile grid (176 columns x 317 rows, 55 792 tiles — the numbers come
//      from the pack's own `Modern_Exteriors_Complete_Tileset.tsx`, not from
//      counting). Sliced into 1024x1024 pages that is 3 x 5 = **15** pages,
//      which is the number the adapter's 16-page texture array has to hold.
//      Edge pages are padded to a full 1024 so every layer of one pipeline has
//      one size, because an array texture has exactly one.
//
//   2. **Pick.** The three tiles the scene draws are located by *tile index*,
//      read off the sliced pages by inspection (DESIGN.md §6.3's fallback when
//      the pack ships no tile properties — the .tsx carries geometry only).
//      The lantern is additionally verified by byte-exact search: it is
//      located again from `ME_Singles_..._Lantern_2.png`, and the build fails
//      if the two answers disagree. A wrong tile is a silent wrong picture, so
//      the one that can be checked mechanically is.
//
//   3. **Compose the character page.** The character generator ships its
//      sprites as *layers* — `Bodies/`, `Hairstyles/`, `Accessories/` — drawn
//      at identical coordinates and composited at run time. That is the
//      modular-character case the composite sort exists for, so the page holds
//      the three layers side by side and the guest submits three records at one
//      world position.
//
//   4. **Write IWI.** The adapter decodes one container at v1 (`IWI1`), so each
//      page is written as an IWI blob under `assets/textures/`, which the guest
//      reads out of the resource pak. Nothing here downsamples or rescales: a
//      page's pixels are the tileset's pixels, which is what keeps a record's
//      `src_x`/`src_y` meaningful.
//
// It also emits `src/scene.generated.ts`: the page table, the sprite table and
// the expected colours the test asserts against. Those colours are *read from
// the source images here*, so an assertion cannot drift from the art it
// describes — the test compares the rendered frame to what the layers say,
// not to a number someone typed twice.
//
// SPDX-License-Identifier: MIT

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const assets = join(repo, 'tension-2d', 'test-assets');
const RUNNER = 'build-isometric';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

// ── the inputs ──────────────────────────────────────────────────────────────

const TILESET = join(assets, 'modernexteriors', 'Modern_Exteriors_Complete_Tileset.png');
const TSX = join(assets, 'modernexteriors', 'Modern_Exteriors_Complete_Tileset.tsx');
const SINGLES = join(assets, 'modernexteriors', 'Modern_Exteriors_Complete_Singles_16x16');
const CHARACTERS = join(assets, 'characters');
const SLICED = join(assets, 'sliced');
const OUT_TEXTURES = join(here, 'assets', 'textures');

for (const [path, hint] of [
  [TILESET, 'place the third-party exteriors pack under tension-2d/test-assets/'],
  [TSX, 'place the third-party exteriors pack under tension-2d/test-assets/'],
  [join(CHARACTERS, 'Bodies', 'Body_01.png'), 'place the third-party character layers under tension-2d/test-assets/characters/'],
]) {
  if (!existsSync(path)) die(`missing ${path}\n  ${hint}`);
}

// The .tsx is the authority on geometry; the constants below are checked
// against it rather than trusted.
const tsx = readFileSync(TSX, 'utf8');
const tsxNumber = (name) => {
  const m = tsx.match(new RegExp(`\\b${name}="(\\d+)"`));
  if (!m) die(`${TSX} has no ${name}`);
  return Number(m[1]);
};
const TILE = tsxNumber('tilewidth');
const TILE_H = tsxNumber('tileheight');
const IMG_W = tsxNumber('width');
const IMG_H = tsxNumber('height');
const COLUMNS = tsxNumber('columns');
if (TILE !== 16 || TILE_H !== 16) die(`tileset is ${TILE}x${TILE_H}, this scene assumes 16x16`);

const PAGE = 1024;
const PAGES_X = Math.ceil(IMG_W / PAGE);
const PAGES_Y = Math.ceil(IMG_H / PAGE);
const PAGE_COUNT = PAGES_X * PAGES_Y;
const TILES_PER_ROW = IMG_W / TILE;

// ── image helpers (ImageMagick is the one image dependency; the tileset is a
//    PNG and Node has no decoder) ────────────────────────────────────────────

function magick(args, input) {
  // ImageMagick 7 is `magick`, 6 is `convert`. Both take raw RGBA on stdin,
  // which is how this script hands over a sliced page.
  const exe = process.env.MAGICK ?? 'magick';
  const argv = exe.endsWith('magick') || exe === 'convert' ? args : args;
  const input_ = input ?? 'pipe:0';
  try {
    return execFileSync(exe, argv, { maxBuffer: 1 << 28, input });
  } catch (error) {
    if (error.status === undefined) throw error; // spawn failure, not a refusal
    return execFileSync('convert', argv, { maxBuffer: 1 << 28, input });
  }
}

/// Crop a rectangle out of a PNG and return tightly packed 8-bit RGBA bytes.
///
/// `-depth 8` is load-bearing: ImageMagick's default raw depth is 16 bits per
/// channel, so without it every buffer here would be twice the size the rest
/// of the script assumes and every index would land on half a pixel.
function rgba(path, x, y, w, h) {
  return magick([path, '-crop', `${w}x${h}+${x}+${y}`, '+repage', '-depth', '8', 'rgba:-']);
}

/// Page `index` of the sliced tileset: a 1024x1024 RGBA raster, padded with
/// transparency where the sheet ends.
function slicePage(index) {
  const col = index % PAGES_X;
  const row = Math.floor(index / PAGES_X);
  const x = col * PAGE;
  const y = row * PAGE;
  const w = Math.min(PAGE, IMG_W - x);
  const h = Math.min(PAGE, IMG_H - y);
  const inner = rgba(TILESET, x, y, w, h);
  if (w === PAGE && h === PAGE) return Buffer.from(inner);

  // Pad on the right and bottom. Padding is transparent, so a src rect that
  // lands in it samples nothing rather than a wrong tile.
  const page = Buffer.alloc(PAGE * PAGE * 4);
  for (let line = 0; line < h; line++) {
    inner.copy(page, (line * PAGE) * 4, line * w * 4, (line + 1) * w * 4);
  }
  return page;
}

// ── 1. slice ────────────────────────────────────────────────────────────────

mkdirSync(SLICED, { recursive: true });
const pages = [];
for (let i = 0; i < PAGE_COUNT; i++) {
  const raw = slicePage(i);
  pages.push(raw);
  // Written beside the tileset so a reader can look at the pages this scene
  // binds without running the example. Regenerated on every build; ignored by
  // git with the rest of test-assets.
  const png = join(SLICED, `page${String(i).padStart(2, '0')}.png`);
  magick(['-size', `${PAGE}x${PAGE}`, '-depth', '8', 'rgba:-', `png:${png}`], raw);
}
console.log(
  `${RUNNER}: ${IMG_W}x${IMG_H} @ ${TILE}px, ${COLUMNS} columns, ` +
  `${(IMG_W / TILE) * (IMG_H / TILE)} tiles -> ${PAGES_X}x${PAGES_Y} = ${PAGE_COUNT} pages of ${PAGE}px`,
);

// ── 2. pick the tiles ───────────────────────────────────────────────────────
//
// Atlas coordinates, in *tileset* pixels. The first two were read off page 0
// (DESIGN.md §6.3's "print a map and pick by inspection"); the lantern was read
// off page 1 and then checked by byte-exact search below.

const PICKS = {
  ground: { x: 112, y: 16, w: 16, h: 16 },   // grass, page 0
  tree: { x: 112, y: 96, w: 32, h: 64 },     // conifer, page 0
  lantern: { x: 1872, y: 144, w: 16, h: 16 }, // camping lantern (lit), page 1
};

/// Locate a single PNG's opaque content inside the full tileset, byte-exactly.
///
/// The pack ships both a 55 792-tile sheet and one PNG per tile, but the
/// singles are *trimmed*, so their origin inside the sheet is not known and
/// tile-grid search alone would miss one sitting three pixels into a cell.
/// Instead the single's first opaque row is searched for as a byte pattern —
/// one C-speed scan of the sheet's raw RGBA — and each hit is verified against
/// the whole block. A hit means the art at that spot *is* the art in the
/// single, which is what makes the pick verifiable rather than eyeballed.
function locateSingle(name) {
  const path = join(SINGLES, name);
  if (!existsSync(path)) die(`missing ${path}`);
  const box = magick([path, '-trim', '-format', '%w %h', 'info:-']).toString().trim().split(' ').map(Number);
  const [w, h] = box;
  const trimmed = magick([path, '-trim', '+repage', '-depth', '8', 'rgba:-']);
  const sheet = Buffer.from(magick([TILESET, '-depth', '8', 'rgba:-']));

  // The first fully opaque row, as a contiguous byte pattern.
  let row = -1;
  for (let y = 0; y < h && row < 0; y++) {
    let allOpaque = true;
    for (let x = 0; x < w; x++) {
      if (trimmed[(y * w + x) * 4 + 3] === 0) { allOpaque = false; break; }
    }
    if (allOpaque) row = y;
  }
  if (row < 0) die(`${name} has no fully opaque row to search for`);

  const needle = trimmed.subarray(row * w * 4, (row + 1) * w * 4);
  let from = 0;
  for (;;) {
    const at = sheet.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    if (at % 4 !== 0) continue;
    const pix = at / 4;
    // The needle is *row `row`* of the block, so the block starts `row` above
    // where the hit landed. Getting this wrong once cost a build: the search
    // found the row and then verified the wrong rectangle, so a lantern that
    // was there read as "not in the tileset".
    const x = pix % IMG_W;
    const y = Math.floor(pix / IMG_W) - row;
    if (x + w > IMG_W || y + h > IMG_H || y < 0) continue;

    let ok = true;
    for (let dy = 0; dy < h && ok; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const src = (dy * w + dx) * 4;
        const dst = ((y + dy) * IMG_W + x + dx) * 4;
        if (sheet[dst + 3] !== trimmed[src + 3]) { ok = false; break; }
        if (trimmed[src + 3] === 0) continue;
        if (sheet[dst] !== trimmed[src] || sheet[dst + 1] !== trimmed[src + 1] ||
            sheet[dst + 2] !== trimmed[src + 2]) { ok = false; break; }
      }
    }
    if (!ok) continue;
    // Report the tile-aligned cell that contains it.
    return { x: Math.floor(x / TILE) * TILE, y: Math.floor(y / TILE) * TILE, w, h };
  }
  return null;
}

const lanternSingle = locateSingle('ME_Singles_Camping_16x16_Lantern_2.png');
if (lanternSingle === null) {
  die('the lantern single is not byte-identical anywhere in the tileset; refusing to pick by eye');
}
if (lanternSingle.x !== PICKS.lantern.x || lanternSingle.y !== PICKS.lantern.y) {
  die(`lantern: picked (${PICKS.lantern.x},${PICKS.lantern.y}), byte search says ` +
      `(${lanternSingle.x},${lanternSingle.y}) — one of the two is wrong`);
}
console.log(`${RUNNER}: lantern at (${PICKS.lantern.x},${PICKS.lantern.y}) confirmed by byte search`);

const pageOf = (p) => Math.floor(p.y / PAGE) * PAGES_X + Math.floor(p.x / PAGE);
const local = (p) => ({ x: p.x - Math.floor(p.x / PAGE) * PAGE, y: p.y - Math.floor(p.y / PAGE) * PAGE });

const GROUND = local(PICKS.ground);
const TREE = local(PICKS.tree);
const LANTERN = local(PICKS.lantern);
const PAGE_TILESET_A = pageOf(PICKS.ground); // ground + tree
const PAGE_TILESET_B = pageOf(PICKS.lantern);
if (pageOf(PICKS.tree) !== PAGE_TILESET_A) die('the tree and the ground are not on one page');
if (PAGE_TILESET_B === PAGE_TILESET_A) die('the lantern shares a page with the tree; multi-atlas would not be exercised');

// The pages the scene binds, in texture-array slot order.
const SLOT_TILESET_A = 0;
const SLOT_TILESET_B = 1;
const SLOT_CHARACTER = 2;

// ── 3. the character page ───────────────────────────────────────────────────

const CHAR_CELL = { col: 7, row: 1 }; // a back view: the backpack is on the back
const CHAR_W = 16;
const CHAR_H = 32;
const CHARACTER_LAYERS = [
  { name: 'body', file: join(CHARACTERS, 'Bodies', 'Body_01.png') },
  { name: 'hair', file: join(CHARACTERS, 'Hairstyles', 'Hairstyle_09_01.png') },
  { name: 'backpack', file: join(CHARACTERS, 'Accessories', 'Accessory_03_Backpack_01.png') },
];

const characterPage = Buffer.alloc(PAGE * PAGE * 4);
const layerBytes = CHARACTER_LAYERS.map((layer, index) => {
  const bytes = rgba(layer.file, CHAR_CELL.col * CHAR_W, CHAR_CELL.row * CHAR_H, CHAR_W, CHAR_H);
  // Side by side along the top row of the page; the guest samples each at
  // (index*16, 0).
  for (let y = 0; y < CHAR_H; y++) {
    bytes.copy(characterPage, (y * PAGE + index * CHAR_W) * 4, y * CHAR_W * 4, (y + 1) * CHAR_W * 4);
  }
  layer.src = { x: index * CHAR_W, y: 0, w: CHAR_W, h: CHAR_H };
  return bytes;
});

const alphaAt = (bytes, w, x, y) => bytes[(y * w + x) * 4 + 3];
const pixelAt = (bytes, w, x, y) => {
  const at = (y * w + x) * 4;
  return [bytes[at], bytes[at + 1], bytes[at + 2]];
};

// The composite probe: a pixel where all three layers are opaque with three
// different colours, nearest the sprite's geometric centre. The backpack sits
// low on the back, so this is a little below centre — the *centre* pixel has
// hair over body and no backpack at all, which cannot tell the three z values
// apart. Picking it by rule rather than by eye is what keeps the test honest.
const centre = { x: 8, y: 16 };
let probe = null;
for (let y = 0; y < CHAR_H; y++) {
  for (let x = 0; x < CHAR_W; x++) {
    const [b, h, p] = layerBytes.map((bytes) => alphaAt(bytes, CHAR_W, x, y));
    if (!b || !h || !p) continue;
    const colours = new Set(layerBytes.map((bytes) => pixelAt(bytes, CHAR_W, x, y).join(',')));
    if (colours.size !== 3) continue;
    const d = Math.abs(x - centre.x) + Math.abs(y - centre.y);
    if (probe === null || d < probe.d) probe = { x, y, d };
  }
}
if (probe === null) die('no pixel has all three character layers opaque with distinct colours');
console.log(`${RUNNER}: composite probe at sprite (${probe.x},${probe.y})`);

// The pixel the lantern sits on: the character must be drawn there, or "the
// lantern is in front of the character" would be untestable — the lantern would
// be in front of nothing. Any of the three layers counts; which one wins is the
// z assignment's business, and the revert test asserts the character's colour
// that appears when the sort is asked to put the lantern behind.
//
// The lantern is 16 wide and the character 16 wide, offset by 8, so the
// lantern's centre lands on the character's left column and its right edge
// stops one pixel short of the composite probe at x=8.
const lanternProbeChar = { x: 0, y: 24 };
const stackAtLantern = layerBytes.map((bytes) =>
  alphaAt(bytes, CHAR_W, lanternProbeChar.x, lanternProbeChar.y)
    ? pixelAt(bytes, CHAR_W, lanternProbeChar.x, lanternProbeChar.y) : null);
if (stackAtLantern.every((c) => c === null)) {
  die(`no character layer is opaque at the lantern's probe pixel ` +
      `(${lanternProbeChar.x},${lanternProbeChar.y})`);
}
// Topmost opaque layer for the back-facing z order (body 0, hair 1, backpack 2).
const lanternBehindColour = [stackAtLantern[2], stackAtLantern[1], stackAtLantern[0]]
  .find((c) => c !== null);

// ── the scene, in world pixels ──────────────────────────────────────────────

const CANVAS = { w: 320, h: 180 };
const GROUND_ORIGIN = { x: 64, y: 72 };
const GROUND_COLS = 6;
const GROUND_ROWS = 6;

const TREE_AT = { x: 96, y: 54 };       // 32x64
const TREE_SLICE_H = 32;                // two slices: crown, trunk
const TREE_BASE_Y = TREE_AT.y + PICKS.tree.h; // 118

const CHAR_AT = { x: 100, y: 58 };      // 16x32
const CHAR_FEET_Y = CHAR_AT.y + CHAR_H; // 90
const CHAR_SORT = CHAR_FEET_Y - 2;      // feet_offset = 2: the sprite has two
                                        // rows of ground contact below the feet
const CHAR_GROUP = 200;

const LANTERN_AT = { x: CHAR_AT.x - 8, y: CHAR_AT.y + 16 }; // left of the character
const LANTERN_SORT = LANTERN_AT.y + 16;                     // its base, 90

// ── 4. write IWI + the generated scene table ────────────────────────────────

function iwi(rgbaBytes, width, height) {
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
    header.writeUInt8(i + 1, at);     // semantics R,G,B,A
    header.writeUInt8(2, at + 1);     // componentClass UNORM
    header.writeUInt16LE(i * 8, at + 2);
    header.writeUInt16LE(8, at + 4);
  }
  header.writeBigUInt64LE(BigInt(width) * BigInt(height) * 4n, 66);
  return Buffer.concat([header, rgbaBytes]);
}

mkdirSync(OUT_TEXTURES, { recursive: true });
const pageFiles = [
  { slot: SLOT_TILESET_A, name: 'tileset_p0.iwi', bytes: pages[PAGE_TILESET_A] },
  { slot: SLOT_TILESET_B, name: 'tileset_p1.iwi', bytes: pages[PAGE_TILESET_B] },
  { slot: SLOT_CHARACTER, name: 'character.iwi', bytes: characterPage },
];
for (const page of pageFiles) {
  const blob = iwi(page.bytes, PAGE, PAGE);
  writeFileSync(join(OUT_TEXTURES, page.name), blob);
  page.size = blob.length;
}
console.log(
  `${RUNNER}: ${pageFiles.map((p) => `${p.name} ${(p.size / 1048576).toFixed(2)} MB`).join(', ')}`,
);

// The expected colours, read from the layers rather than typed twice.
const composite = layerBytes.map((bytes) => pixelAt(bytes, CHAR_W, probe.x, probe.y));
// The crown's centre, in screen pixels, is the tree's top-left plus half a
// slice; the character's layer colours at that screen point are what the frame
// must show (topmost opaque layer first).
const crownScreen = { x: TREE_AT.x + PICKS.tree.w / 2, y: TREE_AT.y + TREE_SLICE_H / 2 };
const crownAt = { x: crownScreen.x - CHAR_AT.x, y: crownScreen.y - CHAR_AT.y };
const crownStack = layerBytes
  .map((bytes, i) => ({ i, rgba: alphaAt(bytes, CHAR_W, crownAt.x, crownAt.y) ? pixelAt(bytes, CHAR_W, crownAt.x, crownAt.y) : null }))
  .filter((e) => e.rgba !== null);

// The lantern's own centre pixel, read from the page it was sliced into — so
// the colour the test expects is the colour the GPU will sample.
const lanternPage = pages[PAGE_TILESET_B];
const lanternColour = pixelAt(lanternPage, PAGE, LANTERN.x + 8, LANTERN.y + 8);

const scene = `// Generated by examples/2d/isometric/build.mjs — do not edit.
//
// The page table, the sprite table and the colours the test asserts against.
// The colours are read from the source images at build time, so they cannot
// drift from the art.
//
// Flat scalars rather than objects: TensionScript infers an object literal's
// type narrowly and property access on it does not survive, so a scene table
// shaped like a JavaScript config object compiles to "property does not exist
// on type 'auto'" fifty times over.

export const CANVAS_WIDTH: u32 = ${CANVAS.w};
export const CANVAS_HEIGHT: u32 = ${CANVAS.h};

/** Texture-array slots. One pipeline, three pages — the multi-atlas case. */
export const SLOT_TILESET_A: i32 = ${SLOT_TILESET_A};
export const SLOT_TILESET_B: i32 = ${SLOT_TILESET_B};
export const SLOT_CHARACTER: i32 = ${SLOT_CHARACTER};

export const PAGE_FILES: string[] = ${JSON.stringify(pageFiles.map((p) => `textures/${p.name}`))};
export const PAGE_SLOTS: i32[] = ${JSON.stringify(pageFiles.map((p) => p.slot))};

/** The \`sprite\` record layout this scene writes. */
export const RECORD_SIZE: u32 = 28;

// ground
export const GROUND_SLOT: i32 = ${SLOT_TILESET_A};
export const GROUND_SRC_X: i32 = ${GROUND.x};
export const GROUND_SRC_Y: i32 = ${GROUND.y};

// the tree, in two slices
export const TREE_SLICE_W: i32 = ${PICKS.tree.w};
export const TREE_CROWN_SRC_X: i32 = ${TREE.x};
export const TREE_CROWN_SRC_Y: i32 = ${TREE.y};
export const TREE_TRUNK_SRC_Y: i32 = ${TREE.y + TREE_SLICE_H};

// the lantern
export const LANTERN_SLOT: i32 = ${SLOT_TILESET_B};
export const LANTERN_SRC_X: i32 = ${LANTERN.x};
export const LANTERN_SRC_Y: i32 = ${LANTERN.y};

// the character: three layers side by side on one page
export const CHAR_SLOT: i32 = ${SLOT_CHARACTER};
export const CHAR_BODY_SRC_X: i32 = 0;
export const CHAR_HAIR_SRC_X: i32 = 16;
export const CHAR_BACKPACK_SRC_X: i32 = 32;
export const CHAR_SRC_Y: i32 = 0;
export const CHAR_W: i32 = ${CHAR_W};
export const CHAR_H: i32 = ${CHAR_H};

// world placement
export const GROUND_ORIGIN_X: i32 = ${GROUND_ORIGIN.x};
export const GROUND_ORIGIN_Y: i32 = ${GROUND_ORIGIN.y};
export const GROUND_COLS: i32 = ${GROUND_COLS};
export const GROUND_ROWS: i32 = ${GROUND_ROWS};

export const TREE_X: i32 = ${TREE_AT.x};
export const TREE_Y: i32 = ${TREE_AT.y};
export const TREE_HEIGHT: i32 = ${PICKS.tree.h};
export const TREE_SLICE_H: i32 = ${TREE_SLICE_H};
export const TREE_CROWN_SORT: u32 = ${TREE_BASE_Y - TREE_SLICE_H};
export const TREE_TRUNK_SORT: u32 = ${TREE_BASE_Y};

export const CHAR_X: i32 = ${CHAR_AT.x};
export const CHAR_Y: i32 = ${CHAR_AT.y};
export const CHAR_SORT: u32 = ${CHAR_SORT};
export const CHAR_GROUP: u16 = ${CHAR_GROUP};

export const LANTERN_X: i32 = ${LANTERN_AT.x};
export const LANTERN_Y: i32 = ${LANTERN_AT.y};
export const LANTERN_SORT: u32 = ${LANTERN_SORT};
/** What the sort is supposed to be; the revert test asks the guest for the
 *  wrong one on purpose (\`--lantern-behind\`) and the assertion must fail. */
export const LANTERN_SORT_WRONG: u32 = ${CHAR_SORT - 10};

// ── the probes, and the colours each must show ──────────────────────────────
//
// Screen coordinates. \`back\`/\`front\` are the two z assignments: the art is
// the same, only the composite order changes, which is what the composite test
// is about.

export const PROBE_COMPOSITE_X: i32 = ${CHAR_AT.x + probe.x};
export const PROBE_COMPOSITE_Y: i32 = ${CHAR_AT.y + probe.y};
export const COMPOSITE_BACK: u8[] = [${composite[2].join(', ')}];   // backpack z=2 wins
export const COMPOSITE_FRONT: u8[] = [${composite[0].join(', ')}];  // body z=2 wins

export const PROBE_CROWN_X: i32 = ${crownScreen.x};
export const PROBE_CROWN_Y: i32 = ${crownScreen.y};
export const CROWN_BACK: u8[] = [${crownStack[crownStack.length - 1].rgba.join(', ')}];
export const CROWN_FRONT: u8[] = [${crownStack[0].rgba.join(', ')}];

export const PROBE_LANTERN_X: i32 = ${LANTERN_AT.x + 8};
export const PROBE_LANTERN_Y: i32 = ${LANTERN_AT.y + 8};
export const LANTERN_COLOUR: u8[] = [${lanternColour.join(', ')}];

/** One pixel per page, all in one frame: the multi-atlas proof. */
export const PROBE_PAGE_A_X: i32 = ${GROUND_ORIGIN.x + 8};
export const PROBE_PAGE_A_Y: i32 = ${GROUND_ORIGIN.y + 8};
`;

writeFileSync(join(here, 'src', 'scene.generated.ts'), scene);

// The same numbers for the runner, which is JavaScript and cannot import a
// TypeScript module of `as const` objects. Emitting both from one place is what
// keeps the guest's scene and the test's expectations from diverging.
writeFileSync(join(here, 'scene.json'), JSON.stringify({
  canvas: CANVAS,
  pageFiles: pageFiles.map((p) => `textures/${p.name}`),
  pageSlots: pageFiles.map((p) => p.slot),
  pages: PAGE_COUNT,
  pageSize: PAGE,
  tileset: { width: IMG_W, height: IMG_H, tile: TILE, columns: COLUMNS, tiles: (IMG_W / TILE) * (IMG_H / TILE) },
  picks: PICKS,
  pagesOf: { tree: PAGE_TILESET_A, character: SLOT_CHARACTER, lantern: PAGE_TILESET_B },
  probes: {
    composite: { x: CHAR_AT.x + probe.x, y: CHAR_AT.y + probe.y },
    crown: crownScreen,
    lantern: { x: LANTERN_AT.x + 8, y: LANTERN_AT.y + 8 },
    pageA: { x: GROUND_ORIGIN.x + 8, y: GROUND_ORIGIN.y + 8 },
  },
  expect: {
    compositeBack: composite[2],
    compositeFront: composite[0],
    crownBack: crownStack[crownStack.length - 1].rgba,
    crownFront: crownStack[0].rgba,
    lantern: lanternColour,
    lanternBehind: lanternBehindColour,
    pageA: pixelAt(pages[PAGE_TILESET_A], PAGE, GROUND.x + 8, GROUND.y + 8),
    pageB: lanternColour,
    pageC: composite[2],
  },
}, null, 2));
console.log(`${RUNNER}: wrote src/scene.generated.ts`);
console.log(
  `${RUNNER}: tree slices sort ${TREE_BASE_Y - TREE_SLICE_H} / ${TREE_BASE_Y}, ` +
  `character ${CHAR_SORT}, lantern ${LANTERN_SORT}`,
);
