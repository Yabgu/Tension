# Backlog: buffer rendering — embedding a nested guest in a host surface

**Status:** backlog, not a plan. Recorded before Pass 4 discovers it, because the
shape of the 2D record path and the shape of a 3D embedding pull in different
directions, and the difference has to be written down somewhere other than a
conversation. Nothing here is scheduled; the one thing this file settles is the
feasibility question at the bottom, which a later pass would otherwise have to
re-derive from scratch.

## What it is

"Buffer rendering" is the long-term path for embedding a nested guest into any
host surface: a docs page that runs a snippet, the editor's viewport, and the
bundled-docs feature. There are two paths, both required, and they are not
interchangeable — each is the only viable answer for a different class of guest.

**Texture rendering — mandatory for 3D, no substitute.** The inner guest renders
into a host-allocated render target on the *shared* GPU device, and the outer
guest binds that target as a page in its own pipeline. No CPU copy per frame.
This is the only viable path for 3D: a 3D scene is triangles and draw state, not
a sprite stream, and cannot express itself as records no matter how the record
format grows. It is also the model the bundled-docs feature needs, where the
inner surface is a texture in someone else's UI.

**Surface rendering — the escape hatch, for still images.** Offscreen render →
read back pixels → hand them to the outer guest as a texture. This is the CPU
round-trip path, and its cost is the whole frame: 5.76 MB for a full 1600x900
window, 2.13 MB for the editor's 916x582 Edit-mode viewport
(`docs/spikes/records-budget.md`). Acceptable for a still image, a screenshot, or
a fallback where direct binding is unavailable. Not acceptable for live 3D at any
frame rate worth having.

**Record rendering — v1, 2D only.** The path Pass 4 uses: the inner guest emits
sprite records, the host copies them into the editor's own frame, the editor's
device draws them. It stays, and it stays an optimization for 2D rather than a
general answer. 2D can work around the absence of texture rendering — a sprite
stream *is* what a 2D scene is made of. 3D cannot.

## What exists

- `Render2dState::open_offscreen` (`tension-core/src/render2d/device.rs:424`)
  creates a real offscreen canvas: a device, a target, and a `screenshot` readback
  path. It is also, since Pass 2 slice 1, the place where a **capture** canvas is
  opened with no device at all (`:426-433`).
- `Render2dState` is now `Mode { Present, Capture }`, with a third variant
  (working name `Render`) explicitly reserved (`:157`, and the note on the enum
  itself). Slice 1's commit is where the reservation is reasoned about.
- The render target is created with `TextureUsage::COLOR_TARGET` only, RGBA8,
  `_2D`, one layer (`:1145-1151`, via `create_texture`).
- Pipeline atlases are **2D array** textures with `MAX_ATLAS_PAGES = 16` layers
  (`:50`, `create_array` at `:1248-1249`), sampled as `texture2DArray` with the
  record's `tex` field as the layer index. One array per pipeline, not one
  texture per draw.
- `copy_into_layer` (`:1338`) is a **GPU→GPU texture copy** into a named array
  layer — not an upload. It is what `set_texture` uses to place an IWI texture in
  a page.
- `texture_load` (`:945`) accepts IWI bytes only, and only RGBA8 targets
  (`:951-958`); the other three wire formats are refused with `-ENOTSUP`.

## What is missing

- **A texture handle the outer store can bind by page index.** Today a page is
  filled from a texture the *same* `Render2dState` loaded. There is no way to say
  "page 3 is the render target that state X drew into".
- **`texture_from_pixels(ptr, w, h, fmt)`** for the surface path: an RGBA8 upload
  that does not go through the IWI decoder. Everything above `upload_rgba`
  (`:1259-1300`) already exists, so this is a decode-free entry point, not a new
  pipeline.
- **A shared-GPU-texture path** for the no-copy case: the inner state renders
  into a layer the outer state can sample, with no transfer in between.

## Correction to earlier framing

Earlier discussions described this as needing "textures shared between stores".
That is the wrong level and it makes the problem look intractable.

**Stores do not touch GPU resources.** A store owns linear memory and calls host
shims; the GPU device, the window and the swapchain are host singletons
(`tension-core/src/host/mod.rs`, the singleton list, items 1-3). `Render2dState`
lives in `HostState` today only because there is exactly one guest per process —
it is the *host's* renderer that a guest addresses by handle, not a per-guest GPU
object graph. So "a texture shared between two stores" is not a thing that has to
exist: the second guest's `Render2dState` is a capture state with no device
(slice 1), and the pixels live on the one device the host owns. The question is
not about store isolation at all; it is about whether one `Render2dState` can
bind another's render target as a sampled page on that single device.

**The feasibility question, answered from the code — `NEEDS-SPIKE`, with the
reading that says why.** The mechanism is supported: SDL_GPU lets a 2D-array
texture carry `COLOR_TARGET | SAMPLER` at creation — `sdl3-sys` names
`SAMPLER | STORAGE_READ` as the one invalid combination and lists `R8G8B8A8_UNORM`
as universally sampleable (`sdl3-sys-0.7.3+SDL-3.4.20/src/generated/gpu.rs:1424`,
`:778`) — and a render pass names the layer it writes through
`SDL_GPUColorTargetInfo::layer_or_depth_plane` (`:5393`: *"treated as a layer
index on 2D array … textures"*), so an inner guest can render into layer N of the
*same* array the outer pipeline samples at page N — no copy. Two
things in this tree stand in the way today, and both are construction-time rather
than architectural: the target is created `COLOR_TARGET`-only and cannot be
sampled, and it is a `_2D` single-layer texture while the pipeline samples a
`_2DArray`. A third constraint is real and is not about flags: an array's size is
fixed by the first page bound to a pipeline and every later page must match
(`:1031-1037`), so binding a viewport-sized inner surface into a pipeline whose
atlas is a different size is refused, not resampled. The spike is
`sdl3-sys`-level and small: create one `_2DArray` with `COLOR_TARGET | SAMPLER`,
render into layer 1 through `layer_or_depth_plane`, sample it from a pipeline on
the same device, and confirm the image on this rig's driver (Mesa `dzn` here,
lavapipe in CI). Until that runs, `NEEDS-SPIKE` is the honest answer — the API
reading is strong, and reading is not running.

## Constraints to record

Each of these is a fact about the current code, not a decision.

- **The 16-page cap is shared between outer and nested guests.** Pages are layers
  of one array per pipeline, so each embedded guest surface bound as an outer
  texture consumes one of the outer guest's 16 pages. Embedding three live
  surfaces leaves thirteen for the outer guest. A future pass that wants more
  either raises `MAX_ATLAS_PAGES` (a shader/data-format change, since it is a
  layer count) or gives each nested surface its own pipeline, which costs a draw
  call per surface.
- **Format and usage flags must be decided at creation.** A texture that is both
  an attachment and a sampled source needs `COLOR_TARGET | SAMPLER` when it is
  created; SDL_GPU has no "add a usage later". That is a constraint on the
  eventual texture-path signature of `open_offscreen`, and it is why slice 1's
  `Mode` is the right place to put the branch rather than a caller-side flag.
- **Synchronization needs a texture pair, not one texture.** The outer guest
  samples frame N-1 while the inner guest renders frame N; a single texture is
  read and written in the same frame. Ping-pong is the shape. This is a design
  note for whoever builds it — it is not resolved here, and it is the reason the
  no-copy path is not simply "bind the target".
- **"A sprite cannot stretch."** The record has one `W`/`H` pair
  (`tension_2d.h:305-306`, `TENSION_2D_OFF_W`/`OFF_H`) used as both the source
  texel rect and the destination rect, so a record cannot scale a page. A
  surface-bound guest therefore has to render at the exact viewport size and
  re-render on resize; scaling it in the outer guest is not something the record
  format can express. Resize handling is part of the buffer path, not an edge
  case after it.
- **The subprocess escape hatch is not the answer for OGRE.** OGRE renders
  offscreen on the shared device the same way any texture-path guest does
  (`docs/known-limitations.md`, "No offscreen GPU render path", is about the
  null-render-system fallback, not about the device). The subprocess exists for
  debugging an unkillable guest, and stays confined to that.

## Related

- `docs/known-limitations.md` — the page-cap row, and the state of the OGRE
  offscreen path.
- `docs/spikes/records-budget.md` — the record-path measurement this is the
  alternative to.
- `docs/modules/2d.md` — the record format, the atlas, and the pipeline rules the
  constraints above come from.
