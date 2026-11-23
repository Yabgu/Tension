# `fixtures/thread` — the release guest the wake guard runs

Two release guests, both built from `../../thread/`, both committed as bytes:

- **`wake-on-worker.wasm`** — `wake-on-worker.ts`. `tests/threads.rs` runs it twice
  and asserts the pair at
  [`a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake`](../../../tests/threads.rs):
  with `--post-completion 4,7` a parked worker resumes and exits 0; without it the
  same guest exits non-zero with a strand refusal.
- **`two-waiters-late.wasm`** — `two-waiters-late.ts`. Run twice by
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

From the repository root, with the pinned compiler installed (bundle `aa74d6a1`,
I44) — `WAKE_FLAGS` in `scripts/build-test-programs.mjs` is the flag list, and
`--enable stack-switching` is deliberately **absent** (the Promise shell is what
resumes this guest):

```sh
node scripts/build-test-programs.mjs --force          # → tests/programs/build/*.wasm
cp tension-core/tests/programs/build/wake-on-worker.wasm \
   tension-core/tests/programs/build/two-waiters-late.wasm \
   tension-core/tests/programs/fixtures/thread/
```

The artifacts that were committed at bundle `aa74d6a1`:

```
wake-on-worker.wasm    29 315 bytes   sha256 23ed47bfe51733ac…
two-waiters-late.wasm  29 286 bytes   sha256 973a9fb99be8a6be…
```

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
