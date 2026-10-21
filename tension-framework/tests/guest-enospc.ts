// tension-framework/tests/guest-enospc.ts — a refused task creation is answered,
// not stranded (0.7.0d-pre).
//
// The second blocked mechanism. `__taskBindTable(capacity)` used to bound
// *parked* tasks: the slot was allocated at park, so a full table meant the park
// had nowhere to put the task — and the -ENOSPC refusal had no id to fail. The
// task stranded with nothing coming, which is the failure mode §5.1 exists to
// forbid ("a refusal must never leave the task parked with nothing coming").
//
// Now the slot is claimed at **creation**. Capacity bounds live tasks, the id is
// the task's handle for its whole life, and a task that cannot get one is
// settled with -ENOSPC before its body runs — so the caller's `await` falls
// through on the settled record instead of suspending.
//
// What this forces:
//
//   * a two-slot table;
//   * two tasks that each park on a pre-posted job (1 and 3) and therefore hold
//     both slots;
//   * a third task, created while they hold them, whose registration must fail.
//
// It prints the third's status and then lets the loop drain: the epoch resumes
// the two parked fillers, they complete, and the loop reaches its exit with
// nothing parked. Remove the creation-time claim and the third task either parks
// (growing the table) or strands — either way the status is not -ENOSPC.

import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

const ENOSPC: i32 = -28;

let over: bool = false;

/// Parks on a job the runner has already completed; a filler.
async function filler(job: i32): void {
  const parked: Task<u32> = rt.job(job);
  const value: u32 = await parked;
  print("ENOSPC filler " + job.toString() + " resumed with " + value.toString());
}

/// Created while the table is full: its registration is refused.
async function refused(): i32 {
  print("ENOSPC FAIL the refused task's body ran");
  return 1;
}

export function _game_running(): i32 {
  return over ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  // Two slots, deliberately: the bound is live tasks, and this fixture wants it
  // reached.
  __taskBindTable(2);

  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("ENOSPC FAIL the session refused to open");
    over = true;
    return;
  }

  filler(1);   // claims slot 0 and parks
  filler(3);   // claims slot 1 and parks

  const third: Task<i32> = refused();   // no slot left
  const status: i32 = third._record.status;
  if (status == ENOSPC) {
    print("ENOSPC third task settled with " + status.toString() + " (no slot, no body)");
  } else {
    print("ENOSPC FAIL third task settled with " + status.toString() + ", not -ENOSPC");
  }

  // The verdict is printed; the loop drains the two fillers and stops on its own.
  over = true;
}
