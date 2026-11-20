# Test programs

These are the TensionScript programs the Rust test suite runs. A test's subject
is a program; this directory is where you read the language instead of the
harness that spawns it.

Each `.ts` is built by `scripts/build-test-programs.mjs` (one recipe, the same
one a developer runs by hand), and each line below names the Rust file that
asserts it.

- **`count.ts`** — the thread ABI's executor count and the boot order: a
  non-zero carved control block proves `__threadInit` ran before `__start`.
  Asserted by `tension-core/tests/threads.rs` (`one_executor_count_plus_the_pool`,
  `a_shared_memory_guest_can_print`).
- **`spawn-join.ts`** — a worker runs on its own store and joins: the reply
  `242` packs the worker's id into the answer, and `__threadJoin` sees the exit.
  Asserted by `threads.rs` (`a_worker_runs_on_its_own_store_and_joins`).
- **`two-workers.ts`** — twelve tasks over two workers: every value observed
  exactly once, none lost or doubled. Asserted by `threads.rs`
  (`two_workers_observe_every_value_exactly_once`).
- **`spawn-refusals.ts`** — the contract's refusals as values: main cannot be
  spawned, an id past the end is `-1`, a live id is `-2`. Asserted by
  `threads.rs` (`the_contracts_refusals_are_values`).
- **`async-on-main.ts`** — the shared `async-main` ABI contract, copied
  verbatim from TensionScript's `examples/async-main/main.ts` with a header
  naming its origin. It proves a stackful continuation chain on one store: six
  suspensions, locals that survive them, and a final value that needs all of
  them. Asserted by `tension-core/tests/async_on_main.rs` against
  `async-on-main.expected.txt`.

  > **TensionScript's `tests/rt/examples.js` asserts the same file on a stub
  > host.** A change to this program must be made in both repos in the same
  > breath, and the expected transcript must match. The next round can replace
  > the two copies with a real shared-file mechanism; until then the written
  > rule is the mechanism.

- **`rt-guards.ts`** — the framework's no-session guards: `rt.start`, `rt.job`,
  the no-table park, `rt.onEvent`, and the region-table refusal all return
  quietly instead of trapping. Asserted by
  `tension-core/tests/framework_guards.rs`.

`build/` is generated and gitignored. A program whose flags are missing from the
table in `scripts/build-test-programs.mjs` is a build error naming the file, not
a silent default.
