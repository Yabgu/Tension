// COPIED VERBATIM from TensionScript's `examples/async-main/main.ts` (below this
// header). That program is the shared ABI contract: TensionScript's
// `tests/rt/examples.js` asserts it on a stub host, and
// `tension-core/tests/async_on_main.rs` asserts this copy against
// `async-on-main.expected.txt`. The two copies must stay identical — change
// them in both repos in the same breath.
// async-main — async/await with no threads at all.
//
// One store, one executor, one linear memory. There is no `--sharedMemory`, no
// worker, and no scheduler import: every suspension below is a guest
// continuation parked on the Task path and resumed by the guest's own core
// loop. What the program proves is the property a task model is *for* — a
// local assigned before a suspension is still the same local after it, and the
// final value is reachable only if every suspension resumed where it stopped.
//
// The transcript is a tag and an i32 per observation. The host names the tags
// (run.mjs), because the guest has no strings and no way to format.

@external("env", "emit")
declare function emit(tag: i32, value: i32): void;

const SUSPENSIONS: i32 = 1;
const CARRIED: i32 = 2;
const TOTAL: i32 = 3;
const FINAL: i32 = 4;

/** Suspensions that actually happened. It must equal the count below. */
let suspends: i32 = 0;

/**
 * A real suspension: `await 0` is not a task, but its presence makes `step` a
 * task, so each `await step(...)` parks the caller's stack and resumes it.
 */
async function step(x: i32): i32 {
  await 1;
  suspends++;
  return x + 1;
}

export async function main(): i32 {
  // A local written **before** the first suspension and read after the last.
  let carried: i32 = 10;

  // Three suspensions in a loop. Each iteration reads the value the previous
  // resume left in this frame, which is the whole point of a stack.
  let total: i32 = 0;
  for (let i = 0; i < 3; ++i) {
    total += await step(i * 10);
    carried += 1;
    emit(CARRIED, carried);
  }

  // Three more, chained: each argument is the previous result.
  let a = await step(100);
  let b = await step(a);
  let c = await step(b);

  let final = carried + total + c;
  emit(SUSPENSIONS, suspends);
  emit(TOTAL, total);
  emit(FINAL, final);
  return final;
}
