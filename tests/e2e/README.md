# `tests/e2e` — the examples, executed

`tension-core/tests/example_adoption.rs` answers static questions: does every
example pin a DWARF-emitting compiler, does every committed artifact carry
`.debug_info`, is every `launch.json` well formed. Those checks read files.

This runner does the other half: it **spawns the engine**. A `launch.json` that
parses is not a `launch.json` whose flags the engine still accepts; an artifact
that carries `.debug_info` is not an artifact that starts; a guest that starts is
not a guest whose breakpoint binds. Each of those is a separate pass over the
examples, and each reports independently.

```sh
node tests/e2e/runner.js                  # all three modes (same as --check)
node tests/e2e/runner.js --only launch
node tests/e2e/runner.js --only smoke
node tests/e2e/runner.js --only debug
node tests/e2e/runner.js --example ogre/hello-triangle
```

Requires a built `tension-core` (`cargo build --manifest-path
tension-core/Cargo.toml --release`) and Node 20+. Set `TENSION_CORE` to point at
a binary built elsewhere.

Debug mode additionally needs a debugger. Install it once:

```sh
cd tests/e2e && npm install
```

That installs `@debugmcp/codelldb-*` — the same package family and version
TensionScript uses — as optional dependencies, so only this platform's package
lands. `node_modules/` and `package-lock.json` are gitignored: which package
installs is a per-host fact. Launch and smoke modes do not need it; the runner's
own code uses Node built-ins only.

The runner reports where its debugger came from on startup:

```
e2e: lldb = tests/e2e/node_modules/@debugmcp/codelldb-linux-x64/lldb/bin/lldb (source: npm)
e2e: lldb = absent (debug mode will skip)
```

Resolution order is `PATH` first, then the npm package: a developer who
installed lldb deliberately should get that one, and the npm package is the
fallback that makes debug mode runnable on a machine with no system lldb.

## Modes

- **launch** — for each `.vscode/launch.json` configuration, rebuild the command
  and run it with the guest path replaced by a path that cannot exist
  (`/tmp/e2e-missing-<pid>.wasm`). A configuration whose flags are accepted stops
  at "that file does not exist"; one that passes a removed flag stops earlier, at
  argument parsing, and the failure names the flag.
- **smoke** — run each `build/*.wasm` under `--debug` with a 2 s deadline. A
  crash is `SIGSEGV`/`SIGABRT` or a Rust panic. Exit 0 and "still running at the
  deadline" both count as no crash; any other exit is a failure, because "it
  stopped for a reason I did not anticipate" is what a regression looks like.
- **debug** — bind a source breakpoint from `config/breakpoints.json` under
  lldb and confirm it resolves. The breakpoint is the first **executable
  statement** inside `_start_game`, not the declaration line: a declaration
  with comments after it has no line-table entry, so a breakpoint set there
  never binds (measured — `log` failed on its declaration line, passes on the
  statement). Skips when neither a system lldb nor the npm package is available.

## Config

- `config/breakpoints.json` — one entry per example, pointing at the first line
  of its `_start_game`. Hand-curated: a breakpoint that never executes proves
  nothing, and generating these from the source would hide that.
- `config/known-skips.json` — examples that cannot participate and why. This
  file is the record; a skip that lives only in code drifts, one that lives in a
  reviewed data file has to be argued for.

## Skip discipline

Every skip prints one line:

```
skipped [<mode>] <example> — <reason>
```

A run that skips half its inputs says so in its own output. Pass/fail counts per
mode are printed at the end; the exit code is 1 if any case fails.

Skips are only for states the test does not own: an artifact that was never
built, a packed resource that was never packed, lldb not installed. A guest that
fails to start for any other reason is a failure.

## Why not Rust

These are process-level checks: spawn, capture, time out, kill. Node's
`child_process` and a temp directory express that directly, and the lldb driver
is the same shape as `TensionScript/tests/debug/lib/run-lldb.js`, so the two
harnesses stay readable side by side. The Rust suites keep the checks that need
in-process access to the engine (`e2e_debug.rs` uses a cfg-gated dump flag).
