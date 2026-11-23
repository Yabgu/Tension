// DL31 — the spawn entry is the one the lowering created, and a worker started
// from the API's own answer runs the body it names.
//
// # The defect this program proves gone
//
// `__spawnIndexOf` answered the index of the **factory** `f` — the function a
// user writes — while a served continuation must be the synthesized
// `f$spawnStart`, which creates the task, parks on it, and answers the task's
// slot. Serving the factory instead made `__serveOne` queue nothing (`f` completes
// normally, so `__resumeTask` answers `-1`), and the task that `f` created and
// bound was left unsettled with nothing to drive it — DL30 measured it as
// `slot 4: a task, .entry=3, .settled=0`, at exit 0 with no sentence. That silent
// exit 0 is what this round removes.
//
// # What it prints, and why each line is here
//
//   main: spawnIndexOf=<n>          **the number under test**: 3, the `$spawnStart`
//                                   index — not 4, the factory's.
//   main: spawn=0                   the record was written and the thread asked for.
//   worker: entered (async entry)   the served continuation *ran the body*.
//   worker: AFTER the await, v=0    it ran past its suspension, so this is a
//                                   body that finished and not one that started.
//   main: join=0                    the worker was joined, not timed out.
//
// # Termination: the worker stops itself
//
// DL29 and DL30 both measured the trap in the obvious shape — main calling
// `__executorExit(1)` right after spawning — and both times it killed the worker
// **before it could serve**, which is how DL29 came to report that index 3
// produced nothing. So the stop happens where the ordering fact actually is: the
// body's last statement, after its lines are printed. Main only joins.
//
// The body's `await` is syntactic (`leaf()`), which is what keeps the stackful
// shape — `$start` and `$spawnStart` exist only for a body the lowering sees
// suspend (DL30 §4.2). It is not a real suspension; this program is about being
// *served*, not about being resumed, and DL30's `serve-suspend` is the probe that
// covers the other half.
//
// Built with the `thread/` folder's default flags (`THREAD_FLAGS` in
// `scripts/build-test-programs.mjs`), which include `--enable stack-switching`.
// Bundle **3ef8a8f4** (I44) — the one this fix produced.
import { __spawnIndexOf } from "~lib/task-stack";
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

/** The worker's body — a factory, whose spawn entry is what must be served. */
async function workerEntryAsync(): i32 {
  line("worker: entered (async entry)");
  let v: i32 = await leaf();
  line("worker: AFTER the await, value=" + v.toString());
  // The body is done, so the executor is done: ordered by the work finishing
  // rather than by a frame count or a sleep.
  __executorExit(1);
  return v;
}

export function _start_game(): void {
  // **One** `__spawnIndexOf` call site: the table is built from the entries the
  // compiler was asked for, so a second call would add a second name and move
  // nothing — but one call also keeps this program's table the 4-entry shape the
  // answer is stated against: `[0] $start · [1] ~asyncMainStart · [2] coreloop ·
  // [3] $spawnStart`.
  let index = __spawnIndexOf(workerEntryAsync);
  line("main: spawnIndexOf=" + index.toString());
  line("main: spawn=" + __spawnThread(1, index, 0).toString());
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}
