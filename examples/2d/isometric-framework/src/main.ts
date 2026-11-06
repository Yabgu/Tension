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

import { arg, argCount, ConfigBuilder, print, ResFile, RuntimeSession } from "tension-framework";
import {
  Composite,
  HEADER_SIZE,
  IsometricWorld,
  RECORD_SIZE,
  Tileset,
  layoutSelfTest,
  writeSubmitHeader,
} from "tension-2d-framework";
import * as gfx from "./bindings";
import * as scene from "./scene.generated";

const FRAME_BYTES: u32 = scene.CANVAS_WIDTH * scene.CANVAS_HEIGHT * 4;

/// `memory.data` allocates a *static* block, so its size must be a constant —
/// the world cannot size the buffer itself. 42 records is what this scene emits
/// (36 ground + 2 tree slices + 3 character layers + 1 lantern); 64 leaves room
/// for a scene that grows, and `emit` is checked against `recordCount` below.
const MAX_RECORDS: i32 = 64;
const RECORD_BYTES: u32 = <u32>MAX_RECORDS * RECORD_SIZE;

/// Where `layoutSelfTest` writes its probe: one record plus one header, 8-aligned.
const LAYOUT_SCRATCH: usize = memory.data(<usize>40, 8);

let failures: i32 = 0;

function hasArg(flag: string): bool {
  for (let i: i32 = 0; i < argCount(); i++) {
    if (arg(i) == flag) return true;
  }
  return false;
}

function fail(what: string): void {
  print("  FAIL: " + what);
  failures++;
}

// --- frame emission (the guest has no file writer; see the isometric guest) --

function emitFrame(name: string, frame: usize, bytes: u32): void {
  const chunk: u32 = 128;
  print("FRAME-BEGIN " + name + " " + bytes.toString());
  for (let base: u32 = 0; base < bytes; base += chunk) {
    let line = "FRAME " + name + " " + base.toString() + " ";
    const end: u32 = min<u32>(base + chunk, bytes);
    for (let i: u32 = base; i < end; i++) {
      const v = load<u8>(frame + <usize>i);
      line += v < 16 ? "0" : "";
      line += v.toString(16);
    }
    print(line);
  }
  print("FRAME-END " + name);
}

function colourAt(frame: usize, x: i32, y: i32): u8[] {
  const at = frame + <usize>((y * <i32>scene.CANVAS_WIDTH + x) * 4);
  return [load<u8>(at), load<u8>(at + 1), load<u8>(at + 2)];
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

  const handle = gfx.open(<i32>scene.CANVAS_WIDTH, <i32>scene.CANVAS_HEIGHT, 0);
  if (handle <= 0) {
    print("FAIL: open -> " + handle.toString());
    RuntimeSession.close();
    return;
  }

  // The wire layout, checked before a single record is drawn: the struct writes
  // a record and reads it back at the offsets `tension_2d.h` publishes. The
  // compile-time assertions in `types.ts` already proved the declaration's
  // layout, so this is the other half — that the writes land there.
  const layout = layoutSelfTest(LAYOUT_SCRATCH);
  if (layout != 0) {
    print("FAIL: layout self-test -> code " + layout.toString());
    gfx.close(handle);
    RuntimeSession.close();
    return;
  }
  print("layout: ok (" + RECORD_SIZE.toString() + "-byte record, " + HEADER_SIZE.toString() + "-byte header)");

  const pipe = gfx.setPipelinePreset(handle, 1);
  if (pipe < 1) {
    print("FAIL: set_pipeline(preset 1) -> " + pipe.toString());
    gfx.close(handle);
    RuntimeSession.close();
    return;
  }
  print("set_pipeline -> pipe " + pipe.toString());

  // The pages, in slot order: `Tileset.load` assumes page i is slot i, which is
  // what makes a frame's `tex` the slot the shader indexes.
  const textures: i32[] = [];
  for (let i: i32 = 0; i < scene.PAGE_FILES.length; i++) {
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
    textures.push(tex);
  }

  const tileset = Tileset.load(textures, scene.PAGE_SIZE, scene.PAGE_SIZE, scene.TILE_SIZE);
  if (!tileset.isValid()) {
    print("FAIL: Tileset.load refused " + textures.length.toString() + " pages");
    gfx.close(handle);
    RuntimeSession.close();
    return;
  }
  const bound = tileset.bind(handle, pipe);
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

  const header: usize = memory.data(<usize>HEADER_SIZE, 4);
  const frame: usize = memory.data(<usize>FRAME_BYTES, 8);

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

    const written = world.emit(records);
    if (written != count) {
      print("FAIL: emit(" + name + ") wrote " + written.toString() + ", counted " + count.toString());
      failures++;
      break;
    }
    // The framework writes the submit header too: the record contract is one
    // thing, and splitting its two halves across two modules is how they drift.
    writeSubmitHeader(header, records, written);

    const accepted = gfx.submit(handle, pipe, header, 0);
    if (accepted != <i32>written) {
      print("FAIL: submit(" + name + ") -> " + accepted.toString() + ", expected " + written.toString());
      failures++;
      break;
    }
    if (gfx.present(handle) != 0) {
      print("FAIL: present(" + name + ") failed");
      failures++;
      break;
    }
    const got = gfx.screenshot(handle, frame, <i32>FRAME_BYTES);
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

  gfx.close(handle);
  RuntimeSession.close();
  print(failures == 0 ? "OK: built by Tileset + Composite + IsometricWorld" : "FAILED");
}
