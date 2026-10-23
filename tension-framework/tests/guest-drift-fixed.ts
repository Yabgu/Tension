// The drift check's **fixed** cell: the same corruption, through the checked
// path, so the guest stops at open instead of at the first wrong read.
//
// `RuntimeSession.open` compares the host's nine manifest entries against this
// guest's declarations once the session is READY and before any user code runs.
// This fixture corrupts id 2's size to the value the guest itself declared
// before 0.6.0a (128, where the host writes 144) and opens through the checked
// wrapper, so the abort's text is the evidence: it names the type, the guest's
// size and the host's.
//
// The runner asserts the exact message, a non-zero exit, and the absence of
// `OK` — the same contract as the callback guard fixture (`run.sh`), for the
// same reason: "the guest aborted" is only evidence when it aborted for the
// right reason.

import { print } from "../assembly/io";
import {
  ConfigBuilder,
  ManifestEntry,
  RuntimeSession,
  ctrl,
  makeCallbacks,
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

  // The checked path. This must trap here; reaching the next line is the
  // failure the runner reports.
  RuntimeSession.open(cfg, callbacks);

  print("OK");
}
