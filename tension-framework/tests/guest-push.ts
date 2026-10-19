// tension-framework/tests/guest-push.ts — the first end-to-end push path.
//
// 0.7.0a's gate before any example adopts the host-owned loop. A guest that
// exports `__taskWake` and `_game_running`:
//
//   1. `_start_game` binds the task table, opens the session, and starts a task
//      that parks on a job completion — then returns.
//   2. The host loop runs: wait, epoch, match, `__taskWake(ids)`.
//   3. The task resumes, `_game_running()` turns 0, the loop exits.
//
// The completion itself is pre-queued by the runner (`--post-test-events` posts
// three JOB_DONE records before the guest runs). What that tests is the part
// that did not exist before: the *match* and the *wake*. The record arrives
// through the publisher, the host's scheduler table resolves `(family, key)` to
// the parked task id, and the id crosses back as `__taskWake` — not through
// `__taskTick`, which this guest never calls.

import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

// The host resolves this export by name; nothing in guest code calls it, so
// without the re-export DCE drops it and the load-time coexistence check fails.
export { __taskWake } from "~lib/task-rt";

/// Set when the awaited task has resumed — what `_game_running` reports.
let finished: bool = false;
/// Set when the run is over for any reason, so the loop stops either way.
let over: bool = false;

async function waiter(): void {
  // `--post-test-events` posts JOB_DONE for job ids 1, 3 and 5. Job 1 is this
  // one: the await parks on `(JOBS, 1)` and only the push wake can resume it.
  const parked: Task<u32> = rt.job(1);
  const resumed: u32 = await parked;
  print("PUSH resumed with " + resumed.toString());
  finished = true;
  over = true;
}

/// 1 while the guest still wants the host to drive it.
export function _game_running(): i32 {
  return over ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);

  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("PUSH FAIL the session refused to open (" + opened.toString() + ")");
    over = true;
    finished = true;
    return;
  }

  // Parks here; the host loop's wake is what resumes it.
  waiter();
  print("PUSH parked, _start_game returning");
}
