# Spike: the record budget for a nested guest

**Question.** Nested-guest Play Mode has one hard resource: a frame stages
**4096 sprite records across all buckets** (`tension-core/src/render2d/device.rs:52`,
`:505-509`). The plan's central claim is that a real 2D scene fits in that
budget beside the editor's own chrome. If it does not, the whole record path
(`docs/spikes` §"why records") is worth less than a pixel path and the design
changes before Pass 1 starts.

**Verdict: GO.** A 2400-cell scene costs 2410 records and fits beside the
editor's Play-mode chrome (904) with room to spare. The ceiling is exactly
4096 — 4095 is accepted, 4100 is refused — and the refusal is **whole-frame**,
which is what makes a cap that is decided *before* the inner guest draws
necessary rather than nice.

## Reproduce

```sh
node scripts/spike-records-budget.mjs                 # 40x60 = 2400 cells
node scripts/spike-records-budget.mjs --cols 5 --rows 817 --canvas 80x13072
node scripts/spike-records-budget.mjs --cols 65 --rows 65 --canvas 1040x1040
```

The subject is `examples/2d/isometric`, because its scene table is generated
from committed art and its frame is written record by record. Nothing about the
example changed: `build.mjs` grew `--cols/--rows/--canvas/--origin`, and with no
flags it writes exactly the 6x6 frame it always did. Every artifact the probe
regenerates (`src/scene.generated.ts`, `scene.json`, `build/`) is gitignored.

## Measurements

Host: Linux 6.18 (WSL2), 12 cores, `SDL_VIDEODRIVER=offscreen`, in-core
`render2d`, dzn ICD. Guest: TensionScript 0.14.1, release.

| grid | ground cells | records/frame | submit | cells painted | non-black px |
| --- | --- | --- | --- | --- | --- |
| 6x6 (the example's own frame) | 36 | 46 | accepted | — | — |
| 40x60, canvas 640x960 | 2400 | **2410** | accepted | **2400/2400** | 614400/614400 |
| 5x817, canvas 80x13072 | 4085 | **4095** | accepted | 4085/4085 | 1045760/1045760 |
| 65x65, canvas 1040x1040 | 4225 | 4235 | **refused `-28`** | 0 | — |

`records/frame` is `RECORD_COUNT` from the generated table; the guest sizes its
record buffer from that constant and submits exactly that many
(`examples/2d/isometric/src/main.ts:45`, `:317`), so the count the guest
submits *is* the count the table declares. "submit accepted" is the guest's own
`accepted != count` check staying silent (`main.ts:341-345`). "cells painted" is
each ground cell's centre pixel read back out of the guest's frame bytes — a
record that was counted but never drawn leaves that pixel black.

Two things this first section does **not** use, deliberately:

- `Scene.dropped` (the framework's pack counter). The isometric guest writes
  records by hand and submits them directly, so the framework's `Scene` is not
  in the path — §"The framework path" below measures that separately, because
  `Scene` is what a nested guest actually calls.
- The example's own probe assertions. They are pixel claims about sort order,
  not about budget, and they are unchanged at the default grid.

The 4095/4235 pair brackets the ceiling to within 5 records of the `MAX_RECORDS`
constant. The refusal at 4235 is a single line — `FAIL: submit(back) -> -28,
expected 4235` — with **no frame at all**: not 4096 records and a truncated
tail, nothing. `device.rs:505-509` returns before any record is copied.

## The framework path: `Scene.dropped` and `Scene.commit()`

A nested guest will not write records by hand. It calls
`Scene.create(w, h, capacity)` and `scene.commit(canvas, pipe)`, and the number
that tells it it asked for too much is `Scene.dropped`
(`tension-framework/assembly/2d/scene.ts:347`, incremented in `pack()` at
`:673-676`). So the same grid is measured through the framework, by a guest the
probe generates into `.tmp/spike-scene-guest/` (gitignored, not an example).

| capacity | cells on a canvas that shows them | live | `commit()` | `dropped` | painted |
| --- | --- | --- | --- | --- | --- |
| 2400 | 2400 (640x960) | 2400 | **2400** | **0** | 2400/2400 |
| 5041 | 5041 (1136x1136) | 5041 | **4096** | **945** | — |

`dropped = 5041 - 4096 = 945`, exactly the renderer constant, and `commit()`
reports the 4096 that were staged. That is the mechanism a nested guest relies
on: over-budget is **reported**, not silently truncated.

**Culling happens before the budget check, and that is load-bearing.** A first
run of this measurement used a 5041-cell grid on the 640x960 canvas and got
`accepted=2400 dropped=0`: the 2641 cells past the canvas edge were culled in
`pack()` (`scene.ts:665-667`) and never reached the capacity test. So the
budget is spent on *visible* content only, and a game whose world is larger
than its viewport is not penalised for the part it is not showing.

## The editor's chrome, measured

Same session, same document (6 nodes, 1 selected), window 1600x900:

| mode | `ui rec` in the status bar | viewport |
| --- | --- | --- |
| Edit | **1133** | 916x582 |
| Play | **904** | 1600x822 |

**How it was read.** `cd apps/editor && node ../../packages/cli/bin/tension.js dev
--no-watch` builds the guest and runs it in a 1600x900 window; clicking Play at
`(1453, 21)` switches the mode, and the status bar's left cell then reads
`<n> nodes  <n> selected  <n> ui rec`. The two numbers above are that cell, in
each mode, with the document the editor opens with (`log: ready: 5 nodes`, plus
the one node `ctrl+a` adds, which is why the chrome is 1133 and not 1121).

**The number is the evidence, so the number is what is kept.** No screenshot is
committed for this measurement: a PNG is a blob that history keeps forever, and
what a reader needs is the figure, the window size, the document, and how to
reproduce it — all of which this section states. A measurement that genuinely
needs an image is a UT/E2E reference fixture in the test tree, where the image
is an input something asserts against rather than an artifact.

An earlier reading on the editor pass, against the editor's 5-node opening
document, gave 1121 `ui rec` in Edit — so Edit chrome is ~1120-1135 and moves
with the tree's node count and the open console lines. The 1133 above is that
same document plus the one node `ctrl+a` adds. Both readings are quoted as
numbers, not as images: the earlier one was taken before this rule existed, and
its capture was never committed either (`apps/editor/screenshots/` is
gitignored).

These numbers are the **UI painter's** records only (`AppShell.lastRecords`,
`tension-framework/assembly/app/shell.ts:342`). The game's records are a
separate submit into bucket 0 and are not counted in the status bar.

## Budget arithmetic

- Renderer ceiling: **4096** records, summed across buckets (`device.rs:52`).
- Editor chrome in Play: **904** measured.
- Headroom for the chrome's own variance: **128**.
- Nested cap: `4096 - 904 - 128 =` **3064**.
- The spike scene: **2410**. Fits with 654 records spare.

The cap must be applied to the **inner guest's** `submit`, not to the outer
one's. If it is applied later, at the editor's chrome submit, the renderer
refuses the whole bucket and the *chrome* disappears while the game stays
visible — the inverse of the intent, and it reads as a crash. Refusing the
inner guest's submit puts the failure where it can be shown: the inner guest
already handles a refused commit (`tension-framework/assembly/2d/scene.ts:712-716`)
and the host can report it.

The rule is dynamic, not the constant 3064: `4096 - (last frame's chrome + 128)`,
floored at 2048. A spike cannot fix that number because the chrome grows with
the document — 904 is this document, on this window.

## What this fixes

- **Bucket assignment is already separate.** The editor draws the game into
  bucket 0 with the game pipeline and the UI into bucket 1 (`apps/editor/src/main.ts:661-664`,
  `:958-976`). Nested records join bucket 0. Bucket separation buys draw order
  and pipeline binding, **not** budget: the 4096 check sums buckets.
- **A cap is part of the ABI**, not a policy: the inner guest's `submit` is the
  only place the refusal is cheap and attributable.
- **The pixel path stays on the shelf.** At 916x582 a copied frame is ~2.1 MB
  per frame (~128 MB/s at 60 Hz, twice through the CPU) against 2410 records =
  67 KB.

## Not measured

- A real game's HUD. The editor's chrome is a *proxy* for "the other records in
  the frame", not the same thing; a game with its own HUD pays from the same cap.
- Any 3D guest. OGRE records are not sprite records; the record path does not
  apply (`docs/known-limitations.md` lists the same limit from the other side).
- Frame cost. The spike proves records *fit*; `tension-2d/bench/results.txt`
  measures what they cost to draw (1024 records ~ 0.21 ms net CPU).

## Status

This is the **Commit 0 gate** for the nested-guest pass. It measures; it does
not decide the design beyond the two points above.
