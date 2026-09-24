// The lighting acid test (chunk 10, round 10b).
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-light.wasm --renderer=gl3plus
//
// Three curved surfaces in one frame under one directional light — a *lit* PBS
// barrel (diffuse, specular, zero emissive), an **emissive-only** PBS barrel and
// an **Unlit** barrel — and then the questions chunk 5b's "PBS renders black"
// workaround never asked:
//
//   1. the wire offsets, the session, the renderer and the meshes load (Barrel
//      for the shading, the character for the skinned clause)
//   2. the scene is accepted: three materials, one camera, three renderables
//   3. the light is mirrored — `submitLight` returns 0, the region's slot holds
//      kind `LIGHT_DIRECTIONAL`, the colour, the intensity and the direction —
//      and a second submit of the same id replaces the record (an upsert)
//   4. thirty frames run with the light in the scene, and the light is still
//      mirrored when they are done
//
// and, under a renderer with a framebuffer (GL3+):
//
//   5. **the lit surface is lit**: its pixels split by the screen-space
//      projection of the light direction give a lit half measurably brighter
//      than the dark half, with a mid band strictly between them, and both
//      halves carrying pixels (dark is not not-drawn)
//   6. the light is what does it: with the light removed the lit surface's
//      region goes black, and re-submitting it brings the shading back
//   7. the **emissive-only** PBS surface's region is byte-identical with and
//      without the light — the regression clause walking-stickman and the
//      angular bouncing-bodies built their look on
//   8. the **Unlit** surface's region is byte-identical with and without the
//      light — a light must not reach a material that never asked for one
//   9. the **skinned** path shades: the rigged character under a lit PBS datablock
//      turns a lit/dark profile of its own
//
// Measured, GL3+, 320x240, this configuration: the lit half's mean is **255.0**
// over 914 px and the dark half's is **0.0** over 914 px — the dark half of a
// side-lit surface with no ambient is *pure black*, and the lit half saturates
// at intensity 20, because 0.9 diffuse times a power scale of 20 clips wherever
// the surface faces the light. The probe's own sphere (0.8 diffuse, off-axis)
// read lit 217.58 / dark 39.90; the difference is the material and the framing,
// and the profile below is the part both share. So the clause is not a ratio
// alone — `lit ≥ 4 × dark + 20` would be satisfied by a black frame on a pure
// ratio, and a *saturated* lit half would hide a hard edge — but a ratio **and**
// a mid band strictly between the two, and the ten-band profile, whose
// intermediate bands (0.13 then 136.44) are what say the transition is a
// falloff rather than a step. The band profile also shows the barrel's own
// silhouette: the outermost bands are empty on both ends, so the split is
// measured on the shape that is drawn.
//
// The background is the workspace's clear colour, 0.1 grey ≈ 26/255: a *grey*
// background rather than black is what makes a black unlit hemisphere
// countable, which is the trap the probe's own `is_background` names.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import {
  CameraRecord, LightRecord, Material, Renderable, assertOgreWireOffsets,
} from "../../tension-framework/assembly/ogre/wire";
import { regionOffset } from "../../tension-framework/assembly/runtime/arena";
import { REGION_SCENE } from "../../tension-framework/assembly/runtime/wire";

const WINDOW_WIDTH: i32 = 320;
const WINDOW_HEIGHT: i32 = 240;
/** The 10a probe's calibration: (0, 0, 6), 45° vertical, looking down -z. */
const EYE_Z: f64 = 6.0;
const FOV_Y: f64 = 45.0 * (3.14159265358979 / 180.0);
/** Barrel.mesh's bounding radius is 4.8555 (probe, off the v1 side). */
const BARREL_SCALE: f32 = 0.2060;
/**
 * The character at scale 1 is 3.765 units tall (chunk 12a), so 0.583 is 2.2 —
 * the same 2x-the-old-rig sizing that made the retired 1.83-tall figure 106 px
 * at depth 6, and the -1.1 offset below still centres him.
 */
const CHARACTER_SCALE: f32 = 0.583;
/** The three barrel centres: one every 2.4 units, which is 116 px apart. */
const LIT_X: f64 = 0.0;
const EMISSIVE_X: f64 = -2.4;
const UNLIT_X: f64 = 2.4;
const RADIUS: f64 = 1.0; // the barrel, scaled to bounding radius 1
/** The half-width of a comparison rect: the 48 px radius plus its margin. */
const RECT_HALF: i32 = 52;
/** The workspace's clear colour: 0.1 grey, 25 or 26 in 8-bit. */
const BACKGROUND_LEVEL: i32 = 26;
const BACKGROUND_SLACK: i32 = 8;
const FRAMES: i32 = 30;
/** The one handle this fixture names for the region read-back. */
const LIGHT_ID: u32 = 7;
/** The light: white, intensity 20 (see the doc's intensity note). */
const LIGHT_INTENSITY: f32 = 20.0;
/**
 * The direction the light *travels*: straight along -x, so it comes from the
 * right and the lit hemisphere is the right half of the disc. This is the 10a
 * probe's own geometry, chosen for the same reason the probe chose it: a light
 * perpendicular to the view direction puts the terminator *across* the visible
 * disc, so there is a lit hemisphere and a genuinely dark one.
 *
 * The round wrote (-1, -1, -1) here, and it was measured before it was
 * changed: with the light 54.7° off the view axis — coming from the camera's own
 * side — the two screen halves measure 247.08 and 133.32, a ratio of 1.85,
 * because a surface that faces the light also faces a camera on the light's
 * side. That is a gradient, not a hemisphere, and it is a weak thing to write a
 * threshold under. The direction moved; the *result* is the probe's, and the
 * thresholds below are its numbers rather than adjusted ones.
 */
const LIGHT_DIR_X: f32 = -1.0;
const LIGHT_DIR_Y: f32 = 0.0;
const LIGHT_DIR_Z: f32 = 0.0;

// ── the wire's own contract, then the frame's arithmetic ────────────────

let clause = 0;
let total = 0;

function fail(reason: string): void {
  print("ACID " + clause.toString() + "/" + total.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

/// The camera is at (0, 0, 6) with no roll, looking down -z, so a point's
/// projection is arithmetic rather than a matrix: depth is 6 - z, and the
/// pixels per world unit follow from the 45° vertical field of view.
function pixels_per_unit(depth: f64): f64 {
  return (<f64>WINDOW_HEIGHT * 0.5) / (depth * Math.tan(FOV_Y * 0.5));
}

function project_col(x: f64, z: f64): f64 {
  const depth = EYE_Z - z;
  if (depth <= 0.01) return -1.0;
  return <f64>(WINDOW_WIDTH) * 0.5 + x * pixels_per_unit(depth);
}

function project_row(y: f64, z: f64): f64 {
  const depth = EYE_Z - z;
  if (depth <= 0.01) return -1.0;
  return <f64>(WINDOW_HEIGHT) * 0.5 - y * pixels_per_unit(depth);
}

function brightness(pixels: Uint8Array, at: i32): i32 {
  return (<i32>pixels[at] + <i32>pixels[at + 1] + <i32>pixels[at + 2]) / 3;
}

function is_background(pixels: Uint8Array, at: i32): bool {
  const r = <i32>pixels[at], g = <i32>pixels[at + 1], b = <i32>pixels[at + 2];
  return abs(r - BACKGROUND_LEVEL) <= BACKGROUND_SLACK &&
         abs(g - BACKGROUND_LEVEL) <= BACKGROUND_SLACK &&
         abs(b - BACKGROUND_LEVEL) <= BACKGROUND_SLACK;
}

function grab(): ArrayBuffer | null {
  const armed = ogre.frameCount();
  ogre.screenshot(0, 0);
  for (let guard: u32 = 0; guard < 300 && ogre.frameCount() < armed + 3; guard++) {
    RuntimeSession.wait(5);
  }
  const length = ogre.screenshot(0, 0);
  if (length <= 0) return null;
  const frame = new ArrayBuffer(length);
  if (ogre.screenshot(changetype<usize>(frame), length) != length) return null;
  return frame;
}

function settle(extra: i32 = 5): void {
  const from = ogre.frameCount();
  while (<i32>(ogre.frameCount() - from) < extra) RuntimeSession.wait(5);
}

/// The lit and dark halves of an object's pixels, split by the screen-space
/// projection of the light direction rather than by the screen's x-axis: the
/// lit side of the world is wherever `centre + radius · L̂` lands on screen,
/// which is the general case the probe's axis-aligned split assumed away.
class Halves {
  lit_count: i32 = 0;
  dark_count: i32 = 0;
  mid_count: i32 = 0;
  lit_sum: f64 = 0.0;
  dark_sum: f64 = 0.0;
  mid_sum: f64 = 0.0;
  lit_mean: f64 = 0.0;
  dark_mean: f64 = 0.0;
  mid_mean: f64 = 0.0;
  max_pixel: i32 = 0;
  /// Ten bands from the dark end of the axis to the lit end: the probe's own
  /// profile, which is what "a diffuse falloff and not a hard edge" looks like
  /// as numbers.
  profile_sum: Float64Array = new Float64Array(10);
  profile_count: Float64Array = new Float64Array(10);
}

function halves_axis(frame: ArrayBuffer, centre_col: f64, centre_row: f64,
                     axis_x: f64, axis_y: f64, half_extent: f64): Halves {
  const pixels = Uint8Array.wrap(frame);
  const h = new Halves();
  const length = Math.sqrt(axis_x * axis_x + axis_y * axis_y);
  if (length <= 0.0 || half_extent <= 0.0) return h;
  const ax = axis_x / length, ay = axis_y / length;
  for (let row: i32 = 0; row < WINDOW_HEIGHT; row++) {
    for (let col: i32 = 0; col < WINDOW_WIDTH; col++) {
      const at = (row * WINDOW_WIDTH + col) * 4;
      if (is_background(pixels, at)) continue;
      const dcol = (<f64>col + 0.5) - centre_col;
      const drow = (<f64>row + 0.5) - centre_row;
      // Anything this far from the centre is a different object.
      if (Math.abs(dcol) > 60.0 || Math.abs(drow) > 60.0) continue;
      const u = (dcol * ax + drow * ay) / half_extent; // +1 is the lit point
      const value = <f64>brightness(pixels, at);
      if (value > <f64>h.max_pixel) h.max_pixel = <i32>value;
      let band: i32 = <i32>((u + 1.0) * 5.0);
      if (band < 0) band = 0;
      if (band > 9) band = 9;
      h.profile_sum[band] += value;
      h.profile_count[band] += 1.0;
      if (u > 0.25) {
        h.lit_count += 1; h.lit_sum += value;
      } else if (u < -0.25) {
        h.dark_count += 1; h.dark_sum += value;
      } else {
        h.mid_count += 1; h.mid_sum += value;
      }
    }
  }
  h.lit_mean = h.lit_count ? h.lit_sum / <f64>h.lit_count : 0.0;
  h.dark_mean = h.dark_count ? h.dark_sum / <f64>h.dark_count : 0.0;
  h.mid_mean = h.mid_count ? h.mid_sum / <f64>h.mid_count : 0.0;
  return h;
}

/// The halves of an object whose world centre is known: the axis is the
/// screen-space vector from the object's projected centre to the projection of
/// the point on its surface that faces the light, `centre + radius · L̂`.
function halves(frame: ArrayBuffer, wx: f64, wy: f64, wz: f64, radius: f64): Halves {
  const lx = -<f64>LIGHT_DIR_X, ly = -<f64>LIGHT_DIR_Y, lz = -<f64>LIGHT_DIR_Z;
  const centre_col = project_col(wx, wz);
  const centre_row = project_row(wy, wz);
  const lit_col = project_col(wx + radius * lx, wz + radius * lz);
  const lit_row = project_row(wy + radius * ly, wz + radius * lz);
  return halves_axis(frame, centre_col, centre_row, lit_col - centre_col,
                     lit_row - centre_row,
                     Math.sqrt((lit_col - centre_col) * (lit_col - centre_col) +
                               (lit_row - centre_row) * (lit_row - centre_row)));
}

class Region {
  count: i32 = 0;
  sum: f64 = 0.0;
  mean: f64 = 0.0;
}

function region(frame: ArrayBuffer, cx: i32, cy: i32, half: i32): Region {
  const pixels = Uint8Array.wrap(frame);
  const out = new Region();
  for (let row: i32 = cy - half; row <= cy + half; row++) {
    if (row < 0 || row >= WINDOW_HEIGHT) continue;
    for (let col: i32 = cx - half; col <= cx + half; col++) {
      if (col < 0 || col >= WINDOW_WIDTH) continue;
      const at = (row * WINDOW_WIDTH + col) * 4;
      if (is_background(pixels, at)) continue;
      out.count += 1;
      out.sum += <f64>brightness(pixels, at);
    }
  }
  out.mean = out.count ? out.sum / <f64>out.count : 0.0;
  return out;
}

/// Two frames' rects, byte for byte, alpha ignored — the probe's own comparison.
function region_identical(a: ArrayBuffer, b: ArrayBuffer, cx: i32, cy: i32, half: i32): bool {
  const pa = Uint8Array.wrap(a), pb = Uint8Array.wrap(b);
  for (let row: i32 = cy - half; row <= cy + half; row++) {
    if (row < 0 || row >= WINDOW_HEIGHT) continue;
    for (let col: i32 = cx - half; col <= cx + half; col++) {
      if (col < 0 || col >= WINDOW_WIDTH) continue;
      const at = (row * WINDOW_WIDTH + col) * 4;
      for (let c: i32 = 0; c < 3; c++) {
        if (pa[at + c] != pb[at + c]) return false;
      }
    }
  }
  return true;
}

// ── the fixture ─────────────────────────────────────────────────────────

export function _start_game(): void {
  let renderer = "null";
  let tns = "";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const gl3plus = renderer == "gl3plus";
  total = gl3plus ? 9 : 4;

  clause = 0; // the wire's own contract, before anything runs
  assertOgreWireOffsets();

  const callbacks = makeCallbacks(null, null);
  assert(RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) == 0,
         "session_open refused");
  const config = new ogre.ConfigBuilder()
    .renderer(gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
    .headless(!gl3plus).vsync(false).frameHz(60).windowSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  assert(ogre.init(config) == 0, "ogre::init refused");
  // Everything this fixture loads comes out of one packed volume (chunk 11):
  // tests/resources is packed into build/fixtures.tns and the runner hands the
  // path in as `--tns=`. No mount, no bytes — the fixtures are migrated, not
  // grandfathered.
  assert(tns.length > 0, "no --tns=<volume> argument (run through tests/run.sh)");
  assert(ogre.mountTns("resources", tns) == 0, "mountTns refused");
  ogre.assertSubmissionRegions();

  // ── clause 1: the meshes ─────────────────────────────────────────────
  clause = 1;
  const barrel_job = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  check(barrel_job > 0, "queueMeshLoad refused (Barrel.mesh)");
  while (ogre.jobState(barrel_job) != ogre.JOB_DONE &&
         ogre.jobState(barrel_job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  check(ogre.jobState(barrel_job) == ogre.JOB_DONE, "Barrel.mesh did not load");
  const barrel = ogre.jobResult(barrel_job);
  // The skinned clause's mesh: a rig, resolved by the loader's skeleton path.
  const character_job = ogre.queueMeshLoad("resources/meshes/characterMedium.mesh", 0);
  check(character_job > 0, "queueMeshLoad refused (characterMedium.mesh)");
  while (ogre.jobState(character_job) != ogre.JOB_DONE &&
         ogre.jobState(character_job) != ogre.JOB_FAILED) {
    RuntimeSession.wait(10);
  }
  check(ogre.jobState(character_job) == ogre.JOB_DONE, "characterMedium.mesh did not load");
  const character = ogre.jobResult(character_job);
  check(ogre.isRigged(character), "characterMedium.mesh came back without a rig");
  print("1 ok: Barrel.mesh and characterMedium.mesh loaded through the job queue");

  // ── clause 2: the scene ──────────────────────────────────────────────
  clause = 2;
  // The lit material: diffuse and specular written, emissive zero — the shape
  // the "PBS renders black" workaround avoided, and the one this round is about.
  const lit_material = new Material();
  lit_material.materialId = 1;
  lit_material.kind = ogre.MAT_HLMS_PBS;
  lit_material.diffuseR = 0.9; lit_material.diffuseG = 0.2; lit_material.diffuseB = 0.2;
  lit_material.specularR = 0.5; lit_material.specularG = 0.5; lit_material.specularB = 0.5;
  lit_material.emissiveR = 0.0; lit_material.emissiveG = 0.0; lit_material.emissiveB = 0.0;
  lit_material.roughness = 0.5; lit_material.metalness = 0.0;
  check(ogre.submitMaterial(lit_material) == 0, "submitMaterial refused (lit)");

  // The control that must not move: an emissive-only PBS material, the exact
  // shape walking-stickman and `bouncing-bodies --angular` submit.
  const emissive_material = new Material();
  emissive_material.materialId = 2;
  emissive_material.kind = ogre.MAT_HLMS_PBS;
  emissive_material.diffuseR = 0.0; emissive_material.diffuseG = 0.0;
  emissive_material.diffuseB = 0.0;
  emissive_material.specularR = 0.0; emissive_material.specularG = 0.0;
  emissive_material.specularB = 0.0;
  emissive_material.emissiveR = 0.9; emissive_material.emissiveG = 0.55;
  emissive_material.emissiveB = 0.25;
  emissive_material.roughness = 1.0; emissive_material.metalness = 0.0;
  check(ogre.submitMaterial(emissive_material) == 0, "submitMaterial refused (emissive)");

  const unlit_material = Material.unlit(0.9, 0.55, 0.25);
  unlit_material.materialId = 3;
  check(ogre.submitMaterial(unlit_material) == 0, "submitMaterial refused (unlit)");

  const skinned_material = new Material();
  skinned_material.materialId = 4;
  skinned_material.kind = ogre.MAT_HLMS_PBS;
  skinned_material.diffuseR = 0.8; skinned_material.diffuseG = 0.5;
  skinned_material.diffuseB = 0.3;
  skinned_material.specularR = 0.5; skinned_material.specularG = 0.5;
  skinned_material.specularB = 0.5;
  skinned_material.emissiveR = 0.0; skinned_material.emissiveG = 0.0;
  skinned_material.emissiveB = 0.0;
  skinned_material.roughness = 0.5; skinned_material.metalness = 0.0;
  check(ogre.submitMaterial(skinned_material) == 0, "submitMaterial refused (skinned)");

  const camera = CameraRecord.perspective(<f32>FOV_Y,
                                          <f32>WINDOW_WIDTH / <f32>WINDOW_HEIGHT, 0.1, 100.0,
                                          0.0, 0.0, <f32>EYE_Z);
  camera.cameraId = 1;
  check(ogre.submitCamera(camera) == 0, "submitCamera refused");

  const lit = Renderable.at(barrel, 1, <f32>LIT_X, 0.0, 0.0, BARREL_SCALE);
  lit.renderableId = 10;
  check(ogre.submitRenderable(lit) == 0, "submitRenderable refused (lit)");
  const emissive = Renderable.at(barrel, 2, <f32>EMISSIVE_X, 0.0, 0.0, BARREL_SCALE);
  emissive.renderableId = 11;
  check(ogre.submitRenderable(emissive) == 0, "submitRenderable refused (emissive)");
  const unlit = Renderable.at(barrel, 3, <f32>UNLIT_X, 0.0, 0.0, BARREL_SCALE);
  unlit.renderableId = 12;
  check(ogre.submitRenderable(unlit) == 0, "submitRenderable refused (unlit)");
  print("2 ok: lit, emissive-only and Unlit materials, one camera, three renderables");

  // ── clause 3: the light ──────────────────────────────────────────────
  clause = 3;
  const light = LightRecord.directional(<f32>1.0, <f32>1.0, <f32>1.0, LIGHT_INTENSITY,
                                        LIGHT_DIR_X, LIGHT_DIR_Y, LIGHT_DIR_Z);
  light.lightId = LIGHT_ID;
  const rc = ogre.submitLight(light);
  check(rc == 0, "submitLight refused (" + rc.toString() + ")");
  // Read the record back out of the region the SDK wrote it into: the same
  // bytes the adapter's submit shim decodes and the mirror stores.
  const base = regionOffset(REGION_SCENE) + ogre.SCENE_LIGHT_BASE +
               (LIGHT_ID - 1) * ogre.SCENE_LIGHT_SIZE;
  const kind = load<u32>(base + 4);
  const colourR = load<f32>(base + 16);
  const intensity = load<f32>(base + 32);
  const directionX = load<f32>(base + 48);
  check(kind == ogre.LIGHT_DIRECTIONAL, "the region's light kind is not directional");
  check(colourR == 1.0 && intensity == LIGHT_INTENSITY, "the light's colour/intensity moved");
  check(directionX == LIGHT_DIR_X, "the light's direction moved");
  // A second submit of the same id is an upsert, not a duplicate.
  light.directionY = <f32>-1.0;
  check(ogre.submitLight(light) == 0, "the light's upsert was refused");
  check(load<f32>(base + 52) == <f32>-1.0, "the upsert did not replace the record");
  light.directionY = LIGHT_DIR_Y;
  check(ogre.submitLight(light) == 0, "the light's restore was refused");
  print("3 ok: the light is mirrored (kind " + kind.toString() + ", intensity " +
        intensity.toString() + ", direction " + directionX.toString() + ") and upserts");

  // ── clause 4: thirty frames with the light in the scene ──────────────
  clause = 4;
  settle(5); // let the adapter apply the submissions before counting frames
  let counted: i32 = 0;
  let last = ogre.frameCount();
  while (counted < FRAMES) {
    RuntimeSession.wait(5);
    const now = ogre.frameCount();
    if (now == last) continue;
    counted += <i32>(now - last);
    last = now;
  }
  check(counted >= FRAMES, "only " + counted.toString() + " frames were drawn");
  check(load<u32>(base + 4) == ogre.LIGHT_DIRECTIONAL, "the light left the region");
  print("4 ok: " + counted.toString() + " frames with the light in the scene, no fault");

  if (!gl3plus) {
    print("ACID " + total.toString() + "/" + total.toString() +
          " passed (structural, renderer=null)");
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── clause 5: the lit surface is lit ─────────────────────────────────
  clause = 5;
  const pps = pixels_per_unit(EYE_Z);
  const lit_cx = project_col(LIT_X, 0.0), lit_cy = project_row(0.0, 0.0);
  const with_light = grab();
  check(with_light != null, "no frame could be downloaded with the light on");
  const h = halves(with_light!, LIT_X, 0.0, 0.0, RADIUS);
  const lit_region = region(with_light!, <i32>lit_cx, <i32>lit_cy, RECT_HALF);
  check(h.lit_count > 0 && h.dark_count > 0,
        "one of the halves has no pixels at all (lit " + h.lit_count.toString() + ", dark " +
        h.dark_count.toString() + ")");
  // The threshold is the round's "at least 4x the dark half", with a floor
  // added so it cannot be passed by a frame that is black on both sides: a
  // fixture whose light never arrived would read 0 over 0 and satisfy any pure
  // ratio. The measured numbers are printed next to it.
  check(h.lit_mean >= 4.0 * h.dark_mean + 20.0,
        "the lit half (" + h.lit_mean.toString() + ") is not 4x the dark half (" +
        h.dark_mean.toString() + ") plus a visible floor");
  check(h.mid_mean > h.dark_mean && h.mid_mean < h.lit_mean,
        "the mid band (" + h.mid_mean.toString() + ") is not between the halves (" +
        h.dark_mean.toString() + " / " + h.lit_mean.toString() + ")");
  print("5 ok: lit half " + h.lit_mean.toString() + " over " + h.lit_count.toString() +
        " px, dark half " + h.dark_mean.toString() + " over " + h.dark_count.toString() +
        " px, ratio " + (h.lit_mean / h.dark_mean).toString() + ", mid band " +
        h.mid_mean.toString() + ", brightest " + h.max_pixel.toString() +
        ", whole surface mean " + lit_region.mean.toString() +
        " over " + lit_region.count.toString() + " px");
  let profile = "5 band: ";
  for (let band: i32 = 0; band < 10; band++) {
    profile += (h.profile_count[band] > 0.0
                  ? (h.profile_sum[band] / h.profile_count[band]).toString()
                  : "0") + (band == 9 ? "" : " ");
  }
  print(profile);

  // ── clause 6: the light is what does it ──────────────────────────────
  clause = 6;
  check(ogre.removeLight(LIGHT_ID) == 0, "removeLight was refused");
  settle(6); // the adapter destroys the Ogre light on the next apply
  const light_off = grab();
  check(light_off != null, "no frame could be downloaded with the light off");
  const dark_region = region(light_off!, <i32>lit_cx, <i32>lit_cy, RECT_HALF);
  check(dark_region.mean <= 1.0,
        "the lit surface is still at mean " + dark_region.mean.toString() +
        " with the light removed");
  // And back: the shading is the light's, not the passage of time.
  check(ogre.submitLight(light) == 0, "re-submitting the light was refused");
  settle(6);
  const light_back = grab();
  check(light_back != null, "no frame could be downloaded after re-submitting the light");
  const back_region = region(light_back!, <i32>lit_cx, <i32>lit_cy, RECT_HALF);
  check(back_region.mean >= 2.0 * dark_region.mean + 1.0,
        "the surface did not light back up (mean " + back_region.mean.toString() + ")");
  print("6 ok: the lit surface is mean " + lit_region.mean.toString() + " with the light, " +
        dark_region.mean.toString() + " without, " + back_region.mean.toString() +
        " with it again");

  // ── clause 7: the emissive-only surface is untouched ─────────────────
  clause = 7;
  const emissive_cx = <i32>project_col(EMISSIVE_X, 0.0);
  check(region_identical(with_light!, light_off!, emissive_cx, <i32>lit_cy, RECT_HALF),
        "the emissive-only PBS surface changed when the light was removed");
  const emissive_region = region(with_light!, emissive_cx, <i32>lit_cy, RECT_HALF);
  print("7 ok: the emissive-only PBS surface is byte-identical with and without the light (" +
        emissive_region.mean.toString() + " mean over " + emissive_region.count.toString() +
        " px)");

  // ── clause 8: the Unlit surface is untouched ─────────────────────────
  clause = 8;
  const unlit_cx = <i32>project_col(UNLIT_X, 0.0);
  check(region_identical(with_light!, light_off!, unlit_cx, <i32>lit_cy, RECT_HALF),
        "the Unlit surface changed when the light was removed");
  const unlit_region = region(with_light!, unlit_cx, <i32>lit_cy, RECT_HALF);
  print("8 ok: the Unlit surface is byte-identical with and without the light (" +
        unlit_region.mean.toString() + " mean over " + unlit_region.count.toString() + " px)");

  // ── clause 9: the skinned path shades ────────────────────────────────
  clause = 9;
  // The three barrels make way for the rig: the character is not a sphere, and
  // its mesh origin is at its feet, so the split's centre is the silhouette's
  // centroid rather than a projected origin (12b: 2422 px, lit/dark 1.746 —
  // the retired stick figure measured 2765 px and 3.006 at this scale).
  for (let id: u32 = 10; id <= 12; id++) {
    check(ogre.removeRenderable(id) == 0, "removeRenderable refused (" + id.toString() + ")");
  }
  const hero = Renderable.at(character, 4, 0.0, <f32>(-1.1), 0.0, CHARACTER_SCALE);
  hero.renderableId = 13;
  check(ogre.submitRenderable(hero) == 0, "submitRenderable refused (character)");
  settle(8);
  const rigged = grab();
  check(rigged != null, "no frame could be downloaded for the skinned clause");
  const pixels = Uint8Array.wrap(rigged!);
  let count = 0, sum_col = 0.0, sum_row = 0.0;
  for (let row: i32 = 0; row < WINDOW_HEIGHT; row++) {
    for (let col: i32 = 0; col < WINDOW_WIDTH; col++) {
      const at = (row * WINDOW_WIDTH + col) * 4;
      if (is_background(pixels, at)) continue;
      count += 1;
      sum_col += <f64>col + 0.5;
      sum_row += <f64>row + 0.5;
    }
  }
  check(count > 100, "the character drew " + count.toString() + " pixels");
  // The split's centre is the silhouette's centroid (a rig's origin is at its
  // feet), and its axis is the same projection of the light direction — the rig
  // is coarse by construction: it is 106 px tall, not a sphere.
  const rig_axis_x = project_col(-<f64>LIGHT_DIR_X, -<f64>LIGHT_DIR_Z) -
                     project_col(0.0, 0.0);
  const rig_axis_y = project_row(-<f64>LIGHT_DIR_Y, -<f64>LIGHT_DIR_Z) -
                     project_row(0.0, 0.0);
  const rigged_halves = halves_axis(rigged!, sum_col / <f64>count, sum_row / <f64>count,
                                    rig_axis_x, rig_axis_y,
                                    Math.sqrt(rig_axis_x * rig_axis_x +
                                              rig_axis_y * rig_axis_y));
  check(rigged_halves.lit_count > 0 && rigged_halves.dark_count > 0,
        "the character's halves are not both drawn");
  check(rigged_halves.dark_mean > 0.5 &&
        rigged_halves.lit_mean / rigged_halves.dark_mean > 1.5,
        "the character's lit half (" + rigged_halves.lit_mean.toString() +
        ") is not 1.5x its dark half (" + rigged_halves.dark_mean.toString() + ")");
  print("9 ok: the skinned character under lit PBS: " + count.toString() + " px, lit " +
        rigged_halves.lit_mean.toString() + " over " + rigged_halves.lit_count.toString() +
        " px, dark " + rigged_halves.dark_mean.toString() + " over " +
        rigged_halves.dark_count.toString() + " px, ratio " +
        (rigged_halves.lit_mean / rigged_halves.dark_mean).toString());

  print("ACID " + total.toString() + "/" + total.toString() + " passed");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
