// The schedule, made visible: three policies and a step the program owns.
//
// `main-policy.ts` answers "can a program replace main's step?" — yes, and it
// wraps the default. `main-step-replaced.ts` answers "can it own the decision?"
// — yes, and it drives two slots before draining. This program answers the
// question both leave open: **can the order be a policy's choice?**
//
// Three rows, all visible in the transcript:
//
//   eager    `create` drives the task, so its prefix runs at the call site.
//   ranked   `create` **submits** (`__submitTask`) and runs nothing; the rank
//            is the policy's own field, read back through the task
//            (`__taskAt(slot).policy`), so a task's policy is readable after
//            the fact rather than hidden inside the scheduler.
//   step     `mainStep` resumes the highest-ranked ready task each iteration,
//            so creation order 1, 5, 9 produces enter order 9, 5, 1 — which no
//            FIFO step can produce.
//
// `__mainStep__` is never called. Every primitive below comes from
// `~lib/thread`, which is what makes a step writable at all.
//
// The transcript is the schedule, one line per event:
//
//   enter <name> / resume <name> <rank> / value <name> <n> / steps <n>
//
// ## Two compiler limits this program is written around (both measured)
//
// 1. **No nested loop over an `Array` in a stack-switching module.** The
//    insertion sort this step started with aborts the compiler
//    (`Binaryen mixed_arena: index < usedElements`) on the incremental runtime,
//    with or without `unchecked`. The step therefore keeps one candidate and
//    stashes the rest in a `SlotRing`, which is a flat pair of loops.
// 2. **No string concatenation of a captured parameter.** `"enter " + name` in
//    a parameterized async body also trips the same assert; the bodies print
//    literals instead, and the rank carries the identity.

import {
  Executor,
  SlotRing,
  __drainInbox,
  __submitTask,
  __taskAt,
  __resumeTask,
} from "~lib/thread";
import { TaskBase, TaskPolicy, __inlineAwait } from "~lib/task";
import { print } from "../../../../tension-framework";

/** Eager: the prefix runs at the call site, because `create` drives the task. */
@final class Eager extends TaskPolicy {
  create(task: TaskBase): void {
    task.drive();
  }
  await(task: TaskBase): void {
    if (!task.settled) __inlineAwait(task);
  }
}

/** Ranked: `create` **submits** and runs nothing; the step decides the turn. */
@final class Ranked extends TaskPolicy {
  rank: i32;
  constructor(rank: i32) {
    super();
    this.rank = rank;
  }
  create(task: TaskBase): void {
    __submitTask(task);
  }
  await(task: TaskBase): void {
    if (!task.settled) __inlineAwait(task);
  }
}

/** A slot's rank, or `-1` for a slot that is not a ranked task (main, a leaf). */
function rankOf(slot: i32): i32 {
  let taskOrNull = __taskAt(slot);
  if (!taskOrNull) return -1;
  let policy = changetype<TaskBase>(taskOrNull).policy;
  if (!policy) return -1;
  return changetype<Ranked>(policy).rank;
}

/** Steps taken, so the transcript can say the loop ran. */
let steps: i32 = 0;

/** Where the non-chosen ready slots wait while the step picks one. */
let scratch: SlotRing | null = null;

/**
 * Main's step, written by the program.
 *
 * `__mainStep__` is drain-then-one-slot in ring order. This one is
 * drain-then-one-slot in **rank** order: everything ready goes to a scratch
 * ring while the highest rank is remembered, then the rest go back and the
 * chosen task is resumed. One resume per iteration, so each transcript line is
 * a decision this loop made.
 */
export function mainStep(e: Executor): bool {
  steps++;
  __drainInbox(e);
  let ring = scratch;
  if (!ring) {
    ring = new SlotRing(64);
    scratch = ring;
  }
  let best = -1;
  let bestRank = -1000000;
  let slot = e.ready.pop();
  while (slot >= 0) {
    let r = rankOf(slot);
    if (r > bestRank) {
      // The previous best is no longer the best, so it waits with the others.
      if (best >= 0) ring.push(best);
      bestRank = r;
      best = slot;
    } else {
      ring.push(slot);
    }
    slot = e.ready.pop();
  }
  // Back in the order they were stashed, so relative order survives the scan.
  let back = ring.pop();
  while (back >= 0) {
    e.ready.push(back);
    back = ring.pop();
  }
  if (best >= 0) {
    let taskOrNull = __taskAt(best);
    // A settled task must not be resumed: `driveReady` guards the same way, and
    // the ready ring can outlive a settlement (two waiters, one task).
    if (!taskOrNull || !changetype<TaskBase>(taskOrNull).settled) {
      let awaited = __resumeTask(best);
      if (awaited >= 0) e.ready.push(awaited);
    }
  }
  return false;
}

/** A real suspension point: the caller parks, so the step decides what runs next. */
async function yieldPoint(rank: i32): i32 {
  await 1;
  return rank;
}

// One body per rank, each printing a literal: a name captured as a `string` and
// concatenated in the body hits the compiler assert noted in the header.
async function low(): i32 {
  print("enter low");
  let v = await yieldPoint(1);
  print("resume low 1");
  return v;
}

async function mid(): i32 {
  print("enter mid");
  let v = await yieldPoint(5);
  print("resume mid 5");
  return v;
}

async function high(): i32 {
  print("enter high");
  let v = await yieldPoint(9);
  print("resume high 9");
  return v;
}

async function eager(): i32 {
  print("enter eager");
  let v = await yieldPoint(7);
  print("resume eager 7");
  return v;
}

export async function main(): i32 {
  print("main: enter");
  // Eager first, so the two ways of making a task run sit side by side in one
  // transcript: `drive` inside `create` for work that must start now,
  // `__submitTask` for work whose turn the step decides.
  let e1 = eager() on new Eager();
  // Creation order 1, 5, 9. Nothing runs: `create` only submits.
  let a1 = low() on new Ranked(1);
  let b1 = mid() on new Ranked(5);
  let c1 = high() on new Ranked(9);
  // Awaited in creation order, resumed in rank order — which is the point, and
  // the values arrive either way.
  let a = await a1;
  let b = await b1;
  let c = await c1;
  let d = await e1;
  print("value low " + a.toString());
  print("value mid " + b.toString());
  print("value high " + c.toString());
  print("value eager " + d.toString());
  print("steps " + steps.toString());
  return 0;
}
