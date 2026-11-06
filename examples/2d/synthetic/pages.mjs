// examples/2d/synthetic/pages.mjs — the synthetic isometric scene, in one place.
//
// Why this exists: `examples/2d/isometric/` proves the three 2D problems on
// LimeZu's art, but that art is third-party and not in the tree, so CI cannot run
// it. This is the same scene with the same geometry, drawn from flat colour cells
// instead of painted tiles. Every number below is the real example's number (canvas, sprite
// positions, sort keys, slice height, group id); only the pixels differ.
//
// One definition, three consumers:
//
//   build-synthetic-assets.mjs  writes the pages as PNGs, for a human to look at
//   emit.mjs                    writes the pages as IWI + the scene table the
//                               guest compiles against
//   test-synthetic.mjs / the framework example's runner
//                               read `scene()` for the probes and the colours
//
// Nothing here reads the art back: the pages are generated from COLOURS, so the
// expected colour at a probe is a value this module knows by construction. That
// is weaker than the real example (which reads its expectations off the source
// images) and it is the right trade for a CI fixture — there is no source image
// to drift from.

export const PAGE = 1024;
export const PAGE_COUNT = 3;
export const TILE = 16;

/// The flat colours. Every one is distinct and none is black: the sort tests
/// read a pixel and name the layer it came from, so two layers sharing a colour
/// would make a wrong order invisible.
export const COLOURS = {
  ground: [86, 160, 72],    // grass green
  crown: [34, 96, 48],      // dark green, the tree's top slice
  trunk: [122, 86, 52],     // brown, the tree's bottom slice
  lantern: [242, 196, 60],  // warm yellow
  body: [206, 164, 130],    // tan
  hair: [96, 62, 40],       // dark brown
  backpack: [58, 92, 186],  // blue
};

/// Where each piece of art sits *inside its page*, and which page that is.
///
/// The tree is two 32x32 cells stacked, which is what makes it sliceable: the
/// crown and the trunk become two records with two sort keys and the character
/// stands between them.
export const PIECES = {
  ground: { page: 0, x: 0, y: 0, w: 16, h: 16 },
  crown: { page: 0, x: 32, y: 0, w: 32, h: 32 },
  trunk: { page: 0, x: 32, y: 32, w: 32, h: 32 },
  lantern: { page: 1, x: 0, y: 0, w: 16, h: 16 },
  body: { page: 2, x: 0, y: 0, w: 16, h: 32 },
  hair: { page: 2, x: 16, y: 0, w: 16, h: 32 },
  backpack: { page: 2, x: 32, y: 0, w: 16, h: 32 },
};

/// The character layers are not full cells. Real art has the hair over the head
/// and shoulders and the pack on the lower back; flat rectangles that all fill
/// the cell would make "the hair is on top at the centre" untestable, because
/// every layer would be on top everywhere. These row spans reproduce the shape
/// the real sprites have, so the two probes below mean what they say:
///
///   centre (8,16)   body + hair            -> back: hair,      front: body
///   pack   (8,24)   body + backpack        -> back: backpack,  front: body
export const LAYER_ROWS = {
  body: { top: 0, bottom: 31 },
  hair: { top: 6, bottom: 20 },
  backpack: { top: 18, bottom: 29 },
};

// ── the scene, in world pixels — the real example's numbers ─────────────────

export const CANVAS = { w: 320, h: 180 };

export const GROUND_ORIGIN = { x: 64, y: 72 };
export const GROUND_COLS = 6;
export const GROUND_ROWS = 6;

export const TREE_AT = { x: 96, y: 54 };   // 32x64
export const TREE_SLICE_H = 32;
export const TREE_BASE_Y = TREE_AT.y + 64; // 118

export const CHAR_AT = { x: 100, y: 58 };  // 16x32
export const CHAR_FEET_Y = CHAR_AT.y + 32; // 90
export const CHAR_SORT = CHAR_FEET_Y - 2;  // 88, feet_offset 2
export const CHAR_GROUP = 200;

export const LANTERN_AT = { x: CHAR_AT.x - 8, y: CHAR_AT.y + 16 }; // 92,74
export const LANTERN_SORT = LANTERN_AT.y + 16;                     // 90

/// The two sort keys the tree slices get. The prompt's numbers, and the same
/// arithmetic the real build uses: a slice sorts by its own bottom edge.
export const TREE_CROWN_SORT = TREE_BASE_Y - TREE_SLICE_H; // 86
export const TREE_TRUNK_SORT = TREE_BASE_Y;                // 118
/// What `--lantern-behind` asks for: below the character, so the character wins.
export const LANTERN_SORT_WRONG = CHAR_SORT - 10;          // 78

// ── the probes ──────────────────────────────────────────────────────────────
//
// Screen coordinates, and what each must show. `hair` and `pack` are the two
// composite probes: the sprite centre, where hair covers body, and the lower
// back, where the pack covers body.

export const PROBES = {
  // The composite. `pack` is the one the isometric guest prints as its
  // composite probe (the same sprite pixel the real scene uses), `hair` is the
  // centre, which is what "the hair is on top facing back" means.
  pack: { x: CHAR_AT.x + 8, y: CHAR_AT.y + 24 },
  hair: { x: CHAR_AT.x + 8, y: CHAR_AT.y + 16 },

  // Depth, in three probes: the crown is behind the character at one, the
  // character is in front of the crown at another, and the trunk is in front of
  // the character at a third. Together they say "the character is between the
  // two slices", which is the claim slicing exists for.
  crownOnly: { x: TREE_AT.x + 2, y: TREE_AT.y + 16 },
  crownOver: { x: TREE_AT.x + 16, y: TREE_AT.y + 16 },
  trunkOver: { x: CHAR_AT.x + 8, y: TREE_AT.y + 34 },

  // The lantern, at its centre.
  lantern: { x: LANTERN_AT.x + 8, y: LANTERN_AT.y + 8 },

  // One pixel of pure ground: page 0, nothing over it.
  pageA: { x: GROUND_ORIGIN.x + 8, y: GROUND_ORIGIN.y + 8 },
};

/// Draw the three pages. Pure function of the constants above: same bytes every
/// run, so a stale page cannot masquerade as a change in the renderer.
export function buildPages() {
  const pages = [];
  for (let i = 0; i < PAGE_COUNT; i++) pages.push(Buffer.alloc(PAGE * PAGE * 4));

  const fill = (piece, colour, rows) => {
    const page = pages[piece.page];
    const top = rows ? rows.top : 0;
    const bottom = rows ? rows.bottom : piece.h - 1;
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < piece.w; x++) {
        const at = ((piece.y + y) * PAGE + piece.x + x) * 4;
        page[at] = colour[0];
        page[at + 1] = colour[1];
        page[at + 2] = colour[2];
        page[at + 3] = 255;
      }
    }
  };

  fill(PIECES.ground, COLOURS.ground);
  fill(PIECES.crown, COLOURS.crown);
  fill(PIECES.trunk, COLOURS.trunk);
  fill(PIECES.lantern, COLOURS.lantern);
  for (const name of ['body', 'hair', 'backpack']) {
    fill(PIECES[name], COLOURS[name], LAYER_ROWS[name]);
  }
  return pages;
}

/// The scene as the runners and the emitter want it: one object, no prose.
export function scene() {
  const page = (name) => PIECES[name].page;
  return {
    canvas: CANVAS,
    page: PAGE,
    pageCount: PAGE_COUNT,
    tile: TILE,
    pages: [
      { slot: 0, name: 'page0.iwi', pieces: ['ground', 'crown', 'trunk'] },
      { slot: 1, name: 'page1.iwi', pieces: ['lantern'] },
      { slot: 2, name: 'page2.iwi', pieces: ['body', 'hair', 'backpack'] },
    ],
    pieces: PIECES,
    colours: COLOURS,
    probes: PROBES,
    // The composite's two z assignments, by facing. Back: the pack is on the
    // back, so z=2 draws it over the body. Front: the body is nearest, z=2.
    zTable: {
      body: [0, 2, 0, 0, 0, 0, 0, 0],
      hair: [1, 1, 0, 0, 0, 0, 0, 0],
      backpack: [2, 0, 0, 0, 0, 0, 0, 0],
    },
    world: {
      ground: { origin: GROUND_ORIGIN, cols: GROUND_COLS, rows: GROUND_ROWS, tile: 16 },
      tree: {
        x: TREE_AT.x, y: TREE_AT.y, w: 32, h: 64,
        sliceHeight: TREE_SLICE_H,
        crownSort: TREE_CROWN_SORT, trunkSort: TREE_TRUNK_SORT,
      },
      character: {
        x: CHAR_AT.x, y: CHAR_AT.y, w: 16, h: 32,
        sort: CHAR_SORT, group: CHAR_GROUP,
      },
      lantern: { x: LANTERN_AT.x, y: LANTERN_AT.y, w: 16, h: 16, sort: LANTERN_SORT, sortWrong: LANTERN_SORT_WRONG },
    },
    /// What each probe must show, for the two facings. `crownOver` and
    /// `crownOnly` carry the character's colour on top, which is the claim.
    expect: {
      back: {
        pack: COLOURS.backpack,
        hair: COLOURS.hair,
        crownOnly: COLOURS.crown,
        crownOver: COLOURS.hair,
        trunkOver: COLOURS.trunk,
        lantern: COLOURS.lantern,
        pageA: COLOURS.ground,
        pageB: COLOURS.lantern,
        pageC: COLOURS.backpack,
      },
      front: {
        pack: COLOURS.body,
        hair: COLOURS.body,
        crownOnly: COLOURS.crown,
        crownOver: COLOURS.body,
        trunkOver: COLOURS.trunk,
        lantern: COLOURS.lantern,
        pageA: COLOURS.ground,
        pageB: COLOURS.lantern,
        pageC: COLOURS.backpack,
      },
      /// The colour that appears when a mistake is made, so a revert test can
      /// name what it caught instead of saying "something changed".
      wrong: {
        compositeSwapped: COLOURS.body,      // backpack/body z swapped, facing back
        lanternBehind: COLOURS.backpack,     // the character wins at the lantern's pixel
        noSlice: COLOURS.crown,              // one unsliced tree record, in front
        brokenGroup: COLOURS.body,           // one layer in its own group
      },
    },
  };
}
