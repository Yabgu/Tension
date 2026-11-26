# `fixtures/thread` — the release guests the thread guards run

Three release guests, all built from `../../thread/`, all committed as bytes:

- **`wake-on-worker.wasm`** — `wake-on-worker.ten`. `tests/threads.rs` runs it twice
  and asserts the pair at
  [`a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake`](../../../tests/threads.rs):
  with `--post-completion 4,7` a parked worker resumes and exits 0; without it the
  same guest exits non-zero with a strand refusal.
- **`spawn-entry-async.wasm`** — `spawn-entry-async.ten`. Run once by
  [`an_async_worker_entry_is_served_as_its_spawn_entry`](../../../tests/threads.rs):
  a worker spawned at `__spawnIndexOf(anAsyncFunction)`'s own answer must run its
  body, print both of its lines, and exit 0 with nothing stranded. The number
  under test is the answer itself — `3`, the `$spawnStart` entry — because `4`
  (the factory) is what the API answered before DL31, and a factory completes
  normally, so `__serveOne` queued nothing and the task it created was never
  driven, at exit 0 and with no sentence.
- **`two-waiters-late.wasm`** — `two-waiters-late.ten`. Run twice by
  [`a_second_waiter_is_refused_when_the_completion_arrives_after_both_parks`](../../../tests/threads.rs):
  with `--post-completion-after-parks 4,7,2` the completion lands after both parks
  and the run must exit 1 with a count of exactly 1; with `--post-completion 4,7`
  (the mirror) it must exit 1 with the other waiter resumed.

## Why it is committed

For the same reason [`../debug/README.md`](../debug/README.md) gives, and the same
one the committed example guests make: **the CI job has no compiler.** `.packs/`
holds the canonicalised compiler tarball, is gitignored, and is rebuilt per
machine, so a runner that has not built it cannot install it — the job's own
comment records the `ENOENT` it produced when an earlier version tried. Committing
the *artifact* instead of the *compiler* is the trade this repository already
makes; the recipe travels beside the bytes.

## How a test resolves it

`tension-core/tests/support/programs.rs` → `guest_thread_fixture`:

1. **a compiler is installed here** (`node_modules/@yabgu_gm/tensionscript`) →
   build from source, because the behavior under test is the program and the
   source is its truth;
2. otherwise **this fixture**.

Note the difference from `guest_debug`, which prefers its fixture unconditionally.
There the fixture *is* the artifact under test (a line table only one compiler
emits); here the artifact is a behavior, so a checkout that can build should
measure the source it has rather than a copy of it. **Consequence, stated:** a
fixture left stale relative to its `.ts` is not detected by the suite. The recipe
below is the remedy, and a run on a machine with a compiler is what proves the
source.

## The recipe

From the repository root, with the pinned compiler installed — `WAKE_FLAGS` in
`scripts/build-test-programs.mjs` is the flag list for the two wake guests, and
`--enable stack-switching` is deliberately **absent** from it (the Promise shell is
what resumes those guests). `spawn-entry-async` instead takes the `thread/`
folder's default, `THREAD_FLAGS`, which **includes** `--enable stack-switching`:
its body is served as a continuation, which is the whole point.

```sh
node scripts/build-test-programs.mjs --force          # → tests/programs/build/*.wasm
cp tension-core/tests/programs/build/wake-on-worker.wasm \
   tension-core/tests/programs/build/two-waiters-late.wasm \
   tension-core/tests/programs/fixtures/thread/
```

**Each artifact records the bundle that built it (I44), and the three do not
share one:**

```
wake-on-worker.wasm    29 315 bytes   sha256 23ed47bfe51733ac…   bundle aa74d6a1
two-waiters-late.wasm  29 286 bytes   sha256 973a9fb99be8a6be…   bundle aa74d6a1
spawn-entry-async.wasm 27 666 bytes   sha256 62e2460568f500a7…   bundle 3ef8a8f4
```

The two wake guests were **not** rebuilt by DL31: the change was in `__spawnIndexOf`
and neither of them calls it, so their bytes are the ones DL21 and DL22 committed
and re-measuring them under a new bundle would move the artifact without moving the
behaviour. `spawn-entry-async` had to be built at `3ef8a8f4` — it is the fix's own
proof, and it could not be built at `aa74d6a1` (the defect is the guard).

**Regenerate it after any edit to the guest, comments included.** Measured while
landing DL21: the source's header comment changed and **four bytes of the module
moved** (`i32.const` immediates, two pairs, each off by 8) with the code identical
— comment-free diff verified with `diff` on the stripped files. Same path, same
flags, same compiler bundle, deterministic across runs. Whatever the mechanism, the
practical rule is the one above, and it is why the recipe and the hash are written
down rather than trusted to memory.

Then prove it, both directions:

```sh
tension-core --executors 2 --post-completion 4,7 <artifact>   # exit 0
tension-core --executors 2 <artifact>                         # exit 1, refusal
```
