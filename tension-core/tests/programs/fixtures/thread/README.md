# `fixtures/thread` — the release guest the wake guard runs

`wake-on-worker.wasm` is a **release build of `../../thread/wake-on-worker.ts`**,
committed as bytes. `tension-core/tests/threads.rs` runs it twice and asserts the
pair described at
[`a_task_parked_on_a_worker_is_resumed_by_a_sticky_wake`](../../../tests/threads.rs):
with `--post-completion 4,7` a parked worker resumes and exits 0; without it the
same guest exits non-zero with a strand refusal.

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
node scripts/build-test-programs.mjs --force          # → tests/programs/build/wake-on-worker.wasm
cp tension-core/tests/programs/build/wake-on-worker.wasm \
   tension-core/tests/programs/fixtures/thread/
```

The artifact that was committed:

```
29 315 bytes   sha256 4981f0914e9be592…
```

Then prove it, both directions:

```sh
tension-core --executors 2 --post-completion 4,7 <artifact>   # exit 0
tension-core --executors 2 <artifact>                         # exit 1, refusal
```
