// The contract's negative cases, as values the test asserts.
//
// `__spawnThread` (`std/assembly/thread.ts`) answers its own refusals before it
// ever reaches the host:
//
//   -1   the id is out of range (`<= 0`, or `>= __executorTotal`)
//   -2   the id is already born (its record's state word is not `0`)
//   0    the record was written and the host accepted the spawn
//
// The host's half is what test (2) proves; this one proves the guest's, so a
// host that started a thread for an id the guest had already refused would be a
// visible difference rather than a silent second instance.
//
// Built by `build.mjs`; run by `tension-core/tests/threads.rs` with
// `--executors 2`.

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

export async function main(): i32 {
  let _ = await leaf();
  return 0;
}

export function _start_game(): void {
  // Out of range, both ends. Main is 0 and is never a spawn target; the count is
  // 3 (main plus two workers), so 3 is past the end.
  line("spawnMain=" + __spawnThread(0, -1, 0).toString());
  line("spawnPastEnd=" + __spawnThread(3, -1, 0).toString());

  // The one that must succeed, then the same id again: already born.
  let first = __spawnThread(1, -1, 0);
  line("spawnFirst=" + first.toString());
  line("spawnAgain=" + __spawnThread(1, -1, 0).toString());

  // End the worker and wait, so the process does not exit under a live thread.
  __executorExit(1);
  line("join=" + __threadJoin(1).toString());
}
