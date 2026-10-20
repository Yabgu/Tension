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
// The std's task machine: the table the push path parks in (0.7.0a).
import { __taskBindTable } from "~lib/task-rt";

// The host's wake entry. Re-exported because the linker drops an export the
// guest never names, and the host resolves `__taskWake` by name at load.
export { __taskWake } from "~lib/task-rt";

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

/// The whole guest life, as one task (0.7.0b).
///
/// `await` here parks *this* task on `(FRAME, 0)` and the host's loop wakes it.
/// Nothing composes another async layer above it.
async function run(): void {
  // Declared before the first await: the transform scopes a local declared
  // after one to its own resume guard.
  let frames: i32 = 0;

  print("async-io: awaiting guest tasks");

  // `handle` is a name the state struct reserves, so the handle is `pipelineTask`.
  const pipelineTask: Task<i32> = pipeline();
  // `await` already ran inside pipeline(); the record holds its return value.
  print("  pipeline() completed with " + pipelineTask._record.payload.toString());

  // The frame loop: three frames from the host. This is the scheduler's
  // "nothing to do" path on a real session — no task is parked between these
  // awaits — so it costs three wakeups and exercises the loop's exit.
  while (frames < 3) {
    await rt.frame();
    frames += 1;
  }

  print("  no task left to resume: " + (rt.hasRunnable() ? "false" : "true"));
  print("--- end ---");

  RuntimeSession.close();
  finished = true;
}

/// 1 while the guest wants the host to drive it (0.7.0a). Cleared after the
/// session is closed, so the host's exit cannot cut the closing line off.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}

export function _start_game(): void {
  // Bind the completion classes to their families before any await can park
  // (§3.1). Harmless with no producer attached: an unbound class is its own
  // family, and the binding is what makes a failure class resolve the same task.
  rt.start();
  // The table the push path parks slots in (0.7.0a); one task parks at a time.
  __taskBindTable(8);

  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("async-io: the session refused to open (" + opened.toString() + ")");
    finished = true;
    return;
  }

  // A floating task: it runs to its first `await rt.frame()` and parks. From
  // here the host owns the loop.
  run();
}
