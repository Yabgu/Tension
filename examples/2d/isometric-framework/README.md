# isometric-framework — the same scene, built by a library

The isometric scene from [`../isometric`](../isometric), with one difference: the
forty-two records are not written by the guest. They come from three types in the
guest SDK, [`tension-framework/assembly/2d`](../../../tension-framework/assembly/2d):

```
Tileset         the sheet arrived as pages; ask it for a frame by pixel coordinate
IsometricWorld  add a tall sprite, get slices sorted by their bottom edge
Composite       add layers with a per-facing z table, get records grouped by sort key
```

The hand-written guest is the specification. Its `writeScene` is the ground loop,
the two tree slices with hand-computed sort keys, the three character layers with
their z values, and the lantern — every one of those decisions as arithmetic.
Here they are four calls:

```ts
world.addGround(tileset, tileset.frameNamed("ground"), x, y);
world.addStatic(tileset, tileset.frameNamed("tree"), 96, 54, 32);
world.addStatic(tileset, tileset.frameNamed("lantern"), 92, 74, 16);
world.addActor(character, 100, 58);
```

## What it proves

`npm start` renders both guests from the same synthetic scene and compares the
frames **byte for byte**:

```
  framework back == hand-written back: byte-identical (230400 bytes)
  framework front == hand-written front: byte-identical (230400 bytes)
```

That is the claim worth making. A framework that "renders the same scene" can
still differ in a field no probe reads — a sort key that happens to order
correctly, a group id that happens not to matter. Byte equality says the records
are equivalent in every field that reaches the frame.

Then the probes, and three revert levers:

```
  revert facing (front label, back table):  probe is (58,92,186)   the pack, not the body
  revert slicing (sliceHeight 0):           probe is (34,96,48)    the crown, not the character
  revert grouping (backpack in its own group): probe is (206,164,130) the body, not the pack
```

Each lever is a one-line change a real game could make by accident: a facing
selected without the z table following, a tall sprite added without slicing, a
layer that ends up in its own group. Each produces a *specific* wrong colour, and
the test asserts that colour rather than "something differed".

## Running it

```sh
npm install          # links the tension-framework SDK
npm start            # builds both guests, packs, renders, compares
```

No external assets: the pages are generated flat colour cells from
[`../synthetic/pages.mjs`](../synthetic/pages.mjs). The real-art version —
the one with the painted conifer and the character generator's layers — is
[`../isometric`](../isometric), and it needs the asset packs placed by hand
under `tension-2d/test-assets/`.

Screenshots land in `tension-2d/test-assets/screenshots/framework-{back,front}.png`.

## The API, and where it came from

| type | verb | why |
| --- | --- | --- |
| `Tileset.load(pages, w, h, tile)` | `frame(tileX, tileY)`, `frameForPixel(px, py, w?, h?)`, `define(name, frame)`, `bind(handle, pipe)` | pages are one row of the sheet, so a sheet pixel names its own page — the lantern on page 1 is `frameForPixel(1024 + x, y)` |
| `Composite.create(group, sortKey)` | `addLayer(tileset, name, zTable)`, `setFacing(n)`, `emit(out, x, y)` | `zTable` is one z per facing; that is what makes "facing back, the pack is on top" a column rather than a branch |
| `IsometricWorld.create()` | `addGround`, `addStatic(tileset, frame, x, y, sliceHeight)`, `addActor`, `emit(out)` | `sliceHeight` is the whole depth model; `0` means "do not slice" |

Three deviations from the sketch this was written against, each for a reason the
tests would have found later:

- **`addGround` exists.** The sketch used `addStatic` for the floor. Sorting a
  floor tile by its bottom edge puts the far row of the ground *in front of* a
  character standing at `y=88` and covers its feet. The floor's key is 0.
- **`frameForPixel` takes optional `w`/`h`.** A single-cell default cannot name a
  32×64 tree. `frameForPixel(112, 96, 32, 64)`.
- **Invalid lookups return an invalid `Frame`, not null.** In TensionScript a
  `Frame | null` return forces a null check at every use, and one missed check is
  a null dereference inside a frame loop. An invalid frame is inert: `addStatic`
  writes nothing for it.

## What this is not

`addActor` does not sort, and neither does `emit`. The adapter's comparator owns
ordering; a second implementation here would eventually disagree with it about
which of two equal keys comes first. The framework's job is to decide *what* the
records are, not what order they draw in.

This is also not a scene graph. There is no parent/child, no transform stack, no
animation. It is the layer between "the game knows where things are" and "the
adapter wants 28-byte records", which is what the worked example showed was
missing.
