// examples/2d/hello-sprites/src/main.ts
//
// Ten sprites, drawn by tension-2d from a TensionScript guest.
//
// This is the same frame `tension-2d/tests/smoke_core.cpp` renders, produced
// through the real guest path instead of a C++ stub: a session, the
// `tension::2d` capability loaded from its DSO, and the verbs called through
// the framework's `Canvas`. The 10240-pixel total is the assertion both
// paths share, so a difference means the guest is not doing what the stub does.
//
// What the guest is responsible for, and what it is not:
//
//   atlas        built here, byte by byte, as an IWI container. The adapter
//                decodes it; nothing outside IWI is served at v1.
//   records      written here, at the offsets `tension_2d.h` fixes.
//   ordering     the adapter's. The guest sets `sort_key`; the comparator runs
//                on the host, driven by the graph's `make_tuple`.
//   pixels       read back here with `screenshot` and counted here.
//
// The canvas is 640x360 because this example asks for 640x360:
// `open(width, height, flags)` fixes the target's size for the handle's life.
// Nothing in the adapter bakes it in — the 320x180 case is exercised in
// tension-2d/tests/smoke_core.cpp.

import {
  arg,
  argCount,
  Bytes,
  Canvas,
  ConfigBuilder,
  Frame,
  PIPE_PRESET_MIN,
  Pixels,
  print,
  RecordBuffer,
  RuntimeSession,
} from "tension-framework";
import * as platform from "tension-framework/assembly/platform";
import { DEFAULT_2D_BLOB } from "./graph.generated";

/// Whether the guest was started with `flag`. `--windowed` is the one this
/// example reads; everything else is the harness's.
function hasArg(flag: string): bool {
  for (let i = 0; i < argCount(); i++) {
    if (arg(i) == flag) return true;
  }
  return false;
}

/// Whether the guest was asked to show a window.
///
/// This is purely the application's word now: the runtime has no window flag,
/// so `--window` is an ordinary argument like any other, and the guest is the
/// one that decides what it means. Two spellings for the same request, because
/// `--windowed` predates the merge and the suites still pass it.
function wantsWindow(): bool {
  return hasArg("--windowed") || hasArg("--window");
}

// --- the frame's numbers ---------------------------------------------------

/// The example's canvas. The adapter takes it from `open`, so this is a
/// decision here rather than a constant there.
const CANVAS_WIDTH: u32 = 640;
const CANVAS_HEIGHT: u32 = 360;
/// The bytes `screenshot` writes, from the same two constants the canvas was
/// opened with. `Pixels.create` sizes its own buffer from them, so this is the
/// number the *assertion* compares against rather than a size anyone allocates.
const FRAME_BYTES: u32 = CANVAS_WIDTH * CANVAS_HEIGHT * 4;

const SPRITES: i32 = 10;
/// The atlas is 4x4 cells of 64 px, and a 32 px sprite samples the top-left
/// quarter of one. Same as the C++ smoke test, which is what makes the pixel
/// count comparable.
const ATLAS_SIZE: u32 = 256;
const CELL: u32 = 64;
const SPRITE_SIZE: u16 = 32;
/// Sprites sit 64 px apart, so 32 px quads never touch: the non-black count is
/// exactly `SPRITES * SPRITE_SIZE^2` with no overlap to reason about.
const SPRITE_PITCH: i32 = 64;

/// How long a windowed run holds the frame: ~5 minutes at 60 fps. A bound
/// rather than "until closed" so a headless machine asked for `--windowed` by
/// mistake cannot hang a test job.
const WINDOW_FRAMES: i32 = 18000;

const EXPECTED_PIXELS: u32 = <u32>SPRITES * <u32>SPRITE_SIZE * <u32>SPRITE_SIZE;

/// The ten cell colours, RGB. Distinct on purpose: a solid atlas would let a
/// wrong source rectangle still produce the right pixel count.
const CELL_COLOURS: u8[][] = [
  [255, 0, 0],   [0, 255, 0],   [0, 0, 255],   [255, 255, 0], [0, 255, 255],
  [255, 0, 255], [128, 0, 0],   [0, 128, 0],   [0, 0, 128],   [128, 128, 0],
];

// --- the atlas -------------------------------------------------------------

/// Build the IWI container `IWImageIO.ixx` writes: magic, a 74-byte header, then
/// interleaved pixels.
///
/// Written here rather than shipped as a file because a guest has no file
/// reader (`tension::io` is text only), and because building it exercises the
/// path that matters: the guest writes bytes, the adapter reads them back
/// through `guest_read`.
function buildAtlas(): Bytes {
  const pixels = ATLAS_SIZE * ATLAS_SIZE * 3;
  const total = 74 + pixels;
  // A heap buffer with a runtime size, reachable only through `Bytes`. The old
  // spelling was `memory.data(total, 8)` returning a `usize` this function then
  // offset by hand, so "the atlas" was a number that meant the buffer only as
  // long as nobody wrote the wrong arithmetic beside it.
  const image = Bytes.allocate(total);
  image.fill(0);

  // The 74-byte IWI1 header, byte by byte — the one record in this tree that
  // cannot be a struct, and worth saying why so nobody tries.
  //
  // It is a *packed* C layout: `componentCount` is a `u16` at offset 13 and
  // `bitsPerPixel` a `u16` at 15, neither on a 2-byte boundary, and each of the
  // four component records at 18+ is `u8, u8, u16, u16` with the same problem.
  // TensionScript lays a record out at natural alignment and `@abi.align` can
  // only *raise* it — asking for less is refused:
  //
  //   TS6408: '@abi.align(1)' is less than the field type's natural alignment
  //           (2); asking for less is a lie, so it is refused
  //
  // So a struct here would silently move every field after `colorSpace` by a
  // byte, and the adapter's decoder would read a 1024-tall atlas as garbage.
  // The format is ImageViewer's, not ours; the stores stay.
  image.setByteAt(0, 0x49); // I
  image.setByteAt(1, 0x57); // W
  image.setByteAt(2, 0x49); // I
  image.setByteAt(3, 0x31); // 1
  image.setU32(4, ATLAS_SIZE); // width
  image.setU32(8, ATLAS_SIZE); // height
  image.setByteAt(12, 0); // colorSpace: sRGB
  image.setU16(13, 3); // componentCount
  image.setU16(15, 24); // bitsPerPixel
  image.setByteAt(17, 0); // storageLayout: interleaved

  // Eight 6-byte component descriptors; the first three are R, G, B (UNORM,
  // 8 bits each, at 0/8/16), the rest are the reserved slots and stay zero.
  for (let i = 0; i < 8; i++) {
    const at = 18 + i * 6;
    if (i < 3) {
      image.setByteAt(at + 0, <u8>(i + 1)); // semantic R=1, G=2, B=3
      image.setByteAt(at + 1, 2); // class UNORM
      image.setU16(at + 2, <u16>(i * 8)); // bitOffset
      image.setU16(at + 4, 8); // bitWidth
    }
  }
  image.setU64(66, <u64>pixels);

  // Paint the cells. Cell k covers (k%4, k/4) * 64, and cells 10..15 keep the
  // zero they were filled with -- black, which no sprite samples.
  const cellsPerRow: u32 = ATLAS_SIZE / CELL;
  for (let y: u32 = 0; y < ATLAS_SIZE; y++) {
    for (let x: u32 = 0; x < ATLAS_SIZE; x++) {
      const cell = (y / CELL) * cellsPerRow + (x / CELL);
      if (cell < <u32>CELL_COLOURS.length) {
        const c = CELL_COLOURS[cell];
        const o = 74 + <i32>((y * ATLAS_SIZE + x) * 3);
        image.setByteAt(o + 0, c[0]);
        image.setByteAt(o + 1, c[1]);
        image.setByteAt(o + 2, c[2]);
      }
    }
  }
  return image;
}

// --- the records -----------------------------------------------------------

/// The same ten records `smoke_core.cpp` submits: one per cell, 64 px apart,
/// 32 px square, `sort_key = i` so draw order is submission-independent.
///
/// The buffer owns its record count, so this fills it and there is no second
/// number travelling beside it: `submit` sends exactly what was pushed.
function writeSprites(records: RecordBuffer): void {
  for (let i = 0; i < SPRITES; i++) {
    const cell = <u32>i;
    const frame = new Frame(
      0, // tex: the one atlas
      <u16>((cell % 4) * CELL), // src_x
      <u16>((cell / 4) * CELL), // src_y
      SPRITE_SIZE,
      SPRITE_SIZE,
    );
    records.pushFrame(i * SPRITE_PITCH, 0, frame, <u32>i, 0, 0);
  }
}

// --- the run ---------------------------------------------------------------

function fail(what: string): void {
  print("hello-sprites: " + what);
}

export function _start_game(): void {
  print("=== TensionCore 2D demo: ten sprites through tension::2d ===");

  // 1. the session. Every verb that touches guest memory needs it READY;
  //    without this, `open` still succeeds and `info` answers -EBADF.
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    fail("the session did not open");
    return;
  }

  // 2. the window, if the user asked for one.
  // `--windowed` shows the frame; the default is offscreen, which is what the
  // test harness runs and what makes its pixel assertions reproducible.
  //
  // The window is created here, by the guest, because the runtime has no flag
  // for it. A refusal is not fatal: `wantsWindow()` is a request, and a
  // headless machine that was asked anyway still draws — offscreen — rather
  // than failing a test job.
  const window = wantsWindow();
  const canvas = window
    ? Canvas.windowedOrOffscreen(<i32>CANVAS_WIDTH, <i32>CANVAS_HEIGHT, "hello-sprites")
    : Canvas.open(<i32>CANVAS_WIDTH, <i32>CANVAS_HEIGHT);
  if (!canvas.isValid()) {
    fail("open -> " + canvas.lastError().toString());
    return;
  }
  if (window && !canvas.displaysToWindow()) {
    print("hello-sprites: no window; drawing offscreen");
  }
  print("open -> handle " + canvas.handle.toString());

  // Name the window before the first frame is presented. `setWindowTitle` is
  // the E1b mutator and the example's proof that the guest can own the window
  // after creating it: the call reaches SDL on this thread and returns once the
  // window system has taken the change, so the title is in place rather than
  // queued for some later frame. A refusal is reported and not fatal — a
  // headless driver has no title to set, and the pixels are the example's
  // assertion, not the caption.
  if (canvas.displaysToWindow()) {
    const renamed = platform.setWindowTitle("Hello Sprites");
    print("setWindowTitle -> " + renamed.toString());
  }

  // `readInfo` is the one Canvas method that cannot return an errno, because
  // the record is the return value. A refusal arrives as a zeroed record --
  // `version` is 2 in every real answer -- and `lastError()` carries the code.
  const info = canvas.readInfo();
  if (info.version == 0) {
    fail("info -> " + canvas.lastError().toString());
    canvas.close();
    return;
  }
  print(
    "info -> v" + info.version.toString() +
      ", max_records " + info.maxRecords.toString() +
      ", max_buckets " + info.maxBuckets.toString() +
      ", canvas " + info.canvasWidth.toString() + "x" +
      info.canvasHeight.toString(),
  );
  if (info.canvasWidth != CANVAS_WIDTH || info.canvasHeight != CANVAS_HEIGHT) {
    fail("info reports a different canvas than open was given");
    canvas.close();
    return;
  }

  // 3. the pipeline, from the graph blob the adapter was built against. A
  //    blob whose hash the DSO does not carry is -ENOSYS here, so this failure
  //    has exactly one cause: the .t2dg is not the one build-2d.mjs compiled.
  // `Bytes.ofArray` copies the generated literal once, here, instead of the
  // guest reserving a static block and `memory.copy`ing into it: same bytes, and
  // no address for anyone to hold on to.
  const blob = Bytes.ofArray(DEFAULT_2D_BLOB);
  const pipe = canvas.pipelineGraph(blob);
  if (pipe < PIPE_PRESET_MIN) {
    fail("set_pipeline -> " + pipe.toString() + " (blob " + blob.length.toString() + " bytes)");
    canvas.close();
    return;
  }
  print("set_pipeline -> pipe " + pipe.toString());

  // 4. the texture
  const atlas = buildAtlas();
  const atlasBytes = atlas.length;
  const tex = canvas.loadTexture(atlas);
  if (tex <= 0) {
    fail("texture_load -> " + tex.toString());
    canvas.close();
    return;
  }
  // 4b. bind the atlas to page 0. The records below carry `tex = 0`, and this
  //     is the call that makes that field mean something: without it a pipeline
  //     samples the last-loaded texture implicitly, which works but leaves the
  //     tenth verb unexercised.
  const bound = canvas.bindTexture(pipe, 0, tex);
  if (bound != 0) {
    fail("set_texture -> " + bound.toString());
    canvas.close();
    return;
  }
  print("texture_load -> texture " + tex.toString() + " (" + atlasBytes.toString() + " bytes)" +
    ", bound to page 0");

  // 5. the records
  //
  // `RecordBuffer` owns the memory and the count, and `Canvas.submit` writes the
  // 12-byte header from that count — the header is one value with one wire
  // layout, and a caller that could pass a stride could submit records the
  // adapter cannot decode.
  const records = RecordBuffer.create(SPRITES);
  writeSprites(records);
  const accepted = canvas.submit(pipe, records, 0);
  if (accepted != SPRITES) {
    fail("submit -> " + accepted.toString() + ", expected " + SPRITES.toString());
    canvas.close();
    return;
  }
  print("submit -> " + accepted.toString() + " records");

  // 6. draw
  if (canvas.present() != 0) {
    fail("present failed");
    canvas.close();
    return;
  }

  // 7. read the frame back and count what is not black
  //
  // `Pixels` is sized from the canvas that will fill it, and `screenshot`
  // refuses a destination that is too small rather than writing a short frame.
  const shot = Pixels.create(<i32>CANVAS_WIDTH, <i32>CANVAS_HEIGHT);
  const written = canvas.screenshot(shot);
  if (written != <i32>FRAME_BYTES) {
    fail("screenshot -> " + written.toString() + ", expected " + FRAME_BYTES.toString());
    canvas.close();
    return;
  }
  const nonBlack: u32 = <u32>shot.nonBlack();

  // 8. per-sprite checks: each centre must be its own cell's colour. The count
  //    alone would pass if every sprite sampled the same cell.
  let wrong = 0;
  for (let i = 0; i < SPRITES; i++) {
    const cx = <u32>(i * SPRITE_PITCH + <i32>SPRITE_SIZE / 2);
    const cy: u32 = <u32>SPRITE_SIZE / 2;
    const c = CELL_COLOURS[<i32>i];
    const r = shot.channelAt(<i32>cx, <i32>cy, 0);
    const g = shot.channelAt(<i32>cx, <i32>cy, 1);
    const b = shot.channelAt(<i32>cx, <i32>cy, 2);
    const close = (abs(<i32>r - <i32>c[0]) <= 3) && (abs(<i32>g - <i32>c[1]) <= 3) &&
      (abs(<i32>b - <i32>c[2]) <= 3);
    if (!close) {
      wrong++;
      print(
        "  sprite " + i.toString() + " at (" + cx.toString() + "," + cy.toString() +
          ") is (" + r.toString() + "," + g.toString() + "," + b.toString() +
          "), expected (" + c[0].toString() + "," + c[1].toString() + "," + c[2].toString() + ")",
      );
    }
  }

  print("screenshot -> " + written.toString() + " bytes, " + nonBlack.toString() + " non-black pixels");
  print("expected " + EXPECTED_PIXELS.toString() + " (" + SPRITES.toString() + " x 32x32)");

  const ok = nonBlack == EXPECTED_PIXELS && wrong == 0;
  print(ok ? "OK: ten sprites at their recorded positions" : "FAILED: see above");

  // Windowed: hold the frame up until the user closes the window.
  //
  // The guest has already asserted everything it can, so this loop is not a
  // test — it is the reason `npm start` shows something. An empty `present`
  // re-presents the frame already in the target rather than clearing it, so each
  // iteration is a repaint of the same image.
  //
  // **`closeRequested` is asked directly, and `present` is not trusted to say
  // it.** The renderer learns of a close from its own pump, but the host pumps
  // the same SDL queue in `RuntimeSession.wait`, so whichever pump drains the
  // quit event is the only one that sees it — normally the host's. Which one
  // wins is timing, and it differs by host build: on this rig's in-core debug
  // host `present` does answer `-ECANCELED` about 215 ms after the click, while
  // the same app under `tension dev` was measured needing the direct read (639
  // frames drawn with the check absent, exit 350-450 ms with it). A loop that
  // owns its lifetime should not depend on the race, so both are checked:
  // `closeRequested` for the request, `present` for a window that died under it.
  //
  // Capped at ~3000 iterations (a minute at vsync) so a headless machine asked
  // for `--windowed` by mistake cannot hang a CI job.
  if (wantsWindow() && ok) {
    print("windowed: close the window to exit");
    // `wait` inside the loop, not after it: a tight present-loop on a software
    // driver spins as fast as the CPU allows and finishes before anyone can
    // look at the window. One host-owned tick per repaint paces it.
    let keep: i32 = 0;
    while (keep < WINDOW_FRAMES) {
      if (platform.windowInfo().closeRequested) break; // the X button
      if (canvas.present() != 0) break; // -ECANCELED: the window is gone
      RuntimeSession.wait(16);
      keep++;
    }
  }

  canvas.close();
  RuntimeSession.close();
}
