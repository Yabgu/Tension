# Async/await in TensionScript — PLAN v2

**Status:** proposal, awaiting architect review. **No code written. No lowering
implemented. No commits beyond the fork setup commit.**
**Supersedes:** `docs/async-await-plan.md` (v1). v1 assumed the fork would stay a
thin layer over upstream; that constraint is withdrawn. v2 is a detached-fork plan.

Date of evidence: 2026-10-15.

---

## 0. Fork model and repository setup — DONE

Executed and verified. This section is a record, not a proposal.

**Fork identity.** Detached fork of `AssemblyScript/assemblyscript`.

**Remotes, as configured:**

```
origin    git@github.com:Yabgu/TensionScript.git          (fetch + push)
upstream  https://github.com/AssemblyScript/assemblyscript.git   (fetch only)
upstream  DISABLED_no_prs_back_to_upstream                (push)
```

Upstream's push URL is deliberately set to a dead value. That is the mechanical
enforcement of "reference only — no PRs back, no proposals back, no compatibility
patches to preserve mergeability." It is not a comment in a document; it is
configuration that makes an accidental push fail.

**Initial commit.** Upstream `main` @ `b6bda05c29c9eb7d07d7f6cb2703508483b30493`
("chore: Update Binaryen and other dependencies (#3035)", 2026-07-21) pushed as
`refs/heads/main`. Verified:

```
$ git ls-remote origin
b6bda05c29c9eb7d07d7f6cb2703508483b30493	HEAD
b6bda05c29c9eb7d07d7f6cb2703508483b30493	refs/heads/main
```

**Consumed by Tension** as a submodule at `third_party/assemblyscript` (architect's
chosen location). `.gitmodules` entry:

```
[submodule "third_party/assemblyscript"]
	path = third_party/assemblyscript
	url = git@github.com:Yabgu/TensionScript.git
```

Submodule state: added and staged in Tension, **not committed** (AGENTS.md rule 2
— the architect commits). Submodule HEAD is the same `b6bda05c`, matching origin.

### 0.1 The AGENTS.md rule 1 conflict — restated, with the resolution

`AGENTS.md` rule 1 says `third_party/` is read-only, including "never generate
into". Building AssemblyScript requires `npm ci`, which writes `node_modules/`
**inside** the checkout. The architect chose this location knowingly (the
tradeoff was stated when the choice was offered), so the plan resolves it rather
than re-litigating it:

> **The submodule holds source only and is never built in place.**
> `npm ci && npm run build` runs in an out-of-tree scratch copy under
> `build/assemblyscript/`, which is already covered by Tension's `.gitignore`.
> The submodule tree stays byte-identical to what the fork's `main` says.

Measured cost: a full AS build is ~7 seconds (`npm ci` then `npm run build`),
so a scratch build per invocation is not a burden.

### 0.2 What commits are additions, and what commits touch core

This is the fork's whole maintenance surface. Everything the async work needs
falls into the first column except where noted.

**Pure additions (new files, no upstream file modified):**

- `src/passes/async_lower.ts` — Backend A. New file.
- `src/passes/async_ir.ts` — the backend-agnostic intermediate (see §5.4). New file.
- `src/passes/wasmfx_lower.ts` — Backend B skeleton, not implemented in v2. New file.
- `tests/compiler/async_*.ts` + generated `.wat`/`.js`/`.d.ts` fixtures — new.
- `tests/parser/async_*.ts.fixture.ts` — new.

**Modifies core files (the irreducible set):**

| File | Nature of edit | Why it cannot be additive |
|---|---|---|
| `src/ast.ts` | `NodeKind.Await`; `AwaitExpression` class; `isAsync` field on `FunctionDeclaration`; `Node.createAwaitExpression` factory | A new expression kind is *by definition* an AST change. |
| `src/parser.ts` | Consume `async` as a function modifier; parse `await` as a prefix expression; contextual diagnostics | Parsing requires parser edits. This is explicitly authorized. |
| `src/resolver.ts` | One `case NodeKind.Await` in the expression switch | `await` must propagate a want-type like any other expression. |
| `src/compiler.ts` | One `case NodeKind.Await`; register the lowering backend in the existing custom-pass block | Codegen needs to know the node; backend registration has one existing site. |
| `src/extra/ast.ts` | `case NodeKind.Await` in the `ASTBuilder` serializer | **Required companion edit** — without it the parser round-trip fixture fails immediately. Easy to miss; called out deliberately. |
| `src/diagnosticMessages.json` | New message keys | Backing for new diagnostics. |

**Not touched:** `src/tokenizer.ts` (see §2.2 — the tokens already exist and are
already reserved), `std/assembly/**`, `src/types.ts` *except* for the synthesized
`Task<T>` registration site, `cli/**`.

Non-ASCII identifiers, the std lib, and the CLI are untouched, which matters for
§0.3: those are the surfaces most likely to churn.

**A note on `CommonFlags`.** `src/common.ts:7-87` is a `const enum` whose last
bit is `InternallyNullable = 1 << 31` — **there is no free bit**. Two
consequences: (a) `async` cannot be a `CommonFlags` bit without widening the
flag word, and (b) `async` must therefore be a dedicated field (§2.1). This is
verified, not assumed; it is exactly the kind of thing v1 would have gotten wrong.

### 0.3 Maintenance posture

**We do not track upstream.** We are not obligated to cherry-pick, and we will
not carry compatibility patches whose only purpose is to keep a future rebase
easy. Where upstream's design and async coverage conflict, async wins.

The relevant upstream facts, measured, for when the question comes up:

| Year | Upstream commits (all paths) |
|---|---|
| 2022 | 178 |
| 2023 | 77 |
| 2024 | 23 |
| 2025 | 32 |
| 2026 (to 2026-07-21) | 22 |

Upstream moved 60 commits in two years and has been silent since 2026-07-21.
Cherry-picking remains *available* — `upstream` fetches fine — but the fork does
not depend on it. This is a posture decision, not a forecast: the fork is viable
even if upstream never accepts anything again, because we never need anything
from it.

**Naming.** The origin repository is `TensionScript`. Whether the *package*
renames (`package.json` name, the `asc` binary name, `lib/asc.js` self-references)
is an implementation milestone, not a plan item, and is listed in §10 as a
question rather than decided here.

---

## 1. Host-side non-negotiables this plan composes with

Restated so the design can be checked against them line by line. Every one is a
property of `tension-core` and none is proposed for change.

- **Two callback slots, resolved by table index.** `caller.get_export("table")`
  (`session/mod.rs:1233`); `onBatch: (i32,i32,i32)->i32`, `onEvent: (i32,i32)->i32`
  (`callbacks.ts:26,28`); `CALLBACK_SLOTS = 2` (`arena.rs:197`).
- **No `_tension_event`.** Verified absent from the tree.
- **The session is not reentrant.** `run_epoch_verb` takes the session out of the
  store; a nested `wait`/`drain`/`close`/`open` from inside a callback finds no
  session and returns **`-EBADF`**. Verbs that do not take it out (`subscribe`,
  `unsubscribe`, `pending`) hit the depth guard and return **`-EBUSY`**
  (`session/mod.rs:1346-1350`; `EBUSY = -16`).
- **Jobs are a stub.** `REGION_JOB` (kind 3, `arena.rs:295`), `JOB_SIZE = 48 KiB`
  (`arena.rs:341`); classes `JOB_FAILED = 1`, `JOB_DONE = 4`; submission does not
  exist — `apply::sweep_jobs_to_failed` is a stub (`apply.rs:263`) and the apply
  phase is documented "Not implemented in A2b".
- **The guest owns the frame loop.** The host calls `_start_game` once
  (`main.rs:1226`) and returns. The loop is
  `while (...) { RuntimeSession.wait(16); ... }`.

---

## 2. AST changes

### 2.1 New AST nodes

**`AwaitExpression` — a new expression kind.** Modelled on
`UnaryPrefixExpression` (`src/ast.ts:1618-1628`), which is the existing precedent
for "one operator token + one operand":

```ts
/** Represents an `await` expression. */
export class AwaitExpression extends Expression {
  constructor(
    /** The awaitable expression. */
    public operand: Expression,
    /** Source range. */
    range: Range
  ) {
    super(NodeKind.Await, range);
  }
}
```

- `NodeKind.Await` is added to the `const enum NodeKind` (`src/ast.ts:46-126`,
  currently 67 values, grouped by comment block; `Await` belongs in the
  `// expressions` block).
- Factory: `Node.createAwaitExpression(operand, range)` alongside the ~60
  existing `Node.createXxx` factories (`src/ast.ts:100-900`). AS never `new`s AST
  nodes from the parser; the factory pattern is the rule.

**`isAsync` is a field, not a node kind, and not a flag bit.**

```ts
export class FunctionDeclaration extends DeclarationStatement {
  // ... existing fields ...
  /** Whether this function is `async`. */
  public isAsync: bool = false;
```

Why this shape, verified against the class hierarchy:

- `MethodDeclaration extends FunctionDeclaration` (`src/ast.ts:2215`) — so **one
  field covers functions and methods**.
- `FunctionExpression` merely *wraps* a `FunctionDeclaration`
  (`src/ast.ts:1351-1359`) — so **arrow functions and function expressions are
  covered too**, since they carry `arrowKind` on the same node.
- `CommonFlags` has no free bit (§0.2) — so a flag bit would require widening the
  word and touching every `is`/`isAny`/`set` site. A field is strictly cheaper and
  far more readable.

**What the AST deliberately does NOT carry.** No state ids, no resume-point
numbers, no lifted-local lists, no transition tables. Those are *lowering*
artifacts and belong to a backend. Baking them into the AST is precisely the
mistake that would make Backend B a rewrite instead of a swap. See §5.4 for where
they live instead.

### 2.2 Parser changes

**The tokenizer needs no change — and this is verified, not assumed.**

- `Token.Async` and `Token.Await` already exist: `src/tokenizer.ts:48-49`
  (`Async,` / `Await, // ES2017`).
- `tokenFromKeyword` already produces them: `src/tokenizer.ts:191-192`.
- **They are already reserved identifiers**: `tokenIsAlsoIdentifier`
  (`src/tokenizer.ts:356-378`) does *not* list them, so `IdentifierHandling.Prefer`
  sites already reject them.

This has a user-visible consequence worth stating plainly: **`async` and `await`
are already unusable as variable names.** `let await = 5;` fails today with
`TS1003: Identifier expected.` No new breakage is introduced by reserving them —
they were already reserved. We are adding a *consumer* for tokens that currently
produce parse errors.

**Parser hook points, with the exact sites:**

| What | Where | Edit |
|---|---|---|
| Function modifier | `parseTopLevelStatement` modifier loop `src/parser.ts:221-258`, `Token.Function` case `:287-290` | Consume `Token.Async` before `function`; set `isAsync` |
| Method modifier | `parseClassMember` `src/parser.ts:2209-2211`, params `:2249` | Same, for class members |
| Declaration build | `parseFunction` `src/parser.ts:1475-1607` (node built `:1593`) | Accept + record `isAsync` |
| Expression parse | `parseExpressionStart` prefix group `src/parser.ts:3700-3713` | Add `case Token.Await:` → `parseAwaitExpression` at `Precedence.UnaryPrefix` |
| Statement fallthrough | `parseStatement` `:3028-3030` | Unchanged — `await` is an expression, reached via the prefix path |

The prefix group at `:3700-3713` is where `Token.TypeOf` / `Token.Void` /
`Token.New` are already handled; `await` joins that group. Note the adjacent
`Token.Yield` fallthrough at `:3701` — **we are not adding generators**, so that
path stays exactly as it is.

**Error paths that change.** Today `async`/`await` produce
`Expression_expected` (`:4046`) or `Identifier_expected` (`:1009`). After the
change they parse, and these new diagnostics apply:

- `await` used outside an `async` function.
- `async` on a construct that cannot be async (e.g. a class constructor).
- Missing operand after `await`.

Diagnostics live in `src/diagnosticMessages.json` (message → number); the
`DiagnosticCode` enum is generated by `scripts/build.js:135-165` into a
gitignored `src/diagnosticMessages.generated.ts`. Adding a code therefore means
editing the JSON and letting the generator run — no hand-maintained enum.

**Where "await outside async" is diagnosed — an open implementation choice.**
The parser has **no context-tracking precedent**: `class Parser` keeps no
scope/depth/context stack (verified: no `breakableDepth`, `switchDepth`,
`loopDepth`, or `flowContext` field exists; the class fields are source
bookkeeping only: `backlog`, `seenlog`, `donelog`, `currentSource`, `dependees`,
`sources`, `currentModuleName`, `options`). Two options:

- **(a) Parser context flag.** A single `asyncContext: bool` saved/restored
  around function bodies, checked at `await`. Cheap; but puts a semantic rule in
  the parser.
- **(b) A dedicated AST validation walk before lowering.** A small function that
  walks function bodies tracking async-ness. More code, but it is
  **backend-agnostic** — which matters a great deal, because whether `await` is
  legal in a given position is *not* the same question under Backend B (§5.3).

**Recommendation: (b)**, precisely because it keeps a backend-sensitive rule out
of the parser. Surfaced in §10 as a decision.

### 2.3 Resolver changes

**Structural fact, verified, that shapes this section: the resolver resolves
expressions and types, not statements.** `grep -c "NodeKind.$K" src/resolver.ts`
for `Return`, `If`, `While`, `For`, `Break`, `Continue`, `Block`,
`ExpressionStatement`, `Throw` all return **0**. The resolver's switch handles 22
kinds, all expressions or types (`Assertion`, `Binary`, `Call`, `Comma`,
`ElementAccess`, `False`, `Function`, `FunctionType`, `Identifier`,
`InstanceOf`, `Literal`, `NamedType`, `New`, `Null`, `PropertyAccess`, `Super`,
`Ternary`, `This`, `True`, `TupleType`, `UnaryPostfix`, `UnaryPrefix`).

So the resolver edit is **exactly one new expression case**:

```
case NodeKind.Await:
  // the awaited type of the operand's type; the call-result type for a task handle
```

It participates in the same want-type propagation every other expression case
uses: `await` sits in a context expecting `T`, so the resolver pushes `T` down as
the want-type of the operand, and the operand (a `Task<T>`-typed expression)
checks against it.

**The return-type transformation is a resolver concern, not a backend concern** —
both backends need it, so it must not live in either:

- An `async function f(): T` **declares** return type `T`.
- A **call** to `f` yields `Task<T>`.
- `await` on a `Task<T>` yields `T`.

This mirrors TypeScript exactly (`async function f(): T` is callable as
`() => Promise<T>`), which is the mental model authors already have. The resolver
synthesizes the `Task<T>` result type at the call site while leaving the
declaration's `signature.returnType` as `T`.

### 2.4 Type checker: what replaces `Promise`

**AS has no `Promise` type** — verified: a grep for `Promise` across `src/`
returns one hit, in generated JS glue (`bindings/tsd.ts:240`), not a type.

**`Task<T>` — a synthesized built-in generic class.** AS's generic machinery
supports this: class instantiation is memoized per `instanceKey`
(`resolver.ts:2789,2810`), type arguments propagate into `ctxTypes`
(`resolver.ts:2804-2816`), and builtin types register through
`builtinTypes = new Map<string, (ctx) => Type | null>()` (`builtins.ts:824`).
`Task<T>` is registered the same way `Array<T>`/`Map<K,V>` are.

Three types, all backend-agnostic, all synthesized in the shared front-end:

- **`Task<T>`** — the call-result type of an async function.
- **`Awaitable<T>`** — the operand type of `await`. `Task<T>` satisfies
  `Awaitable<T>`; so do the runtime's own handles (§3).
- **`AsyncStatus`** — the error channel (§3.3).

`await x` has type `T` where `x: Awaitable<T>`.

**Verified mechanics note:** function types are `Signature`
(`src/types.ts:934-1200`), not a `FunctionType` class, and are interned by
`signature.toString()` in `program.uniqueSignatures` (`program.ts:484`). The
`async` trait must therefore **not** be encoded in the `Signature` string — two
functions differing only in `async`-ness would otherwise collide in the intern
table. This is a real trap; it is why `isAsync` lives on the *declaration* and the
call-site type is transformed in the resolver rather than being part of the
signature key.

---

## 3. Await operand and result semantics

### 3.1 The handle: what `load_mesh(...)` returns

An async-capable host operation returns an **awaitable handle** — a managed AS
class instance, not a `Promise`.

```ts
// Framework-provided. Backend-agnostic: the zero-allocation base is the same
// under Backend A and Backend B.
export class Awaitable<T> {
  /** Which completion this is waiting for. Opaque to the user. */
  class_: u32 = 0;
  /** Correlation id the runtime assigned. */
  taskId: u32 = 0;
  /** 0 = completed successfully; non-zero = an errno (§3.3). */
  status: i32 = 0;
  /** The value, valid only when status == 0. */
  value: T;
}
```

Two families, and the distinction is load-bearing for §6:

- **Event awaitables** — completed by a host-delivered record. `class_` names the
  event class (JOB_DONE, RESOURCE_READY, …). These are what `await job()` and
  `await loadMesh()` produce.
- **Tick awaitables** — completed by the scheduler itself with no host event at
  all: `nextTick()`, `nextFrame()`. No class, no ring slot. These exist because
  `FRAME` is `MODE_POLLED` (§6.1), so frame delivery is not a callback at all —
  a tick awaitable is both cheaper and more honest than subscribing to FRAME
  purely to get a callback.

### 3.2 What `await handle` evaluates to, and where it is read from

`await h` evaluates to `h.value`, typed `T`.

**Where the value is read from — and the correctness rule that goes with it.**
The completion payload arrives in the **32-byte `EventRecord`** the callback
points at. Verified guest-side layout (`wire.ts:215-222`, with offsets asserted at
`wire.ts:351-358`):

| Field | Offset | Size | Meaning |
|---|---|---|---|
| `seq` | 0 | 8 | host sequence number |
| `class_` | 8 | 4 | class id |
| `flags` | 12 | 4 | record flags |
| `a` | 16 | 4 | **generic payload word 1** |
| `b` | 20 | 4 | **generic payload word 2** |
| `f0` | 24 | 4 | **generic payload float 1** |
| `f1` | 28 | 4 | **generic payload float 2** |

The host writes these through `write_event_record` (`arena.rs:840-853`), and
`a`/`b`/`f0`/`f1` are carried verbatim from whatever the producer posted
(`posting.rs` `EventFields`). They are generic payload words with no assigned
meaning today.

> **Rule: the runtime copies the payload out of the record during dispatch, into
> the awaitable, and `await` reads the awaitable.**
>
> The ring slot is *transient*. It is a bounded sub-ring that later epochs
> overwrite. A runtime that deferred reading the payload until resume time would
> read a slot that may already hold a different event. This is a silent data
> corruption bug waiting to happen, which is why it is stated as a rule rather
> than a detail.

**For pointer-typed results** (a `Mesh`, an `Array<f32>`): the producer writes the
guest address of the result object into `a`. The runtime copies `a` into the
awaitable and `await` hands back the reference. This is why the state struct and
the awaitable must be **managed** objects — see §4.4.

### 3.3 Error model for rejection

**Constraint restated: AS has no `try`/`catch`.** Verified in this fork:
`try { throw ... } catch (e) { ... }` fails with
**`AS100: Not implemented: Exceptions`**, and there is no `--enable exceptions`
flag to unlock it. So an error model built on rejection-throwing is not merely
awkward — it is unavailable.

Four candidates:

- **(a) Trap on failure.** A failed await traps the guest. Simple, and matches
  the trap-based fault handling the session already has. But it makes *expected*
  failures (`file not found`) fatal, which is wrong for a game engine.
- **(b) Status on the handle, value is zero on failure.** `await h` yields `T`;
  on failure `h.status` is the errno and the value is the type's zero. The caller
  checks when it cares.
- **(c) A `Result<T>`-shaped class.** Explicit, forces unwrapping — but allocates
  per await on the happy path and adds a generic instantiation per T.
- **(d) Out-of-band channel** (a per-task error slot the scheduler surfaces at
  the next tick). Least invasive to the expression's type, but the error's
  association with *which* await produced it is implicit — bad for debugging.

**Recommendation: (b), with an opt-in trap helper.**

```ts
const h = loadMesh("bunny");
const m = await h;
if (h.status != 0) { /* recoverable: log, substitute a fallback mesh */ }
```

Rationale: no allocation on the happy path; no new syntax; no generics
instantiation per result type; and it keeps the *decision* about fatality with
the game author rather than the runtime. A library helper
`Async.expect(h)` covers the "this must not fail" case by trapping with a
diagnostic naming the await.

The honest cost, stated plainly: **this model is forgettable.** A caller who
ignores `status` silently proceeds with a zero value. That is the price of having
no exceptions, and it is better to name it than to pretend the API prevents it.
Two partial mitigations, both recommended: the runtime logs every non-zero status
at the moment it sets it, so a forgotten check still leaves a trace; and
`Async.expect` is the documented default in the framework's own examples, so the
checked path is the one people copy.

If the fork ever gains `try`/`catch` (see §9's note on btc-vision, and §10) the
model can be *extended* — a `try { await h } catch` form — without changing the
lowering, because the status field is already on the handle.

---

## 4. Lowering Backend A: state machines

### 4.1 Shape

An `async function f(): T` with body `B` lowers to three artifacts:

1. **A resume-point enum** — one value per suspension point in `B`, plus an entry
   and a terminal value. Numbered by the backend, stored in a side table (§5.4),
   **not** on the AST.
2. **A state struct** — one field per lifted local, one per live parameter, plus
   `resumePoint: u32` and `status: i32`.
3. **A resume function** — `f_resume(state: StateStruct): void`, whose body is
   `B` with each `await` replaced by a state transition:

```
state.resumePoint = K
rt.suspend(state, awaitable)     // registers the task; returns immediately
return                            // back to the scheduler
// ... re-entry here on resume:
// dispatch jumps to case K
case K:                           // operand's value now lives in state.tmp_K
  <continue with the await's value>
```

The switch on `state.resumePoint` at function entry is what makes re-entry work.
This is the standard C#/Rust/Babel-without-generators lowering, and it is what
the direct async→state-machine decision (v1's D1) produces.

### 4.2 How awaits become state transitions

Each `await` expression becomes, in order: evaluate the operand → store it in a
temporary slot in the state struct → set `resumePoint` → suspend → return → on
re-entry, read the temporary (now filled from the awaitable) as the value of the
`await` expression.

The await's *result* is deliberately routed through the state struct rather than a
wasm local. Wasm locals do not survive the return to the scheduler; only memory
does. This is the single most important mechanical fact of Backend A, and it is
why the harness's "lifted locals survive" assertion (§8) exists.

### 4.3 How locals are lifted

**Precedent exists in the codebase, which is why this is tractable rather than
speculative.** `ShadowStackPass` (`src/passes/shadowstack.ts`) already moves
locals into a per-function memory frame:

- `slotMaps: Map<FunctionRef, SlotMap>` where `SlotMap = Map<LocalIndex, SlotIndex>`
  (`shadowstack.ts:157, 190`)
- `noteSlot(func: FunctionRef, localIndex: Index): i32` (`shadowstack.ts:222`)
  assigns each wasm local a slot and returns it
- its header comment documents the frame layout in detail (`shadowstack.ts:18-77`)

That pass is a *stack* transform for a different purpose, but the mechanism —
enumerate locals, assign slots, spill through memory — is exactly what lifting
needs, and it proves AS's own IR layer can do it.

**Lifting rule for Backend A:**

- A local is lifted if it is **live across any `await`** in the function.
- Start with the **conservative** rule — lift every local declared before the
  first `await` in its scope. Correct, possibly wasteful. Tighten to a real
  liveness analysis later, as a pure optimization with the harness as the guard.
- Parameters live across an `await` are lifted too; the resume function's
  parameter list is empty and it reads them from the state struct.
- `this`, in a method: AS has no `arguments` object, and `this` is a value like
  any other — lift it.

The conservative-first order is deliberate: a wrong liveness analysis produces
*silently wrong values*, which is the worst failure mode, while an over-lifted
local produces only slower code.

### 4.4 Where the lowered code lives, and the state struct's home

**The state struct lives on the guest heap. Not the arena, not the wasm stack,
not a static.**

- **Wasm stack: impossible.** The frame is gone the moment the resume function
  returns to the scheduler. This is the whole reason lifting exists.
- **Static / global: rejected.** It would permit exactly one live instance per
  async function, so two concurrent awaits of the same operation would corrupt
  each other. That is not a restriction a game engine can accept.
- **Arena: rejected**, on two independent grounds. (i) The arena's regions are
  fixed-size and part of a **layout hash** — any change is an ABI change, and this
  plan must not require host changes. (ii) The only region that could plausibly
  hold task state is `JOB`, which is **48 KiB** (`arena.rs:341`) and is
  specifically the job-submission region, not a general allocator. Putting task
  state there would couple the compiler's lowering to the job system's layout.
- **Guest heap: recommended.** No host involvement, no ABI change, no fixed
  capacity, and — decisively — AS's own allocator gives it a lifetime.

**The state struct must be a *managed* AS object, not `@unmanaged`.** This is not
a style choice. Lifted locals may be reference-typed (a `String`, an `Array<f32>`,
a `Mesh`). If the state struct is an unmanaged heap buffer, AS's runtime will not
trace those fields, and a lifted reference can be reclaimed while the task is
suspended. The task would resume holding a dangling pointer. A managed class
makes the fields traced; the runtime's task table holds the only strong
reference, so completing or cancelling a task frees its state by dropping that
reference.

**Lowered code placement.** The resume function is a synthesized function in the
same module (the original `f` becomes a thin constructor that allocates the state
struct, fills parameters, registers the task, and returns the `Task<T>` handle).
The state struct is a synthesized class. Both are ordinary IR — no new wasm
constructs, so Backend A needs nothing from Binaryen beyond what AS already uses.

### 4.5 Correctness cases that must be covered and tested

| # | Case | Why it is a distinct hazard |
|---|---|---|
| 1 | `await` in a loop | Re-entry must resume *inside* the loop body with the induction variable intact. The resume-point dispatch must land after the right iteration's await. |
| 2 | `await` in a conditional | Only one branch's suspension points are reachable per execution; the dispatch must handle a resume point that the current path did not set. |
| 3 | Multiple awaits per function | Distinct resume points must not alias. Cheapest bug to write, hardest to notice. |
| 4 | `await` in nested functions | Each async function gets its own state struct. An inner async function called without `await` must still produce a `Task<T>` the outer one can await. |
| 5 | `await` with early return | The terminal resume point and the cleanup path must agree; a task that returns must not also stay registered. |
| 6 | `await` in a loop with `break`/`continue` | Break/continue targets are `string` wasm block labels in this version (`flow.ts:251,253`), pushed/popped via `pushControlFlowLabel` (`flow.ts:634`) / `popControlFlowLabel` (`flow.ts:644`). A state transition crossing a loop boundary must not leave a label dangling. **This is the case most likely to be wrong**, and it is not in the architect's list — added here. |
| 7 | `await` inside `try`/`catch` | **Not applicable.** `try`/`catch` does not exist in this fork (`AS100: Not implemented: Exceptions`). There is nothing to lift across. |
| 8 | `await` inside a closure | **Not applicable today** — see below. |

**On case 8, stated plainly because the task asks about it.** Closures do not
exist in this fork. A capturing arrow function fails with
**`AS100: Not implemented: Closures`**. Notably the *flag* exists
(`CommonFlags.Closure = 1 << 29`, `src/common.ts:79`) but the implementation does
not. Non-capturing function values do work — they lower to table indices, which is
how the existing `onBatch`/`onEvent` callbacks are passed at all
(`callbacks.ts:21-23`).

So "await inside closures" is vacuous in v2, and would be strictly harder than
await-in-function if closures were added later, because a closure's *captured
environment* would also have to be lifted, and the environment is shared between
the closure and its creating scope. **Adding closures is a separate, large feature
with its own plan; it is not smuggled in here.** There is a reference
implementation to study if it is ever wanted (§9). Surfaced in §10.

---

## 5. Lowering Backend B: WasmFX (design only)

### 5.1 The same AST, lowered differently

Under Backend B, `await` emits a suspension of a real continuation instead of a
state transition:

| Backend A | Backend B |
|---|---|
| allocate state struct, switch on `resumePoint` | `cont.new` over the async function body |
| `rt.suspend(state, awaitable); return` | `suspend $tension_await` with the awaitable as payload |
| scheduler calls `f_resume(state)` | scheduler/host `resume`s the continuation |
| task table holds state structs | continuation queue holds continuations |
| lifted locals | the continuation's own stack — **no lifting at all** |

Instruction set, verified against the proposal's own Explainer
(`proposals/stack-switching/Explainer.md`), with occurrence counts:

| Instruction | Count | Role |
|---|---|---|
| `cont.new` | 13 | create a continuation from a function reference |
| `suspend` | 94 | suspend the current continuation to its handler |
| `resume` | 110 | resume a continuation |
| `switch` | 107 | symmetric transfer to a peer continuation |
| `resume_throw` | 39 | resume while raising a tag at the suspension point |
| `cont.bind` | 20 | partial application |
| **`cont.drop`** | **0** | **does not exist** |

Two consequences the design must respect:

- **No deallocation.** `cont.drop` has zero occurrences; wasmtime's tracking issue
  #10248 lists "Support for deallocating continuations" as explicitly *not* in the
  initial implementation. Every continuation stays alive for the store's lifetime
  (wasmtime's own `StoreOpaque::allocate_continuation` says so in its doc comment:
  "we currently don't support deallocating them... all continuations remain
  allocated throughout the store's lifetime"). A long-running game with a task per
  frame would leak continuations without bound. **This is a real design constraint
  on Backend B, not a footnote.**
- **The scheduler is outside the instruction set.** The Explainer's reference
  `$scheduler1`/`$scheduler2` are written *in wasm*; the bag-of-stacks design notes
  describe a *tree* of arena schedulers, with the root yielding to the embedder's
  event loop. So a host-owned continuation queue is **permitted but not
  mandated**.

### 5.2 What changes in the runtime when Backend B lands

- **The suspend/resume mechanism.** State structs disappear; the task table becomes
  a continuation queue.
- **The resume-queue owner may move.** Guest-side `runReady()` (Backend A) can
  become a host-owned continuation queue driven by the same event classes.
- **Lifted locals disappear entirely** — this is the bulk of Backend A's
  complexity, and Backend B deletes it.
- **The "no await inside a callback" restriction can be lifted** (§5.3).

**What does not change:** the AST, the `Task<T>`/`Awaitable<T>`/`AsyncStatus`
types, the handle fields, `await`'s type and its value semantics, the error model,
the event classes used, and every line of game code.

### 5.3 The one thing that would break Backend B — and it is a front-end decision

Under Backend A, `await` **cannot** occur where a host-invoked callback is on the
stack: you cannot suspend a wasm frame the host called into via `call_indirect`,
and the session is not reentrant anyway, so there is nothing to return to.

Under Backend B, that restriction **could** be relaxed: `suspend` inside a
callback transfers control back to the suspend point's handler, and the host's
`callback.call(...)` returns normally at that point. A game could then
`await` inside a callback — which is a genuinely different programming model.

> **Therefore: "await is illegal inside a callback" must NOT become a language
> rule in the parser or the resolver.** It is a **Backend A capability
> restriction**, reported by Backend A, not by the front-end.
>
> If the front-end hard-rejects it, Backend B inherits a restriction it does not
> have, and lifting it later means a second front-end change — i.e. exactly the
> "bake in state-machine assumptions" failure the architect warned about.

This is the concrete answer to "what would break it": not the AST *nodes*, but an
over-eager *diagnostic*. It is listed in §10 as a decision with a recommendation.

### 5.4 What in the AST design makes Backend B a drop-in

- **Syntax only in the AST.** `AwaitExpression` carries an operand and a range.
  `isAsync` is a bool on the declaration. Nothing about lowering is encoded.
- **Backend metadata lives in side tables, keyed by node identity.** Each backend
  owns a `Map<NodeRef, BackendRecord>` (resume points, lifted-local sets,
  continuation descriptors). A backend can be deleted without touching a single
  node. This is the structural guarantee that makes "swappable" real rather than
  aspirational.
- **Shared concerns are shared.** Return-type transformation (`async f(): T` →
  call yields `Task<T>`), the awaitable types, the error model, and diagnostics
  are all backend-agnostic and live in the front-end.
- **The backend hook is a proper seam.** Two options, both verified to exist:
  - the `afterParse` transform (`Transform` at `cli/index.d.ts:247`, loaded by
    `--transform`), which runs before resolution (`cli/index.js:697`);
  - the custom-pass block in `src/compiler.ts:765-772`, which already gates
    `ShadowStackPass` on an option and `RtraceMemory` on a define — the existing
    precedent for "a compiler extension selected at build time".
  
  **Recommendation:** register Backend A and Backend B through the custom-pass
  block, selected by a compiler option, so switching is a build flag rather than
  a code edit. Rationale: both backends operate on resolved, typed code, and the
  custom-pass site is where AS already does exactly this.

---

## 6. Guest async runtime

### 6.1 Dispatch: which callbacks participate, and why both must

**This is settled by the code, not by preference.** Every class's default delivery
mode, from `DEFAULT_CLASS_MODES` (`arena.rs:249-259`):

| Class | id | Mode | Async relevance |
|---|---|---|---|
| DEVICE_LOST | 0 | DIRECT → `onEvent` | fatal path |
| JOB_FAILED | 1 | DIRECT → `onEvent` | **job failure** |
| RESOURCE_FAILED | 2 | DIRECT → `onEvent` | **load failure** |
| SUBMISSION_REJECTED | 3 | DIRECT → `onEvent` | submit failure |
| **JOB_DONE** | **4** | **BATCHED → `onBatch`** | **job completion** |
| **RESOURCE_READY** | **5** | **BATCHED → `onBatch`** | **load completion** |
| INPUT_KEY | 6 | BATCHED → `onBatch` | not async-relevant |
| INPUT_MOUSE | 7 | BATCHED → `onBatch` | not async-relevant |
| LOG | 8 | BATCHED → `onBatch` | not async-relevant |
| FRAME | 9 | **POLLED** | tick awaitables only |

> **`onBatch` must participate in async dispatch. There is no alternative.**
> `JOB_DONE` and `RESOURCE_READY` are `MODE_BATCHED` (`arena.rs:255-256`), so
> awaiting a job or a resource load *completes through `onBatch`*. `onEvent`
> carries only the failure paths (JOB_FAILED, RESOURCE_FAILED) plus input and the
> device/submission errors. A design that hooked only `onEvent` would never see a
> successful completion of anything the async runtime exists to await.

`FRAME` being `MODE_POLLED` is the second useful fact: frame delivery is not a
callback at all, which is exactly why `nextFrame()` is a tick awaitable (§3.1)
rather than an event awaitable.

### 6.2 How wakeups encode into the two i32 arguments

**They do not — and that is the good news.** `onEvent(class, ptr)` and
`onBatch(class, ptr, count)` consume both arguments already: `class` is the class
id, `ptr` is the arena address of the record. There is nothing left in them.

The wakeup correlation rides in the **record's existing generic payload words**,
which are already part of the frozen 32-byte layout (§3.2): `a` @ 16, `b` @ 20.

**Recommended encoding (Backend A and B identical):**

- `a` = **task id** — the runtime's correlation handle for the suspended task.
- `b` = **await-point discriminator** — which suspension of that task the
  completion belongs to. Guards against a late completion waking the wrong await.
- **Failure is carried by the class id**, not by a flag: JOB_DONE vs JOB_FAILED,
  RESOURCE_READY vs RESOURCE_FAILED. This is strictly better than overloading a
  bit, because it reuses the host's own semantics and needs no convention on the
  `flags` word.
- `f0`/`f1` carry float payloads; `b` may instead carry a guest pointer when the
  result is a heap object (§3.2), in which case the await-point discriminator
  moves to the `flags` word.

**Scope caveat, stated honestly:** this convention is only *half ours*. `a`/`b`
are also the fields the host's job system will use to report job identity. The
final convention must be defined **jointly with the job-system milestone** (§7),
not fixed unilaterally by the compiler. For the M1 harness the convention is
test-only and fully under the harness's control on both sides, which is why the
harness can proceed without the job system.

**`onBatch` dispatch mechanics.** `onBatch(class, ptr, count)` delivers `count`
records contiguous from `ptr`, stride `EVENT_RECORD_SIZE = 32`. The dispatcher
loops `count` times at `ptr + i*32`, reading `a`/`b` per record. A batched
delivery can mix several tasks' completions in one callback, so the dispatcher
must be per-record, not per-callback.

### 6.3 The scheduler tick, inside the guest-owned frame loop

No new host import is needed, because the yield primitive already exists.
`RuntimeSession.wait(timeoutMs)` is the yield; and — verified — `wait(0)` is
defined to be exactly the non-blocking drain (`session/mod.rs` documents
`EpochMode::DrainAll` as "there is no verb for it, because `wait(0)` is one").

Shape:

```ts
export function _start_game(): void {
  // ... existing setup ...
  while (!done) {
    // If tasks are runnable, do not block; otherwise wait for work.
    const timeout = rt.hasRunnable() ? 0 : frameTimeoutMs;
    RuntimeSession.wait(timeout);   // ← the yield. Host delivers here.
    rt.runReady();                  // ← the scheduler tick
    game.update();                  // ← the game's own frame logic
  }
}
```

Three properties worth noting:

- **Composing with the existing loop is an insertion, not a rewrite.** The
  existing loop already calls `wait`; the change is the timeout argument and one
  call. Every existing example keeps working unchanged if `rt` is present but idle.
- **`rt.runReady()` sits after `wait` returns, never before.** That position is
  what makes §6.4 true.
- **The tick is where resume happens**, so by construction the session is idle and
  every verb is legal — the reentrancy rule is satisfied by ordering, not by a
  guard.

### 6.4 "A callback records a wakeup; it never resumes a task"

**The rule.** Enforced three ways, deliberately more than one, because a silent
violation here produces a `-EBADF` storm that is hard to trace back to its cause.

1. **Runtime (primary).** The dispatcher writes into a *pending-wakeup* list and
   sets a flag while inside a callback. `runReady()` refuses to run while
   `inCallback` is true. A resume attempted in the wrong place is a loud,
   named failure, not a mysterious errno.
2. **Compile-time (partial, best-effort).** Where statically detectable, the
   front-end reports it — a function literal with an `await` inside it passed
   directly as a `Callbacks` slot, or an `async` function reference assigned into
   one. Coverage is necessarily partial, because the callback table index is
   assembled at runtime (`callbacks.ts:21-23`); this check is a convenience, not
   the guarantee. Consistent with §5.3, this must be a **Backend A** diagnostic,
   not a language rule.
3. **Harness (negative control).** §8's control 1 asserts the failure is
   *detected*, so a regression in (1) or (2) is caught rather than shipped.

### 6.5 Payload capture is part of dispatch, not of resume

Restating §3.2 as a runtime obligation, because it is easy to get wrong while
implementing the callback:

During dispatch — inside the callback, cheaply, without resuming anything — the
runtime copies `a`/`b`/`f0`/`f1` out of each delivered record into the matching
awaitable, and marks the task ready. The ring slot is never referenced again.

---

## 7. Host-side dependency: the job system

**Jobs are a stub, so awaiting a host job has nothing to await yet.** Measured:

- `REGION_JOB` exists as a region kind (`arena.rs:295`), `JOB_SIZE = 48 KiB`
  (`arena.rs:341`).
- Classes `JOB_DONE = 4` and `JOB_FAILED = 1` exist, with the modes in §6.1.
- **Completion delivery works**: `--post-test-events` posts three JOB_DONE records
  through the posting face before the guest runs (`main.rs:1191-1216`).
- **Submission does not exist**: `apply::sweep_jobs_to_failed` is a stub
  (`apply.rs:263`) and the apply phase is documented "**Not implemented in A2b**:
  the call site exists and the pending list is always empty."
- There is no general worker pool in the host. The only real worker thread is
  capability-owned inside the OGRE DSO.

**Scope decision, recommended: the job system is a prerequisite the architect
must schedule separately, not part of this plan.**

Reasons:

1. It is **host-side Rust** in `tension-core` — the compiler plan explicitly does
   not propose `tension-core` changes, and this plan should not breach that by the
   back door.
2. It is a **different discipline**: thread pool sizing, back-pressure, queue-full
   policy (`PostError::QueueFull` already exists and returns `-ENOSPC`), job
   cancellation, and the pending/apply machinery. None of that is compiler work.
3. It has its **own ABI question**: what `a`/`b` mean for a job completion is the
   other half of §6.2.

**What this plan delivers without it, and why that is enough to prove the design:**
the M1 harness drives await/resume using host-*posted* events on a real host
thread. That exercises suspension, resume, lifted-local survival, wakeup
dispatch, and both negative controls — everything the compiler and runtime must
get right — while touching **zero production code in `tension-core`**.

**Recommended milestone split** (architect to schedule):

| | Repo | Deliverable | Depends on |
|---|---|---|---|
| M2a | `tension-core` | job submission: fill `apply.rs`'s pending path, real worker pool, `-ENOSPC` back-pressure | independent |
| M2b | `tension-core` + `tension-framework` | the `a`/`b` completion convention, agreed with §6.2 | M2a, and this plan's §6.2 |

**The one place this plan touches `tension-core`** is a new test file
(`tension-core/tests/async_await.rs`) plus a guest fixture. It adds **no
production code and no ABI change** — it is a test that uses the existing
`PostingSide` from a spawned thread. Flagged explicitly in §10 for the architect's
approval, since "do not propose changes to tension-core" is a constraint I would
rather ask about than quietly interpret in my own favour.

---

## 8. Test harness

### 8.1 Fixture and shape

Guest fixture: `tension-framework/tests/guest-async.ts` (matching the existing
`guest-*.ts` + `run.sh` convention in that directory).

```ts
// The smallest program that can be wrong in each interesting way.
let resumedValue: u32 = 0;
let framesWhileSuspended = 0;
let errnoFromCallback = 0;

async function awaitedTask(): u32 {
  let local: u32 = 41;                 // live across the await → must be lifted
  process.stdout.write("A:before\n");

  // Negative control 2: a nested verb from inside a callback is refused.
  // (recorded by the callback below; asserted by the host)

  local = await rt.jobHandle(1);       // ← suspends here
  process.stdout.write("B:after " + local.toString() + "\n");
  return local;                        // 42 iff the lifted local survived
}

export function _start_game(): void {
  rt.start(awaitedTask());

  let ticks = 0;
  while (ticks < 500) {
    RuntimeSession.wait(rt.hasRunnable() ? 0 : 16);
    rt.runReady();
    if (rt.isSuspended()) framesWhileSuspended++;
    if (rt.isFinished()) break;
    ticks++;
  }
  process.stdout.write("C:frames-while-suspended=" + framesWhileSuspended.toString() + "\n");
  process.stdout.write("D:value=" + resumedValue.toString() + "\n");
}
```

Host test: `tension-core/tests/async_await.rs`, following the existing
`tests/log_guest.rs` / `tests/frame_layout.rs` conventions.

**The critical harness property: the completion is posted from a *separate host
thread, after a delay*.** `--post-test-events` posts *before* the guest runs
(`main.rs:1191`), which proves delivery but **not suspension** — a busy-waiting
guest would pass such a test. Posting from a spawned thread that holds a cloned
`PostingSide` (`posting.rs` is `Sync` by design, and `main.rs:1196` already clones
it) is what makes the test meaningful: the guest is provably *inside* `wait` when
the completion arrives.

### 8.2 Pass criteria

All four must hold.

1. **Ordering.** `A:before` precedes `B:after`, and `B:after` appears only after
   the epoch that carried the completion. A resume that happened before the
   completion arrived fails here.
2. **Genuine yield, not spin.** `frames-while-suspended >= 1` — the guest loop
   advanced at least one tick while the task was parked. A busy-wait reports zero.
3. **Lifted locals survive.** `D:value=42` — a local assigned *before* the await
   and read *after* it holds its value. This is the assertion that catches the
   most likely Backend A bug.
4. **No reentrancy refusal in the normal path.** The run produces no `-EBADF` and
   no `-EBUSY` from any session verb. A runtime that resumed inside a callback
   fails here.

### 8.3 Negative controls

**Control 1 — resuming inside a callback must fail.**
A variant whose `onEvent` body calls `rt.runReady()` directly. The harness asserts
the runtime's own guard fires (the `inCallback` refusal from §6.4), and that the
session subsequently returns an error rather than silently corrupting state.
**Asserted:** the guard triggers, and the run is reported as failed rather than
producing a wrong-but-plausible transcript.

**Control 2 — a nested verb from inside a callback must return `-EBADF`.**
The guest calls a session verb from inside a callback and records the return
value; the host asserts **`-EBADF`** — the value `run_epoch_verb` actually
produces when the session has been taken out of the store (`session/mod.rs`,
`caller.data_mut().session.take()`), **not** `-EBUSY`.

This distinction is worth the explicit control. `-EBUSY` is what `subscribe` /
`unsubscribe` / `pending` return via the depth guard (`mod.rs:1346-1350`) and what
the unit tests observe when they set `depth = 1` by hand with the session still
installed. A real guest inside a real callback normally sees **`-EBADF`**. A
harness that asserted `-EBUSY` would encode the wrong contract and would pass
against a host that behaved differently.

### 8.4 Platform

**Must run on Windows**, and the design is arranged so it can:

- The guest builds with the fork's `asc`; no POSIX-only tooling in the path.
- The host test is a normal `cargo test` under MSVC
  (`cargo test --no-default-features --features audio`), following `AGENTS.md`.
- The fixture writes its transcript with `process.stdout.write` (already used by
  the existing fixtures), so the host asserts on captured output, not on a file.
- **The build step runs out-of-tree** (§0.1), so the Windows path never writes into
  the submodule.
- No WasmFX, no threads-in-wasm, no platform-specific syscalls.

---

## 9. Verification of the claims from v1

Each claim re-checked against primary sources. Two are confirmed as stated, one is
confirmed with a correction of *emphasis*, and two need nuance.

**9.1 `moonbitlang/async` ships its own event loop — CONFIRMED.**
Its README states "Currently, this library only supports native/LLVM backends on
Linux/MacOS", but the repository does carry a wasm path: `src/internal/event_loop/`
contains `event_loop.wasm.mbt`, `event_bus.wasm.mbt`, `io.wasm.mbt`,
`network.wasm.mbt`, `thread_pool.wasm.mbt`, plus `src/process/wasm.mbt`, and there
is a `nightly-wasm-test.yml` CI job. The event loop is unambiguously its own:
`event_loop.wasm.mbt` defines `PlatformEventLoopExtra` with `Unix`/`Windows`
variants and `UnixEventLoopExtra::new()` / `WindowsEventLoopExtra::new()`.

So the accurate summary is: **it has its own event loop with per-platform backends
(epoll/kqueue/IOCP/JS-fetch) and no integration point for an embedder-owned host
loop.** It can run on a wasm1 target; it simply cannot solve this problem, because
there is no way to say "this task's completion will be delivered by *my* host at
*my* frame boundary." Relevant as prior art for the scheduler's
structured-concurrency design; not a dependency.

**9.2 Wasmtime #13584 is closed — CONFIRMED.**
`state: closed`, `state_reason: completed`, closed 2026-07-28, 3 comments.

**9.3 Wasmtime #14644 and #14509 are open — CONFIRMED, with corrected emphasis.**
- #14644 "cranelift: preserve fuel across stack-switching instructions" — **open**,
  updated 2026-10-10, 0 comments.
- #14509 "Stack-switching ops loses fuel accounting" — **open**, updated
  2026-10-09, 0 comments.

Both are *open*, as v1 said. The correction is to emphasis: these are **fuel
accounting** issues, not correctness-of-unwinding issues. They matter for
determinism and for Wasmtime's fuel-based preemption — which is directly relevant
to Tension, whose host uses **epoch interruption** for latency-critical
preemption. Losing fuel accounting across a suspend/resume means an epoch-driven
preemption budget can be silently wrong for a guest that switches stacks. That is
a real reason to keep Backend B behind Backend A, stated in the engine's own
terms rather than as a vague "experimental".

**9.4 WasmFX instruction set and `cont.drop` absence — CONFIRMED.**
Counts in the Explainer: `cont.new` 13, `cont.bind` 20, `suspend` 94,
`resume_throw` 39, `resume` 110, `switch` 107, **`cont.drop` 0**. `cont.bind` is
present and was missing from v1's list. The Explainer's proposed type math
(`cont.new $ct : [(ref null $ft)] -> [(ref $ct)]`) is consistent with one-shot
continuations. Schedulers are written in wasm; a host-owned queue is permitted,
not mandated.

**9.5 WasmFX Windows support is a roadmap item per #10248 — CONFIRMED.**
Tracking issue #10248 "Tracking issue: Stack switching proposal implementation
status" is **open**, updated 2026-10-05. Its "Limitations of initial
implementation" list, quoted verbatim:

```
- [ ] Support for ISAs other than x64
- [ ] Support for resume.throw instructions (requires exception handling)
- [ ] Support for deallocating continuations
- [ ] Integration with GC (i.e., allowing continuation references to appear in GC objects, such as arrays an structs)
- [ ] Windows support
- [ ] Pulley support
- [ ] Winch support
```

`Windows support` is unchecked. Corroborated independently by Wasmtime's stability
table (`docs/stability-wasm-proposals.md`): `stack-switching` = ❌/🚧/🚧/❌/❌/❌ with
the footnote "Currently the implementation is only for x86\_64 Linux", and
`Config::wasm_stack_switching` documented "This feature is `false` by default"
(`crates/wasmtime/src/config.rs:1269-1280`).

**The architect's framing is correct and the plan adopts it: this is a roadmap
item, not a bug.** Three checklist items are Windows- or constraint-relevant
(`Windows support`, `deallocating continuations`, and the fuel-accounting issues
#14509/#14644), and
Backend B ships when they clear. Backend A is not a compromise — it is what runs
today on the actual target platform, and §5.4 is the structural guarantee that
swapping costs nothing in the AST or the guest API.

---

## 10. Open decisions requiring architect approval

Each with a recommendation. None decided unilaterally.

**D1 — Error model for await rejection.**
*Options:* (a) trap; (b) status on the handle, zero value on failure; (c)
`Result<T>` class; (d) out-of-band channel.
**Recommend (b)**, plus an `Async.expect(h)` trap helper. No allocation on the
happy path, no new syntax, and — decisively — it is the only option that does not
require `try`/`catch`, which does not exist in this fork.
*Named cost:* it is forgettable. Mitigated by runtime logging of every non-zero
status and by making `Async.expect` the documented default in examples.

**D2 — How wakeups encode into the two i32 arguments.**
**They do not; both are already consumed by `(class, ptr)`.** The correlation rides
in the 32-byte record's generic payload words: `a` @ 16 = task id, `b` @ 20 =
await-point discriminator, failure carried by class id (JOB_DONE vs JOB_FAILED).
**Recommend this**, and note that the convention is only half ours — it must be
finalized jointly with the job system (§7). The M1 harness uses a test-only
convention it controls on both sides.

**D3 — Whether `onBatch` participates in async dispatch.**
**Recommend yes, and it is not really optional.** `JOB_DONE` (4) and
`RESOURCE_READY` (5) are `MODE_BATCHED` (`arena.rs:255-256`), so job and resource
completions *arrive through `onBatch`*. A design that ignored `onBatch` could never
see a successful completion. `onEvent` handles the failure classes (1, 2) plus
device/submission errors.
*Sub-decision:* batched dispatch is per-record (stride 32 from `ptr`, `count`
times), since one callback can carry several tasks' completions.

**D4 — How the scheduler yields for completion delivery without a new host import.**
**Recommend `RuntimeSession.wait(timeout)` — it already exists.** `wait(0)` is
already defined to be the non-blocking drain, so the loop can pass `0` when tasks
are runnable and a frame timeout otherwise. Zero new imports; a two-line insertion
into the existing guest loop.

**D5 — Where the state struct lives.**
**Recommend the guest heap, as a managed AS object.**
*Rejected:* wasm stack (the frame is gone at suspension); static (one live instance
per function — two concurrent awaits of the same operation would corrupt each
other); arena (fixed regions under a layout hash → ABI change, and the only
candidate region is the 48 KiB `JOB` region, which belongs to the job system).
*Requirement:* managed, not `@unmanaged`, so lifted *reference-typed* locals are
traced. An unmanaged buffer would let a lifted reference be reclaimed while the
task is suspended.

**D6 — How the AST supports Backend B without baking in Backend A.**
**Recommend three structural rules**, all in §5.4:
(i) AST carries syntax only — `AwaitExpression(operand, range)`, `isAsync: bool`;
(ii) backend metadata lives in per-backend side tables keyed by node, never on the
node; (iii) **"await inside a callback" is a Backend A capability diagnostic, not a
language rule** — hard-coding it in the parser or resolver would give Backend B a
restriction it does not have and force a second front-end change later.

**D7 — Where "await outside async" is diagnosed.**
*Options:* (a) a parser context flag; (b) a dedicated backend-agnostic AST
validation walk.
**Recommend (b).** The parser has **no context-tracking precedent** (verified: no
depth/scope/context fields on `class Parser`), and (b) keeps backend-sensitive
rules out of the parser — which is D6(iii) applied consistently.

**D8 — The one place this plan touches `tension-core`.**
The harness needs `tension-core/tests/async_await.rs` (test file) plus a guest
fixture, to run a real host with a completion posted from a spawned thread.
**Recommend approving it explicitly**, because it adds no production code and no
ABI change, but the constraint said not to propose `tension-core` changes and I
would rather ask than interpret that in my own favour.

**D9 — `await` inside closures.**
**Recommend declaring it out of scope**, on the facts: closures are not implemented
in this fork (`AS100: Not implemented: Closures`); the `CommonFlags.Closure` bit
exists (`common.ts:79`) but no implementation does. Non-capturing function values
do work (they lower to table indices). If closures are ever wanted, they are a
separate feature with a separate plan, and `await` inside a closure is strictly
harder than `await` in a function because the captured environment must be lifted
too — and the environment is shared with the creating scope.
*Reference implementation if ever wanted:* `@btc-vision/assemblyscript` carries
`closures`, `closures-pr`, `closure-pr`, `hybrid-closure-approch`, and
`experimental-try-catch-finally` branches. Adopting it is not recommended (it is a
third-party rebase of a moving upstream, on a different version line), but its
branches are the design to study.

**D10 — Whether the backend hook is the `--transform` plugin or the in-tree
custom-pass block.**
**Recommend the in-tree custom-pass block** (`src/compiler.ts:765-772`), selected
by a compiler option, so switching backends is a build flag. Both backends operate
on resolved, typed code; the custom-pass site is where AS already does exactly
this (it gates `ShadowStackPass` on an option and `RtraceMemory` on a define).
Backend A may *additionally* want an `afterParse` transform step for AST-to-AST
prep; if so, that is additive via the existing `--transform` flag.

**D11 — Package renaming.**
The origin is named `TensionScript`. Whether to rename `package.json`'s name,
`package.json`'s `version`, the `asc` binary, and the `lib/asc.js` self-references
is a product decision with a real cost (the CLI test suite asserts on the binary
name and its help output). **Recommend deferring** until Backend A compiles the
harness, so a rename never blocks progress on lowering. Not decided here.

**D12 — Whether `async` is permitted on declarations that are ambient or
`declare`d.** An `async declare function` has no body to lower.
**Recommend disallowing** with a clear diagnostic, and treating the equivalent for
methods and constructors the same way (constructors can never be async in TS
either).

---

## 11. Milestones and dependency graph

```
   [DONE] M0  fork: origin=TensionScript, upstream=reference-only,
   │          initial commit b6bda05c, submodule at third_party/assemblyscript
   │
   ├─ M1a  AST + parser + resolver + types
   │        NodeKind.Await, AwaitExpression, isAsync field, factories,
   │        parser modifier + prefix-expression hooks, one resolver case,
   │        Task<T>/Awaitable<T>/AsyncStatus synthesis, extra/ast.ts serializer
   │        ├── gate: tests/parser/async_*.ts.fixture.ts round-trips
   │        └── gate: `async`/`await` parse; `await h` type-checks to T
   │
   ├─ M1b  Backend A lowering            (depends on M1a)
   │        state structs, lifted locals (conservative first), resume dispatch,
   │        custom-pass registration, terminal/cleanup path
   │        └── gate: compiler fixtures land for correctness cases §4.5 #1-#6
   │
   ├─ M1c  Guest runtime                 (depends on M1a; parallel with M1b)
   │        task table, ready queue, inCallback guard, payload capture,
   │        onBatch + onEvent dispatch, runReady(), tick awaitables
   │        └── gate: unit-testable independently of lowering
   │
   ├─ M1d  Harness                       (depends on M1b AND M1c)
   │        guest fixture + tension-core/tests/async_await.rs (D8),
   │        completion posted from a spawned thread
   │        └── gate: §8.2 criteria 1-4 all pass, on Windows
   │        └── gate: §8.3 negative controls 1 and 2 pass
   │
   ├─ M2a  Job submission in tension-core   (SEPARATE PLAN — not this one)
   │        apply.rs pending path, worker pool, back-pressure
   │
   ├─ M2b  a/b completion convention        (depends on M2a + this plan's §6.2)
   │
   └─ M3   Backend B / WasmFX               (depends on NOTHING here but time)
            blocked on: Windows support, continuation deallocation, and the
            fuel/epoch issues #14509/#14644 clearing upstream (wasmtime #10248)
```

**Blocking summary.** M0 done. M1a blocks both M1b and M1c, which are independent
and can proceed in parallel. M1d needs both. M2a is a separate plan in a separate
repo. M3 depends on upstream, not on us.

**What M1d proves and what it does not.** It proves suspension, resume,
lifted-local survival, wakeup dispatch through both callback slots, and both
negative controls — with zero production changes to `tension-core`. It does **not**
prove a real host job round-trips, because no job system exists. That is M2, and
saying so plainly is the difference between a green harness and a working feature.

---

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Local liveness for lifted locals is the real engineering risk, not the syntax | High | Conservative-first lifting (lift everything live before the first await); tighten only as an optimization; §8.2 assertion 3 guards it |
| State transition crossing a loop boundary leaves a dangling block label (`flow.ts:251,253,634,644`) | High | §4.5 case 6 — added beyond the architect's list; explicit compiler fixtures |
| A forgotten `status` check silently proceeds with a zero value (D1's named cost) | Medium | Runtime logs every non-zero status; `Async.expect` is the documented default |
| `onBatch` dispatch appears to work but misses batched completions | Medium | §6.1 is code-grounded; harness asserts a batched completion path, not only a direct one |
| The `a`/`b` convention is fixed unilaterally and later conflicts with the job system | Medium | Explicitly deferred to M2b; M1 uses a test-only convention |
| `await` becomes a language rule illegal in callbacks, blocking Backend B | Medium | D6(iii): it is a Backend A diagnostic only |
| Reading a completion payload lazily (after the ring slot is reused) | High if it happens | §3.2/§6.5 state payload capture as a dispatch obligation |
| AGENTS.md rule 1 vs building in `third_party/` | Medium | Out-of-tree build in `build/assemblyscript/` (§0.1) |
| Backend B's lack of `cont.drop` leaks continuations in a long-running game | Medium (future) | Noted as a real constraint in §5.1; a reason M3 is gated on deallocation, not merely on Windows |
| Renaming the package breaks the CLI test suite | Low | D11 defers renaming until after M1d |

---

## 13. What happens on approval (nothing before)

Nothing until the architect reviews this document. On approval, M1a is the first
implementation milestone, and it is dispatched as a separate implementation agent —
not by the plan author, and not in this turn.

**No code has been written for this plan. No lowering exists. No commits beyond the
fork setup commit.** The Tension working tree contains exactly two changes: the
staged submodule addition (`.gitmodules` + the gitlink, uncommitted per AGENTS.md
rule 2) and this document.
