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
tension-core/Cargo.toml --release`). Node 20+, built-ins only — there is no
`package.json` here and nothing to `npm install`. Set `TENSION_CORE` to point at
a binary built elsewhere.

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
  lldb and confirm it resolves. Skips entirely when lldb is absent, saying so.

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
