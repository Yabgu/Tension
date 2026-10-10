# Logging

Tension has one logger, and the host owns it. The Rust side (`tension-core`)
decides the level, the filter, the layout, and the sink; every other language
hands it a *record* — a level, a logger name, and a message — through a thin
adapter. The layout is applied **once**, in the host, so the same record
produces the same bytes whether it came from an AssemblyScript guest, a C++
adapter, or Rust.

```
  guest (AssemblyScript)      tension::io::log       ─┐
  native adapters (C/C++)     tension_core_api        ─┼─▶  Record ─▶ Layout ─▶ Sink
  the host (Rust)             logging::log            ─┘                (text|json)  (stderr|file)
```

The implementation is `tension-core/src/logging/`. Logging is a *verb*: it does
not touch the arena, the adapter wire format, or `layout_hash`.

## Command line

Options precede `<game.wasm>`; everything after it is the guest's.

```
--log-level <SPEC>     LEVEL, or NAME:LEVEL[,NAME:LEVEL...]   (repeatable)
--log-format <FORMAT>  text (default) | json
--log-file <PATH>      append to PATH instead of stderr
```

```sh
tension-core game.wasm
tension-core --log-level=debug game.wasm
tension-core --log-level=ai:debug,ogre:warn game.wasm
tension-core --log-level=audio:warn,audio:real:debug game.wasm
tension-core --log-level=off game.wasm
tension-core --log-format=json game.wasm 2>&1 | jq .
tension-core --log-file=run.log game.wasm
```

`LEVEL` is one of `trace debug info warn error fatal off` (case-insensitive;
`warning` is accepted for `warn`).

**Precedence: CLI beats the environment beats the defaults** (`info`, `text`,
stderr). The environment fallback is `TENSION_LOG_LEVEL`, `TENSION_LOG_FORMAT`,
`TENSION_LOG_FILE`. Flags *merge*: a `--log-level=ogre:debug` does not discard a
`TENSION_LOG_LEVEL`, and a later flag for the same name wins.

## Levels and filtering

Levels, least severe first. The numbers are the ABI's and are frozen:

```
TRACE 0   DEBUG 1   INFO 2   WARN 3   ERROR 4   FATAL 5
```

A record is emitted when its level is at least the threshold in force for its
logger **name**. A name is a *namespace*: the host tries the exact name, then
each of its ancestors (split on `:` or `.`), then the global threshold. So

```
--log-level=physics:warn              # quiets physics, physics:collision, ...
--log-level=physics:collision:trace   # ... and reopens just that one channel
```

Unknown names fall back to the global level. `--log-level=off` silences
everything.

## Layouts

Text (the default) — one line per record, level padded to five columns:

```
2026-10-10T19:46:12.345Z INFO  ogre: renderer = null (source: guest config)
2026-10-10T19:46:12.346Z WARN  physics:collision: a contact impulse was clamped
2026-10-10T19:46:12.346Z INFO  game: {"tick":1,"entities":7,"ready":true}
```

The timestamp is RFC-3339 UTC with milliseconds. The level tag is uppercase.

JSON — one flat object per line, `jq`-parsable:

```json
{"ts":"2026-10-10T19:46:12.345Z","level":"INFO","logger":"ogre","msg":"renderer = null"}
{"ts":"2026-10-10T19:46:12.346Z","level":"INFO","logger":"game","msg":"","data":{"tick":1,"entities":7}}
```

A structured payload that **begins** with `{` or `[` (after leading whitespace)
is spliced as `data` verbatim — the caller is trusted to have sent valid JSON,
which is the contract. Anything else is quoted as a string. In the text layout a
payload-only record puts the payload in the message slot; when a record has both
a message and a payload, the payload follows ` | `.

## Emitting from C++ (adapters and native callers)

Two routes, both landing in the same logger.

**Capability adapters** reach it through `tension_core_api`, the table they
already hold (`tension-core/include/tension_adapter.h`). The slots
`log_named` / `log_structured` were *appended* under rule 11 (append-only within
ABI version 1); the legacy `log` slot stays populated for adapters built before
the append.

```c
/* time: a renderer log line on the "ogre" logger */
static void log_line(int32_t level, const std::string &message) {
    AdapterState &s = adapter_state();
    if (s.api->log_named != nullptr) {
        s.api->log_named(s.api->user, level, "ogre",
                         message.data(), (uint32_t)message.size());
        return;
    }
    if (s.api->log != nullptr)  /* a host that left the named slot NULL */
        s.api->log(s.api->user, level, message.data(), (uint32_t)message.size());
}
```

`log_named` takes a `tension_log_level_t` (0..5). The **legacy `log` slot takes
0 debug, 1 info, 2 warning, 3 error** — a different vocabulary; it is kept only
for compatibility.

**Anything else that links the host directly** (a tool, and the statically
linked Zig resource core) uses the free symbols in
`tension-core/include/tension_logger.h`:

```c
#include "tension_logger.h"

void on_start(void) {
    tension_log(TENSION_LOG_INFO, "my-tool", "starting", strlen("starting"));
    tension_log_structured(TENSION_LOG_WARN, "my-tool",
                           "{\"retries\":3}", strlen("{\"retries\":3}"));
}
```

```zig
// Zig, linking libtension_core. The message is a byte slice; `logger_name` is
// NUL-terminated and has no length of its own.
extern fn tension_log(
    level: c_int,
    logger_name: [*:0]const u8,
    message: [*]const u8,
    message_len: usize,
) void;

fn warn(msg: []const u8) void {
    tension_log(3, "res", msg.ptr, msg.len); // 3 = TENSION_LOG_WARN
}
```

Both are panic-free, never block, and may be called from any thread; the host
serialises the write.

## Emitting from Rust

```rust
use tension_core::logging::{self, Config, Level};

fn main() -> anyhow::Result<()> {
    let mut config = Config::default();
    config.set_level_spec("ogre:debug,core:info")?;
    config.set_format("json")?;
    logging::init(config)?;

    logging::log(Level::Info, "core", "ready");
    logging::emit(Level::Warn, "ai", "", Some("{\"ctx\":4096}"));
    Ok(())
}
```

`logging::log(level, logger, message)` is the common case;
`logging::emit(level, logger, message, Some(payload))` carries a structured
payload. Before `init`, or if a process never calls it, a record at `info` or
above still reaches stderr through a text-layout fallback.

## Emitting from AssemblyScript (the guest)

The guest imports `tension::io::log(level, name_ptr, name_len, msg_ptr,
msg_len)` and `tension::io::log_structured(...)`; `tension-framework` binds them
and exposes a `Logger`:

```ts
import { Logger, LogLevel } from "tension-framework";

export function _start_game(): void {
  const game = Logger.get("game");              // a name, a namespace
  game.info("ready");
  game.warn("low on memory");
  game.error("the load failed");
  game.structured(LogLevel.Info, "{\"tick\":1,\"entities\":7}");

  Logger.get("physics:collision").debug("42 pairs");   // --log-level=physics:debug
}
```

Strings cross as **UTF-8 byte lengths** (`String.UTF8.byteLength` /
`String.UTF8.encode`), never `message.length` — the host reads exactly the byte
count it is given, and the UTF-16 length would truncate any non-ASCII message.

### Why `LogLevel` and not `Level`

The enum is `LogLevel` on purpose, and it has no `Level` alias. `assembly/index.ts`
re-exports every module with `export *`, and TypeScript drops **both** sides of a
duplicated name silently — the hazard `runtime/index.ts` already avoids by
naming its session `RuntimeSession`. A bare `Level` is the most collision-prone
export a game engine can offer (render levels, mip levels, tile levels), so the
logger does not claim it. A game that wants the shorter spelling can alias it at
its own call site: `import { LogLevel as Level } from "tension-framework"`.
Do not "fix" this by adding a `Level` alias.

Try it: `examples/log` logs at every level and both layouts. Its `package.json`
requests `--log-level=trace` through the runner's `hostArgs`, so `npm start`
shows every record:

```sh
cd examples/log && npm install
npm start
```

The runner passes extra `npm run run -- ...` arguments to the **guest**, not the
host, so other host options are shown by running the interpreter directly (from
`examples/log`, after `npm start` has built the guest):

```sh
# The records are on stderr; the guest's own stdout is separate, so take stderr
# only (2>&1 >/dev/null), or jq sees the game's output too.
../../tension-core/target/debug/tension-core --log-format=json build/game.wasm \
  2>&1 >/dev/null | jq -c 'select(.level=="WARN")'

../../tension-core/target/debug/tension-core --log-level=physics:warn build/game.wasm
```

## Thread safety and failures

One `OnceLock<Mutex<LoggerCore>>` holds the logger. The mutex makes it safe to
call from any thread — native adapters log from render threads — and it
serialises the sink, so two threads' lines never interleave mid-write. A
poisoned lock is recovered rather than propagated.

Every `extern "C"` entry point runs under `catch_unwind`: a panic is swallowed
and reported as a one-line fallback on stderr, so nothing unwinds across the
FFI boundary. A log call never traps and never fails. The guest import
bounds-checks the spans it reads, so an out-of-range range drops the record; the
C ABI trusts its caller's pointer and length, as a C function does, and a null
message with a non-zero length drops the record rather than reading anything.

## Extension

`Sink` is a one-method trait (`write_line(&mut self, line)`), so a second sink
is small: an in-game debug overlay's ring buffer is a `Vec` behind a lock, and
nothing else changes. `SinkKind` is the CLI-visible selector (`stderr`, `file`,
`null`).

## Host diagnostics

The host's own diagnostics — startup, capability loading, the session, and the
in-process `ai` / `audio` / `solver` modules — go through the same logger as
everything else, under the names `core`, `session`, `ai`, `audio` (`audio:real`,
`audio:headless`), and `solver`. The capability adapters name themselves too:
`ogre` and `input` (via the appended `log_named` slot). So a fully JSON run stays
JSON: with `--log-format=json`, **every** line on stderr is one object, from the
host, an adapter, or the guest alike.

The acceptance check:

```sh
# a capability run with no game output: every stderr line must parse
LD_LIBRARY_PATH=third_party/ogre-next-install/lib \
  tension-core --log-format=json --capability libtension_ogre.so game.wasm \
      --renderer=null --tns=fixtures.tns 2>err.log >/dev/null
jq -c . err.log          # exit 0, no error output
```

Left on plain `eprintln!` deliberately: game output on **stdout** (`println!`);
the `pack` / `layout-hash` subcommands and the `tension-core:` usage/refusal
family (they run before `logging::init`, or exit 2 with `USAGE`); the `--debug`
report (a formatted human block, not records); and one failure path, the pak-load
warning in `res/mod.rs`. A *successful* run at `--log-format=json` is therefore
all JSON; the pak warning and the `--debug` report are the two places a plain
line can still appear, both on error/opt-in paths.

The native `tension-input` / `tension-solver` C sources log through the C ABI like
any other native code.

## Running the tests

```sh
cargo test --manifest-path tension-core/Cargo.toml --no-default-features --features audio
bash tension-framework/tests/run.sh
```

The `ogre_*` integration tests load the capability adapter, which links OGRE-Next
from `third_party/ogre-next-install/lib`. Cargo does not put that directory on
the loader path, so run them with an **absolute** `LD_LIBRARY_PATH` (a relative
one resolves against `tension-core/`, not the repo root) and, where a display is
absent, headless:

```sh
LD_LIBRARY_PATH="$PWD/third_party/ogre-next-install/lib" TENSION_OGRE_HEADLESS=1 \
  cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
      --features audio --test ogre_jobs
```

Without it they fail with `libOgreNextMain.so.4.0: cannot open shared object
file` from the child `tension-core`, not from a test assertion. One OGRE test,
`test_ogre_vulkan_refused`, also fails in a tree whose OGRE-Next was built
without the Vulkan RenderSystem plugin — the adapter then returns `-EIO` at the
plugin stage where the test expects `-ENOSYS`; it fails identically on a
pristine adapter and is environment, not code.
