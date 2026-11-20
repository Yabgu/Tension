// Spawn a worker, post it work, receive the answer, join it.
//
// The shape is gate4 (d)'s in TensionScript's `tests/rt/gate4.js`, with two
// differences that make it a *host* test rather than a Node one: the indices a
// request carries are read from the task objects the transform already built
// (`TaskBase.entry`), so nothing has to be scraped out of a `.wat`; and the boot
// contract is the host's, not this file's — `__threadInit`, `__arenaInit` and
// `__start` have all run before `_start_game` is called.
//
// The three calls this guest makes that matter:
//
//   __spawnThread(1, -1, 0)          ask the host for a real OS thread
//   __spawnOn(1, work, 21, deliver)  post a request to executor 1
//   __threadJoin(1)                  wait on the record's state word
//
// `work` runs **in the worker's store**; `deliver` runs in main's, and that
// asymmetry is the whole point — a continuation cannot cross a store, an index
// can, so what crosses is a `$starts` index and the receiving store makes its
// own continuation.
//
// Built by `build.mjs`; run by `tension-core/tests/threads.rs` with
// `--executors 2`.

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

/** What the worker computed, as main learned it. */
let answer: i32 = -1;
/** The executor the reply came from — 1, if the request really crossed. */
let replyOrigin: i32 = -1;

async function leaf(): i32 {
  return 0;
}

/**
 * Served **in the worker's store**: double the argument and post it back.
 *
 * Zero-argument on purpose: `$starts` entries are canonical `() -> i32`, so a
 * served body takes no operands and reads its one `i32` through `__serveArg`.
 * `__serveKey` is the origin's reply index, which this store must not interpret.
 */
async function work(): i32 {
  let value = __serveArg();
  let reply = __serveKey();
  let origin = __serveOrigin();
  // `__selfExecutor()` rides back inside the value, so one `i32` proves both
  // "this ran in the worker" (id 1) and "the argument crossed" (21 -> 42):
  // `(1 + 1) * 100 + 42 = 242`.
  let self = __selfExecutor();
  await leaf();
  __spawnOn(origin, reply, (self + 1) * 100 + value * 2, 0);
  return 0;
}

/**
 * Served **in main's store**: record the answer, then end the worker.
 *
 * `__executorExit` is how main ends an executor deterministically — it writes
 * the state word and notifies, which is what releases both the worker's idle
 * wait and any `__threadJoin`.
 */
async function deliver(): i32 {
  let value = __serveArg();
  let origin = __serveOrigin();
  await leaf();
  answer = value;
  replyOrigin = origin;
  __executorExit(origin);
  return 0;
}

/**
 * Drive main's executor until the reply has landed.
 *
 * **Bounded, not `while (nothing queued)`.** The reply is produced by another
 * thread, so the queue is empty for a while before it exists; gate4's pump works
 * in Node because the reply is already there by the time it runs. The bound is
 * what makes a worker that never answers a printed count rather than a hang:
 * the guest says how many rounds it spent, and the test reads it.
 */
function pumpUntilAnswered(): i32 {
  let e: Executor = mainExecutor();
  let rounds = 0;
  while (answer < 0 && rounds < 2000000) {
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
  // Calling an async function creates its task and runs nothing. `entry` is the
  // `$starts` index of the spawn entry the transform synthesized; that index is
  // a fact of the module, so a store other than this one can resolve it.
  let workTask = work();
  let deliverTask = deliver();
  line("workIndex=" + workTask.entry.toString());
  line("deliverIndex=" + deliverTask.entry.toString());

  let spawned = __spawnThread(1, -1, 0);
  line("spawn=" + spawned.toString());
  if (spawned != 0) return;

  __spawnOn(1, workTask.entry, 21, deliverTask.entry);
  let rounds = pumpUntilAnswered();
  line("pumpRounds=" + rounds.toString());
  line("answer=" + answer.toString());
  line("replyOrigin=" + replyOrigin.toString());
  line("join=" + __threadJoin(1).toString());
}
