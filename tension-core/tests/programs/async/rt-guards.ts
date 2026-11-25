// The framework's guards, exercised from a guest.
//
// **What this replaces.** `tension-framework/tests/rt-dispatch.mjs` compiled a
// small probe and instantiated it under a JS proxy that answered every import
// with zeros. That harness existed to reach one state a normal run has:
// **no session open and no task table**. This program is that probe, run by
// `tension-core` itself (`tests/framework_guards.rs`), which is the host whose
// guards are being claimed.
//
// The state is real here: the program declares no session import, so the host
// creates none (`host/guest.rs` scopes the session to a module that imports
// it). Every completion class is unbound, the region table at address 0 is not
// a table, and `rt.start()`/`rt.job()`/`rt.onEvent()` must return rather than
// trap or read out of bounds. The one assertion this program cannot make is the
// **park**: on the stackful backend an `await` with no producer parks until the
// core loop has nothing runnable and idles forever, which is the behaviour
// `async-on-main` proves on purpose. The state-machine lowering used here parks
// through `scheduler::park`, whose no-table answer is a return; the line
// `resumed-after-park=0` is the observation, and if that ever blocked the test
// would time out rather than pass.
//
// Every line is `tag: value`, one observation per line, so a failure names the
// value that moved rather than a prose sentence.

import { rt } from "../../../../tension-framework/assembly/runtime/rt";
import { Task, TaskRecord } from "~lib/task";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

/** One line of UTF-8, the way `tension-framework`'s `print` does it. */
function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

/** Set only when a parked task is resumed; the guards must leave it at 0. */
let resumed: i32 = 0;

/**
 * Parks on `h`. With no table bound and no session open, the park must return
 * (the guard) rather than resume the task (a delivery) or trap (a wild read).
 */
async function awaitJob(h: Task<u32>): u32 {
  let v: u32 = await h;
  resumed = i32(v);
  return v;
}

/** The probe's own verdict: 41 when every guard held, negative at the first
 *  one that did not. Kept as a number so the failure is a value, not prose. */
function probe(): i32 {
  // No table bound, no session open: the state a fixture is in before
  // session_open. Every one of these must be inert rather than a trap.
  rt.start();                             // binds families; needs no session
  let handle: Task<u32> = rt.job(7);      // a stamped handle, no allocation
  awaitJob(handle);                       // parks with no table: returns
  if (resumed != 0) return -1;            // nothing delivered, so nothing ran
  if (rt.hasRunnable()) return -2;        // and nothing claimed to be ready

  // The dispatcher with no session: rt.deliver reads the region table only when
  // a session is open, so this must be a no-op, not an out-of-bounds read.
  let record: EventRecord = new EventRecord();
  record.class_ = 4;
  record.a = 7;
  record.b = 41;
  rt.onEvent(4, changetype<u32>(record));
  if (resumed != 0) return -3;

  return 41;                              // the guards held
}

/**
 * The byte layout `rt.onEvent` is given. A class, as in the JS probe, because
 * the pointer argument is an object reference; the fields are the ones the
 * dispatcher would read if a session were open.
 */
class EventRecord {
  seq: u64 = 0;
  class_: u32 = 0;
  flags: u32 = 0;
  a: u32 = 0;
  b: u32 = 0;
  f0: f32 = 0;
  f1: f32 = 0;
}

export function _start_game(): void {
  rt.start();
  line("start: ok");

  let handle: Task<u32> = rt.job(7);
  line("job-class: " + handle._record!.class_.toString());
  line("job-key: " + handle._record!.key.toString());
  line("job-settled: " + (handle.settled ? "1" : "0"));
  line("has-runnable-before: " + (rt.hasRunnable() ? "1" : "0"));

  awaitJob(handle);
  line("resumed-after-park: " + resumed.toString());

  let record: EventRecord = new EventRecord();
  record.class_ = 4;
  record.a = 7;
  record.b = 41;
  rt.onEvent(4, changetype<u32>(record));
  line("resumed-after-on-event: " + resumed.toString());

  line("ai-dropped: " + rt.aiDropped().toString());
  line("has-runnable-after: " + (rt.hasRunnable() ? "1" : "0"));
  line("guard-result: " + probe().toString());
}
