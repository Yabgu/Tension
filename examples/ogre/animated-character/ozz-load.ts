// The ozz archives, loaded at runtime (chunk 19 round 19f-b).
//
//   ./test-ozz.sh
//
// A byte-reading probe: it opens the session, brings OGRE up on the null
// renderer, mounts the example's packed volume (the archives ride in the same
// `.tns`; this proves the mount still opens), then reads the four `.ozz` files
// back through the framework's resource layer and parses them with the
// framework's own anim reader.
//
// Where the bytes come from is worth one note: `resReadFile` reads the
// `tension::res` capability, which is mounted by the interpreter's `--res`
// flag — **not** by `ogre.mountTns`. The two capabilities keep separate mount
// tables (the ogre mount feeds the OGRE loader only), so `test-ozz.sh` passes
// the same volume to both flags, and this probe exercises both halves.
//
// The numbers are the artifacts' own: 58 joints in OGRE bone order, `Hips` at
// 19 and `LeftForeArm` at 28 (the remap tool's promise), and the three clips'
// durations as gltf2ozz wrote them.

import {
  Animation,
  ConfigBuilder,
  RuntimeSession,
  Skeleton,
  arg,
  argCount,
  makeCallbacks,
  print,
  resReadFile,
} from "tension-framework";
import * as ogre from "tension-framework/assembly/ogre";

const SKELETON_PATH = "models/characterMedium_skeleton.ozz";
const CLIP_PATHS: string[] = [
  "models/characterMedium_idle.ozz",
  "models/characterMedium_run.ozz",
  "models/characterMedium_jump.ozz",
];
const CLIP_NAMES: string[] = ["idle", "run", "jump"];
const CLIP_SECONDS: f64[] = [1.375, 0.7083333, 0.5416667];
/// The shipped sizes, in bytes — the archive files, as packed.
const SKELETON_BYTES: i32 = 3295;
const CLIP_BYTES: i32[] = [5415, 6404, 4050];

function fail(reason: string): void {
  print("OZZ-LOAD FAIL: " + reason);
  assert(false, reason);
}

function read(path: string): Uint8Array {
  const bytes = resReadFile(path);
  if (bytes == null) fail("resReadFile refused " + path);
  return bytes!;
}

/// The parser takes `StaticArray<u8>`; the resource layer hands out
/// `Uint8Array`. One copy, deliberately — no pointer games in a probe.
function asStatic(bytes: Uint8Array): StaticArray<u8> {
  const out = new StaticArray<u8>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}

export function _start(): void {
  let tns = "";
  for (let i: i32 = 0; i < argCount(); i++) {
    const a = arg(i);
    if (a.startsWith("--tns=")) tns = a.substring(6);
  }

  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    fail("session_open refused");
  }

  const config = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true)
    .vsync(false)
    .frameHz(60)
    .windowSize(320, 240);
  const started = ogre.init(config);
  if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");

  if (tns.length == 0) fail("no --tns=<volume> argument (run via ./test-ozz.sh)");
  const mounted = ogre.mountTns("resources", tns);
  if (mounted != 0) fail("mountTns refused (" + mounted.toString() + ")");
  ogre.assertSubmissionRegions();

  // ── the skeleton ───────────────────────────────────────────────────────
  const skeleton_bytes = read(SKELETON_PATH);
  if (skeleton_bytes.length != SKELETON_BYTES) {
    fail(SKELETON_PATH + " is " + skeleton_bytes.length.toString() + " bytes, not " +
         SKELETON_BYTES.toString());
  }
  const skeleton = Skeleton.parse(asStatic(skeleton_bytes));
  if (skeleton.error.length > 0) fail("skeleton parse: " + skeleton.error);
  if (skeleton.jointCount != 58) {
    fail("the skeleton has " + skeleton.jointCount.toString() + " joints, not 58");
  }
  const hips = skeleton.name(19);
  const left_forearm = skeleton.name(28);
  if (hips != "Hips" || left_forearm != "LeftForeArm") {
    fail("the anchors are " + hips + "@19, " + left_forearm + "@28 — not OGRE order");
  }
  print("OZZ-LOAD skeleton joints=" + skeleton.jointCount.toString() + " hips=" + hips +
        " leftforearm=" + left_forearm);

  // ── the three clips ────────────────────────────────────────────────────
  let sizes = "skeleton=" + skeleton_bytes.length.toString();
  for (let i = 0; i < CLIP_PATHS.length; i++) {
    const bytes = read(CLIP_PATHS[i]);
    if (bytes.length != CLIP_BYTES[i]) {
      fail(CLIP_PATHS[i] + " is " + bytes.length.toString() + " bytes, not " +
           CLIP_BYTES[i].toString());
    }
    sizes += " " + CLIP_NAMES[i] + "=" + bytes.length.toString();
    const animation = Animation.parse(asStatic(bytes));
    if (animation.error.length > 0) fail(CLIP_NAMES[i] + " parse: " + animation.error);
    if (animation.trackCount != 58) {
      fail(CLIP_NAMES[i] + " has " + animation.trackCount.toString() + " tracks, not 58");
    }
    if (abs(<f64>animation.duration - CLIP_SECONDS[i]) > 1e-4) {
      fail(CLIP_NAMES[i] + " is " + animation.duration.toString() + " s, not " +
           CLIP_SECONDS[i].toString());
    }
    print("OZZ-LOAD " + CLIP_NAMES[i] + " duration=" + animation.duration.toString() +
          " tracks=" + animation.trackCount.toString());
  }
  print("OZZ-LOAD bytes " + sizes);

  // The example's own teardown order (game.ts): the renderer first, then the
  // session. The windowed fixtures skip it and get away with it because their
  // render loop ran; a probe that never drew a frame segfaults in the
  // adapter's destructor path (measured: exit 139 with every line printed).
  if (ogre.shutdown() != 0) fail("ogre::shutdown");
  if (RuntimeSession.close() != 0) fail("session_close");
  print("OZZ-LOAD OK");
}
