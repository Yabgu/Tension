// DL41 — a **served** body that parks, and is resumed by a completion the host
// posts.
//
// Every DL40 row has a served entry that awaits an already-settled task
// (`await leaf()`), so none of them ever parks *inside* a served body. That is
// the gap this program covers: the served body itself suspends, and the only
// thing that can resume it is the worker's own session loop applying the
// completion. DL39 could not see this case (it measured the non-suspending rows),
// and DL40 declared it dropped on the fiber backend (I97).
//
// # Shape, and why each part is there
//
// It is `wake-on-worker.ts`'s proven shape — a served entry that parks on a
// stamped handle whose pair the host completes with `--post-completion 4,7` —
// with **one addition**: an exported `main`. That is not decoration. The stackful
// shell refuses a program with no exported root ("the stackful backend requires an
// exported main (there is no root continuation to resume)", measured), and
// `wake-on-worker.ts` has none, so that program cannot be built for the fiber
// backend at all. Adding `main` here rather than editing it keeps its committed
// artifact and its two assertions untouched.
//
// # Where the suspension happens
//
// `workerEntry` is served in the worker's store (`__spawnThread` → an index into
// `$starts` → `__serveOne`). It awaits `awaited()`, which awaits a stamped
// `TaskRecord`. On the continuation backend that parks a nested task on
// (class 4, key 7); the host's `--post-completion 4,7` satisfies the pair and the
// worker's session loop resumes it with this store's own `__taskWake`.
//
// # The transcript
//
//   main: spawning
//   main: index=<i>                      the served entry resolved
//   main: spawn=0                        the worker took it
//   worker: BEFORE the await             the served body ran in the worker
//   inner: AFTER the await, value=<v>    the parked task RESUMED
//   worker: AFTER the await, value=<v>   and the served body continued
//   main: join=0                         the worker exited because its body ran
//   main: done
//
// The join cannot return before the two `AFTER` lines, because the body only
// returns once the park has been resumed: the ordering is the join, not a clock.
//
// # The value, and the one column this program does not force
//
// `--post-completion` can carry a payload word (`<CLASS>,<KEY>,<PAYLOAD>`) and
// `Delivery::payload` carries it as far as the session loop. The loop resumes the
// task with `__taskWake(idsPtr, count)`, which names **ids and nothing else**, so
// on the continuation backend the resumed task reads 0 whatever was posted
// (measured: `--post-completion 4,7,500` still prints `value=0`). On the fiber
// backend the same park is resumed through `scheduler::park` and the word is asked
// for by `scheduler::completion`. The two backends are therefore expected to
// differ in *this* column and to agree in every other one; `DL41-REPORT.md` §2
// records that as I98 rather than hiding it behind an exclusion in a shared
// expectation.
import { Task, TaskRecord } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";
import { __spawnIndexOf } from "~lib/task-stack";
import { RemotePolicy, __executorExit, __spawnThread, __threadJoin } from "~lib/thread";

// **The guest must export this itself.** `__taskWake` lives in `~lib/task-rt` but
// is not a module export of a compiled guest: the host resolves it by name to find
// a push handler, so a program that wants a wake path re-exports it.
export { __taskWake } from "~lib/task-rt";

/**
 * The coexistence rule's other half: a guest that exports `__taskWake` must also
 * export `_game_running`, or the host refuses the module at load. `0` is the
 * truthful answer — this program drives its own stop through the served-wake
 * counter and the join below, not a frame count.
 */
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
/** Header word 6: wakes this session has served (host-written, `bump_served`). */
const HEADER_SERVED: usize = 6;
/** The pair the host's `--post-completion 4,7` names. */
const KEY: i32 = 7;

/** A handle for a completion the *host* delivers: class and key stamped. */
function pendingJob(key: i32): Task<i32> {
  const record = new TaskRecord();
  record.class_ = CLASS_JOB_DONE;
  record.key = key;
  const handle = new Task<i32>();
  handle._record = record;
  return handle;
}

/** The parked task: this `await` is what the worker's session loop must resume. */
async function awaited(): i32 {
  let job: Task<i32> = pendingJob(KEY);
  // **`policy.await`, not a bare `await`, and the difference is the round.** A bare
  // `await` on a stamped handle is the Promise protocol: it parks on the
  // continuation shell and, on the fiber backend, has no park site at all (measured:
  // the artifact imports no `scheduler::park`), so it resolves inline and reads 0.
  // `policy.await` is the one await lowered to a real suspension on both — the
  // intrinsic `__suspendParked` → `scheduler::park`.
  let policy = new RemotePolicy(1, 0, -1);
  policy.await(job);
  let v: i32 = job.value;
  line("inner: AFTER the await, value=" + v.toString());
  return v;
}

/** The served entry: runs in the worker's store, parks on the host's pair. */
async function workerEntry(): i32 {
  __taskBindTable(16);
  line("worker: BEFORE the await");
  let v: i32 = await awaited();
  line("worker: AFTER the await, value=" + v.toString());
  // **The worker stops itself, after it has printed.** The executor's state word is
  // what `__threadJoin` waits on, and it is set here — after both `AFTER` lines, and
  // after the resume — so a main that joins cannot print while the worker is still
  // writing. Stopping the executor from *main* instead makes the join return
  // immediately and interleaves the transcript (measured:
  // `…value=500main: wakes served=1`). Same line, same position, as
  // `spawn-entry-async`'s own entry.
  __executorExit(1);
  return v;
}

/**
 * The root continuation the stackful shell requires. Deliberately inert: the
 * subject here is the *worker's* park, and a suspension on main would be a second,
 * unrelated variable.
 */
export async function main(): i32 {
  return 0;
}

export function _start_game(): void {
  line("main: spawning");
  let index = __spawnIndexOf(workerEntry);
  line("main: index=" + index.toString());
  line("main: spawn=" + __spawnThread(1, index, 0).toString());

  // **The join is the only wait, and it is enough.** The worker stops itself after
  // printing, so `join=0` means every worker line is already written and the park
  // has been resumed. A spin on the served word was tried first and removed: it is a
  // clock in disguise (200 000 000 iterations was not enough on this host, and the
  // transcript said `wakes served=0` for a run that had resumed), and it also hides
  // the failure it should report — a worker that never started leaves a spinner
  // spinning instead of a join returning.
  //
  // `wakes served` is read **after** the join for the same reason: header word 6 goes
  // to 1 at the park, before the resumed body prints.
  let served = <usize>__controlBase + HEADER_SERVED * 4;
  let joined = __threadJoin(1);
  line("main: wakes served=" + atomicLoad<i32>(served).toString());
  line("main: join=" + joined.toString());
  line("main: done");
}
