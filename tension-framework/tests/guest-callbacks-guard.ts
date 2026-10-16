// The callback guard, refusing half: a plain module that registers a handler
// **that captures `this`** and must be stopped by `makeCallbacks` with a named
// abort.
//
// The guard exists because the compiler delivers a captured `this` to an arrow
// function through its environment word (`~env`), and it can only do that at an
// indirect call site *inside the guest*. The host has no such site: at
// `session_open` it resolves the record's table index and calls the entry
// itself, so a handler that expected a receiver would read whatever environment
// global last held — someone else's receiver rather than none at all. Refusing
// at registration is the safe answer, and this fixture is what makes the
// refusal observed rather than assumed.
//
// The handler is a **real** capturing arrow, compiled by the fork: an arrow in
// a class field initializer that reads `this.x`. That is the shape a guest
// would actually write, so the guard is exercised against the compiler's own
// output rather than against a value built by hand. (An earlier revision of
// this fixture hand-built the environment word, because a capturing arrow was a
// compile error in the published AssemblyScript the engine used to build with.
// The `this` fix landed, so the real shape is testable — and is what is tested.)
//
// The fixture calls the arrow itself first, which is deliberate twice over: a
// guest *can* call a capturing arrow (the mechanism delivers the receiver at the
// guest's own indirect call site), and the call is what makes resolution reach
// the arrow's body, so the arrow is genuinely marked as capturing rather than
// being dead code the compiler drops.
//
// This fixture **aborts**, by design: its contract is a non-zero exit and the
// guard's message on stderr, which is what `tests/run.sh` checks. It never
// prints `OK`.

import { makeCallbacks, OnBatch } from "../assembly/runtime/callbacks";

/// A handler that captures `this`: reading `x` is what makes it capture, and the
/// field makes the value per-instance rather than static.
class Holder {
  x: i32 = 7;
  handler: OnBatch = (class_: u32, ptr: u32, count: u32): i32 => this.x;
}

export function _start_game(): void {
  const holder = new Holder();

  // The guest can call it: `this.x` arrives through the environment at the
  // guest's own indirect call site. This must work, or the fixture would be
  // testing the wrong thing.
  const value = holder.handler(0, 0, 0);
  assert(value == 7, "the capturing handler did not read this.x");

  // Must abort with the guard's message: the host has no call site at which to
  // deliver the environment this handler carries. Nothing after this line runs.
  makeCallbacks(holder.handler, null);

  // If this is reached, the guard let an environment-carrying handler through.
  assert(false, "the guard accepted a handler that captures `this`");
}
