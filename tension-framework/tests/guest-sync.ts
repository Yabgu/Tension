// tension-framework/tests/guest-sync.ts — a synchronous async function, and the
// slot it must give back (0.7.0).
//
// The one path none of the other fixtures covers. `guest-push`, `guest-early`,
// `guest-enospc` and `guest-drop` all end in a park; this one never parks at all:
//
//   async function answer(): i32 { return 42; }
//
// The lowering is the same shape as any async function — the entry creates the
// handle, calls `__taskRegister` (which **claims a slot**, 0.7.0d-pre), runs the
// body, and the terminal calls `__taskCompleteResult` (which **frees it**) — but
// the body has no `await`, so the record is already settled when the caller's
// `await` checks it. The caller falls through on the settled record: no park, no
// `scheduler::park`, no wake, no ready queue.
//
// Two things this proves, and the second is the one that can fail silently:
//
//   1. **the value arrives** — 42 through the record, twelve times over;
//   2. **the slot comes back** — the table is four slots and this awaits twelve
//      tasks. A task that completes without freeing its slot looks exactly like
//      a parked one to the next registration, so the fifth would be refused with
//      -ENOSPC and return 0 instead of 42.
//
// The sum is the assertion: 12 × 42 = 504, and a single leaked slot makes it
// short. Measured both ways — with `finishTask` in `__taskComplete`, 504; with it
// removed, the fifth await returns 0 and the sum is short.

import { __taskBindTable } from "~lib/task-rt";
import { Task } from "~lib/task";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

const SLOTS: i32 = 4;
const ROUNDS: i32 = 12;
const EXPECTED: i32 = 42;
const TOTAL: i32 = 504; // ROUNDS * EXPECTED

let over: bool = false;

/// A task that finishes inside its own entry: no `await`, so no park.
async function answer(): i32 {
  return 42;
}

/// The whole guest: twelve synchronous awaits, then one real park, then exit.
async function run(): void {
  let total: i32 = 0;
  let rounds: i32 = 0;
  // The bound is declared before the first await; the loop condition carries
  // everything the transform refuses (`break`, `continue`).
  while (rounds < ROUNDS) {
    const value: i32 = await answer();
    total += value;
    rounds += 1;
  }
  if (total != TOTAL) {
    print("SYNC FAIL " + ROUNDS.toString() + " awaits summed " + total.toString() +
          ", not " + TOTAL.toString() + " (a slot did not come back)");
    over = true;
    return;
  }
  print("SYNC " + ROUNDS.toString() + " synchronous awaits summed " + total.toString());

  // A real park after all that: if the twelve had held their slots, four would
  // have exhausted the table and this task's creation would have been refused —
  // the same -ENOSPC the sum above would already have caught.
  const parked: Task<u32> = rt.job(1);
  const resumed: u32 = await parked;
  if (resumed != 2) {
    print("SYNC FAIL the park after the sync rounds resumed with " + resumed.toString());
    over = true;
    return;
  }
  print("SYNC park after the sync rounds resumed with " + resumed.toString());
  over = true;
}

export function _game_running(): i32 {
  return over ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  // Four slots against twelve tasks: the bound is live tasks, and this fixture
  // reaches it repeatedly.
  __taskBindTable(SLOTS);

  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("SYNC FAIL the session refused to open");
    over = true;
    return;
  }

  run();
}
