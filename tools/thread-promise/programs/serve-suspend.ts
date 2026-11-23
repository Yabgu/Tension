// DL30 Q2 — does a body that **genuinely suspends** serve at all?
//
// Every probe so far (DL29's, and DL30's three) awaits a `leaf()` that has no `await` of its
// own, so the stackful modifier may be cleared and the body may never really suspend. This
// guest's body awaits a `Task` handle whose completion comes from the host
// (`--post-completion 4,7`) — the same idiom `tests/programs/thread/wake-on-worker.ts` uses,
// and the smallest form that parks on the Promise path.
//
// # The two entries, and what each would prove
//
//   ENTRY = 0  `workerEntryAsync$start` — the body continuation, served directly.
//              DL29 measured this **runs and prints** for a non-suspending body. If it also
//              runs *to completion* when the body really suspends, the serve machinery can
//              host a suspended body and the defect is small. If it prints the first line and
//              then never the AFTER line, the continuation has no task to be resumed into —
//              `f$start` was served without the task `f$spawnStart` would have created.
//
//   ENTRY = 3  `workerEntryAsync$spawnStart` — the factory+drive entry. Per the lowering
//              contract it creates the task, drives it, and returns the task's slot, so
//              `__serveOne` queues it and `driveReady` runs the body. DL29 reported no output
//              for this index; DL30's `serve-index-probe.ts` measured it **working in main's
//              store** (returns slot 2, body runs). Re-measured here in a worker.
//
// # Timeout and what it means
//
// 25 s, and it is load-bearing: the pre-DL20B failure mode for a stackful worker was
// `EXIT=124` after 25 s (DL23). A timeout here means the worker parked and nothing resumed it
// — the "cannot host a suspended body" answer. A run that ends with no AFTER line but exit 0
// means the body never even parked.
//
// # The pinned 5-entry `$starts`
//
// One `__spawnIndexOf` call site:
//   [0] body · [1] mainStart · [2] coreloop · [3] spawnStart · [4] the factory
//
// Build (bundle aa74d6a1, I44) — flip `ENTRY` for the second run, from this directory:
//   tensionscript serve-suspend.ts -o /tmp/serve-suspend.wasm --textFile /tmp/ss.wat \
//     --runtime incremental --target release --sharedMemory --importMemory \
//     --initialMemory 2 --maximumMemory 256 \
//     --enable threads --enable stack-switching --optimizeLevel 0
//
// Run:   tension-core --executors 2 --post-completion 4,7 /tmp/serve-suspend.wasm
import { Task, TaskBase, TaskRecord } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";
import { __spawnIndexOf } from "~lib/task-stack";
import { RemotePolicy, __executorExit, __spawnThread, __threadJoin } from "~lib/thread";

export { __taskWake } from "~lib/task-rt";

/** A guest that exports `__taskWake` must also export this (`0` = no host frames). */
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

const CLASS_JOB_DONE: i32 = 4;
const KEY: i32 = 7;
const HEADER_SERVED: usize = 6;

/** **The only knob.** 0 = the body continuation, 3 = the factory+drive entry. */
const ENTRY: i32 = 0;

function pendingJob(key: i32): Task<i32> {
  const record = new TaskRecord();
  record.class_ = CLASS_JOB_DONE;
  record.key = key;
  const handle = new Task<i32>();
  handle._record = record;
  return handle;
}

async function leaf(): i32 {
  return 0;
}

/** The stackful shell requires a root continuation. */
export async function main(): i32 {
  return await leaf();
}

/**
 * The body. It **really** suspends.
 *
 * A plain `await task` does **not** suspend on the stackful path — measured: both entries ran
 * straight through it, `recorded 0 park(s)`, the host's completion stayed buffered. The form
 * that suspends is `RemotePolicy.await` (`stackful-external-await.ts`, DL23 Q4): it emits
 * `__parkOn` + `__suspendParked` and the body stops there.
 */
async function workerEntryAsync(): i32 {
  __taskBindTable(16);
  line("W-BODY: entered");
  // A **syntactic** await, so the lowering keeps the stackful shape ($start + $spawnStart).
  // Measured: a body whose only suspension is `policy.await` is lowered *without* them — the
  // `$starts` table is 3 entries — because `asyncShellSuspends` is syntactic (DL23 Q1).
  let w: i32 = await leaf();
  line("W-BODY: leaf=" + w.toString());
  // A **real** suspension: `policy.await` emits `__parkOn` + `__suspendParked` and stops here.
  let job: Task<i32> = pendingJob(KEY);
  let policy = new RemotePolicy(1, 0, -1);
  policy.await(changetype<TaskBase>(job));
  line("W-BODY: after the policy await (this line is the pass condition)");
  return 0;
}

export function _start_game(): void {
  let index: i32 = ENTRY;
  let label: string = ENTRY == 0 ? "body continuation" : "factory+drive";
  line("main: ENTRY=" + ENTRY.toString() + " (" + label + ")");
  // One `__spawnIndexOf` call site keeps `$starts` at 5 entries (DL29's trap).
  line("main: __spawnIndexOf(workerEntryAsync)=" + __spawnIndexOf(workerEntryAsync).toString());
  let spawned = __spawnThread(1, index, 0);
  line("main: spawn=" + spawned.toString());

  // Wait for a wake to be served, bounded. `atomicWait` with a timeout is the only
  // notification a guest can receive from the host (DL27): the host cannot `atomic.notify`.
  let served = <usize>__controlBase + HEADER_SERVED * 4;
  for (let i: i32 = 0; i < 50 && atomicLoad<i32>(served) == 0; i++) {
    atomicWait<i32>(served, 0, 20000000);
  }
  line("main: wakes served=" + atomicLoad<i32>(served).toString());

  __executorExit(1);
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
