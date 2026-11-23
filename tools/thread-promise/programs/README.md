# `tools/thread-promise/programs/` — the guest programs behind DL9 and DL11

## Why these files exist

DL9 and DL11 measured thread behaviour with programs written to `/tmp` and never
committed. `git log --all` finds nothing, so their artifacts cannot be rebuilt
and their measurements cannot be re-run. When round W13 needed them it had to
**reconstruct** them from the reports' prose.

A measurement whose input cannot be reconstructed is weaker than one whose input
is committed: nobody can re-derive it, nobody can vary one thing and compare, and
the next round starts by re-inventing the program. These two files close that
hole for the two measurements W13 reproduced.

**They are reconstructions, not originals.** See the header of each file, and the
hash table below. Do not compare a reconstruction's hash with an original's.

## Which compiler these programs need

**Bundle `aa74d6a1`, on `main` (`3f59ec08`).** Everything these programs use is
released surface now; earlier revisions of this file named
`fix/plain-worker`/`767d3d7a`, which was true in rounds 9–16 and is not any more.

What they need from it:

- `__workerArg()` and `__workerMainPlain(id)` in `std/assembly/thread.ts`;
- a `__spawnIndexOf` that answers a real index for a build with no async shell,
  and the thread-surface exports emitted for a program that reaches them rather
  than for every shared build (`6a7b2a1`/DL16).

Build them with the installed bundle directly:

```sh
node scripts/tensionscript.mjs tools/thread-promise/programs/plain-worker.ts \
  -o /tmp/plain-worker.wasm \
  --runtime incremental --target release \
  --sharedMemory --importMemory --initialMemory 2 --maximumMemory 256 \
  --enable threads --optimizeLevel 0
```

```sh
node scripts/tensionscript.mjs tools/thread-promise/programs/strand-nested.ts \
  -o /tmp/strand-nested.wasm \
  --runtime incremental --target release \
  --sharedMemory --importMemory --initialMemory 2 --maximumMemory 256 \
  --enable threads --optimizeLevel 0
```

Those flags are `THREAD_FLAGS` from `scripts/build-test-programs.mjs` with
`--enable stack-switching` removed and nothing else changed. Do **not** add
`--enable stack-switching`: a stackful build measures a different mechanism, and
on Windows the engine refuses a continuation guest before it loads at all.

## Run

```sh
tension-core --executors 2 /tmp/plain-worker.wasm
tension-core --executors 2 /tmp/strand-nested.wasm
# `wake-on-worker` now builds from the test tree:
#   node scripts/build-test-programs.mjs && \
#   tension-core --executors 2 --post-completion 4,7 \
#     tension-core/tests/programs/build/wake-on-worker.wasm
```

**`--executors 2` goes before the module path.** Everything after the module path
is handed to the guest verbatim as its own arguments, so a flag written after it
is silently ignored and the host answers `executors=1` — a wrong measurement that
still looks like a successful run (I32).

## Expected output

`plain-worker` — exit **0**, a worker does real atomic work over shared memory:

```
before=0
workIndex=0
spawn=0
join=0
counter=10
```

`counter=10` is the number that matters. `workIndex` is `0` on a plain build; a
stackful control reports `2`, which is what distinguishes the two mechanisms.

`wake-on-worker` — **moved in DL21** to `tension-core/tests/programs/thread/`,
because it is a regression test now and not only a probe: `tests/threads.rs` runs
it twice (with and without `--post-completion`) and CI runs that test by name. The
log below is still what it prints; the build flags, the committed fixture and the
recipe live under `tension-core/tests/programs/fixtures/thread/`.

`wake-on-worker` — exit **0**, the DL20 proof: a completion main posts *before* the
park is claimed by a worker's park, and the worker's continuation runs:

```
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
inner: AFTER the await, value=0
worker: AFTER the await, value=0
main: wakes served=1
main: join=0
main: done
```

Needs `--post-completion 4,7`; without it the guest parks forever and the run
refuses (which is what `strand-nested` demonstrates on purpose).

`two-waiters` — **DL21's measurement (I52)**, not a pass/fail probe: two tasks on
one worker both await the same `(class, key)`, and the log says which of them the
host can still see.

```sh
tension-core --executors 2 /tmp/two-waiters.wasm                        # both park
tension-core --executors 2 --post-completion 4,7 /tmp/two-waiters.wasm  # one resumes
```

Both runs record **2 parks** at the seam and report **1** in the refusal, and both
exit **1**:

```
worker: starting two waiters on class 4 key 7
waiter 1: BEFORE the await
waiter 2: BEFORE the await
worker: both waiters started
...
INFO  thread: executor 1 left the park seam having recorded 2 park(s) (first: task 0 on class 4 key 7)
Error: ... executor 1 left 1 task(s) parked and never resumed (first: task 1 on class 4 key 7) ...
```

With the completion, `waiter 1: AFTER the await, value=0` is the one line that
appears — waiter 1 (task 0) is resumed by the sticky buffer at its own park, before
waiter 2 (task 1) displaces it in the ledger. **Verdict: (b)** for the shape the
brief asks about — one resumed, the other stranded, the refusal fired. The count is
the part to keep: the ledger holds **one** entry per key, so a second concurrent
waiter is unrepresentable and the refusal's `2 → 1` is that loss made visible. See
`DL21-REPORT.md` §Part 2 for the code path that would make it (c).

### Pool lifetime — a worker lives for the session (DL20)

A worker does **not** exit when its entry returns. It runs a host-side loop
(`tension-core/src/thread.rs`, `service_wakes`) until the session stops it, and
each wake it serves is a call to **its own** `__taskWake` — the scheduler contract
confines that to the store's owner thread (§2.2), so no other thread may do it.

Teardown is **stop → join → check**: the pool is told to stop, workers leave, they
are joined, and only then is the strand refusal decided. Joining first would
detach a healthy worker with a warning on every run, and checking first would read
a ledger a live worker had not finished contributing to.

Consequence for a guest: joining a worker blocks until that worker is *told* to
stop, so a program must stop it (`__executorExit`) rather than expect it to die
with its entry. `wake-on-worker.ts` — now at
`tension-core/tests/programs/thread/` — uses the host's served-wake counter (header
word 6) to know the wake landed.

`strand-nested` — exit **1**, by design; the guest's stdout is unchanged and the
process refuses in stderr:

```
main: spawning
main: index=0
main: spawn=0
worker: BEFORE the await
main: join=0
main: done
```

```
INFO  thread: executor 1 left the park seam having recorded 1 park(s)
             (first: task 0 on class 4 key 7) — a worker runs no host loop,
             so none of them can be resumed
Error: a worker's task cannot be resumed on this host, so this run would otherwise
       have exited successfully with it stranded: executor 1 left 1 task(s) parked
       and never resumed (first: task 0 on class 4 key 7). …
```

A run of `strand-nested` that exits 0 means the strand refusal did not fire.

## Hashes

Four hashes are known, and **none of the pairs is comparable**: each
reconstruction is a different text from its original, so the bytes differ by
construction.

| program | which | size | sha256 |
|---|---|---|---|
| `plain-worker` | DL9 original (lost) | 15,729 B | `2952849fa89be404…11334f` |
| `plain-worker` | this reconstruction | 15,947 B | `E49006E31B85F89E41ED56D0364F06DA652976B8B8C966EE9D9587E342F7FE28` |
| `strand-nested` | DL11 original (lost) | 30,751 B | `ef56d394a653b2c1…33dbd9` |
| `strand-nested` | this reconstruction | 28,405 B | `72BFC834165E81A1D1E2A6E5DDD361D9674DA529704F9083AD915C7DBC7460AB` |

One more artifact is known by hash: the wake guard's committed fixture,
`tension-core/tests/programs/fixtures/thread/wake-on-worker.wasm` — 29,315 B,
`23ed47bfe51733ac…` at bundle `aa74d6a1`. It is not a probe (DL21 made it a test),
so it lives with the tests; the recipe is beside it.

The reconstruction hashes are reproducible: same compiler bundle, same flags,
same bytes. The original hashes are recorded so that nobody mistakes a
reconstruction for its source. Both rows on each side were built with bundle
`767d3d7a`, so the size difference is the program text alone.

## History

- W13 reconstructed both programs in `%TEMP%` and measured them on Windows
  (`counter=10`; strand exit 1).
- W14 committed them here, verbatim as measured, with these headers.
