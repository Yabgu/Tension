# DL8 — the thread surface is a build config, and it stops one function short

Round: un-gate the threading surface so `--sharedMemory` builds get it without an
async shell. Compiler branch `fix/thread-surface-any-shell`:

| commit | what |
|---|---|
| `dad86d13` | the fix — `src/compiler.ts`, +27/−7 |
| `14afe8aa` | the `features/threads` golden, regenerated (derived output) |
| `a764f8f4` | two RT test hosts answer the imports a shared build now carries |

Pushed, `origin/fix/thread-surface-any-shell` = `a764f8f4`. Nothing merged, `main`
untouched.

## 1. What the round found before it edited anything

The brief's hypothesis was "the gate is `asyncShellPrepared`, move it to
`sharedMemory && !gcActive`". That is right for eight of the nine exports and
wrong for the ninth, and the ninth is the one the host needs to start a worker.

`threadFunctions` (compiler.ts:570) are compiled only when exported, so exporting
one compiles its whole import closure. Measured, on a Promise build of `count.ts`
with the gate removed entirely:

```
ERROR AS100: ~lib/task-stack/__serveCont requires the suspending async shell    (task-stack.ts:63)
ERROR AS100: ~lib/task-stack/__resumeTask requires the suspending async shell   (thread.ts:936, :1174)
ERROR AS100: ~lib/task-stack/__lastStatus requires the async shell              (thread.ts:1186, :1650)
```

All five come from one function, `__workerMain`, through three callees —
`__serveOne`, `__drainInbox`, `Executor.step`. That is the **served body** path:
a worker pulling a request and resuming a continuation. It is continuations-shaped
by construction (a `cont` reference cannot leave the store that made it), and it
is exactly what §2 of the brief puts out of scope.

So the change is the briefed one **minus** `__workerMain` where no suspending
shell exists. A Promise build now exports the carveable half:

| export | promise build | stackful build |
|---|---|---|
| `__threadInit` | yes | yes |
| `__spawnThread` | yes | yes |
| `__executorExit` | yes | yes |
| `__threadJoin` | yes | yes |
| `__mainArenaBase/Size`, `__workerArenaBase/Size` | yes | yes |
| `__heapBase`, `__controlBase`, `__controlStride`, `__ringCapacity`, `__executorTotal` | yes | yes |
| `__workerMain` | **no — needs the served body path** | yes |

The consequence, stated plainly: **a Promise build can now be carved, booted,
joined and read, but it cannot run a worker.** `a_worker_runs_on_its_own_store_and_joins`
stays a stackful-only test. Threads that *do work* still need continuations; what
this round buys is that the host no longer silently skips the carve.

## 2. Phase A — the inventory the brief asked for

1. **The guard.** `compiler.ts:1709` opens `if (this.options.sharedMemory && !this.gcActive)`;
   `arenaFunctions` at :1711 were already under that alone, and `threadFunctions`
   (:1725) plus `threadGlobals` (:1733) were additionally under
   `if (this.asyncShellPrepared)` at :1724.
2. **What a user can call.** `ThreadPool` (`std/assembly/thread.ts:587`) —
   `create(workers)`, `submit`, `take`, `join`, `size`, `lastStatus` — is the
   user-facing API that lives in `~lib/thread` and calls no `~lib/task-stack`
   symbol. So the premise holds: there *is* a spawn/join a user can write without
   the served-body API. It compiles today on the old compiler (measured), and it
   aborted at run time at `itcms.ts:128` — the arena assertion — because the host
   skipped the carve. That is the bug the round is about. What it cannot do,
   before or after, is hand work to a worker without a `$starts` index, because
   the only drain path is `__workerMain` → `__serveOne`.
3. **Every `asyncShellPrepared` site, with a verdict.**

| line | what it does | verdict after the change |
|---|---|---|
| 723 | declaration | unchanged |
| 956 (`preparePromiseShell`) | sets `promiseShellPrepared`, not this | unchanged |
| 1085 (`prepareAsyncShell`, A1) | set before compiling `__coreloop` | unchanged |
| 1263 (`prepareAsyncStackPrologue`) | set | unchanged |
| 1316-1317 (`prepareAsyncStackShell`) | sets `asyncShellSuspends` + this | unchanged — now also the `__workerMain` gate |
| 1583 | drives `prepareAsyncStackPrologue` | unchanged |
| 1660 | "stackful needs an exported main" refusal | unchanged |
| **1724** | **the thread-surface gate** | **moved out; `__workerMain` now gated on `asyncShellSuspends`** |
| 1913-1914 | `__start` rewrite | unchanged |
| 2014 (`emitStartEntry`) | the shell status word | unchanged — a Promise build still answers 0 |
| 6781 | await lowering | unchanged (reads `asyncShellSuspends`) |

No second site needed a matching edit: the surface has no status word and no
`__start` rewrite, so nothing else was inconsistent.

## 3. Phase B — the change

`src/compiler.ts`, one hunk, +27/−7. The emission is single-run by construction:
the block sits in the one code path that emits the start entry, the loops iterate
fixed name lists, and each `add*Export` is guarded by `module.hasExport(name)`.

Compiler bundle: `dist/assemblyscript.js` **45b3535e… → cf14aa5c…**.
`dist/asc.js` is unchanged (`e635a221…`) — it is the bootstrap stub and proves
nothing. Both compilers rebuild to their exact hashes here, so the before/after
builds are reproducible.

## 4. Phase C — Linux did not move

| check | result |
|---|---|
| `cargo test --test threads` | **5 passed**, 0 failed, 1.13 s — the real assertions, not the refusal path: `a_shared_memory_guest_can_print`, `a_worker_runs_on_its_own_store_and_joins`, `one_executor_count_plus_the_pool`, `the_contracts_refusals_are_values`, `two_workers_observe_every_value_exactly_once` |
| conformance census (82 cases, 8 workers) | **71 pass / 11 no-source / 0 wrong-line / 0 unresolved / 0 skipped — no case moved**; all 71 `pass` rows keep their `observedLine` |
| `cargo test --test async_main_promise` | **2 passed** (`the_promise_entry_loads_without_stack_switching`, `async_main_runs_on_the_promise_backend`) |
| stackful guest | `examples/async-on-main/build/game.wasm` → 28 lines, exit 0; `main-policy.wasm --executors 2` → `phase: start / installed: 1 / steps: 5 / value: 30` |

Stronger than the census: all **25** debug artifacts rebuilt from the new
compiler are **byte-identical** to the pre-change builds — every stackful and
every non-shared program is untouched, byte for byte.

## 5. Phase D — the Promise builds

Both scratch copies are `count.ts` built with `THREAD_FLAGS` minus
`--enable stack-switching`. **`--executors N` must come before the module path**;
after it, the host ignores the flag and answers `executors=1` (measured — both
orientations were run).

### D1 — the annotated async copy (what W10 built)

`let _ignored: i32 = await leaf();`, 25 906 B, sha256 `8936a887…`.

```
executors=3            controlBase=carved      executorTotal=3
ringCapacity=1024      controlStride=16432
exit 0
```

### D2 — the synchronous copy (no `async`, no `await` anywhere)

14 912 B, sha256 `7e40c6b3…`. Same five lines, same exit 0. **Threads no longer
need async at all** — the async shell was never the reason the surface exists,
only the reason it was gated.

### The same two programs on the pre-change compiler (45b3535e)

| | D1 | D2 |
|---|---|---|
| size | 22 797 B | 11 764 B |
| sha256 | `4c0f553f…` | `005839b9…` |
| exports | arena only — no thread surface | the same |
| run `--executors 2` | **exit 1**, `game aborted: (in , line 128, col 18)` | **exit 1**, the same abort |

So the causal chain is measured end to end: same source, same flags, same host;
the compiler bundle is the only variable, and it moves the guest from an
`itcms.ts:128` abort to five correct lines.

## 6. Blast radius, stated honestly

The commit message says "every existing artifact is unchanged". That is true for
the 25 conformance artifacts, and **false in general** — it should read "every
non-shared artifact". Measured: a one-line `export function main(): i32 { return 0; }`
built with `--sharedMemory --enable threads` now exports the whole surface and
imports `env.__executorCount` + `env.__startThread`, where before it exported
nothing and imported neither.

That matters outside the Tension host: a shared-memory module dropped into a bare
wasmtime now fails to instantiate on two unknown imports where it used to
instantiate fine. The host here registers both for every guest
(`ExecutorPool::link`), so nothing in this repo breaks; a third-party embedder
would notice.

`--sharedMemory` already compiled `~lib/thread` into the program before this
change (that is why `--enable threads` is required even for a one-line `main`), so
`program.lookup("__threadInit")` was always going to succeed — the old gate was
the only thing keeping the surface out. A narrower rule ("export only if the
program names a thread API") is possible but is not what the brief asked for, and
is not free: it needs a usage question the compiler does not currently ask.

**One test moved, and it is derived output.** `tests/compiler/features/threads`
— an atomic-opcode fixture that pulls `~lib/thread` in via `--sharedMemory` — had
a stale golden. Regenerated in its own commit (`14afe8aa`), unchanged in intent:
no assertion was relaxed, the fixture still pins exact codegen. Validated by
running the same generation procedure with the pre-change compiler, which
reproduces the previous golden byte for byte.

**Two RT hosts had to learn the two imports** (`a764f8f4`). `tests/rt/arena.js`
and `tests/rt/atomics.js` instantiate shared guests with `env: { abort, trace }`
and nothing else — correct until today, because an unshelled shared build
imported neither thread verb. Both now answer `__executorCount: () => 1` and
`__startThread: () => -1`, the no-pool values, exactly as a host with no pool
does. Neither harness spawns.

One assertion changed scope on the way, and the change is a tightening rather
than a relaxation. `arena.js` §6 asserted *zero* atomic instructions in the whole
module — the proxy for "the allocator is not atomic, because each arena is its
own store". That proxy is only the same claim while the module carries no thread
surface; `~lib/thread`'s slot ring is atomics by nature (106 of them). The check
then still measured exactly what it always measured — `tlsf` has none, `~lib/rt/`
has none — and now says more: every atomic in the module must belong to the
thread surface, and the allocator's must be zero. Verified by attribution (each
`atomic` counted against its enclosing function), not by string presence.

## 7. Gate

| gate | declared | measured |
|---|---|---|
| `npm run check` | green | exit 0 |
| `npm test` | — | **exit 0**, 20 suites `[ SUCCESS ]`, no failure block |
| `npm run test:compiler -- --parallel` | — | exit 0, 7 pre-existing feature skips, `features/threads` compare SUCCESS (debug + release) |
| `node tests/rt/arena.js` | — | 76 checks SUCCESS |
| `node tests/rt/atomics.js` | — | 71 checks SUCCESS |
| `cargo test --test threads` | 5 passed | 5 passed |
| `cargo test --test async_main_promise` | 2 passed | 2 passed |
| census | 71 / 11, nothing leaves `pass` | 71 / 11 / 0 / 0 / 0, no case moved |
| 25 debug artifacts | — | byte-identical after the rebuild |
| compiler bundle | changes, hash reported | 45b3535e… → **cf14aa5c…** (`asc.js` unchanged) |

## 8. What is not verified

- **No worker has ever been started from a Promise build**, because it cannot be:
  `__workerMain` is the served-body path and is not emitted. D1/D2 prove the carve,
  the globals, the arena bounds and the boot order, not a running worker.
- **Windows has not run any of this.** The brief's premise is that this is what
  unblocks Windows; that is what the Windows host will say.
- The `features/threads` golden was regenerated here, on the reasoning above. If
  the narrower gate ("only programs that name a thread API") is preferred, the
  golden goes back to what it was and the surface stops appearing for atomic-only
  fixtures.
- `ThreadPool.create()` on a Promise build now carves, spawns and joins — but the
  spawned worker exits immediately with the host's "the module exports no
  `__workerMain`" rather than doing work. Not measured end to end; inferred from
  the export list and `thread.rs:415`.
- The three commits are on one branch and were each pushed as they were made; no
  force-push, no rebase, and `main` never moved.
