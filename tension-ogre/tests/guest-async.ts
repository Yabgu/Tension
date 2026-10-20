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
  rt,
  TableHeader,
  TABLE_HEADER_SIZE,
  EVENT_RECORD_SIZE,
  RING_CAPACITIES,
  CLASS_JOB_DONE,
  regionOffset,
  EventRecord
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { Task, TaskRecord } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";

// Host-driven since 0.7.0: `__taskTick` and `__taskDeliver` are gone, so a guest
// that awaits is resumed by the host loop.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

/// 1 while the guest still wants the host to drive it.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}

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
/// The class the delivery stamped on the awaited record. This is the design's
/// guarantee — the record resolves the await — and the only value the harness
/// may assert *immediately* after the resume.
let deliveredClass: i32 = 0;

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
  // `handle` is a name the state struct reserves (the transform refuses it).
  const awaitedHandle: Task<u32> = rt.job(job);
  let resource: u32 = await awaitedHandle;
  awaitedResource = resource;
  deliveredClass = awaitedHandle._record.class_;

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

/// Class 4's sub-ring header, straight from the arena: the session's
/// `ring_offset` (`arena.rs:1198-1207`) — a 32-byte header plus
/// `capacity × 32` bytes per class, in class-id order. Classes 0–3 keep their
/// build capacities; only class 4 is shrunk by the drop case.
function jobRingHeader(): TableHeader {
  let at: u32 = regionOffset(5);
  for (let i: u32 = 0; i < CLASS_JOB_DONE; ++i) {
    at += TABLE_HEADER_SIZE + RING_CAPACITIES[i] * EVENT_RECORD_SIZE;
  }
  return changetype<TableHeader>(at);
}

/// The awaited record of the next `awaitJobRec` call, so the guest can read the
/// *job's* status. The task's own result record is completed with `status = 0`
/// by `__taskCompleteResult`; §3.4's errno lives on the record the task awaited.
let recorded: TaskRecord = new TaskRecord();
let recordNext: bool = false;

async function awaitJobRec(job: i32): i32 {
  const h: Task<u32> = rt.job(job);
  if (recordNext) {
    recorded = h._record;
    recordNext = false;
  }
  const v: u32 = await h;
  return i32(v);
}

/// The drop case (`--async-case=drop`, 4e-2): one completion is forced to be
/// dropped, and the task awaiting it must wake with -EIO rather than hang.
///
/// The forced drop is a test-only trick: `JOB_DONE`'s ring is shrunk to one
/// slot, one completion nobody awaits fills it, and the next completion finds
/// it full — counted `dropped` and discarded (`subring.rs:290-295`). The store
/// is a real session either way.
///
/// **Why this case opens the session without callbacks.** With `rt.callbacks()`
/// the epoch's invoke phase hands the guest every class-4 record and the
/// guest's `onBatch` drains it in the same epoch, so the ring is empty again
/// before the next completion is posted. Measured: three loads queued with no
/// tick between them produced `dropped=0`, `delivered=1` per epoch — never an
/// overflow. Without callbacks the records stay in the ring (the ring protocol:
/// the guest owns `tail`), which makes the overflow deterministic and lets the
/// case exercise the same `rt.deliver` seam the callback uses.
/// Setup results, module-level for the reason `j2u32` exists.
let dropOpen: i32 = 0;
let mainOpen: i32 = 0;

/// `j2` as a `u32`, outside the async body (which refuses `<T>expr`).
let jobForRecord: i32 = 0;
function j2u32(): u32 {
  return <u32>jobForRecord;
}

/// The drop case's setup, in synchronous code: the transform lifts locals out
/// of an async body and does not always keep their types (measured with 0.7.0's
/// conversion: "Cannot find name 'cfg'").
function openDropCase(tns: string): i32 {
  rt.start();
  const cfg = ConfigBuilder.forThisBuild(null).ringCapacity(CLASS_JOB_DONE, 1);
  if (RuntimeSession.open(cfg) != 0) return -1;
  const config = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  if (ogre.init(config) != 0 || tns.length == 0 || ogre.mountTns("resources", tns) != 0) {
    RuntimeSession.close();
    return -2;
  }
  return 0;
}

async function dropCase(tns: string): void {
  // Module-level, not a local: the transform drops a local declared from a call
  // and read immediately in an async body (measured: "Cannot find name
  // 'opened'").
  dropOpen = openDropCase(tns);
  if (dropOpen == -1) {
    print("ASYNC SKIP drop-setup: session_open refused the capacity");
    finished = true;
    return;
  }
  if (dropOpen != 0) {
    print("ASYNC SKIP drop-setup: ogre init or mount failed");
    finished = true;
    return;
  }

  const ring: TableHeader = jobRingHeader();
  const base: u32 = changetype<u32>(ring);

  // 1. Fill the one slot with a completion nobody awaits. The first `runReady`
  //    also adopts the drop counter (0), so the later delta is reportable.
  const j1: i32 = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  if (j1 <= 0) {
    print("ASYNC SKIP drop-setup: the fill load was refused");
    RuntimeSession.close();
    return;
  }
  let guard: u32 = 0;
  while (ogre.jobState(j1) != ogre.JOB_DONE && guard < 600) {
    await rt.frame();
    guard++;
  }
  if (ogre.jobState(j1) != ogre.JOB_DONE || ring.head != 1 || ring.tail != 0) {
    print("ASYNC SKIP drop-setup: the ring did not hold j1's completion (state " +
      ogre.jobState(j1).toString() + " head=" + ring.head.toString() +
      " tail=" + ring.tail.toString() + ")");
    RuntimeSession.close();
    return;
  }
  if (ring.capacity != 1) {
    print("ASYNC SKIP drop-setup: the ring capacity is " + ring.capacity.toString() + ", not 1");
    RuntimeSession.close();
    return;
  }

  // 2. Two tasks park before the drop: the dropped job's, and a control on a
  //    key that never completes — it must stay parked while the older task
  //    takes the -EIO (attribution is per family, oldest-first).
  const j2: i32 = ogre.queueMeshLoad("resources/meshes/cube.mesh", 0);
  if (j2 <= 0) {
    print("ASYNC SKIP drop-setup: the drop load was refused");
    RuntimeSession.close();
    return;
  }
  recordNext = true;
  const lost: Task<i32> = awaitJobRec(j2);
  const lostRecord: TaskRecord = lost._record;
  const lostAwait: TaskRecord = recorded;
  // A **valid** jobs key that nothing will ever complete. The old control used
  // 0x7FFFFFFF, which is outside the class's key space — under the push path
  // that park is refused at once (§5.1: a key outside the space is refused,
  // never waited on), so the control would wake with -EINVAL and the
  // over-attribution check would measure nothing. 767 is the last valid jobs
  // key (768 = `key_capacity(CLASS_JOB_DONE)`).
  const control: Task<i32> = awaitJobRec(767);
  const controlRecord: TaskRecord = control._record;

  // 3. j2's completion finds the ring full and is dropped; the tick that sees
  //    the delta wakes the oldest parked task with -EIO.
  guard = 0;
  while (ring.dropped == 0 && guard < 600) {
    await rt.frame();
    guard++;
  }
  if (ring.dropped != 1) {
    print("ASYNC SKIP drop-setup: the ring dropped " + ring.dropped.toString() +
      " completions, not 1");
    RuntimeSession.close();
    return;
  }
  if (lostRecord.done == 0) {
    print("ASYNC FAIL: the dropped task did not resume");
    assert(false, "no resume");
    return;
  }
  if (lostAwait.status != -5) {
    print("ASYNC FAIL: the awaited record's status is " + lostAwait.status.toString() +
      ", not -EIO");
    assert(false, "no -EIO");
    return;
  }
  if (lostAwait.payload != 0) {
    print("ASYNC FAIL: the lost completion left a payload");
    assert(false, "payload");
    return;
  }
  // Attribution: the control task, parked second, must still be waiting.
  if (controlRecord.done != 0) {
    print("ASYNC FAIL: both tasks took the -EIO wake");
    assert(false, "over-attribution");
    return;
  }

  // 4. A delivery for the lost key after the wake must not turn -EIO into
  //    success (the wake writes the status; a delivery never clears it).
  jobForRecord = j2;
  const late: EventRecord = new EventRecord();
  late.class_ = CLASS_JOB_DONE;
  late.a = j2u32();
  late.b = 0x5eed;
  rt.deliver(CLASS_JOB_DONE, changetype<u32>(late), 1);
  if (lostAwait.status != -5 || lostAwait.payload != 0) {
    print("ASYNC FAIL: a post-wake delivery overwrote the -EIO status");
    assert(false, "overwrite");
    return;
  }

  // 5. Reclaim the slot and let one live job complete through the ring. No
  //    callbacks: the guest consumes the record itself and hands it to the
  //    same dispatcher seam the callback would (`rt.deliver`).
  ring.tail = ring.head;
  const j3: i32 = ogre.queueMeshLoad("resources/meshes/Smiley.mesh", 0);
  if (j3 <= 0) {
    print("ASYNC SKIP drop-setup: the live load was refused");
    RuntimeSession.close();
    return;
  }
  recordNext = true;
  const live: Task<i32> = awaitJobRec(j3);
  const liveRecord: TaskRecord = live._record;
  const liveAwait: TaskRecord = recorded;
  guard = 0;
  while (liveRecord.done == 0 && guard < 600) {
    await rt.frame();
    // Reclaim the ring as the callback would: `rt.deliver` is the guest's
    // tail-advance since 0.7.0 (the host matches and wakes; this no longer
    // delivers).
    if (ring.head > ring.tail) {
      const slot: u32 = base + TABLE_HEADER_SIZE + ring.tail * EVENT_RECORD_SIZE;
      const record: EventRecord = changetype<EventRecord>(slot);
      rt.deliver(record.class_, slot, 1);
      ring.tail = ring.tail + 1;
    }
    guard++;
  }
  if (liveRecord.done == 0 || liveAwait.status != 0 || liveAwait.payload == 0) {
    print("ASYNC FAIL: the live job did not complete normally (status " +
      liveAwait.status.toString() + " payload=" + liveAwait.payload.toString() + ")");
    assert(false, "live job");
    return;
  }
  if (ogre.jobState(j3) != ogre.JOB_DONE) {
    print("ASYNC FAIL: the live job's region state is not JOB_DONE");
    assert(false, "region");
    return;
  }

  // Recovery: the region is the truth (tension-ogre/DESIGN.md:1842-1844).
  print("ASYNC EIO job=" + j2.toString() + " status=" + lostAwait.status.toString() +
    " payload=" + lostAwait.payload.toString() + " region-state=" + ogre.jobState(j2).toString());
  print("ASYNC live job=" + j3.toString() + " resource=" + liveAwait.payload.toString());
  print("ASYNC PASS drop");
  RuntimeSession.close();
  finished = true;
}

export function _start_game(): void {
  __taskBindTable(16);
  let tns = "";
  let drop = false;
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--tns=")) tns = value.slice(6);
    if (value == "--async-case=drop") drop = true;
  }
  // A floating task: it runs the synchronous setup and parks at its first
  // await. From here the host owns the loop.
  run(tns, drop);
}

/// The main path's setup, in synchronous code (see `openDropCase`).
/// 0 ok, 1 session, 2 ogre, 3 no volume, 4 mount.
function openMain(tns: string): i32 {
  rt.start();
  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) return 1;
  const config = new ogre.ConfigBuilder()
    .renderer(ogre.Renderer.Null)
    .headless(true).vsync(false).frameHz(60).windowSize(64, 64);
  if (ogre.init(config) != 0) return 2;
  if (tns.length == 0) return 3;
  if (ogre.mountTns("resources", tns) != 0) return 4;
  return 0;
}

/// The harness body, as one task (0.7.0). Every await here parks this task, so
/// the host's wake is what advances the criteria — the same property the old
/// `RuntimeSession.wait` + `rt.runReady` pump had, without a tick.
async function run(tns: string, drop: bool): void {
  if (drop) {
    await dropCase(tns);
    return;
  }

  mainOpen = openMain(tns);
  if (mainOpen == 1) fail("session_open refused");
  if (mainOpen == 2) fail("ogre::init refused");
  if (mainOpen == 3) fail("no --tns=<volume> argument");
  if (mainOpen == 4) fail("mountTns refused");

  const job: i32 = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0);
  if (job <= 0) fail("queueMeshLoad refused (" + job.toString() + ")");

  // Start the task. It parks inside `awaitJob`, so its entry returns a handle
  // whose record is *not* settled yet.
  const handle: Task<u32> = awaitJob(job);
  const taskRecord: TaskRecord = handle._record;
  if (taskRecord.done != 0) fail("the task was already settled before the loop ran");

  // Wait for the task's own record, on the frame clock.
  let ticks: u32 = 0;
  while (taskRecord.done == 0 && ticks < 600) {
    await rt.frame();
    ticks++;
  }
  if (taskRecord.done == 0) fail("the job never completed (no delivery in 600 frames)");

  // The handle's record is the *task's own* result record: `awaitJob`'s return
  // completed it (`__taskCompleteResult`), so its payload is `resource + frames`
  // — a different record from the job's, which held the resource id. The two
  // numbers disagreeing is the design working, not a mismatch.
  const result: u32 = taskRecord.payload;
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

  // The cross-checks, in the order the design guarantees them.
  //
  // 1. **The delivered class**, which is what resolved the await and is the
  //    contract (`docs/async-await-plan-v2.md` §3.1). Available immediately.
  if (deliveredClass != CLASS_JOB_DONE) {
    fail("the delivered class is " + deliveredClass.toString() + ", not JOB_DONE");
  }
  // 2. **The arena mirror**, which is a *different* mechanism and eventually
  //    consistent. The loader sets its own `JobSlot` and posts the record from
  //    the worker thread; the guest's `jobState` reads the arena's JOB region,
  //    which is written later, by the render thread's `publish` hook
  //    (`adapter.cpp:1364`, `mirror_to_region`). A record can therefore arrive
  //    while the mirror still says RUNNING — measured, one run in three, and
  //    documented in `ogre/async.ts`'s classification comment. Asserting the
  //    mirror *immediately* would assert something the design never promised.
  //
  //    The property the design does promise is convergence: the slot stays
  //    dirty until it is mirrored. So the harness waits for it, bounded. This
  //    is a test harness, not a guest: the no-poll rule governs guest code,
  //    and a bounded wait for an eventual guarantee is exactly what a
  //    conformance test is for.
  let mirrorGuard: i32 = 0;
  while (ogre.jobState(job) != ogre.JOB_DONE && mirrorGuard < 600) {
    await rt.frame();
    mirrorGuard++;
  }
  if (ogre.jobState(job) != ogre.JOB_DONE) {
    fail("jobState never mirrored JOB_DONE (guard " + mirrorGuard.toString() + ")");
  }
  if (ogre.jobResult(job) != awaited) fail("the completion and the job table disagree");
  if (result != awaited + framesWhileSuspended) fail("the task's own result is not resource + frames");

  print("ASYNC frames-while-suspended=" + framesWhileSuspended.toString());
  print("ASYNC awaited=" + awaited.toString() + " result=" + result.toString());
  print("ASYNC PASS");

  RuntimeSession.close();
  finished = true;
}
