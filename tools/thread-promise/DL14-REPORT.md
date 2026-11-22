# DL14 — the thread surface is on `main`, and CI is red on it (I33, as predicted)

`~/work/TensionScript-a2` `main` @ **`dddd8849`**, pushed, PR **#78** merged as a
plain fast-forward. `main` builds `767d3d7a` and all three local suites pass — but
**the CI `Features` job fails**, and it fails for exactly the reason the brief told me
to state in the PR body.

## 0. Phase 0

```
TensionScript-a2    main  646e6058   clean
origin/main                646e6058…
origin/fix/plain-worker    dddd8849…
origin/main..origin/fix/plain-worker   5
origin/fix/plain-worker..origin/main   0        → FF-OK
Tension   integration/dwarf-debug  7b9a0a2   clean
```

The five commits, in order:

```
dad86d13  thread: emit the carveable thread surface for any shell, not just the async one
14afe8aa  compiler(test): regenerate the `features/threads` golden for the new surface
a764f8f4  test(rt): answer the thread imports a shared build now carries
695f51d3  thread: a worker that runs an entry, with no continuations
dddd8849  compiler(test): regenerate the `features/threads` golden for the plain worker
```

Files: `src/builtins.ts`, `src/compiler.ts`, `std/assembly/thread.ts`, the two
`features/threads` goldens, `tests/rt/arena.js`, `tests/rt/atomics.js`.

## 1. Phase A — PR #78

https://github.com/Yabgu/TensionScript/pull/78 — base `main` ← `fix/plain-worker`,
`MERGEABLE`, five commits visible.

The body carries: what each commit does in plain terms; the cross-platform table
(Linux/Windows bundle hashes `45b3535e`/`45B3535E` from `main` and
`767d3d7a`/`767D3D7A` from this branch, attributed to the Windows round rather than
claimed as my own measurement); the same-guest-built-twice evidence (plain
`counter=10` with 0 continuation ops, control `counter=10` with 7); the regression
numbers; and an explicit "what is not fixed" section.

**How I33 is stated**, verbatim from the body:

> **I33 — an embedder-visible consequence of `dad86d13`.** Every `--sharedMemory`
> build now carries the thread surface, so it imports `env.__executorCount` and
> `env.__startThread` **even when it spawns nothing**. A bare embedder that does not
> define those two imports can no longer instantiate such a module — where before it
> could. Nothing in Tension is affected (the host registers both for every guest),
> but this is a real behaviour change and it is not hidden. The narrowing — emit the
> surface only when the program actually names a thread API — is **planned and not
> done** …

## 2. Phase B — the merge

**Method: `git merge --ff-only`, then `git push`.** Chosen so the five SHAs are
unchanged and the bundle hash both platforms verified is the bundle this tree builds.

```
git rev-parse HEAD                    dddd8849dfd2eeb3e514c897811648dfb13d99ad
git ls-remote origin refs/heads/main  dddd8849dfd2eeb3e514c897811648dfb13d99ad
git diff --stat dddd8849 HEAD         (empty — content-neutral)
```

GitHub recorded `mergeCommit == dddd8849`, state `MERGED`.

**Clean build of `main`:** `dist/assemblyscript.js` = **`767d3d7a`** — the declared
hash. Installed into `~/work/Tension/node_modules/@yabgu_gm/tensionscript/dist/`
excluding `binaryen.js` (that file's mtime is still `02:41`, untouched); installed
hash **`767d3d7a`**, matching.

**Local suites on `main`:**

| suite | exit | summary |
|---|---|---|
| `npm run check` | **0** | tsc + `eslint --max-warnings 0` clean |
| `npm test` | **0** | 20 groups `[ SUCCESS ]`, no failure block |
| `npm run test:compiler -- --parallel` | **0** | `[ SUCCESS ]`; `features/threads` compile + compare green, **instantiation skipped** (`feature not enabled: threads`) |

All three green — which is why the CI result matters: **they do not cover the case CI
tests.**

## 3. The finding: CI `Features` is red on `main`

```
2 fail / 30 pass / 0 pending
failing job: Features  (both runs — the PR run 45058777962 and the main push run 45058792760)
```

CI's own words, from `gh run view --log-failed --job=137319939560`:

```
# compiler/features/threads
- compile debug        SUCCESS
- compare fixture      SUCCESS
- compile release      SUCCESS
- compare fixture      SUCCESS
- instantiate debug    ---
  LinkError: WebAssembly.instantiate(): Import #1 "env" "__executorCount": function import requires a callable
  ---
  FAILURE
FAILURE: 1 compiler tests had failures:
  features/threads [instantiate error (debug)]
```

### Why this is I33 and nothing else

The `Features` job runs with `ASC_FEATURES=threads,reference-types,gc,exception-handling`,
which is what makes the harness **actually instantiate** the fixture instead of
skipping it. `tests/compiler.js:481-520` builds that instantiation's `env` from
`globalThis` plus `memory`, `abort`, `trace`, `seed`, `visit`, the `Date`/`Math`
helpers, and a `scheduler.park` no-op — and **no `__executorCount` / `__startThread`**.
Since `dad86d13`, every `--sharedMemory` module imports those two names. So the
module cannot instantiate there. That is precisely the embedder-visible consequence
the PR body declares.

### Reproduced locally, and proved causal by A/B

Same command, same env, two compilers:

| compiler | result |
|---|---|
| pre-merge `646e6058` (`45b3535e`) | `instantiate debug SUCCESS`, `instantiate release SUCCESS`, `[ SUCCESS ]`, exit 0 |
| merged `dddd8849` (`767d3d7a`) | `LinkError: Import #1 "env" "__executorCount" …`, `features/threads [instantiate error (debug)]`, exit 1 |

So none of the other 30 checks moved, and the single red job is caused by these five
commits and by nothing else.

### Why DL8's "green" did not catch it

DL8 ran the same three suites locally and reported them green — correctly, but the
local `test:compiler` prints

```
features/threads [feature not enabled: threads]
Error: unrecognized flag --experimental-wasm-threads
```

and marks the case **skipped**. Only with `ASC_FEATURES` set does the harness stop
skipping and start instantiating. The gap is in the verification recipe, not in the
measurement: the local three-suite gate cannot see this class of failure, and it
should be stated in every future brief as "the Features job is a separate gate".

### Options, not taken

The brief says a red merge is a finding, not something to fix in passing, and
`tests/rt/*` edits are its own kind of change. The two remedies, for the user's call:

1. **Stub the two imports in `tests/compiler.js`'s `env`** — the same shape as
   `a764f8f4` gave `arena.js`/`atomics.js` (`__executorCount: () => 1`,
   `__startThread: () => -1`). ~2 lines, no behaviour change, does not narrow I33, and
   makes the fixture instantiable exactly as a pool-less host would. It leaves the
   I33 embedder impact intact and documented.
2. **Narrow I33** (emit the surface only when the program names a thread API) — the
   real fix, a separate diff, and it is the one this round was told not to do.

Either way this is a red `main`, and a revert of #78 is a third option nobody has
asked for.

## 4. State

```
~/work/TensionScript-a2   main  dddd8849  clean, pushed, dist 767d3d7a
~/work/Tension            integration/dwarf-debug  7b9a0a2  clean, installed 767d3d7a
```

Harness content untouched — the brief's §0 lists guest-program preservation as a
deliverable, but §4, §5 and the gate all assign it to W14 ("the guest-program
preservation is W14", "No guest-program preservation"). I followed §4/§5 and did not
touch the harness, and I am flagging the contradiction rather than silently choosing.

## 5. What I did not verify

- **Windows.** The `45B3535E`/`767D3D7A` and `counter=10` cells are the Windows
  round's measurements, cited. I re-derived only the Linux hashes.
- **The 30 passing CI checks** were not re-run locally; I read their status.
- **Whether the `Features` job was green before this branch ever existed.** I proved
  it green at `646e6058`, which is the parent of the merge, which is the claim that
  matters.
- **The two guest programs** named in §0 are not committed anywhere; that is W14's.
- I assumed `ASC_FEATURES` is the only thing separating my local run from CI's; the
  reproduction with that variable set produced CI's exact error, which is the
  evidence for it.
