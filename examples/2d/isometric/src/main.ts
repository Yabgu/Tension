// examples/2d/isometric/src/main.ts — the worked isometric scene.
//
// Three of the original 2D problems, one frame, real assets:
//
//   oversized tileset   the source sheet is 2816x5072 = 15 pages of 1024x1024.
//                       Two of them are bound to one pipeline here, and the
//                       tree and the lantern sample different pages in the
//                       same instanced draw.
//   isometric depth     every record carries sort_key = world y. The tree is
//                       split into a crown and a trunk with different sort
//                       keys, so the character stands *between* them — behind
//                       the crown, in front of the trunk. The lantern's base is
//                       lower on screen than the character's feet, so it draws
//                       in front even though its pixels reach up over the legs.
//   modular characters  three records at one world position, one group (200),
//                       ordered by z: body, hair, backpack. Reverse the z
//                       assignment and the character faces the other way.
//
// The scene numbers come from `scene.generated.ts`, which `build.mjs` writes
// from the art. Nothing here hard-codes a tile coordinate.
//
// The assertions live in `test.mjs`, which reads the frame this guest prints.
// The guest's own job is to make the frame and say enough for a reader to
// believe it: the draw count, the sort keys, and a sampled pixel per claim.

import {
  arg,
  argCount,
  ConfigBuilder,
  pixelAt,
  print,
  Rgba,
  readRgba,
  ResFile,
  RuntimeSession,
  SpriteRecord,
} from "tension-framework";
import * as gfx from "./bindings";
import * as scene from "./scene.generated";

const FRAME_BYTES: u32 = scene.CANVAS_WIDTH * scene.CANVAS_HEIGHT * 4;

/// One frame's records: 6x6 ground tiles, 2 tree slices, 3 character layers,
/// 1 lantern. Enough that the sort order changes what is visible.
const MAX_RECORDS: i32 = 36 + 2 + 3 + 1;

let failures: i32 = 0;

/// Whether the guest was started with `flag`. Used by the revert test, which
/// asks for a deliberately wrong sort key — the point being that the assertion
/// downstream must then fail.
function hasArg(flag: string): bool {
  for (let i = 0; i < argCount(); i++) {
    if (arg(i) == flag) return true;
  }
  return false;
}

function fail(what: string): void {
  print("  FAIL: " + what);
  failures++;
}

// --- hex emission ----------------------------------------------------------
//
// The guest has no file writer and the runner has no view into guest memory, so
// the frame leaves through stdout as hex, four bytes at a time. 320x180x4 is
// 230 400 bytes = 460 800 characters, which is why it is chunked: one line per
// 128 bytes, reassembled by the runner by offset.

function hex2(v: u8): string {
  return (v < 16 ? "0" : "") + v.toString(16);
}

function emitFrame(name: string, frame: Rgba, bytes: u32): void {
  // A row is 128 bytes = 32 pixels; the chunk boundary is a pixel boundary
  // because `bytes` is `width * height * 4` and 128 is a multiple of 4.
  const chunk: u32 = 128;
  print("FRAME-BEGIN " + name + " " + bytes.toString());
  for (let base: u32 = 0; base < bytes; base += chunk) {
    let line = "FRAME " + name + " " + base.toString() + " ";
    const end: u32 = min<u32>(base + chunk, bytes);
    for (let i: u32 = base; i < end; i += 4) {
      const px = readRgba(changetype<Rgba>(changetype<usize>(frame) + <usize>i));
      line += hex2(px.r) + hex2(px.g) + hex2(px.b) + hex2(px.a);
    }
    print(line);
  }
  print("FRAME-END " + name);
}

function colourAt(frame: Rgba, x: i32, y: i32): u8[] {
  const px = pixelAt(frame, x, y, <i32>scene.CANVAS_WIDTH);
  return [px.r, px.g, px.b];
}

function same(a: u8[], b: u8[], tolerance: i32 = 2): bool {
  for (let i = 0; i < 3; i++) {
    if (abs(<i32>a[i] - <i32>b[i]) > tolerance) return false;
  }
  return true;
}

function describe(c: u8[]): string {
  return "(" + c[0].toString() + "," + c[1].toString() + "," + c[2].toString() + ")";
}

// --- the record writer -----------------------------------------------------

/// Fill `base` with the whole scene for one facing.
///
/// `facingBack` picks the composite order and nothing else: the art, the
/// positions and the sort keys are identical in both renders, so a difference
/// between the two frames is the z assignment and only that.
function writeScene(base: SpriteRecord, facingBack: bool, lanternSort: u32, invert: bool): i32 {
  // The record writer below is this example's own (it is the control the
  // framework is measured against), so it takes an address. The scene names the
  // base by type; the offset arithmetic stays in the writer that owns it.
  const at = changetype<usize>(base);
  let n: i32 = 0;

  // Ground: 6x6 tiles, all sort 0 so they are behind everything. Their own
  // order does not matter — they do not overlap each other.
  for (let row: i32 = 0; row < scene.GROUND_ROWS; row++) {
    for (let col: i32 = 0; col < scene.GROUND_COLS; col++) {
      gfx.writeSprite(
        at, n++,
        scene.GROUND_ORIGIN_X + col * 16, scene.GROUND_ORIGIN_Y + row * 16,
        <u16>scene.GROUND_SRC_X, <u16>scene.GROUND_SRC_Y,
        16, 16,
        <u16>scene.GROUND_SLOT,
        0,
      );
    }
  }

  // The tree, in two slices. `world_y` for a slice is the tree's base minus the
  // height it sits above the base — so the crown's key is the smallest and it
  // draws first, and the trunk's is the base and it draws last of the two.
  gfx.writeSprite(
    at, n++,
    scene.TREE_X, scene.TREE_Y,
    <u16>scene.TREE_CROWN_SRC_X, <u16>scene.TREE_CROWN_SRC_Y,
    <u16>scene.TREE_SLICE_W, <u16>scene.TREE_SLICE_H,
    <u16>scene.SLOT_TILESET_A,
    scene.TREE_CROWN_SORT,
  );
  gfx.writeSprite(
    at, n++,
    scene.TREE_X, scene.TREE_Y + scene.TREE_SLICE_H,
    <u16>scene.TREE_CROWN_SRC_X, <u16>scene.TREE_TRUNK_SRC_Y,
    <u16>scene.TREE_SLICE_W, <u16>scene.TREE_SLICE_H,
    <u16>scene.SLOT_TILESET_A,
    scene.TREE_TRUNK_SORT,
  );

  // The character: three layers, one position, one group, ordered by z.
  //
  //   facing back   body 0, hair 1, backpack 2   (the pack is on the back)
  //   facing front  body 2, hair 1, backpack 0   (the pack is behind you)
  // Facing front puts the body on top, facing back puts the backpack on top.
  // `invert` is the revert test's lever: same records, same order, wrong z, so
  // the composite assertion has something wrong to catch.
  const wantBodyOnTop: bool = invert ? facingBack : !facingBack;
  const bodyZ: u8 = wantBodyOnTop ? 2 : 0;
  const packZ: u8 = wantBodyOnTop ? 0 : 2;
  gfx.writeSprite(
    at, n++, scene.CHAR_X, scene.CHAR_Y,
    <u16>scene.CHAR_BODY_SRC_X, <u16>scene.CHAR_SRC_Y,
    <u16>scene.CHAR_W, <u16>scene.CHAR_H,
    <u16>scene.CHAR_SLOT,
    scene.CHAR_SORT, scene.CHAR_GROUP, bodyZ,
  );
  gfx.writeSprite(
    at, n++, scene.CHAR_X, scene.CHAR_Y,
    <u16>scene.CHAR_HAIR_SRC_X, <u16>scene.CHAR_SRC_Y,
    <u16>scene.CHAR_W, <u16>scene.CHAR_H,
    <u16>scene.CHAR_SLOT,
    scene.CHAR_SORT, scene.CHAR_GROUP, 1,
  );
  gfx.writeSprite(
    at, n++, scene.CHAR_X, scene.CHAR_Y,
    <u16>scene.CHAR_BACKPACK_SRC_X, <u16>scene.CHAR_SRC_Y,
    <u16>scene.CHAR_W, <u16>scene.CHAR_H,
    <u16>scene.CHAR_SLOT,
    scene.CHAR_SORT, scene.CHAR_GROUP, packZ,
  );

  // The lantern: its base is below the character's feet, so its sort key is
  // higher and it draws over the legs. Its right edge stops one pixel short of
  // the composite probe, which is why `build.mjs` offsets it by half a sprite.
  gfx.writeSprite(
    at, n++,
    scene.LANTERN_X, scene.LANTERN_Y,
    <u16>scene.LANTERN_SRC_X, <u16>scene.LANTERN_SRC_Y,
    16, 16,
    <u16>scene.LANTERN_SLOT,
    lanternSort,
  );

  return n;
}

// --- the run ---------------------------------------------------------------

export function _start_game(): void {
  const behind: bool = hasArg("--lantern-behind");
  const invertComposite: bool = hasArg("--swap-composite");
  print("=== TensionCore 2D: isometric scene ===");
  print(
    "canvas " + scene.CANVAS_WIDTH.toString() + "x" + scene.CANVAS_HEIGHT.toString() +
      ", " + MAX_RECORDS.toString() + " records, 3 atlas pages",
  );

  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }

  const handle = gfx.open(<i32>scene.CANVAS_WIDTH, <i32>scene.CANVAS_HEIGHT, 0);
  if (handle <= 0) {
    print("FAIL: open -> " + handle.toString());
    RuntimeSession.close();
    return;
  }

  // The built-in preset, not a graph blob: the scene's shape is the `sprite`
  // pipeline the adapter already carries, and this example's subject is the
  // pages and the sort, not the compiler.
  const pipe = gfx.setPipelinePreset(handle, 1);
  if (pipe < 1) {
    print("FAIL: set_pipeline(preset 1) -> " + pipe.toString());
    gfx.close(handle);
    RuntimeSession.close();
    return;
  }
  print("set_pipeline -> pipe " + pipe.toString());

  // Bind one page per slot. Each IWI is read out of the resource pak, handed to
  // the adapter, and released: the page lives on the GPU, not in the guest.
  for (let i = 0; i < scene.PAGE_FILES.length; i++) {
    const file = ResFile.open(scene.PAGE_FILES[i]);
    if (file === null) {
      print("FAIL: no resource " + scene.PAGE_FILES[i]);
      failures++;
      continue;
    }
    const bytes = file.readAll();
    const tex = gfx.textureLoad(handle, bytes.dataStart, <u32>bytes.length);
    file.close();
    if (tex <= 0) {
      print("FAIL: texture_load(" + scene.PAGE_FILES[i] + ") -> " + tex.toString());
      failures++;
      continue;
    }
    const bound = gfx.setTexture(handle, pipe, scene.PAGE_SLOTS[i], tex);
    if (bound != 0) {
      print("FAIL: set_texture(slot " + scene.PAGE_SLOTS[i].toString() + ") -> " + bound.toString());
      failures++;
      continue;
    }
    print(
      "page " + scene.PAGE_SLOTS[i].toString() + " <- " + scene.PAGE_FILES[i] +
        " (" + bytes.length.toString() + " bytes), texture " + tex.toString(),
    );
  }

  const records: usize = memory.data(<usize>(MAX_RECORDS * <i32>gfx.RECORD_SIZE), 8);
  const header: usize = memory.data(<usize>gfx.HDR_SIZE, 4);
  const frameBuf: usize = memory.data(<usize>FRAME_BYTES, 8);
  // The same block, named twice: bytes for the verb, pixels for the probes.
  const frame = changetype<Rgba>(frameBuf);

  const lanternSort: u32 = behind ? scene.LANTERN_SORT_WRONG : scene.LANTERN_SORT;
  print(
    "sort keys: crown " + scene.TREE_CROWN_SORT.toString() +
      ", character " + scene.CHAR_SORT.toString() +
      ", lantern " + lanternSort.toString() +
      ", trunk " + scene.TREE_TRUNK_SORT.toString(),
  );

  for (let pass: i32 = 0; pass < 2; pass++) {
    const facingBack: bool = pass == 0;
    const name: string = facingBack ? "back" : "front";

    const count = writeScene(changetype<SpriteRecord>(records), facingBack, lanternSort, invertComposite);
    gfx.writeSubmitHeader(header, records, <u32>count);
    const accepted = gfx.submit(handle, pipe, header, 0);
    if (accepted != count) {
      print("FAIL: submit(" + name + ") -> " + accepted.toString() + ", expected " + count.toString());
      failures++;
      break;
    }
    if (gfx.present(handle) != 0) {
      print("FAIL: present(" + name + ") failed");
      failures++;
      break;
    }
    const written = gfx.screenshot(handle, frameBuf, <i32>FRAME_BYTES);
    if (written != <i32>FRAME_BYTES) {
      print("FAIL: screenshot(" + name + ") -> " + written.toString());
      failures++;
      break;
    }

    // The guest's own reading of its frame. The runner re-checks the same
    // pixels from the bytes, but a guest that says "wrong here" is easier to
    // debug than a runner that says "wrong at offset 41040".
    const composite = colourAt(frame, scene.PROBE_COMPOSITE_X, scene.PROBE_COMPOSITE_Y);
    const crown = colourAt(frame, scene.PROBE_CROWN_X, scene.PROBE_CROWN_Y);
    const lantern = colourAt(frame, scene.PROBE_LANTERN_X, scene.PROBE_LANTERN_Y);
    const wantComposite = facingBack ? scene.COMPOSITE_BACK : scene.COMPOSITE_FRONT;
    const wantCrown = facingBack ? scene.CROWN_BACK : scene.CROWN_FRONT;

    print(
      "  " + name + ": composite " + describe(composite) + " (want " + describe(wantComposite) + "), " +
        "crown " + describe(crown) + " (want " + describe(wantCrown) + "), " +
        "lantern " + describe(lantern) + " (want " + describe(scene.LANTERN_COLOUR) + ")",
    );
    if (!same(composite, wantComposite)) fail(name + ": the composite probe is wrong");
    if (!same(crown, wantCrown)) fail(name + ": the character is not in front of the tree crown");
    if (!same(lantern, scene.LANTERN_COLOUR)) fail(name + ": the lantern is not in front");

    emitFrame(name, frame, FRAME_BYTES);
  }

  gfx.close(handle);
  RuntimeSession.close();
  print(failures == 0 ? "OK: three pages, two slices, one composite" : "FAILED");
}
