# examples/2d/assets — the tileset the examples render

```
build-tileset.mjs   draws the sheet: terrain, props, tree, character
png.mjs             RGBA8 PNG encode and decode, no dependencies
tileset.png         3072x1024, three 1024px pages, committed (CC0, LICENSE.md)
```

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

Three pages, and the split is deliberate rather than tidy:

- **page 0** — terrain and the tree. The tree is 32×64 so it can be sliced into
  a crown and a trunk at y=32, which is what the depth test needs.
- **page 1** — props and the lantern. Separate from page 0 so the scene samples
  two array layers for statics alone.
- **page 2** — the character, three 16×32 layers side by side (body, hair,
  backpack). The composite test needs the three layers at one world position
  with three distinct colours where they overlap.

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
