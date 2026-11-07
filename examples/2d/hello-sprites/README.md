# hello-sprites — a TensionScript guest drawing through `tension::2d`

Ten sprites, rendered by the `tension-2d` capability from a Wasm guest written
in TensionScript. It is the same frame the adapter's own C++ stub renders
(`tension-2d/tests/smoke_core.cpp`), produced through the real guest path
instead of a stub: a session, the capability loaded from its DSO, and the ten
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

It also **shows the frame**: the guest is asked for a window, and holds it open
until you close it. The window is a presentation path, not a second renderer —
the same target the assertion measured is blitted to a swapchain — so what you
see is what the test checked.

```sh
npm start -- --headless    # assert only, no window
TENSION_2D_HEADLESS=1 npm start
```

A machine with no `DISPLAY` or `WAYLAND_DISPLAY` is treated as headless rather
than failing, and every suite in `scripts/test.mjs` sets `TENSION_2D_HEADLESS=1`
so a test run never opens a window.

```
  === TensionCore 2D demo: ten sprites through tension::2d ===
  open -> handle 1
  info -> v2, max_records 4096, max_buckets 8, canvas 640x360
  set_pipeline -> pipe 100
  texture_load -> texture 1 (196682 bytes), bound to page 0
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
2. **Opens the canvas at 640×360.** `open(width, height, flags)` — the size is
   the guest's choice, and `info` echoes it back so the readback buffer is sized
   from what the adapter says rather than from the guest's memory of the call.
3. **Builds an atlas** — a 256×256 IWI container, written byte by byte in
   `main.ts`. A guest has no file reader (`tension::io` is text only), so the
   texture is constructed in memory and handed over by pointer.
4. **Sets the pipeline** from the `default_2d` graph blob. The blob is
   generated into `src/graph.generated.ts` by the build, from the same
   `.t2dg` the adapter's hash table was compiled against. A different blob is
   `-ENOSYS`, because the DSO carries modules for one hash.
5. **Binds the atlas to page 0** with `set_texture`. The records carry `tex = 0`;
   without this call a pipeline samples the last-loaded texture implicitly,
   which works but leaves the tenth verb unexercised.
6. **Writes ten records** at the offsets `tension_2d.h` fixes, into one 28-byte
   record array, behind a 12-byte submit header.
7. **Submits, presents, screenshots**, then counts non-black pixels and checks
   each sprite's centre is its own cell's colour.

## Layout

```
package.json              build + start scripts
asconfig.json             the shared session config with initialMemory raised
src/main.ts               the guest
src/bindings.ts           the ten verbs, the record, the submit header
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

## The canvas is the caller's choice

`open(width, height, flags)` fixes the offscreen target's size for the handle's
life; a resize is `close` + `open`, because v1 has no swapchain to renegotiate
with. This example asks for **640×360**, which is a decision in `main.ts`, not a
constant in the adapter — `tension-2d/tests/smoke_core.cpp` opens a second
handle at 320×180 in the same run and checks the projection follows.

`memory.data` needs a compile-time size, so the readback buffer is sized from the
example's own two constants (`FRAME_BYTES`), while the *check* that the adapter
agrees comes from `info`'s `canvas_width`/`canvas_height`.

## What is not exercised

- **Sorting across characters.** `group_id` and `z` are written as zero here;
  the composite ordering is proved in `smoke_core.cpp`, not from a guest.
- **Runtime pipeline compilation.** The guest sets the shipped `default_2d`
  blob, so it hits the adapter's build-time table. A guest-authored graph would
  go through the host's `compile_graph` slot and answer `pipe_id >= 1000`; the
  stub proves that path, this example does not.
- **Multi-atlas beyond page 0.** The guest binds one atlas to page 0 and every
  record names page 0. Two pages, and the size-mismatch refusal, are proved in
  `smoke_core.cpp` (`set_texture` on a second atlas), not from a guest.
