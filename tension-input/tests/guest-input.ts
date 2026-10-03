// guest-input.ts — the input capability's guest fixture.
//
//   tension-core --capability tension-input/build/libtension_input.so \
//       tension-input/build/guest-input.wasm
//
// What one run proves: the guest opens the session itself, opens an input
// handle, attaches to input's *own* surface (kind 0 — no renderer involved,
// which is the non-goal INPUT.md §6 states: a text game needs this capability
// and no OGRE), reads one state record and prints its flags, and closes.
//
// **The headless case is a legal answer.** With no display, `input_open`
// (or the attach) refuses with `-ENODEV`, and this fixture prints
// "OK headless -ENODEV" and exits 0 — the same shape as the ogre capability's
// no-display case, where the refusal is the expected result and the guest says
// so on stdout. A runner asserts on the `OK ` prefix either way.

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

/// -ENODEV: no display, no window, nothing attached yet (see the header).
const ENODEV: i32 = -19;

/// Set by edge mode before the session opens; the callbacks are resolved from
/// the record at open time, so one pair serves both modes.
let edge_mode: bool = false;
let key_events: u32 = 0;
let mouse_events: u32 = 0;
let key_lines: u32 = 0;
let mouse_lines: u32 = 0;

/// Print every record a batch carries. This is the guest end of the wire:
/// SDL -> the DSO's post_event -> the session's ring -> here.
function print_batch(class_: u32, ptr: u32, count: u32): i32 {
  for (let i: u32 = 0; i < count; i++) {
    const record = changetype<EventRecord>(ptr + i * EVENT_RECORD_SIZE);
    if (class_ == CLASS_INPUT_KEY) {
      key_events++;
      if (key_lines < 32) {
        key_lines++;
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
      mouse_events++;
      if (mouse_lines < 32) {
        mouse_lines++;
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

function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  return edge_mode ? print_batch(class_, ptr, count) : 0;
}

function onEvent(class_: u32, ptr: u32): i32 {
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

/// Edge mode: the end-to-end test. Everything before this is structural — this
/// is the one that carries a real key press and a real mouse delta from the
/// device to a guest callback.
function run_edge(): void {
  const seconds = u32(I32.parseInt(flag("seconds", "20")));
  edge_mode = true;
  const callbacks = makeCallbacks(onBatch, onEvent);
  const session_config = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session_config, callbacks) == 0, "session_open refused");

  const handle = input.open(0);
  assert(handle > 0, "input_open refused: " + handle.toString());
  assert(input.attach(handle, input.Kind.OwnSurface, 0, 0) == 0, "attach refused");
  assert(input.setRelative(handle, true) == 0, "set_relative refused");

  const subscription = changetype<Subscription>(heap.alloc(SUBSCRIPTION_SIZE));
  subscription.class_ = CLASS_INPUT_KEY;
  subscription.mode = MODE_BATCHED;
  subscription.flags = 0;
  subscription.reserved = 0;
  assert(RuntimeSession.subscribe(subscription) == 0, "subscribe INPUT_KEY refused");
  subscription.class_ = CLASS_INPUT_MOUSE;
  assert(RuntimeSession.subscribe(subscription) == 0, "subscribe INPUT_MOUSE refused");

  print("EDGE: the probe's own window is 'tension-input' (320x200).");
  print("EDGE: put the POINTER OVER THAT WINDOW, move the mouse, then press a few KEYS.");
  print("EDGE: running for " + seconds.toString() + " s (" + (seconds * 63).toString() + " wait(16) iterations).");

  const state_buffer = heap.alloc(input.STATE_SIZE);
  let dx: f32 = 0.0;
  let dy: f32 = 0.0;
  let epochs: u32 = 0;
  let moved_epochs: u32 = 0;
  let focused_epochs: u32 = 0;
  let waits_with_records: u32 = 0;
  let first_motion_iteration: i32 = -1;

  const iterations = seconds * 63;
  for (let i: u32 = 0; i < iterations; i++) {
    if (i > 0 && i % 315 == 0) {
      print("EDGE t~" + (i / 63).toString() + "s: keys=" + key_events.toString() + " mouse=" + mouse_events.toString() + " motion-epochs=" + moved_epochs.toString());
    }
    const delivered = RuntimeSession.wait(16);
    if (delivered > 0) waits_with_records++;
    // The epoch runs inside wait; these make the drain explicit, as the brief
    // asks, and they are where a POLLED subscription would deliver instead.
    RuntimeSession.drain(CLASS_INPUT_KEY);
    RuntimeSession.drain(CLASS_INPUT_MOUSE);

    const wrote = input.state(handle, state_buffer);
    if (<u32>wrote == input.STATE_SIZE) {
      const state = input.InputState.read(state_buffer);
      epochs++;
      if (state.focused()) focused_epochs++;
      if (state.mouseDxf != 0.0 || state.mouseDyf != 0.0) {
        moved_epochs++;
        if (first_motion_iteration < 0) first_motion_iteration = <i32>i;
        dx += state.mouseDxf;
        dy += state.mouseDyf;
      }
    }
  }

  print("EDGE SUMMARY");
  print("  key events .......... " + key_events.toString());
  print("  mouse events ........ " + mouse_events.toString() + "  (buttons/wheel; motion is state)");
  print("  epochs polled ....... " + epochs.toString());
  print("  epochs focused ...... " + focused_epochs.toString());
  print("  epochs with motion .. " + moved_epochs.toString());
  print("  waits with records .. " + waits_with_records.toString());
  print("  accumulated delta ... dx=" + dx.toString() + " dy=" + dy.toString());
  print(
    "  first motion at ..... " +
      (first_motion_iteration < 0 ? "never" : (first_motion_iteration * 16).toString() + " ms into the loop")
  );

  assert(input.close(handle) == 0, "input_close");
  assert(RuntimeSession.close() == 0, "session_close");
  print("OK edge");
}

export function _start_game(): void {
  if (has("edge")) {
    run_edge();
    return;
  }
  const callbacks = makeCallbacks(onBatch, onEvent);
  const session_config = ConfigBuilder.forThisBuild(callbacks);
  assert(RuntimeSession.open(session_config, callbacks) == 0, "session_open refused");

  const handle = input.open(0);
  if (handle == ENODEV) {
    print("OK headless -ENODEV");
    assert(RuntimeSession.close() == 0, "session_close");
    return;
  }
  assert(handle > 0, "input_open refused with " + handle.toString());

  // Kind 0: input's own surface. No token, no renderer, no other capability.
  const attached = input.attach(handle, input.Kind.OwnSurface, 0, 0);
  if (attached == ENODEV) {
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
  assert(state.padsPresent == 0, "a gamepad appeared out of nowhere");

  // Zero gamepads is normal: every slot answers -ENOENT, and that is not an
  // error (INPUT.md §3 Q2).
  const pad_buffer = heap.alloc(input.PAD_SIZE);
  for (let slot: i32 = 0; slot < <i32>input.PAD_SLOTS; slot++) {
    const rc = input.pad(handle, slot, pad_buffer);
    assert(rc == -2, "pad(" + slot.toString() + ") answered " + rc.toString() + ", not -ENOENT");
  }

  print("OK attached flags=0x" + hex(state.flags) + " pads=" + state.padsPresent.toString());

  assert(input.close(handle) == 0, "input_close");
  assert(RuntimeSession.close() == 0, "session_close");
}
