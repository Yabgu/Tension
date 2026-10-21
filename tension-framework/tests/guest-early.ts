// tension-framework/tests/guest-early.ts — a completion that arrives before its
// park is not lost (0.7.0d-pre).
//
// The push path's second mechanism. The host matches published records to parked
// tasks; a record with **no waiter** used to be dropped, which is invisible while
// the pull path is also running (the guest's own buffer caught it) and fatal once
// it is not: the AI stream posts READY then DONE for one key in one epoch, and
// the second arrival found the table entry already taken by the first — measured
// as the failed retirement's `C2 readyWakes=0 firstPayload=0`.
//
// What this fixture forces, deterministically:
//
//   * `--post-test-events` queues JOB_DONE for job ids 1, 3 and 5 **before the
//     guest runs**, so the first epoch publishes them with nobody parked;
//   * the guest does not park immediately: it waits two frames first, so at
//     least one epoch with no waiter has certainly run;
//   * then it parks on job 5 and must resume with that record's payload.
//
// With the recent-completions table the record waits and the park claims it.
// Without it the completion was dropped at the epoch and the park waits forever
// — the two outcomes are a pass and a timeout, and nothing in between.

import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

// The host resolves all three by name; nothing in guest code calls them, so
// without the re-exports DCE drops them and the load-time check fails.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

let over: bool = false;

async function lateWaiter(): void {
  // The handle is created before any park — it is only a stamped record — and
  // awaited after two frames. Those two frames are at least one epoch, so job
  // 5's record is published while nothing is waiting for it.
  await rt.frame();
  await rt.frame();
  const resumed: u32 = await rt.job(5);
  if (resumed == 6) {
    print("EARLY resumed with " + resumed.toString() + " (buffered before the park)");
  } else {
    print("EARLY FAIL resumed with " + resumed.toString() + ", not 6");
  }
  over = true;
}

export function _game_running(): i32 {
  return over ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);

  // No callbacks: the guest must not be able to rescue the record itself. What
  // is under test is the host's table, not the pull path's.
  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("EARLY FAIL the session refused to open");
    over = true;
    return;
  }

  lateWaiter();
}
