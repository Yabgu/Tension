// An `async main` on the **Promise** backend: the state machine, started and
// driven, with no stack switching and no thread.
//
// This is the program round AS2 fixed. Before it, a build without `--enable
// stack-switching` emitted **no shell at all** for a program that awaited, so
// `main` had zero call sites and this guest exited 0 having printed nothing —
// on Linux as well as on Windows. The mechanism was `hasAwait`, latched from
// every parsed source, gating the only shell that existed.
//
// What the transcript proves, in order:
//
//   * `main` runs at all (the fix's whole point);
//   * an `await` whose callee settles inside its own entry falls through;
//   * an `await` chain three deep resumes in the right order (`leaf` ->
//     `chain` -> `main`), which is `drainReady` driving parked states;
//   * a suspension in a loop resumes for each iteration;
//   * `main`'s return value is a handle, so the value assertions are the
//     `print`s, not `__asyncStatus`.
//
// Built with `PLAIN_FLAGS` (`scripts/build-test-programs.mjs`), so nothing here
// is silent about which backend it measures: a stray `--enable stack-switching`
// would turn this into a test of the stackful path under a Promise-program name.
//
// `print` comes from the framework's `io` module and not its barrel: the barrel
// re-exports `./2d`, whose `scene.ts` contains an `await` in a function this
// program never calls. Importing it would make the program depend on the very
// reachability-blindness that caused the defect — a useful measurement (round
// AP1), and a bad thing for a regression test to hinge on.
import { print } from "../../../../tension-framework/assembly/io";

let bodies: i32 = 0;

/// Settles inside its own entry: the await of this task never parks.
async function leaf(x: i32): i32 {
  bodies += 1;
  print("leaf " + x.toString());
  return x * 2;
}

/// Parks on `leaf` and is resumed by the shell's drain.
async function chain(x: i32): i32 {
  bodies += 1;
  print("chain before " + x.toString());
  let a: i32 = await leaf(x);
  print("chain after " + a.toString());
  return a + 1;
}

/// The host's entry export, empty by design — the same shape
/// `examples/async-on-main/game.ts` uses. `--exportStart __start` makes the boot
/// body and the Promise shell an export the host calls *before* this, so `main`
/// has already run by the time this is reached.
export function _start_game(): void {}

export async function main(): i32 {
  bodies += 1;
  print("main begin");
  let a: i32 = await chain(20);
  print("main after " + a.toString());
  let total: i32 = 0;
  for (let i: i32 = 0; i < 3; i++) {
    // One await per statement, in one of Backend A's four supported positions:
    // `total += await leaf(i)` is not one of them (`AS100: await in an
    // unsupported position`), so the value lands in a local first.
    let v: i32 = await leaf(i);
    total += v;
  }
  print("main loop " + total.toString());
  print("bodies " + bodies.toString());
  return total;
}
