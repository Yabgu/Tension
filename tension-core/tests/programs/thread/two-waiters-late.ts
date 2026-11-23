// DL22 Part 1 (issue I53) — two waiters on one key, and a completion posted **after
// both have parked**.
//
// This is the ordering DL21 could not produce. DL21's `--post-completion` posts at
// startup, so its completion sits in the sticky buffer and the *first* park claims
// it — one waiter resumes, one is displaced in the ledger, and the refusal fires,
// which is (b). A real producer posts later: the loading zone's worker parks, the
// I/O lands, *then* the completion arrives. That ordering is the one that could
// abandon a task without saying so, and it is what this program measures.
//
// # The two runs, and what each is for
//
//   `--post-completion-after-parks 4,7,2`
//       The host arms a watch at startup and posts once its park seam has seen
//       **two** parks on the pair. Both waiters are parked by then; the post
//       therefore wakes whichever waiter the ledger still holds, and the other is
//       abandoned. On the engine before DL22 the process exits **0** — the silent
//       loss. After DL22 it exits **1** and names the abandoned task.
//
//   `--post-completion 4,7`
//       The mirror: the same guest, the completion waiting *before* the parks. The
//       first park claims it, one waiter resumes, the other strands and the
//       refusal fires (exit 1). This is DL21's measured behaviour and must not
//       change — it is the control that keeps this round from having moved wake
//       semantics under cover of fixing the count.
//
// # Which waiter resumes, and why the tags matter
//
// `ParkedTable` keeps one entry per key, and the *later* park overwrites the
// earlier one, so the ledger holds the **second** waiter (task 1). A post that
// arrives after both parks therefore wakes waiter 2, and waiter 1 is the one
// abandoned. The tags make that visible in the log instead of inferable from a
// count, which is why every line carries its own id.
//
// # The shape, and why it is two *tasks* and not two awaits
//
// A worker's entry task cannot park (DL11 shape 1: `__taskBindTable` lands in the
// `$resume` body, so `state.slot` is -1 while the entry body runs). Parking needs a
// **nested** async function, so each waiter is its own `async` function called and
// not awaited: the call runs eagerly to its `await`, parks, and hands back a
// suspended handle. Two calls, two parked tasks, one key.
//
// Build: `WAKE_FLAGS` in `scripts/build-test-programs.mjs` when it is built as a
// test guest; by hand it is THREAD_FLAGS minus `--enable stack-switching`, bundle
// **aa74d6a1** (I44). No std or compiler change.
//
// Run:   tension-core --executors 2 --post-completion-after-parks 4,7,2 <artifact>
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
  // Two calls, neither awaited: each runs to its first `await` and parks, leaving a
  // suspended task behind. The order is deliberate — waiter 1 parks first and is
  // therefore the one the ledger's single slot loses.
  let first: Task<i32> = waiter(1);
  let second: Task<i32> = waiter(2);
  line("worker: both waiters started");
  // The handles are dropped on purpose: the entry cannot park on them (a worker's
  // entry task has no slot). Referencing them keeps the compiler from eliminating
  // the calls.
  if (first._record == second._record) line("worker: one record for both (unexpected)");
  return 0;
}

export function _start_game(): void {
  line("main: spawning");
  let index = __spawnIndexOf(workerEntry);
  line("main: index=" + index.toString());
  line("main: spawn=" + __spawnThread(1, index, 0).toString());

  // Wait for the host to have served a wake, bounded so a broken run reports rather
  // than hangs. The control block is the one region every store addresses
  // identically — a worker's heap flag is in its own arena (DL20 A1).
  let served = <usize>__controlBase + HEADER_SERVED * 4;
  let spins: i32 = 0;
  while (atomicLoad<i32>(served) == 0 && spins < 200000000) spins++;
  line("main: wakes served=" + atomicLoad<i32>(served).toString());

  __executorExit(1);
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
