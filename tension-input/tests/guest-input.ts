// guest-input.ts — the input capability's guest fixture.
//
//   tension-core --capability tension-input/build/libtension_input.so \
//       tension-input/build/guest-input.wasm
//
// One file, four modes, because all four need the same three things: a session,
// a host window the guest created itself, and an attached input capability.
//
//   (default)        the functional case. Creates a 320x200 window, opens input,
//                    attaches, reads one state record and every pad slot,
//                    closes. Prints `OK attached flags=… pads=…`.
//   --no-window      the refusal case. No window is created, so `attach` answers
//                    -ENODEV and the fixture prints `OK headless -ENODEV`. That
//                    is a legal answer, not a failure — the same shape the ogre
//                    capability's no-display case uses.
//   --mode=fidelity  the hard gate. Runs a fixed number of frames at
//                    `--cadence=<ms>`, accumulating `mouse_dxf`/`mouse_dyf`, and
//                    prints `FIDELITY dx=… dy=… frames=…`. The driver script
//                    injects a known displacement while it runs; the totals must
//                    agree with it (test-input-edge.mjs).
//   --mode=latency   the soft gate. Same loop, but prints one `FRAME <index>
//                    <count>` line per frame that saw key events, so the script
//                    can time each observation against when it injected the key.
//
// **The guest has no clock**, deliberately — there is no monotonic-time import in
// the ABI, and inventing one for a measurement would be a wire change in a pass
// that is meant to remove a component. Everything here is counted in frames, and
// the script that drives it owns the seconds.

import { arg, argCount, print } from "../../tension-framework/assembly/io";
import {
  CLASS_INPUT_KEY,
  CLASS_INPUT_MOUSE,
  ConfigBuilder,
  EVENT_RECORD_SIZE,
  EventRecord,
  MODE_BATCHED,
  RuntimeSession,
  SUBSCRIPTION_SIZE,
  Subscription,
  makeCallbacks,
} from "../../tension-framework/assembly/runtime";
import * as input from "../../tension-framework/assembly/input";
import * as platform from "../../tension-framework/assembly/platform";

/// -ENODEV: no window, or nothing attached yet (see the header).
const ENODEV: i32 = -19;
/// -ENOENT: an empty gamepad slot, which is normal.
const ENOENT: i32 = -2;

let edge_mode: bool = false;
let key_events: u32 = 0;
let mouse_events: u32 = 0;
/// Set while a measurement loop is running: each frame that saw key events
/// prints its index and how many it saw, so the script can time the first
/// observation against the injection.
let latency_mode: bool = false;
let frame_index: u32 = 0;

/// Print every record a batch carries. This is the guest end of the wire:
/// SDL -> the host's pump -> the layer -> the session's ring -> here.
function print_batch(class_: u32, ptr: u32, count: u32): i32 {
  for (let i: u32 = 0; i < count; i++) {
    const record = changetype<EventRecord>(ptr + i * EVENT_RECORD_SIZE);
    if (class_ == CLASS_INPUT_KEY) {
      if (key_events <= 8) {
        print(
          "  KEY   flags=0x" +
            hex(record.flags) +
            " keycode=0x" +
            hex(record.a) +
            " scancode=" +
            record.b.toString()
        );
      }
    } else if (class_ == CLASS_INPUT_MOUSE) {
      if (mouse_events <= 8) {
        print(
          "  MOUSE shape=" +
            (record.flags & 0x3).toString() +
            " a=" +
            (<i32>record.a).toString() +
            " b=0x" +
            hex(record.b) +
            " f0=" +
            record.f0.toString() +
            " f1=" +
            record.f1.toString()
        );
      }
    }
  }
  return 0;
}

/// Every delivery is counted, whether or not it is printed: the measurement
/// modes need the totals, and `--verbose` only decides how much of each line is
/// shown. (Counting inside the printer was a bug worth this comment: the first
/// latency run measured 0 keys because the printer never ran.)
function count_batch(class_: u32, count: u32): void {
  if (class_ == CLASS_INPUT_KEY) key_events += count;
  else if (class_ == CLASS_INPUT_MOUSE) mouse_events += count;
}

function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  count_batch(class_, count);
  return edge_mode ? print_batch(class_, ptr, count) : 0;
}

function onEvent(class_: u32, ptr: u32): i32 {
  count_batch(class_, 1);
  return edge_mode ? print_batch(class_, ptr, 1) : 0;
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

/// `--name` present?
function has(name: string): bool {
  for (let i: i32 = 0; i < argCount(); i++) {
    if (arg(i) == "--" + name) return true;
  }
  return false;
}

function hex(value: u32): string {
  if (value == 0) return "0";
  let digits = "";
  const table = "0123456789abcdef";
  while (value > 0) {
    digits = table.charAt(<i32>(value & 0xF)) + digits;
    value = value >>> 4;
  }
  return digits;
}

/// A guest-created window, or an invalid handle.
///
/// **The guest owns this.** Under v7 there is no `--window` flag and no window
/// the host made for input: an application that wants one asks for it, and the
/// input capability joins whatever exists.
function open_window(): platform.Window {
  const config = new platform.WindowConfig();
  config.target = platform.WindowTarget.Plain;
  config.width = 320;
  config.height = 200;
  config.title = "tension-input";
  config.flags = platform.WindowFlags.Resizable | platform.WindowFlags.Decorated;
  return platform.createWindow(config);
}

/// The session, opened, with both reserved classes subscribed.
function open_session(): void {
  const callbacks = makeCallbacks(onBatch, onEvent);
  const session_config = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session_config, callbacks) == 0, "session_open refused");
  const subscription = changetype<Subscription>(heap.alloc(SUBSCRIPTION_SIZE));
  subscription.class_ = CLASS_INPUT_KEY;
  subscription.mode = MODE_BATCHED;
  subscription.flags = 0;
  subscription.reserved = 0;
  assert(RuntimeSession.subscribe(subscription) == 0, "subscribe INPUT_KEY refused");
  subscription.class_ = CLASS_INPUT_MOUSE;
  assert(RuntimeSession.subscribe(subscription) == 0, "subscribe INPUT_MOUSE refused");
}

// ── the functional case ─────────────────────────────────────────────────────

function run_basic(create_window: bool): void {
  open_session();
  let window: platform.Window = new platform.Window(0, 0);
  if (create_window) {
    window = open_window();
    if (!window.isValid()) {
      // The host could not make a window (no display, no driver). That is the
      // headless answer for this fixture, not a failure.
      print("OK headless -ENODEV (createWindow answered " + window.error.toString() + ")");
      assert(RuntimeSession.close() == 0, "session_close");
      return;
    }
  }

  const handle = input.open(0);
  assert(handle > 0, "input_open refused with " + handle.toString());

  const attached = input.attach(handle, input.Kind.OwnSurface, 0, 0);
  if (!create_window) {
    assert(attached == ENODEV, "attach without a window answered " + attached.toString());
    print("OK headless -ENODEV");
    assert(input.close(handle) == 0, "input_close");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }
  assert(attached == 0, "input_attach refused with " + attached.toString());

  const stated = input.stateSize(handle);
  assert(<u32>stated == input.STATE_SIZE, "input_state's probe is not the record size");

  const buffer = heap.alloc(input.STATE_SIZE);
  const wrote = input.state(handle, buffer);
  assert(<u32>wrote == input.STATE_SIZE, "input_state wrote " + wrote.toString() + " bytes");

  const state = input.InputState.read(buffer);
  assert(state.version == 1, "the state record's version is not 1");
  assert(state.attached(), "the state record does not say ATTACHED");
  // Nothing has moved a pointer: the deltas are the attach settle's, already
  // discarded, so they are zero — the round-21 rule, visible from the guest.
  assert(state.mouseDxf == 0.0 && state.mouseDyf == 0.0, "a delta survived the settle window");

  // Gamepads come from the host now: `pads_present` is what the host's mirror
  // says, and an empty slot answers -ENOENT either way.
  const pad_buffer = heap.alloc(input.PAD_SIZE);
  let live_slots: u32 = 0;
  for (let slot: i32 = 0; slot < <i32>input.PAD_SLOTS; slot++) {
    const rc = input.pad(handle, slot, pad_buffer);
    if (rc == 0) live_slots++;
    else assert(rc == ENOENT, "pad(" + slot.toString() + ") answered " + rc.toString());
  }
  assert(state.padsPresent == live_slots, "pads_present disagrees with the pad records");

  // Relative mouse mode is a *request* to the host's executor now. The flag
  // reports the accepted request; the host logs the refusal if it cannot apply
  // it, which on a real window it can.
  assert(input.setRelative(handle, true) == 0, "set_relative refused");
  const after_relative = input.state(handle, buffer);
  assert(<u32>after_relative == input.STATE_SIZE, "state after set_relative");
  const relative_state = input.InputState.read(buffer);
  assert(relative_state.relative(), "RELATIVE is not set after a successful request");
  assert(input.setRelative(handle, false) == 0, "set_relative off refused");

  print(
    "OK attached flags=0x" +
      hex(state.flags) +
      " pads=" +
      state.padsPresent.toString() +
      " window=" +
      window.info().width.toString() +
      "x" +
      window.info().height.toString()
  );

  assert(input.close(handle) == 0, "input_close");
  assert(window.close() == 0, "window close");
  assert(RuntimeSession.close() == 0, "session_close");
}

// ── the measurement loops ───────────────────────────────────────────────────

/// Attach, then run `frames` frames at `cadence_ms`.
///
/// Each frame is one `session.wait`, which is also the pump: the host drains SDL
/// and dispatches the batch before the epoch runs (thread rule 13). So the frame
/// period *is* the pump period, and varying it is how the fidelity question
/// ("does a slow guest lose motion?") gets asked.
function measure(cadence_ms: i32, frames: u32, fidelity: bool): void {
  open_session();
  const window = open_window();
  assert(window.isValid(), "createWindow refused: " + window.error.toString());

  const handle = input.open(0);
  assert(handle > 0, "input_open refused");
  assert(input.attach(handle, input.Kind.OwnSurface, 0, 0) == 0, "attach refused");
  assert(input.setRelative(handle, true) == 0, "set_relative refused");

  // The settle window is 500 ms of *wall* time and the guest has no clock, so it
  // is spent as frames: at any cadence 40 frames is at least 80 ms and at most
  // 1.3 s, and the driver script starts injecting only after READY, which is
  // printed after this. An over-long wait is harmless; a short one is not.
  const settle_frames: u32 = <u32>(500 / cadence_ms) + 8;
  for (let i: u32 = 0; i < settle_frames; i++) {
    RuntimeSession.wait(cadence_ms);
    RuntimeSession.drain(CLASS_INPUT_KEY);
    RuntimeSession.drain(CLASS_INPUT_MOUSE);
  }

  print("READY");
  const buffer = heap.alloc(input.STATE_SIZE);
  let flags: u32 = 0;
  let dx: f32 = 0.0;
  let dy: f32 = 0.0;
  let polled: u32 = 0;
  for (let i: u32 = 0; i < frames; i++) {
    // Before the wait, not after: the callbacks run *inside* it, so a counter
    // read afterwards already includes this frame's delivery.
    const keys_before = key_events;
    RuntimeSession.wait(cadence_ms);
    RuntimeSession.drain(CLASS_INPUT_KEY);
    RuntimeSession.drain(CLASS_INPUT_MOUSE);
    frame_index = i;
    const wrote = input.state(handle, buffer);
    if (<u32>wrote == input.STATE_SIZE) {
      const state = input.InputState.read(buffer);
      flags = state.flags;
      polled++;
      dx += state.mouseDxf;
      dy += state.mouseDyf;
    }
    // The latency probe reads this: which frame saw key events, and how many.
    if (latency_mode && key_events != keys_before) {
      print("FRAME " + i.toString() + " " + key_events.toString());
    }
  }

  if (fidelity) {
    print(
      "FIDELITY dx=" +
        dx.toString() +
        " dy=" +
        dy.toString() +
        " frames=" +
        polled.toString() +
        " keys=" +
        key_events.toString()
    );
  } else {
    print(
      "LATENCY frames=" +
        polled.toString() +
        " keys=" +
        key_events.toString() +
        " mouse=" +
        mouse_events.toString() +
        " flags=0x" +
        hex(flags)
    );
  }

  assert(input.close(handle) == 0, "input_close");
  assert(window.close() == 0, "window close");
  assert(RuntimeSession.close() == 0, "session_close");
}

export function _start_game(): void {
  const mode = flag("mode", "");
  if (mode.length > 0) {
    const cadence = I32.parseInt(flag("cadence", "16"));
    const frames = u32(I32.parseInt(flag("frames", "120")));
    edge_mode = has("verbose");
    latency_mode = mode == "latency";
    measure(cadence, frames, mode == "fidelity");
    return;
  }
  run_basic(!has("no-window"));
}
