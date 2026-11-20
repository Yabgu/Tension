# Test programs

Every `.ts` file here is a **TensionScript program**, compiled by the repo's vendored
compiler and run on `tension-core`. Open one to read the feature; open the Rust test beside it
to read what is asserted. Nothing here is JavaScript, and nothing is assembled at runtime.

```
node scripts/build-test-programs.mjs        # build every program
node scripts/build-test-programs.mjs --force # rebuild unconditionally
```

A built artifact lands in `build/<name>.wasm`, named by the program's **basename**. Names are
unique across folders — that is what lets a test ask for `guest("main-policy")` without caring
which folder the source lives in.

| folder | what lives there |
|---|---|
| `async/` | the Task path on one store: suspensions, locals, main's step, the fallback loop |
| `policy/` | `TaskPolicy` implementations — default, eager, counting, custom, remote |
| `thread/` | the thread ABI — identity, rings, spawn, pool, join |
| `mask/` | placement control — widths, admission, violations, program-written masks |
| `atomic/` | the primitives underneath — RMW, `@atomic` fields |

| program | run by | proves |
|---|---|---|
| `async/main-policy.ts` | `gallery_async.rs` | a program's own `mainStep` replaces main's default step |
| `async/fallback-loop.ts` | `gallery_async.rs` | a suspension yields into the executor loop, which keeps turning |
| `async/async-on-main.ts` | `async_on_main.rs` | the shared ABI contract: six suspensions, a local carried across all of them |
| `async/rt-guards.ts` | `framework_guards.rs` | the framework's behaviour with no session open |
| `thread/count.ts` | `threads.rs` | `__executorCount` and the carved control block |
| `thread/spawn-join.ts` | `threads.rs` | spawn a worker, serve a request, reply, join |
| `thread/two-workers.ts` | `threads.rs` | two workers, twelve tasks, every value exactly once |
| `thread/spawn-refusals.ts` | `threads.rs` | the contract's refusals are values, not traps |
