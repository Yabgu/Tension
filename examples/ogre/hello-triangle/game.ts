// A triangle on screen, built out of nothing: no file, no loader, nine numbers.
//
// This is the smallest mesh a Tension game can make — `MeshBuilder.triangle`
// writes three positions into the guest's own memory and `ogre::create_mesh`
// turns them into a resource the renderer can draw, exactly as if a `.mesh`
// file had been loaded. Its sibling `hello-mesh` takes the other road: a barrel
// off disk through the job queue.
//
// The session runtime owns the loop, the arena and the events; a capability
// adapter owns the renderer; this file owns the world. Nothing here draws — it
// submits records, and the renderer reads them on its own thread.
//
//   ./run.sh                             a window, a screenshot, a summary
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed

// The session: the loop, the arena, the event ring, the frame handshake.
import { ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession, rt } from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";
// The std's task machine: the table the push path parks in (0.7.0a).
import { __taskBindTable } from "~lib/task-rt";

// The host's wake entry. Re-exported because the linker drops an export the
// guest never names, and the host resolves `__taskWake` by name at load.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

const WINDOWED_RENDERER = "gl3plus";

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("hello-triangle: " + what);
  assert(false, what);
}

/// The pixel census. A free function, not inline: the async body refuses
/// `continue` and a `<T>` cast, and this needs both.
function reportFrame(frame: ArrayBuffer, bytes: i32): void {
  // The workspace clears to a dark grey, so "not background" is what we drew.
  const pixels = Uint8Array.wrap(frame);
  let drawn = 0, sum_r = 0.0, sum_g = 0.0, sum_b = 0.0;
  for (let i = 0; i < bytes; i += 4) {
    if (pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40) continue;
    drawn++;
    sum_r += <f64>pixels[i]; sum_g += <f64>pixels[i + 1]; sum_b += <f64>pixels[i + 2];
  }
  print("rendered " + ogre.frameCount().toString() + " frames, " + drawn.toString() +
        " non-background pixels, mean rgb " + u32(sum_r / drawn).toString() + "/" +
        u32(sum_g / drawn).toString() + "/" + u32(sum_b / drawn).toString());
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// Whatever `_start_game` needs to know before it touches the runtime.
class Options {
  renderer: string = "null";

  get windowed(): bool { return this.renderer == WINDOWED_RENDERER; }
}

/// The launcher names the renderer; null needs no display, so it is the default.
function parseArgs(): Options {
  const options = new Options();
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) options.renderer = value.slice(11);
  }
  return options;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

class Game {
  private options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  /// Open the session and the renderer, submit the triangle, then either report
  /// structurally (headless) or grab a frame.
  async run(): void {
    // Declared before the first await: the transform scopes a local declared
    // after one to its own resume guard.
    let from: u64 = 0;
    let bytes: i32 = 0;

    this.openSession();
    this.openRenderer();
    const mesh: i32 = this.buildMesh();

    // The render thread builds the mesh on its next pass; the resource record is
    // where the guest learns it happened. Waiting on the frame clock is what
    // lets the host wake this task — no `RuntimeSession.wait`, no `rt.runReady()`.
    while (ogre.resourceState(mesh) != ogre.RES_STATE_READY) {
      if (ogre.resourceState(mesh) == ogre.RES_STATE_FAILED) fail("the mesh was never built");
      await rt.frame();
    }
    this.submitScene(mesh);

    if (!this.options.windowed) {
      print("renderer=null: no pixels to read; submitted 1 object");
    } else {
      // The frame counter is the renderer's own progress, so waiting on it is
      // waiting on something real. A screenshot is probe/consume: ask, wait,
      // read. The waiting is the frame clock now — no `RuntimeSession.wait`.
      from = ogre.frameCount();
      while (ogre.frameCount() < from + 300) await rt.frame();
      ogre.screenshot(0, 0);
      while (ogre.frameCount() < from + 340) await rt.frame();
      bytes = ogre.screenshot(0, 0);
      if (bytes <= 0) fail("no frame was downloaded");
      const frame = new ArrayBuffer(bytes);
      if (ogre.screenshot(changetype<usize>(frame), bytes) != bytes) {
        fail("the frame came back short");
      }
      reportFrame(frame, bytes);
    }

    this.shutdown();
    finished = true;
  }

  /// The session itself: the loop, the arena, the event ring, the frame
  /// handshake. Nothing in this file runs before it opens.
  private openSession(): void {
    // Open the session, then hand the renderer its own config.
    const callbacks = makeCallbacks(null, null);
    if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
      fail("session_open refused");
    }
  }

  /// Bring up the renderer the launcher asked for.
  private openRenderer(): void {
    const windowed = this.options.windowed;
    const config = new ogre.ConfigBuilder()
      .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
      .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
    const started = ogre.init(config);
    if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");
  }

  /// Build the triangle in the guest's own memory, then hand the renderer a
  /// material, a camera and the mesh placed in the world.
  buildMesh(): i32 {
    // Nine numbers and three indices: a triangle in the XY plane, one unit either
    // way from the origin. This is the whole mesh — no file, no job, no bytes to
    // read.
    const mesh = ogre.MeshBuilder.triangle(-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0);
    if (mesh <= 0) fail("MeshBuilder.triangle refused (" + mesh.toString() + ")");

    // The id comes back *before* the mesh exists: only the render thread may make
    // an OGRE object, so it is built on that thread's next pass and the resource
    // record is where a guest learns it happened. Submitting a renderable against
    // a resource that is not READY yet is refused and skipped, so wait for the
    // record exactly as a loader's job is waited for.
    // The render thread builds it; the readiness wait belongs to `run`, which
    // holds every `await` in this guest. An async helper here would park *its*
    // task and leave `run` on the ready queue a host loop never drains. So the
    // wait sits between this method and `submitScene`, both synchronous.
    return mesh;
  }

  /// The material, the camera and the renderable — after the mesh is READY,
  /// because a renderable naming a resource that is still building is refused.
  submitScene(mesh: i32): void {

    // Unlit is the simplest material: a colour, and no lights required.
    const material = ogre.Material.unlit(0.9, 0.2, 0.2);
    material.materialId = 1;
    if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

    // Four units back on +Z. An OGRE camera looks down its own -Z, so an identity
    // rotation looks at the origin — and at z=0 this camera's 45° frustum shows
    // about ±1.65 units, which is why a triangle of ±1 fills the middle of it.
    const camera = ogre.CameraRecord.perspective(
      45.0 * (3.14159265358979 / 180.0), <f32>640 / <f32>480, 0.1, 100.0, 0.0, 0.0, 4.0);
    camera.cameraId = 1;
    if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

    // A renderable is a mesh, a material and a place in the world. Scale 1.0: the
    // triangle is already the size this camera shows.
    const renderable = ogre.Renderable.at(mesh, 1, 0.0, 0.0, 0.0, 1.0);
    renderable.renderableId = 1;
    if (ogre.submitRenderable(renderable) != 0) fail("submitRenderable refused");
  }

  /// Bring the renderer and the session down. Safe to call on any exit path.
  shutdown(): void {
    ogre.shutdown();
    RuntimeSession.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function _start_game(): void {
  rt.start();
  // The table the push path parks slots in (0.7.0a); one task parks at a time.
  __taskBindTable(8);
  const game = new Game(parseArgs());
  // A floating task: it runs the synchronous prologue and parks on the mesh's
  // readiness. From here the host owns the loop.
  game.run();
}

/// 1 while the guest wants the host to drive it (0.7.0a). Cleared after
/// teardown, so the host's exit cannot cut the last frame or the readback off.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}
