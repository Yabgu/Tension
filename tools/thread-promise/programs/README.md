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

**`fix/plain-worker` (`dddd8849`), bundle `767d3d7a` — not `main`.** They use
surface that exists only on that branch:

- `__workerArg()` and `__workerMainPlain(id)` in `std/assembly/thread.ts` (added
  by `695f51d3`, the plain worker);
- a `__spawnIndexOf` that answers a real index for a build with no async shell,
  and the thread-surface exports emitted for any shell rather than only the
  async one (`dad86d13`).

Built with `main`'s bundle (`45b3535e`), both programs fail to compile:

```
ERROR TS2305: Module '~lib/thread' has no exported member '__workerArg'.
ERROR AS100: Not implemented: ~lib/task-stack/__spawnIndexOf requires the
             suspending async shell, which this program does not emit
```

That is the whole point of the branch: on `main` a thread program needs the
continuations shell, and on Windows the engine refuses continuations. So a
round re-running these measurements must install the `fix/plain-worker` bundle
first, and must say which bundle it used.

## Build

Both programs build with the thread flags **minus `--enable stack-switching`** —
that is the whole point of the plain (Promise) worker. From the repository root:

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

The reconstruction hashes are reproducible: same compiler bundle, same flags,
same bytes. The original hashes are recorded so that nobody mistakes a
reconstruction for its source. Both rows on each side were built with bundle
`767d3d7a`, so the size difference is the program text alone.

## History

- W13 reconstructed both programs in `%TEMP%` and measured them on Windows
  (`counter=10`; strand exit 1).
- W14 committed them here, verbatim as measured, with these headers.
