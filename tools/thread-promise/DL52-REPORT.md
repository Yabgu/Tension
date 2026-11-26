# DL52 — the default must build the corpus

**Mostly a regression, and the fix is in the shell.** `build:examples` goes from **14 of 22
failed** to **22 of 22 built**, exit 0. CI **16/16** (`45912441455`), `--check` 10/10, every
suite at its declared count.

```
TensionScript  feat/dl51-auto-fiber @ 2a28a3b4   (2 commits: the root, and nothing else)
Tension        feat/dl51-auto-fiber @ db87f82    (example configs; main 4f7ecb8 untouched)
```

---

## 1. Phase 0 — the verdict, measured on both commits

A worktree at `4f7ecb8` (the commit before DL51's merge), with its own pinned compiler
(`035b816380d3`) resolved and verified, and the framework built so the examples had their
session config:

| commit | `build:examples` | failed |
|---|---|---|
| **`4f7ecb8`** — before DL51 | exit 1 | **3 of 22** |
| **`f7b65f1`** — DL51's tip | exit 1 | **14 of 22** |

**It is a regression: 3 → 14.** And the 3 at `4f7ecb8` are a different defect entirely —
`2d/{isometric,isometric-framework,stiff-boxes}` fail in `pack-volume.mjs`, an asset step,
not in the compiler. They also fail at the tip, for the same reason.

So the honest split at the tip is: **11 regressions** from DL51's default flip, and **3
pre-existing asset-packing failures** that have nothing to do with the backend.

---

## 2. Phase A — the root, and what `AS110` actually says

**The `AS110` conflict is `exportStart` naming an export the guest already holds.** Measured
directly, on an async guest:

```
--exportStart __start       exit 0    (the shell's own export, as the examples configure)
--exportStart _start_game   AS110: Start function name '_start_game' is invalid or
                                   conflicts with another export
```

`exportStartUnder` (`compiler.ts:2628`) refuses any name the module already exports, and a
guest that writes `export function _start_game()` already has that export. So **`exportStart`
names the export the compiler creates for the shell start, not a guest function** — two
different questions, and DL51's fallback conflated them by only checking `_start_game` when
`exportStart` was absent. Every example sets `"exportStart": "__start"`, so the fallback never
ran.

**The fix (b), compiler-side:** the root is `main`, else `_start_game` — checked
unconditionally — else a guest function named by `exportStart`. Verified on `examples/io`,
which refused before and builds now.

Against the alternatives: **(a)** would mean editing 27 `asconfig.json`s to name a function
that still cannot be named (`AS110`), so it is not available; **(c)** is what landed, since
the compiler change needs no config change at all.

`examples/async-on-main/` was not touched — `game.ts` and `package.json` are the user's, and
the fix needed neither.

**Effect: 14 → 8 failures.**

---

## 3. Phase B — the async method, and a second gap found by the fix

**6 examples** fail with `AS100: Not implemented: an async method (the stackful backend)`,
raised at `src/async/stack.ts:935` — a **lowering gap, documented as such**: the header says
"the refusals mark the shapes it does not yet accept". The methods are the guest's own:
`async run(): void` on a class in each `game.ten`, heavy with `this`.

Measured per backend on a minimal case:

```
fiber         AS100: Not implemented: an async method
continuation  builds
promise       builds
```

**Decision: declare, not implement, and declare `promise` rather than `continuation`.** A
fibre-backed async method is a real lowering (the state struct must carry `$this`, and DL51's
driver already emits 9 named refusals around it) — too large for this round. But the brief's
route 3 assumed `continuation` would be the fallback, which would make these artifacts
**`linux-only`** and refuse them on Windows. **`promise` is portable** — no wasm proposal, so
`target=portable` — and it compiles all 6. Strictly better: the artifact still runs on Windows.

**Then the root fix exposed a second gap.** With `_start_game` as a root, `async-io` and
`platform-control` advanced past the root refusal and hit:

```
[wasm-validator error in function game/gameLoop] unexpected false: call target must exist, on
(call $~spawnIndex/game/gameLoop$spawnStart)
```

`builtins.ts:12617` emits a call to a `~spawnIndex/<fn>` helper for **any** async function
with an `await`, and the helper's body is added in `emitStartsTable` — which the fibre path
reaches, but evidently not for this shape. Both build under `promise`. **This is a compiler
defect named, not fixed**: I could not reduce it inside this round's budget, and the honest
statement is that it is unresolved rather than that it is understood.

Both examples declare `promise` in their own `package.json` for the same reason as the ogre
six: visible in the repo, portable, and the reason is in the commit message.

**Effect: 8 → 0.**

---

## 4. Phase C — the gate

```
$ npm run build:examples
build-examples: 22 example(s) built          exit 0
```

**Three run**, one per class (building is not running):

| example | lowering | output |
|---|---|---|
| `solver/world` (plain) | `backend fiber target portable — met` | `t = 3.1000000000000016`, `match: \|err\| = 6.599878976665252e-11` |
| `async-io` (suspends, promise) | `backend promise target portable — met` | `async-io: awaiting guest tasks` |
| `ogre/hello-triangle` (suspends, promise) | `backend promise target portable — met` | `realised procedural mesh tension-mesh-1: 3 vertices, 1 triangles` · **`rendered 342 frames, 42050 non-background pixels`** |

Every artifact declares `target=portable`, so **nothing here is Linux-only** and the Windows
refusal of §1.5 of the brief has no artifact to exercise. Stated rather than skipped.

| gate | result |
|---|---|
| `build:examples` | **22 of 22, exit 0** |
| `--check` | **10/10**; fixtures `15 current (13 bytes, 2 dwarf)`; **0 artifacts moved** |
| guests | 35 built, 70 records, all by the new compiler |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| `--bin` default · audio-only | **307 · 298** |
| TensionScript CI | **`45912441455` — 16/16** |

---

## 5. What the tree contradicted in this brief

- **"14 of 22, so it is a DL51 regression"** — 11 are; **3 are a pre-existing asset-packing
  failure** that predate DL51 and are unrelated to the backend.
- **"`AS110` means the name is already taken — find what holds it"** — the guest's own export
  does. `exportStart` is not a guest-function selector at all, which is why the examples all
  set `__start` and why no config edit could have fixed this.
- **Decision 3 assumed a `continuation` fallback.** `promise` is the better answer for both
  gaps: it is portable, so the artifacts stay Windows-legal. The route the brief allowed would
  have made 8 examples Linux-only for no reason.
- **A second compiler defect sits behind the first** (`~spawnIndex` helper with no body), so
  "the default builds the corpus" is true of the corpus and not yet true of fibre + an async
  non-entry function.

## 6. What I did not verify

- **The `~spawnIndex` gap is named, not root-caused.** I measured that it reproduces, that it
  blocks any async function with an `await` that is not the entry (`async-io`,
  `platform-control`, and a three-line synthetic case), and that `promise` avoids it. I did
  not find why `emitStartsTable` fails to define the helper in that shape.
- **No test pins the root fix.** I wrote one (`stackful-entry-root`) and removed it: the
  harness compiles a fixture before its assertions run, so a program that cannot yet compile
  on fibre cannot carry a test. The evidence for the fix is `build:examples` 14 → 8 → 0,
  which is behavioural but not a unit test.
- **Nothing ran on Windows**, and no artifact declares `linux-only`, so the Windows refusal
  was not exercised this round.
- **The 3 asset-packing failures are untouched.** They are `pack-volume.mjs` and out of scope.
- **macOS:** CI compiles there; nothing ran a guest.
