// DL21 Part 2 (issue I52) — what a **second waiter on the same producer key** does.
//
// This is a **measurement**, not a fix. `ParkedTable` holds one entry per key and
// `ParkedTable::record` overwrites, answering the one it displaced, so two tasks
// awaiting the same `(class, key)` means the second displaces the first. Nothing
// reports it. This program is the log that says which of three things happens:
//
//   (a) both resumed — the displacement is harmless in this path;
//   (b) one resumed, the other became a strand and the refusal fired (exit 1);
//   (c) one resumed, the other vanished, exit 0 — a silent loss.
//
// # The shape, and why it is two *tasks* and not two awaits
//
// A worker's entry task cannot park (DL11 shape 1: `__taskBindTable` lands in the
// `$resume` body, so `state.slot` is -1 while the entry body runs). Parking needs
// a **nested** async function, so each waiter is its own `async` function called
// and not awaited: the call runs eagerly to its first `await`, parks there, and
// hands back a suspended handle. Two calls, two parked tasks, one key.
//
// The entry then returns **without awaiting either** — a worker's entry task
// could not park on them anyway — so both tasks are left in the store's table for
// the host's session loop to route a completion to.
//
// # What each run means
//
//   no `--post-completion`     both tasks park, nothing completes the key. The
//                              refusal's count is the measurement: the ledger holds
//                              **one** entry per key, so if the store recorded two
//                              parks and the refusal names one task, the ledger
//                              cannot see the second waiter.
//   `--post-completion 4,7`    one completion for the key. Whichever waiter the
//                              table still holds is resumed; the log says which,
//                              because each tags its own line.
//
// Build: `WAKE_FLAGS` in `scripts/build-test-programs.mjs` (THREAD_FLAGS minus
// `--enable stack-switching`), bundle **aa74d6a1**. No std or compiler change.
//
// Run:   tension-core --executors 2 [--post-completion 4,7] <artifact>
//        ^ host flags BEFORE the module path (I32)
import { Task, TaskRecord } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";
import { __spawnIndexOf } from "~lib/task-stack";
import { __executorExit, __spawnThread, __threadJoin } from "~lib/thread";

// The wake path's other half: a guest that wants a wake must export the push
// handler itself (DL19 A2) and, because of the load-time coexistence rule, must
// also export `_game_running` — `0` is truthful, this program wants no host frames.
export { __taskWake } from "~lib/task-rt";

export function _game_running(): i32 {
  return 0;
}

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

const CLASS_JOB_DONE: i32 = 4; // session/arena.rs:222

/** Header word 6: wakes the host has served this session (`thread.rs`). */
const HEADER_SERVED: usize = 6;

/** The one producer key both waiters await. */
const KEY: i32 = 7;

function pendingJob(key: i32): Task<i32> {
  const record = new TaskRecord();
  record.class_ = CLASS_JOB_DONE;
  record.key = key;
  const handle = new Task<i32>();
  handle._record = record;
  return handle;
}

/** Waiter `tag`: parks on the shared key, and says so on both sides of it. */
async function waiter(tag: i32): i32 {
  let job: Task<i32> = pendingJob(KEY);
  line("waiter " + tag.toString() + ": BEFORE the await");
  let v: i32 = await job;
  line("waiter " + tag.toString() + ": AFTER the await, value=" + v.toString());
  return v;
}

async function workerEntry(): i32 {
  __taskBindTable(16);
  line("worker: starting two waiters on class 4 key 7");
  // Two calls, neither awaited: each runs to its first `await` and parks, leaving
  // a suspended task behind. Deliberately in this order, so "the second displaced
  // the first" and "the first was kept" are distinguishable in the log.
  let first: Task<i32> = waiter(1);
  let second: Task<i32> = waiter(2);
  line("worker: both waiters started");
  // The handles are dropped on purpose: the entry cannot park on them (a worker's
  // entry task has no slot), and what this run measures is the host's routing, not
  // a join. Referencing them keeps the compiler from eliminating the calls.
  if (first._record == second._record) line("worker: one record for both (unexpected)");
  return 0;
}

export function _start_game(): void {
  line("main: spawning");
  let index = __spawnIndexOf(workerEntry);
  line("main: index=" + index.toString());
  line("main: spawn=" + __spawnThread(1, index, 0).toString());

  // Wait for the host to have served a wake, bounded so a broken run reports
  // rather than hangs. The control block is the one region every store addresses
  // identically — a worker's heap flag is in its own arena (DL20 A1).
  let served = <usize>__controlBase + HEADER_SERVED * 4;
  let spins: i32 = 0;
  while (atomicLoad<i32>(served) == 0 && spins < 200000000) spins++;
  line("main: wakes served=" + atomicLoad<i32>(served).toString());

  __executorExit(1);
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
