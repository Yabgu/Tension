// Four characters, one mesh, four skins, three clips.
//
// The subject is `submitAnimation`: the guest names a clip and a time, the
// adapter enables that animation on the renderable's `SkeletonInstance` and
// puts it at that time, and OGRE's own animation system deforms the mesh. The
// guest owns the clock (it computes `elapsed % duration` itself); nothing here
// poses a bone. The bone table still exists for guests that want to pose by
// hand — this example is the other road, the one keyframed clips are for.
//
// The four renderables share **one** mesh resource and differ in two ways: the
// material (each has its own PBS datablock, textured with one of the pack's
// four skins through `slot0`) and the clip. Characters 2 and 4 both run, half
// a cycle apart, so the same clip reads differently twice in one frame.
//
//   ./run.sh                             a window, a screenshot, a summary
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed

// The session: the loop, the arena, the event ring, the frame handshake.
import { ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession } from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

/** The character is 3.765 units tall at scale 1; 0.29 makes it 1.09. */
const SCALE: f32 = 0.29;
const FRAMES = 300; // ~5 seconds at 60 Hz
const MESH = "resources/models/characterMedium.mesh"; // its skeleton, and its three clips, ship beside it

/// The four skins, in the order the four characters stand.
const SKINS: string[] = [
  "resources/textures/humanMaleA.dds",
  "resources/textures/humanFemaleA.dds",
  "resources/textures/zombieMaleA.dds",
  "resources/textures/zombieFemaleA.dds",
];
/// The clips, as the skeleton exporter wrote them (13b's inventory).
const CLIPS: string[] = ["idle", "run", "jump", "run"];
/// Their durations in seconds (13a measured them; this verb does not report them).
const DURATIONS: f64[] = [1.333333, 0.666667, 0.5, 0.666667];
/// The fourth runner starts half a cycle behind the second: same clip, visibly
/// out of phase — 0.333 s is half of Run's 0.667 s.
const OFFSETS: f64[] = [0.0, 0.0, 0.0, 0.333];
const CHARACTERS = 4;

/// The 2x2 grid: two columns, two rows (the front row is nearer the camera).
/// The characters are 1.05 units wide at this scale, so ±0.62 leaves a gap.
const GRID_X: f32[] = [-0.62, 0.62, -0.62, 0.62];
const GRID_Z: f32[] = [-0.45, -0.45, 0.55, 0.55];
/// The mesh origin is at the feet, so every character shifts down to sit in the
/// middle of the frame (the same -0.55 the previous single-character version used).
const GRID_Y: f32 = -0.55;

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("animated-character: " + what);
  assert(false, what);
}

/// One frame from the renderer's readback, or null when there is none (the NULL
/// render system has no framebuffer).
function grab(): ArrayBuffer | null {
  const armed_at = ogre.frameCount();
  ogre.screenshot(0, 0);
  for (let guard: u32 = 0; guard < 300 && ogre.frameCount() < armed_at + 3; guard++) {
    RuntimeSession.wait(5);
  }
  const length = ogre.screenshot(0, 0);
  if (length <= 0) return null;
  const frame = new ArrayBuffer(length);
  const got = ogre.screenshot(changetype<usize>(frame), length);
  if (got != length) return null;
  return frame;
}

/// Foreground is "not the frame's own corner pixel" — a mesh drawn black and a
/// mesh not drawn at all are the same number under a brightness test.
function foreground_count(frame: ArrayBuffer): f64 {
  const pixels = Uint8Array.wrap(frame);
  const bg0 = pixels[0], bg1 = pixels[1], bg2 = pixels[2];
  let count: f64 = 0;
  const length: i32 = <i32>pixels.length;
  for (let i: i32 = 0; i + 2 < length; i += 4) {
    if (abs(<i32>pixels[i] - <i32>bg0) > 8 || abs(<i32>pixels[i + 1] - <i32>bg1) > 8 ||
        abs(<i32>pixels[i + 2] - <i32>bg2) > 8) {
      count += 1;
    }
  }
  return count;
}

/// Pixels that differ between two frames by more than the tolerance the
/// background test uses. Nothing else in the frame moves — the camera is
/// still, the background is a clear colour — so a changed pixel is a bone
/// that moved, and the number is the skinning deforming the mesh.
function changed_count(a: ArrayBuffer, b: ArrayBuffer): f64 {
  const pa = Uint8Array.wrap(a), pb = Uint8Array.wrap(b);
  const length: i32 = <i32>(pa.length < pb.length ? pa.length : pb.length);
  let count: f64 = 0;
  for (let i: i32 = 0; i + 2 < length; i += 4) {
    if (abs(<i32>pa[i] - <i32>pb[i]) > 8 || abs(<i32>pa[i + 1] - <i32>pb[i + 1]) > 8 ||
        abs(<i32>pa[i + 2] - <i32>pb[i + 2]) > 8) {
      count += 1;
    }
  }
  return count;
}

/// Per-quadrant foreground pixels and mean colour: four characters, four skins.
function quadrant_report(frame: ArrayBuffer): string {
  const pixels = Uint8Array.wrap(frame);
  const bg0 = pixels[0], bg1 = pixels[1], bg2 = pixels[2];
  const counts = new Float64Array(4);
  const sums = new Float64Array(12);
  const width = 640, height = 480;
  for (let y: i32 = 0; y < height; y++) {
    for (let x: i32 = 0; x < width; x++) {
      const at: i32 = (y * width + x) * 4;
      if (abs(<i32>pixels[at] - <i32>bg0) <= 8 && abs(<i32>pixels[at + 1] - <i32>bg1) <= 8 &&
          abs(<i32>pixels[at + 2] - <i32>bg2) <= 8) {
        continue;
      }
      const quadrant = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
      counts[quadrant] += 1;
      sums[quadrant * 3] += <f64>pixels[at];
      sums[quadrant * 3 + 1] += <f64>pixels[at + 1];
      sums[quadrant * 3 + 2] += <f64>pixels[at + 2];
    }
  }
  let line = "quadrants (back-left, back-right, front-left, front-right):";
  for (let q: i32 = 0; q < 4; q++) {
    if (counts[q] == 0) {
      line += " q" + q.toString() + "=none";
      continue;
    }
    line += " q" + q.toString() + "=" + counts[q].toString() + "px rgb(" +
            (sums[q * 3] / counts[q]).toString() + "," + (sums[q * 3 + 1] / counts[q]).toString() +
            "," + (sums[q * 3 + 2] / counts[q]).toString() + ")";
  }
  return line;
}

/// Wait for a job to finish, and fail with the job's errno when it failed.
function settle(job: i32, what: string): u32 {
  while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) {
    fail(what + " did not load (state " + ogre.jobState(job).toString() + ", error " +
         ogre.jobError(job).toString() + ")");
  }
  return ogre.jobResult(job);
}

export function _start_game(): void {
  // The launcher names the renderer; null needs no display, so it is the default.
  let renderer = "null";
  let tns = "";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
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
    .headless(!windowed).vsync(false).frameHz(60).windowSize(640, 480);
  const started = ogre.init(config);
  if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");

  // Everything this example loads comes out of one packed volume (chunk 11):
  // the assets live in `resources/`, `pack.sh` packs them, and the run script
  // hands the absolute path in as `--tns=`. No mount, no bytes — there is no
  // fallback to the disk.
  if (tns.length == 0) fail("no --tns=<volume> argument (the assets are packed; run via ./run.sh)");
  const mounted = ogre.mountTns("resources", tns);
  if (mounted != 0) fail("mountTns refused (" + mounted.toString() + ")");

  // One mesh, and the skeleton that ships beside it — with the three clips the
  // converter baked into it (idle, run, jump; chunk 13b).
  const mesh_job = ogre.queueMeshLoad(MESH, 0);
  if (mesh_job <= 0) fail("queueMeshLoad refused (" + mesh_job.toString() + ")");
  const mesh = settle(mesh_job, MESH);
  if (!ogre.isRigged(mesh)) fail(MESH + " came back without a rig");

  // Four skins, one job each: the texture path through the volume, and the
  // resource ids the four materials name in their slot 0.
  const textures: u32[] = [];
  for (let i = 0; i < CHARACTERS; i++) {
    const job = ogre.queueTextureLoad(SKINS[i], 0);
    if (job <= 0) fail("queueTextureLoad refused (" + SKINS[i] + ")");
    const id = settle(job, SKINS[i]);
    textures.push(id);
  }

  // Four PBS materials, one per skin: diffuse white so the texture is what shows,
  // specular off, roughness 0.5. Slot 0 is the id the loader handed back.
  for (let i = 0; i < CHARACTERS; i++) {
    const material = ogre.Material.pbs(1.0, 1.0, 1.0, 0.5, 0.0);
    material.materialId = <u32>(i + 1);
    material.specularR = 0.0;
    material.specularG = 0.0;
    material.specularB = 0.0;
    material.slot0Resource = textures[i];
    if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused (" + (i + 1).toString() + ")");
  }

  // One directional light: PBS is lit, and an unlit PBS datablock draws black.
  const L = 0.5773502691896258; // one unit of (1, -1, -1) normalised
  const light = ogre.LightRecord.directional(1.0, 1.0, 1.0, 20.0, <f32>L, <f32>-L, <f32>-L);
  light.lightId = 1;
  if (ogre.submitLight(light) != 0) fail("submitLight refused");

  // Four units back on +Z, looking at the origin: at scale 0.29 the characters
  // are 1.09 units tall, well inside the ±1.65 the camera shows at z=0.
  const camera = ogre.CameraRecord.perspective(
    45.0 * (3.14159265358979 / 180.0), <f32>640 / <f32>480, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

  // Four renderables over the one mesh resource, in a 2x2 grid.
  for (let i = 0; i < CHARACTERS; i++) {
    const renderable = ogre.Renderable.at(mesh, <u32>(i + 1), GRID_X[i], GRID_Y, GRID_Z[i], SCALE);
    renderable.renderableId = <u32>(i + 1);
    if (ogre.submitRenderable(renderable) != 0) {
      fail("submitRenderable refused (" + (i + 1).toString() + ")");
    }
  }

  print("clips: " + CLIPS[0] + " " + CLIPS[1] + " " + CLIPS[2] + " " + CLIPS[3] +
        " (" + DURATIONS[0].toString() + "s, " + DURATIONS[1].toString() + "s, " +
        DURATIONS[2].toString() + "s, fourth offset +" + OFFSETS[3].toString() + "s)");

  // The loop. The guest owns the clock: one tick of 1/60 s per iteration, and
  // each character's time is `elapsed % its duration` — the clip loops because
  // the caller wraps it, not because the adapter knows the duration.
  let elapsed: f64 = 0.0;
  let frames = 0;
  let mid_frame: ArrayBuffer | null = null;
  for (frames = 0; frames < FRAMES; frames++) {
    elapsed += 1.0 / 60.0;
    for (let i = 0; i < CHARACTERS; i++) {
      const at = (elapsed + OFFSETS[i]) % DURATIONS[i];
      // The wrap is floating point: when the accumulated time lands a hair
      // past a duration boundary, `%` gives a hair *past zero*, and the
      // millisecond truncation makes it 0 — the one time the verb refuses
      // (`0 ms` is not distinguishable from "no time given"; the clip's start
      // is 1 ms). Measured: four refusals in a 300-frame run before this.
      let ms: i32 = <i32>(at * 1000.0);
      if (ms <= 0) ms = 1;
      const accepted = ogre.submitAnimation(<i32>(i + 1), CLIPS[i], ms);
      if (accepted != 0) fail("submitAnimation refused (" + accepted.toString() + " at character " +
                              (i + 1).toString() + ")");
    }
    RuntimeSession.wait(16);
    // Halfway through, a second frame is kept: the last one is compared
    // against it below, and the difference is the animation.
    if (windowed && frames == FRAMES / 2) mid_frame = grab();
  }

  // The readback, where there is a framebuffer to read: four characters, three
  // clips, one mesh, four skins — and the count says they were drawn.
  if (windowed) {
    const frame = grab();
    if (frame == null) {
      fail("no frame could be downloaded");
    }
    print("rendered " + foreground_count(frame!).toString() + " non-background pixels");
    // The four characters are in the four screen quadrants (the back row
    // projects higher and the front row lower at this camera), so a per-
    // quadrant count and mean colour is a self-check that all four are drawn
    // and that they are wearing different skins — the two things a screenshot
    // is looked at for.
    print(quadrant_report(frame!));
    if (mid_frame != null) {
      const moved = changed_count(mid_frame!, frame!);
      print("motion: " + moved.toString() + " pixels changed between frame " +
            (FRAMES / 2).toString() + " and " + frames.toString());
      assert(moved > 0.0, "no pixel changed between the two frames: the clips did not move the rig");
    }
  }

  print("animated 4 characters, 3 clips, " + frames.toString() + " frames");
  print("done: 4 characters, one mesh, four skins, three clips");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
