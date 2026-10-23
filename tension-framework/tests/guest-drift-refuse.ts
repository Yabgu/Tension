// The drift check's **refuse** cell: the pre-check world, reproduced.
//
// A guest that opens a session without ever comparing the host's manifest to its
// own declarations sees nothing wrong. This fixture writes the drift the
// `SessionInfo` case actually had — host says 144 bytes, guest declared 128 —
// into the arena *before* opening, then opens through the raw verb (`verbs.open`),
// which is the path that does not run the check. The open succeeds, the guest
// proceeds, and nothing anywhere notices.
//
// Its job in the three-way fixture is to hold the "before" still: the same
// corruption the other two cells act on, with the check absent. If this ever
// stops printing `OK`, the corruption stopped landing and the other two cells
// prove nothing.
//
// `verbs` is exported from the runtime barrel precisely so a caller can drive the
// ABI layer without the ergonomic one; `RuntimeSession.open` wraps `open` with
// the manifest check.

import { print } from "../assembly/io";
import {
  CALLBACKS_SIZE,
  Callbacks,
  ConfigBuilder,
  ManifestEntry,
  RuntimeSession,
  ctrl,
  isReady,
  makeCallbacks,
  verbs,
} from "../assembly/runtime";

/** Write the stale `SessionInfo` size the host has not believed since 0.6.0a. */
function corruptSessionInfoSize(): void {
  const block = ctrl();
  // The manifest is id-ordered and dense, so id 2 is entry index 1.
  const entry = changetype<ManifestEntry>(block.manifestOff + 1 * 8);
  entry.size = 128;
  print("corrupted: manifest id " + entry.typeId.toString() + " size -> " + entry.size.toString());
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

  // The raw verb: no manifest check on this path. Any caller that drives the
  // ABI layer directly — or any build from before the check existed — behaves
  // exactly like this.
  const bytes = cfg.toBytes();
  const opened = verbs.open(changetype<usize>(bytes), <u32>bytes.byteLength);
  assert(opened == 0, "verbs.open refused the runtime's config: " + opened.toString());

  // The region table and the control block still read correctly; the drift is a
  // number this guest never looks at. That is what "silent" means here.
  assert(isReady(), "the session is not READY after open");
  const closed = RuntimeSession.close();
  assert(closed == 0, "session_close refused");

  print("OK");
}
