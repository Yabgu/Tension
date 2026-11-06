// examples/2d/hello-sprites/src/main.ts
//
// Ten sprites, drawn by tension-2d from a TensionScript guest.
//
// This is the same frame `tension-2d/tests/smoke_core.cpp` renders, produced
// through the real guest path instead of a C++ stub: a session, the
// `tension::2d` capability loaded from its DSO, and the nine verbs called
// through the session's imports. The 10240-pixel total is the assertion both
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
  ConfigBuilder,
  Frame,
  print,
  readRgba,
  RECORD_SIZE,
  Rgba,
  SpriteRecord,
  SubmitHeader,
  RuntimeSession,
  writeRecord,
  writeSubmitHeader,
} from "tension-framework";
import * as gfx from "./bindings";
import { DEFAULT_2D_BLOB } from "./graph.generated";

// --- the frame's numbers ---------------------------------------------------

/// The example's canvas. The adapter takes it from `open`, so this is a
/// decision here rather than a constant there.
const CANVAS_WIDTH: u32 = 640;
const CANVAS_HEIGHT: u32 = 360;
/// `memory.data` takes a compile-time size, so the readback is sized from the
/// same two constants rather than from `gfx.frameBytes(...)`.
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

const EXPECTED_PIXELS: u32 = <u32>SPRITES * <u32>SPRITE_SIZE * <u32>SPRITE_SIZE;

/// The ten cell colours, RGB. Distinct on purpose: a solid atlas would let a
/// wrong source rectangle still produce the right pixel count.
const CELL_COLOURS: u8[][] = [
  [255, 0, 0],   [0, 255, 0],   [0, 0, 255],   [255, 255, 0], [0, 255, 255],
  [255, 0, 255], [128, 0, 0],   [0, 128, 0],   [0, 0, 128],   [128, 128, 0],
];

// --- the atlas -------------------------------------------------------------

/// Three packed channels: the atlas is IWI at 24 bpp, so a pixel there is three
/// bytes with no fourth. Named rather than three `store<u8>` at `+0/+1/+2`,
/// because a channel written to the wrong offset is a colour nobody can read.
struct Rgb24 {
  r: u8;
  g: u8;
  b: u8;
}

/// Build the IWI container `IWImageIO.ixx` writes: magic, a 74-byte header, then
/// interleaved pixels.
///
/// Written here rather than shipped as a file because a guest has no file
/// reader (`tension::io` is text only), and because building it exercises the
/// path that matters: the guest writes bytes, the adapter reads them back
/// through `guest_read`.
function buildAtlas(): usize {
  const pixels = ATLAS_SIZE * ATLAS_SIZE * 3;
  const total = 74 + pixels;
  const at: usize = memory.data(<usize>total, 8);

  memory.fill(at, 0, <usize>total);

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
  store<u8>(at + 0, 0x49); // I
  store<u8>(at + 1, 0x57); // W
  store<u8>(at + 2, 0x49); // I
  store<u8>(at + 3, 0x31); // 1
  store<u32>(at + 4, ATLAS_SIZE); // width
  store<u32>(at + 8, ATLAS_SIZE); // height
  store<u8>(at + 12, 0); // colorSpace: sRGB
  store<u16>(at + 13, 3); // componentCount
  store<u16>(at + 15, 24); // bitsPerPixel
  store<u8>(at + 17, 0); // storageLayout: interleaved

  // Eight 6-byte component descriptors; the first three are R, G, B (UNORM,
  // 8 bits each, at 0/8/16), the rest are the reserved slots and stay zero.
  for (let i = 0; i < 8; i++) {
    const at2 = at + 18 + <usize>(i * 6);
    if (i < 3) {
      store<u8>(at2 + 0, <u8>(i + 1)); // semantic R=1, G=2, B=3
      store<u8>(at2 + 1, 2); // class UNORM
      store<u16>(at2 + 2, <u16>(i * 8)); // bitOffset
      store<u16>(at2 + 4, 8); // bitWidth
    }
  }
  store<u64>(at + 66, <u64>pixels);

  // Paint the cells. Cell k covers (k%4, k/4) * 64, and cells 10..15 keep the
  // zero they were filled with -- black, which no sprite samples.
  const cellsPerRow: u32 = ATLAS_SIZE / CELL;
  for (let y: u32 = 0; y < ATLAS_SIZE; y++) {
    for (let x: u32 = 0; x < ATLAS_SIZE; x++) {
      const cell = (y / CELL) * cellsPerRow + (x / CELL);
      const o = at + 74 + <usize>((y * ATLAS_SIZE + x) * 3);
      if (cell < <u32>CELL_COLOURS.length) {
        const c = CELL_COLOURS[cell];
        const px = changetype<@unmanaged Rgb24>(o);
        px.r = c[0];
        px.g = c[1];
        px.b = c[2];
      }
    }
  }
  return at;
}

// --- the records -----------------------------------------------------------

/// The same ten records `smoke_core.cpp` submits: one per cell, 64 px apart,
/// 32 px square, `sort_key = i` so draw order is submission-independent.
function writeSprites(base: usize): void {
  for (let i = 0; i < SPRITES; i++) {
    const cell = <u32>i;
    const frame = new Frame(
      0, // tex: the one atlas
      <u16>((cell % 4) * CELL), // src_x
      <u16>((cell / 4) * CELL), // src_y
      SPRITE_SIZE,
      SPRITE_SIZE,
    );
    const at = base + <usize>(i * <i32>RECORD_SIZE);
    writeRecord(changetype<SpriteRecord>(at), i * SPRITE_PITCH, 0, frame, <u32>i, 0, 0);
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

  // 2. the capability
  const handle = gfx.open(CANVAS_WIDTH, CANVAS_HEIGHT, 0);
  if (handle <= 0) {
    fail("open -> " + handle.toString());
    return;
  }
  print("open -> handle " + handle.toString());

  const infoBuf: usize = memory.data(<usize>gfx.INFO_SIZE, 8);
  const infoLen = gfx.info(handle, infoBuf, <i32>gfx.INFO_SIZE);
  if (infoLen != <i32>gfx.INFO_SIZE) {
    fail("info -> " + infoLen.toString());
    gfx.close(handle);
    return;
  }
  print(
    "info -> v" + gfx.infoVersion(infoBuf).toString() +
      ", max_records " + gfx.infoMaxRecords(infoBuf).toString() +
      ", max_buckets " + gfx.infoMaxBuckets(infoBuf).toString() +
      ", canvas " + gfx.infoCanvasWidth(infoBuf).toString() + "x" +
      gfx.infoCanvasHeight(infoBuf).toString(),
  );
  if (gfx.infoCanvasWidth(infoBuf) != CANVAS_WIDTH ||
    gfx.infoCanvasHeight(infoBuf) != CANVAS_HEIGHT) {
    fail("info reports a different canvas than open was given");
    gfx.close(handle);
    return;
  }

  // 3. the pipeline, from the graph blob the adapter was built against. A
  //    blob whose hash the DSO does not carry is -ENOSYS here, so this failure
  //    has exactly one cause: the .t2dg is not the one build-2d.mjs compiled.
  const BLOB_SIZE: u32 = 584; // DEFAULT_2D_BLOB.length, fixed at generation
  const blobPtr: usize = memory.data(<usize>BLOB_SIZE, 8);
  memory.copy(blobPtr, changetype<usize>(DEFAULT_2D_BLOB.dataStart), BLOB_SIZE);
  const pipe = gfx.setPipeline(handle, blobPtr, BLOB_SIZE);
  if (pipe < gfx.PIPE_PRESET_MIN) {
    fail("set_pipeline -> " + pipe.toString() + " (blob " + BLOB_SIZE.toString() + " bytes)");
    gfx.close(handle);
    return;
  }
  print("set_pipeline -> pipe " + pipe.toString());

  // 4. the texture
  const atlas = buildAtlas();
  const atlasBytes = 74 + ATLAS_SIZE * ATLAS_SIZE * 3;
  const tex = gfx.textureLoad(handle, atlas, atlasBytes);
  if (tex <= 0) {
    fail("texture_load -> " + tex.toString());
    gfx.close(handle);
    return;
  }
  // 4b. bind the atlas to page 0. The records below carry `tex = 0`, and this
  //     is the call that makes that field mean something: without it a pipeline
  //     samples the last-loaded texture implicitly, which works but leaves the
  //     tenth verb unexercised.
  const bound = gfx.setTexture(handle, pipe, 0, tex);
  if (bound != 0) {
    fail("set_texture -> " + bound.toString());
    gfx.close(handle);
    return;
  }
  print("texture_load -> texture " + tex.toString() + " (" + atlasBytes.toString() + " bytes)" +
    ", bound to page 0");

  // 5. the records and the header
  const records: usize = memory.data(<usize>(SPRITES * <i32>RECORD_SIZE), 8);
  writeSprites(records);
  const header: usize = memory.data(<usize>12, 4);
  writeSubmitHeader(changetype<SubmitHeader>(header), records, <u32>SPRITES);

  const accepted = gfx.submit(handle, pipe, header, 0);
  if (accepted != SPRITES) {
    fail("submit -> " + accepted.toString() + ", expected " + SPRITES.toString());
    gfx.close(handle);
    return;
  }
  print("submit -> " + accepted.toString() + " records");

  // 6. draw
  if (gfx.present(handle) != 0) {
    fail("present failed");
    gfx.close(handle);
    return;
  }

  // 7. read the frame back and count what is not black
  const frame: usize = memory.data(<usize>FRAME_BYTES, 8);
  const written = gfx.screenshot(handle, frame, <i32>FRAME_BYTES);
  if (written != <i32>FRAME_BYTES) {
    fail("screenshot -> " + written.toString() + ", expected " + FRAME_BYTES.toString());
    gfx.close(handle);
    return;
  }

  // A view, not a value: this function holds two pixel loops, and two value
  // locals of one struct type in two loops crash the compiler (0.13.2 and
  // 0.14.1 both: `duplicate local name`, from `fillSroaFieldLocals`). A view is
  // a pointer local, so it is unaffected — and the fields are still named.
  let nonBlack: u32 = 0;
  for (let i: u32 = 0; i < CANVAS_WIDTH * CANVAS_HEIGHT; i++) {
    const px = changetype<@unmanaged Rgba>(frame + <usize>(i * 4));
    if (px.r != 0 || px.g != 0 || px.b != 0) nonBlack++;
  }

  // 8. per-sprite checks: each centre must be its own cell's colour. The count
  //    alone would pass if every sprite sampled the same cell.
  let wrong = 0;
  for (let i = 0; i < SPRITES; i++) {
    const cx = <u32>(i * SPRITE_PITCH + <i32>SPRITE_SIZE / 2);
    const cy: u32 = <u32>SPRITE_SIZE / 2;
    const px = changetype<@unmanaged Rgba>(frame + <usize>((cy * CANVAS_WIDTH + cx) * 4));
    const c = CELL_COLOURS[<i32>i];
    const r = px.r;
    const g = px.g;
    const b = px.b;
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

  gfx.close(handle);
  RuntimeSession.close();
}
