// The guest's logging: a thin `Logger` over `tension::io::log`.
//
// The host owns everything that makes a log line — the level, the filter, the
// layout, and the sink. This class carries only what the guest knows, a logger
// name and a message, so the bytes that reach stderr are the host's: a guest
// line is byte-identical to the same record from a C++ adapter or from Rust.
//
//   const log = Logger.get("physics:collision");
//   log.info("settled");
//   log.warn("clamped the impulse");
//   log.structured(LogLevel.Debug, "{\"bodies\":42}");
//
// A name is a **namespace**, not a label. The host resolves a name by its
// ancestors, so `--log-level=physics:warn` quiets `physics:collision` too, and
// `--log-level=physics:collision:trace` reopens just that channel.
//
// **The enum is `LogLevel`, not `Level`.** `assembly/index.ts` re-exports every
// module with `export *`, and TypeScript drops *both* sides of a duplicate name
// silently (the reason `runtime/index.ts` calls its session `RuntimeSession`).
// A bare `Level` is the most collision-prone name a game engine can export —
// render levels, mip levels — so the logger does not claim it.

import { log as hostLog, logStructured as hostLogStructured } from "./io";

/** The six levels. The discriminants are the ABI's (`tension_log_level_t`). */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Fatal = 5,
}

/**
 * One named logger over the host's logging ABI.
 *
 * Cheap to hold: `Logger.get` returns the same instance for the same name, so a
 * module can keep one at file scope rather than thread a logger through every
 * call.
 */
export class Logger {
  /** The one logger per name, so `get` is stable and allocation is one-time. */
  private static registry: Map<string, Logger> = new Map<string, Logger>();

  private name: string;

  private constructor(name: string) {
    this.name = name;
  }

  /** The logger for `name`. Names are namespaces (`a:b` inherits from `a`). */
  static get(name: string): Logger {
    // `Map#get` aborts on an absent key in AssemblyScript, so the guard is
    // `has` rather than a null check on the result.
    const registry = Logger.registry;
    if (registry.has(name)) return registry.get(name);
    const logger = new Logger(name);
    registry.set(name, logger);
    return logger;
  }

  /** The name the host filters on. */
  getName(): string {
    return this.name;
  }

  /** Emit at an explicit level. */
  log(level: LogLevel, message: string): void {
    hostLog(level, this.name, message);
  }

  trace(message: string): void {
    this.log(LogLevel.Trace, message);
  }

  debug(message: string): void {
    this.log(LogLevel.Debug, message);
  }

  info(message: string): void {
    this.log(LogLevel.Info, message);
  }

  warn(message: string): void {
    this.log(LogLevel.Warn, message);
  }

  error(message: string): void {
    this.log(LogLevel.Error, message);
  }

  fatal(message: string): void {
    this.log(LogLevel.Fatal, message);
  }

  /**
   * Emit a structured record. `json` is expected to be a JSON object; the JSON
   * layout splices it as the `data` field, and the text layout appends it after
   * the record (the payload takes the message slot when there is no message).
   */
  structured(level: LogLevel, json: string): void {
    hostLogStructured(level, this.name, json);
  }
}
