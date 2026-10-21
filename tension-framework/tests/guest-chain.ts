// tension-framework/tests/guest-chain.ts — a task awaiting a *suspending guest
// task* (0.7.0).
//
// The shape none of the other fixtures covers, and the one that deadlocked: a
// task parked on another task's own record rather than on a producer key.
//
//   outer()  awaits  inner()       -- a class-0 record; no producer key, so
//   inner()  parks on (FRAME, 0)      the host is never told about it
//
// `inner` suspends, so `outer`'s `await` genuinely parks. The host resumes
// `inner` on the frame clock; `inner` completes and `__taskCompleteResult`
// settles its record, which is where `outer` must be woken from. Nothing in the
// host knows `outer` exists — its rendezvous is the handle, not a key.
//
// Measured as a deadlock before the fix: `wake` filtered out every state with
// `slot >= 0` ("the host owns this one"), a rule written when a slot was
// allocated at park. Pre-park registration gives every task a slot at creation,
// so the filter dropped everything and `outer` was resumed by nobody — the guest
// printed "awaiting inner" and hung, rc=124.
//
// The fix is the rendezvous rule: a state parked on a producer key is the
// host's; one parked on a guest task's own record is the guest's, drained at the
// top of the next host entry (`__taskWake`/`__taskResume`/`__taskFail`).

import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

let over: bool = false;

/// Suspends: parks on (FRAME, 0).
async function inner(): i32 {
  await rt.frame();
  return 7;
}

/// Awaits a *guest task* that suspends — a class-0 record, no producer key.
async function outer(): void {
  print("CHAIN outer: awaiting inner");
  const v: i32 = await inner();
  print("CHAIN outer: got " + v.toString());
  over = true;
}

export function _game_running(): i32 { return over ? 0 : 1; }

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);
  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("CHAIN FAIL open"); over = true; return;
  }
  outer();
}
