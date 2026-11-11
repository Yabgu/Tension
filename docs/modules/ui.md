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
