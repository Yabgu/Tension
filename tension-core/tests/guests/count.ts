// The thread ABI's first observable: how many executors this instance was
// configured for, and that the host booted it the way the contract says.
//
// The import is declared here rather than imported from `~lib/thread`, because
// `std/assembly/thread.ts` declares it `@external` but does not export it — and
// a test guest that restates the wire name is the same thing gate4's probes do:
// the ABI it exercises is visible in the file that exercises it.
//
// Built by `build.mjs` in this directory; run by `tension-core/tests/threads.rs`
// with `--executors 2`, so the expected count is 3 (main plus two workers).

import { __controlBase, __controlStride, __executorTotal, __ringCapacity } from "~lib/thread";

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

/** One line of UTF-8, the way `tension-framework`'s `print` does it. */
function line(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let newline = String.UTF8.encode("\n");
  hostPrint(changetype<usize>(newline), newline.byteLength);
}

@external("env", "__executorCount")
declare function executorCount(): i32;

/** An async shell is what makes the compiler emit `__threadInit` at all. */
async function leaf(): i32 {
  return 0;
}

export async function main(): i32 {
  let _ = await leaf();
  return 0;
}

export function _start_game(): void {
  line("executors=" + executorCount().toString());
  // The tree the host carved, from the guest's own exports: a nonzero
  // `__controlBase` is the one observable that says `__threadInit` ran *before*
  // `__start` (a guest whose block was never carved has 0 here, and finds
  // nothing from `__heap_base` either).
  line("controlBase=" + (__controlBase != 0 ? "carved" : "0"));
  line("executorTotal=" + __executorTotal.toString());
  line("ringCapacity=" + __ringCapacity.toString());
  line("controlStride=" + __controlStride.toString());
}
