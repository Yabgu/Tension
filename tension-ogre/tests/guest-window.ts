// The hello-window guest: the milestone's own proof, run by tension-core with
// the OGRE adapter loaded.
//
//   tension-core --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-window.wasm --renderer=null
//
// What one run proves, in order: the guest opens the session itself, asks the
// capability for a renderer, is told when the window is up — an event posted
// from *another thread*, which is why `session_wait` can block here and could
// not against the chunk-1 stub (DESIGN.md §3.3) — reads the renderer's status
// record (events are advisory, the record is the truth), watches the frame
// counter tick, asks for shutdown, and closes.
//
// Flags, all optional:
//   --renderer=null|gl3plus   (default null: the headless gate's renderer)
//   --frames=N                how many frames must have run before OK
//   --window-width=N --window-height=N
//   --expect-fail             a DEVICE_LOST is the expected answer: print
//                             "FAIL <stage> <errno>" and exit cleanly
//   --shutdown-only           call ogre::shutdown before any init and stop

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  CLASS_DEVICE_LOST,
  CLASS_RESOURCE_READY,
  ConfigBuilder,
  EventRecord,
  MODE_DIRECT,
  REGION_RESOURCE,
  RuntimeSession,
  SUBSCRIPTION_SIZE,
  Subscription,
  makeCallbacks,
  regionOffset,
} from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { RES_STATE_READY } from "../../tension-framework/assembly/ogre/wire";

/// The Resource record's fields this fixture reads (`assembly/ogre/wire.ts`).
const RESOURCE_STATE_OFFSET: u32 = 8;
const RESOURCE_ERROR_OFFSET: u32 = 28;
const RESOURCE_SEQ_OFFSET: u32 = 40;

let saw_ready: bool = false;
let saw_device_lost: bool = false;
let lost_stage: u32 = 0;
let lost_errno: i32 = 0;

function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  // Nothing subscribes as batched here; the slot exists so the callbacks
  // record has two real table indices rather than one.
  return 0;
}

function onEvent(class_: u32, ptr: u32): i32 {
  const record = changetype<EventRecord>(ptr);
  if (record.class_ == CLASS_RESOURCE_READY) {
    saw_ready = true;
  } else if (record.class_ == CLASS_DEVICE_LOST) {
    saw_device_lost = true;
    lost_stage = record.a;
    lost_errno = <i32>record.b;
  }
  return 0;
}

/// `--name=value`, or the fallback.
function flag(name: string, fallback: string): string {
  const prefix = "--" + name + "=";
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return fallback;
}

function has(name: string): bool {
  for (let i: i32 = 0; i < argCount(); i++) {
    if (arg(i) == "--" + name) return true;
  }
  return false;
}

function decimal(value: u32): string {
  if (value == 0) return "0";
  let digits = "";
  while (value > 0) {
    digits = String.fromCharCode(48 + (value % 10)) + digits;
    value = value / 10;
  }
  return digits;
}

function decimalSigned(value: i32): string {
  return value < 0 ? "-" + decimal(<u32>(-value)) : decimal(<u32>value);
}

export function _start_game(): void {
  const renderer = flag("renderer", "null");
  const wanted_frames = u32(I32.parseInt(flag("frames", "3")));
  const width = u32(I32.parseInt(flag("window-width", "1280")));
  const height = u32(I32.parseInt(flag("window-height", "720")));
  const expect_fail = has("expect-fail");

  // Before anything else: shutdown with nothing running is 0, not an error.
  if (has("shutdown-only")) {
    assert(ogre.shutdown() == 0, "ogre::shutdown before init must return 0");
    print("OK shutdown-before-init");
    return;
  }

  // Named explicitly rather than defaulted: a renderer this build cannot
  // provide must reach the adapter as itself, so the refusal names it.
  let which: ogre.Renderer = ogre.Renderer.Null;
  if (renderer == "gl3plus") which = ogre.Renderer.Gl3Plus;
  else if (renderer == "vulkan") which = ogre.Renderer.Vulkan;
  else if (renderer == "metal") which = ogre.Renderer.Metal;
  const headless = which == ogre.Renderer.Null;
  const ogre_config = new ogre.ConfigBuilder()
    .renderer(which)
    .headless(headless)
    .vsync(false)
    .frameHz(60)
    .windowSize(width, height);

  const callbacks = makeCallbacks(onBatch, onEvent);
  const session_config = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session_config, callbacks) == 0, "session_open refused");

  const subscription = changetype<Subscription>(heap.alloc(SUBSCRIPTION_SIZE));
  subscription.class_ = CLASS_RESOURCE_READY;
  subscription.mode = MODE_DIRECT;
  subscription.flags = 0;
  subscription.reserved = 0;
  assert(RuntimeSession.subscribe(subscription) == 0, "subscribe RESOURCE_READY refused");
  subscription.class_ = CLASS_DEVICE_LOST;
  assert(RuntimeSession.subscribe(subscription) == 0, "subscribe DEVICE_LOST refused");

  // Accepted here; the window comes up on the render thread, which is what the
  // event below is for.
  assert(ogre.init(ogre_config) == 0, "ogre::init refused the config");

  // Bounded, not infinite: if the render thread dies without posting, the
  // guest should say so rather than hang. Ten seconds is the whole budget.
  const delivered = RuntimeSession.wait(10000);

  if (saw_device_lost) {
    if (expect_fail) {
      print("FAIL " + decimal(lost_stage) + " " + decimalSigned(lost_errno));
      assert(ogre.shutdown() == 0, "ogre::shutdown after a failure");
      assert(RuntimeSession.close() == 0, "session_close");
      return;
    }
    assert(false, "the renderer reported DEVICE_LOST");
  }
  assert(delivered >= 0, "session_wait refused");
  assert(saw_ready, "no RESOURCE_READY within 10s — the render thread never reported");

  // Let frames run, then read the record: the event said "ready", the table
  // says how it has been since.
  assert(RuntimeSession.wait(250) >= 0, "the second wait refused");
  const record = regionOffset(REGION_RESOURCE);
  const state = load<u32>(record + RESOURCE_STATE_OFFSET);
  const error = load<i32>(record + RESOURCE_ERROR_OFFSET);
  const frames = load<u64>(record + RESOURCE_SEQ_OFFSET);
  assert(state == RES_STATE_READY, "the renderer's record does not say READY");
  assert(error == 0, "the renderer's record carries an error");
  assert(frames >= wanted_frames, "the frame counter has not reached the requested frames");

  print("OK " + decimal(<u32>frames) + " " + decimal(width) + "x" + decimal(height));

  assert(ogre.shutdown() == 0, "ogre::shutdown");
  assert(RuntimeSession.close() == 0, "session_close");
}
