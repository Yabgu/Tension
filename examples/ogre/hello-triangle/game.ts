// A triangle on screen: the smallest complete Tension game.
//
// The session runtime owns the loop, the arena and the events; a capability
// adapter owns the renderer; this file owns the world. Nothing here draws — it
// submits records, and the renderer reads them on its own thread.
//
//   ./run.sh                             headless: everything but the pixels
//   TENSION_OGRE_WINDOW_TEST=1 ./run.sh  a real window, and a screenshot

// The session: the loop, the arena, the event ring, the frame handshake.
import { ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession } from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("hello-triangle: " + what);
  assert(false, what);
}

export function _start_game(): void {
  // The launcher names the renderer; null needs no display, so it is the default.
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const windowed = renderer == "gl3plus";

  // Open the session, then hand the renderer its own config.
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    fail("session_open refused");
  }
  const config = new ogre.ConfigBuilder()
    .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    // 640x480 rather than something smaller: this example is the one a reader
    // runs first, and a window a human is looking at should be readable at a
    // glance. The ball keeps 640x480 for the same reason.
    .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
  const started = ogre.init(config);
  if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");

  // Loads are asynchronous: the job id is a handle you resolve when the result
  // arrives. The worker reads the bytes; the render thread makes the mesh.
  const job = ogre.queueMeshLoad("Barrel.mesh", 0);
  if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");
  while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) fail("Barrel.mesh did not load");
  const mesh = ogre.jobResult(job);
  // Unlit is the simplest material: a colour, and no lights required. The
  // factories fill the shape; the ids are yours, because they are the guest's
  // own handles.
  const material = ogre.Material.unlit(0.9, 0.2, 0.2);
  material.materialId = 1;
  if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

  // Four units back on +Z. An OGRE camera looks down its own -Z, so an identity
  // rotation looks at the origin.
  const camera = ogre.CameraRecord.perspective(
    45.0 * (3.14159265358979 / 180.0), <f32>320 / <f32>240, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

  // A renderable is a mesh, a material and a place in the world; the barrel is
  // about five units across, so 0.02 fits it in the frame.
  const renderable = ogre.Renderable.at(mesh, 1, 0.0, 0.0, 0.0, 0.02);
  renderable.renderableId = 1;
  if (ogre.submitRenderable(renderable) != 0) fail("submitRenderable refused");

  if (!windowed) {
    print("renderer=null: no pixels to read; submitted 1 object");
    ogre.shutdown(); RuntimeSession.close();
    return;
  }

  // The frame counter is the renderer's own progress, so waiting on it is
  // waiting on something real. A screenshot is probe/consume: ask, wait, read.
  const from = ogre.frameCount();
  while (ogre.frameCount() < from + 30) RuntimeSession.wait(16);
  ogre.screenshot(0, 0);
  while (ogre.frameCount() < from + 34) RuntimeSession.wait(16);
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

  ogre.shutdown(); RuntimeSession.close();
}
