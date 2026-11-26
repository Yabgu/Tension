// Can a program replace **main's** default step policy? Yes.
//
// Main is an executor like any other. The shell builds it with `__mainStep__`
// (drain the inbox, drive one ready slot, return false) and then calls
// `__setDefaultMainStep` with the program's own `mainStep` if one exists. So a
// program that declares `mainStep` replaces the policy for the thread every
// program starts on — no flag, no extra import.
//
// The proof is a counter *inside* the step: if the shell were still running
// `__mainStep__` directly, `ourSteps` would stay 0.

import { Executor, __mainStep__ } from "~lib/thread";
import { print } from "../../../../tension-framework";

/** Iterations this program's step has taken. Zero would mean "not installed". */
let ourSteps: i32 = 0;

/**
 * Main's step, written by the program.
 *
 * It wraps the standard step rather than replacing the work: a real override
 * decides its own order of "directed work" then "queued work", and this one
 * adds observable counting on top of the default policy so the installation is
 * visible.
 */
export function mainStep(e: Executor): bool {
  ourSteps++;
  return __mainStep__(e);
}

async function step(x: i32): i32 {
  await 1;
  return x * 10;
}

export async function main(): i32 {
  print("phase: start");
  let before = ourSteps;
  let a = await step(1);
  let b = await step(2);
  print("installed: " + (ourSteps > before ? 1 : 0).toString());
  print("steps: " + ourSteps.toString());
  print("value: " + (a + b).toString());
  return 0;
}
