// The 3a acid test: five clauses about jobs, asserted by the guest itself.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-jobs.wasm --renderer=null
//
// The clauses (DESIGN.md §14: the acid test is the milestone gate):
//
//   1. a shipped mesh loads: jobState DONE, jobResult > 0
//   2. a mesh that is not there fails: JOB_FAILED with -ENOENT, and the
//      process keeps running
//   3. eight loads queued together all reach DONE with eight distinct
//      resource ids
//   4. releasing a job frees its slot, and the next queue lands in it
//   5. a shipped texture decodes and loads
//
// Prints one line per clause and "ACID 5/5 passed" at the end; a failure
// prints "ACID <n>/5 failed: <reason>" and traps, so the interpreter exits
// non-zero and the runner sees both.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  CLASS_JOB_DONE,
  CLASS_JOB_FAILED,
  ConfigBuilder,
  EventRecord,
  MODE_DIRECT,
  RuntimeSession,
  SUBSCRIPTION_SIZE,
  Subscription,
  makeCallbacks,
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { JOB_DONE, JOB_FAILED, JOB_RELEASED } from "../../tension-framework/assembly/ogre/wire";

let clause = 0;

/// One clause failed: say which, and stop with a non-zero exit.
function fail(reason: string): void {
  print("ACID " + clause.toString() + "/5 failed: " + reason);
  assert(false, reason);
}

function check(condition: bool, reason: string): void {
  if (!condition) fail(reason);
}

/// Wait for `job` to reach a terminal state (or give up and say so).
function settle(job: i32): void {
  for (let attempt: u32 = 0; attempt < 200; attempt++) {
    const state = ogre.jobState(job);
    if (state == JOB_DONE || state == JOB_FAILED) return;
    RuntimeSession.wait(10);
  }
  fail("job " + job.toString() + " never settled");
}

export function _start_game(): void {
  let renderer = "null";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) renderer = value.slice(11);
  }
  const which = renderer == "gl3plus" ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null;

  const callbacks = makeCallbacks(null, null);
  const session = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session, callbacks) == 0, "session_open refused");

  const ogre_config = new ogre.ConfigBuilder()
    .renderer(which)
    .headless(which == ogre.Renderer.Null)
    .vsync(false)
    .frameHz(60)
    .windowSize(640, 480);
  assert(ogre.init(ogre_config) == 0, "ogre::init refused the config");

  // ── clause 1: a shipped mesh ─────────────────────────────────────────
  clause = 1;
  const mesh_job = ogre.queueMeshLoad("Barrel.mesh", 0);
  check(mesh_job > 0, "queueMeshLoad did not return a job id");
  settle(mesh_job);
  check(ogre.jobState(mesh_job) == JOB_DONE,
        "Barrel.mesh did not reach DONE (state " + ogre.jobState(mesh_job).toString() +
        ", error " + ogre.jobError(mesh_job).toString() + ")");
  check(ogre.jobResult(mesh_job) > 0, "no resource id for Barrel.mesh");
  print("1 ok");

  // ── clause 2: a mesh that is not there ───────────────────────────────
  clause = 2;
  const missing = ogre.queueMeshLoad("does-not-exist.mesh", 0);
  check(missing > 0, "queueMeshLoad refused the missing file at queue time");
  settle(missing);
  check(ogre.jobState(missing) == JOB_FAILED, "a missing mesh did not fail");
  check(ogre.jobError(missing) == -2, "the failure is not -ENOENT");
  print("2 ok");

  // ── clause 3: eight at once ──────────────────────────────────────────
  clause = 3;
  const ids = new Array<i32>(8);
  for (let i = 0; i < 8; i++) {
    ids[i] = ogre.queueMeshLoad("Barrel.mesh", 0);
    check(ids[i] > 0, "one of eight loads was refused");
  }
  for (let i = 0; i < 8; i++) settle(ids[i]);
  let resources = new Array<u32>(8);
  for (let i = 0; i < 8; i++) {
    check(ogre.jobState(ids[i]) == JOB_DONE, "one of eight did not reach DONE");
    resources[i] = ogre.jobResult(ids[i]);
    check(resources[i] > 0, "one of eight has no resource id");
    for (let j = 0; j < i; j++) {
      check(resources[j] != resources[i], "two jobs share a resource id");
    }
  }
  print("3 ok");

  // ── clause 4: release, then reuse ────────────────────────────────────
  clause = 4;
  const released = ids[0];
  check(ogre.releaseJob(released) == 0, "releaseJob refused");
  // The record the guest reads is written by the *publish* phase, so a change
  // becomes visible when an epoch runs — not the instant the verb returns.
  RuntimeSession.wait(0);
  check(ogre.jobState(released) == JOB_RELEASED, "the released job does not read RELEASED");
  const again = ogre.queueMeshLoad("Barrel.mesh", 0);
  // The id *is* the slot, so the freed one comes straight back — which is what
  // makes jobRecord(jobId) arithmetic true on the guest side too.
  check(again == released, "the freed slot was not reused");
  settle(again);
  check(ogre.jobState(again) == JOB_DONE, "the reusing job did not reach DONE");
  print("4 ok");

  // ── clause 5: a texture ──────────────────────────────────────────────
  // DDS is the format this install's OGRE can decode (its codecs are OITD and
  // DDS only); a PNG would fail with a named error, which is clause 2's shape.
  clause = 5;
  const texture_job = ogre.queueTextureLoad("ASCII.dds", 0);
  check(texture_job > 0, "queueTextureLoad did not return a job id");
  settle(texture_job);
  check(ogre.jobState(texture_job) == JOB_DONE, "ASCII.dds did not reach DONE");
  check(ogre.jobResult(texture_job) > 0, "no resource id for ASCII.dds");
  print("5 ok");

  print("ACID 5/5 passed");
  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
