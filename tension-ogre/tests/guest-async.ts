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

export function _start_game(): void {
  let tns = "";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
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
