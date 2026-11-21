// The promise path: an `async` body compiled by the state-machine backend, which
// is what a build **without** `--enable stack-switching` produces.
//
// The breakpoint is the statement **before** the await, because the resume of a
// promise task needs a producer the bare debug host does not have (measured:
// `--session-open` reports "no session is installed", and without it the park
// returns and the body never continues). The line after the await is therefore
// measured by the census — it is in the line table — and not by a stop.
import { print } from "../../../../tension-framework";
import { rt } from "../../../../tension-framework/assembly/runtime/rt";
import { Task } from "~lib/task";

async function awaitJob(h: Task<u32>): u32 {
  print("promise park"); // @stop
  let v: u32 = await h;
  print("promise resume " + v.toString());
  return v;
}

export function _start_game(): void {
  rt.start();
  awaitJob(rt.job(7));
}
