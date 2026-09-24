// The smallest real session guest: build it, open a session, close it.
//
// It is the fixture where A3a's build pipeline meets the host work of A1 and
// A2 — a guest compiled by `asc` with the generated flags, importing the arena
// the session owns, registering its callbacks, and driving the verbs through
// the runtime layer.
//
// What it proves, in order:
//
//   1. the wire offsets this build compiled against are the arena's
//      (`assertWireOffsets`, which uses `offsetof`);
//   2. `session_open` accepts a config built by the runtime, which means the
//      TLV encodes what `config.rs` decodes, the layout hash matches the Rust
//      side's, and the memory this guest imported is the arena the session
//      prepared;
//   3. the callbacks record resolved — a function-table index that names a
//      function of the declared signature;
//   4. `session_close` succeeds.
//
// It prints `OK` on success and traps on any failure, so the runner sees a
// distinct failure mode rather than a quiet wrong answer.
//
// It does not wait, drain, or subscribe: A3a is the pipeline and the runtime,
// and a fixture that needs events would be A3b's.

import { print } from "../assembly/io";
import { assertWireOffsets, ConfigBuilder, makeCallbacks, RuntimeSession } from "../assembly/runtime";

/// The batch callback: a real function, so `makeCallbacks` has a table index to
/// resolve. This fixture never receives an event — nothing is delivered — but
/// the session pins the signature at open, which is the point.
function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  return 0;
}

/// The per-event callback, likewise registered and likewise never called.
function onEvent(class_: u32, ptr: u32): i32 {
  return 0;
}

export function _start_game(): void {
  assertWireOffsets();

  const callbacks = makeCallbacks(onBatch, onEvent);
  const cfg = ConfigBuilder.forThisBuild(callbacks);

  const opened = RuntimeSession.open(cfg, callbacks);
  assert(opened == 0, "session_open refused the runtime's config");

  const closed = RuntimeSession.close();
  assert(closed == 0, "session_close refused");

  print("OK");
}
