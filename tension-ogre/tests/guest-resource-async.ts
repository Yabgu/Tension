// The awaitable resource API's negative controls (`docs/resource-async-scope.md`
// §7). Four cases, each exercising a failure path the wrapper must survive
// **without hanging** — which is the property the whole fixture exists for.
//
// Run through `tests/run.sh`'s guest list; every case prints a line and the
// script asserts the exit status and the transcript.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  ConfigBuilder, makeCallbacks, RuntimeSession, rt,
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { Task } from "~lib/task";

const CLASS_JOB_DONE: i32 = 4;
const ENOENT: i32 = -2;
const EIO: i32 = -5;

function fail(reason: string): void {
  print("RESASYNC FAIL: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

/// Runs `task` to completion, ticking the scheduler. The guard is a hang
/// detector: a task that never settles is the failure this fixture hunts.
function settle(task: Task<i32>): i32 {
  for (let guard: i32 = 0; guard < 6000 && !task._record.done; ++guard) {
    RuntimeSession.wait(10);
    rt.runReady();
  }
  return task._record.done;
}

function openSession(callbacks: bool): bool {
  const cb = callbacks ? rt.callbacks() : makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(cb), cb) != 0) return false;
  const config = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  return ogre.init(config) == 0;
}

// ── case 1: a mesh that is not there ──────────────────────────────────────
// The wrapper must return the loader's errno and the task must settle.
async function loadMissing(path: string): i32 {
  return await ogre.loadMesh(path, 0);
}

// ── case 2: a completion that never arrives ───────────────────────────────
// 4e-2's drop trick: the JOB_DONE ring is shrunk to one slot, one unawaited
// completion fills it, and the next is dropped. The parked task must wake with
// -EIO rather than hang — the wrapper has to report that, not a resource id.
async function loadDropped(path: string): i32 {
  return await ogre.loadMesh(path, 0);
}

// ── case 4: two loads in flight at once ───────────────────────────────────
async function loadTwo(a: string, b: string): i32 {
  const first: i32 = await ogre.loadMesh(a, 0);
  const second: i32 = await ogre.loadMesh(b, 0);
  // Two distinct, positive resource ids: the correlation is per job id.
  if (first <= 0 || second <= 0) return first < 0 ? first : second;
  return first == second ? -99 : first * 1000 + second;
}

/// Case 2 runs in its own process: the OGRE adapter is a singleton, and
/// `shutdown()` does not make `init` legal again in the same instance — the 4c
/// harness (`guest-async.ts:297-301`) splits its drop case for the same reason.
function dropCase(tns: string): void {
  const cfg = ConfigBuilder.forThisBuild(null).ringCapacity(CLASS_JOB_DONE, 1);
  if (RuntimeSession.open(cfg) != 0) fail("case 2: session_open refused the capacity");
  const dropConfig = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  if (ogre.init(dropConfig) != 0) fail("case 2: ogre init refused");
  if (ogre.mountTns("resources", tns) != 0) fail("case 2: mountTns refused");

  // Fill the one slot with a completion nobody awaits.
  const filler: i32 = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  check(filler > 0, "case 2: the filler load was refused");
  for (let guard: i32 = 0; guard < 600 && ogre.jobState(filler) != ogre.JOB_DONE; ++guard) {
    RuntimeSession.wait(10);
    rt.runReady();
  }
  check(ogre.jobState(filler) == ogre.JOB_DONE, "case 2: the filler never completed");

  // Now the awaited load's completion finds the ring full and is dropped.
  const dropped: Task<i32> = loadDropped("resources/meshes/cube.mesh");
  const settled: i32 = settle(dropped);
  const code: i32 = dropped._record.payload;
  check(settled == 1, "case 2: the dropped load never settled (the hang)");
  check(code == EIO, "case 2: the dropped load returned " + code.toString() + ", not -EIO");
  print("2 ok: dropped completion -> " + code.toString() + " (-EIO, no hang)");

  RuntimeSession.close();
  print("RESASYNC PASS");
}

export function _start_game(): void {
  let tns = "";
  let drop = false;
  for (let i: i32 = 0; i < argCount(); ++i) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
    if (value == "--resasync-case=drop") drop = true;
  }
  if (tns.length == 0) fail("no --tns=<volume> argument");
  if (drop) {
    dropCase(tns);
    return;
  }

  // ── 1. missing mesh: the errno arrives, the task settles ───────────────
  if (!openSession(true)) fail("session or ogre init refused");
  if (ogre.mountTns("resources", tns) != 0) fail("mountTns refused");

  const missing: Task<i32> = loadMissing("resources/meshes/does-not-exist.mesh");
  check(settle(missing) == 1, "case 1: the missing-mesh load never settled");
  const missingId: i32 = missing._record.payload;
  check(missingId == ENOENT, "case 1: the errno is " + missingId.toString() + ", not -ENOENT");
  print("1 ok: missing mesh -> " + missingId.toString() + " (settled, no hang)");

  // ── 4. two concurrent loads ────────────────────────────────────────────
  const two: Task<i32> = loadTwo("resources/meshes/Barrel.mesh", "resources/meshes/cube.mesh");
  check(settle(two) == 1, "case 4: the two-load task never settled");
  const pair: i32 = two._record.payload;
  check(pair > 0, "case 4: two loads did not both resolve (" + pair.toString() + ")");
  print("4 ok: two loads -> " + pair.toString() + " (distinct ids)");

  // ── 3. a refused queue does not park ───────────────────────────────────
  // The name is far longer than the submission half can carry, so
  // `queueMeshLoad` refuses before a job exists. The wrapper must return that
  // code and must not park on an id that will never complete.
  let longName = "";
  for (let i: i32 = 0; i < 20000; ++i) longName += "x";
  const refused: Task<i32> = ogre.loadMesh(longName, 0);
  check(refused._record.done == 1,
    "case 3: the refused queue parked instead of returning immediately");
  const refusedCode: i32 = refused._record.payload;
  check(refusedCode < 0, "case 3: a refused queue returned " + refusedCode.toString());
  print("3 ok: refused queue -> " + refusedCode.toString() + " (no park)");

  ogre.shutdown();
  RuntimeSession.close();
  print("RESASYNC PASS");
}
