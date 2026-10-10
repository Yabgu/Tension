// The logging fixture: a plain module (no session, no capability) that drives
// the guest `Logger` through every level and both layouts.
//
// What it proves is that the ABI is callable from a **compiled** guest, not
// just from a hand-written `.wat`: `tension::io::log` and `log_structured` are
// the imports the SDK binds, and a mismatch in arity, or a pointer/length pair
// that is not the UTF-8 byte count, would trap here. The lines themselves go to
// the host's stderr — this fixture cannot see them, and the runner shows them.
//
// It prints `OK`, so the runner's contract ("prints OK, exit 0") is met.
//
// Run against the interpreter directly to read the records, e.g.
//
//   tension-core --log-level=trace build/guest-log.wasm
//   tension-core --log-format=json build/guest-log.wasm 2>&1 | jq .

import { print } from "../assembly/io";
import { LogLevel, Logger } from "../assembly/log";

export function _start_game(): void {
  const game = Logger.get("game");

  // One record per level. At the default `info` threshold only the last four
  // reach stderr; `--log-level=trace` shows all six.
  game.trace("trace: filtered out at the default level");
  game.debug("debug: filtered out at the default level");
  game.info("info: the default threshold");
  game.warn("warn");
  game.error("error");
  game.fatal("fatal");

  // A structured record: `data` in the JSON layout.
  game.structured(LogLevel.Info, "{\"tick\":1,\"ready\":true}");

  // The ABI's length must be the UTF-8 byte count, not the UTF-16 code units
  // `str.length` reports: a non-ASCII message is where the two differ, and the
  // host reads exactly what it is told. `--log-level=trace` and read the line.
  game.info("unicode: héllo wörld ✓");

  // `Logger.get` is stable, so the same name is the same instance.
  assert(Logger.get("game") == game, "Logger.get is not stable per name");
  assert(game.getName() == "game", "getName lost the name");

  print("OK");
}
