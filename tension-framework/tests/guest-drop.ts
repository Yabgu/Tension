// tension-framework/tests/guest-drop.ts — a lost completion wakes with -EIO.
//
// 0.7.0c's gate. Before this, drop attribution lived in the guest
// (`rt.reportDrops` → `__taskReportDrops`), reached through `rt.runReady()` —
// which a host-owned loop never calls. A lost signal under a host loop parked
// forever. The rule now runs in the host, which owns the parked tables.
//
// The drop is forced, not simulated:
//
//   * `--post-test-events` queues three JOB_DONE records before the guest runs
//     (job ids 1, 3 and 5);
//   * the session is opened with `ringCapacity(CLASS_JOB_DONE, 2)`, so two are
//     published and the third finds the sub-ring full with nothing reclaimed
//     and is **dropped** (`subring.rs`: the session never overwrites a record
//     the guest has not consumed);
//   * the session is opened with **no callbacks**, so nothing drains the ring
//     and the guest never reclaims: the drop is deterministic rather than a
//     race;
//   * this guest parks on job 5 — the record that is dropped — so nothing but
//     the fail path can resume it.
//
// What must happen: the host's loop reads the class's drop delta, takes the
// parked task from the jobs family, and calls
// `__taskFail(ids, statuses, count)`. The task resumes with `status = -EIO` on
// the record it awaited. If the task prints anything else — or never resumes —
// the path is wrong.

import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";
import { print } from "../assembly/io";
import { ConfigBuilder, CLASS_JOB_DONE, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

// The host resolves both by name; nothing in guest code calls them, so without
// the re-exports DCE drops them and the load-time check fails.
export { __taskWake, __taskFail } from "~lib/task-rt";

/// -EIO: §4.4's lost completion.
const EIO: i32 = -5;

let over: bool = false;
let sawStatus: i32 = 1;

async function waiter(): void {
  // Job 5's record is the one the ring refuses: three posts, capacity two.
  const parked: Task<u32> = rt.job(5);
  await parked;
  sawStatus = parked._record.status;
  if (sawStatus == EIO) {
    print("DROP woke with status " + sawStatus.toString() + " (-EIO)");
  } else {
    print("DROP FAIL woke with status " + sawStatus.toString() + ", not -EIO");
  }
  over = true;
}

/// 1 while the guest still wants the host to drive it.
export function _game_running(): i32 {
  return over ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);

  // No callbacks, a two-slot ring: the third record is dropped by the session,
  // not by the guest. A guest that drained would hide the case this proves.
  const cfg = ConfigBuilder.forThisBuild(null).ringCapacity(CLASS_JOB_DONE, 2);
  if (RuntimeSession.open(cfg) != 0) {
    print("DROP FAIL the session refused to open");
    over = true;
    return;
  }

  waiter(); // parks on (JOBS, 5) and returns; the host owns the loop now
}
