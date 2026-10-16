// The callback record, as the host boundary accepts it: a plain module that
// builds `Callbacks` records and checks what lands in them.
//
// This is the accepting half of the guard in `assembly/runtime/callbacks.ts`
// (its refusing half is `guest-callbacks-guard.ts`). What it pins is the
// precondition the guard rests on: a function value that does **not** capture
// `this` carries a zero environment word, so it is accepted, and the index the
// record stores is the one the host resolves at `session_open`.
//
// The environment word matters because the compiler can now hand a receiver to
// an arrow function through it (`~env`), and a host-side invocation has no call
// site to hand anything over. So the record a guest registers is only safe while
// every handler in it has a zero word — which is what an ordinary function has,
// and what this fixture asserts rather than assumes.
//
// A plain module: it imports nothing but the framework's own runtime code, so
// it compiles without the session's flags and runs with no capability. It
// prints `OK`.

import { print } from "../assembly/io";
import { makeCallbacks } from "../assembly/runtime/callbacks";
import { CALLBACK_SLOTS, CALLBACKS_SIZE } from "../assembly/runtime/wire";

/// A batch handler: a real function, so `makeCallbacks` has a table index to
/// resolve.
function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  return 0;
}

/// A per-event handler, likewise.
function onEvent(class_: u32, ptr: u32): i32 {
  return 0;
}

export function _start_game(): void {
  // The precondition the guard checks: a plain function value's environment
  // word is zero. The word follows the index, at the pointer size.
  assert(
    load<usize>(changetype<usize>(onBatch), sizeof<usize>()) == 0,
    "a plain handler carries an environment"
  );
  assert(
    load<usize>(changetype<usize>(onEvent), sizeof<usize>()) == 0,
    "a plain handler carries an environment"
  );

  // Both handlers accepted, into a record the session would take.
  const both = makeCallbacks(onBatch, onEvent);
  assert(both.abiVersion != 0, "abiVersion not filled in");
  assert(both.slotCount == CALLBACK_SLOTS, "slotCount not filled in");
  assert(both.onBatch != 0, "onBatch index not resolved");
  assert(both.onEvent != 0, "onEvent index not resolved");

  // A null handler leaves its slot zero, which the ABI defines as absent.
  const none = makeCallbacks(null, null);
  assert(none.onBatch == 0, "a null handler did not leave its slot absent");
  assert(none.onEvent == 0, "a null handler did not leave its slot absent");

  // One of each, so the slots are independent.
  const mixed = makeCallbacks(onBatch, null);
  assert(mixed.onBatch != 0, "onBatch index not resolved");
  assert(mixed.onEvent == 0, "a null handler did not leave its slot absent");

  // The record is the wire size, not whatever `sizeof` would report for the
  // managed class: `heap.alloc` got `CALLBACKS_SIZE` bytes and every field the
  // host reads is inside them.
  assert(CALLBACKS_SIZE >= 24, "the record no longer covers its fields");

  print("OK");
}
