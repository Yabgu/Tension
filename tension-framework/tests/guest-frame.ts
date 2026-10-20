// tension-framework/tests/guest-frame.ts — the frame clock, end to end.
//
// 2B-continued's gate. The guest awaits `rt.frame()`; nothing in the guest
// produces frames, so a resume can only come from the host loop waking it after
// the renderer signalled. Counting frames proves the signal reached the loop and
// the loop reached the guest.
//
// Adapter-free: this fixture runs with no capability, so there is no render
// thread to signal. What it exercises is the *completion* half of the loop plus
// the exit condition — `_game_running()` returns 0 after N frames, so the loop
// must stop on its own. The OGRE signal path is measured separately, by running
// an OGRE example with the host loop (`--capability`), where `signal_frame`
// fires from the render thread.

import { __taskBindTable } from "~lib/task-rt";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";
import { rt } from "../assembly/runtime/rt";

export { __taskWake } from "~lib/task-rt";

const FRAMES: i32 = 3;
let frame: i32 = 0;
let done: bool = false;

/// 1 while the guest still wants the host to drive it.
export function _game_running(): i32 {
  return done ? 0 : 1;
}

/// The frame loop: a loop over frames, not over readiness.
async function gameLoop(): void {
  let running: bool = true;
  while (running) {
    // Parks on (FRAME, 0). The host loop's `wake(ids)` is the only thing that
    // resumes it — there is no `__taskTick` call in this guest.
    await rt.frame();
    frame += 1;
    if (frame >= FRAMES) {
      running = false;   // no `break`: the transform refuses it in async bodies
    }
  }
  print("FRAME loop finished after " + frame.toString() + " frames");
  done = true;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);

  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("FRAME FAIL the session refused to open (" + opened.toString() + ")");
    done = true;
    return;
  }
  gameLoop();     // floating task: parks on the first `await rt.frame()`
}
