// Four characters, one mesh, four skins, three clips — animated **by the
// guest**. The clips ship as ozz archives (`resources/models/*.ozz`); the guest
// reads them through `tension::res` at startup, samples each character's clip
// every frame with the framework's evaluator, turns the pose into model-space
// matrices with `localToModel`, and submits them through
// `submit_skin_matrices`. The matrices carry the whole chain the base path
// would have applied — `world × model × bind⁻¹`, at rest the world transform
// alone — because the piece's overwrite lands where `worldPos` already is:
// **world space** (the template applies `worldMat` before the custom piece and
// `viewProj` after it). OGRE's own `SkeletonInstance` no longer drives the
// pose, and the adapter's animation verb is not called at all (it stays, for
// guests that want it).
//
// The four renderables share **one** mesh resource and differ in two ways: the
// material (each has its own PBS datablock, textured with one of the pack's
// four skins through `slot0`) and the clip. Characters 2 and 4 both run, half
// a cycle apart, so the same clip reads differently twice in one frame.
//
//   ./run.sh                             a window, a screenshot, a summary
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed

// The session: the loop, the arena, the event ring, the frame handshake.
import {
  Animation,
  AnimationIndex,
  BoneTransform,
  ConfigBuilder,
  RuntimeSession,
  Skeleton,
  arg,
  argCount,
  identityPose,
  indexAnimation,
  localToModel,
  makeCallbacks,
  mat4Multiply,
  print,
  resReadFile,
  restPose,
  sample,
} from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

/** The character is 3.765 units tall at scale 1; 0.29 makes it 1.09. */
const SCALE: f32 = 0.29;
const FRAMES = 300; // ~5 seconds at 60 Hz
const MESH = "resources/models/characterMedium.mesh"; // its skeleton ships beside it; the pose comes from the .ozz archives

/// The four skins, in the order the four characters stand.
const SKINS: string[] = [
  "resources/textures/humanMaleA.dds",
  "resources/textures/humanFemaleA.dds",
  "resources/textures/zombieMaleA.dds",
  "resources/textures/zombieFemaleA.dds",
];
/// The clip archives, one per clip: the loader reads
/// `models/characterMedium_<name>.ozz` for each of them.
const CLIP_NAMES: string[] = ["idle", "run", "jump"];
/// Which clip each of the four characters plays (the fourth runs, like the
/// second).
const CLIP_INDEX: i32[] = [0, 1, 2, 1];
/// The fourth runner starts half a cycle behind the second: same clip, visibly
/// out of phase — 0.35416667 s is half of Run's 0.7083333 s.
const CLIP_OFFSETS: f32[] = [0.0, 0.0, 0.0, 0.35416667];
const CHARACTERS = 4;

/// The 2x2 grid: two columns, two rows (the front row is nearer the camera).
/// The characters are 1.05 units wide at this scale, so ±0.62 leaves a gap.
const GRID_X: f32[] = [-0.62, 0.62, -0.62, 0.62];
const GRID_Z: f32[] = [-0.45, -0.45, 0.55, 0.55];
/// The mesh origin is at the feet, so every character shifts down to sit in the
/// middle of the frame (the same -0.55 the previous single-character version used).
const GRID_Y: f32 = -0.55;

const WINDOWED_RENDERER = "gl3plus";

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

/// Per-character patch means, and the largest pairwise |dR| + |dG| + |dB|
/// between them — the "are these characters wearing different skins" test.
///
/// One character stands in each screen quadrant and each wears a different
/// skin, all under the same light. At a sane exposure a textured render gives
/// four measurably different patches (the skins' atlas means differ by >= 10 on
/// at least one channel pair); an untextured render draws the datablock's
/// white, a saturated one clips every skin to white, and a failed one draws
/// black — all three give pairwise ~ 0 and fail.
///
/// This replaced round 14a's whole-quadrant `|R-B| > 8` test (round 14d). That
/// one measured the captured animation phase and the light's saturation rather
/// than the surface: it passed on one phase and failed on another with the same
/// binary. A patch at the centroid of a quadrant does not have that problem —
/// it is a colour comparison between characters in the *same* frame, so phase
/// and exposure cancel between them.
function character_patch_spread(frame: ArrayBuffer, label: string): f64 {
  const pixels = Uint8Array.wrap(frame);
  const bg0 = pixels[0], bg1 = pixels[1], bg2 = pixels[2];
  const width = 640, height = 480;
  const counts = new Float64Array(4);
  const cx = new Float64Array(4);
  const cy = new Float64Array(4);
  for (let y: i32 = 0; y < height; y++) {
    for (let x: i32 = 0; x < width; x++) {
      const at: i32 = (y * width + x) * 4;
      if (abs(<i32>pixels[at] - <i32>bg0) <= 8 && abs(<i32>pixels[at + 1] - <i32>bg1) <= 8 &&
          abs(<i32>pixels[at + 2] - <i32>bg2) <= 8) {
        continue;
      }
      const quadrant = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
      counts[quadrant] += 1;
      cx[quadrant] += <f64>x;
      cy[quadrant] += <f64>y;
    }
  }
  // A 16x16 patch at each character's centroid, clamped to the frame.
  const patch = new Float64Array(12);
  let line = label + " character patches (back-left, back-right, front-left, front-right):";
  for (let q: i32 = 0; q < 4; q++) {
    if (counts[q] == 0) {
      line += " q" + q.toString() + "=none";
      continue;
    }
    const px: i32 = <i32>(cx[q] / counts[q]) - 8;
    const py: i32 = <i32>(cy[q] / counts[q]) - 8;
    let n: f64 = 0;
    for (let dy: i32 = 0; dy < 16; dy++) {
      for (let dx: i32 = 0; dx < 16; dx++) {
        const x = px + dx, y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const at: i32 = (y * width + x) * 4;
        patch[q * 3] += <f64>pixels[at];
        patch[q * 3 + 1] += <f64>pixels[at + 1];
        patch[q * 3 + 2] += <f64>pixels[at + 2];
        n += 1;
      }
    }
    if (n > 0) {
      patch[q * 3] /= n;
      patch[q * 3 + 1] /= n;
      patch[q * 3 + 2] /= n;
    }
    line += " q" + q.toString() + "=" + patch[q * 3].toString() + "/" +
            patch[q * 3 + 1].toString() + "/" + patch[q * 3 + 2].toString();
  }
  print(line);
  let spread: f64 = 0.0;
  for (let a: i32 = 0; a < 4; a++) {
    for (let b: i32 = a + 1; b < 4; b++) {
      const d = abs(patch[a * 3] - patch[b * 3]) + abs(patch[a * 3 + 1] - patch[b * 3 + 1]) +
                abs(patch[a * 3 + 2] - patch[b * 3 + 2]);
      if (d > spread) spread = d;
    }
  }
  return spread;
}

/// The parser takes `StaticArray<u8>`; `resReadFile` hands out `Uint8Array`.
/// One copy, deliberately — no pointer games in an example.
function asStatic(bytes: Uint8Array): StaticArray<u8> {
  const out = new StaticArray<u8>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}

/// The inverse of a column-major affine 4x4 (rotation/scale + translation) —
/// the shape `localToModel` produces. `false` when the linear part is
/// singular (a rig with a zero scale somewhere).
function mat4AffineInverseInto(src: Float32Array, src_at: i32, dst: Float32Array,
                               dst_at: i32): bool {
  const m0 = src[src_at + 0], m1 = src[src_at + 1], m2 = src[src_at + 2];
  const m4 = src[src_at + 4], m5 = src[src_at + 5], m6 = src[src_at + 6];
  const m8 = src[src_at + 8], m9 = src[src_at + 9], m10 = src[src_at + 10];
  const det = m0 * (m5 * m10 - m9 * m6) - m4 * (m1 * m10 - m9 * m2) +
              m8 * (m1 * m6 - m5 * m2);
  if (abs(det) < 1e-12) return false;
  const inv: f32 = <f32>1.0 / det;
  const b00: f32 = (m5 * m10 - m9 * m6) * inv;
  const b01: f32 = (m8 * m6 - m4 * m10) * inv;
  const b02: f32 = (m4 * m9 - m8 * m5) * inv;
  const b10: f32 = (m9 * m2 - m1 * m10) * inv;
  const b11: f32 = (m0 * m10 - m8 * m2) * inv;
  const b12: f32 = (m8 * m1 - m0 * m9) * inv;
  const b20: f32 = (m1 * m6 - m5 * m2) * inv;
  const b21: f32 = (m4 * m2 - m0 * m6) * inv;
  const b22: f32 = (m0 * m5 - m4 * m1) * inv;
  const tx = src[src_at + 12], ty = src[src_at + 13], tz = src[src_at + 14];
  dst[dst_at + 0] = b00;
  dst[dst_at + 1] = b10;
  dst[dst_at + 2] = b20;
  dst[dst_at + 3] = 0.0;
  dst[dst_at + 4] = b01;
  dst[dst_at + 5] = b11;
  dst[dst_at + 6] = b21;
  dst[dst_at + 7] = 0.0;
  dst[dst_at + 8] = b02;
  dst[dst_at + 9] = b12;
  dst[dst_at + 10] = b22;
  dst[dst_at + 11] = 0.0;
  dst[dst_at + 12] = -(b00 * tx + b01 * ty + b02 * tz);
  dst[dst_at + 13] = -(b10 * tx + b11 * ty + b12 * tz);
  dst[dst_at + 14] = -(b20 * tx + b21 * ty + b22 * tz);
  dst[dst_at + 15] = 1.0;
  return true;
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
  private frames: i32 = 0; // how many frames the clip loop ran
  private midFrame: ArrayBuffer | null = null; // the frame kept halfway through the run
  private skeleton: Skeleton = new Skeleton();
  private animations: Animation[] = [];
  private indices: AnimationIndex[] = [];
  /// Each joint's bind matrix, inverted once: the shader's matrices are
  /// bind-relative, so every frame multiplies the model pose by this.
  private bind_inverse: Float32Array = new Float32Array(0);

  constructor(options: Options) {
    this.options = options;
  }

  /// Open the session and the renderer, mount the volume, load the mesh and
  /// submit the scene, play the clips, then read the frames back.
  run(): void {
    this.openSession();
    this.openRenderer();
    this.mountAssets();
    this.loadClips();
    const mesh = this.loadMesh(MESH);
    this.submitScene(mesh);
    this.animate();
    this.captureFrame();

    print("animated 4 characters, 3 clips, " + this.frames.toString() + " frames");
    print("done: 4 characters, one mesh, four skins, three clips");
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

  /// Mount the packed volume the assets were shipped in.
  private mountAssets(): void {
    // Everything this example loads comes out of one packed volume (chunk 11):
    // the assets live in `resources/`, `pack.sh` packs them, and the run script
    // hands the absolute path in as `--tns=`. No mount, no bytes — there is no
    // fallback to the disk.
    if (this.options.tns.length == 0) {
      fail("no --tns=<volume> argument (the assets are packed; run via ./run.sh)");
    }
    const mounted = ogre.mountTns("resources", this.options.tns);
    if (mounted != 0) fail("mountTns refused (" + mounted.toString() + ")");
  }

  /// The animation archives: the skeleton and the three clips, read through
  /// `tension::res` — the `--res` pak the run script passes — and parsed by
  /// the framework's own reader. `resReadFile` does **not** see the OGRE
  /// mount (`--tns` feeds the adapter's loader, a separate table), which is
  /// why the launcher gives the same volume to both flags.
  private loadClips(): void {
    const skeleton_bytes = resReadFile("models/characterMedium_skeleton.ozz");
    if (skeleton_bytes == null) {
      fail("resReadFile refused the skeleton archive (does ./run.sh pass --res?)");
    }
    this.skeleton = Skeleton.parse(asStatic(skeleton_bytes!));
    if (this.skeleton.error.length > 0) fail("the skeleton archive: " + this.skeleton.error);
    if (this.skeleton.jointCount != 58) {
      fail("the skeleton has " + this.skeleton.jointCount.toString() +
           " joints, not the rig's 58");
    }
    for (let i = 0; i < CLIP_NAMES.length; i++) {
      const path = "models/characterMedium_" + CLIP_NAMES[i] + ".ozz";
      const bytes = resReadFile(path);
      if (bytes == null) fail("resReadFile refused " + path);
      const animation = Animation.parse(asStatic(bytes!));
      if (animation.error.length > 0) fail(path + ": " + animation.error);
      if (animation.trackCount != 58) {
        fail(path + " has " + animation.trackCount.toString() + " tracks, not 58");
      }
      this.animations.push(animation);
      this.indices.push(indexAnimation(animation));
    }

    // The bind, once. The shader's matrices are **bind-relative** (at rest
    // they are identity — the fixture path's proven contract), the mesh is
    // skinned against the skeleton's rest pose, and `localToModel(rest)` is
    // that bind, so each joint's frame matrix will be `model × bind⁻¹`.
    const bind = localToModel(this.skeleton, restPose(this.skeleton));
    this.bind_inverse = new Float32Array(bind.length);
    for (let j = 0; j < this.skeleton.jointCount; j++) {
      if (!mat4AffineInverseInto(bind, j * 16, this.bind_inverse, j * 16)) {
        fail("joint " + j.toString() + "'s bind matrix is singular");
      }
    }
  }

  /// One mesh, and the skeleton that ships beside it. The rig still matters —
  /// it is what makes the mesh skinnable and what the base fill streams — but
  /// the **pose** is no longer OGRE's: the .ozz archives drive it now.
  private loadMesh(path: string): i32 {
    const mesh_job = ogre.queueMeshLoad(path, 0);
    if (mesh_job <= 0) fail("queueMeshLoad refused (" + mesh_job.toString() + ")");
    const mesh = settle(mesh_job, path);
    if (!ogre.isRigged(mesh)) fail(path + " came back without a rig");
    return mesh;
  }

  /// Four skins, four materials, one light, one camera, four renderables: the
  /// whole scene, submitted once.
  submitScene(mesh: i32): void {
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
    // The intensity is a power scale, so it is the whole exposure: 20.0 blew the
    // lit facets out to white and flattened the skins' hue. Round 14d lowered it
    // until no character saturates at any captured phase (the measured means are
    // in the round's report).
    const L = 0.5773502691896258; // one unit of (1, -1, -1) normalised
    const light = ogre.LightRecord.directional(1.0, 1.0, 1.0, 1.5, <f32>L, <f32>-L, <f32>-L);
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
  }

  /// The loop. The guest owns the clock and the pose: one tick of 1/60 s per
  /// iteration, each character's time wrapped into its clip, and the pose
  /// sampled and turned into model-space matrices here — the adapter only
  /// forwards them. Everything the loop uses is allocated once, before it.
  private animate(): void {
    print("clips: " + CLIP_NAMES[CLIP_INDEX[0]] + " " + CLIP_NAMES[CLIP_INDEX[1]] + " " +
          CLIP_NAMES[CLIP_INDEX[2]] + " " + CLIP_NAMES[CLIP_INDEX[3]] + " (" +
          this.animations[CLIP_INDEX[0]].duration.toString() + "s, " +
          this.animations[CLIP_INDEX[1]].duration.toString() + "s, " +
          this.animations[CLIP_INDEX[2]].duration.toString() + "s, fourth offset +" +
          CLIP_OFFSETS[3].toString() + "s)");

    // Per-character buffers, allocated once: a pose the sampler writes into,
    // a scratch for the frame's model matrices, the bind-relative block the
    // shader consumes, and one batch the four renderables share every frame
    // (`commit` resets its cursor, so the batch is the frame's scratch, not
    // one object per submit).
    const poses: BoneTransform[][] = [];
    const models: Float32Array[] = [];
    const placed: Float32Array[] = [];
    const matrices: Float32Array[] = [];
    for (let i = 0; i < CHARACTERS; i++) {
      poses.push(identityPose(this.animations[CLIP_INDEX[i]].slots));
      models.push(new Float32Array(this.skeleton.jointCount * 16));
      placed.push(new Float32Array(this.skeleton.jointCount * 16));
      matrices.push(new Float32Array(this.skeleton.jointCount * 16));
    }
    // The node's world matrix, constant per character. The shader piece's
    // overwrite lands where `worldPos` already is — **world space** (the
    // template transforms by `worldMat` before the custom piece and by
    // `viewProj` after it) — so the submitted matrices carry the node transform
    // the base path would have applied: world × model × bind⁻¹.
    const worlds: Float32Array[] = [];
    for (let i = 0; i < CHARACTERS; i++) {
      const world = new Float32Array(16);
      world[0] = SCALE;
      world[5] = SCALE;
      world[10] = SCALE;
      world[15] = 1.0;
      world[12] = GRID_X[i];
      world[13] = GRID_Y;
      world[14] = GRID_Z[i];
      worlds.push(world);
    }
    const batch = new ogre.SkinMatrixBatch();

    let frames = 0;
    let mid_frame: ArrayBuffer | null = null;
    for (frames = 0; frames < FRAMES; frames++) {
      const now: f32 = <f32>frames / 60.0;
      for (let i = 0; i < CHARACTERS; i++) {
        const clip = this.animations[CLIP_INDEX[i]];
        let t: f32 = now + CLIP_OFFSETS[i];
        while (t >= clip.duration) t -= clip.duration;
        const pose = sample(clip, this.indices[CLIP_INDEX[i]], t, poses[i]);
        const model = localToModel(this.skeleton, pose, models[i]);
        const skin = matrices[i];
        // The submitted matrices carry the whole chain the base path would
        // have applied: world × model × bind⁻¹ (two multiplies per joint —
        // `placed` exists because the module's mat4Multiply may not alias its
        // output).
        for (let j = 0; j < this.skeleton.jointCount; j++) {
          mat4Multiply(worlds[i], model, placed[i], 0, j * 16, j * 16);
          mat4Multiply(placed[i], this.bind_inverse, skin, j * 16, j * 16, j * 16);
        }
        if (!batch.set(<u32>i, <u32>(i + 1), skin)) {
          fail("the matrix batch refused character " + (i + 1).toString());
        }
      }
      if (batch.commit() != CHARACTERS) fail("submit_skin_matrices refused the batch");
      RuntimeSession.wait(16);
      // Halfway through, a second frame is kept: the last one is compared
      // against it below, and the difference is the animation.
      if (this.options.windowed && frames == FRAMES / 2) mid_frame = grab();
    }
    this.frames = frames;
    this.midFrame = mid_frame;
  }

  /// The readback, where there is a framebuffer to read: four characters, three
  /// clips, one mesh, four skins — and the count says they were drawn.
  private captureFrame(): void {
    if (!this.options.windowed) return;
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
    this.assertSkinsDiffer(frame!, "frame " + this.frames.toString());
    if (this.midFrame != null) {
      // The same comparison at the other captured phase (frame FRAMES/2),
      // printed but not asserted: it is the evidence that the guard's value is
      // a property of the four characters, not of the pose the frame caught.
      const mid_spread = character_patch_spread(this.midFrame!, "frame " + (FRAMES / 2).toString());
      print("character patch spread at frame " + (FRAMES / 2).toString() + " = " +
            mid_spread.toString());
      const moved = changed_count(this.midFrame!, frame!);
      print("motion: " + moved.toString() + " pixels changed between frame " +
            (FRAMES / 2).toString() + " and " + this.frames.toString());
      assert(moved > 0.0, "no pixel changed between the two frames: the clips did not move the rig");
    }
  }

  /// The four characters must show measurably different surface hues: four
  /// skins, one light, one frame. This is measured at a fixed index — the
  /// final frame of the run, the same one the motion check below ends on.
  private assertSkinsDiffer(frame: ArrayBuffer, label: string): void {
    const patch_spread = character_patch_spread(frame, label);
    print("character patch spread (max pairwise |dR|+|dG|+|dB|) = " + patch_spread.toString());
    assert(patch_spread > 9.0, "the four characters do not show different skins");
  }

  /// Bring the renderer and the session down.
  shutdown(): void {
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function _start_game(): void {
  const game = new Game(parseArgs());
  game.run();
  game.shutdown();
}
