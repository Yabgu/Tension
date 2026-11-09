// The platform example: a guest that asks the host to resize its own window,
// then watches for it to happen.
//
// This is the readable proof of the north star's write direction. The guest does
// not touch SDL — it cannot — and it does not receive a callback either. It
// posts a message, and it learns the result by polling the same numbers a
// renderer reads.
//
//   npm start                              a window, resized a little
//   TENSION_PLATFORM_FRAMES=60 npm start    more patience
//
// The shape of the loop is the point:
//
//   frame 0    post RESIZE (w+64, h+64)     returns 0: queued
//   frame 1    the host drains, on the thread that owns the window, and calls
//              SDL_SetWindowSize
//   frame 1-2  surfaceWidth() reports the new size
//
// A frame or two between asking and seeing is not a race — it is the contract.
// "Queued" and "applied" are different instants by design, because SDL's window
// API belongs to one thread and this is wasm. A guest that read the size back in
// the same frame would see the old value, correctly.
//
// The host end is tested by `tension-core/tests/platform_control.rs`; this
// example is the version a person can read.

import { ConfigBuilder, print, RuntimeSession, rt } from "tension-framework";
import * as platform from "tension-framework/assembly/platform";
import { __taskBindTable } from "~lib/task-rt";

// The host's wake entries. Re-exported because the linker drops an export the
// guest never names, and the host resolves these by name at load.
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

/// How many frames to wait for the resize to become visible.
///
/// Bounded on purpose: a host that never applied the message must fail loudly
/// rather than hang the run. Ten is generous; the contract is one or two.
const TIMEOUT_FRAMES: i32 = 10;

let done: bool = false;
let startWidth: i32 = 0;

/// 1 while the guest still wants the host to drive it.
export function _game_running(): i32 {
  return done ? 0 : 1;
}

function fail(what: string): void {
  print("platform: FAIL " + what);
  done = true;
  assert(false, what);   // a guest exits non-zero by trapping
}

/// The loop: one park per frame, one comparison per frame.
async function gameLoop(): void {
  let frame: i32 = 0;
  let running: bool = true;

  while (running) {
    await rt.frame();
    frame += 1;

    // Explicitly typed: a local that crosses an `await` needs a declared type,
    // which the compiler refuses to infer (AS100).
    const width: u32 = platform.surfaceWidth();
    const height: u32 = platform.surfaceHeight();

    // Visible when the width moves off what the guest started from.
    if (width != 0 && width != startWidth) {
      print("platform: now " + width.toString() + "x" + height.toString() +
            " after " + frame.toString() + " frame(s)");
      running = false;   // no `break`: the transform refuses it in async bodies
    } else if (frame >= TIMEOUT_FRAMES) {
      fail("the host never applied the resize within " + TIMEOUT_FRAMES.toString() +
           " frames (still " + width.toString() + "x" + height.toString() + ")");
      running = false;
    }
  }
  done = true;
}

/// The window this example asks for: 320x240, plain, resizable.
function makeWindowConfig(): platform.WindowConfig {
  const config = new platform.WindowConfig();
  config.target = platform.WindowTarget.Plain;
  config.width = 320;
  config.height = 240;
  config.title = "platform-control";
  return config;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);

  // The window is the guest's to create: the runtime has no flag for it, and a
  // runtime that opened one unasked would be application configuration in the
  // wrong place. `Plain` because nothing renders into it — this example only
  // resizes it and watches the size come back.
  const window = platform.createWindow(makeWindowConfig());
  if (!window.isValid()) {
    fail("createWindow -> " + window.error.toString());
    return;
  }

  // No window: nothing to resize. A refusal, not a skip — a run that passed
  // here would pass on a host that never opened a window at all. Kept even
  // though `createWindow` just succeeded: it is the assertion that the two
  // answers agree.
  if (!platform.hasSurface()) {
    fail("createWindow succeeded but the host reports no surface");
    return;
  }

  startWidth = <i32>platform.surfaceWidth();
  const startHeight = <i32>platform.surfaceHeight();
  print("platform: surface " + startWidth.toString() + "x" + startHeight.toString());

  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    fail("the session refused to open (" + opened.toString() + ")");
    return;
  }

  // Ask before the first frame, so the host has drained by frame 1.
  const rc = platform.resize(startWidth + 64, startHeight + 64);
  if (rc != 0) {
    fail("resize returned " + rc.toString());
    return;
  }
  print("platform: asked for " + (startWidth + 64).toString() + "x" +
        (startHeight + 64).toString());

  gameLoop();   // floating task: parks on the first `await rt.frame()`
}
