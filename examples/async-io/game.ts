// The async example: `await` a guest task, from a program that opens a real
// session and runs a real frame loop.
//
//   npm start
//
// ## What this shows
//
// `pipeline()` awaits two tasks and adds their values. Each `compute()` finishes
// inside its own entry, so by the time `await` runs the record is already
// settled: the await falls through, and the value it reads is the one the
// callee's return stored in the record (`__taskCompleteResult`, §4.7.3). The
// frame loop below then ticks the scheduler — `RuntimeSession.wait(...)` yields,
// `rt.runReady()` resumes whatever is ready — which is the shape every game
// loop uses once a task actually suspends.
//
// ## What it does not show, and why
//
// A *suspension* — a task that parks on a completion it has not received yet —
// needs a producer that posts one. The only producers in this tree are
// capabilities: OGRE's loader (job and resource classes) and the input adapter.
// There is no capability-free job producer, so this example awaits tasks, not
// jobs. The job path (`rt.job(id)` + a real JOB_DONE) is the OGRE integration
// test's job — `tension-framework/tests/guest-async.ts`, Phase 4c — where a
// genuine cross-thread completion exists to wait for.

import {
  ConfigBuilder,
  RuntimeSession,
  print,
  rt
} from "tension-framework";
import { Task } from "~lib/task";

/** A task that finishes inside its own entry: no park, a settled record. */
async function compute(seed: i32): i32 {
  let value: i32 = seed * 2;
  return value + 1; // 41 -> 83's halves; the record carries this
}

/** Awaits two tasks in sequence and adds them. */
async function pipeline(): i32 {
  let a: i32 = await compute(20); // 41
  let b: i32 = await compute(20); // 41
  return a + b + 1;                // 83
}

export function _start_game(): void {
  // Bind the completion classes to their families before any await can park
  // (§3.1). Harmless with no producer attached: an unbound class is its own
  // family, and the binding is what makes a failure class resolve the same task.
  rt.start();

  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("async-io: the session refused to open (" + opened.toString() + ")");
    return;
  }

  print("async-io: awaiting guest tasks");

  const handle: Task<i32> = pipeline();
  // `await` already ran inside pipeline(); the record holds its return value.
  print("  pipeline() completed with " + handle._record.payload.toString());

  // The frame loop every async game runs: yield, then resume what is ready.
  // Three ticks is plenty here — nothing is parked — and it exercises the
  // scheduler's "nothing to do" path on a real session.
  for (let frame: i32 = 0; frame < 3; frame++) {
    RuntimeSession.wait(0);
    rt.runReady();
  }

  print("  no task left to resume: " + (rt.hasRunnable() ? "false" : "true"));
  print("--- end ---");

  RuntimeSession.close();
}
