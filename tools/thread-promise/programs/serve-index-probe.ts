// DL30 Q1 — the value, not the guess. Serve index 3 **and** index 4 (the factory)
// in main's store, exactly as `__serveOne` does, and print what comes back.
//
// # What is already settled
//
// `serve-chain-probe.ts` serves `$starts[3]` (`$spawnStart`) in main and the body prints.
// `serve-chain-probe-worker.ts` does the same walk inside a worker's store and the body prints
// there too. So `__serveSlot` → `__resumeTask` → `__taskAt` → `__resumeTask` is sound in both
// stores, and the chain is not the defect.
//
// # What is left to measure
//
// DL29 established (from outside, by a worker printing nothing) that the async entry is served
// as index 4 — the **factory** — and that index 3 also produces nothing. This probe takes the
// two resumes apart and prints their **return values**, which is the one thing the worker
// could not show:
//
//   index 3 (`$spawnStart`)  → per the lowering contract, returns the created task's slot;
//   index 4 (`f`)            → per the contract, returns **the task handle**.
//
// If index 4 answers a number in the heap-pointer range while index 3 answers a small slot id,
// then `__serveOne`'s `if (awaited >= 0) { __taskAt(awaited); e.ready.push(awaited); }` pushes
// a *pointer* onto a ring of slot ids, and `driveReady` → `__resumeTask(pointer)` is the failing
// link. That is the value Q1 asks for.
//
// # The pinned 5-entry `$starts`
//
// One `__spawnIndexOf` call site:
//   [0] body · [1] mainStart · [2] coreloop · [3] spawnStart · [4] the factory
//
// Build (bundle aa74d6a1, I44), from this directory:
//   tensionscript serve-index-probe.ts -o /tmp/serve-index.wasm --textFile /tmp/serve-index.wat \
//     --runtime incremental --target release --sharedMemory --importMemory \
//     --initialMemory 2 --maximumMemory 256 \
//     --enable threads --enable stack-switching --optimizeLevel 0
//
// Run:   tension-core --executors 2 --post-completion 4,7 /tmp/serve-index.wasm
import { Task, TaskRecord } from "~lib/task";
import { __spawnIndexOf } from "~lib/task-stack";
import {
  __bindTask,
  __resumeTask,
  __serveSlot,
  __taskAt,
} from "~lib/task-stack";
import { __taskBindTable } from "~lib/task-rt";

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

/** The body. Its line proves a serve reached the body. */
async function workerEntryAsync(): i32 {
  line("BODY: workerEntryAsync ran");
  let job: Task<i32> = pendingJob(KEY);
  let v: i32 = await job;
  line("BODY: after the await, value=" + v.toString());
  return v;
}

/** One serve, with every value printed. `label` says which index this is. */
function serve(label: string, index: i32): void {
  line("--- serve " + label + " (index " + index.toString() + ") ---");
  let slot = __serveSlot(index);
  line(label + ": __serveSlot=" + slot.toString());
  if (slot < 0) {
    line(label + ": REFUSED at __serveSlot");
    return;
  }
  let awaited = __resumeTask(slot);
  line(label + ": __resumeTask(slot)=" + awaited.toString());
  if (awaited >= 0) {
    let t = __taskAt(awaited);
    if (t) {
      line(label + ": __taskAt(awaited)=a task, .slot=" + t.slot.toString()
        + ", .entry=" + t.entry.toString());
    } else {
      line(label + ": __taskAt(awaited)=null — awaited is NOT a slot id");
    }
    // What `driveReady` would do with it.
    let next = __resumeTask(awaited);
    line(label + ": __resumeTask(awaited)=" + next.toString());
  }
}

export function _start_game(): void {
  __taskBindTable(16);

  let api = __spawnIndexOf(workerEntryAsync);
  line("api: __spawnIndexOf(workerEntryAsync)=" + api.toString() + "  (4 = the factory)");

  serve("spawnStart", 3);
  serve("factory", 4);

  // The factory completed normally (-1) and nothing was queued. Is the task it created still
  // there, waiting for a driver that will never come? That is the difference between "the
  // factory did nothing" and "the factory built a task and orphaned it".
  line("--- scan: tasks in the slot table after both serves ---");
  for (let i: i32 = 1; i < 10; i++) {
    let t = __taskAt(i);
    if (t) {
      line("slot " + i.toString() + ": a task, .entry=" + t.entry.toString()
        + ", .settled=" + (t.settled ? "1" : "0"));
    }
  }
  line("probe: done");
}
