# DL15 — the gate now runs what it was skipping, and `main` is green

`~/work/TensionScript-a2` `main` @ **`00675020`**, pushed, PR **#79** merged as a
fast-forward. `main` CI run **`45070707186`** completed **success — 16/16 jobs**,
`Features` among them, with `features/threads` actually instantiating.

`tests/compiler.js` only, +124/−8. **Bundle unchanged at `767d3d7a`.** No I33
narrowing, no compiler source change, no revert of #78.

## 0. Phase 0

```
TensionScript-a2   main  dddd8849   clean   node v26.13.1
Tension            integration/dwarf-debug  316d109   clean
```

One difference from the brief's expectation: Node here is **v26.13.1**, not
v26.12.1. No behavioural difference for this round — every measurement below ran
on 26.13.1 and says so. The harness is at `316d109`, matching the brief, and it
now includes my DL14 report, which had been left unpushed when the branch
diverged; that was reconciled outside this round and is on the remote.

## 1. Phase A — why it skipped, and whether the probe can be truthful

**Item 1 — where the skip is decided.** `tests/compiler.js:80` (before this round):

```js
const features = process.env.ASC_FEATURES ? process.env.ASC_FEATURES.split(",") : [];
```

and, per fixture, `tests/compiler.js:253-256`:

```js
config.features.forEach(feature => {
  if (!features.includes(feature) && !features.includes("*")) {
    missing_features.push(feature);
  }
```

then `tests/compiler.js:370-372`:

```js
if (missing_features.length) {
  console.log("- " + stdoutColors.yellow("instantiate SKIPPED") + ": " + missing_features.join(", ") + " not enabled\n");
  return prepareResult(SKIPPED, "feature not enabled: " + missing_features.join(", "));
}
```

**Item 2 — what it probes for. It probed nothing.** `missing_features` was fed
*only* by `ASC_FEATURES`. There was no capability test anywhere in this path: the
harness never asked the runtime whether it could run a feature, it asked whether
the operator had listed it. So the printed sentence `threads not enabled` was a
statement about an environment variable, and it read as a statement about the
machine. That is the defect — bigger than the flag, and the reason DL8's local
green was vacuous.

The `unrecognized flag --experimental-wasm-threads` line is a *separate*, cosmetic
consequence: `tests/features.json` lists `--experimental-wasm-threads` as a
`v8_flag`, and `v8.setFlagsFromString` printed that error into the log. Measured
on Node 26.13.1: `node --v8-options | grep -c experimental-wasm-threads` → **0**,
i.e. the flag is gone, because threads are on by default. All three V8 flags in
`features.json` are obsolete on this Node (`threads`, `gc`, `relaxed-simd` each
print "unrecognized flag"). `setFlagsFromString` does **not** throw — it returns
and prints — which is why the run continued to the LinkError instead of aborting.

**What Node 26.13.1 actually supports**, measured by compiling one minimal module
per feature (`new WebAssembly.Module`, which throws when the runtime cannot):

| feature | probe | result |
|---|---|---|
| `threads` | `(memory 1 1 shared)` + `i32.atomic.rmw.add` | supported, and executed: memory 41 → 42 |
| `reference-types` | `(func (param externref))` | supported |
| `simd` | `(func (result v128))` + `v128.const` | supported |
| `relaxed-simd` | the same + `i32x4.relaxed_swizzle` | supported |
| `gc` | `(type (struct (field i32)))` | supported |
| `exception-handling` | `(tag (param i32))` | supported |

**Item 3 — what `ASC_FEATURES` does.** It was the whole gate (item 1). CI sets it
to `threads,reference-types,gc,exception-handling` for the Features job
(`.github/workflows/test.yml:157-160`), which is why CI ran the case and a local
run did not.

**Item 4 — what else skipped on the same gate. Seven fixtures, not one:**

```
tests/compiler/features/threads.json              ['threads']
tests/compiler/features/reference-types.json      ['reference-types']
tests/compiler/features/gc.json                   ['gc']
tests/compiler/features/exception-handling.json   ['exception-handling']
tests/compiler/features/relaxed-simd.json         ['simd','relaxed-simd']
tests/compiler/bindings/raw.json                  ['reference-types']
tests/compiler/bindings/esm.json                  ['reference-types']
```

A whole local run printed `instantiate SKIPPED` **7 times**. Every one of them was
a case that had never run on this machine.

**Stop verdict: no stop.** The probe can be made truthful without guessing —
all six features have a real, minimal, compilable module, and each is verified
above on the Node in use.

## 2. Phase B — the change

`tests/compiler.js`, +124/−8, three parts.

**(1) Capability probes** (`CAPABILITY_PROBES` + `runtimeSupports`), each entry a
base64 module with the disassembly in a comment. The `threads` probe is the one
that matters:

```js
// (memory 1 1 shared) + (func (result i32)) whose body is
// i32.const 0; i32.const 1; i32.atomic.rmw.add; drop; i32.const 0; end.
// Compiling it is what proves the runtime accepts a **shared memory** and an
// **atomic instruction** — the two halves a thread fixture needs.
threads: "AGFzbQEAAAABBQFgAAF/AwIBAAUEAQMBAQcQAgZtZW1vcnkCAANydW4AAAoPAQ0AQQBBAf4eAgAaQQAL",
```

An unknown feature name reports *unsupported*, not "fine": guessing is what this
change exists to remove.

**(2) The gate**: `ASC_FEATURES`, when set, keeps exactly the old semantics (CI's
contract); when unset, the runtime decides. The skip line now carries the reason:

```
instantiate SKIPPED: reference-types (not listed in ASC_FEATURES)
instantiate SKIPPED: threads (this runtime cannot run it)
```

V8 flags are applied **only** for features the probe said no to, and the probe
cache is cleared afterwards because a flag can change the answer. On Node 26
nothing is applied, so the `unrecognized flag` noise is gone; on an older Node this
is exactly the previous behaviour.

**(3) The two imports**, in the `scheduler::park` style the brief specified —
inside `env`, which was my first mistake in this round (I put them as siblings of
`env` at first, and the same LinkError came back; that is what the deliberate-red
step below exercised):

```js
// The thread ABI's host half, `env.__executorCount` and
// `env.__startThread` (`docs/threads.md` §1). A `--sharedMemory` build
// imports both **unconditionally** — even a program that spawns nothing —
// so instantiation needs them present. Linkability only: nothing here
// runs a thread, and these fixtures never call them.
//
// The answers are the ones `docs/threads.md` §1 fixes for a guest with no
// pool: `__executorCount` is 1 (main alone, no worker to count) and
// `__startThread` is non-zero (the worker never started). Returning 0
// from `__startThread` would claim a thread is running that is not.
//
// I33 is why this stub exists at all: since `dad86d13` the surface
// follows `--sharedMemory` rather than the async shell, so a fixture that
// only wanted a shared memory now carries the imports too. When the
// compiler emits the surface only for programs that name a thread API,
// these two become unnecessary and this block goes with them.
__executorCount: () => 1,
__startThread: () => -1,
```

## 3. Phase C — both directions

**The case now runs, locally, with no `ASC_FEATURES` set (Node 26.13.1):**

```
# compiler/features/threads
- compile debug        SUCCESS
- compare fixture      SUCCESS
- compile release      SUCCESS
- compare fixture      SUCCESS
- instantiate debug    SUCCESS (36.049 ms)
- instantiate release  SUCCESS (2.534 ms)
[ SUCCESS ]  EXIT=0
```

**no skip line** (`grep -c SKIPPED` → 0) and no `unrecognized flag` line.

**The gate can fail — deliberate red.** With `__executorCount` removed from the
stub and nothing else touched:

```
LinkError: WebAssembly.instantiate(): Import #1 "env" "__executorCount": function import requires a callable
features/threads [instantiate error (debug)]
EXIT=1
```

restored afterwards, and the run went back to `[ SUCCESS ] EXIT=0`. Before this
round **no local invocation of any kind could produce that error**, because the
case was skipped before instantiation was attempted. That is the whole point.

**Suites:**

| suite | exit | note |
|---|---|---|
| `npm run check` | **0** | — |
| `npm test` | **0** | 20 groups `[ SUCCESS ]`, no failure block |
| `npm run test:compiler -- --parallel` | **0** | **0 `instantiate SKIPPED` lines** (was 7) |
| CI's exact Features command, `ASC_FEATURES` set | **0** | unchanged behaviour |

## 4. After the merge

```
PR #79  16/16 checks pass
main    run 45070707186  completed  success   16/16 jobs
        Features         success
```

And the Features job's log shows the case genuinely running rather than skipping:

```
# compiler/features/threads
- instantiate debug
- instantiate release
```

The only `SKIPPED` left in that job is `features/gc`, which is `gc.json`'s own
`"skipInstantiate": true` (it compiles with `--noValidate`) — unchanged from
`dddd8849`, and a per-fixture opt-out rather than a capability skip.

## 5. State

```
TensionScript-a2   main  00675020   clean, pushed   bundle 767d3d7a (unchanged)
Tension            integration/dwarf-debug  316d109  clean, unchanged
```

`git diff --stat dddd8849 HEAD` → `tests/compiler.js | 132 +++---` and nothing else.

## 6. What I did not verify

- **Older Node behaviour.** The claim "on Node 20 the probe fails, the flag is
  applied, the probe answers again" is reasoned from the code path, not measured —
  only 26.13.1 is installed here. `package.json` says `node >=20`.
- **That the six probe modules are the *minimal* ones.** They are minimal enough to
  be read at a glance, not proven minimal.
- **Windows.** The PR CI matrix includes it and passed, but I did not examine that
  job's log.
- `features/simd` has no fixture of its own; `simd` appears only as one of
  `relaxed-simd`'s two declared features. The authoritative count is the **7**
  `instantiate SKIPPED` lines in the pre-change run's log, from 7 fixture JSONs.
- The 30 → 16 check-count difference between PR #78 and #79 is simply two runs vs
  one (PR run + main push run); I did not change any workflow.
