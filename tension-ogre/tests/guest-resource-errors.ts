// A resource that cannot load must say so to the guest — not vanish.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-resource-errors.wasm \
//       --tns=tension-ogre/build/fixtures.tns --renderer=gl3plus
//
// Every clause waits on a job and asserts the *terminal state and the errno the
// guest can read*, which is the whole error-propagation contract: a load either
// succeeds (JOB_DONE, a resource id) or fails (JOB_FAILED, a negative errno in
// `jobError`). A load that instead sat in JOB_PENDING would make the bounded
// wait below expire and fail the clause, so a lost error is a red test and not
// a hang.
//
// The clauses:
//
//   1. not found       a path the volume does not carry  -> JOB_FAILED, -ENOENT
//   2. not loadable    a present file that is not a mesh -> JOB_FAILED, -EIO
//   3. submit unready  a renderable naming a mesh that never loaded
//                                                       -> refused, -EINVAL
//   4. control         a mesh that does load             -> JOB_DONE, id > 0
//
// Clause 4 is the discrimination: 1-3 prove the failures are reported, and 4
// proves the reporting is specific — a blanket refusal would fail it.
//
// `--dead-renderer` is the second shape, for a run whose renderer never started
// (TENSION_RENDERER names something invalid, or OGRE cannot come up). Nothing
// will ever realise a job then, so a load queued *after* the failure must still
// come back terminal, with -EIO. This is the case that used to wait forever:
// clause 1's bounded settle is what turns that into a failure here.
//
// Prints one "RESERR <clause> <name> <errno>" line per clause and then "OK"; a
// failure prints "RESERR <clause> failed: <reason>" and traps, so the runner
// sees a non-zero exit.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { JOB_DONE, JOB_FAILED, MAT_HLMS_UNLIT, Material, Renderable } from "../../tension-framework/assembly/ogre/wire";

/// -ENOENT / -EIO / -EINVAL, as the guest reads them back out of `jobError`.
const ENOENT: i32 = -2;
const EIO: i32 = -5;
const EINVAL: i32 = -22;

/// How long a clause waits for a job to settle: 200 frames at 10 ms is a
/// couple of seconds, which is patience and not a hang. A job that never
/// reaches a terminal state fails the clause.
const SETTLE_ATTEMPTS: u32 = 200;

let clause = 0;

function fail(reason: string): void {
  print("RESERR " + clause.toString() + " failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

function decimalSigned(value: i32): string {
  if (value >= 0) return value.toString();
  return "-" + (-value).toString();
}

/// Wait for a job to reach a terminal state, bounded. Returns the state.
///
/// The epoch comes **first**, before the first read. A `Job` record reaches the
/// guest through the adapter's publish hook, so a freshly queued job's slot —
/// reused after a `releaseJob` — still holds the *previous* job's terminal
/// record until an epoch has published the new one. Reading before that epoch
/// returns the stale state, so every clause publishes once and only then reads.
function settle(job: i32): u32 {
  for (let attempt: u32 = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    RuntimeSession.wait(10);
    const state = ogre.jobState(job);
    if (state == JOB_DONE || state == JOB_FAILED) return state;
  }
  return ogre.jobState(job);
}

/// Queue a load, wait for it to settle, and insist it failed with `expected`.
/// This is the propagation assertion: FAILED plus the exact errno.
function expect_load_failure(path: string, expected: i32, name: string): void {
  const job = ogre.queueMeshLoad(path, 0);
  check(job > 0, "queueMeshLoad did not return a job id for " + path);
  const state = settle(job);
  check(state == JOB_FAILED,
        path + " settled in state " + state.toString() + ", not JOB_FAILED (a lost error)");
  const error = ogre.jobError(job);
  check(error == expected,
        path + " failed with errno " + decimalSigned(error) + ", expected " +
        decimalSigned(expected));
  print("RESERR " + clause.toString() + " " + name + " " + decimalSigned(error));
  ogre.releaseJob(job);
}

/// `--name=value`, or the fallback.
function flag(name: string, fallback: string): string {
  const prefix = "--" + name + "=";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return fallback;
}

function has(name: string): bool {
  for (let i: i32 = 0; i < argCount(); i++) {
    if (arg(i) == "--" + name) return true;
  }
  return false;
}

export function _start_game(): void {
  const renderer = flag("renderer", "gl3plus");
  const tns = flag("tns", "");
  const dead_renderer = has("dead-renderer");

  const gl3plus = renderer == "gl3plus";
  const which = gl3plus ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;

  const callbacks = makeCallbacks(null, null);
  const session = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session, callbacks) == 0, "session_open refused");

  const ogre_config = new ogre.ConfigBuilder()
    .renderer(which)
    .headless(!gl3plus)
    .vsync(false)
    .frameHz(60)
    .windowSize(320, 240);
  assert(ogre.init(ogre_config) == 0, "ogre::init refused the config");

  assert(tns.length > 0, "no --tns=<volume> argument (run through tests/run.sh)");
  assert(ogre.mountTns("resources", tns) == 0, "mountTns refused");
  ogre.assertSubmissionRegions();

  if (dead_renderer) {
    // The renderer is gone, so no job can ever be realised. A load queued now
    // must still terminate with the errno. Before the drain latch it stayed
    // PENDING, and the bounded settle below is what reports that as a failure.
    clause = 1;
    expect_load_failure("resources/meshes/cube.mesh", EIO, "dead-renderer");
    print("OK");
    assert(ogre.shutdown() == 0, "ogre::shutdown");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }

  // ── clause 1: not found ──────────────────────────────────────────────
  // The volume is mounted under "resources/", so this path resolves to a mount
  // and the volume itself has no such file: the not-found the guest must hear.
  clause = 1;
  expect_load_failure("resources/meshes/nope.mesh", ENOENT, "not-found");

  // ── clause 2: present, but not loadable ──────────────────────────────
  // A texture loaded as a mesh: the bytes exist and are read, and the mesh
  // magic check rejects them — the "readable but not viable" errno.
  clause = 2;
  expect_load_failure("resources/textures/ASCII.dds", EIO, "not-loadable");

  // ── clause 3: a renderable naming a mesh that never loaded ───────────
  // The mesh id is not a READY resource, so the mirror refuses the upsert.
  // That refusal must reach the guest as -EINVAL; a bare `return rc` in the
  // shim used to leave the wasm result at 0, so the guest believed the
  // drawable was accepted while nothing was drawn.
  clause = 3;
  const material = new Material();
  material.materialId = 1;
  material.kind = MAT_HLMS_UNLIT;
  material.diffuseR = 0.9;
  material.diffuseG = 0.2;
  material.diffuseB = 0.2;
  material.diffuseA = 1.0;
  check(ogre.submitMaterial(material) == 0, "the control material was refused");

  const orphan = Renderable.at(99999, 1);
  orphan.renderableId = 1;
  const refused = ogre.submitRenderable(orphan);
  check(refused == EINVAL,
        "a renderable naming an unloaded mesh was answered " + decimalSigned(refused) +
        ", expected " + decimalSigned(EINVAL) + " (a swallowed refusal)");
  print("RESERR 3 submit-unready " + decimalSigned(refused));

  // ── clause 4: the control ────────────────────────────────────────────
  // A mesh that does load still loads: the failures above are specific, not a
  // blanket refusal of every load.
  clause = 4;
  const good_job = ogre.queueMeshLoad("resources/meshes/cube.mesh", 0);
  check(good_job > 0, "queueMeshLoad did not return a job id for cube.mesh");
  const good_state = settle(good_job);
  check(good_state == JOB_DONE,
        "cube.mesh did not reach JOB_DONE (state " + good_state.toString() + ", error " +
        decimalSigned(ogre.jobError(good_job)) + ")");
  check(ogre.jobResult(good_job) > 0, "cube.mesh loaded with no resource id");
  print("RESERR 4 control-done 0");
  ogre.releaseJob(good_job);

  print("OK");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
