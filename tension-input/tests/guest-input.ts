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

import { print } from "../../tension-framework/assembly/io";
import {
  ConfigBuilder,
  RuntimeSession,
  makeCallbacks,
} from "../../tension-framework/assembly/runtime";
import * as input from "../../tension-framework/assembly/input";

/// -ENODEV: no display, no window, nothing attached yet (see the header).
const ENODEV: i32 = -19;

function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  return 0;
}

function onEvent(class_: u32, ptr: u32): i32 {
  return 0;
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

export function _start_game(): void {
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
