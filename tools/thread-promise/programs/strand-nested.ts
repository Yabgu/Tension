// W13 Phase C — a reconstruction of DL11 §2's `strand-nested` (shape 2).
//
// WHAT THIS IS NOT: byte-identical to DL11's original. DL11's source was
// written to /tmp/dl11 and never committed; its artifact was 30,751 B /
// sha256 ef56d394a653b2c1…33dbd9. That file cannot be recovered from any
// branch of either repository, so this is a rebuild from DL11's report — its
// own code block plus the stdout it recorded.
//
// WHAT THIS IS: behaviourally equivalent. It builds to 28,405 B / sha256
// 72BFC834165E81A1D1E2A6E5DDD361D9674DA529704F9083AD915C7DBC7460AB and
// reproduced DL11's measured shape on both platforms: the guest prints its
// five lines and exits 1 with the strand named (`executor 1 left 1 task(s)
// parked and never resumed (first: task 0 on class 4 key 7)`). Do not compare
// its hash with DL11's original's; the sizes differ because the text differs.
//
// Build: THREAD_FLAGS minus `--enable stack-switching` (spelled out in README.md)
// Run:   tension-core --executors 2 <artifact>    ← flag BEFORE the module path (I32)
//
// The recorded stdout this reproduces:
//   main: spawning / main: index=0 / main: spawn=0 /
//   worker: BEFORE the await / main: join=0 / main: done
// A worker's nested async function awaits a hand-made record that nothing ever
// completes, so the task parks and strands.
import { Task, TaskRecord } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";
import { __spawnIndexOf } from "~lib/task-stack";
import { __spawnThread, __threadJoin } from "~lib/thread";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

const CLASS_JOB_DONE: i32 = 4; // session/arena.rs:222

/** A handle nothing will ever complete: class stamped, `done` still 0. */
function pendingJob(key: i32): Task<i32> {
  const record = new TaskRecord();
  record.class_ = CLASS_JOB_DONE;
  record.key = key;
  const handle = new Task<i32>();
  handle._record = record;
  return handle;
}

async function awaited(): i32 {
  let job: Task<i32> = pendingJob(7);
  let v: i32 = await job;
  line("inner: AFTER the await, value=" + v.toString());
  return v;
}

async function workerEntry(): i32 {
  __taskBindTable(16);
  line("worker: BEFORE the await");
  let v: i32 = await awaited();
  line("worker: AFTER the await, value=" + v.toString());
  return 0;
}

export function _start_game(): void {
  line("main: spawning");
  let index = __spawnIndexOf(workerEntry);
  line("main: index=" + index.toString());
  let spawned = __spawnThread(1, index, 0);
  line("main: spawn=" + spawned.toString());
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
