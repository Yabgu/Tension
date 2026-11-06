# hello-sprites — a TensionScript guest drawing through `tension::2d`

Ten sprites, rendered by the `tension-2d` capability from a Wasm guest written
in TensionScript. It is the same frame the adapter's own C++ stub renders
(`tension-2d/tests/smoke_core.cpp`), produced through the real guest path
instead of a stub: a session, the capability loaded from its DSO, and the nine
verbs called as wasm imports.

That equality is the point. The C++ stub proves the adapter works when driven
from C; this example proves a **guest** can drive it — the memory model, the
import registration, the `guest_read` window, and the graph blob's identity all
survive the crossing into TensionScript.

## Run it

```sh
npm start
```

That builds the adapter if it is missing, builds the guest, runs the adapter's
own suite, then runs the guest under `tension-core` with `libtension_2d.so`
loaded — and fails if the frame is not the expected one.

```
  === TensionCore 2D demo: ten sprites through tension::2d ===
  open -> handle 1
  info -> v1, max_records 4096, max_buckets 8
  set_pipeline -> pipe 100
  texture_load -> texture 1 (196682 bytes)
  submit -> 10 records
  screenshot -> 921600 bytes, 10240 non-black pixels
  expected 10240 (10 x 32x32)
  OK: ten sprites at their recorded positions
```

`10240` is `10 × 32 × 32`: ten 32-pixel quads, 64 pixels apart so none overlap.

## What the guest does

1. **Opens the session.** `RuntimeSession.open(ConfigBuilder.forThisBuild())`.
   Not optional: the verbs reach guest memory through the session, so without a
   READY session `open` still succeeds and the first verb that touches memory
   answers `-EBADF`.
2. **Builds an atlas** — a 256×256 IWI container, written byte by byte in
   `main.ts`. A guest has no file reader (`tension::io` is text only), so the
   texture is constructed in memory and handed over by pointer.
3. **Sets the pipeline** from the `default_2d` graph blob. The blob is
   generated into `src/graph.generated.ts` by the build, from the same
   `.t2dg` the adapter's hash table was compiled against. A different blob is
   `-ENOSYS`, because the DSO carries modules for one hash.
4. **Writes ten records** at the offsets `tension_2d.h` fixes, into one 28-byte
   record array, behind a 12-byte submit header.
5. **Submits, presents, screenshots**, then counts non-black pixels and checks
   each sprite's centre is its own cell's colour.

## Layout

```
package.json              build + start scripts
asconfig.json             the shared session config with initialMemory raised
src/main.ts               the guest
src/bindings.ts           the nine verbs, the record, the submit header
src/graph.generated.ts    the default_2d blob (generated; do not edit)
```

`src/bindings.ts` is **hand-written**. `tension-2d/include/tension_2d.h` has no
entry in `schema/`, so `tools/codegen/generate.mjs` cannot emit it — codegen
covers `ogre` only. When the schema tool grows a `2d` entry this file should
become generated output; until then every offset in it is transcribed from the
header by hand, and the header is the authority.

## Two things this example had to work around, and why

**Memory.** The shared `tension-framework/build/session.asconfig.json` declares
`initialMemory: 133` pages. That is enough for a guest that never holds a frame;
it is not enough for one that allocates 921 600 bytes for a 640×360 screenshot
plus a 196 682-byte atlas. `asconfig.json` here is that file with only
`initialMemory` raised to 200 — the arena geometry, and therefore the layout
hash, is untouched.

**The compiler.** TensionScript resolves to
`tension-framework/node_modules/.bin/tensionscript` (0.13.2). The globally
installed one on this machine was 0.11.0, which cannot compile this framework —
it fails inside `ogre.generated.ts`. `scripts/build-2d-guest.mjs` checks the
local pin first and names the compiler it used.

## The canvas is 640×360, not 320×240

The brief for this example asked for `open(320, 240, 0)`. `open` takes **only
`flags`** — the size is `kCanvasWidth`/`kCanvasHeight` in the adapter's
`render.h`, because v1 renders to one fixed offscreen target and has no
swapchain to resize. The guest therefore screenshots 640×360 (921 600 bytes)
and the sprites occupy the top-left corner. A caller-chosen size is the v1.1
window path, not a missing argument here.

## What is not exercised

- **Sorting across characters.** `group_id` and `z` are written as zero here;
  the composite ordering is proved in `smoke_core.cpp`, not from a guest.
- **Runtime pipeline compilation.** The guest sets the shipped `default_2d`
  blob, so it hits the adapter's build-time table. A guest-authored graph would
  go through the host's `compile_graph` slot and answer `pipe_id >= 1000`; the
  stub proves that path, this example does not.
- **Multi-atlas.** One texture is bound per frame, so one atlas is all a guest
  can use today.
