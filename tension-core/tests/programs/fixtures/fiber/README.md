# `fixtures/fiber` — the one guest the fiber executor's tests load

`i70-fiber.wasm` is the **fiber backend's** guest (DL36). It is committed, not
built on demand, for the reason `fixtures/thread` and `fixtures/debug` are: the
artifact *is* the compiler behaviour under test. A test that rebuilt it would be
testing whatever compiler happens to be installed, and a compiler that stopped
recording `tension.stackful-backend` would fail in the *load* rather than in the
assertion — a much less legible failure than a mismatched artifact.

## What it is

`tests/programs/fiber/i70-fiber.tension`, compiled with the thread flags plus
`--stackful-backend=fiber`:

```
node scripts/build-test-programs.mjs i70-fiber
cp build/i70-fiber.wasm{,.build.json} tests/programs/fixtures/fiber/
```

`i70-fiber.wasm.build.json` is written by the builder (DL36 Phase A) and records
the compiler's `dist/assemblyscript.js` sha256 and the exact flags, so the bytes
here can always be traced to the command that made them. Rebuilding with a
different compiler is a **deliberate** act: the record then differs, and
`rebuild.mjs --check`'s `guests: built by the installed compiler` link covers the
*built* set only — a committed fixture is pinned on purpose and is not asked to
follow the installed compiler.

## What it does

```ts
let warm_up = await leaf();      // the suspending shell needs a real `await`
line("before=1");
policy.await(job);               // parks on (class 4, key 7)
line("value=" + job.value);      // the value the host delivered
```

Under the fiber backend `policy.await` becomes `scheduler::park(0, 4, 7)`, the
host suspends the task on a fiber, and `scheduler::completion(0)` answers the
producer's value after the resume. The module imports exactly:

```
(import "scheduler" "park"       (func (param i64 i32 i32)))
(import "scheduler" "completion" (func (param i64) (result i32)))
```

and contains **no `suspend`**, which is what lets it run on a target where
wasmtime refuses continuations.
