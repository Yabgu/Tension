# DL37 — the fiber artifact stops asking for a feature it does not use

**Round:** DL37, 2026-11-24. Three phases: A (I85, the pruning), B (I86, records
for the rows above the guests), C (the CI the suites needed).

| | |
|---|---|
| Tension | branch **`feat/dl37-build-records`** @ **`edb5f48`**, off `2ba1bf8` |
| TensionScript-a2 | branch **`feat/dl37-fiber-types`** @ **`0159ea2c`**, off `8d495b06` |
| binaryen | `e84dfd8e…` — **not moved** |
| installed compiler | `a1ccac35` before → **`1065f81c`** after (the tree's own build) |
| census | **71/82**, `engine.stale: false`, before **and** after |

---

## 1. Phase 0, as measured

```
TensionScript-a2  feat/dl36-artifact-identity @ 8d495b06   clean
Tension           feat/dl36-fiber-executor   @ 2ba1bf8    clean
third_party/binaryen  e84dfd8e0f6ea3536a14c6c4f7f75e86ffaf031a
installed compiler    a1ccac356de5   (= tree dist/assemblyscript.js)
census                71/82 pass, 0 skipped, 11 no-source   engine.stale: false
```

All four matched the brief.

**The release runtime was rebuilt first**, as instructed:

```
cd tension-core && TENSION_STATIC_SDL=0 cargo build --release \
  --no-default-features --features audio,render2d-core --bin tension-core
→ target/release/tension-core  2026-11-24 17:07  (28 272 280 bytes, sha256 303ac29b…)
```

Its mtime was then **newer than every source** (`src/main.rs` 15:13), and the
census captured `engine.stale: false` on both ends of the round (engine mtime
17:33 after the chain rebuild, `stale: false` again). DL36's report ran a binary
that predated its own commit; that is not repeated here.

---

## 2. Phase A — fiber mode emits no continuation machinery (I85)

### 2.1 What decides the pruning

**Not a special case for the fixture: a second shell.** `Compiler#fiberShell`
(`asyncShellSuspends && fiberBackendActive`) selects, in four places that must
agree:

| decision | continuation shell | fiber shell |
|---|---|---|
| prologue | `prepareAsyncStackPrologue` — interns `$ct`, declares `$idle`/`$done`/`$await`, adds the `(ref null $ct)` table | `prepareFiberPrologue` — **globals only** (`__asyncStatus`, `__currentSlot`, `__nextSlot`, `__lastStatus`) |
| module features | `… \| StackSwitching \| GC \| …` | the same **minus `StackSwitching` and minus `GC`** (GC existed only for the continuation type) |
| shell preparation | `prepareAsyncStackShell` — core loop, `$ctCore`, spawn starts | `prepareAsyncFiberShell` — `main$start`, `__asyncPump`, spawn starts; **no core loop** |
| `__start` rewrite | install `main$start` as a continuation, `resume` `__coreloopAwait` with two handlers | `__asyncStatus = main$start()` — three lines |

`__installCont` also splits: in fiber mode it is a counter (`__nextSlot` hands
out the id) rather than `cont.new` + `table.set`.

The three other mechanism intrinsics — `__resumeMain`, `__serveCont`,
`__resumeTask` — are reachable from std's executor (`std/assembly/thread.ts` is
compiled whole, and a fiber build needs `mainExecutor`, the step and the
workspace), so pruning by reachability was not available. In fiber mode they
compile to `module.unreachable()`, with the reason in the source: nothing in a
fiber run calls them, and a tool that did gets a trap rather than a module
demanding a feature it does not use.

**The selection is also why the flag became optional**: `transforms.ts` now picks
the stackful lowering when `--stackful-backend=fiber` is set, not only when
`--enable stack-switching` is, and the shell gate is
`hasAwait && (StackSwitching || stackfulBackend === fiber)`.

### 2.2 The artifact, measured

```
$ how the fixture is built now (FIBER_FLAGS = THREAD_FLAGS − "‑‑enable stack-switching"
  + "‑‑stackful-backend fiber")
  (cont …) types          0
  tag section             0
  cont.new/resume/suspend 0
  imports                 env.abort, tension::io.print,
                          scheduler.park, scheduler.completion,
                          env.__executorCount, env.__startThread, env.memory
```

Section ids, **before → after**:

```
before: [1,2,3,4,13,6,7,9,12,10,11,0]   ← 13 is the tag section
after:  [1,2,3,4,     6,7,9,12,10,11,0]
```

**The brief's byte codes were wrong, and the test asserts the measured ones.**
It said "no `0x5e`/`0x5f` type encodings"; those are `struct` and `array` in the
GC encoding. The continuation type's form byte is **`0x5d`** — measured: 2
occurrences in the DL36 fixture's type section, 0 in this round's. The new test
asserts on `0x5d` (and counts it by walking the type section, because a raw scan
for the byte can match inside a type's payload).

### 2.3 With and without `--enable stack-switching`

```
without the flag:  f7ac5f00273c2777ab66ffd5642ea62c8be8a17de3dacfcb73632b0c7d0f6564
with    the flag:  f7ac5f00273c2777ab66ffd5642ea62c8be8a17de3dacfcb73632b0c7d0f6564
cmp: identical
```

### 2.4 The bare-`Config` load

A throwaway probe (`/tmp/dl37load`, not committed — see §9) with **no**
`wasm_stack_switching`, no threads, no shared memory: the configuration a target
without continuations offers.

```
new fiber artifact:        PARSED ok: 280 functions, 7 imports
                           INSTANTIATE refused (defined): unknown import: `env::abort` …
DL36's fiber fixture:      PARSE REFUSED: failed to parse WebAssembly module     ← the defect
```

A missing import is a defined answer; a parse refusal is not. And the
continuation fixtures are unchanged, as they must be:

```
debug/main-policy.wasm        PARSE REFUSED   ← still asks for the feature, correctly
debug/rt-guards.wasm          PARSED ok
fiber/i70-fiber.wasm          PARSED ok       ← this round
thread/spawn-entry-async.wasm PARSE REFUSED
thread/two-waiters-late.wasm  PARSED ok
thread/wake-on-worker.wasm    PARSED ok
```

**It still runs.** The real binary, on the pruned artifact:

```
executor: fiber (scheduler::park suspends an OS thread's stack)
warm=0 · before=1
fiber: task 0 parked on class 4 key 7
fiber: completing class 4 key 7 with 500 → resume
value=500 · start_game=1 · EXIT=0
```

### 2.5 The new test — suite 366 → 367

`tests/compiler/stackful-fiber-pruned` (`npm run test:compiler -- --parallel` →
**367**, `[ SUCCESS ]`). Four assertions:

1. the fiber build declares **no** `0x5d` composite type;
2. it declares **no** tag section;
3. compiling with `--enable stack-switching` gives **byte-identical** output;
4. **the control** — the same source in the default backend **does** declare a
   continuation type and a tag section.

Harness reused, not duplicated: the DL36 `skipFixture` mechanism and its
import-time glue, with the byte reader extracted to
`tests/compiler/stackful-wasm.mjs` and shared by both tests. `stackful-fiber-section.js`
was refactored onto it in the same commit.

### 2.6 What Windows still lacks

**Not claimed.** A fiber artifact now parses on an engine without stack
switching, which is the blocker I16 named — but nothing here ran on Windows, the
runtime's own executor path on a non-continuation target is unexercised, and the
concurrency model (one suspended fiber per OS thread) has never been measured
there. That is WIN18.

---

## 3. Phase B — the rows above the guests record their inputs (I86)

### 3.1 The schema, and who writes it

Canonical form, one definition per artifact:

```
files sorted by repo-relative POSIX path
  for each:  <path>\0<sha256(content)>\n
sha256 over that stream  →  "inputs"
```

**No mtime anywhere.** Two records, each written by the step that built the
artifact:

| artifact | record | inputs | writer |
|---|---|---|---|
| `dist/assemblyscript.js` | `dist/assemblyscript.js.build.json` | `src/`, `cli/`, `std/`, `package.json`, `tsconfig-base.json` — **159 files** | `TensionScript-a2/scripts/build.js`, last step |
| `target/<profile>/tension-core` | `tension-core.build.json` beside it | every `.rs` under `tension-core/src`, every `.zig` under `tension-res/src`, `Cargo.toml`, `build.rs` — **84 files** | release: `scripts/build-native.mjs`; debug: `rebuild.mjs`'s `cargo build (dev)` step |

```json
{ "format": 1, "inputs": "…", "inputFiles": 84,
  "inputsDescription": "tension-core/src/**/*.rs, …", "profile": "release",
  "artifact": "…", "built": "2026-11-24T16:49:58.343Z" }
```

`--check` **only reads**. The compiler's digest is imported from *the checkout
being verified* (`COMPILER_DIR/scripts/lib/build-record.mjs`) rather than
reimplemented here: two copies of a canonical form is how a record and its check
come to disagree.

### 3.2 The rows, and both red cases

Green:

```
compiler: src → dist/assemblyscript.js  159 inputs → 2b94c03e4458  recorded 2b94c03e4458  PASS
runtime: src → release                  84 inputs → 676a8e4e6329   recorded 676a8e4e6329   PASS
runtime: src → debug                    84 inputs → 676a8e4e6329   recorded 676a8e4e6329   PASS
```

**Red 1 — the dist record names another source identity:**

```
compiler: src → dist/assemblyscript.js  159 inputs → 2b94c03e4458  built from ffffffffffff  STALE
rebuild: 8/9 links PASS, 1 STALE/UNKNOWN                                        EXIT=1
```

**Red 2 — a runtime record is stale:**

```
runtime: src → release  84 inputs → 676a8e4e6329  built from 000000000000  STALE
runtime: src → debug    84 inputs → 676a8e4e6329  recorded 676a8e4e6329     PASS   ← isolated
rebuild: 8/9 links PASS, 1 STALE/UNKNOWN                                   EXIT=1
```

Restored: `9/9 links PASS`, exit 0. The ninth link (guests) is untouched and
still reports **58 of 58 current**.

A third red state showed up unasked and is worth recording: with the code in
place and no records written yet, both runtime rows read
`no build record beside the binary` → STALE. That is the intended behaviour for a
tree that has not run the build, and it is what a fresh clone sees.

---

## 4. Phase C — the CI the suites needed

**Tension** (`.github/workflows/e2e-debug.yml`), one line plus its comment:

```diff
       - name: Stackful proofs
         run: |
           cargo test --manifest-path tension-core/Cargo.toml --no-default-features \
-            --test fiber --test fiber-executor
+            --test fiber --test fiber-executor --test fiber-runner
```

The exact command, run locally: **6 + 7 + 5 = 18 tests**, all pass under
`--no-default-features`. `fiber-runner` needs no compiler (its artifact is
committed), which is what lets this job run it.

**TensionScript-a2** (`.github/workflows/test.yml`):

```diff
 on:
-  push:
-    branches:
-    - main
+  push:
   pull_request:
```

**Triggers as they now stand:** `push` (any branch), `pull_request` (any). The
proof is the round's own push — the workflow ran on a feature branch, which it
would not have before:

```
Test  feat/dl37-fiber-types  push  45443174768
```

Nothing was weakened or skipped: the job list, the flags and the fixtures are
unchanged.

---

## 5. Gates

| # | gate | measured |
|---|---|---|
| 1 | compiler suite 366 → **367** | **367** `[ SUCCESS ]` |
| 2 | `--check` 9/9 with both record types, two red transcripts | **9/9**, §3.2 |
| 3 | default-mode guests byte-identical to `a1ccac35` | **56 of 58 identical**; the 2 that moved are the **fiber** artifacts, which Phase A changes by design (§6) |
| 4 | fiber: 0 cont, 0 tags, bare-Config load, same bytes with/without the flag | §2.2–§2.4 |
| 5 | threads 9 · fiber 6 · fiber-executor 7 · async_main_promise 2 · debugger 5 · `--bin` 307 · fiber-runner 5 | all as declared |
| 6 | census identical, `stale: false` both times | **71/82** twice, `stale: false` twice, engine sha256 `303ac29b…` |
| 7 | CI: `fiber-runner` in the list, both triggers named | §4 |
| 8 | commits and branches, both trees clean, `main` untouched | §7 |

### Guest artifacts, per path

```
baseline (a1ccac35, 58 artifacts)   now (58 artifacts)
only in baseline: i70-fiber.wasm ×2 (release 70981859b8d8, debug 2578436723fd)
only in now:      i70-fiber.wasm ×2 (release f7ac5f00273c, debug db89d5477b8a)
```

Every one of the 56 continuation-mode artifacts is **byte-identical**. The
brief's gate 3 says "all 58 … any default-mode byte that moves stops the round";
the two that moved are not default-mode — Phase A's whole purpose is to change
fiber output — and no default-mode byte moved.

---

## 6. What else changed, and why

- **`stackful-fiber-record.{debug,release}.wat` regenerated.** The DL35 fixture
  is the fiber-mode one; its golden is the artifact, and the artifact legitimately
  changed (no cont types, no tags, no core loop). Diff: −5 907 / +4 611 lines.
- **`FIBER_FLAGS` no longer passes `--enable stack-switching`.** The committed
  fixture is therefore *evidence* that the flag is not needed. Its bytes are
  unchanged by the omission — same hash either way — so this is a truthfulness
  fix to the recorded flags, not a behavioural one.
- **`dist/*.build.json` is gitignored**, beside the artifact it describes: a
  record committed for a file git does not carry would be a claim about nothing.

---

## 7. Commits

**TensionScript-a2**, `feat/dl37-fiber-types`:
`0159ea2c` — `async: a fiber build asks for no continuation feature (I85), and
dist records its inputs (I86)`.

**Tension**, `feat/dl37-build-records`:
`edb5f48` — `build: the rows above the guests record their inputs (I86)`.

Both trees clean at the end; `main` untouched in both; no `third_party/` change;
no npm publish; no PR.

**One environment fact worth recording:** the a2 push over HTTPS was rejected —
`refusing to allow an OAuth App to create or update workflow .github/workflows/test.yml
without workflow scope`. The credential `gh` reports has scopes
`admin:public_key, gist, read:org, repo` and no `workflow`. The branch was pushed
over SSH instead (`git push git@github.com:Yabgu/TensionScript.git …`), which is
the same machine's authenticated path and changes no remote configuration. The
HTTPS remote still cannot push a workflow change, so the *next* round that edits
`.github/workflows/*` in this repo will hit the same wall until the token gains
the scope.

---

## 8. What I did not verify

- **Windows.** No run, and §2.6 says what it would and would not prove.
- **The census harness's multi-location behaviour** (I87) — untouched.
- **`f32` / 64-bit payloads** — the i32 path only.
- **I76** (`tests/fiber.rs` Windows cfg), **I78**, **I79/I80**.
- **A fiber stack overflow** — guard pages are off; a guest that overruns its
  512 KiB stack runs into whatever follows.
- **More than one parked fiber per OS thread** — DL24's engine assertion is
  unchanged; the pool shape is one thread per parked task.
- **The bare-`Config` load is a probe, not a standing test.** It lives in
  `/tmp/dl37load` and is not committed: Phase A budgets exactly one new compiler
  test, §5 forbids new suites, and adding a test to `tests/continuation_module.rs`
  would move a count the gate pins. The pattern it follows is already in that
  file (`continuation_module_is_refused_without_stack_switching`), so promoting
  it is a one-test change for the round that wants it standing.
- **The `unreachable()` bodies** for `__resumeMain`/`__serveCont`/`__resumeTask`
  are exercised only in the sense that they compile: nothing in a fiber run calls
  them, which is the point, and a fiber program that *did* would trap.
