// A **complete** replacement of main's step — not a wrapper around
// `__mainStep__`.
//
// `async/main-policy.ts` wraps the default, which answers "can I observe it".
// This one answers the stronger question: can a program own the scheduling
// decision itself? It can, because `mainStep` is an ordinary exported function
// and the shell installs whichever one exists.
//
// What this step does differently from the default:
//
//   default (`__mainStep__`)   drain every inbox request, then drive one slot
//   this one                   drive two slots, then drain **one** request
//
// The order is a scheduling policy, not decoration: draining first serves
// newcomers and starves parked tasks when the inbox is never empty; driving
// first does the opposite. The two counters below show which happened, so the
// transcript is a record of the decision rather than a claim about it.
//
// `__drainInbox` and `driveReady` are the building blocks, both exported from
// `~lib/thread`, which is what makes a step writable at all.

import { Executor, __drainInbox, driveReady } from "~lib/thread";
import { print } from "../../../../tension-framework";

let iterations: i32 = 0;
let drains: i32 = 0;

/**
 * Main's step, owned by this program.
 *
 * Returning `true` ends the loop; this one never does, which is the same
 * contract `__mainStep__` keeps.
 */
export function mainStep(e: Executor): bool {
  iterations++;
  // **Two slots before any inbox work** — the policy decision.
  driveReady(e);
  driveReady(e);
  // Then one request, so an inbox that never empties cannot starve the queue.
  __drainInbox(e);
  drains++;
  return false;
}

async function step(x: i32): i32 {
  await 1;
  return x + 100;
}

export async function main(): i32 {
  print("phase: start");
  let a = await step(1);
  let b = await step(2);
  let c = await step(3);
  print("iterations: " + iterations.toString());
  print("drains: " + drains.toString());
  print("value: " + (a + b + c).toString());
  return 0;
}
