// The fallback loop, made visible.
//
// When `main` suspends, control does not return to a scheduler in the host — it
// drops into the executor's **step**, which decides what runs next. That is the
// "fallback" the whole design turns on: a suspension is a *yield to our own
// loop*, not a return to C.
//
// This program installs a step that prints one line per iteration, then does
// three suspensions. The transcript therefore shows the loop turning, with the
// task that is parking and the slot it parks on named in `~lib/thread`'s terms:
//
//   loop 1  main is resumed; `a`'s body runs and suspends on its own task
//   loop 2  `a` completes; main resumes with the value
//   loop 3  `b`'s body runs and suspends
//   ...
//
// The count is the assertion: fewer iterations than suspensions would mean the
// loop stopped resuming; more would mean it spun.

import { Executor, __mainStep__ } from "~lib/thread";
import { print } from "../../../../tension-framework";

/** Every iteration of main's step. */
let iterations: i32 = 0;

/** The iteration on which each suspension was observed, in order. */
let marks: i32 = 0;

export function mainStep(e: Executor): bool {
  iterations++;
  return __mainStep__(e);
}

async function step(x: i32): i32 {
  await 1;
  marks = iterations;
  return x + 1;
}

export async function main(): i32 {
  print("phase: start");
  let a = await step(1);
  print("after a: " + marks.toString());
  let b = await step(2);
  print("after b: " + marks.toString());
  let c = await step(3);
  print("after c: " + marks.toString());
  print("iterations: " + iterations.toString());
  print("value: " + (a + b + c).toString());
  return 0;
}
