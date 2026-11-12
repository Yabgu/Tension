# tension-ui — the toolkit and the app shell

`tension-ui` is the part of the guest SDK that draws a user interface with sprite
records, and `tension-app` is the frame loop and window lifecycle an application
holds it in. Both were lifted out of the documentation viewer, which had grown
them one bug at a time; the editor is the second caller, and a second caller is
what turns "the viewer does this" into an API.

The module names are `assembly/ui/` and `assembly/app/shell.ts`. Everything here
is re-exported from `tension-framework`, so a guest imports a name rather than a
path.

## 1. What is in the toolkit

| file | what it owns |
|---|---|
| `ui/theme.ts` | what an *atlas* is: cell size, the colour/weight stripe, the chrome cells, the record budget |
| `ui/painter.ts` | sprite records: rectangles, rules, glyphs, and the clip |
| `ui/flow.ts` | where a line ends: wrapping, column counts, centring, the vertical rhythm |
| `ui/hit.ts` | click targets, recorded by the draw that produced them |
| `ui/fonts.ts` | a baked (font, size) page — its baseline, pitch and advances — and the book that indexes them |
| `ui/widget.ts` | the four shapes a panel is made of: label, rule, button, list row |
| `app/shell.ts` | session, window, canvas, resize, texture reload, input attach, the close button, teardown |

The split is not decorative. `theme.ts` and `painter.ts` are about *pixels*;
`flow.ts` is about *where text goes*; `hit.ts` is about *what a click lands on*.
They are separate because the bugs they prevent are separate, and each file's
header records the measurement behind it.

## 2. The three rules the whole thing rests on

**Nothing is tinted and nothing is stretched.** A sprite record has one `w`/`h`
pair, used for the destination quad *and* the source texel rect, so a record
cannot be scaled and has no tint. A coloured glyph is a coloured glyph in the
atlas; a panel is **tiled** from cells rather than enlarged, which is why
`tileCost` exists — so a caller can decide what a rectangle costs *before*
drawing it.

**Black is the background.** The renderer clears to opaque black. A full-window
fill at 1280x720 costs about 4,000 records, which is the entire per-frame budget
(4096, summed across buckets), so a UI is lines and text on black: panels draw
their edges.

**The draw records the hit targets.** A hit test that recomputes positions is a
second layout, and the two drift — measured here, when the viewer's result rows
were drawn at one pitch and tested at another, so a click selected the row below
the pointer. `Hits.add` is called from the draw, and `Hits.at` answers the
**last** match, which is the one drawn on top.

## 3. The painter

```ts
const p = new Painter();                  // the default theme: the 2x atlas
p.reset();
p.setClip(x, y, w, h);                    // optional; every draw is trimmed to it
p.fill(x, y, w, h, CHROME_PANEL);         // tiled; `tileCost(w, h)` says what it costs
p.textBytes(chars, 0, len, x, y, NORMAL, REGULAR, CELL_W, clipTop, clipBottom);
p.textBytes(chars, 0, len, x, y, MUTED,  REGULAR, 0, clipTop, clipBottom, page);  // proportional
p.submit(canvas, pipe);                   // one bucket; records go to the canvas
```

A glyph outside the clip emits nothing; one straddling the edge is trimmed by
shortening its **source** rect, which works because at this size source and
destination are the same pixels. The vertical band is passed per call and the
horizontal one comes from the clip, because a scrolling page only ever needs the
first.

`Painter.text` **never breaks a line.** A painter that also honoured `\n` would
break a line the layout had already placed — the orphaned-word bug — so a
control byte is treated as a space and `flow.ts` owns the wrapping.

## 4. The flow

```ts
cols = fitColumns(paneWidth, padding, MAX_COLS);   // capped, floored, never zero
x    = centred(paneX, paneWidth, cols, px(4));     // centred, never against the edge
take = breakLine(chars, start, end, cols);         // never leaves a leading space
```

`breakLine` has three rules worth knowing exactly, because the obvious variants
are wrong: the candidate line is `[start, start+cols)`, a break at a space
excludes the space, and a space at `start+cols` is itself a valid break (it
yields the widest line that fits). A token longer than the column breaks
mid-word rather than spilling.

## 5. The hit list

```ts
hits.begin();                      // once per frame, where the draw begins
hits.add(x, y, w, h, id, tag);     // where the target is *drawn*
const id = hits.at(mouseX, mouseY); // topmost match, or -1
```

The press edge is not here: `input.Snapshot.buttonPressed(n)` already answers
"went down since the previous read" by latching the previous mask where the
record is read, and a second mechanism would be a second answer.

## 6. The app shell

```ts
class MyApp extends AppShell {
  protected loadAssets(canvas: Canvas, pipe: i32): bool {   // textures; twice per session
    const atlas = canvas.loadTextureFromRes("/ui.iwi");
    if (atlas <= 0) return false;
    return canvas.bindTexture(pipe, 0, atlas) == 0;
  }

  protected draw(p: Painter): void { /* one frame, records only */ }
}

export function _start_game(): void { new MyApp().run(); }
```

`run` is: ask the close button, poll the window size, attach input if it is still
pending, `update()`, `into the painter`, `present()`, `RuntimeSession.wait(16)`.
The shell resets the painter before `draw` and submits it after, so a frame
cannot be built and never sent.

**`onResize` runs before the canvas comes back.** A canvas is fixed for its
lifetime, so a resize is `close()` and a new `open()` — and the app's layout has
to be recomputed and its scroll clamped *before* the frame that draws against the
new size, or a window dragged wider leaves the reader past the end of content
that just got shorter. That is why the hook is arithmetic on the size and nothing
else: no canvas, no textures, nothing the reopen is about to destroy.

## 7. The five measurements the shell carries

Each of these was found by running an app, and each is why the code looks the way
it does rather than being a preference:

1. **A reopen must claim the window with `OPEN_WINDOWED`.** `windowedOrOffscreen`
   tests `platform.hasSurface()`, which is false for a window an SDL_GPU device
   owns, so it would try to create a window that already exists and then quietly
   open *offscreen* — a resize that stops presenting.
2. **A refused close abandons the resize.** Opening anyway answers `-EBUSY` and
   leaves no drawable canvas at all, which is worse than one stale frame.
3. **The close button must be asked for.** The renderer learns of a close from
   its own pump and the host pumps too; whichever drains SDL's quit event is the
   only one that sees it, and it is normally the host's.
4. **`input.attach` answers `-ENODEV` for the first frames** while the window
   comes up, so a failure is a retry rather than a crash.
5. **The headless bound is the shell's.** An offscreen run has no window to close
   and would loop until something kills it; a bound makes `--headless` a job that
   finishes, which is what a CI check and a screenshot harness both need.

## 8. What is not here

No retained widget tree, no layout solver, no styling layer, and no scene: an
app draws in `draw()` from its own state, every frame. A game that wants
retained, declarative drawing uses `Scene` and `scene.run`, which is a different
shape for a different job — `Scene` keeps bytes between frames and this toolkit
rebuilds a frame's records on purpose, because a UI's cost is its *text* and text
is what changes when a panel scrolls.

## 9. Tests

`guest-ui.ts` in `tension-framework/tests` is the toolkit's gate, with no canvas
and no GPU: wrapping (including the space-at-the-limit rule), the column floor
and cap, centring, `tileCost` against what `fill` actually emits, the clip
(whole-cell skip, straddle trim, nothing-outside), the budget's refusal and
count, and hit testing's topmost-wins. The pixel half is proved by the two apps
that ship on it — `apps/docs` (whose `verify` checks the atlas against
`theme.ts`) and the editor.

## 10. Baked fonts: outlines in, pages out

The atlas used to be an 8x16 ROM font, which is why the toolkit's text is
arithmetic: every glyph advanced one cell, so "does this fit" was a division.
Real panels want real type — proportional advances, a real bold face, two sizes
— so `tools/font/bake-ttf.mjs` rasterizes TrueType outlines at the exact pixel
size they will be drawn at.

**Nothing is scaled at draw time**, and that is the constraint the whole design
follows from. A record carries one `w`/`h` pair and the vertex shader uses it for
the destination quad *and* the source texel rect, and the sampler is
`Filter::Nearest` on all three axes. A glyph can therefore only be drawn at the
size it was baked at, so there is one **page** per (font, size) and `SizeId`
selects a bake rather than a scale.

| piece | what it is |
|---|---|
| `assets/fonts/fonts.json` | the spec: faces, pages, and the **pairs** (colour, weight) each page bakes |
| `tools/font/bake-ttf.mjs` | opentype.js parses, an adaptive scanline rasterizer draws, `assets/ui.N.iwi` comes out |
| `assets/ui.json` | the manifest: dimensions, per-page cell/grid/baseline/pitch, pairs, advances |
| `assembly/ui/fonts.generated.ts` | the same numbers as compile-time constants — what the guest actually reads |
| `tools/font/verify-atlas.mjs` | compares all three, and reads back the cell a glyph claims |

**Three artifacts, one bake, and the verifier exists because they can drift.**
TensionScript has no JSON parser, so the metrics reach the guest as generated
source rather than as a data file it would have to parse. `ui.json` is the
contract and a person's reference. `verify-atlas.mjs` decodes the IWI headers and
checks the manifest against the generated literals — because a bake that
regenerated two of the three does not throw, it draws glyphs from neighbouring
cells, which reads as "the font broke".

**Anti-aliasing is ours.** opentype.js parses and flattens; it does not
rasterize. Curves are subdivided to 0.2 px and each pixel row is sampled by four
sub-scanlines with exact horizontal coverage at every span end, nonzero winding.
The alpha channel is *coverage*, which is what makes 14 px read as text rather
than as stairs. `PAD` is one pixel, and the baker refuses a bake whose glyph ink
touches a cell's outer ring — that is ink the neighbouring cell owns.

**Advances are quarter-pixels.** The painter places a glyph at an integer pixel,
so a subpixel advance is not drawable; but rounding each advance to a whole pixel
puts a forty-character line up to twenty pixels off, and the error grows with the
line. So the table is in 1/4 px and the painter rounds the *accumulated* position
rather than each step: every glyph lands within an eighth of a pixel and nothing
accumulates. It costs one shift per glyph.

**A pair nobody draws is VRAM, so pairs are declared.** The default spec bakes six
of the ten (colour x weight) combinations: five colours regular, plus bold
headings. Asking for one that was not baked is a *missing stripe* — `cellOf`
answers -1 and the painter draws nothing — rather than a recolour or a
neighbour's glyph. Adding a pair is a spec line and a re-bake.

`FONT_ATLAS_SIZE` is shared across pages because a pipeline binds its pages as
layers of one texture array, so every page is the same dimensions even though each
lays its own grid with its own cell size. Three pages of the default atlas are
3.7 MiB on disk; the tile cost of a fill is the *page's* cell, which is why the
UI still draws panel edges rather than backgrounds.

## 11. Future: Dynamic Text (SDL_ttf 3)

Baked bitmaps are the right answer for a **fixed, deterministic** UI — the editor,
the documentation viewer, any surface whose type sizes are known at build time.
They are the wrong answer for text whose size is not: a game that renders a chat
log, a dialogue box that scales with a cinematic, a debug overlay whose font size
follows a settings slider, a nameplate drawn at whatever distance the camera
happens to be. Baking every size is not a strategy — it is a page per size per
face, and the atlas doubles each time someone drags a slider.

The plan is therefore **two pipelines, not one replacing the other**:

* **Baked** (`ui.N.iwi`) stays the UI's font system. It is exact, it is
  deterministic, it costs one record per glyph, and it needs no font engine in
  the guest or the host.
* **Dynamic** will be a host-side **SDL_ttf 3** capability. The guest names a
  face, a pixel size and a string; the host rasterizes and caches the surface,
  and the guest draws it as one textured quad — or as a texture it binds and
  samples, which is the more likely shape given the record format.

What it will require, stated now so the ABI change is not a surprise:

* **A new ABI slot.** A `tension::text`-shaped capability (or an addition to
  `tension::2d`) with three verbs at minimum: *rasterize* (face, size, string →
  texture id and metrics), *measure* (the same arithmetic without the texture),
  and *release* (a cache is only a cache if the guest can drop from it).
* **A new pipeline in the renderer**, because dynamic text needs `Linear`
  sampling and a texture per size — the opposite of the fixed grid the baked
  pipeline assumes. `set_pipeline`/`set_texture` already model this; the work is
  a preset whose sampler is linear and whose pages are arbitrary.
* **A cache with a budget.** Dynamic text is unbounded by construction: every new
  string is a new atlas. The host will need an LRU with a byte ceiling, and the
  guest a way to ask what it holds.

What it will **not** do: replace `Painter`'s baked path, the atlas format, or the
metrics table. A UI built on baked pages keeps its one-record-per-glyph cost and
its build-time guarantee that every character it can draw exists. The two paths
meet at the record: a baked glyph and a dynamic quad are both `(x, y, src rect,
page)`, so a widget drawn with either looks the same to everything above the
painter.
