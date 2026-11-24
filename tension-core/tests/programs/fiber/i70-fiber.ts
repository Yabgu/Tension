// The fiber backend's I70 scenario, as a guest the host can run (DL36).
//
// A stackful body awaits a task whose completion comes from the **host**, not
// from this store: `RemotePolicy.await` parks the current task on a producer's
// `(class, key)` pair. Under `--stackful-backend=fiber` that park is a call
// (`scheduler::park`) the host can see, so the host suspends the task on a fiber
// and resumes it with the producer's value — which is what makes
// `value=<the producer's>` possible at all. Under the continuation backend the
// same source parks inside a wasm `suspend` and needs an executor with a
// continuation table.
//
// What the two lines are for:
//
//   before=1        printed before the await, so the transcript shows the guest
//                   reached the park
//   value=<n>       printed after the resume, with the value the host delivered.
//                   I70's assertion is that this is the producer's number and not
//                   `0`, which is what a suspension that never really parked — or
//                   a park whose completion was dropped — would produce.
//
// The `await leaf()` is **load-bearing, not scaffolding**. The shell choice is
// whole-program and syntactic (`asyncShellSuspends = program.hasAwait && …`), and
// `policy.await(...)` is a method call rather than an `await` expression: without
// a real `await` in the program there is no suspending shell and the stackful
// intrinsics are refused at compile time.
//
// Build: `node scripts/build-test-programs.mjs i70-fiber` (flags in `PROGRAMS`).
// The artifact every test loads is the committed copy in
// `tests/programs/fixtures/fiber/` — see the README beside it.
import { Task, TaskRecord } from "~lib/task";
import { RemotePolicy } from "~lib/thread";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

/** The class the host's producer posts under (`session::arena::CLASS_*`). */
const CLASS_JOB_DONE: i32 = 4;
/** The key this program's producer was told to complete. */
const KEY: i32 = 7;

/** A handle for a completion this store does not produce: class and key stamped. */
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

export async function main(): i32 {
  // See the header: the suspending shell needs a real `await` in the program.
  let warm_up = await leaf();
  line("warm=" + warm_up.toString());
  line("before=1");

  let job = pendingJob(KEY);
  let policy = new RemotePolicy(1, 0, -1);
  policy.await(job);

  let got = <i32>job.value;
  line("value=" + got.toString());
  return got;
}

/** The host calls `__start`; this is the entry a non-shell guest would use. */
export function _start_game(): void {
  line("start_game=1");
}
