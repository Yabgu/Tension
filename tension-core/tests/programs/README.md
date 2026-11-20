# Test programs

Every `.ts` file here is a **TensionScript program**, compiled by the repo's vendored
compiler and run on `tension-core`. Open one to read the feature; open the Rust test beside it
to read what is asserted. Nothing here is JavaScript, and nothing is assembled at runtime.

```
node scripts/build-test-programs.mjs        # build every program
node scripts/build-test-programs.mjs --force # rebuild unconditionally
node scripts/build-test-programs.mjs --debug # the same programs with DWARF, in build/debug/
```

A built artifact lands in `build/<name>.wasm`, named by the program's **basename**. Names are
unique across folders — that is what lets a test ask for `guest("main-policy")` without caring
which folder the source lives in.

`--debug` adds `--debug --sourceMap` to each program's own flag list and writes to
`build/debug/<name>.wasm` (plus `<name>.wasm.map`). It exists for one caller,
`tension-core/tests/debugger.rs`, which sets a source breakpoint in a debug artifact under
lldb; release artifacts stay what every other test runs. Which programs actually carry
`.debug_info` today, and why the stack-switching ones do not yet, is
[`docs/debugging.md`](../../../docs/debugging.md) §3.

One debug artifact is **committed**: `fixtures/debug/rt-guards.wasm` with its map, so the
breakpoint assertions run on a machine with no compiler (CI installs none). A test asking for
a debug guest resolves it there first, then through `--debug` when
`node_modules/@yabgu_gm/tensionscript` exists, then gives up with one line naming what is
missing and what to run. The README beside the fixture carries the command that built it.

| folder | what lives there |
|---|---|
| `async/` | the Task path on one store: suspensions, locals, main's step, the fallback loop |
| `policy/` | `TaskPolicy` implementations — default, eager, counting, custom, remote |
| `thread/` | the thread ABI — identity, rings, spawn, pool, join |
| `mask/` | placement control — widths, admission, violations, program-written masks |
| `atomic/` | the primitives underneath — RMW, `@atomic` fields |

| program | run by | proves |
|---|---|---|
| `async/main-policy.ts` | `gallery_async.rs`, `debugger.rs` | a program's own `mainStep` replaces main's default step; the breakpoint guard reads it as a stack-switching guest |
| `async/fallback-loop.ts` | `gallery_async.rs` | a suspension yields into the executor loop, which keeps turning |
| `async/main-step-replaced.ts` | `gallery_async.rs` | a program **owns** main's scheduling — two slots, then one drain |
| `async/async-on-main.ts` | `async_on_main.rs` | the shared ABI contract: six suspensions, a local carried across all of them |
| `async/rt-guards.ts` | `framework_guards.rs`, `debugger.rs` | the framework's behaviour with no session open; and, in a debug build, a source breakpoint that binds |
| `thread/count.ts` | `threads.rs` | `__executorCount` and the carved control block |
| `thread/spawn-join.ts` | `threads.rs` | spawn a worker, serve a request, reply, join |
| `thread/two-workers.ts` | `threads.rs` | two workers, twelve tasks, every value exactly once |
| `thread/spawn-refusals.ts` | `threads.rs` | the contract's refusals are values, not traps |

## Running one by hand

`tension-core` runs these on **Linux and macOS**. On Windows the engine refuses stack
switching — wasmtime does not implement it there (`wasmtime-50/src/config.rs:2486`), and
`Engine::new` refuses the feature at construction. For Windows, use the Node runner in this
folder: it serves the same imports and prints the same transcript.

```sh
node --experimental-wasm-wasmfx runner.mjs main-policy
node --experimental-wasm-wasmfx runner.mjs async-on-main --trace
```

Thread programs (`thread/*`) need a real thread host. Run them under `tension-core` on
Linux/macOS, or through the Rust tests, which provide one.

`.vscode/` in this folder has launch configurations for both paths. Open this folder as the
workspace root to use them; the file's header records what can and cannot be breakpointed, and
why.

