// `await` on main: a stackful continuation chain on **one** store, with no
// host, no worker, no OS thread and no capability. `npm start`.
//
// **This file is the demo; the ABI contract is the test program.**
// `tension-core/tests/programs/async-on-main.ts` is a verbatim copy of
// TensionScript's `examples/async-main/main.ts`, and
// `tension-core/tests/async_on_main.rs` asserts its transcript, so a change to
// the contract is caught on both hosts. This example stays the longer, printed
// walkthrough; if the two disagree, the test program is right.
//
// ## What this shows
//
// Every `await` here is a real suspension of `main`, not a straight line. The
// compiler's stackful backend (`--enable stack-switching`) turns each
// may-suspend call into a continuation on the guest's own stack, and the
// module's core loop — `~lib/async/__coreloopAwait`, emitted into `__start` —
// is the only thing that resumes them. Three participants, all in this one
// wasm instance:
//
//   main        parks on every await, and is resumed by the core loop
//   core loop   resumes one continuation at a time; parks only when nothing
//               is runnable (`$idle`), which here never happens
//   nobody else there is no host call, no thread, no device to wait for
//
// ## The two properties the transcript is here to prove
//
// 1. **A call runs nothing.** `outer(1)` creates a continuation and returns;
//    `outer`'s first line is not printed until `main` parks on the await. The
//    `bodies run=` counter prints 0 before the await and 3 after it — all
//    three bodies in the chain, each of which ran only once `main` had parked.
// 2. **A local survives a suspension.** `total` is assigned before the loop and
//    read after each await inside it; `a` is assigned at the first await and
//    read by the next line. A continuation that resumed with fresh locals would
//    print a wrong `total` at iteration 0 and a wrong `a` at the first line.
//
// The chain is three deep (`main` -> `outer` -> `mid` -> `base`), plus three
// more suspensions from the loop, so six parks in one program with one store.
//
// ## What it does not use, deliberately
//
// No `RuntimeSession`, no `rt.frame()`, no capability. The only import is
// `tension::io` for the transcript itself — a program cannot prove ordering
// without printing. `docs/task-model.md` in the host repository puts this path
// (Task = stack) next to the other one (Promise = state machine).

import { print } from "tension-framework";

// Counts every may-suspend body that actually started. Read twice, around one
// await, which is property 1 above.
let bodiesRun: i32 = 0;

/** The leaf: it still suspends once, so a chain's bottom is not special. */
async function base(): i32 {
  bodiesRun += 1;
  print("    base: runs (bodies run=" + bodiesRun.toString() + ")");
  return 7;
}

async function mid(x: i32): i32 {
  bodiesRun += 1;
  print("    mid: runs, x=" + x.toString());
  // `b` is lifted across the suspension below.
  let b: i32 = await base();
  print("    mid: after await base, b=" + b.toString());
  return x + b;
}

async function outer(x: i32): i32 {
  bodiesRun += 1;
  print("    outer: runs, x=" + x.toString());
  let m: i32 = await mid(x);
  print("    outer: after await mid, m=" + m.toString());
  return m * 2;
}

export async function main(): i32 {
  print("main: begin");

  print("main: before await outer(1) — bodies run=" + bodiesRun.toString());
  let a: i32 = await outer(1);
  print("main: after await outer(1) — bodies run=" + bodiesRun.toString() + ", a=" + a.toString());

  // `total` is assigned here, before any suspension in the loop, and read after
  // each one: the lifted-local check.
  let total: i32 = a;
  print("main: total before the loop=" + total.toString());

  for (let i: i32 = 0; i < 3; i++) {
    print("main: loop i=" + i.toString() + " before await");
    let v: i32 = await mid(i * 10);
    print("main: loop i=" + i.toString() + " after await, v=" + v.toString());
    total += v;
    print("main: loop i=" + i.toString() + " total=" + total.toString());
  }

  print("main: done, total=" + total.toString());
  return total;
}

/// The host's entry export.
///
/// **It is empty, and that is the point of the showcase.** With `--exportStart
/// __start` the compiler puts the boot body and the core loop in `__start`,
/// which the host calls *before* the game entry — so `main` has already run to
/// completion by the time this is reached. A host-driven guest would export
/// `_game_running` as well; this one has nothing left to drive.
export function _start_game(): void {}
