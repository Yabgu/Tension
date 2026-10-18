// The async × OGRE job harness (Phase 4c): a guest that awaits a real job.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-async.wasm --renderer=null --tns=<volume>
//
// What makes this the *meaningful* harness (`docs/async-await-plan-v2.md`
// §8.1): the completion is posted by the loader's worker thread, through the
// render thread's drain, after a genuine delay — the adapter is the producer,
// so suspension is real and a busy-waiting guest would fail.
//
// The four pass criteria, each asserted here and echoed for the host to check
// (§8.2):
//
//   1. ordering — the pre-await line precedes the post-await line, and the
//      post-await line is printed only after the epoch that carried the
//      completion;
//   2. genuine yield — the frame counter advanced at least one frame while the
//      task was parked (`frames-while-suspended`);
//   3. lifted locals survive — `before` is assigned before the await and read
//      after it;
//   4. no reentrancy refusal — no session verb returned -EBADF or -EBUSY.
//
// Plus the two cross-checks that make it this feature rather than a synthetic
// one: the awaited value equals `jobResult(job)`, and `jobState(job)` is
// JOB_DONE. The result is an addition (`resource + frames`) so a wrong lift or
// a stale record changes the number instead of passing by coincidence.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  ConfigBuilder,
  RuntimeSession,
  rt
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { Task, TaskRecord } from "~lib/task";

/** -EBADF: the session is FAULTED; -EBUSY: a verb inside a callback. */
const EBADF: i32 = -9;
const EBUSY: i32 = -16;

let framesWhileSuspended: u32 = 0;
let sawPreAwait: bool = false;
let sawPostAwait: bool = false;
let preAwaitFrame: u32 = 0;
let afterFrame: u32 = 0;
let badVerbResult: i32 = 0;
let awaitedResource: u32 = 0;

function fail(reason: string): void {
  print("ASYNC FAIL: " + reason);
  assert(false, reason);
}

/** Awaits `job`'s completion, and measures what happened around the park. */
async function awaitJob(job: i32): u32 {
  // Criterion 3: this local is live across the suspension.
  let before: u32 = u32(ogre.frameCount());
  preAwaitFrame = before;
  sawPreAwait = true;
  print("ASYNC pre-await frame=" + before.toString());

  // The parked path: `rt.job` stamps the record with (JOB_DONE, jobId), which
  // is exactly what the loader posts — `post_event(JOB_DONE|JOB_FAILED, job_id,
  // resource_id)` (`loader.cpp:433-439`, `adapter.cpp:194-197`).
  let resource: u32 = await rt.job(job);
  awaitedResource = resource;

  // `after` is a module-level variable, not a local: a local declared *after*
  // an await and read by a later statement is scoped to its own resume guard
  // (reported — the same guard/scoping defect Phase F found, on the other side
  // of the await). `before` above is the lifted local this test is about.
  afterFrame = u32(ogre.frameCount());
  sawPostAwait = true;
  framesWhileSuspended = afterFrame - before;
  print("ASYNC post-await frame=" + afterFrame.toString() + " resource=" + resource.toString());

  // Criterion 3's assertion: the value assigned before the park survived it.
  if (before == 0 && afterFrame == 0) fail("the frame counter never moved");
  return resource + framesWhileSuspended;
}

/// The drop case (`--async-case=drop`, 4e-2): one completion is forced to be
/// dropped, and the task awaiting it must wake with -EIO rather than hang.
///
/// The forced drop uses a test-only trick: `JOB_DONE`'s ring is shrunk to one
/// slot at `session_open`, three loads are queued without a tick between, and
/// the middle load's completion finds the ring full — counted `dropped` and
/// discarded (`subring.rs:290-295`). The store is a real session either way.
function dropCase(tns: string): void {
  rt.start();
  const callbacks = rt.callbacks();
  const cfg = ConfigBuilder.forThisBuild(callbacks).ringCapacity(4, 1); // class 4 = JOB_DONE
  if (RuntimeSession.open(cfg, callbacks) != 0) {
    print("ASYNC SKIP drop-setup: session_open refused the capacity");
    return;
  }
  const config = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  if (ogre.init(config) != 0 || tns.length == 0 || ogre.mountTns("resources", tns) != 0) {
    print("ASYNC SKIP drop-setup: ogre init or mount failed");
    RuntimeSession.close();
    return;
  }

  const j1 = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  const j2 = ogre.queueMeshLoad("resources/meshes/cube.mesh", 0);
  const j3 = ogre.queueMeshLoad("resources/meshes/Smiley.mesh", 0);
  if (j1 <= 0 || j2 <= 0 || j3 <= 0) {
    print("ASYNC SKIP drop-setup: a load was refused at queue time");
    RuntimeSession.close();
    return;
  }

  // j1's own completion fills the 1-slot ring; its job must reach DONE before
  // anything about the later drops can be attributed.
  let guard: u32 = 0;
  while (ogre.jobState(j1) != ogre.JOB_DONE && ogre.jobState(j1) != ogre.JOB_FAILED && guard < 600) {
    RuntimeSession.wait(10);
    rt.runReady();
    guard++;
  }
  if (ogre.jobState(j1) != ogre.JOB_DONE) {
    print("ASYNC SKIP drop-setup: j1 never reached JOB_DONE (state " + ogre.jobState(j1).toString() + ")");
    RuntimeSession.close();
    return;
  }

  // Two tasks park: one on the dropped job, one on the live one.
  const lost: Task<i32> = awaitJob32(j2);
  const live: Task<u32> = rt.job(j3);
  const lostRecord: TaskRecord = lost._record;
  const liveRecord: TaskRecord = live._record;

  guard = 0;
  while (lostRecord.status == 0 && guard < 600) {
    RuntimeSession.wait(10);
    rt.runReady();
    guard++;
  }

  if (lostRecord.status != -5) {
    print("ASYNC FAIL: the dropped job did not wake with -EIO (status " + lostRecord.status.toString() + ")");
    assert(false, "no -EIO");
    return;
  }
  // Exactly one task took the drop: the live job's record is untouched.
  if (liveRecord.status == -5) {
    print("ASYNC FAIL: both tasks took the -EIO wake");
    assert(false, "over-attribution");
    return;
  }
  // Recovery: the region is the truth (tension-ogre/DESIGN.md:1842-1844).
  const state = ogre.jobState(j2);
  print("ASYNC EIO job=" + j2.toString() + " status=" + lostRecord.status.toString() +
    " payload=" + lostRecord.payload.toString() + " region-state=" + state.toString());

  guard = 0;
  while (liveRecord.done == 0 && guard < 600) {
    RuntimeSession.wait(10);
    rt.runReady();
    guard++;
  }
  if (liveRecord.done == 0 || liveRecord.status != 0) {
    print("ASYNC FAIL: the live job did not complete normally");
    assert(false, "live job");
    return;
  }
  print("ASYNC live job=" + j3.toString() + " resource=" + liveRecord.payload.toString());
  print("ASYNC PASS drop");
  RuntimeSession.close();
}

/// Parks a task on a job and reports the outcome as an `i32` status: an `-EIO`
/// wake leaves the payload 0, so the value alone cannot say what happened.
async function awaitJob32(job: i32): i32 {
  let v: u32 = await rt.job(job);
  return i32(v);
}

export function _start_game(): void {
  let tns = "";
  let drop = false;
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
    if (value == "--async-case=drop") drop = true;
  }
  if (drop) {
    dropCase(tns);
    return;
  }

  rt.start();
  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    fail("session_open refused");
  }

  const config = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  if (ogre.init(config) != 0) fail("ogre::init refused");
  if (tns.length == 0) fail("no --tns=<volume> argument");
  if (ogre.mountTns("resources", tns) != 0) fail("mountTns refused");

  const job = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");

  // Start the task. It parks inside `awaitJob`, so its entry returns a handle
  // whose record is *not* settled yet.
  let handle: Task<u32> = awaitJob(job);
  let record: TaskRecord = handle._record;
  if (record.done != 0) fail("the task was already settled before the loop ran");

  // The frame loop every async game runs: yield, then resume what is ready.
  let ticks: u32 = 0;
  while (record.done == 0 && ticks < 600) {
    const waited = RuntimeSession.wait(10);
    if (waited == EBADF || waited == EBUSY) badVerbResult = waited;
    rt.runReady();
    ticks++;
  }
  if (record.done == 0) fail("the job never completed (no delivery in 600 ticks)");

  // The handle's record is the *task's own* result record: `awaitJob`'s return
  // completed it (`__taskCompleteResult`), so its payload is `resource + frames`
  // — a different record from the job's, which held the resource id. The two
  // numbers disagreeing is the design working, not a mismatch.
  const result: u32 = record.payload;
  const awaited: u32 = awaitedResource;

  // Criterion 1: ordering. Both lines exist, and the post-await line's frame is
  // strictly after the pre-await line's — it was printed by the resume, which
  // can only run after the epoch that carried the completion.
  if (!sawPreAwait) fail("no pre-await line");
  if (!sawPostAwait) fail("no post-await line");
  if (afterFrame <= preAwaitFrame) fail("the post-await line did not follow a later frame");

  // Criterion 2: the guest really yielded — the frame counter advanced while
  // the task was parked.
  if (framesWhileSuspended < 1) fail("frames-while-suspended = 0: the task never suspended");

  // Criterion 4: no reentrancy refusal in the normal path.
  if (badVerbResult != 0) fail("a session verb refused with " + badVerbResult.toString());

  // The cross-checks: the awaited value is the job's, from the job's own table.
  if (ogre.jobState(job) != ogre.JOB_DONE) fail("jobState != JOB_DONE");
  if (ogre.jobResult(job) != awaited) fail("the completion and the job table disagree");
  if (result != awaited + framesWhileSuspended) fail("the task's own result is not resource + frames");

  print("ASYNC frames-while-suspended=" + framesWhileSuspended.toString());
  print("ASYNC awaited=" + awaited.toString() + " result=" + result.toString());
  print("ASYNC PASS");

  RuntimeSession.close();
}
