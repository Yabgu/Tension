// The drift check's **partial** cell: log-and-continue, which is the half-fix.
//
// The check exists and it finds the drift — `manifestProblem()` returns the
// diagnostic — but the caller prints it and goes on. This is what a
// "warn and keep running" implementation would ship, and it is worse than no
// check at all: the guest now has positive evidence that its offsets are wrong
// and uses them anyway, so a wrong answer arrives with a note attached instead
// of a crash.
//
// The cell exists so the record says which failure mode was chosen and why. The
// fixed cell next door aborts on the same corruption; the difference between
// them is one `assert`.

import { print } from "../assembly/io";
import {
  ConfigBuilder,
  ManifestEntry,
  RuntimeSession,
  SessionInfo,
  ctrl,
  makeCallbacks,
  manifestProblem,
  verbs,
} from "../assembly/runtime";

/** Write the stale `SessionInfo` size the host has not believed since 0.6.0a. */
function corruptSessionInfoSize(): void {
  const block = ctrl();
  const entry = changetype<ManifestEntry>(block.manifestOff + 1 * 8);
  entry.size = 128;
}

function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  return 0;
}

function onEvent(class_: u32, ptr: u32): i32 {
  return 0;
}

export function _start_game(): void {
  const callbacks = makeCallbacks(onBatch, onEvent);
  const cfg = ConfigBuilder.forThisBuild(callbacks);
  corruptSessionInfoSize();

  // What the guest built against, from the arena the host wrote.
  const block = ctrl();
  const entry = changetype<ManifestEntry>(block.manifestOff + 1 * 8);
  const guestSize = sizeof<SessionInfo>();
  print("declaration: SessionInfo guest " + guestSize.toString() +
    ", host " + (<u32>entry.size).toString());

  const drift = manifestProblem();
  assert(drift != null, "manifestProblem() did not notice the corrupted size");
  print("drift: " + <string>drift);

  // ... and then the half-fix's decision: proceed anyway. Every offset in the
  // guest's SessionInfo view is now computed against a record the host did not
  // write, so anything reading past `classCount` reads another field's bytes.
  const bytes = cfg.toBytes();
  const opened = verbs.open(changetype<usize>(bytes), <u32>bytes.byteLength);
  assert(opened == 0, "verbs.open refused the runtime's config: " + opened.toString());
  const closed = RuntimeSession.close();
  assert(closed == 0, "session_close refused");

  print("OK");
}
