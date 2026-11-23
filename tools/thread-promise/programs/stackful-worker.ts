// DL23 Q3 — the smallest stack-switching worker, and nothing else.
//
// DL11's stackful control is lost (it lived in `/tmp`, never committed). Rather
// than rebuild the whole shaped guest first, this removes everything that could
// confuse a diagnosis — the park, the await, the hand-made record, the wake — and
// leaves one worker whose entry prints one line and returns.
//
// # What it measures (bundle `aa74d6a1`, engine 33 643 504 B @ 2026-11-23 14:11)
//
// Two knobs, four runs, and the pair of them is the diagnosis:
//
//   ASYNC_ENTRY  STOP_FIRST   result
//   -----------  ----------   --------------------------------------------------
//   false        false        `worker: entered (sync entry)` then **EXIT=124**
//   false        true         `worker: entered (sync entry)`, exit 0, 0 s
//   true         false        **no worker line at all**, **EXIT=124**  ← DL11
//   true         true         no worker line, `recorded 0 park(s)`, exit 0, 0 s
//
// Read the columns as two separate facts:
//
// 1. **`STOP_FIRST` explains the hang in the synchronous case.** A worker lives
//    until it is told to stop (DL20B's session pool), so joining it without
//    `__executorExit` first waits forever. That is the programs README's "Pool
//    lifetime" section, not a stack-switching defect.
//
// 2. **`ASYNC_ENTRY` explains DL11.** An **async** worker entry is a
//    continuation-shaped spawn entry and never runs under stack switching: no
//    line, no park, nothing. Pre-DL20B there was no stop word either, so the
//    worker thread never finished and `__threadJoin` hung — DL11's `EXIT=124`
//    with only main's three lines. Today the stop word releases the join and the
//    same failure exits **0 in 0 s**: the hang became a silent success.
//
// `index=4` in every run above because both entry functions exist in the module;
// DL11's own control reported `index=6`, a different guest with more bodies.
//
// Both knobs are `false` as committed, which is the hanging variant — flip one at a
// time to reproduce the table.
//
// Build (bundle aa74d6a1, I44):
//   tensionscript stackful-worker.ts -o /tmp/probe.wasm \
//     --runtime incremental --target release --sharedMemory --importMemory \
//     --initialMemory 2 --maximumMemory 256 \
//     --enable threads --enable stack-switching --optimizeLevel 0
//
// Run: tension-core --executors 2 /tmp/probe.wasm
import { __spawnIndexOf } from "~lib/task-stack";
import { __executorExit, __spawnThread, __threadJoin } from "~lib/thread";

/**
 * `false` measures the hang; `true` measures its cause.
 *
 * With `true` the worker is told to stop before main joins, and the same program
 * exits 0 in under a second — which is what identifies the hang as DL20B's pool
 * lifetime (a worker lives until stopped) rather than anything to do with stack
 * switching or parks.
 */
const STOP_FIRST: bool = false;

/**
 * `false` gives the worker a plain-function entry; `true` an **async** one.
 *
 * This is the knob that reproduces DL11's stackful control, and the difference is
 * the finding: a plain entry runs (`worker: entered`), an async entry is a
 * continuation-shaped spawn entry and **never runs at all** — no line, no park,
 * `recorded 0 park(s)`. `tools/thread-promise/DL23-REPORT.md` §Q3.
 *
 * Leave `STOP_FIRST` at `false` when flipping this: the async case's exit code is
 * the measurement (it is 0 today, and was a hang before DL20B's stop word).
 */
const ASYNC_ENTRY: bool = false;

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

// The stackful shell requires a root continuation, i.e. an exported async main:
// without one the build is refused with
//   "the stackful backend requires an exported main (there is no root continuation
//    to resume)"
async function leaf(): i32 {
  return 0;
}

export async function main(): i32 {
  return await leaf();
}

function workerEntry(): i32 {
  line("worker: entered (sync entry)");
  return 0;
}

/** The same body behind an `await`, i.e. a continuation-shaped spawn entry. */
async function workerEntryAsync(): i32 {
  line("worker: entered (async entry)");
  let v = await leaf();
  return v;
}

export function _start_game(): void {
  line("main: spawning");
  let index = ASYNC_ENTRY ? __spawnIndexOf(workerEntryAsync) : __spawnIndexOf(workerEntry);
  line("main: index=" + index.toString());
  line("main: spawn=" + __spawnThread(1, index, 0).toString());
  // With `STOP_FIRST` false this is the variant that hangs, and the hang is the
  // measurement; with it true, the control that names the cause.
  if (STOP_FIRST) __executorExit(1);
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
