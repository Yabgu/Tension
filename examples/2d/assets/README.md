# examples/2d/assets — the tileset the examples render

```
build-tileset.mjs   draws the sheet: terrain, props, trees, character, icons
png.mjs             RGBA8 PNG encode and decode, no dependencies
tileset.png         384x128, three 128px pages, committed (CC0, LICENSE.md)
```

Three 128px pages, 64 cells each, 141 pieces. Every page is at least 70 % full
of tiles — asserted by the generator, not left to inspection.

`tileset.png` is generated but committed, because the examples and their tests
need it and a build step that must run before anything else is a build step
someone forgets. Regenerate it after editing the drawing code:

```sh
node examples/2d/assets/build-tileset.mjs
```

The output is deterministic — fixed seeds, no `Math.random` — so regenerating an
unchanged script produces identical bytes. If a diff appears, something in the
drawing code changed, which is what you want to know.

## The layout is a contract

`LAYOUT` in `build-tileset.mjs` names every piece and its rectangle. The
example's build reads that table and nothing else, so there are no coordinates
hardcoded in a test or a guest. Adding a tile means adding an entry there and
drawing it.

Three pages, and the split is by role rather than by size:

- **page 0** — terrain: three materials (grass, dirt, stone), each as a
  16-variant autotile set, plus sixteen decorations.
- **page 1** — props: two conifers, a broadleaf, a dead tree, the furniture, the
  lantern, the well. A 32×64 tree lives here because it is sliced into a crown
  and a trunk at y=32, which is what the depth test needs.
- **page 2** — the character (four facings × three layers) and 32 icons.

## Autotiles

The terrain is not sixteen swatches of one colour. Each material has sixteen
variants, one per neighbour mask: bit 1 = north neighbour matches, 2 = east,
4 = south, 8 = west. Variant `0b1111` is an interior tile; variant `0` is an
isolated one with edges on all four sides. That is what lets a map drawn from
these tiles have outlines instead of a checkerboard of identical squares — and
it means page 0 is full of tiles that are all different.

## Packing

`pack()` places every piece first-fit, tallest-first, and throws if one does not
fit. There are no coordinates in the file to get wrong, and `LAYOUT` is the
packer's *output*. The generator also refuses to write a sheet whose pages fall
below `MIN_DENSITY` (70 %), because a page that is mostly transparent wastes
texture memory and reads as an unfinished asset. An earlier version of this
sheet was 1024×1024 pages holding the same few dozen tiles: 5 % full, 12 MB of
texture, and — correctly — a complaint.

## Why not real art

This could have been a CC0 pack from OpenGameArt or Kenney, and that would have
worked. Two reasons it is drawn instead:

1. **The tests assert exact pixels.** An expected colour read off a downloaded
   PNG is a function of an opaque binary; a colour read off a sheet whose
   palette is a constant in this repository is a fact you can check by reading
   ten lines.
2. **A downloaded binary is a dependency on someone else's URL.** The previous
   version of this example used one, and the example exited 77 on any machine
   that did not have it — including CI. That is a worse outcome than slightly
   less handsome art.

If you do want to try a real pack, the shape is here: replace `tileset.png`,
keep the three-page split, and update `LAYOUT`. `examples/2d/isometric/build.mjs`
computes its probes from whatever pixels it finds, so it adapts.

## Drawing notes

The raster helpers are small on purpose: `plot`, `rect`, `hline`, `vline`,
`spans`, `ellipse`, and a seeded `rng`. `spans` — a table of
`[y, x0, x1, colour]` rows — is how the character and the props are shaped,
because a silhouette that is nearly right reads as a rectangle.

Shading is three tones per material (light, base, dark) applied by position
within the shape, not a gradient. That is what makes 16px art read at 16px.
