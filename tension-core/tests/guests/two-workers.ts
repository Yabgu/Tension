// Two workers, twelve tasks: every value observed exactly once, by main.
//
// The third thread test, and the one that would catch a ring that loses or
// duplicates an entry: the tasks alternate between the two workers, so a
// misrouted request shows up as a wrong *worker* sum and a lost or doubled reply
// as a wrong *value* sum. Nothing here needs a per-task acknowledgement — the
// sums and the count are enough, because every task's value is unique.
//
// # One request in flight at a time, and why
//
// The obvious shape posts all twelve and pumps once. That shape returns the
// **last** posted argument twelve times, and it does so under TensionScript's own
// Node harness (`tests/rt/gate4.js`) as well as under this host — measured on
// this pin (`0.14.1` at `03e0507b`) with a three-request fixture: `work` served
// three times and every serve read the third request's argument. So the four
// `__serveArg`/`__serveKey`/`__serveOrigin` globals are not per-serve across a
// queue of servers, whatever the contract's "read them before the body's first
// suspension" says. Posting one, pumping until it is observed, and posting the
// next sidesteps it; the milestone report carries the measurement. **When that
// is fixed upstream, the loop below is the thing to collapse.**
//
// Built by `build.mjs`; run by `tension-core/tests/threads.rs` with
// `--executors 2` (main plus two workers).

import {
  __executorExit,
  __selfExecutor,
  __serveArg,
  __serveOrigin,
  __spawnOn,
  __spawnThread,
  __threadJoin,
  mainExecutor,
  Executor,
} from "~lib/thread";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

/** How many tasks are posted. Twelve is even, so each worker gets six. */
const TASKS: i32 = 12;

let observed: i32 = 0;
let valueSum: i32 = 0;
let workerSum: i32 = 0;
/** Set once every task is in, so the pump knows when to stop. */
let finished: bool = false;

async function leaf(): i32 {
  return 0;
}

/**
 * Served in a worker: reply with `(self + 1) * 1000 + value`.
 *
 * The packing is the observation: the `1000`-block says *which* store served the
 * task, the remainder says which value it was handed.
 */
async function work(): i32 {
  let value = __serveArg();
  let reply = __serveKey();
  let origin = __serveOrigin();
  let self = __selfExecutor();
  await leaf();
  __spawnOn(origin, reply, (self + 1) * 1000 + value, 0);
  return 0;
}

/** Served in main: unpack, accumulate, and end the workers after the last. */
async function deliver(): i32 {
  let packed = __serveArg();
  await leaf();
  let worker = packed / 1000;
  let value = packed - worker * 1000;
  workerSum += worker;
  valueSum += value;
  observed += 1;
  return 0;
}

/** Drive main's executor until `target` replies have been seen. */
function pumpUntil(target: i32): i32 {
  let e: Executor = mainExecutor();
  let rounds = 0;
  while (observed < target && rounds < 4000000) {
    if (e.step(e)) break;
    ++rounds;
  }
  return rounds;
}

export async function main(): i32 {
  let _ = await leaf();
  return 0;
}

export function _start_game(): void {
  let workTask = work();
  let deliverTask = deliver();

  let spawned1 = __spawnThread(1, -1, 0);
  let spawned2 = __spawnThread(2, -1, 0);
  line("spawn1=" + spawned1.toString());
  line("spawn2=" + spawned2.toString());
  if (spawned1 != 0 || spawned2 != 0) return;

  let rounds: i32 = 0;
  for (let i: i32 = 0; i < TASKS; i++) {
    // Even values to executor 1, odd to executor 2.
    __spawnOn(1 + (i & 1), workTask.entry, i, deliverTask.entry);
    rounds += pumpUntil(i + 1);
  }
  line("pumpRounds=" + rounds.toString());
  line("observed=" + observed.toString());
  line("valueSum=" + valueSum.toString());
  line("workerSum=" + workerSum.toString());
  __executorExit(1);
  __executorExit(2);
  line("join1=" + __threadJoin(1).toString());
  line("join2=" + __threadJoin(2).toString());
}
