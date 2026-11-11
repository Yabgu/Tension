// examples/2d/box-physics/src/main.ts
//
// 2D Rigid Body Box Physics Simulation.
//
// Demonstrates:
//   - Full box-box and box-environment collision detection via SAT
//   - Contact manifold generation using Sutherland-Hodgman polygon clipping
//   - Sequential impulse resolution with rotational dynamics, friction, and bounce
//   - Gravity, tumbling on inclined ramps, and settling on the floor
//   - Visual rendering through tension-2d's Canvas using pre-baked rotated sprites

import {
  arg,
  argCount,
  Canvas,
  ConfigBuilder,
  PIPE_PRESET_MIN,
  print,
  RECORD_SIZE,
  Rgba,
  RuntimeSession,
  SpriteRecord,
} from "tension-framework";
import * as platform from "tension-framework/assembly/platform";
import {
  buildBoxAtlas,
  getBoxFrame,
  getStaticTileFrame,
  SHAPE_AMBER_SQUARE,
  SHAPE_BLUE_RECT,
  SHAPE_CYAN_CUBE,
  SHAPE_GREEN_RECT,
  SHAPE_PURPLE_SLAB,
  SHAPE_RAMP,
  SHAPE_RED_SQUARE,
  SHAPE_STATIC_TILE,
} from "./atlas";
import { DEFAULT_2D_BLOB } from "./graph.generated";
import { absf } from "./math";
import { Body, PhysicsWorld } from "./physics";

function hasArg(flag: string): bool {
  for (let i = 0; i < argCount(); i++) {
    if (arg(i) == flag) return true;
  }
  return false;
}

function wantsWindow(): bool {
  return hasArg("--windowed") || hasArg("--window");
}

const CANVAS_WIDTH: u32 = 640;
const CANVAS_HEIGHT: u32 = 360;
const FRAME_BYTES: u32 = CANVAS_WIDTH * CANVAS_HEIGHT * 4;
const ATLAS_SIZE: u32 = 1024;
const ATLAS_BYTES: u32 = 74 + ATLAS_SIZE * ATLAS_SIZE * 4;

const MAX_RECORDS: i32 = 128;
const RECORD_BYTES: i32 = MAX_RECORDS * <i32>RECORD_SIZE;

const SIMULATION_FRAMES: i32 = 600; // 10 seconds of physics @ 60 fps
const WINDOW_FRAMES: i32 = 18000;

function fail(what: string): void {
  print("box-physics: " + what);
}

function emitStaticEnvironment(
  out: @unmanaged [SpriteRecord *],
  startIdx: i32,
): i32 {
  let idx = startIdx;
  const tileFrame = getStaticTileFrame();

  // 1. Floor: 10 segments of 64 px across bottom (y = 330)
  for (let i = 0; i < 10; i++) {
    out[idx].set(i * 64, 330, tileFrame, <u32>idx, 0, 0);
    idx++;
  }

  // 2. Ceiling: 10 segments of 64 px across top (y = 0)
  for (let i = 0; i < 10; i++) {
    out[idx].set(i * 64, 0, tileFrame, <u32>idx, 0, 0);
    idx++;
  }

  // 3. Left Wall: 6 segments of 60 px along x = 0
  for (let i = 0; i < 6; i++) {
    out[idx].set(0, i * 60, tileFrame, <u32>idx, 0, 0);
    idx++;
  }

  // 4. Right Wall: 6 segments of 60 px along x = 620
  for (let i = 0; i < 6; i++) {
    out[idx].set(620, i * 60, tileFrame, <u32>idx, 0, 0);
    idx++;
  }

  // 5. Left Ramp at (175, 225) angle = 0.35 rad
  const leftRampFrame = getBoxFrame(SHAPE_RAMP, 0.35);
  out[idx].set(175 - 32, 225 - 32, leftRampFrame, <u32>idx, 0, 0);
  idx++;

  // 6. Right Ramp at (465, 225) angle = -0.35 rad
  const rightRampFrame = getBoxFrame(SHAPE_RAMP, -0.35);
  out[idx].set(465 - 32, 225 - 32, rightRampFrame, <u32>idx, 0, 0);
  idx++;

  return idx;
}

function emitDynamicBoxes(
  world: PhysicsWorld,
  out: @unmanaged [SpriteRecord *],
  startIdx: i32,
): i32 {
  let idx = startIdx;
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.isStatic) continue;

    const frame = getBoxFrame(b.shapeType, b.angle);
    const spriteX = <i32>Mathf.round(b.x - 32.0);
    const spriteY = <i32>Mathf.round(b.y - 32.0);

    out[idx].set(spriteX, spriteY, frame, <u32>idx, 0, 0);
    idx++;
  }
  return idx;
}

export function _start_game(): void {
  print("=== TensionCore 2D demo: full rigid body box physics simulation ===");

  // 1. Open the session
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    fail("the session did not open");
    return;
  }

  // 2. Open canvas (windowed or offscreen)
  const window = wantsWindow();
  const canvas = window
    ? Canvas.windowedOrOffscreen(<i32>CANVAS_WIDTH, <i32>CANVAS_HEIGHT, "box-physics")
    : Canvas.open(<i32>CANVAS_WIDTH, <i32>CANVAS_HEIGHT);

  if (!canvas.isValid()) {
    fail("open -> " + canvas.lastError().toString());
    return;
  }
  if (window && !canvas.displaysToWindow()) {
    print("box-physics: no window; drawing offscreen");
  }
  print("open -> handle " + canvas.handle.toString());

  if (canvas.displaysToWindow()) {
    platform.setWindowTitle("2D Rigid Body Box Physics Simulation");
  }

  const info = canvas.readInfo();
  if (info.version == 0) {
    fail("info -> " + canvas.lastError().toString());
    canvas.close();
    return;
  }
  print(
    "info -> v" + info.version.toString() +
      ", max_records " + info.maxRecords.toString() +
      ", canvas " + info.canvasWidth.toString() + "x" +
      info.canvasHeight.toString(),
  );

  // 3. Set pipeline graph
  const BLOB_SIZE: i32 = 584;
  const blobPtr: usize = memory.data(BLOB_SIZE, 8);
  memory.copy(blobPtr, changetype<usize>(DEFAULT_2D_BLOB.dataStart), <usize>BLOB_SIZE);
  const pipe = canvas.pipelineGraph(blobPtr, <u32>BLOB_SIZE);
  if (pipe < PIPE_PRESET_MIN) {
    fail("set_pipeline -> " + pipe.toString());
    canvas.close();
    return;
  }
  print("set_pipeline -> pipe " + pipe.toString());

  // 4. Build and load the 1024x1024 RGBA atlas
  const atlas = buildBoxAtlas();
  const tex = canvas.loadTexture(atlas, ATLAS_BYTES);
  if (tex <= 0) {
    fail("texture_load -> " + tex.toString());
    canvas.close();
    return;
  }
  const bound = canvas.bindTexture(pipe, 0, tex);
  if (bound != 0) {
    fail("set_texture -> " + bound.toString());
    canvas.close();
    return;
  }
  print("texture_load -> texture " + tex.toString() + " (1024x1024 RGBA), bound to page 0");

  // 5. Initialize the Physics World
  const world = new PhysicsWorld(256);
  world.gravityY = 480.0; // px/s² downward

  // Static environment: Floor, Ceiling, Walls, Ramps (thick overlapping boundary colliders)
  // Floor: y from 330 to 450 (hh = 60), x from -80 to 720 (hw = 400)
  world.addBody(Body.createStatic(1, 320.0, 390.0, 0.0, 400.0, 60.0, 0.2, 0.6, SHAPE_STATIC_TILE));
  // Ceiling: y from -90 to 15 (hh = 52.5), x from -80 to 720 (hw = 400)
  world.addBody(Body.createStatic(2, 320.0, -37.5, 0.0, 400.0, 52.5, 0.2, 0.4, SHAPE_STATIC_TILE));
  // Left Wall: x from -90 to 18 (hw = 54), y from -80 to 440 (hh = 260)
  world.addBody(Body.createStatic(3, -36.0, 180.0, 0.0, 54.0, 260.0, 0.2, 0.4, SHAPE_STATIC_TILE));
  // Right Wall: x from 622 to 730 (hw = 54), y from -80 to 440 (hh = 260)
  world.addBody(Body.createStatic(4, 676.0, 180.0, 0.0, 54.0, 260.0, 0.2, 0.4, SHAPE_STATIC_TILE));
  // Left Ramp: (175, 225) angle = 0.35 rad
  world.addBody(Body.createStatic(5, 175.0, 225.0, 0.35, 28.0, 8.0, 0.2, 0.4, SHAPE_RAMP));
  // Right Ramp: (465, 225) angle = -0.35 rad
  world.addBody(Body.createStatic(6, 465.0, 225.0, -0.35, 28.0, 8.0, 0.2, 0.4, SHAPE_RAMP));

  // Dynamic boxes: varied shapes, sizes, starting positions, initial angles and velocities
  const initialAngles: f32[] = [
    0.2, -0.5, 0.8, -0.3, 0.6, -0.7, 0.4, -0.2, 0.5, -0.4, 0.1, 0.9,
  ];

  world.addBody(Body.createDynamic(10, 140.0, 50.0, initialAngles[0], 15.0, 15.0, 0.01, 0.35, 0.4, SHAPE_RED_SQUARE));
  world.addBody(Body.createDynamic(11, 200.0, 80.0, initialAngles[1], 21.0, 10.0, 0.01, 0.35, 0.4, SHAPE_BLUE_RECT));
  world.addBody(Body.createDynamic(12, 260.0, 45.0, initialAngles[2], 10.0, 21.0, 0.01, 0.35, 0.4, SHAPE_GREEN_RECT));
  world.addBody(Body.createDynamic(13, 320.0, 75.0, initialAngles[3], 13.0, 13.0, 0.01, 0.35, 0.4, SHAPE_AMBER_SQUARE));
  world.addBody(Body.createDynamic(14, 380.0, 55.0, initialAngles[4], 19.0, 12.0, 0.01, 0.35, 0.4, SHAPE_PURPLE_SLAB));
  world.addBody(Body.createDynamic(15, 440.0, 95.0, initialAngles[5], 11.0, 11.0, 0.01, 0.35, 0.4, SHAPE_CYAN_CUBE));
  world.addBody(Body.createDynamic(16, 170.0, 130.0, initialAngles[6], 15.0, 15.0, 0.01, 0.35, 0.4, SHAPE_RED_SQUARE));
  world.addBody(Body.createDynamic(17, 230.0, 150.0, initialAngles[7], 21.0, 10.0, 0.01, 0.35, 0.4, SHAPE_BLUE_RECT));
  world.addBody(Body.createDynamic(18, 350.0, 135.0, initialAngles[8], 10.0, 21.0, 0.01, 0.35, 0.4, SHAPE_GREEN_RECT));
  world.addBody(Body.createDynamic(19, 410.0, 120.0, initialAngles[9], 13.0, 13.0, 0.01, 0.35, 0.4, SHAPE_AMBER_SQUARE));
  world.addBody(Body.createDynamic(20, 290.0, 140.0, initialAngles[10], 19.0, 12.0, 0.01, 0.35, 0.4, SHAPE_PURPLE_SLAB));
  world.addBody(Body.createDynamic(21, 470.0, 150.0, initialAngles[11], 11.0, 11.0, 0.01, 0.35, 0.4, SHAPE_CYAN_CUBE));

  const records: usize = memory.data(RECORD_BYTES, 8);
  let out = changetype<@unmanaged [SpriteRecord *]>(records);

  const dt: f32 = 1.0 / 60.0;
  let totalDrawnRecords: i32 = 0;

  // 6. Run simulation loop for 180 frames (headless validation phase)
  for (let frame = 0; frame < SIMULATION_FRAMES; frame++) {
    world.step(dt);

    let recCount = emitStaticEnvironment(out, 0);
    recCount = emitDynamicBoxes(world, out, recCount);
    totalDrawnRecords = recCount;

    const accepted = canvas.submit(pipe, out, <u32>recCount, 0);
    if (accepted != recCount) {
      fail("submit failed on frame " + frame.toString());
      canvas.close();
      return;
    }
    if (canvas.present() != 0) {
      fail("present failed on frame " + frame.toString());
      canvas.close();
      return;
    }
  }

  // 7. Verify simulation physics invariants
  let physicsOk = true;

  // 7a. Ensure hundreds of collisions were resolved
  if (world.totalCollisionsResolved < 50) {
    fail("insufficient collisions resolved: " + world.totalCollisionsResolved.toString());
    physicsOk = false;
  }

  // 7b. Ensure all dynamic bodies stayed within bounds, kept finite coordinates, and rotated
  let dynCount = 0;
  let rotatedCount = 0;
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    if (b.isStatic) continue;

    if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !isFinite(b.vy) ||
        !isFinite(b.angle) || !isFinite(b.omega)) {
      fail("body " + b.id.toString() + " has NaN/infinite state");
      physicsOk = false;
    }

    if (b.y < 20.0 || b.y > 340.0 || b.x < 15.0 || b.x > 625.0) {
      fail("body " + b.id.toString() + " escaped arena bounds: (" + b.x.toString() + "," + b.y.toString() + ")");
      physicsOk = false;
    }

    // Check that collision torques produced rotation
    const initA = initialAngles[dynCount];
    if (absf(b.angle - initA) > 0.3) {
      rotatedCount++;
    }
    dynCount++;
  }

  if (rotatedCount < 8) {
    fail("expected at least 8 bodies to rotate from collision torques, got " + rotatedCount.toString());
    physicsOk = false;
  }

  // 8. Verify rendering via screenshot readback
  const shotBuf: usize = memory.data(<i32>FRAME_BYTES, 8);
  let shot = changetype<@unmanaged [Rgba *]>(shotBuf);
  const written = canvas.screenshot(shot, FRAME_BYTES);
  if (written != <i32>FRAME_BYTES) {
    fail("screenshot failed");
    canvas.close();
    return;
  }

  let pixels = changetype<@unmanaged [Rgba *]>(shotBuf);
  let nonBlack: u32 = 0;
  for (let i: u32 = 0; i < CANVAS_WIDTH * CANVAS_HEIGHT; i++) {
    if (pixels[i].r != 0 || pixels[i].g != 0 || pixels[i].b != 0) nonBlack++;
  }

  print(
    "physics -> resolved " + world.totalCollisionsResolved.toString() +
      " contact pairs, " + rotatedCount.toString() + "/" + dynCount.toString() +
      " bodies rotated through collision torque",
  );
  print(
    "screenshot -> " + written.toString() + " bytes, " +
      nonBlack.toString() + " non-black pixels (" + totalDrawnRecords.toString() + " sprite records)",
  );

  // Expected at least 20k non-black pixels from floor, walls, ramps, and tumbled boxes
  if (nonBlack < 20000) {
    fail("too few non-black pixels drawn: " + nonBlack.toString());
    physicsOk = false;
  }

  if (physicsOk) {
    print("OK: full 2d box physics simulation verified");
  } else {
    fail("simulation verification failed");
  }

  // 9. Interactive Windowed Loop
  if (wantsWindow() && physicsOk) {
    print("windowed: running 2D box physics simulation (close window to exit)");
    let frameCount: i32 = 0;
    while (frameCount < WINDOW_FRAMES) {
      world.step(dt);

      let recCount = emitStaticEnvironment(out, 0);
      recCount = emitDynamicBoxes(world, out, recCount);

      if (canvas.submit(pipe, out, <u32>recCount, 0) != recCount) break;
      if (canvas.present() != 0) break; // Window closed (-ECANCELED)

      RuntimeSession.wait(16);
      frameCount++;
    }
  }

  canvas.close();
  RuntimeSession.close();
}
