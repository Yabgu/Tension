// DL29 — which `$starts` index an async worker entry needs, and what each one does.
//
// `stackful-worker.ts` (DL23) established that an **async** worker entry produces no
// line and no park under the stack-switching shell. This probe finds out **which
// function** the served body is actually resuming, by spawning a literal `$starts`
// index instead of asking `__spawnIndexOf`.
//
// # Why a literal index, and why the registrations are kept
//
// Removing the `__spawnIndexOf` call sites changes the table itself (measured: the
// table drops from 5 entries to 4 and every index shifts), so the probe keeps both
// calls — `keep` below — purely so `$starts` has the shape a real program's has, and
// then spawns `INDEX` regardless. The two builds therefore differ **only** in which
// index is spawned.
//
// # What the table is, in this build
//
//   0  workerEntryAsync$start        the BODY continuation (`f$start`)
//   1  ~asyncMainStart
//   2  ~lib/async/__coreloopAwait
//   3  workerEntryAsync$spawnStart   `f$spawnStart`: factory + drive() + return 0
//   4  workerEntryAsync              the ENTRY: the factory (`f` itself)
//
// **The numbering depends on which `__spawnIndexOf` call sites exist** — a build with
// none has [mainStart, coreloop, start, spawnStart] and drops the factory to a 4-entry
// table. That instability is itself part of the defect: only the lowering's own
// `$rec.entry = __spawnIndexOf(f$spawnStart)` is trustworthy, because it is resolved in
// the same build that uses it.
//
// # Measured (bundle aa74d6a1, engine at Tension 2c90554, `--executors 2`,
// #           `--enable stack-switching`, STOP_FIRST = true so a run terminates)
//
//   INDEX   spawned (5-entry table)           result
//   -----   ---------------------------------  ------------------------------------
//   4       workerEntryAsync (the factory)     no worker line, exit 0
//   3       workerEntryAsync$spawnStart        no worker line, exit 0
//   0       workerEntryAsync$start (the body)  **`worker: entered (async entry)`**, 0
//   (—)      `__spawnIndexOf(workerEntryAsync)` answers **4** — the factory.
//
// Two separate findings, both outside a probe's reach to fix:
//
// 1. **`__spawnIndexOf` of an async function answers the factory, not `$spawnStart`.**
//    The builtin's own doc says "the `$starts` index of a synthesized `f$spawnStart`"
//    (`src/builtins.ts:12413`), which is what the *lowering's* internal call
//    (`$rec.entry = __spawnIndexOf(f$spawnStart)`) gets. A user's call naming `f`
//    registers `f` — the function whose entire body is "construct a task and return
//    it" — so the served body resumes it, gets a **task handle** back, and reads that
//    handle as an awaited slot. Measured corroboration: the host logs
//    `__workerMain answered 170176`, a heap pointer, which is the handle.
// 2. **`$spawnStart` does not work either.** Index 3 is the function the lowering
//    itself stores in `$rec.entry`, and it produces no output. So even correcting the
//    index would not make the worker run: something in `spawnStart` → `drive()` →
//    `__serveOne`'s ready push → `driveReady` → `__resumeTask` does not reach the body.
//
// The body **can** run from a served continuation — index 2 proves the serve machinery
// (`__serveCont` → `cont.new` → `__resumeTask` → ready → step) is sound. What fails is
// everything between "a task is created" and "its body continuation is resumed".
//
// `tools/thread-promise/DL29-REPORT.md` names both seams and stops there: the first is
// `builtin_async_spawnIndexOf` (compiler), the second is the std serve/drive chain.
// Neither is this round's to change.
//
// Build (bundle aa74d6a1, I44) — by hand, from this directory:
//   tensionscript stackful-worker-index.ts -o /tmp/idx.wasm \
//     --runtime incremental --target release --sharedMemory --importMemory \
//     --initialMemory 2 --maximumMemory 256 \
//     --enable threads --enable stack-switching --optimizeLevel 0
//
// Run:   tension-core --executors 2 /tmp/idx.wasm
import { __spawnIndexOf } from "~lib/task-stack";
import { __executorExit, __spawnThread, __threadJoin } from "~lib/thread";

/**
 * Which `$starts` index to spawn — the probe's whole knob.
 *
 * `4` (the default) is what `__spawnIndexOf(workerEntryAsync)` answers, i.e. what a real
 * program spawns: the defect, reproduced. Set it to `0` for the control that proves the
 * body *can* run from a served continuation, and to `3` for `$spawnStart`.
 */
const INDEX: i32 = 4;

/**
 * Stop the worker before joining.
 *
 * `true`, unlike DL23's probe: with the stop word every run terminates in under a
 * second, so the exit code is about the *entry* rather than about the join. DL23's
 * `false` variant measured the hang instead, which is a different question.
 */
const STOP_FIRST: bool = true;

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

export async function main(): i32 {
  return await leaf();
}

export function _start_game(): void {
  line("main: spawning");
  // Kept so the table has the shape a real program's has (see the header). Its answer
  // is what a user would pass, and it is 4 — the factory.
  let as_the_api_answers = __spawnIndexOf(workerEntryAsync);
  line("main: __spawnIndexOf(workerEntryAsync)=" + as_the_api_answers.toString());
  line("main: spawning index=" + INDEX.toString());
  line("main: spawn=" + __spawnThread(1, INDEX, 0).toString());

  if (STOP_FIRST) __executorExit(1);
  line("main: join=" + __threadJoin(1).toString());
  line("main: done");
}

function workerEntry(): i32 {
  line("worker: entered (sync entry)");
  return 0;
}

async function workerEntryAsync(): i32 {
  line("worker: entered (async entry)");
  let v = await leaf();
  return v;
}
