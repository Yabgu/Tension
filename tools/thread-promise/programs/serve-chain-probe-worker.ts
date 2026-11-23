// DL30 Q1, the decisive half — the same walk, in a **worker's** store.
//
// `serve-chain-probe.ts` runs the whole chain in main's store and it **works**: the body
// prints. So `__serveSlot` → `__resumeTask` → `__taskAt` → `__resumeTask` is sound, and the
// break is specific to a worker. This probe is the same walk with one difference that
// matters: it runs **inside the worker**, in the worker's store, on the worker's executor.
//
// # How it gets there without hitting the defect
//
// The worker entry here is a **sync** function, which DL23 measured *does* run. So the served
// path delivers us into the worker's store — `__workerMain` → `__serveOne` → `cont.new` →
// `__resumeTask` → our function — and from inside it every step of the inner chain is
// printable, in the store where the async entry fails.
//
// # Why this is not the same as the failing case
//
// It is not: it is one store removed from the observed failure (a sync entry, not an async
// one). Its job is to say **whether the inner chain works in a worker's store at all**.
// - If the BODY line appears here too, then the chain is fine in both stores and the defect
//   is in how the *async* entry's own served step is set up — not in what it calls.
// - If it does not appear here, the chain breaks in a worker's store specifically, and the
//   difference between the two probes is the next thing to bisect.
//
// # The `$starts` shape is pinned to 5 entries
//
// One `__spawnIndexOf` call site, exactly as `serve-chain-probe.ts`:
//   [0] workerEntryAsync$start · [1] ~asyncMainStart · [2] __coreloopAwait ·
//   [3] workerEntryAsync$spawnStart · [4] workerEntryAsync
//
// Build (bundle aa74d6a1, I44) — by hand, from this directory:
//   tensionscript serve-chain-probe-worker.ts -o /tmp/serve-chain-worker.wasm \
//     --runtime incremental --target release --sharedMemory --importMemory \
//     --initialMemory 2 --maximumMemory 256 \
//     --enable threads --enable stack-switching --optimizeLevel 0
//
// Run:   tension-core --executors 2 /tmp/serve-chain-worker.wasm
import { __spawnIndexOf } from "~lib/task-stack";
import {
  __resumeTask,
  __serveSlot,
  __taskAt,
} from "~lib/task-stack";
import { __taskBindTable } from "~lib/task-rt";
import { __executorExit, __spawnThread, __threadJoin } from "~lib/thread";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

async function leaf(): i32 {
  return 0;
}

/** The stackful shell requires a root continuation. */
export async function main(): i32 {
  return await leaf();
}

/** The body under test: the thing that never runs in the failing case. */
async function workerEntryAsync(): i32 {
  line("W-BODY: workerEntryAsync ran (in the WORKER's store)");
  let v = await leaf();
  return v;
}

/**
 * The worker's entry — **sync**, so it runs. Inside it, the same five steps
 * `serve-chain-probe.ts` takes in main.
 */
function workerProbe(): i32 {
  line("W: worker entry ran (sync)");
  __taskBindTable(16);
  line("W step 0: task table bound");

  let api = __spawnIndexOf(workerEntryAsync);
  line("W step 1: __spawnIndexOf(workerEntryAsync)=" + api.toString());

  let slot = __serveSlot(3);
  line("W step 2: __serveSlot(3)=" + slot.toString());
  if (slot < 0) {
    line("W STOP: __serveSlot refused");
    return 0;
  }

  let awaited = __resumeTask(slot);
  line("W step 3: __resumeTask(serveSlot)=" + awaited.toString());

  let taskOrNull = __taskAt(awaited);
  if (taskOrNull) {
    line("W step 4: __taskAt(" + awaited.toString() + ")=a task, .slot="
      + taskOrNull.slot.toString() + ", .entry=" + taskOrNull.entry.toString()
      + ", .settled=" + (taskOrNull.settled ? "1" : "0"));
  } else {
    line("W step 4: __taskAt(" + awaited.toString() + ")=null");
  }

  if (awaited >= 0) {
    let second = __resumeTask(awaited);
    line("W step 5: __resumeTask(awaited)=" + second.toString());
  } else {
    line("W step 5: skipped — awaited was negative");
  }

  line("W probe: done (the W-BODY line is the pass condition)");
  return 0;
}

export function _start_game(): void {
  line("main: spawning (sync worker probe)");
  let index = __spawnIndexOf(workerProbe);
  line("main: workerProbe index=" + index.toString());
  line("main: spawn=" + __spawnThread(1, index, 0).toString());
  __executorExit(1);
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
