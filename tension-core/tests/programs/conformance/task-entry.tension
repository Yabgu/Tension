// A task entry that is **spawned, not called**: the body runs because the
// executor served the spawn entry, so its first line is reached from a
// continuation nobody wrote a call to.
import { print } from "../../../../tension-framework";
import { __spawnOn } from "~lib/thread";

async function work(): i32 {
  print("task entry"); // @stop
  await 1;
  return 0;
}

export async function main(): i32 {
  let task = work();
  __spawnOn(0, task.entry, 0, 0);
  return 0;
}
