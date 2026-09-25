// A barrel on screen: a mesh from a file, drawn and read back.
//
// The session runtime owns the loop, the arena and the events; a capability
// adapter owns the renderer; this file owns the world. Nothing here draws — it
// submits records, and the renderer reads them on its own thread.
//
// The mesh is the *loaded* kind: `Barrel.mesh` comes off disk through the job
// queue and the resource id that comes back is what the renderable names. Its
// sibling `hello-triangle` builds a mesh out of nothing but the guest's own
// memory instead (`MeshBuilder`), which is the other way a mesh arrives.
//
//   ./run.sh                             a window, a screenshot, a summary
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed

// The session: the loop, the arena, the event ring, the frame handshake.
import { ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession } from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

const WINDOWED_RENDERER = "gl3plus";

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("hello-mesh: " + what);
  assert(false, what);
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/// Whatever `_start_game` needs to know before it touches the runtime.
class Options {
  tns: string = "";
  renderer: string = "null";

  get windowed(): bool { return this.renderer == WINDOWED_RENDERER; }
}

/// The launcher names the renderer; null needs no display, so it is the default.
function parseArgs(): Options {
  const options = new Options();
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) options.tns = value.slice(6);
    else if (value.startsWith("--renderer=")) options.renderer = value.slice(11);
  }
  return options;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

class Game {
  private options: Options;
  // Whatever `ogre.jobResult` hands back for a loaded mesh (an id/handle).
  private mesh: i32 = 0;

  constructor(options: Options) {
    this.options = options;
  }

  /// Open the session, bring up OGRE, mount the volume, load the mesh.
  initialize(): void {
    const callbacks = makeCallbacks(null, null);
    if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
      fail("session_open refused");
    }

    const windowed = this.options.windowed;
    const config = new ogre.ConfigBuilder()
      .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
      // 640x480 rather than something smaller: a window a human is looking at
      // should be readable at a glance.
      .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
    const started = ogre.init(config);
    if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");

    // Everything this example loads comes out of one packed volume (chunk 11):
    // the assets live in `resources/`, `pack.sh` packs them, and the run script
    // hands the absolute path in as `--tns=`. No mount, no bytes — there is no
    // fallback to the disk.
    if (this.options.tns.length == 0) {
      fail("no --tns=<volume> argument (the assets are packed; run via ./run.sh)");
    }
    const mounted = ogre.mountTns("resources", this.options.tns);
    if (mounted != 0) fail("mountTns refused (" + mounted.toString() + ")");

    this.mesh = this.loadMesh("resources/models/Barrel.mesh");
  }

  /// Loads are asynchronous: the job id is a handle you resolve when the result
  /// arrives. The worker reads the bytes; the render thread makes the mesh.
  private loadMesh(path: string): i32 {
    const job = ogre.queueMeshLoad(path, 0);
    if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");
    while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
      RuntimeSession.wait(10);
    }
    if (ogre.jobState(job) != ogre.JOB_DONE) fail(path + " did not load");
    return ogre.jobResult(job);
  }

  /// Hand the renderer a material, a camera and the mesh placed in the world.
  submitScene(): void {
    // Unlit is the simplest material: a colour, and no lights required. The
    // factories fill the shape; the ids are yours, because they are the guest's
    // own handles.
    const material = ogre.Material.unlit(0.9, 0.2, 0.2);
    material.materialId = 1;
    if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

    // Four units back on +Z. An OGRE camera looks down its own -Z, so an
    // identity rotation looks at the origin.
    const camera = ogre.CameraRecord.perspective(
      45.0 * (3.14159265358979 / 180.0), <f32>320 / <f32>240, 0.1, 100.0, 0.0, 0.0, 4.0);
    camera.cameraId = 1;
    if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

    // A renderable is a mesh, a material and a place in the world; the barrel
    // is about five units across, so 0.02 fits it in the frame.
    const renderable = ogre.Renderable.at(this.mesh, 1, 0.0, 0.0, 0.0, 0.02);
    renderable.renderableId = 1;
    if (ogre.submitRenderable(renderable) != 0) fail("submitRenderable refused");
  }

  /// Run the scene, then either report structurally (headless) or grab a frame.
  run(): void {
    this.initialize();
    this.submitScene();

    if (!this.options.windowed) {
      print("renderer=null: no pixels to read; submitted 1 object");
      return;
    }

    this.captureFrame();
  }

  /// The frame counter is the renderer's own progress, so waiting on it is
  /// waiting on something real. A screenshot is probe/consume: ask, wait, read.
  private captureFrame(): void {
    const from = ogre.frameCount();
    while (ogre.frameCount() < from + 300) RuntimeSession.wait(16);
    ogre.screenshot(0, 0);
    while (ogre.frameCount() < from + 340) RuntimeSession.wait(16);
    const bytes = ogre.screenshot(0, 0);
    if (bytes <= 0) fail("no frame was downloaded");
    const frame = new ArrayBuffer(bytes);
    if (ogre.screenshot(changetype<usize>(frame), bytes) != bytes) fail("the frame came back short");

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
  const options = parseArgs();
  const game = new Game(options);
  game.run();
  game.shutdown();
}