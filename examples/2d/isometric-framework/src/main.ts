// examples/2d/isometric-framework/src/main.ts — the same scene, built by the
// library instead of by hand.
//
// Compare with `examples/2d/isometric/src/main.ts`, which writes each of the 42
// records itself: the ground loop, the two tree slices with their sort keys, the
// three character layers with their z values, the lantern. Every one of those
// decisions is in that file as arithmetic.
//
// Here they are three calls:
//
//   Tileset         the sheet arrives as pages; ask it for a frame by pixel
//   IsometricWorld  add a tall sprite and it becomes slices with sort keys
//   Composite       add layers with per-facing z and it becomes records
//
// The frames the two guests print are byte-identical. `test.mjs` runs both and
// compares them, which is the claim that this library is a layer over the proven
// primitives rather than a second implementation of them.
//
// The one thing the library does not decide is *what* the scene is: the numbers
// come from `scene.generated.ts`, emitted by the synthetic fixture. A game would
// get them from its own data.

import { arg, argCount, Canvas, ConfigBuilder, OPEN_WINDOWED, print, RuntimeSession } from "tension-framework";
import * as platform from "tension-framework/assembly/platform";
import {
  Composite,
  IsometricWorld,
  RECORD_SIZE,
  Rgba,
  SpriteRecord,
  Tileset,
} from "tension-framework";
import * as scene from "./scene.generated";

const FRAME_BYTES: u32 = scene.CANVAS_WIDTH * scene.CANVAS_HEIGHT * 4;

/// `memory.data` allocates a *static* block, so its size must be a constant —
/// the world cannot size the buffer itself. 42 records is what this scene emits
/// (36 ground + 2 tree slices + 3 character layers + 1 lantern); 64 leaves room
/// for a scene that grows, and `emit` is checked against `recordCount` below.
const MAX_RECORDS: i32 = 64;
const RECORD_BYTES: u32 = <u32>MAX_RECORDS * RECORD_SIZE;

let failures: i32 = 0;

function hasArg(flag: string): bool {
  for (let i: i32 = 0; i < argCount(); i++) {
    if (arg(i) == flag) return true;
  }
  return false;
}

/// Whether the guest was asked to show a window.
///
/// Purely the application's word: the runtime has no window flag, so `--window`
/// is an ordinary argument and the guest decides what it means. Two spellings
/// for one request, because `--windowed` predates the merge and the suites still
/// pass it.
function wantsWindow(): bool {
  return hasArg("--windowed") || hasArg("--window");
}

/// Open a window for the 2D renderer to claim.
///
/// `target: Gpu` and not `Vulkan`: SDL_GPU claims the window and builds its own
/// surface, so the flag a `Vulkan` window sets is not needed — and on Windows it
/// would demand a Vulkan loader this renderer does not use.
function openWindow(width: i32, height: i32): platform.Window {
  const config = new platform.WindowConfig();
  config.target = platform.WindowTarget.Gpu;
  config.width = <u32>width;
  config.height = <u32>height;
  config.title = "isometric";
  return platform.createWindow(config);
}

function fail(what: string): void {
  print("  FAIL: " + what);
  failures++;
}

// --- frame emission (the guest has no file writer; see the isometric guest) --

function hex2(v: u8): string {
  return (v < 16 ? "0" : "") + v.toString(16);
}

function emitFrame(name: string, frame: @unmanaged [Rgba *], bytes: u32): void {
  // A row is 128 bytes = 32 pixels; the chunk boundary is a pixel boundary
  // because `bytes` is `width * height * 4` and 128 is a multiple of 4.
  const chunk: u32 = 128;
  print("FRAME-BEGIN " + name + " " + bytes.toString());
  for (let base: u32 = 0; base < bytes; base += chunk) {
    let line = "FRAME " + name + " " + base.toString() + " ";
    const end: u32 = min<u32>(base + chunk, bytes);
    for (let i: u32 = base; i < end; i += 4) {
      const px = i >> 2;
      line += hex2(frame[px].r) + hex2(frame[px].g) + hex2(frame[px].b) + hex2(frame[px].a);
    }
    print(line);
  }
  print("FRAME-END " + name);
}

/// A pixel's colour, by channel name rather than by byte offset into it.
function colourAt(frame: @unmanaged [Rgba *], x: i32, y: i32): u8[] {
  const i = y * <i32>scene.CANVAS_WIDTH + x;
  return [frame[i].r, frame[i].g, frame[i].b];
}

function same(a: u8[], b: u8[], tolerance: i32 = 2): bool {
  for (let i: i32 = 0; i < 3; i++) {
    if (abs(<i32>a[i] - <i32>b[i]) > tolerance) return false;
  }
  return true;
}

function describe(c: u8[]): string {
  return "(" + c[0].toString() + "," + c[1].toString() + "," + c[2].toString() + ")";
}

// --- the revert levers -----------------------------------------------------

/// A z table whose every column repeats column 0. Used to simulate "the facing
/// changed but the table did not": the composite is told it faces front while
/// its depths are still the back view's, which must render as the back view.
function flatten(table: u8[]): u8[] {
  const out = new Array<u8>(table.length);
  for (let i: i32 = 0; i < table.length; i++) out[i] = table[0];
  return out;
}

// --- the scene, built by the library ---------------------------------------

/// One pass's world. Rebuilt per facing because the character's z depends on it.
function buildWorld(
  tileset: Tileset,
  facingBack: bool,
  flatTables: bool,
  noSlice: bool,
  breakGroup: bool,
): IsometricWorld {
  const world = IsometricWorld.create();
  const tile: i32 = <i32>scene.TILE_SIZE;

  // Ground: 6x6 tiles, one record each, `sort_key` 0 — the floor never occludes
  // what stands on it. `addGround`, not `addStatic`: sorted by its bottom edge
  // the far row of the floor would draw over the character's feet.
  const ground = tileset.frameNamed("ground");
  for (let row: i32 = 0; row < scene.GROUND_ROWS; row++) {
    for (let col: i32 = 0; col < scene.GROUND_COLS; col++) {
      world.addGround(tileset, ground, scene.GROUND_ORIGIN_X + col * tile, scene.GROUND_ORIGIN_Y + row * tile);
    }
  }

  // The tree: one 32x64 frame from the sheet, sliced at 32 px into crown and
  // trunk. Two records, two sort keys, no arithmetic here.
  const tree = tileset.frameNamed("tree");
  world.addStatic(tileset, tree, scene.TREE_X, scene.TREE_Y, noSlice ? 0 : scene.TREE_SLICE_H);

  // The lantern: 16 px tall, so slicing at 16 is one record sorted by its base.
  const lantern = tileset.frameNamed("lantern");
  world.addStatic(tileset, lantern, scene.LANTERN_X, scene.LANTERN_Y, 16);

  // The character: three layers, one group, one sort key, z per facing.
  const facing: u8 = <u8>(facingBack ? 0 : 1);
  const zBody = flatTables ? flatten(scene.Z_BODY) : scene.Z_BODY;
  const zHair = flatTables ? flatten(scene.Z_HAIR) : scene.Z_HAIR;
  const zBackpack = flatTables ? flatten(scene.Z_BACKPACK) : scene.Z_BACKPACK;

  if (breakGroup) {
    // The revert lever: the pack in a group of its own, sorted before the rest
    // of the character, so the body covers it. Two composites at one position is
    // exactly what a bug in group assignment looks like.
    const bodyAndHair = Composite.create(scene.CHAR_GROUP, scene.CHAR_SORT);
    bodyAndHair.addLayer(tileset, "body", zBody);
    bodyAndHair.addLayer(tileset, "hair", zHair);
    bodyAndHair.setFacing(facing);

    const pack = Composite.create(<u16>(scene.CHAR_GROUP - 1), scene.CHAR_SORT);
    pack.addLayer(tileset, "backpack", zBackpack);
    pack.setFacing(facing);

    world.addActor(bodyAndHair, scene.CHAR_X, scene.CHAR_Y);
    world.addActor(pack, scene.CHAR_X, scene.CHAR_Y);
  } else {
    const character = Composite.create(scene.CHAR_GROUP, scene.CHAR_SORT);
    if (!character.addLayer(tileset, "body", zBody)) fail("no frame named body");
    if (!character.addLayer(tileset, "hair", zHair)) fail("no frame named hair");
    if (!character.addLayer(tileset, "backpack", zBackpack)) fail("no frame named backpack");
    character.setFacing(facing);
    world.addActor(character, scene.CHAR_X, scene.CHAR_Y);
  }

  return world;
}

// --- the run ---------------------------------------------------------------

export function _start_game(): void {
  const flatTables: bool = hasArg("--facing-mislabelled");
  const noSlice: bool = hasArg("--no-slice");
  const breakGroup: bool = hasArg("--break-group");

  print("=== TensionCore 2D: isometric scene, built by the framework ===");

  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }

  // `--windowed` shows the frame; the default is offscreen, which is what the
  // test harness runs and what makes its pixel assertions reproducible.
  // The window is the guest's to create now: the runtime has no flag for it.
  // A refusal is not fatal — an offscreen draw still produces the same frame,
  // and a test job must not fail because a machine has no display.
  const window = wantsWindow() ? openWindow(<i32>scene.CANVAS_WIDTH, <i32>scene.CANVAS_HEIGHT) : new platform.Window(0, 0);
  const shown = window.isValid();
  if (wantsWindow() && !shown) {
    print("  no window (" + window.error.toString() + "); drawing offscreen");
  }
  const flags: i32 = shown ? OPEN_WINDOWED : 0;
  const canvas = Canvas.open(<i32>scene.CANVAS_WIDTH, <i32>scene.CANVAS_HEIGHT, flags);
  if (!canvas.isValid()) {
    print("FAIL: open -> " + canvas.lastError().toString());
    RuntimeSession.close();
    return;
  }

  const pipe = canvas.pipeline(1);
  if (pipe < 1) {
    print("FAIL: set_pipeline(preset 1) -> " + pipe.toString());
    canvas.close();
    RuntimeSession.close();
    return;
  }
  print("set_pipeline -> pipe " + pipe.toString());

  // The pages, in slot order: `Tileset.load` assumes page i is slot i, which is
  // what makes a frame's `tex` the slot the shader indexes.
  const textures: i32[] = [];
  // `Canvas.loadTextureFromRes` is the res-open / readAll / texture_load /
  // close loop this example used to write by hand, in one call: -ENOENT when
  // the path does not resolve, otherwise whatever `texture_load` refused with.
  for (let i: i32 = 0; i < scene.PAGE_FILES.length; i++) {
    const tex = canvas.loadTextureFromRes(scene.PAGE_FILES[i]);
    if (tex <= 0) {
      print("FAIL: texture_load(" + scene.PAGE_FILES[i] + ") -> " + tex.toString());
      failures++;
      continue;
    }
    textures.push(tex);
  }

  const tileset = Tileset.load(textures, scene.PAGE_SIZE, scene.PAGE_SIZE, scene.TILE_SIZE);
  if (!tileset.isValid()) {
    print("FAIL: Tileset.load refused " + textures.length.toString() + " pages");
    canvas.close();
    RuntimeSession.close();
    return;
  }
  const bound = tileset.bind(canvas.handle, pipe);
  if (bound != 0) {
    print("FAIL: tileset.bind -> " + bound.toString());
    failures++;
  }
  print("pages bound: " + textures.length.toString() + ", tile " + scene.TILE_SIZE.toString() + "px");

  // Sheet coordinates -> frames. Pages are one row of the sheet, so the lantern
  // on page 1 is simply the pixel at 1024 + its local x; nothing here says
  // "page 1".
  tileset.define("ground", tileset.frameForPixel(scene.SHEET_GROUND_X, scene.SHEET_GROUND_Y));
  tileset.define("tree", tileset.frameForPixel(scene.SHEET_CROWN_X, scene.SHEET_CROWN_Y, scene.TREE_SLICE_W, <u32>scene.TREE_HEIGHT));
  tileset.define("lantern", tileset.frameForPixel(scene.SHEET_LANTERN_X, scene.SHEET_LANTERN_Y));
  tileset.define("body", tileset.frameForPixel(scene.SHEET_BODY_X, scene.SHEET_CHAR_Y, <u32>scene.CHAR_W, <u32>scene.CHAR_H));
  tileset.define("hair", tileset.frameForPixel(scene.SHEET_HAIR_X, scene.SHEET_CHAR_Y, <u32>scene.CHAR_W, <u32>scene.CHAR_H));
  tileset.define("backpack", tileset.frameForPixel(scene.SHEET_BACKPACK_X, scene.SHEET_CHAR_Y, <u32>scene.CHAR_W, <u32>scene.CHAR_H));

  const frameBuf: usize = memory.data(<usize>FRAME_BYTES, 8);
  // The same block, named twice: bytes for the verb, pixels for the probes.
  // `let`, not `const` — a const view in a scope that also has an integer const
  // crashes the compiler (types.ts has the repro).
  let frame = changetype<@unmanaged [Rgba *]>(frameBuf);

  print(
    "sort keys: crown " + scene.TREE_CROWN_SORT.toString() +
      ", character " + scene.CHAR_SORT.toString() +
      ", lantern " + scene.LANTERN_SORT.toString() +
      ", trunk " + scene.TREE_TRUNK_SORT.toString(),
  );

  for (let pass: i32 = 0; pass < 2; pass++) {
    const facingBack: bool = pass == 0;
    const name: string = facingBack ? "back" : "front";

    const world = buildWorld(tileset, facingBack, flatTables, noSlice, breakGroup);
    const count = world.recordCount();
    if (count > <u32>MAX_RECORDS) {
      print("FAIL: " + count.toString() + " records exceeds the " + MAX_RECORDS.toString() + " the buffer holds");
      failures++;
      break;
    }
    const records: usize = memory.data(<usize>RECORD_BYTES, 8);

    // The buffer as `[SpriteRecord *]`: a pointer to a run of records, which is
    // what the frame is. Nothing here multiplies by a stride.
    //
    // `let`, not `const`, and that is a compiler constraint rather than a
    // preference: a `const` whose type is a pointer view, in a scope that also
    // declares an integer `const`, crashes `tensionscript` (0.13.2 and 0.14.1:
    // `AssertionError` in `setConstantIntegerValue`). A view is a `let` away
    // from working, and nothing here reassigns it.
    let out = changetype<@unmanaged [SpriteRecord *]>(records);
    const written = world.emit(out);
    if (written != count) {
      print("FAIL: emit(" + name + ") wrote " + written.toString() + ", counted " + count.toString());
      failures++;
      break;
    }
    // `Canvas.submit` writes the header from the same view the records went
    // into: the record contract is one thing, and splitting its two halves
    // across two modules is how they drift.
    const accepted = canvas.submit(pipe, out, written, 0);
    if (accepted != <i32>written) {
      print("FAIL: submit(" + name + ") -> " + accepted.toString() + ", expected " + written.toString());
      failures++;
      break;
    }
    if (canvas.present() != 0) {
      print("FAIL: present(" + name + ") failed");
      failures++;
      break;
    }
    const got = canvas.screenshot(frame, FRAME_BYTES);
    if (got != <i32>FRAME_BYTES) {
      print("FAIL: screenshot(" + name + ") -> " + got.toString());
      failures++;
      break;
    }

    const pack = colourAt(frame, scene.PROBE_COMPOSITE_X, scene.PROBE_COMPOSITE_Y);
    const hair = colourAt(frame, scene.PROBE_HAIR_X, scene.PROBE_HAIR_Y);
    const crown = colourAt(frame, scene.PROBE_CROWN_X, scene.PROBE_CROWN_Y);
    const lantern = colourAt(frame, scene.PROBE_LANTERN_X, scene.PROBE_LANTERN_Y);
    const wantPack = facingBack ? scene.COMPOSITE_BACK : scene.COMPOSITE_FRONT;
    const wantHair = facingBack ? scene.HAIR_BACK : scene.HAIR_FRONT;

    print(
      "  " + name + ": pack " + describe(pack) + " (want " + describe(wantPack) + "), " +
        "hair " + describe(hair) + " (want " + describe(wantHair) + "), " +
        "crown " + describe(crown) + ", lantern " + describe(lantern),
    );
    if (!same(pack, wantPack)) fail(name + ": the composite probe is wrong");
    if (!same(hair, wantHair)) fail(name + ": the hair probe is wrong");

    emitFrame(name, frame, FRAME_BYTES);
  }

  // Windowed: hold the last frame until the window is closed. See
  // `examples/2d/isometric/src/main.ts` for the reasoning — same loop, same
  // `-ECANCELED` signal, same iteration cap so a headless run cannot hang.
  if (wantsWindow() && failures == 0) {
    print("windowed: close the window to exit");
    let keep: i32 = 0;
    while (keep < 18000) {
      if (canvas.present() != 0) break; // -ECANCELED: the window is gone
      RuntimeSession.wait(16);
      keep++;
    }
  }

  canvas.close();
  RuntimeSession.close();
  print(failures == 0 ? "OK: built by Tileset + Composite + IsometricWorld" : "FAILED");
}
