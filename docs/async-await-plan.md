# Async/await in the Tension AssemblyScript fork — PLAN

Status: **proposal, not yet reviewed.** No code has been written. No submodule has
been added. This document is the deliverable of the plan phase.

Date of evidence: 2026-10-15. Every "verified" claim below carries the command or
URL that produced it, so a reviewer can re-run it rather than trust it.

---

## 0. Headline findings — four premises in the brief are wrong

The brief is directionally right about the problem. Four of its specific claims
do not match the code or the world, and three of them change the design.

**F1. There is no `_tension_event` export. It does not exist.**
A case-sensitive search for `tension_event` across the tree returns zero hits in
Tension's own sources (`grep -rn "tension_event\|_tension_event" . --exclude-dir=node_modules`
— the only matches are inside `.codewhale/state/`, i.e. my own agent transcripts).
The host does **not** call a guest export to deliver events. It resolves the
guest's exported `table` and calls **function-table indices** carried in a
`Callbacks` record:

- `tension-core/src/session/mod.rs:1233` — `caller.get_export("table")`
- 2 slots only: `onBatch: (i32,i32,i32)->i32`, `onEvent: (i32,i32)->i32`
  (`tension-framework/assembly/runtime/callbacks.ts:26,28`)
- `CALLBACK_SLOTS = 2` (`tension-core/src/session/arena.rs:197`), validated at
  open; `slotCount > 2` is refused.
- The only guest symbols the host ever looks up: `table`, `__start`,
  `_start_game` / `_start` (`tension-core/src/main.rs:1117,1226`).

**Consequence:** there is no free "call any guest function" channel. The async
runtime must ride **inside** the two existing callback slots, or it does not ride
at all. This is a constraint on the design, not a detail.

**F2. There is no host worker pool.** Jobs are a stub.
`REGION_JOB` exists as an arena region kind 3 (`arena.rs:295`), `JOB_SIZE = 48 KiB`
(`arena.rs:341`), and two event classes exist — `CLASS_JOB_FAILED = 1` (MODE_DIRECT)
and `CLASS_JOB_DONE = 4` (MODE_BATCHED) (`arena.rs:203,208,252,255`). The
completion path is wired: `--post-test-events` posts three JOB_DONE records
through the posting face before the guest runs (`main.rs:1191-1216`). But job
*submission* does not exist: `apply::sweep_jobs_to_failed` is a stub with an
`apply` phase that is documented as "**Not implemented in A2b**: the call site
exists and the pending list is always empty" (`epoch.rs:23-26`,
`apply.rs:263`). The only real worker thread in the tree is capability-owned
inside the OGRE DSO.

**Consequence:** `await`-on-a-host-job has no job to await yet. Milestone 1 must
therefore prove suspend/resume against host-*posted* events (which do work
today), and job submission becomes its own milestone rather than an assumption.

**F3. The fork is currently byte-identical to upstream — it has zero commits.**
`git clone https://github.com/Yabgu/assemblyscript.git` followed by
`git fetch https://github.com/AssemblyScript/assemblyscript.git main` gives
`git rev-list --left-right --count FETCH_HEAD...HEAD` → **`0  0`**, both resolving
to `b6bda05c29c9eb7d07d7f6cb2703508483b30493` ("chore: Update Binaryen and other
dependencies (#3035)", 2026-07-21). There are no fork branches, no fork tags, no
fork-only commits.

**Consequence:** there is nothing to rebase *yet*, and there is no existing
async work to build on. The rebase-burden question (§4) is therefore a forecast,
not a measurement — and it is a forecast about how much *upstream* moves, which
turns out to be very little.

**F4. `_start_game` is not a loop, and the host does not drive frames.**
The host calls `_start_game` **once** (`main.rs:1226`) and returns. The frame
loop is guest-authored: `while (...) { RuntimeSession.wait(16); ... }`
(`tension-framework/assembly/runtime/index.ts:6-13` documents the intended shape;
`examples/ogre/bouncing-ball/game.ts` `simulate()` is a live instance).

**Consequence — this is the good news.** A pull-dominant guest-owned loop is
exactly the shape a state-machine scheduler wants. The async driver is a guest
loop primitive, not a host architecture change. The brief's framing ("the thread
pool forces a suspension model on the guest") is right, but the host already
handed the guest the loop that makes it tractable.

**Also confirmed, and load-bearing for the design:** the session **cannot be
re-entered** from inside a callback. `run_epoch_verb` takes the session *out* of
the store (`session/mod.rs`, `caller.data_mut().session.take()`), so a nested
`wait`/`drain`/`close`/`open` from inside `onBatch`/`onEvent` finds no session and
returns `-EBADF`; the verbs that do not take it out (`subscribe`, `unsubscribe`,
`pending`) hit an explicit depth guard returning `-EBUSY`
(`session/mod.rs:1346-1350`, `EBUSY = -16` at `session/mod.rs:78`,
`EINVAL = -22`, `ENOSPC = -28`).

**Consequence:** a resumed task **must not** be resumed inside the callback.
Wakeups are recorded in the callback and executed after it returns, in the
guest's own loop. This mirrors the host's own publish/invoke/apply split, and it
is a hard design rule rather than a preference.

---

## 1. Fork architecture — what is where

Inspected at `/tmp/as-inspect/assemblyscript` (clone of the fork, built
successfully: `npm ci` then `npm run build`, which emits `dist/asc.js` in ~7 s).

| Concern | Location | Size |
|---|---|---|
| Parser | `src/parser.ts` | 4,642 lines |
| Tokenizer | `src/tokenizer.ts` | includes the keyword table |
| AST | `src/ast.ts` | 2,451 lines |
| Program / program-level state | `src/program.ts` | 5,155 lines |
| Resolver | `src/resolver.ts` | 3,771 lines |
| Codegen to Binaryen | `src/compiler.ts` | 10,727 lines |
| Builtins | `src/builtins.ts` | 11,394 lines |
| Binaryen binding | `src/bindings/`, `src/module.ts`, `lib/binaryen.js` | — |
| Standard library | `std/assembly/**` (`rt.ts`, `rt/`, `string.ts`, `map.ts`, …) | — |
| Custom Binaryen passes | `src/passes/{pass,shadowstack,ministack,rtrace}.ts` | — |
| **Transform plugin (public)** | `Transform` at `cli/index.d.ts:247`; `--transform` in `cli/options.json` | — |
| CLI | `cli/index.js` (no `src/cli/`) | — |

### Extension points, ranked by invasiveness

**E1 — `--transform` (fully additive, supported, documented).**
`cli/options.json`: `"transform": { "category": "API", "description": "Specifies
the path to a custom transform to load.", "type": "S", "isPath": true,
"useNodeResolution": true }`. The abstract class (`cli/index.d.ts:247`) exposes:

```
afterParse?(parser: Parser): void | Promise<void>
afterInitialize?(program: Program): void | Promise<void>
afterCompile?(module: binaryen.Module): void | Promise<void>
readonly program, binaryen, baseDir, stdout, stderr, log, readFile, writeFile, listFiles
```

Plus `Transform` re-exports the whole compiler front-end for node construction:
`src/index-js.ts` re-exports `./ast`, `./common`, `./compiler`, `./flow`,
`./module`, `./parser`, `./program`, `./resolver`, `./tokenizer`, `./types`, and
`./extra/ast` — so a transform can build AST nodes (`Node.createFunctionDeclaration`,
`Node.createFunctionExpression`, `Node.createBlockStatement`, …) and replace them.

The hook lands at exactly the right place: `cli/index.js:697` runs
`afterParse` **after parsing the entry files and before `initialize`**, i.e.
before resolution and long before codegen. A transform can therefore replace
`__await(x)` with lifted-state machinery while the tree is still unresolved.

**E2 — custom Binaryen pass registered in `compiler.ts`.** There is precedent:
`compiler.ts:765-769` runs `this.shadowStack.walkModule()` and
`new RtraceMemory(this).walkModule()`, gated by `options.stackSize > 0`
(`:540`) and by a `--use ASC_RTRACE=1` define respectively. `Pass extends
Visitor` (`src/passes/pass.ts:1238`) walks functions/globals and rewrites
Binaryen IR. This gives a **second, lower-level** place to work, but requires
editing `compiler.ts` to register it → drift.

**E3 — `src/builtins.ts`.** Builtins are `Map<string, handler>` registrations
(`builtins.ts:824-831`) resolved by name. A pure builtin can implement runtime
operations without parser changes, but cannot *transform control flow*, so it
cannot implement `await` by itself.

**Key structural discovery: `async` and `await` are already reserved tokens with
no consumer.** The token enum declares them (`src/tokenizer.ts:48-49`:
`Async,` / `Await, // ES2017`), and `tokenizer.ts:191-192` maps the keywords to
those tokens — but **nothing in `parser.ts` or `compiler.ts` ever handles
`Token.Async` or `Token.Await`**: `grep -rn "Token.Async\|Token.Await" src/`
returns only those two tokenizer lines. They are dead keywords that currently
produce parse errors. (For contrast, `yield` is similarly reserved
(`tokenizer.ts:107`) and *does* have a parser hook — `parser.ts:3701` routes
`Token.Yield` into the unsupported-unary expression path, and
`parser.ts:4535` reserves a `Precedence.Yield` slot. So the two of the three
ES2017 keywords that matter here were reserved and then never wired up.)

Empirically (`node bin/asc.js <file> --noEmit`, upstream `main`, built locally):

```
async function job(): i32 { return 1; }   → ERROR TS1109: Expression expected.
let x = await(hostJob());                 → ERROR TS1109: Expression expected.
let x = await hostJob();                  → ERROR TS1109: Expression expected.
let await = 5;                            → ERROR TS1003: Identifier expected.
@async function g(): i32 { return 1; }    → ERROR TS1003: Identifier expected.
```

But an **identifier** marker parses fine and fails only at name resolution:

```
let x = __await(hostJob());               → ERROR TS2304: Cannot find name '__await'.
```

That distinction is the whole basis of the additive strategy in §2.

### Closures: confirmed absent, and the failure is explicit

```
let x: i32 = 1; let f = (): i32 => x + 1;  → ERROR AS100: Not implemented: Closures
let x: i32 = 41; return (): i32 => x + 1;  → ERROR AS100: Not implemented: Closures
```

Non-capturing function *values* do work (they lower to table indices), which is
precisely how the existing `onBatch`/`onEvent` callbacks are passed
(`tension-framework/assembly/runtime/callbacks.ts:21-23`).

**`try`/`catch` is also unimplemented upstream:**

```
try { throw new Error("boom"); } catch (e) { ... }  → ERROR AS100: Not implemented: Exceptions
```

and there is no `--enable exceptions` flag to unlock it (the features list is
`threads, simd, reference-types, gc, …`). This matters because a rejected
`await` has no exception to throw. See §2.3.

### `@btc-vision/assemblyscript` — assessed, not adopted

- npm: `@btc-vision/assemblyscript`, latest `0.29.3`, 6 versions, modified
  2026-03-08. It is a rebase of upstream onto a `v0.29` line — its commit list
  is upstream's own commits plus a handful of "Bump version" / "Add std assembly
  utilities" commits.
- Its GitHub repo carries the branches that matter: `closures`,
  `closures-pr`, `closure-pr`, `hybrid-closure-approch`,
  `experimental-try-catch-finally`, `try-catch`. So the closures + try-catch work
  is real and is the reference implementation for the question the brief raises.

**Verdict: do not depend on it; mine it.** Reasons: (a) depending on it means
depending on a third-party rebase of a moving upstream, which *adds* a rebase
burden rather than removing one; (b) the async lowering does not need user-level
closures (§2.3); (c) it is on a different version line (0.29 vs the fork's
upstream 0.28.x-era `main`). It stays valuable as prior art for the day a real
`Promise`-shaped API is wanted.

---

## 2. The lowering decision

### 2.1 Two-pass (TS-style) vs direct async→state-machine

**TypeScript's shape:** `async` → generator (`__awaiter`/`__generator`), then
generator → state machine in a second pass. The intermediate representation is
a *generator object* with `next`/`throw`/`return`.

**Decision: direct async → state machine. One pass. No intermediate generator
representation.**

Justification:

1. **The intermediate form buys nothing here.** TS's two passes exist because it
   must also support *real generators* as a language feature, and because the
   async transform predates generators being reliably downlevelable. AS has no
   generators — `Token.Yield` exists (`tokenizer.ts:107,349`) but
   `parser.ts:3699-3701` explicitly lists `YieldExpression` as a TODO that falls
   through to "unsupported". So a generator IR would be invented *purely* to be
   immediately destroyed, and would have to be defined, resolved, typed, and
   codegen'd — i.e. we would build the expensive half of a feature we then throw
   away.
2. **The target is one known driver.** The generator object's `next()` protocol
   exists to serve an arbitrary resumption policy. Tension has exactly one
   scheduler and one resume point per task. A direct state machine is the same
   lowering minus a protocol layer.
3. **It matches the reference implementations the brief names.** Babel's
   `transform-async-to-generator` without a generator representation is the
   direct form; so are C# and Rust's async lowering.

**Where the pass runs — and this is the decision that keeps the fork thin:**
the transform runs at **`afterParse`** (E1), operating on the **AST**, not at
`afterCompile` on Binaryen IR. Rationale: lifting locals requires *typed* local
declarations and stable name resolution; at Binaryen level you are reconstructing
type information that the compiler already had and discarded. `afterParse` runs
before `initialize`/resolution (`cli/index.js:697`), so the tree is still
name-unresolved — which is what lets the marker `__await` be replaced *before*
it is resolved and reported missing. The transform must therefore produce nodes
that resolve cleanly, and must not depend on resolved types; where a type is
needed it is taken from the syntactic annotation.

A Binaryen-level fallback (E2) is kept in reserve but is **not** the plan; it
would force a `compiler.ts` edit anyway, so it is strictly worse on the drift
axis.

### 2.2 The state-machine shape (what the pass emits)

For an async function, the pass emits:

1. **A state struct** — one field per local that is live across an `await`
   (lifted locals), one field per parameter that is read after an `await`, plus
   `resumePoint: u32` and `status: u32`. This *replaces* TS's closure over
   `this`/`arguments`/lifted locals. There is no `this` to capture: AS is not
   class-method-centric in the lowering, and `arguments` does not exist as an
   object in AS — parameters are lifted explicitly.
2. **A resumable entry function** taking a pointer to the state struct,
   beginning with a `switch (state.resumePoint)` dispatch whose cases are the
   original basic blocks, re-entered at each `await`.
3. **A driver-side descriptor** registering the task with the runtime: state
   pointer, resume function (a table index), and the awaitable it is blocked on.

Crucially the state struct is a **plain AS class/struct allocated by the
runtime**, not a language closure. Nothing in the generated code needs captures.

### 2.3 Closures: what the API surface may be, given no closures

The brief's closure question splits into two layers, and the answer differs.

**Generated-code layer — no closures needed.** The compiler lifts locals into the
explicit state struct. Confirmed feasible: AS supports ordinary heap-allocated
classes with `@unmanaged` records (the framework already does this in
`callbacks.ts` / `wire.ts`).

**User-facing layer — this is the real decision.**

Rejected: `new Promise(resolve => …)`. The executor callback must capture
`resolve` and often outer locals → requires closures → requires the compiler to
synthesize functor objects (Java/C++ style captures). Not available upstream, and
adopting btc-vision's closures to get it means adopting a third-party rebase.
**Rejected.**

Rejected: `.then(cb)` with a capturing `cb` — same reason. `.then(cb)` with a
*non-capturing* `cb` is technically possible (table index + an unmanaged context
pointer), but it is a callback-passing style the compiler cannot type-check
usefully, and it re-introduces the manual-continuation problem the whole exercise
exists to remove. **Rejected as the primary API.**

**Decision — the minimum API surface is: `await` and nothing else.** There is no
`Promise` type in the user-facing language. An awaitable is a **framework-provided
handle** (a concrete AS class) that the runtime knows how to subscribe to. The
user writes:

```ts
const frame = await nextFrame();          // frame boundary
const mesh  = await loadMesh("bunny");    // resource load
const done  = await physics.step(dt);     // solver job
```

The runtime — not the user — maps each handle to the event class it completes
on, and the driver resumes the task when that class delivers. Because the handle
is a concrete class and the subscription is runtime state, **no user callback and
no user closure is ever required.**

Error propagation without exceptions (since `try`/`catch` is unavailable): an
awaitable carries an explicit error field, and `await` returns a result whose
error case the caller *checks* rather than catches. This is a deliberate,
honest choice: with no exceptions in the language, any design that *looks* like
rejection-throwing would be a fiction. A `Status`-checked API is uglier and
truthful. (If btc-vision's `try-catch` ever merges upstream, the surface can grow
a `try { await x } catch` form without changing the lowering — the state struct
already carries a status field.)

### 2.4 Syntax: additive marker now, reserved-word syntax as a flagged second step

Because `async`/`await` currently produce *parse errors*, and `afterParse` only
runs after parsing succeeds (`cli/index.js:693-700`: `parseBacklog()` returns
early on error, **before** the hook), an AST-level transform cannot be reached
using the real keywords. Two options:

- **Option A (additive, recommended for M1): `__await(expr)` marker.**
  Parses today as an ordinary call (verified: only fails as an unresolved name,
  which never happens because the transform replaces the node first). Zero
  edits to `parser.ts`, `ast.ts`, `tokenizer.ts`, `compiler.ts`. The flag is
  `--transform <path>`, already supported.
- **Option B (drift, M2): real `async`/`await` syntax.** Requires editing
  `parser.ts` to accept an `isAsync` modifier on function declarations and
  `await` as a unary-prefix expression, plus a flag field on the AST node.
  Estimated 30–60 lines across `parser.ts` + `ast.ts`. **This is hard fork
  drift** and is flagged as such in §5.

The plan does A first and treats B as a separately-reviewable change, so that the
expensive-to-rebase part is not on the critical path to a working prototype.

---

## 3. The runtime and the host ABI

### 3.1 Design rule derived from the code

The session is not reentrant (F3/§0). Therefore:

> **A callback records a wakeup; it never resumes a task.**
> Resumption happens after the callback has returned, in the guest's loop.

This is not a workaround; it is the same discipline the host itself uses
(publish → invoke → apply, `epoch.rs:1-26`).

### 3.2 The ABI — what is new, and what is reused

**Nothing new crosses the host boundary.** The async runtime introduces **zero**
new host imports and **zero** new guest exports:

- **Guest → host:** unchanged. The seven `session::*` verbs plus the arena
  `memory` import remain the entire surface. The `session` module is *reserved*
  to the core (`adapter/mod.rs:82`, refused at registration `:873`), so no adapter
  can even add to it.
- **Host → guest:** unchanged. The host still resolves `table` and calls the
  `onBatch`/`onEvent` slots from the `Callbacks` record. The async dispatcher is
  installed *as* the guest's `onEvent`/`onBatch` implementation — the framework's
  existing callback body gains a dispatch step:

```ts
// tension-framework: the existing callback slot, extended (additive)
function onBatch(cls: u32, ptr: u32, count: u32): i32 {
  frameworkDispatch(cls, ptr, count);   // existing behaviour
  asyncRuntime.noteDelivery(cls, ptr, count);  // records wakeups ONLY
  return 0;
}
```

- **The guest's loop** gains one call after `wait` returns:

```ts
while (!done) {
  const delivered = RuntimeSession.wait(-1);
  asyncRuntime.runReady();     // resumes tasks woken by this epoch
}
```

**Why this composes cleanly:** the host's epoch already guarantees "publish
everything, then invoke" (`epoch.rs` phases 1–2), so by the time `wait` returns
to the guest, every record for this epoch is in the ring and every wakeup is
recorded. `runReady()` then runs with the session idle, free to call verbs.

### 3.3 Class assignment (frozen today, reused rather than extended)

`CLASS_COUNT = 10`, ids 0–9, urgent-first (`arena.rs:202-218`). Async maps onto
existing classes only:

- `CLASS_JOB_DONE = 4` (MODE_BATCHED) → job completion.
- `CLASS_JOB_FAILED = 1` (MODE_DIRECT) → job failure.
- `CLASS_RESOURCE_READY = 5`, `CLASS_FRAME = 9` → `await loadMesh(...)`,
  `await nextFrame()`.

**Decision: add no class.** Class ids are a frozen ABI; consuming the existing
ones keeps the host untouched and keeps the change additive on the host side
too. If a future awaitable needs its own class, that is a host-side ABI change
and gets its own review.

### 3.4 The gap this plan does not paper over

`await` on a host job requires a way to **submit** a job. That does not exist
(F2). Milestone 1 therefore validates suspend/resume against events the host
*posts* (the `--post-test-events` mechanism, `main.rs:1191`, needs only a
timing/threading variant for a genuine suspend test), and job submission is
scheduled as its own milestone against the `REGION_JOB` / pending-apply design
(`apply.rs:263` is the stub to fill).

This is the single largest piece of unscoped work in the whole plan, and it is
**host-side, not compiler-side**.

---

## 4. Rebase burden

Method: fork cloned, upstream fetched, history measured directly.

```
git for-each-ref --sort=-creatordate --format='%(creatordate:short) %(refname:short)' refs/tags
git log --oneline --since='2 years ago' -- <path> | wc -l
git log --since='2 years ago' --numstat --format='' -- <path> | awk '{a+=$1;d+=$2} END {print a,d}'
```

**Upstream velocity is low and falling.**

| Year | Commits |
|---|---|
| 2023 | 77 |
| 2024 | 23 |
| 2025 | 32 |
| 2026 (to 2026-07-21) | 22 |

30 commits repo-wide in the last 12 months. `main`'s newest commit is
`b6bda05c` (2026-07-21) — roughly three months of silence before today.

**Releases are frequent even when `main` is quiet** (auto-cut per merge by
`github-actions[bot]`): **12 releases in the last 12 months, 28 in the last 24**,
median gap **10 days**, largest gap **144 days**. Latest `v0.28.20` (2026-07-21),
and the npm `latest` tag agrees.

**Churn in exactly the surfaces we would touch, last 2 years:**

| Path | Commits | Line churn |
|---|---|---|
| `src/parser.ts` | 1 | +56 / −1 |
| `src/tokenizer.ts` | 0 | +0 / −0 |
| `src/ast.ts` | 2 | +33 / −2 |
| `src/compiler.ts` | 17 | +366 / −148 |
| `src/resolver.ts` | 7 | — |
| `src/passes/pass.ts` | 1 | +15 / −141 |
| `cli/index.js` | 3 | +11 / −10 |
| `cli/options.json` | 0 | +0 / −0 |
| `std/assembly/**` | 9 | — |

Total across all paths in 2 years: 60 commits.

**Estimate.**

- **Additive path (Option A — new files + `--transform` + framework runtime,
  no core edits): ~0–2 hours of rebase work per year.** Our code lives in new
  files and in `tension-framework/`; upstream's changes to `src/*` cannot
  conflict with files we never touch. The realistic cost is *breakage*, not
  conflicts: a `Transform` base-class change or a `Node.create*` signature change
  would need a fixup. Observed rate for those surfaces: 1 commit touching
  `pass.ts` in 2 years, 3 touching `cli/index.js`.
- **With the syntax patch (Option B — `parser.ts` + `ast.ts`): add ~0.5–1 day per
  year**, concentrated in whichever release touches `parseFunction` /
  `parseUnaryExpression`. Expected conflict frequency is low (1 commit to
  `parser.ts` in 2 years) but nonzero, and each is a hand-merge, not a
  mechanical one.
- **Worst case, stated honestly:** the +366/−148 on `compiler.ts` in 2 years
  shows that when upstream *does* move the compiler core, it moves in bulk. If we
  were modifying `compiler.ts` rather than extending it, a single bad release
  could cost days. This is the strongest argument in the document for staying
  additive.

---

## 5. Hard fork drift ledger

Per the constraint, anything touching AS core is flagged and justified.

| # | Change | File(s) | Drift? | Justification |
|---|---|---|---|---|
| 1 | Async lowering pass (new file) | `src/passes/asyncify.ts` or a standalone transform package | **No** | New file; additive. |
| 2 | Transform entry point | new file, loaded via `--transform` | **No** | Public supported hook (`cli/options.json`). |
| 3 | Runtime package | `tension-framework/assembly/runtime/async.ts` | **No** | Lives in Tension, not AS. |
| 4 | Guest loop + callback extension | `tension-framework/assembly/runtime/index.ts`, `callbacks.ts` | **No** | Tension's own code. |
| 5 | Real `async`/`await` keywords (M2) | `src/parser.ts`, `src/ast.ts` | **YES — hard fork drift** | Unavoidable *if* the keywords are wanted: the tokenizer emits `Token.Async`/`Token.Await` but nothing consumes them, and `afterParse` never runs for a file that fails to parse. ~30–60 lines. Deliberately deferred to its own reviewable step. |

**No `compiler.ts` edit is planned.** If the `afterParse` route proves unable to
reach something (e.g. a construct the resolver rejects before the transform can
replace it), the fallback is an `afterCompile` Binaryen pass — which *does*
require a `compiler.ts` registration edit — and that escalation will come back for
review rather than being taken silently.

---

## 6. Repository integration — one conflict with project law to resolve

**`AGENTS.md` rule 1: "`third_party/` is read-only. Never edit, generate into,
format, or delete anything under it — including its build trees."**

Adding the submodule is what the task asks for, but *building* AssemblyScript
requires `npm ci`, which writes `node_modules/` **inside** the checkout — i.e.
generates into `third_party/`. That is a direct conflict with rule 1.

**Recommended resolution (needs your approval, since it touches a hard rule):**

- The submodule at `third_party/assemblyscript` holds **source only**, never
  built in place, never hand-edited.
- The build happens out-of-tree in `build/assemblyscript/` (`build/` is already
  `.gitignore`d) — a scratch copy or `git worktree` of the submodule, where
  `npm ci && npm run build` is free to write. Measured: ~7 s to build.
- Tension's examples consume the built `asc` from `build/assemblyscript/dist/`.

This keeps the rule's spirit (vendored source is never mutated) while making the
fork buildable. The alternative — carving out an explicit exception for
`third_party/assemblyscript/` — is simpler to explain but weakens the rule for
every future reader.

**Exact commands, held pending review (not executed):**

```
git submodule add https://github.com/Yabgu/assemblyscript.git third_party/assemblyscript
git submodule update --init --recursive third_party/assemblyscript
# upstream stays addressable as a remote for rebasing:
cd third_party/assemblyscript && git remote add upstream https://github.com/AssemblyScript/assemblyscript.git
```

---

## 7. Dependency graph

```
                        ┌───────────────────────────────────────────┐
   M0  fork submodule ──▶│ third_party/assemblyscript on a branch   │
       (§6, needs your   │ "tension/async" with upstream as remote  │
        ruling on rule 1)└────────────────┬──────────────────────────┘
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
        ┌────────────────────────┐              ┌────────────────────────────┐
   M1a  │ out-of-tree AS build   │              │ async runtime package      │
        │ build/assemblyscript/  │              │ tension-framework/         │
        │ asc + npm run build    │              │ assembly/runtime/async.ts  │
        └───────────┬────────────┘              └──────────────┬─────────────┘
                    │                                          │
                    ▼                                          │
        ┌────────────────────────────────┐                     │
   M1b  │ LOWERING PASS (the hard part)  │                     │
        │ afterParse transform:          │                     │
        │ __await(x) → state struct +    │                     │
        │ resume fn + registration       │                     │
        └───────────┬────────────────────┘                     │
                    │                                          │
                    └──────────────┬───────────────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
               M1c  │ HARNESS: guest awaits a      │
                    │ host-posted JOB_DONE, host   │
                    │ asserts suspend/resume order │
                    └──────────────┬───────────────┘
                                   │  (proof the machinery works)
                                   ▼
        ┌────────────────────────────────────────────────────┐
   M2   │ JOB SUBMISSION (host-side, unscoped today)         │
        │ REGION_JOB + pending/apply; apply.rs:263 is a stub │
        │ → this is what makes `await job(...)` real         │
        └───────────┬────────────────────────────────────────┘
                    ▼
        ┌────────────────────────────────────────────────────┐
   M3   │ Ergonomics: real async/await keywords              │
        │ parser.ts + ast.ts → HARD FORK DRIFT, own review   │
        └───────────┬────────────────────────────────────────┘
                    ▼
        ┌────────────────────────────────────────────────────┐
   M4   │ WasmFX: swap the lowering behind the same surface  │
        │ gated on upstream reaching Windows + stability     │
        └────────────────────────────────────────────────────┘
```

**Blocking summary:**

- M0 blocks everything.
- M1a blocks M1b (need a compiler to test against).
- M1b and the runtime are independent of each other and can proceed in parallel;
  M1c needs both.
- M2 is independent of M1b/M1c in principle, but M1c produces the test that M2
  will need.
- M3 depends on M1b being correct (do not add syntax for a broken lowering).
- M4 depends on nothing here except time and upstream; it is deliberately last.

---

## 8. Decision list

### D1 — Two-pass vs direct lowering
**Decision: direct async → state machine, one pass.**
- *Direct:* matches Babel-without-generators, C#, Rust. No invented IR. Fewer
  moving parts. Requires getting the state struct's liveness right ourselves.
- *Two-pass:* matches TS exactly; reuses a familiar mental model. **Cost:** must
  define, resolve, type and codegen a generator representation whose only
  consumer is the pass that immediately consumes it — in a language that has no
  generators at all.
- **Why:** the generator IR is pure overhead when the language lacks the feature
  it represents.

### D2 — AST-level (`afterParse`) vs Binaryen-level (`afterCompile`) lowering
**Decision: AST-level via the public `--transform` hook.**
- *AST:* additive, no core edit, types/annotations still present, unresolved
  names replaceable.
- *Binaryen:* more control over final IR; **requires a `compiler.ts` edit** to
  register the pass → drift.
- **Why:** the drift axis decides it.

### D3 — Closures vs explicit state struct
**Decision: explicit state struct. No closures, at either layer.**
- *State struct:* the compiler lifts locals into a heap record; no language
  feature required; verified feasible with existing `@unmanaged`/class support.
- *Closures:* would let us mirror TS's generated code shape and enable a real
  `Promise` type — but is unimplemented (`AS100`) and would mean adopting
  btc-vision's rebase.
- **Why:** the state struct is the *only* option that does not add a language
  feature to the critical path.

### D4 — API surface
**Decision: `await` only. No `Promise`, no `.then`, no `new Promise(executor)`.**
- Awaitables are framework-specific handle classes; the runtime owns the mapping
  from handle → event class. Rejection is an explicit status field, checked by
  the caller, because the language has no exceptions (`AS100: Not implemented:
  Exceptions`) and any rejection-throwing API would be a fiction.
- *Rejected:* `.then(cb)` with capturing callbacks (needs closures);
  `new Promise(r => …)` (needs closures + an executor protocol that maps to
  nothing in this host); `.then(cb)` with non-capturing callbacks only (possible,
  but returns the user to manual continuation-passing — the exact problem being
  solved).
- **Why:** minimum surface that makes game code linear, with zero new language
  features.

### D5 — WasmFX now vs later
**Decision: state machines now; WasmFX later, behind an unchanged surface.**

Verified facts:
- Wasmtime: `Config::wasm_stack_switching` — "This feature is `false` by
  default" (`crates/wasmtime/src/config.rs:1269-1280`). Stability table:
  `stack-switching` = ❌ / 🚧 / 🚧 / ❌ / ❌ / ❌ with footnote *"Currently the
  implementation is only for x86\_64 Linux"* (`docs/stability-wasm-proposals.md`).
  Tracking issue **#10248 is still open**, listing as *not* in the initial
  implementation: non-x64 ISAs, `resume.throw`, **deallocating continuations**,
  GC integration, **Windows support**, Pulley, Winch.
- **There is no host-facing continuation API.** `StoreOpaque::allocate_continuation`
  exists but the `store` module is `pub(crate)` (`runtime.rs:57`) — so an embedder
  cannot create or resume continuations from Rust today. The only external
  surface is wasm-level imports, as wasmtime's own test does by importing
  `resume`/`suspend` across instances (`tests/all/stack_switching.rs:273-341`).
- **Tension's host is Windows-first** (`AGENTS.md`: `build.bat`, VS 18, MSYS2
  UCRT64; the release target is `x86_64-windows-msvc`). WasmFX cannot run there.
- Instruction set, from the proposal's own Explainer: `cont.new`, `suspend`,
  `resume`, `switch`, `resume_throw`, plus `cont.bind` for partial application.
  There is no `cont.drop` — deallocation is explicitly deferred by the engine.
- **Scheduler placement:** the scheduler is *outside* the instruction set. The
  Explainer implements it **in wasm** (`$scheduler1`, `$scheduler2`), and the
  bag-of-stacks design notes describe per-arena schedulers with a *tree* of them
  yielding upward to the embedder's event loop ("the primary route by which the
  WebAssembly application as a whole can eventually yield back to the browser's
  event loop", `design-notes/bag-o-stacks/Explainer.md:693`). So "the host can
  own the continuation queue" is a legitimate choice, not something the ISA
  dictates.
- The "unwinding bug" in the brief: I could not substantiate a *currently open*
  unwinding bug. The specific historical issue
  (bytecodealliance/wasmtime#13584, "host-ward unwind after a resume double-frees
  a fiber stack") is **closed**. What is live is broader: open issues #14644 and
  #14509 (fuel accounting lost across stack-switching ops), and a cluster of
  closed crash/ASan/GC bugs through 2026-10. **The correct statement is "actively
  churning and incomplete", not "has a specific open unwinding bug"** — I am
  correcting the brief rather than confirming it.

**Why later:** the migration is cheap *because the ABI is unchanged*. The
lowering is a compile-time choice behind a flag; the guest-visible surface
(awaitables, status, the driver's `runReady()`) and the host surface (event
classes, callbacks, the seven verbs) stay identical. Migration path, concretely:
when Wasmtime's stack-switching reaches Windows and gains deallocation, swap the
pass so `await` emits `(suspend $tension_yield)` instead of a state transition,
and move the resume queue from the guest's `runReady()` to a host-owned
continuation queue. **No host ABI change, no guest API change, no game code
change** — a game compiled either way looks the same at the source level.

- *Rejected middle path — Binaryen Asyncify/Bysyncify:* whole-stack
  unwind/rewind, module-wide instrumentation, overhead proportional to the
  instrumented call graph, and it fights the pass pipeline for a 48 KiB-arena,
  render-thread-bearing engine. It also does not compose with the
  pull-dominant loop any better than the state machine does.

### D6 — Additive fork vs modifying AS core
**Decision: additive. `compiler.ts` is not touched. `parser.ts` is touched only
in M3, flagged, and only for sugar.**
- **Why:** measured churn (§4) shows the additive path costs ~0–2 h/year, while
  editing the parser is a permanent hand-merge tax on a file that upstream has
  rewritten once in two years (+56/−1) — rare, but bulk when it happens.

### D7 — Fork as submodule, upstream as remote
**Decision: `third_party/assemblyscript` = fork; `upstream` remote inside it;
work on a `tension/async` branch.** Matches the brief and the repo's existing
`third_party/ogre-next` convention (`.gitmodules`).
**Blocked on:** the rule-1 conflict in §6.

### D8 — Where the build happens
**Decision: out-of-tree in `build/assemblyscript/`** (already gitignored). Keeps
`third_party/` pristine per AGENTS.md. **Needs your ruling** (§6).

---

## 9. Minimal test harness

Purpose: prove that a guest `await` **actually suspends** — the guest returns to
its loop, other frames happen, and the task resumes later **with its lifted
locals intact**.

### Shape

**Fixture:** `tension-framework/tests/guest-async.ts` (matches the existing
convention: `guest-*.ts` + `run.sh` in `tension-framework/tests/`).

```ts
// M1c fixture — the smallest thing that can be wrong in an interesting way.
import { RuntimeSession, makeCallbacks } from "../assembly/runtime";
import { asyncRuntime } from "../assembly/runtime/async";

let framesWhileSuspended = 0;
let resumeValue: u32 = 0;

async function awaitedTask(): i32 {
  let local: u32 = 41;              // live across the await → must be lifted
  process.stdout.write("A:before\n");
  local = await jobHandle(1);       // ← suspends here
  process.stdout.write("B:after " + local.toString() + "\n");
  return local;                     // 42 iff the local survived
}

export function _start_game(): void {
  asyncRuntime.start(awaitedTask());

  let ticks = 0;
  while (ticks < 200) {
    RuntimeSession.wait(16);
    asyncRuntime.runReady();        // resume point, after the callback returned

    if (asyncRuntime.isSuspended()) framesWhileSuspended++;
    if (asyncRuntime.isFinished()) break;
    ticks++;
  }
  process.stdout.write("C:frames-while-suspended=" + framesWhileSuspended.toString() + "\n");
  process.stdout.write("D:value=" + resumeValue.toString() + "\n");
}
```

**Host side:** a Rust integration test (`tension-core/tests/async_await.rs`,
following the existing `tests/log_guest.rs` / `tests/frame_layout` conventions)
that:
1. compiles the fixture with the fork's `asc` + `--transform`,
2. posts a `JOB_DONE` record on a **separate thread** after a short sleep — so the
   guest is provably inside `wait` when the completion arrives (this is the
   suspend proof; posting before the guest runs, as `--post-test-events` does
   today, would *not* prove it),
3. runs the module under Wasmtime,
4. asserts the transcript.

### Pass criteria — all four must hold

1. **Ordering:** `A:before` appears before `B:after`, and `B:after` appears only
   after the epoch that carried the `JOB_DONE` record.
2. **Real suspension, not a spin:** `frames-while-suspended ≥ 1` — the guest's
   loop advanced at least one tick while the task was parked. (A busy-wait
   implementation would report 0.)
3. **Lifted locals survive:** `D:value=42`, i.e. a local assigned *before* the
   await and read *after* it holds its value. This is the test that catches the
   single most likely lowering bug.
4. **No reentrancy violation:** the run produces no `-EBADF`/`-EBUSY` from a
   session verb, which is what would happen if the runtime resumed the task
   inside the callback (the §3.1 rule).

A **negative control** is part of the harness: a variant that calls
`asyncRuntime.runReady()` *inside* `onEvent` must fail with the reentrancy
refusal — proving the constraint is real and the harness can detect it.

### What this harness deliberately does *not* prove
That a real host job round-trips, because job submission does not exist (F2).
That is M2, and its test is a second fixture once `apply.rs:263` stops being a
stub. **Stated here so the green M1c is not mistaken for a working feature.**

---

## 10. Verification ledger — the four claims checked

| Claim in brief | Verdict | Evidence |
|---|---|---|
| `moonbitlang/async` does not run on Wasmtime (vs. just experimental on Wasm1) | **Partly wrong.** It is not Wasmtime-incompatible — it is not a Wasmtime-*shaped* library at all. Its README states "only supports native/LLVM backends on Linux/MacOS", but it *does* have a wasm1 backend and a nightly wasm test CI job, plus a JavaScript backend integrating with JS Promises. What it has **no concept of** is an embedder-owned host event loop driving task resumption: it ships its own event loop (`src/internal/event_loop/…`) with epoll/kqueue/IOCP/JS-fetch backends. There is no `await`-on-host-job integration point for a Wasmtime embedder. So it *can* run on Wasm1; it simply cannot solve Tension's problem. **Relevant as prior art for the runtime design, not as a dependency.** | `curl raw.githubusercontent.com/moonbitlang/async/main/README.md` (lines 63-78); `.github/workflows/nightly-wasm-test.yml` |
| Wasmtime stack-switching is off by default, with an unwinding bug, as of today | **Off-by-default: confirmed.** `Config::wasm_stack_switching` — "This feature is `false` by default"; stability table ❌/🚧/🚧/❌/❌/❌, "only for x86\_64 Linux"; tracking issue #10248 open, listing Windows support and continuation deallocation as *not* implemented. **Unwinding bug: not substantiated as open.** Issue #13584 (host-ward unwind double-free) is **closed**. Open today: #14644 and #14509 (fuel accounting across stack-switching ops). The accurate characterization is "incomplete, x64-Linux-only, actively churning" — which is *enough* to defer WasmFX, without asserting a specific bug that is not there. | `raw.githubusercontent.com/bytecodealliance/wasmtime/main/crates/wasmtime/src/config.rs:1269-1280`; `docs/stability-wasm-proposals.md`; GitHub API issues #10248, #13584, #14644, #14509 |
| AS issue #376 is still open with no implementation | **Confirmed, with nuance.** `state: open`, `state_reason: null`, created 2018-12-14, last updated **2026-02-03**, 23 comments, labels `enhancement`/`question`, no milestone, no assignee. No PR implements it: repo-wide issue search for `async` in title returns 5 results, only #376 is open, and PR #419 ("Async main and compileString") is a *host-side async `main`* change, closed unmerged. The comments are a design discussion, not an implementation — and they are the source of several ideas the brief echoes (Bysyncify/Asyncify suggested by kripken, state-machine/generator lowering suggested by MaxGraey). | GitHub API `issues/376`, `issues/376/comments`, search `repo:AssemblyScript/assemblyscript async in:title` |
| WasmFX instruction set is `cont.new`, `suspend`, `resume`, `switch`; scheduler host or guest | **Instruction set confirmed and extended:** `cont.new`, `suspend`, `resume`, `switch`, `resume_throw`, plus `cont.bind` (partial application). **No `cont.drop`** — the Explainer has zero occurrences; deallocation is deferred by the engine, and wasmtime #10248 lists "Support for deallocating continuations" as out of the initial implementation. **Scheduler: outside the instruction set, and the proposal's reference schedulers are written *in wasm*.** Bag-of-stacks design notes describe per-arena schedulers in a *tree*, each yielding to its parent, with the root yielding to the embedder's event loop. A host-owned continuation queue is therefore permitted but not mandated. The proposed type math (`cont.new $ct : [(ref null $ft)] -> [(ref $ct)]`, line 546) confirms one-shot continuations. | `raw.githubusercontent.com/WebAssembly/stack-switching/main/proposals/stack-switching/Explainer.md`; `.../design-notes/bag-o-stacks/Explainer.md:693` |

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The `afterParse` hook is a *less* capable surface than it looks — it runs before resolution, so the pass cannot rely on resolved types | High | M1b spike proves it on one function before the design is committed. Fallback: `afterCompile` Binaryen pass, at the cost of one `compiler.ts` edit (escalate for review). |
| Liveness analysis for lifted locals is the real engineering risk, not the syntax | High | The harness's assertion 3 (local assigned before await, read after) targets exactly this. Start with a conservative rule (lift every local live at any await) and tighten later. |
| Job submission (M2) is unscoped host work and could be much larger than the compiler work | High | Kept as its own milestone with its own review. M1c is designed to be valuable without it. |
| AGENTS.md rule 1 vs building the fork in `third_party/` | Medium | Out-of-tree build (§6); **explicit ruling requested**. |
| Upstream rewrites `parser.ts` in bulk (it did +56/−1 in 2 years — rare, but `compiler.ts` moved +366/−148) | Medium | Additive strategy (§4); syntax patch isolated to M3. |
| Wasmtime's stack-switching lands Windows support and stabilizes sooner than expected, making M1–M3 partially wasted | Low | The guest surface is deliberately lowering-agnostic; only the pass and the resume queue move (D5). |
| A future awaitable needs a new event class, which *is* a host ABI change | Low | Explicitly out of scope; mapped onto existing classes 1/4/5/9 only. |

---

## 12. Open questions for the reviewer

1. **Rule 1 vs the build (§6):** approve out-of-tree build in
   `build/assemblyscript/`, or carve out `third_party/assemblyscript/` as
   buildable?
2. **M3 syntax:** do you want real `async`/`await` keywords (accepting flagged
   `parser.ts`/`ast.ts` drift), or is the `__await(x)` marker acceptable for the
   first working version? My recommendation: marker first, keywords once the
   lowering is proven.
3. **M2 ownership:** job submission is host-side Rust and is the largest
   unscoped item. Is it in scope for this effort, or does it belong to whoever
   owns `REGION_JOB`?
4. **Awaitable inventory:** which host operations should become awaitable first
   (`nextFrame`, resource load, solver job, AI stream)? This determines which
   event classes the runtime maps, and it is a product decision, not a compiler
   one.
5. **Error surface:** is an explicit checked-status result acceptable, given no
   exceptions in the language — or would you rather block async on the btc-vision
   `try-catch` work landing?

---

## 13. What happens on approval (nothing before)

1. M0 — add the submodule, set the `upstream` remote, branch `tension/async`.
2. M1a — script the out-of-tree AS build (`npm ci && npm run build` in
   `build/assemblyscript/`).
3. M1b — the lowering pass, with the harness from §9 written **first** so the
   spike has a pass/fail gate.
4. M1c — host test in `tension-core/tests/`, asserting the four criteria.
5. Then, and only then, M2/M3/M4 on their own reviews.

**No code has been written for this plan. The working tree is unchanged** apart
from this document.
