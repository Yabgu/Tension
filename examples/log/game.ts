// The logging example: the guest half of Tension's logging subsystem.
//
// The host owns the level, the filter, the layout, and the sink. This guest
// only *names* records, so the same binary produces different output for
// different flags — which is the whole point:
//
//   npm start                        # package.json asks for --log-level=trace,
//                                    # so every record shows (text, on stderr)
//
// Any other host option: run the interpreter directly. (The runner sends extra
// `npm run run -- ...` arguments to the *guest*, not the host — put a host flag
// in the package.json `tension.hostArgs` array to make it part of `npm start`.)
//
//   ../../tension-core/target/debug/tension-core --log-format=json build/game.wasm 2>&1 >/dev/null | jq .
//   ../../tension-core/target/debug/tension-core --log-level=physics:warn build/game.wasm
//   ../../tension-core/target/debug/tension-core --log-file=run.log build/game.wasm
//
// Nothing in this file changes between those runs. That is the layering: the
// guest carries a level, a logger name, and a message; the host decides what
// reaches the terminal and in what shape.
//
// Verified by the host's own tests (tension-core/src/logging, and
// tension-core/tests/log_guest.rs) and the framework fixture
// (tension-framework/tests/guest-log.ts); this example is the readable version.

import { print } from "tension-framework";
import { Logger, LogLevel } from "tension-framework";

export function _start_game(): void {
  // One logger per subsystem, taken once. `Logger.get` is stable per name, so
  // this is the same object everywhere it is asked for.
  const game = Logger.get("game");
  const physics = Logger.get("physics:collision");

  game.info("the logging example starts");

  // One record per level. At the default `info` threshold the first two are
  // dropped; the package asks for `trace`, so all six appear.
  game.trace("trace — step-by-step diagnostics");
  game.debug("debug — developer detail");
  game.info("info — the default threshold");
  game.warn("warn — something looks off");
  game.error("error — an operation failed");
  game.fatal("fatal — the process cannot continue");

  // A second namespace. A name is a namespace, not a label: the host resolves
  // `physics:collision` by its ancestors, so `--log-level=physics:warn` quiets
  // the info line below without touching the `game` logger.
  physics.info("broad phase: 42 candidate pairs");
  physics.warn("narrow phase: a contact impulse was clamped");

  // A structured record: `data` in the JSON layout. The payload is spliced as
  // a JSON object, so `jq .data.entities` reads it.
  game.structured(LogLevel.Info, "{\"tick\":1,\"entities\":7,\"ready\":true}");

  // Non-ASCII: the ABI carries UTF-8 byte lengths (`String.UTF8.byteLength`,
  // never `msg.length`), so this line arrives whole whatever the host writes.
  game.info("unicode survives the boundary: héllo wörld ✓");

  print("done — the host wrote the records to its own stderr");
}
