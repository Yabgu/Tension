// The capability ABI, end to end: a session guest that asks an adapter for a
// mesh and hears back when it has one.
//
// The chain this fixture exercises, and nothing more:
//
//   session_open (callbacks registered, JOB_DONE as DIRECT)
//   ogre::init (headless config)
//   ogre.queueMeshLoad("meshes/hero.glb") -> a job id
//   session_wait                      -> the epoch: the adapter's publish
//                                        completes the job and posts JOB_DONE
//   onEvent(JOB_DONE)                 -> job id in `a`, resource id in `b`
//   jobState(job) == JOB_DONE         -> the record agrees with the event
//   print "OK <job> <resource>"
//   session_close
//
// **JOB_DONE is subscribed as DIRECT**, not the class's batched default: one
// job completes at a time here, and the payload the guest needs (`a` = job,
// `b` = resource) is in the record, so one callback per event is the shape that
// reads best. A guest loading thousands of meshes would take the default and
// read the batch from the ring instead.
//
// The adapter behind it is `ogre_stub_adapter.c`: no OGRE-Next, no window, no
// GPU. What is real is the protocol — an import that returns a job id, a
// region the adapter writes, an event the session delivers, and a callback
// that resolves them.

import { print } from "../assembly/io";
import {
  assertWireOffsets,
  CLASS_JOB_DONE,
  ConfigBuilder,
  makeCallbacks,
  MODE_DIRECT,
  RuntimeSession,
  Subscription,
  SUBSCRIPTION_SIZE,
} from "../assembly/runtime";
import * as ogre from "../assembly/ogre";
import { EventRecord } from "../assembly/runtime/wire";
import { assertOgreWireOffsets, JOB_DONE } from "../assembly/ogre/wire";

/// What the last JOB_DONE delivery said.
let seenJob: i32 = 0;
let seenResource: u32 = 0;
let deliveries: u32 = 0;

function onEvent(class_: u32, ptr: u32): i32 {
  const record = changetype<EventRecord>(ptr);
  if (record.class_ == CLASS_JOB_DONE) {
    seenJob = <i32>record.a;
    seenResource = record.b;
    deliveries++;
  }
  return 0;
}

function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  // Nothing subscribes as batched in this fixture; the slot exists so the
  // record's second field is a real table index rather than zero.
  return 0;
}

/// A decimal string for 0 ..= 4294967295, built a digit at a time: the stub
/// runtime has no integer formatting, and the fixture needs two numbers in its
/// output line. Returns "0" for zero.
function decimal(value: u32): string {
  if (value == 0) return "0";
  let digits = "";
  while (value > 0) {
    digits = String.fromCharCode(48 + (value % 10)) + digits;
    value = value / 10;
  }
  return digits;
}

export function _start_game(): void {
  assertWireOffsets();
  assertOgreWireOffsets();

  const callbacks = makeCallbacks(onBatch, onEvent);
  const cfg = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(cfg, callbacks) == 0, "session_open refused the runtime's config");

  // The adapter: headless, because a stub that renders nothing is the only
  // honest config for a build that links no renderer.
  assert(ogre.init(ogre.ConfigBuilder.headless()) == 0, "ogre_init refused the config");

  // JOB_DONE as DIRECT: the class's default is batched, and this fixture wants
  // one callback per completed job.
  const subscription = changetype<Subscription>(heap.alloc(SUBSCRIPTION_SIZE));
  subscription.class_ = CLASS_JOB_DONE;
  subscription.mode = MODE_DIRECT;
  subscription.flags = 0;
  subscription.reserved = 0;
  assert(RuntimeSession.subscribe(subscription) == 0, "session_subscribe refused JOB_DONE");

  const job = ogre.queueMeshLoad("meshes/hero.glb", 0);
  assert(job > 0, "queueMeshLoad did not return a job id");

  // Poll rather than block, and the reason is worth reading before chunk 2.
  //
  // The stub has no background thread: its `publish` hook is what completes a
  // job, and a publish phase only runs when an epoch runs — which means
  // `session_wait(-1)` *before* any event exists would block forever, with the
  // work that would wake it unable to start. A real OGRE adapter runs its own
  // loader thread and posts when it finishes, so an infinite wait is safe
  // there; a stub that does its work in publish must be polled. (The same is
  // true of any capability whose completion depends on the epoch: the
  // `session_wait` contract is "block until an event", not "block until your
  // work is done".)
  //
  // `wait(0)` is the non-blocking epoch: it publishes (the job completes and
  // JOB_DONE is posted), then delivers what the publish produced, which on this
  // first call is that very event.
  let delivered = 0;
  for (let attempt: u32 = 0; attempt < 8 && deliveries == 0; attempt++) {
    delivered = RuntimeSession.wait(0);
    assert(delivered >= 0, "session_wait refused");
  }
  assert(deliveries == 1, "expected exactly one JOB_DONE delivery");
  assert(seenJob == job, "the event named a different job");
  assert(seenResource > 0, "the event carried no resource id");
  assert(ogre.jobState(job) == JOB_DONE, "the job record is not DONE");
  assert(ogre.jobResult(job) == seenResource, "the record and the event disagree");

  print("OK " + decimal(<u32>seenJob) + " " + decimal(seenResource));

  assert(ogre.releaseJob(job) == 0, "job_release refused");
  assert(RuntimeSession.close() == 0, "session_close refused");
}
