# `fixtures/contract` — the continuation half of the I90 pair

`async-on-main.wasm` is `async/async-on-main.tension` compiled for the **continuation**
backend. Its fiber twin is `../fiber/async-on-main-fiber.wasm`, and the two are
asserted by one test each in `tests/async_on_main.rs` against **one** expected
transcript (`async-on-main.expected.txt`).

## Why it is committed

The pair is the gate (DL39, I93). `--test async_on_main` is the only suite that
runs a plain `await asyncFn()` and checks what came back, and it is what caught
I90 — the fiber backend losing every suspension while everything else stayed
green. It could not run in CI because both artifacts were built on demand and CI
installs no compiler; so both are here, and
`tests/support/programs.rs::guest_contract_fixture` loads them when there is no
compiler.

## Rebuilding

```
node scripts/build-test-programs.mjs --force async-on-main
cp build/async-on-main.wasm{,.build.json} tests/programs/fixtures/contract/
```

The `.build.json` sidecar records the compiler's sha256 and the exact flags, so
these bytes are always traceable to the command that made them.
