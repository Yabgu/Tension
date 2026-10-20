// tension-framework/tests/guest-flow.ts — `break` and `continue` inside an
// await-bearing loop (0.7.1).
//
// The last compiler gap: `break` and `continue` were refused
// ("Not implemented: break in an async function body (async lowering)") because
// the planner had no case for them, so they fell through to `default:` and the
// refusal. Every adopting game worked around it by carrying a `running` flag
// out of the loop instead.
//
// Four shapes, because two of them can go wrong in ways the others cannot:
//
//   1. `while` + `break`      — exits the loop, the task completes normally.
//   2. `while` + `continue`   — skips the rest of the iteration.
//   3. `for` + `continue`     — **the subtle one.** The transform emits an
//                               instrumented `for` as a `while` with the
//                               incrementor *appended to the body*, so a native
//                               `continue` would skip it and spin forever. This
//                               case is what proves the incrementor moved back
//                               into the loop's increment position.
//   4. `for` + `break`        — exits from inside the incrementor-carrying loop.
//
// Every value below is computed by hand in the comments, so a wrong resume point
// shows up as a wrong number rather than as a hang.

import { __taskBindTable } from "~lib/task-rt";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

let over: bool = false;
let failures: i32 = 0;

function expect(label: string, actual: i32, want: i32): void {
  if (actual == want) {
    print("FLOW " + label + " = " + actual.toString());
  } else {
    print("FLOW FAIL " + label + " = " + actual.toString() + ", want " + want.toString());
    failures += 1;
  }
}

/// 1. `while` + `break`: parks every iteration, leaves when i == 3.
async function whileBreak(): i32 {
  let i: i32 = 0;
  while (i < 10) {
    await rt.frame();
    if (i == 3) break;
    i += 1;
  }
  return i;                     // 3
}

/// 2. `while` + `continue`: sums the odd values of 1..6 → 1+3+5 = 9.
async function whileContinue(): i32 {
  let i: i32 = 0;
  let sum: i32 = 0;
  while (i < 6) {
    await rt.frame();
    i += 1;
    if (i % 2 == 0) continue;    // skips the rest of this iteration
    sum += i;
  }
  return sum;                   // 9
}

/// 3. `for` + `continue`: the incrementor must still run, so this terminates.
/// Sums the odd values of 0..5 → 1+3+5 = 9 after i++ has run each time.
async function forContinue(): i32 {
  let sum: i32 = 0;
  for (let i: i32 = 0; i < 6; i++) {
    await rt.frame();
    if (i % 2 == 0) continue;
    sum += i;
  }
  return sum;                   // 9
}

/// 4. `for` + `break`: leaves at i == 4, so i is 4 and the sum is 1+2+3 = 6.
async function forBreak(): i32 {
  let sum: i32 = 0;
  let ended: i32 = 0;
  for (let i: i32 = 0; i < 10; i++) {
    await rt.frame();
    if (i == 4) {
      ended = i;
      break;
    }
    sum += i;
  }
  return ended * 100 + sum;     // 406
}

async function run(): void {
  // Every await is bound to a local first: `await f()` in an argument position
  // is refused ("await in an unsupported position"), which is its own limit and
  // not what this fixture measures.
  let a: i32 = await whileBreak();
  expect("while+break", a, 3);
  let b: i32 = await whileContinue();
  expect("while+continue", b, 9);
  let c: i32 = await forContinue();
  expect("for+continue", c, 9);
  let d: i32 = await forBreak();
  expect("for+break", d, 406);
  if (failures == 0) print("FLOW PASS");
  over = true;
}

export function _game_running(): i32 {
  return over ? 0 : 1;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);
  const callbacks = rt.callbacks();
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("FLOW FAIL the session refused to open");
    over = true;
    return;
  }
  run();
}
