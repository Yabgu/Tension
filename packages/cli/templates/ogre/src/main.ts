// src/main.ts — a spinning triangle.
//
// The smallest 3D Tension game: three vertices written into the guest's own
// memory, a material, a camera, and one renderable whose rotation changes every
// frame. There is no mesh file, no asset volume and no loader — `MeshBuilder`
// is the whole pipeline.
//
// The shape is the same five steps the 2D starter has, with the renderer
// swapped:
//
//   1. open the session
//   2. bring up the renderer on the host's window
//   3. build the mesh (guest memory, no file)
//   4. submit material, camera and renderable
//   5. rotate the renderable once per frame, until the window closes
//
// The renderer runs on its own thread: this file never draws, it submits
// records, and `await rt.frame()` is how it learns that a frame went by.

import { ConfigBuilder, makeCallbacks, print, RuntimeSession, rt } from "tension-framework";
// The OGRE SDK under its own path: its `ConfigBuilder` is a different one from
// the session's, and `initWindowed` owns the window creation.
import * as ogre from "tension-framework/assembly/ogre";
import { windowRequest } from "tension-framework/assembly/platform";
// The std's task machine: the table the push path parks in.
import { __taskBindTable } from "~lib/task-rt";

// Re-exported because the linker drops an export the guest never names, and the
// host resolves `__taskWake` by name at load.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

// ── the numbers worth changing ──────────────────────────────────────────────

/// Radians per frame. **Change this first** — the restart loop is easiest to see
/// as a triangle that suddenly spins faster.
const SPIN: f32 = 0.02;

/// Camera distance. Two units back shows a ±1 triangle filling most of the view.
const CAMERA_Z: f32 = 4.0;

const HALF_PI_HALF: f32 = 0.5;

function fail(what: string): void {
  print("starter: " + what);
  // A guest exits non-zero by trapping; there is no exit code to set.
  assert(false, what);
}

class Game {
  private width: i32 = 1280;
  private height: i32 = 720;
  private title: string = "Tension";
  private headless: bool = false;
  private angle: f32 = 0.0;
  /// The mesh resource, kept so the per-frame record can name it again.
  private mesh: i32 = 0;

  constructor(width: i32, height: i32, title: string, headless: bool) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.headless = headless;
  }

  /// Everything that has to happen once, then the frame loop.
  async run(): void {
    // Declared before the first await: the transform scopes a local declared
    // after one to its own resume guard.
    let mesh: i32 = 0;

    this.openSession();
    this.openRenderer();
    mesh = this.buildMesh();
    this.mesh = mesh;

    // The render thread builds the mesh on its next pass. Waiting on the frame
    // clock is what lets the host wake this task — no `RuntimeSession.wait`.
    while (ogre.resourceState(mesh) != ogre.RES_STATE_READY) {
      if (ogre.resourceState(mesh) == ogre.RES_STATE_FAILED) fail("the mesh was never built");
      await rt.frame();
    }
    this.submitScene(mesh);

    print("starter: a triangle spinning at " + SPIN.toString() + " rad/frame, " +
      this.width.toString() + "x" + this.height.toString() +
      (this.headless ? ", headless" : ""));

    // One iteration per frame the renderer presents. `_game_running()` is what
    // keeps this loop being driven; the host stops the loop when the window is
    // closed, so there is nothing to poll for here.
    while (true) {
      await rt.frame();
      this.spin();
      if (this.headless) {
        // No window to close, so the headless run is bounded instead: 240
        // frames, the same budget the 2D starter uses.
        this.frames++;
        if (this.frames >= 240) break;
      }
    }

    this.shutdown();
    finished = true;
  }

  private frames: i32 = 0;

  /// The session: the loop, the arena, the event ring, the frame handshake.
  private openSession(): void {
    // `makeCallbacks` wires the slot table the push path parks tasks in; a
    // parked task learns of its completion only through that dispatch.
    const callbacks = makeCallbacks(null, null);
    if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
      fail("session_open refused");
    }
  }

  /// The renderer, on the host's window or on nothing.
  private openRenderer(): void {
    // The title is part of `InitOptions`, and `initWindowed` owns the window
    // creation — so the config's title reaches the window through here and
    // nowhere else.
    let options = ogre.initOptions();
    options.title = this.title;
    const rc = this.headless
      ? ogre.initHeadless(options)
      : ogre.initWindowed(this.width, this.height, options);
    if (rc != 0) {
      fail("ogre::init refused: " + rc.toString() +
        (this.headless ? "" : " (is there a display? try --headless)"));
    }
  }

  /// The mesh, out of nine numbers.
  private buildMesh(): i32 {
    const mesh = ogre.MeshBuilder.triangle(-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0);
    if (mesh <= 0) fail("MeshBuilder.triangle refused (" + mesh.toString() + ")");
    return mesh;
  }

  /// Material, camera and renderable — after the mesh is READY, because a
  /// renderable naming a resource that is still building is refused.
  private submitScene(mesh: i32): void {
    const material = ogre.Material.unlit(0.9, 0.35, 0.25);
    material.materialId = 1;
    if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

    const camera = ogre.CameraRecord.perspective(
      45.0 * (3.14159265358979 / 180.0),
      <f32>this.width / <f32>this.height,
      0.1, 100.0, 0.0, 0.0, CAMERA_Z);
    camera.cameraId = 1;
    if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

    // The first placement. `spin()` re-submits the same id with a new rotation
    // every frame, which is an upsert of this record.
    let record = ogre.Renderable.at(mesh, 1, 0.0, 0.0, 0.0, 1.0);
    record.renderableId = 1;
    if (ogre.submitRenderable(record) != 0) fail("submitRenderable refused");
  }

  /// Rotate the triangle about Z by re-submitting its record.
  ///
  /// A renderable is an inline transform plus a mesh and a material, so moving
  /// one is an upsert of the same record: the adapter applies the new rotation
  /// on the render thread's next pass. There is no "set rotation" verb, and
  /// deliberately none — an upsert is the same path a loader's placement takes.
  ///
  /// The record is built here rather than kept as a field: a struct field is not
  /// a value the compiler will hand to an `@inline` parameter (AS100), so the
  /// one place that fills and submits it is the one place that owns it.
  private spin(): void {
    this.angle += SPIN;
    // A quaternion about Z: (0, 0, sin(a/2), cos(a/2)). The half-angle is why
    // the constant is 0.5 rather than 1.
    const half: f32 = this.angle * HALF_PI_HALF;
    let record = ogre.Renderable.at(this.mesh, 1, 0.0, 0.0, 0.0, 1.0);
    record.renderableId = 1;
    record.rotation.x = 0.0;
    record.rotation.y = 0.0;
    record.rotation.z = <f32>Math.sin(half);
    record.rotation.w = <f32>Math.cos(half);
    if (ogre.submitRenderable(record) != 0) fail("submitRenderable refused");
  }

  /// Bring the renderer and the session down. Safe on any exit path.
  private shutdown(): void {
    ogre.shutdown();
    RuntimeSession.close();
  }
}

/// 1 while the guest wants the host to drive it. Cleared after teardown, so the
/// host's exit cannot cut the last frame off.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(8);

  // The window contract: the CLI turns tension.config.json into these
  // arguments, and `--headless` is how a machine with no display runs the same
  // guest.
  const request = windowRequest();
  const game = new Game(request.width, request.height, request.title, request.headless);
  // A floating task: it runs the synchronous prologue and parks on the frame
  // clock. From here the host owns the loop.
  game.run();
}
