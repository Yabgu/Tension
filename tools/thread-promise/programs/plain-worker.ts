// W13 Phase B — a reconstruction of DL9 §3's plain-worker guest.
//
// WHAT THIS IS NOT: byte-identical to DL9's original. DL9's source was written
// to /tmp/dl9 and never committed; its artifact was 15,729 B / sha256
// 2952849fa89be404…11334f. That file cannot be recovered from any branch of
// either repository, so this is a rebuild from DL9's report prose, made during
// round W13.
//
// WHAT THIS IS: behaviourally equivalent. It builds to 15,947 B / sha256
// E49006E31B85F89E41ED56D0364F06DA652976B8B8C966EE9D9587E342F7FE28 and
// reproduced DL9's measured output key for key (`counter=10`, exit 0) — the
// property it exists to preserve. Do not compare its hash with DL9's
// original's; the sizes differ because the text differs.
//
// Build: THREAD_FLAGS minus `--enable stack-switching` (spelled out in README.md)
// Run:   tension-core --executors 2 <artifact>    ← flag BEFORE the module path (I32)
//
// The shape, in one sentence: a StaticArray<i32> in the shared memory, the
// worker reads its one i32 through __workerArg(), does atomicLoad +
// atomicAdd<i32>(addr, 10), then __executorExit(__selfExecutor()); main prints
// before, workIndex, spawn, join, counter.
import { __executorExit, __selfExecutor, __spawnThread, __threadJoin, __workerArg } from "~lib/thread";
import { __spawnIndexOf } from "~lib/task-stack";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

/** One word in the shared heap: main starts it at 0, the worker adds 10. */
let cell: StaticArray<i32> = new StaticArray<i32>(1);

/** The worker's whole life, called through `$starts` by `__workerMainPlain`. */
function worker(): i32 {
  let addr = <usize>__workerArg();
  atomicLoad<i32>(addr);
  atomicAdd<i32>(addr, 10);
  __executorExit(__selfExecutor());
  return 0;
}

export function _start_game(): void {
  cell[0] = 0;
  line("before=" + cell[0].toString());
  let index = __spawnIndexOf(worker);
  line("workIndex=" + index.toString());
  let spawned = __spawnThread(1, index, changetype<i32>(cell));
  line("spawn=" + spawned.toString());
  line("join=" + __threadJoin(1).toString());
  line("counter=" + cell[0].toString());
}
