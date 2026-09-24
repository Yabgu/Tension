// A stickman walking: a rigged mesh, a solver for the cadence, one bone posed
// per frame.
//
// The chain: the guest owns a phase, the solver integrates it, the guest turns
// the phase into a bone rotation, and the renderer draws it — through the bone
// table, one call per frame rather than one call per bone, exactly as
// `bouncing-ball` drives the motion table.
//
// Two things about this example are load-bearing and are not obvious:
//
//   * **the material must be PBS.** HlmsUnlit has no skeletal animation in its
//     shaders at all, so an Unlit rig is a mesh that never moves while every
//     bone transform is perfectly correct — the failure chunk 5b's probe was
//     written to find. Until chunk 10 that also meant an *emissive* colour: a
//     PBS material with no light rig shows only what it emits (DESIGN.md §5.1).
//     Now there is a light, so the body carries a real diffuse and the stickman
//     acquires a lit side and a dark side as he walks.
//   * **a bone is named by index.** The guest has no bone-name lookup (the
//     rig lives in the renderer), so the index below is the one the probe's
//     per-bone sweep measured — see `ARM_BONE`.
//
//   ./run.sh                             a window, and a walking stickman
//   TENSION_OGRE_HEADLESS=1 ./run.sh     structural only: no display needed

// The session: the loop, the arena, the event ring, the frame handshake.
import {
  ConfigBuilder, Solver, SolverConfig, arg, argCount, makeCallbacks, print, RuntimeSession,
} from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";

const TAU = 6.283185307179586; // radians in one cycle: one step per second
const STEP: f64 = 1.0 / 60.0; // one solver step per rendered frame
/** The probe's scale for this mesh: 1574 non-background pixels at 320x240. */
const SCALE: f32 = 0.6;
/** The swing's amplitude, either side of the rest pose. */
const SWING = 0.4;
/**
 * `Arm_L`, **by index** — 9, measured by chunk 5b's per-bone sweep at scale
 * 0.6: rotating it 90° flips 0.03230 of the frame, where `Hand_IK_L` (index 0)
 * flips 0.00000 and `Spine` (6, the clearest) flips 0.03557.
 *
 * The guest cannot look a bone up by name — the skeleton belongs to the
 * renderer — so an index is what the guest has, and this one is the probe's.
 * `Arm_R` is not posed here for a reason worth knowing: the sweep covered the
 * rig's first ten bones, and `Arm_R` is past that, so posing it would be
 * guessing at an index. Extending the sweep is the small round that would
 * give this example two arms instead of one.
 */
const ARM_BONE: u32 = 9;
const HERO = 1; // the renderable id the bone table names
const FRAMES = 300; // give up after this many frames
const CYCLES = 3; // ... or after this many steps
const MESH = "resources/models/Stickman.mesh"; // its skeleton, `Stickman.skeleton`, ships beside it

// The solver's two callback buffers: 64 KiB each in the guest's own memory, the
// addresses the host writes and reads through (tension-solver/GUEST_ABI.md §3.6).
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);
export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

/// f(t, y) = [2π]: the phase advances one full cycle per second, which is the
/// cadence. The solver integrates it; the guest only reads the angle back out.
export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (dyCap < len) return -22; // -EINVAL; the host always calls with dim == dyCap
  store<f64>(dyPtr, TAU);
  return 0;
}

/// A failure the reader can act on: a guest exits non-zero by trapping.
function fail(what: string): void {
  print("walking-stickman: " + what);
  assert(false, what);
}

export function _start_game(): void {
  let renderer = "null";
  let tns = "";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const windowed = renderer == "gl3plus";

  // Same setup as the other examples: session, mesh, material, camera.
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


  // The rig is a file, and its skeleton is a second file the loader resolves by
  // name — which is why this example needs the models directory the adapter
  // reads from `resources2.cfg`.
  const job = ogre.queueMeshLoad(MESH, 0);
  if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");
  while (ogre.jobState(job) != ogre.JOB_DONE && ogre.jobState(job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) fail(MESH + " did not load");
  const mesh = ogre.jobResult(job);
  // The record is the truth about the rig — the loader wrote it when the v1 ->
  // v2 conversion told it whether a skeleton survived.
  if (!ogre.isRigged(mesh)) fail(MESH + " came back without a rig");
  const bones = ogre.boneCount(mesh);
  if (ARM_BONE >= bones) fail("the rig has " + bones.toString() + " bones, not " + ARM_BONE.toString());

  // Lit PBS: a real diffuse and specular with a zero emissive, shaded by the
  // directional light below. Only a PBS material can skin a mesh at all, and
  // only a lit one shows a lit side — the emissive-only shape this example
  // shipped with is now the *regression* clause (chunk 10's fixture keeps an
  // emissive-only surface in the same frame as a control).
  const material = new ogre.Material();
  material.materialId = 1;
  material.kind = ogre.MAT_HLMS_PBS;
  material.diffuseR = 0.8; material.diffuseG = 0.5; material.diffuseB = 0.3;
  material.specularR = 0.5; material.specularG = 0.5; material.specularB = 0.5;
  material.emissiveR = 0.0; material.emissiveG = 0.0; material.emissiveB = 0.0;
  material.roughness = 0.5; material.metalness = 0.0;
  if (ogre.submitMaterial(material) != 0) fail("submitMaterial refused");

  // The light: white, from the camera's upper left, so the viewer sees both a
  // lit side and a dark one — a light on the camera's own axis would light
  // everything the viewer can see and hide the shading entirely (measured
  // during chunk 10's fixture work: a light 54.7° off the view axis leaves the
  // "dark" half at 133/255). The direction is the way the light *travels*:
  // (+x, -y, -z) is down, to the right of the screen and away from the camera,
  // which is a source up, to the left and in front. Intensity 20 and not 1:
  // `intensity` is a power scale, and a lit surface at 1.0 measures 26/255 —
  // lit, and visually black (DESIGN.md §5.1).
  const light = new ogre.LightRecord();
  light.lightId = 1;
  light.kind = ogre.LIGHT_DIRECTIONAL;
  light.colourR = 1.0; light.colourG = 1.0; light.colourB = 1.0;
  light.intensity = 20.0;
  const L = 0.5773502691896258; // one unit of (1, -1, -1) normalised
  light.directionX = <f32>L; light.directionY = <f32>-L; light.directionZ = <f32>-L;
  if (ogre.submitLight(light) != 0) fail("submitLight refused");

  // Four units back on +Z, looking at the origin: the stickman is 1.9 units
  // tall at scale 1, so 0.6 puts all of him in the frame with room to swing.
  const camera = ogre.CameraRecord.perspective(
    45.0 * (3.14159265358979 / 180.0), <f32>640 / <f32>480, 0.1, 100.0, 0.0, 0.0, 4.0);
  camera.cameraId = 1;
  if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

  // His origin is at his feet, so the model needs shifting *down* to sit in the
  // middle of the frame: at scale 0.6 he is 1.1 units tall, and the camera
  // shows ±1.65 at z=0. The fourth argument is the scale — the probe's 0.6,
  // which is what puts a measurable silhouette in a 320x240 frame too.
  const renderable = ogre.Renderable.at(mesh, 1, 0.0, -0.55, 0.0, SCALE);
  renderable.renderableId = HERO;
  if (ogre.submitRenderable(renderable) != 0) fail("submitRenderable refused");

  // The cadence is the guest's derivative and the solver's integral: one
  // dimension, one number out. The rest of the walk is game logic reading it.
  const solver_config = new SolverConfig();
  solver_config.method = "rk45";
  solver_config.source = "wasm";
  solver_config.dim = 1;
  solver_config.relTol = 1e-8; solver_config.absTol = 1e-10;
  const solver = Solver.create(solver_config, {
    derivative: _derivative, bufIn: deriv_buf_in, bufOut: deriv_buf_out,
  });
  if (solver == null) fail("Solver.create refused the config");

  const state = new Float64Array(2); // [t, phase]
  if (solver!.setState(0.0, state.subarray(1)) != 0) fail("setState refused the seed");
  if (!windowed) print("renderer=null: no window; the pose and the summary are the same");

  // One solver step, one batch commit, one frame — the shape every animated
  // guest has.
  const batch = new ogre.BoneBatch();
  let last = ogre.frameCount(), first = last, steps = 0;
  while (ogre.frameCount() < first + FRAMES && steps < CYCLES) {
    RuntimeSession.wait(16);
    const now = ogre.frameCount();
    const advance = now - last;
    if (advance == 0) continue; // the renderer has not drawn a new frame yet
    last = now;

    if (solver!.step(<f64>advance * STEP) != 0) fail("solver step failed");
    if (solver!.state(state) < 0) fail("solver state failed");
    const phase = state[1];

    // The pose. `sin(phase) * 0.4` is a swing about X, which is the axis the
    // stickman's arms hang on; a bone's transform is *local* to its parent, so
    // this rotates the arm without touching anything above or below it in the
    // rig. A batch entry is a whole transform, so the rotation is the whole of
    // what this line sends.
    const swing = <f32>(Math.sin(phase) * SWING);
    batch.setRotation(0, HERO, ARM_BONE, 1.0, 0.0, 0.0, swing);
    // The count is the accepted shape: a batch returns how many entries the
    // adapter took, so 1 is success and 0 is a refusal (a refused verb writes
    // nothing into the guest's return slot — the errno goes to the session log).
    if (batch.commit() != 1) fail("submit_bones refused the batch");

    // Printed a quarter of a cycle apart, so the samples show the swing's whole
    // range (±0.4) rather than landing on the same two phases every time — at
    // 30 frames, which is half a cycle here, every line would read the same
    // pair of numbers.
    if (now % 15 == 0) {
      print("frame " + now.toString() + "  phase " + phase.toString() + "  swing " +
            swing.toString());
    }
    const cycles = <i32>(phase / TAU);
    if (cycles > steps) steps = cycles;
  }

  print("stickman took " + steps.toString() + " steps");
  ogre.shutdown(); RuntimeSession.close();
}
