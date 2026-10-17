# Async/await in TensionScript — PLAN v2 (revised)

**Status:** proposal, revised after independent review. **No code written. No
lowering implemented.**
**Supersedes:** `docs/async-await-plan-v2.md` as originally written (the reviewed
text). This file *is* that document, revised in place.
**Review addressed:** `docs/async-await-plan-v2-review.md` (written against the
arrow-`this` landing). §0.0 maps every finding to its disposition.

**Cited revision.** Fork `Yabgu/TensionScript` at submodule
`third_party/assemblyscript` = `92809069` ("test: rebaseline fixtures after ~env
delivery"), which contains the arrow-`this` work (`c4a16531` resolver,
`6aece91a`+`1dc6e395` codegen, `92809069` fixtures). Host tree at `c66f07f`
(main). Every citation below was re-resolved against these revisions — the
review measured drift of +8…+176 from the line numbers the first draft used, so
**do not trust a line number in the reviewed text; the ones here are current.**
Date of evidence: 2026-10-16.

---

## 0.0 Revision record — what the review changed

Ten findings from the task's list, plus the review's own sub-findings. Every one
is addressed; none is dropped. "No change" means the reviewed text survives
inspection and is now better cited.

| Review finding | Severity | Disposition | Where |
|---|---|---|---|
| 1.1 §5.3 does not encode a language rule | pass | **No change** — conclusion kept verbatim in intent | §4.6 |
| 1.2 §5.3 rationale rests on unpinned TS semantics; thin constructor contradicts it | major | **Revised** — semantics pinned (§1.2); the restriction is re-derived from stated rules, not from an unstated TS behaviour; the constructor now *invokes* the resume function so the synchronous prefix is real | §1.2, §4.1, §4.6 |
| 2.1 `a`/`b` offsets exist and are free *as bytes* | pass | **No change** for the offset fact | §3.1 |
| 2.2 `a`/`b` are not free *in meaning* — JOB_DONE/JOB_FAILED/RESOURCE_READY/DEVICE_LOST/INPUT carry assigned payloads | blocker | **Revised** — correlation scheme replaced; the runtime mints no ids and repurposes no words | §3.1, §6.2 |
| 2.3 the recommended encoding is circular (host cannot echo an id it was never told) | blocker | **Revised** — the id is the producer's submit-time id, which the guest already holds | §3.1, §6.2, D1 |
| 2.4 pointer-typed results contradict the adapter contract | major | **Revised** — `await` yields scalars; references come from the capability's own readers | §3.3, §6.2 |
| 3.1 the host uses neither epoch interruption nor fuel | major | **Revised** — §9.3 rewritten; the real preemption/yield model stated | §6.6, §9.3 |
| 3.2 `#14644` closed | minor | **Revised** — dated and dropped from the gate text | §9.3, §9.6 |
| 3.3 pinned wasmtime 24.0.13 has no stack switching; M3 is not "time only" | major | **Revised** — M3's gate is an engine re-pin plus three upstream items | §5.7, §9.6, §11 |
| 4.1 `Awaitable<T>` with `value: T` cannot be copied into by a dispatcher | major | **Revised** — the record is `T`-free and fixed-layout; `Task<T>` is a one-word handle; the typed read is emitted at the await site | §3.2, §3.3, §10.2 |
| 4.2 error/zero-value rules unpinned | major | **Revised** — result and error rules pinned, including null-for-reference-T excluded by 3.3 | §3.4 |
| 4.3 no reconciliation with `queueMeshLoad` + region readers | major | **Revised** — the async surface is registration over the shipped job id; the region readers stay the truth | §3.3, §7.2 |
| 4.4 five task semantics unpinned | major | **Revised** — sync prefix, floating tasks, double-await, re-await, ordering all pinned | §1.2, §3.4, §6.5 |
| 5.1 AST shape is right for both backends | pass | **No change** — citations refreshed | §2.1, §5.5 |
| 5.2 the resolver needs **two** cases; both switches `assert(false)` | blocker | **Revised** | §2.4 |
| 5.3 D10's custom-pass seam is post-codegen and cannot synthesize a managed class | blocker | **Revised** — the lowering moves to the `afterParse` AST stage; the core edit set shrinks | §0.2, §4.5, D9 |
| 5.4 parser table drift (`parseClassMember` line) | minor | **Revised** — table re-verified | §2.3 |
| 6.1 D9 contradicts the closures plan's single-storage rule | major | **Revised** — environment is referenced, never lifted | §4.4, §10.4 |
| 6.2 §4.3 "lift `this`" contradicts the shipped `capturesThis`/`~env` mechanism | major | **Revised** — `this` lives in the environment | §4.4, §10.4 |
| 6.3 task table must be a traced root | major | **Revised** — root chain stated as a requirement | §4.4, §10.4 |
| 6.4 closure deferral is explicit | pass | **No change** | §10.4, D7 |
| 6.5 §6.4's compile-time check duplicates the shipped runtime guard | minor | **Revised** — the shipped guard is the site; the async dispatcher must be a plain function because of it | §4.6, §6.7 |
| 7.1 `onBatch` contiguity / dispatch analysis | pass | **No change** — kept | §6.1 |
| 7.2 dropped completions hang a task | major | **Revised** — a rule exists, with a testable control | §6.4 |
| 7.3 the reentrancy rule is enforceable | pass | **No change** | §6.3 |
| 7.4 negative control 1 asserts a session error nothing produces | minor | **Revised** — the control asserts the named refusal in the transcript | §8.4 |
| 8.1 no new import/export needed | pass | **No change** — now an enumeration | §7.1 |
| 8.2 the harness cannot post a delayed completion without production code | blocker | **Revised** — the harness targets the OGRE pipeline; no production change | §7.3, §8.1, §8.2 |
| 8.3 payload capture is a dispatch obligation | pass | **No change** — kept as a rule | §3.1, §6.5 |
| 8.4 the ABI claim holds only while the convention is producer-defined | minor | **Resolved by construction** — the plan no longer assigns meaning to `a`/`b` | §3.1 |
| 9.1 OGRE ships a tested job pipeline; "nothing to await" is false | major | **Revised** — OGRE jobs are the target; M2 stops being a prerequisite | §7.2, §7.3, §11 |
| 9.2 stale `pending` doc comment used as evidence | minor | **Revised** — the claim is corrected against `adapter/ffi.rs` | §1.1 |
| 10.1 the harness compiles with the published npm package, not the submodule | major | **Revised** — §0.4 adds the publish-and-re-pin critical path, with the arrow-`this` precedent | §0.4, §11 |
| 10.2 fixture details (`process.stdout.write`, `frame_layout.rs`, skip policy) | minor | **Revised** | §8.3 |
| 10.3 Backend B is contingent on an engine bump, not on Windows alone | major | **Revised** | §5.7, §9.6 |
| 11.1 citations drifted after the plan was written | minor | **Revised** — all re-resolved; policy added | §0.5 |
| 11.2 external facts verified | pass | **No change** except `#14644` | §9 |
| 11.3 no build was run by the reviewer | note | **Stated** as a limit of this plan too | §12 |

---

## 0. Fork model and repository setup — DONE

Record, not proposal, except §0.4 which is new.

**Fork identity.** Detached fork of `AssemblyScript/assemblyscript`; `origin` =
`git@github.com:Yabgu/TensionScript.git`; upstream fetch-only with its push URL
disabled — mechanical, not a comment.

**Consumed by Tension** as a submodule at `third_party/assemblyscript`
(`.gitmodules` entry verified). **Current submodule HEAD is `92809069`** — three
commits past the base `b6bda05c` the reviewed draft named in its header:

```
92809069 test: rebaseline fixtures after ~env delivery — footprint reviewed
1dc6e395 codegen: deliver a captured `this` through a hidden environment global
6aece91a codegen: deliver a captured `this` through a hidden environment global
c4a16531 resolver: `this` in an arrow is the receiver of the enclosing function
b6bda05c chore: Update Binaryen and other dependencies (#3035)
```

`git diff --stat b6bda05c..92809069 -- src std cli lib` touches exactly four
files: `src/compiler.ts` (248 changed), `src/resolver.ts` (100), `src/program.ts`
(+4), `src/builtins.ts` (+1). That is the whole drift surface for citations, and
it is why §0.5 exists.

### 0.1 The AGENTS.md rule 1 conflict — restated, with the resolution

`AGENTS.md` rule 1 says `third_party/` is read-only, including "never generate
into". Building AssemblyScript requires `npm ci`, which writes `node_modules/`
**inside** the checkout. Resolution (unchanged from the reviewed draft):

> **The submodule holds source only and is never built in place.** The build runs
> in an out-of-tree scratch copy under `build/assemblyscript/`, already covered by
> `.gitignore`.

### 0.2 What commits are additions, and what commits touch core — REVISED

The reviewed draft put the lowering in `src/compiler.ts`'s custom-pass block.
The review showed that site is post-codegen, and that a state-struct **managed
class** cannot be synthesized there (§5.3 of the review; §4.5 below). The
lowering therefore moves to the **AST stage**, which changes both columns.

**Pure additions (new files, no upstream file modified):**

- `src/async/lower.ts` — Backend A, an AST→AST transform (§4.5). New file.
- `src/async/ir.ts` — the backend-agnostic intermediate record types (`AwaitSite`,
  `LiftedLocal`, `ResumePoint`) as *analysis results*, never AST fields (§5.5).
- `src/async/wasmfx.ts` — Backend B skeleton, not implemented in v2. New file.
- `std/assembly/task.ts` — the `Task<T>` handle class (§3.2). New std file, and
  the reason is precedent: the compiler already relies on a std generic wrapper
  for function values (`Function<T>`, `std/assembly/function.ts`, reached through
  `program.functionPrototype` / `Type.getClassOrWrapper`), so a std generic
  wrapper for task handles is the same shape, not a new mechanism.
- `tests/compiler/async_*.ts` + fixtures; `tests/parser/async_*.ts.fixture.ts`;
  `tests/transform/async_*.ts` — new.
- `tension-framework/tests/guest-async.ts`; `tension-core/tests/async_await.rs`
  (test-only, per §7.3) — new.

**Modifies core files (the irreducible set, now smaller):**

| File | Nature of edit | Why it cannot be additive |
|---|---|---|
| `src/ast.ts` | `NodeKind.Await`; `AwaitExpression`; `isAsync` on `FunctionDeclaration`; `Node.createAwaitExpression` | A new expression kind is *by definition* an AST change. |
| `src/parser.ts` | Consume `async` before `function`; parse `await` as a prefix expression; contextual diagnostics | Parsing requires parser edits. |
| `src/resolver.ts` | **Two** `case NodeKind.Await` arms (not one — §2.4) plus the call-site return-type transformation | `await` must propagate a want-type like any expression, and both expression switches assert on an unknown kind. |
| `src/extra/ast.ts` | `case NodeKind.Await` in the `ASTBuilder` serializer (`src/extra/ast.ts:109`, `:122`) | **Required companion edit** — without it the parser round-trip fixture fails immediately. |
| `src/diagnosticMessages.json` | New message keys | Backing for new diagnostics. |
| `cli/index.js` | **One line**: register the in-tree transform when the compiler option is set, in the existing transforms collection (`cli/index.js:403-449`) | Zero if the architect prefers `--transform <file>` per consumer (§0.2's note below). |
| `src/compiler.ts` | **One** `case NodeKind.Await`: the typed read of a lowered `await` (§4.7.4) and the diagnostic for an `Await` the lowering did not transform | `T` is a resolved type, and an `afterParse` transform cannot type the read (§4.7.4) |

**`src/compiler.ts` keeps one expression case, and it is not the state machine.**
The file **loses** its lowering role — no lowering registration, no state-struct
construction, no resume-dispatch codegen; the reviewed draft's `compiler.ts` row
is gone. What remains is a single `case NodeKind.Await`, doing two narrow things:

- **The typed read of a lowered `await`.** The value must come out of the task's
  record as `T`, and `T` is a *resolved* type: an `afterParse` transform neither
  has it nor can write it (§4.7.4 — `Task<any>` is not nameable, a bare `Task`
  requires its argument, and AS infers a call's type argument from arguments,
  not from context). So the lowered `AwaitExpression` survives to codegen: `T`
  from the resolver's Phase-2 arm, the value from the record at §3.2's offsets,
  the record pointer from the lowering (a side table keyed by node identity,
  §5.5). That is *reading*, not lowering — the parking, the resume-point
  bookkeeping and the state struct all belong to the transform.
- **A defensive diagnostic** for an `Await` node with no side-table entry — the
  case reports that the async lowering transform did not run instead of emitting
  garbage.

So `src/compiler.ts` is a member of the modifies list above for exactly this one
case, and for nothing else.

**Alternative with zero `cli/` edits.** Ship the transform file inside the
published package and select it with `--transform` — resolvable through
`require.resolve(filename, { paths: [process.cwd(), baseDir] })`
(`cli/index.js:405-436`) — and have `tension-framework/build.sh` emit it into the
generated `session.asconfig.json` (which `build.sh:130-165` already writes, and
which every OGRE example consumes via `--config`). The five non-`--config`
examples (`examples/{ai,audio,io,log,res}/package.json:8`) would each need one
flag. **Recommendation: the in-tree registration** (one line, versioned with the
compiler, covered by the fork's own `test:transform` script) — recorded as D9.

**A note on `CommonFlags`.** `src/common.ts:7-87` is a `const enum` whose last bit
is `InternallyNullable = 1 << 31` — **there is no free bit**. So `async` is a
dedicated field, not a flag (§2.1). Verified; unchanged from the reviewed draft.

### 0.3 Maintenance posture

We do not track upstream; we do not carry mergeability patches. The relevant
measured facts stand (upstream commits: 2022: 178, 2023: 77, 2024: 23, 2025: 32,
2026 to 2026-07-21: 22 — verified against the GitHub API). Naming (D11 in the
reviewed draft) is now partly settled in *practice*: the published package is
`@acakar/tensionscript`, while the fork's own `package.json` still says
`"name": "assemblyscript"`, `"version": "0.0.0"` — see §0.4.

### 0.4 NEW — Compiler provenance and the publish-and-re-pin critical path

The review's finding 10.1, and the reason this section exists: **the compiler the
harness uses is not the submodule.** It is a published npm artifact.

**Measured, on this tree:**

- Every consumer declares a dependency on the published package:
  **15 `package.json` files** (`examples/ai`, `audio`, `io`, `log`, `res`;
  `examples/ogre/{animated-character,bouncing-ball,bouncing-bodies,hello-mesh,
  hello-triangle,input-camera}`; `examples/solver/{collision,wasm,world}`;
  `tension-framework`) and **15 matching `package-lock.json` files**, each
  resolving `https://registry.npmjs.org/@acakar/tensionscript/-/tensionscript-0.1.0.tgz`.
- The framework's own harness compiles with
  `./node_modules/.bin/asc` (`tension-framework/tests/run.sh:85-86`), which is
  that package's `bin/asc.js`.
- The **published tarball already carries the arrow-`this` mechanism**:
  `@acakar/tensionscript@0.1.0` was published **2026-10-16T16:54:58Z** (a
  `0.0.0-stage` tag at 16:52:18Z), and its `dist/assemblyscript.js` has
  sha256 `fc79e90f…`, **byte-identical** to the copy in
  `tension-framework/node_modules/@acakar/tensionscript/dist/assemblyscript.js`.
- The fork's own `package.json` still says `assemblyscript` / `0.0.0`; the publish
  renames and versions the artifact (`publishConfig: { access: public }`,
  description "TensionScript: a TypeScript-shaped language for WebAssembly, forked
  from AssemblyScript for the Tension engine"). The fork has
  `scripts/prepublish.js`, which strips `scripts`/`devDependencies` from the
  published manifest.
- The published `files` list includes `bin/`, `dist/`, `std/`, `util/` — so a new
  std file (§0.2's `std/assembly/task.ts`) ships with the publish, and needs no
  per-consumer path.

**The critical path for every compiler change in this plan:**

| # | Step | Where | By whom |
|---|---|---|---|
| 0 | Land the change in the fork; submodule HEAD moves | `third_party/assemblyscript`, `Yabgu/TensionScript` | implementation agent (no commit — AGENTS.md rule 2) |
| 1 | Build the fork out-of-tree, publish a new version | `build/assemblyscript/` scratch; `npm publish` under `@acakar/tensionscript` | **architect only** — publishing is an external action |
| 2 | Bump the dependency in the 15 consumers; refresh the 15 lockfiles | `examples/**`, `tension-framework` | implementation agent (working tree) |
| 3 | Fresh installs so `node_modules` matches | each consumer | implementation agent |
| 4 | Only now can the harness run — against the *published* artifact | §8 | implementation agent |

**Precedent, verified (this is the arrow-`this` landing):** publish at step 1
happened before the repo commit that adopted it — `c66f07f` ("submodule bump,
consumers on @acakar/tensionscript", 2026-10-16T17:50Z) followed the
16:54Z publish, and its message records both halves. So the pattern is not
hypothetical; it is the pattern that shipped yesterday.

**Reproducibility requirement.** Because the harness tests the *published*
artifact, the harness must record **which compiler it tested**: `asc --version`
plus the fork SHA the artifact was built from, written into the guest's first
transcript line (the guest already has `print`, `io.ts:35`, and the host asserts
on captured stdout — §8.3). Without this, a green harness proves the artifact, not
the reviewed revision.

**Authorization note.** Step 1 is external publication. Per this project's
constraints it is the architect's action and is never taken unilaterally by an
implementation agent; the plan lists it because a plan that omits it would be
wrong about the critical path, not because an agent may do it.

### 0.5 Citation policy (new)

Every claim in this plan cites a file and, where the file is in this tree, a line
at the revisions named in the header. Where a line number could drift again, the
claim names the *symbol* as well as the line (e.g. "`declaredByFlow` sites,
`compiler.ts:5762`/`:7738`"). Any future revision of this plan re-resolves
citations at the then-current submodule SHA and records the SHA — the reviewed
draft's header named `b6bda05c` while citing a tree that had already moved to
`92809069`, which is exactly the failure this policy prevents.

---

## 1. Constraints this plan composes with

### 1.1 Host-side non-negotiables — corrected

Every item below is a property of `tension-core`, `tension-ogre`,
`tension-input` or `tension-framework`. None is proposed for change.

- **Two callback slots, resolved by table index.**
  `caller.get_export("table")` (`session/mod.rs:1233`); signatures
  `onBatch: (class_: u32, ptr: u32, count: u32) => i32` and
  `onEvent: (class_: u32, ptr: u32) => i32` (`runtime/callbacks.ts:41`, `:43`);
  `CALLBACK_SLOTS = 2` (`runtime/wire.ts:73`) and `CALLBACKS_SLOTS = 2`
  (`arena.rs:197`); the record's slot words at `CALLBACKS_ON_BATCH = 8` /
  `CALLBACKS_ON_EVENT = 12` (`arena.rs:192-193`); `CALLBACKS_SIZE = 64`
  (`arena.rs:431`).
- **No `_tension_event`.** Absent from the tree.
- **The session is not reentrant, and the two refusals differ.**
  `run_epoch_verb` takes the session out of the store and returns **`-EBADF`**
  when it is gone (`mod.rs:1321-1332`, `EBADF = -9` at `mod.rs:80`); verbs that
  do not take it out hit the depth guard and return **`-EBUSY`**
  (`depth_refusal`, `mod.rs:1345-1353`; `EBUSY = -16` at `mod.rs:78`). `EINVAL`
  is `-22` (`mod.rs:76`), `EIO` is `-5` (`mod.rs:82`). The reviewed draft wrote
  `-EBADF` as `-8` in one place; the value is **`-9`**.
- **`wait(0)` is the non-blocking drain, by definition.**
  `mod.rs:1370-1385`: "A zero timeout is exactly `EpochMode::DrainAll` … there is
  no verb for it, because `wait(0)` is one."
- **Jobs — restated precisely, because the reviewed draft conflated two things.**
  The *core's generic job machinery* is a stub: `apply::sweep_jobs_to_failed`
  (`apply.rs:263`) reports zero and says why, and the core has no job submission
  path. The *capability-owned job pipeline* is real, tested, and is what this plan
  targets (§7). Separately, the reviewed draft cited "the pending list is always
  empty" from a stale doc comment (`mod.rs:1476-1479`); deferrable adapter imports
  *called from inside a callback* are queued and applied
  (`adapter/ffi.rs:614-651`), so the comment is not evidence for anything.
- **The guest owns the frame loop.** The host calls `_start_game` once
  (`main.rs:1226`) and returns.
- **No preemption and no metering.** The only production engine is configured
  with `debug_info` and nothing else (`main.rs:573-575`); there is no
  `epoch_deadline`, `epoch_interruption`, `increment_epoch`, `set_fuel` or
  `consume_fuel` anywhere in `tension-core/src`. See §6.6 — this is a design
  input, not a footnote.

### 1.2 Language semantics this plan pins (new)

The review's finding 1.2 is that the reviewed draft derived a restriction from
TypeScript behaviour it never wrote down. These are written down. Each is a
language rule: true under both backends, enforced (or not) in the front-end, and
not a backend capability artefact.

1. **Synchronous prefix.** `async function f(): T` runs its body synchronously
   until the first `await` that actually suspends; only then does control return
   to `f`'s caller. A body with no `await` — or whose `await` operands are already
   completed (§2) — runs to completion before the call returns, and the returned
   `Task<T>` is already settled (`status == 0`). This is TypeScript's rule, and
   the reason to adopt it is the standing direction that TensionScript follows
   TypeScript: an author who writes `async function` and then observes that the
   first statement ran before the call returned is seeing TypeScript, not an
   approximation of it.
2. **Call-site type.** A call to `f` yields `Task<T>`; a call to a
   `Task<T>`-returning plain function yields `Task<T>`. `await` on `Task<T>` has
   type `T`.
3. **Floating tasks run.** An `async` call whose handle is never awaited still
   runs; `await` observes, it does not start. A settled, unreferenced task is
   garbage (§3.2).
4. **`await` is idempotent on a settled handle.** `await h` on a handle whose task
   is already settled returns the value immediately and does not suspend — which
   is what makes the no-`await`-in-the-prefix case above coherent, and what makes
   `await h; await h;` well-defined.
5. **One outstanding registration per key.** A second `await` on a *parked* task
   (reachable only if two awaits on one handle are in flight at once, which
   sequential source cannot express) is refused with a named error rather than
   producing two resumes.
6. **Deterministic order.** Within an epoch, deliveries are invoked class by
   class, ascending class id (`epoch.rs:14-22`), and a batch is contiguous in
   ring order (`epoch.rs:192-216`, `:237-240`). `runReady()` resumes in that
   order (§6.5).
7. **The callback-slot contract.** A function registered as `onBatch`/`onEvent`
   must return the ABI's synchronous status `i32` (`callbacks.ts:41`, `:43`) and
   must not be an `async` function — an `async` function's wasm-level result is a
   `Task<T>` handle (a reference), so registering one would hand the host a
   handle where it reads a status. This is a *host-ABI* rule, not a backend
   capability limit, and it is true under Backend A and Backend B alike (§4.6).

**Things this plan does not pin, and says so:** `nextTick()`/`nextFrame()`
ordering relative to each other within a tick (§6.5 names the rule it will need
when they are implemented), and cancellation (out of scope, §10.6).

---

## 2. AST changes

### 2.1 New AST nodes

**`AwaitExpression` — a new expression kind.** Modelled on
`UnaryPrefixExpression` (`ast.ts:1618-1629`), which is the existing precedent for
"one operator token + one operand":

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

- `NodeKind.Await` is added to the `const enum NodeKind` (`ast.ts:46-126`,
  currently 67 values; the `// expressions` block begins at `:58`).
- Factory: `Node.createAwaitExpression(operand, range)` alongside the existing
  factories (`ast.ts:139-762`, 76 of them — the reviewed draft said "~60 at
  100-900"; that was approximate and is corrected here). AS never `new`s AST nodes
  from the parser; the factory pattern is the rule.

**`isAsync` is a field, not a node kind, and not a flag bit.**

```ts
export class FunctionDeclaration extends DeclarationStatement {
  // ... existing fields ...
  /** Whether this function is `async`. */
  public isAsync: bool = false;
}
```

Why this shape, verified against the class hierarchy:

- `MethodDeclaration extends FunctionDeclaration` (`ast.ts:2215`) — one field
  covers functions and methods.
- `FunctionExpression` merely *wraps* a `FunctionDeclaration`
  (`ast.ts:1351-1359`) — arrow functions and function expressions are covered
  too, since they carry `arrowKind` (`ArrowKind` at `ast.ts:2080-2088`, field at
  `ast.ts:2105`) on the same node.
- `CommonFlags` has no free bit (§0.2) — a flag bit would require widening the
  word and touching every `is`/`isAny`/`set` site.

**What the AST deliberately does NOT carry.** No state ids, no resume-point
numbers, no lifted-local lists, no transition tables, no capture sets. Those are
lowering artifacts; they live in the transform's side tables keyed by node
identity (§5.5). This is the same discipline the closures plan reached
independently (`closures-plan.md` §2.1: "Closures add no new AST node and no new
AST field"), and it is what makes Backend B a swap rather than a rewrite.

### 2.2 Parser changes

**The tokenizer needs no change — verified, not assumed.**

- `Token.Async` and `Token.Await` exist: `tokenizer.ts:48-49`.
- `tokenFromKeyword` produces them: `tokenizer.ts:185-192`.
- They are already reserved: `tokenIsAlsoIdentifier` (`tokenizer.ts:356-378`)
  does not list them, so `let await = 5;` fails today. We add a *consumer* for
  tokens that currently produce parse errors.

**Parser hook points, re-verified at `92809069`:**

| What | Where | Edit |
|---|---|---|
| Function modifier | `parseTopLevelStatement` modifier loop `parser.ts:221-258`; `Token.Function` case `:287-292` | Consume `Token.Async` before `function`; set `isAsync` |
| Method modifier | `parseClassMember` `parser.ts:1916`; its modifier chain `:1983-2151`; params at `:2249` | Same, for class members |
| Declaration build | `parseFunction` `parser.ts:1475`, node built at `:1593` | Accept + record `isAsync` |
| Expression parse | `parseExpressionStart` prefix group `parser.ts:3695-3713` | Add `case Token.Await:` → `parseAwaitExpression` at `Precedence.UnaryPrefix` |
| Statement fallthrough | `parseStatement` `:2941`, default `:3028-3030` | Unchanged — `await` is an expression |

The reviewed draft's table pointed at `parser.ts:2209-2211` for the method
modifier; that range is the class-member *name* fetch (`Identifier_expected` at
`:2211`). The modifier chain is `:1983-2151`. Corrected here.

The prefix group at `:3695-3713` is where `Token.TypeOf`/`Void`/`Delete` are
handled; `await` joins it. `Token.Yield`'s fallthrough (`:3701`) stays exactly as
it is — we are not adding generators. `Token.New` is a separate case at `:3734`.

**Error paths that change.** Today `async`/`await` produce `Expression_expected`
(`parser.ts:4046`) or `Identifier_expected` (`parser.ts:1009`). After the change
they parse, and these diagnostics apply: `await` outside an `async` function; a
missing operand after `await`; `async` on a construct that cannot be async
(constructors, `declare`d functions — D12). Message keys go in
`src/diagnosticMessages.json` (`"Not implemented: {0}": 100` at `:2` is the
existing shape), and the generated enum is produced by `scripts/build.js`.

**Where "await outside async" is diagnosed — still an open implementation
choice,** and still recommended as (b) a backend-agnostic AST validation walk,
because the parser class keeps no context stack (`class Parser` at
`parser.ts:106`; its fields are source bookkeeping only: `backlog` `:109`,
`seenlog` `:111`, `donelog` `:113`, `currentSource` `:117`, `dependees` `:119`,
`currentModuleName` `:123`). But note the revision: that walk now has a natural
home — it is a *second pass of the same transform infrastructure* (§4.5), which
is a smaller change than the reviewed draft's separate mechanism.

### 2.3 Resolver changes — TWO cases, not one

The reviewed draft said "exactly one new expression case". There are **two**
expression-kind switches over `NodeKind`, and **both end in `assert(false)`**:

- `lookupExpression` — `resolver.ts:935`, switch at `:948`, `assert(false);
  return null;` at `:1049-1050`.
- `doResolveExpression` — reached from `resolveExpression` (`:1057`), defined at
  `:1076`, switch at `:1085`, `assert(false); return null;` at `:1186-1187`.

`lookupExpression` is called on the *target* of property and element access
(`:1322`), on assertion operands (`:1719`), on element-access bases (`:1768`), and
from the compiler's own property paths (`:2568`, `:2634`). So `(await h).value` —
the most ordinary thing an author writes — reaches `lookupExpression` with a
`NodeKind.Await` node and **aborts the compiler** if the second arm is missing.

**Both arms are mandatory**, and M1a's task list carries both. The arms are
small:

```
case NodeKind.Await:
  // operand resolves to Task<T> (or any Task<T>-typed expression);
  // the await's type is T; propagate T as the operand's want-type.
```

**The return-type transformation is a resolver concern, not a backend concern**
(unchanged from the reviewed draft, and worth restating): `async function f(): T`
*declares* `T`; a call to `f` yields `Task<T>`; `await` on a `Task<T>` yields `T`.
This mirrors TypeScript (`async function f(): T` is callable as `() => Promise<T>`).

**Verified mechanics note.** Function types are `Signature` (`types.ts:934-1200`),
interned by `signature.toString()` in `program.uniqueSignatures`
(`program.ts:484`). The `async` trait must therefore **not** be encoded in the
`Signature` string — two functions differing only in `async`-ness would collide in
the intern table.

### 2.4 Type checker: `Task<T>` and no `Promise`

AS has no `Promise`. `Task<T>` is the handle type, and — revised from the
reviewed draft — it is **std source, not a synthesized built-in**:

- `std/assembly/task.ts` declares `@final export class Task<T>` with a single
  **managed reference** to `TaskRecord` — §3.2's wording governs, not the
  reviewed draft's "single opaque `usize` field". The change is a correctness
  one, not a cosmetic one: a `usize` field is not traced by the
  compiler-generated visitor (the `fieldType.isManaged` arm,
  `builtins.ts:10951-10962`), so a handle the guest keeps across a suspension
  would be the only path to the record and the collector could not see through
  it — the record, its state struct and its environment could be collected while
  the task was parked. `TaskRecord` is an empty managed base class in std, and a
  capability subclasses it (`class JobTaskRecord extends TaskRecord { … }`), so
  one handle type still covers every `T` (§3.2). Its runtime layout is
  **identical for every `T`**; the
  type argument exists for the type checker, exactly as `Function<T>`'s does
  (`std/assembly/function.ts`: `_index`, `_env`, with `_env` traced by `__visit`).
- Per-instantiation memoization is the existing class machinery: `instanceKey`
  and `getResolvedInstance` for functions (`resolver.ts:2878`, `:2885`, `:2902`,
  `:3022`) and the class path (`resolver.ts:3222` `resolveClass`, `:3232-3247`).
- Because it is source, the resolver needs **no class-synthesis entry point** —
  the reviewed draft's "synthesized built-in generic class" would have needed one,
  and the fork does not have one (§4.5).

**`Awaitable<T>` is deleted from the design.** One handle type, one name. The
reviewed draft's two names for one job (a `Task<T>` for call results and an
`Awaitable<T>` with `value: T` for handles) is what produced the
"generic field in a fixed-layout record" error the review caught.

**`AsyncStatus` is not a type.** It is the errno vocabulary the `status` field
carries (§3.4): the same values the capability's own readers return
(`jobError`, `ogre/index.ts:280-283`), unchanged.

---

## 3. Await operand and result semantics — rewritten

### 3.1 The correlation scheme, chosen and justified

**Chosen: the runtime mints no ids. A task is keyed on the producer's
submit-time id, which the guest already holds.**

Concretely, for the classes this plan awaits:

- `JOB_DONE` / `JOB_FAILED`: `a` = the job id, and it is exactly the id the queue
  verb returned to the guest (`loader.cpp:439` for `JOB_DONE`; `:433-436`,
  `:504-507`, `:718-720` for `JOB_FAILED`; the queue verbs at
  `ogre/index.ts:230-241`).
- `RESOURCE_READY`: `a` = the renderer's resource id (`adapter.cpp:340`).
- `b`, `f0`, `f1`, `flags` are copied verbatim and interpreted by nobody at copy
  time (§6.2).

The runtime's task table is keyed `(class-family, a)` where the job family is the
pair `{JOB_DONE, JOB_FAILED}` — so a failure resolves the same await, which is the
reviewed draft's own good idea ("failure is carried by the class id, not by a
flag") now grounded in real payloads.

**Why the alternatives were rejected, against the frozen layout:**

- **(a) A new completion class — rejected.** An 11th class breaks the
  `SessionInfo` layout: capacities occupy `48..88` and the nonce sits at `88`
  (`SESSION_INFO_CLASS_CAPACITY = 48`, `SESSION_INFO_OPEN_NONCE = 88`,
  `arena.rs:96-97`), pinned by the assertion
  `SESSION_INFO_CLASS_CAPACITY + CLASS_COUNT * 4 == SESSION_INFO_OPEN_NONCE`
  (`arena.rs:1326`, comment: "The ten capacities and the nonce fit, with eight
  reserved words"). A class count of 11 forces the nonce to move — a `SessionInfo`
  *field offset* change, and field offsets are hashed into `layout_hash` by the
  field tables `CONTROL_FIELDS` (`arena.rs:1131`), `SESSION_INFO_FIELDS` (`:1149`)
  and `EVENT_FIELDS` (`:1099-1107`). That is a format/ABI bump,
  a `tension-framework` layout regeneration and a capability rebuild — precisely
  the host change this plan must not require. Worse, a class nothing produces
  would never fire: the ten classes are the *producers'* vocabulary.
- **(b) A correlation word in padding — impossible.** The record is exactly 32
  bytes with no padding: `seq` 8, `class` 4, `flags` 4, `a` 4, `b` 4, `f0` 4,
  `f1` 4 (`arena.rs:124`, `:147-150`; guest-side asserts at `wire.ts:351-358`).
  Every word is producer-owned: `a`/`b` as above, `flags` by input
  (`INPUT.md:377-382`, and `flags` offsets are hashed) and `f0`/`f1` by any float
  producer.
- **(c) A host-assigned task id — circular as stated, and unnecessary as
  realized.** For the *host* to echo a runtime-minted id, something must carry
  that id inward. Nothing does: `post_event` is producer→queue
  (`adapter/ffi.rs:1082-1120`), and no import lets a guest bind a key to a future
  completion. The workable form of (c) is "the id is assigned by the party that
  will report it — the capability, at submit time" — which is exactly the chosen
  scheme.

**Justification against the frozen layout.** The chosen scheme reads only fields
the layout already defines and hashes; it adds no field, no class, no schema bump
and no ABI change, and it requires no change to any producer. The runtime's
obligation stays what the reviewed draft correctly stated it must be — copy the
words out of the record during dispatch (§3.2, §6.5) — with the type-free
extension that the words' *meanings* belong to the producer.

**One honest limitation, stated:** today's producers emit at most one terminal
completion per key (the loader's job has one terminal transition,
`loader.cpp:427-440`; the renderer's `RESOURCE_READY` is posted once,
`adapter.cpp:340`). A future capability that completes one key more than once
would need a discriminator, and — because `flags` and the payload words are
producer-owned — the discriminator belongs *guest-side*, in the task record's
await tag (§3.2), not in the record.

### 3.2 The on-heap representation the dispatcher can copy

This is the review's finding 4.1 answered concretely.

**`TaskRecord` — fixed layout, `T`-free, one per task** (framework source; the
fields mirror the record's payload words verbatim plus the runtime's own state):

| Field | Offset | Meaning |
|---|---|---|
| `class_` | 0 | the class the completion arrived as |
| `key` | 4 | = the record's `a`; the producer's id |
| `payload` | 8 | = the record's `b`, verbatim |
| `status` | 12 | 0, or the errno (§3.4) |
| `f0` | 16 | = the record's `f0` |
| `f1` | 20 | = the record's `f1` |
| `tag` | 24 | the await tag (§3.1's limitation); 0 today |
| `done` | 28 | 0 = parked, 1 = settled |

**The dispatcher's copy is therefore type-free and total:** for each delivered
record, `class_ ← record.class_`, `key ← record.a`, `payload ← record.b`,
`f0 ← record.f0`, `f1 ← record.f1`, then `status ← ` derived from the class
(§3.4) and `done ← 1`. No `T` is known or needed. This is what makes the copy
cheap enough to be a dispatch obligation rather than a deferred read (§6.5) — and
deferring it is exactly the corruption §3.1 of the review's finding 8.3 confirms.

**`Task<T>` is a one-word handle** (`std/assembly/task.ts`): a managed reference
to the owning `TaskRecord`. Instantiations differ only in the type argument; the
layout is identical for every `T` (precedent: `Function<T>`).

**Where the typed value comes from — the typed read is emitted at the await
site**, because that is the only place `T` is known:

| `T` | Emitted read |
|---|---|
| `i32` / `u32` / `bool` | `rec.payload` (reinterpreted) |
| `f32` | `rec.f0` |
| `f64` / `i64` / `u64` | `rec.f0`/`rec.f1` as a 64-bit pair |
| reference types | **not supported in v2** — see §3.3 |

**Ownership and lifetime.** The `TaskRecord` is a *managed* object; the runtime's
task table holds the only strong reference while the task is parked (a managed
global — the root chain is §4.4), and the awaiting state struct holds a reference
too. A settled task with no remaining reference is ordinary garbage. Nothing here
is `@unmanaged`: an unmanaged record would not be traced, and the environment it
must keep alive (§4.4) would be collected under a suspended task.

### 3.3 The API surface, reconciled with what ships

The reviewed draft introduced `load_mesh(...)` and an `Awaitable` with no stated
relation to the shipped job API. The revision is a *registration over the
existing id*:

```ts
// Shipped today, unchanged (ogre/index.ts:230-241, :268-283):
const job: i32 = ogre.queueMeshLoad("resources/meshes/Barrel.mesh", 0); // id, or -errno

// The async surface — a thin registration over that id (framework):
const h: Task<u32> = rt.job(job);        // parks the caller on {JOB_DONE, JOB_FAILED} @ a == job
const resource: u32 = await h;           // suspends; resumes at runReady() with jobResult(job)
if (h.status != 0) { /* recover */ }     // or Async.expect(h), which traps

// The region readers remain the truth (DESIGN.md:1840-1848):
ogre.jobState(job); ogre.jobResult(job); ogre.jobError(job);
```

And the sugar is a plain function, not a second truth:

```ts
export function loadMesh(name: string, priority: i32 = 0): Task<u32> {
  const job = ogre.queueMeshLoad(name, priority);
  return rt.job(job);   // a refused queue call becomes an already-settled failed task
}
```

`loadMesh` is *not* `async` — it returns a `Task<u32>` directly — which has a
useful consequence for the milestones: `await` must work on any `Task<T>`-typed
expression, not only on a call to an `async` function, and that is testable before
Backend A's function lowering is complete (§11, M1b).

**Reference-typed results — the ruled-out path, stated.** The producers cannot
supply guest pointers: an adapter must not call the guest and must not touch guest
memory outside `publish`/`apply`/an import call (`tension-ogre/DESIGN.md:1850-1853`),
and the shipped loader reports a *host* resource id, which the guest maps to a
record and a handle (`ogre/index.ts:268-283`). So `await` yields a scalar, and a
reference is obtained from the capability's own reader at the await site. If a
future capability wants `await` to yield a reference directly, the mechanism is a
per-capability reader registry consulted by the lowering — named here as a
future extension, not smuggled in.

### 3.4 Error model: rejection is a status on the result

AS has no `try`/`catch` (`AS100: Not implemented: Exceptions`; `try`/`catch`
fails to compile in this fork). The model is unchanged in shape from the reviewed
draft — **(b) status on the handle, value is the type's zero on failure** — and
pinned where the review found it unpinned:

- **Where the status lives.** `TaskRecord.status` @ 12 (§3.2), read through the
  handle: `h.status`.
- **Where it comes from.** Derived by the dispatcher from the class: the failure
  classes are `JOB_FAILED` (1), `RESOURCE_FAILED` (2), `SUBMISSION_REJECTED` (3),
  `DEVICE_LOST` (0) — class ids at `arena.rs:202-213` — and for the job family the
  errno is the producer's `b` (`loader.cpp:433-436` posts `-ENOSPC`;
  `:504-507`, `:718-720` post the sweep's errno). `status` is therefore a
  capability errno, the same vocabulary `jobError` returns
  (`ogre/index.ts:280-283`) — no new error type.
- **The value on failure.** For scalar `T`, the zero of `T` (§3.3's read table).
  Reference-typed `T` does not exist in v2, so the review's "null dereference"
  hazard is removed by construction rather than documented.
- **The named cost is unchanged and restated:** the model is forgettable. A caller
  who ignores `status` proceeds with a zero. Mitigations: the runtime logs every
  non-zero status at the moment it is set (through the framework's logger, which
  the host routes — `io.ts:47-56`); `Async.expect(h)` traps with a diagnostic and
  is the documented default in the framework's examples.
- **Lifetime of `status`.** `status` is per-task and is not cleared by `await`;
  re-awaiting a settled handle (§1.2 rule 4) returns the same value and the same
  status. A *new* await reuses the record only after the previous one is settled
  and read (§6.5's parking rules), and the runtime zeroes `status` at park time.

### 3.5 What `await` costs

One registration (`rt.park`), one comparison at resume, and — for the common
scalar case — one load. No allocation per await on the happy path: the
`TaskRecord` belongs to the task (allocated once, with its state struct), and
`Task<T>` handles are per-await only if the source creates one. The framework's
`rt.job(job)` does create one small managed object per registration; that is
stated as the honest cost rather than hidden behind "zero-allocation".

---

## 4. Lowering Backend A: state machines

### 4.1 Shape, with the synchronous prefix made real

An `async function f(): T` with body `B` lowers to three artifacts:

1. **A resume-point enum** — one value per suspension point in `B`, plus entry and
   terminal values. Numbered by the transform, stored in its side table (§5.5),
   **not** on the AST.
2. **A state struct** — one field per lifted local, one per live parameter, the
   environment reference (§4.4), the `TaskRecord` reference, plus `resumePoint`
   and `status`.
3. **A resume function** — `f_resume(state: StateStruct): void`, whose body is `B`
   with each `await` replaced by a state transition:

```
state.resumePoint = K
rt.park(state.record, awaitable)     // registers (class-family, key) → record
return                               // back to the caller of f_resume
// ... re-entry here on resume:
// dispatch jumps to case K
case K:                              // the value now lives in state.record
  <continue with the await's value>
```

**The entry function, and the reconciliation the review demanded.** The reviewed
draft called `f` "a thin constructor … and returns the handle", which contradicted
the synchronous-prefix semantics it relied on elsewhere. Under §1.2 rule 1 the
entry is:

```
f(args): Task<T> {
  state = new StateStruct(args)      // resumePoint = 0
  rt.register(state)                 // the task table takes the strong reference
  f_resume(state)                    // ← the synchronous prefix runs HERE, inline
  return state.handle                // may already be settled (rule 1)
}
```

So `f` is thin in the sense that *the body is not in it* — and not lazy in the
sense that matters: the prefix executes before `f` returns, and if it suspends,
the task is parked and `f` returns the handle. That single change is what makes
§1.2 rule 1 true of this lowering, and it is why the §5.3 rationale in the
reviewed draft could be re-derived (now §4.6) rather than merely re-asserted.

### 4.2 How awaits become state transitions

Unchanged from the reviewed draft, and still the single most important mechanical
fact: the await's *result* is routed through the state struct, not a wasm local.
Wasm locals do not survive the return to the scheduler; only memory does. Each
`await` becomes: evaluate the operand → store its record reference in the state
struct → set `resumePoint` → park → return → on re-entry, read the record (typed
read at the await site, §3.2) as the value of the `await` expression.

### 4.3 How locals are lifted

**Precedent exists in the codebase.** `ShadowStackPass`
(`src/passes/shadowstack.ts`) already moves locals into a per-function memory
frame: `SlotMap = Map<LocalIndex,SlotIndex>` (`shadowstack.ts:157`), `slotMaps`
(`:190`), `noteSlot(func, localIndex)` (`:222`), and a header comment documenting
the frame layout (`shadowstack.ts:18-77`). It is a *stack* transform for a
different purpose, but the mechanism — enumerate locals, assign slots, spill
through memory — is what lifting needs.

**Lifting rule for Backend A:**

- A local is lifted if it is live across any `await`; start conservative (every
  local declared before the first `await` in its scope), tighten later as a pure
  optimization.
- Parameters live across an `await` are lifted; the resume function's parameter
  list is empty and it reads them from the state struct.
- **`this` is NOT lifted** — §4.4. The reviewed draft's "lift it" bullet is
  struck: `this` in a capturing function already has a home in the environment.

### 4.4 Storage: one home per binding, and the root chain

This is the closures plan's rule, adopted here because the two features must be
designed once (`closures-plan.md` §0.4, §2.3):

> **A captured binding's storage *is* the environment.** A local that is captured
> by any closure has exactly one home — an environment field — and is therefore
> never a wasm local and never a state-struct field.

The storage rule for every binding, decided once, in one place:

| Condition | Home |
|---|---|
| captured by any closure (`this` in an arrow included) | **environment** (guest heap, managed) |
| else live across an `await` | **state struct** (guest heap, managed) |
| else | **wasm local** |

**Capture wins over lifting, so the two never overlap.** The state struct holds a
*managed reference* to the environment — never a copy of a captured binding. The
reviewed draft's D9 said the captured environment "would also have to be lifted";
that is struck, and it is the specific change that keeps
`let n = 0; const f = () => ++n; await x; f();` from having two `n`s.

**`this` — the shipped mechanism, cited.** In the current fork, `this` in a
capturing arrow is delivered through the environment, not lifted: the resolver
marks `capturesThis` on the prototype (`resolver.ts:2208-2217`), the field is
declared on `Function` (`program.ts:3698`), consumed at `compiler.ts:1919`,
`:7462` and `:7613`, and the indirect-call site hands the callee's `_env` through
a hidden global (`makeCallIndirect`, `compiler.ts:7150`; the global is declared at
`builtins.ts:129`). So the async rule is simply: `this` is a captured binding
under the storage table above, and it needs nothing async-specific.

**The root chain — a requirement, not an implementation note.** Under
`--runtime incremental` — which is what Tension's guests build with
(`tension-framework/build/session.asconfig.json`: `"runtime": "incremental"`) —
the collector's roots are `__visit_globals(cookie)` plus the pin space
(`std/assembly/rt/itcms.ts:155-164`) and a conservative word-by-word scan of
`[__stack_pointer, __heap_base)` (`:167-173`). A suspended task's wasm frame is
gone, so:

> **task table (a managed global, traced by `__visit_globals`) → the task's state
> struct (`TaskState`, managed) → its record (managed, through the state's
> `record` field or the handle's `_record`) and its environment (managed) →
> captures.**
>
> The middle of that chain is stated the way it is implementable: the table's
> element is the *state* (§4.7.3), because §3.2's record has no spare word for a
> state reference, and the record is reached from the state. What matters is
> unchanged — every link is a managed field, so the collector sees through all of
> them, and the handle a guest holds is itself a second traced path to the record
> (`Task<T>._record`, §2.4).

Every link must be a managed field or the collector cannot see through it. This
rule is backend-neutral for the reason the closures plan gives
(`closures-plan.md` §0.5): under Backend B the frame exists but is a fiber stack
that `visitStack` does not cover, so roots are still the only way.

**Case 6 (`await` inside a closure) and `this`: unexercisable today, and why.**
The storage table's first row is the one no lowered program can reach yet. A
captured binding's home is the environment, and the state struct is to reference
the environment — but nothing in this fork can put a capture into an async body:

- **`this`** is supplied only by a method, and async methods are refused by name
  ("async methods (async lowering)"); an `async function` body that writes `this`
  is refused too ("this in an async function body"), because a free function has
  no `this` to capture.
- **A closure** inside an async body is refused by name ("a nested function in an
  async function body"), because closures are unimplemented — `CommonFlags.Closure`
  exists and is dead (§D7), and the only capturing construct that resolves today
  is an arrow inside a *non-async* function (the shipped `capturesThis` path).

So case 6 is deferred to the phase after closures land, and the deferral is
mechanical rather than editorial: when a capture becomes possible, the state
struct gains one managed reference to the environment (never a copy of a binding,
per the rule above), and `this` continues to need nothing async-specific. The
commit that lands closures is also the commit that makes this row testable.

**Where the state struct lives — unchanged from the reviewed draft, and still
right.** Guest heap, managed, never `@unmanaged` (a lifted reference would be
collected under a parked task otherwise). Rejected: wasm stack (the frame is
gone); static (one live instance per function — two concurrent awaits of the same
operation would corrupt each other); arena (fixed regions under a layout hash —
`layout_hash()` hashes the region table and the field offsets, and the only
plausible region is `JOB`, 48 KiB, `arena.rs:295`, `:341`, which belongs to the
capabilities, not the compiler).

### 4.5 The seam: the `afterParse` AST stage, not the custom-pass block — REVISED

**What the review found.** D10 of the reviewed draft recommended registering the
lowering in `src/compiler.ts`'s custom-pass block, described as a place where
"both backends operate on resolved, typed code". That block is:

```
// Run custom passes
if (hasShadowStack) {
  this.shadowStack.walkModule();
}
if (program.lookup("ASC_RTRACE") != null) {
  new RtraceMemory(this).walkModule();
}
```

(`compiler.ts:778-784`) — the *end* of `Compiler#compile()`, over the finished
Binaryen `Module`. Its two occupants are Binaryen passes (`Pass` base constructed
from a `Module`, `src/passes/pass.ts:1257`; `ShadowStackPass.walkModule`,
`shadowstack.ts:575`). At that point there is no AST, no `Local` element, no
`Flow`, and no `Signature`, and there is **no supported entry point to synthesize
a new managed class**: `Node.createClassDeclaration` (`ast.ts:464`) is used only
by the parser (`parser.ts:1820`, `:1880`); `new ClassPrototype(` appears once, in
the parser path (`program.ts:2046`); `Resolver#resolveClass`
(`resolver.ts:3222`) materializes *instances of existing prototypes*
(`:3232-3247`). Hand-writing a state struct at the Binaryen stage would mean
reproducing AS's object header, mmInfo, typeid and `__visit` linkage by hand.

**The seam this plan uses: an `afterParse` AST→AST transform.**

- The hook exists and runs **before** the program is instantiated: `Transform`
  with `afterParse(parser)` / `afterInitialize(program)` / `afterCompile(module)`
  (`cli/index.d.ts:246-284`; `afterParse` at `:277`), applied at
  `cli/index.js:697-701`, and `initializeProgram` runs after it (`:708-719`).
- It sees the **whole parsed program**: `parseBacklog` drains the import backlog
  transitively (`cli/index.js:612-633`, re-reading `getBacklog()` each iteration),
  and the hook sits after that first drain (`:691-701`). The CLI then runs
  `parseBacklog` once more (`:703-706`, commented "Parse additional files, if any")
  before `initializeProgram` (`:708-719`) — so a transform that queues sources of
  its own is also covered, and one that only rewrites what it was handed (this
  plan's lowering) is unaffected.
- **Injected declarations are resolved and compiled by the normal pipeline**:
  `program.initialize()` walks every source's `statements` in order
  (`program.ts:1102-1113`, "initialize relevant declaration-like statements of the
  entire program"), so a class and function synthesized into a source before
  initialization become ordinary elements with ordinary layout, `__visit` and
  typeinfo. The factories the parser itself uses are available to a transform:
  `Node.createClassDeclaration` (`ast.ts:464`),
  `Node.createFunctionDeclaration` (`ast.ts:633`),
  `Node.createMethodDeclaration` (`ast.ts:655`).
- Function *bodies* are resolved lazily at compile time, and
  `maybeCompileEnclosingSource` (`compiler.ts:7552-7561`) finds the enclosing file
  through `node.range.source.internalPath` — so injected nodes must carry a range
  whose `source` is a registered `Source` (use the file being lowered).

**Consequences, stated as consequences:**

- The lowering is `src/async/lower.ts` — a pure addition, versioned with the
  compiler, selectable by a compiler option (D9). The in-tree registration is one
  line in the existing transforms collection (`cli/index.js:403-449`).
- **`src/compiler.ts` is no longer a lowering site** (§0.2). What remains is a
  defensive diagnostic for a surviving `Await` node.
- Backend B is a sibling transform (or a codegen-side switch), selected by the
  same option — the swap story is now structural, not aspirational.
- **Implementation trap, recorded:** `program.initialize()` walks statements in
  array order, so the synthesized state-struct class must be inserted *before*
  the function that uses it in that source's `statements`.

### 4.6 What is a Backend A capability restriction, and what is not — re-derived

The reviewed draft's conclusion was right and is kept: **"await is illegal inside
a callback" must NOT become a language rule** (reviewed text, and the review
confirmed it as a pass). What changes is the derivation. It no longer rests on
"you cannot suspend a wasm frame the host called into" — which does not describe a
state machine, whose suspension is a *return*, not a stack suspension. Under the
semantics pinned in §1.2, the honest derivation is:

1. **A suspension is a return from `f_resume`.** No wasm frame is ever left
   suspended: the caller's frames unwind normally, and the task's state lives on
   the heap. A task may therefore be parked while a host-invoked callback is on
   the stack — the callback returns normally, the host completes its epoch, and
   the resumed portion runs later, outside the callback.
2. **What the runtime forbids is resuming inside a callback** — not awaiting in
   one. `runReady()` refuses while `inCallback` is set (§6.3), because a resume
   that ran inside a callback would put the session's epoch machinery under a
   callback's verb calls, which the reentrancy rules refuse anyway
   (`-EBADF`/`-EBUSY`, §1.1).
3. **What a callback cannot do is be `async`** — §1.2 rule 7. Its wasm-level
   result would be a `Task<T>` reference where the host reads a status. That is a
   host-ABI contract, true under both backends.
4. **What the synchronous prefix inherits is its caller's context** — so a prefix
   that runs inside a callback sees the callback's reentrancy refusals. That is a
   consequence of §1.2 rule 1 plus §1.1's reentrancy, not a new rule.

**Therefore, for the front-end:** nothing about `await`'s *legality* differs by
backend, and no `await`-specific diagnostic may be encoded in the parser or the
resolver (D6(iii) of the reviewed draft, retained). The checks that do exist live
where the fact exists: the framework's callback record guard
(`callbacks.ts:33-35`, §6.7), and the runtime's `inCallback` guard (§6.3). Backend
B's difference — `suspend` transfers control to the suspension's handler rather
than unwinding the frame, so the timing of the host's `callback.call(...)` return
is the handler's business — is named but **not decided here**, which is precisely
what keeps this a capability question rather than a language one.

---

### 4.7 The seam: what the transform names, and who implements it — NEW

§4.1 writes `rt.register(state)` and `rt.park(state.record, awaitable)` without
saying where `rt` lives, and §6 describes the runtime's behaviour without saying
which file it is in. This section pins that, because commit 3 emits the first
these calls and the shape must not be chosen by accident.

#### 4.7.1 What the transform needs

Four entry points, one of them problematic (§4.7.4):

- **`register`** — create the task's record, root it, hand back the handle
  (§4.1 artifact 3).
- **`park`** — register `(family, key) → the task's record` in the table and mark
  the task parked (§6.5).
- **`settled`** — §1.2 rule 4's check on an awaited record, so a settled handle
  does not suspend.
- **the value read** — the awaited value, at the await site.

#### 4.7.2 The module, and why it is top-level in `std`

**`std/assembly/task-rt.ts`** — internal path `~lib/task-rt.ts`, a *top-level*
standard-library file, not `~lib/task/rt.ts` as the plan's prose has been
assuming. The reason is mechanical, not stylistic:

- Top-level `std/assembly/*.ts` files are parsed by every build before anything
  else (`cli/index.js:471-479`), and their exports resolve as bare identifiers
  in any source through the program's global element index
  (`resolver.ts:1301`, the same fallback that makes `Task` itself resolvable —
  `program.ts:559-567`). Measured: a guest calling a function exported by a
  top-level std file compiles with no import statement.
- A sub-directory module is parsed only on demand, and **demand cannot be
  created from the transform**: an import injected into an already-parsed source
  is not queued, and the CLI's second `parseBacklog` drains only what the parser
  queued (`cli/index.js:703-706`). Measured: an injected import naming an
  unparsed `~lib/` module does not resolve, and the compiler trips an assertion
  instead of reporting a diagnostic.

**How the transform references the symbols: by their declared global names, with
no import.** The alternative — injecting `import * as rt from "~lib/task-rt"`
into every lowered source — works for a *parsed* module but buys nothing the bare
name does not, and costs an observable AST edit per file. The cost of bare names
is shadowing, and the transform already refuses a synthesized name a user
declaration took (commit 2); the same check extends to these names.

#### 4.7.3 The symbols, and the split of work

| Symbol | Implemented by | Called by |
|---|---|---|
| `TaskState` (base class, `record!: TaskRecord`) | std | every lowered state struct extends it |
| `__taskRegister(state: TaskState): TaskRecord` | std | the entry, once |
| `__taskPark(state: TaskState, awaited: TaskRecord): void` | std | `f$resume`, at each suspension |
| `__taskSettled(record: TaskRecord): bool` | std | `f$resume`, before suspending |
| `__taskDeliver(class_: i32, a: i32, b: i32, f0: i32, f1: i32): void` | std | the framework's dispatcher (§6.1) |
| `__taskTick(): void` | std | the framework's frame loop (§6.3) |
| `__taskBindRecordFactory(factory: () => TaskRecord)` | std (hook) | the framework, at startup |
| `__taskBindFamily(class_: i32, family: i32)` | std (hook) | the framework, at startup |

**Three corrections to the table, made against the frozen record.** `__taskPark`
takes the *state*, not the record: the runtime's table must hold something a
resume can be dispatched to, and §3.2's record is `T`-free and fixed-layout with
no spare word for a state reference — so the table's element is the state struct,
not the record. That requires a common base type for the state structs (the table
cannot be generic per function), hence **`TaskState`**: an ordinary managed class
with the one field every state struct needs, and the reason every lowered state
struct is `class f$State extends TaskState`. And **`__taskValue<T>` is deleted**:
§4.7.4 moved the typed read into codegen, because `T` is a resolved type that no
`afterParse` transform can name, so nothing calls it.

**std implements the machine**: the task table (`Map<i64, TaskRecord>`, keyed by
family in the high word and the producer's `a` in the low one — §3.1), the
per-record reads and writes at §3.2's byte offsets, the ready queue and its
ordering (§1.2 rule 6, §6.5), the dropped-completion rule (§6.4), and the
`__taskValue` read (§3.2's kind table implemented once, with `load<T>`).

**The framework connects it to the host**: it owns the record subclass (the
subclass *is* §3.2's layout — std only depends on the offsets), the class→family
map for its capabilities (bound through `__taskBindFamily`; unbound classes are
their own family, which is correct for a class that completes once), and the two
call sites — `onBatch`/`onEvent` decode the 32-byte record from the arena and
call `__taskDeliver` (§6.1, §6.2), and the guest loop calls `__taskTick` (§6.3).

**Deviation from D9's parenthetical, reported.** D9 says the framework provides
the implementation. It cannot: a `declare`d function in std with no body is an
*import*, which §7.1 forbids; and there is no linking mechanism for "std declares,
the framework defines" other than the name-based one the compiler itself uses for
`__new` (`program.requireFunction(CommonNames.new_)`, `program.ts:734`), which
needs the *implementer's* source in the program — fine for `__new`, but it would
make every lowered program depend on the framework being linked, and the
compiler's own tests (§8.1's first harness) must compile lowered code without a
framework. So std carries the machine and the framework supplies what only it
knows. The *contract* half of D9 is kept: the transform names symbols, never a
path or an implementation.

#### 4.7.4 The typed read — the one thing this revision got wrong

§3.2 and §4.2 say the typed read is emitted "at the await site, because that is
the only place `T` is known". That is true of *resolution* and false of an
`afterParse` transform, which runs before `program.initialize()`. And `T` cannot
be recovered syntactically where it is needed:

- The transform cannot write a field type for the awaited handle, because the
  only type-erased form is not writable: `Task<any>` does not exist (measured:
  `TS2304: Cannot find name 'any'`), a bare `Task` requires its type argument
  (measured: `TS2558`), and class instantiations are nominal, so `Task<u32>` is
  not assignable to a `Task<usize>` field.
- The transform cannot delegate the inference back to the resolver either: AS has
  no contextual-type inference for calls (measured: `let x: i32 = ret()` with
  `ret<T>(): T` is refused with `TS1140: Type argument expected`). Inference runs
  from *arguments*, so the read must be handed a genuinely `Task<T>`-typed
  expression — which is exactly what does not exist after a suspension.

**Resolution: the read is codegen's.** The lowered `AwaitExpression` node
survives into compilation, and `compiler.ts` compiles it: `T` from the resolver's
type (§2.3's rule, already implemented), the value from the task's record through
§3.2's offsets, and the pointer from the lowering. Two consequences, both
intended:

- §0.2's row for `src/compiler.ts` is now wrong: the file is not "a defensive
diagnostic" only — it keeps the **typed read** of a lowered `await`. The state
machine stays out (§4.5), which is what the review's finding 6 forced; the read
was never a state-machine question.
- The state struct carries **no per-await value slot**. The bearer of a delivered
  value is the task's own record (§3.2's copy), which is why §3.2's copy has to be
  total rather than lazy. A per-site slot would need `T` at the transform, which
  §4.7.4 just showed does not exist there.

**What this costs, stated:** `compiler.ts` grows one expression case, and the
transform must hand that case the pointer it reads from. Everything else in
§4.5's argument — the AST stage, the synthesized managed class, one registration
line in `cli/index.js` — is unaffected.

### 4.8 The validation walk (Phase 3, commit 7) — NEW

§4.5's transform reaches a source's top level, a namespace's members, a class
body, and the statements of the async bodies it lowers. It does not reach the
inside of a non-async function body, an object literal, a class-field initializer
beyond its root expression, a top-level `try`/`catch`/`switch`, a top-level
`if`/`while`/`do`/`for` body, an `export default` declaration, or a decorator
argument. Until commit 7, the parser's Phase 1 guard (`AS100: Not implemented:
Async functions`) was the only diagnostic for an `async` construct written in one
of those places. Commit 7b deletes that guard, so commit 7 adds a second,
read-only walk at `afterParse` (`src/async/validate.ts`), after the lowering
pass, that refuses an unreached construct by name.

**The load-bearing case (Finding G).** `if (true) { async function f() {} }` at
the top level parses — the declaration is an expression statement wrapping a
function expression (measured; `lower.ts`'s `Plan.nestedFunction` records the
same shape) — and neither the parser guard's position nor the lowering pass's
statement switch reaches it. With the guard suppressed, the program yields no
artifact and no refusal. Deleting the guard before the walk would silently
compile it; the walk is what makes 7b safe.

**Refusal list as implemented.** Every `async` construct the lowering pass leaves
`isAsync` gets exactly one message:

| construct the lowering pass never reached | message |
|---|---|
| a function declaration in a block, a non-async body, a top-level loop/`if`, `try`, `catch`, or `switch` | `an async function nested in a non-async body (async lowering)` |
| an `async export default function` | `an async export default function (async lowering)` |
| a method of an unreached class | `an async function nested in a non-async body (async lowering)` |
| a function expression or arrow in any unreached expression position | the lowering pass's `async function expressions` / `async arrow functions` |

`an async function nested in a non-async body (async lowering)` is new in commit
7. An unreached *expression* reuses the lowering pass's wording, because "nested
in a non-async body" names a container and an object literal is not a body.
`export default` was originally folded into the nested-body message; commit 7b
(ruling A) gave it its own, because the shape is a top-level declaration the
lowering pass's statement switch does not visit, not a function inside a body.
The two are disjoint by grammar, not by precedence: `export default` at non-top
level is `TS1109: Expression expected.` (measured), and an export-default arrow
or function expression is `TS1005`/`TS1003` (measured) — so no shape can produce
both messages, and there is no precedence question to settle.

**The refused set.** `isAsync` alone cannot distinguish "lowered" from
"refused": the lowering pass clears it only on success (after every artifact is
built) and leaves it set on every refusal. The walk therefore consults a
per-source `Set<i32>` of construct starts the lowering pass recorded. The map and
its sets are allocated only when a refusal happens. The key is the *construct's*
start, never the diagnostic's:

| shape | construct start | diagnostic start |
|---|---|---|
| async generic function | 0 | 0 |
| async with an optional parameter | 0 | 17 |
| async with no declared return type | 0 | 15 |
| async static method | 10 | 10 |
| async arrow | 10 | 10 |

Two of five refusals report at the parameter or declaration *name*, which is
where the user should look. A key built from the diagnostic would miss those, and
the walk would report the same function a second time. The lowering pass records
the construct on **every** abort path — a wrapper around the lowering body tracks
the current construct — so a `this` in the body, a declarator without a type, or
a nested function's failure all record the enclosing declaration too. String keys
were rejected: building one per walk lookup would allocate, violating the
invariant below.

**The allocation invariant, and its guard.** The walk runs on every non-library
source, including programs that declare no `async`. The byte-identity guarantee
is about the emitted module: identity is a property of output, not of work
performed. The walk therefore allocates nothing — no node creation, no `new`, no
`.clone`, no `.push` into anything reachable from the program, no string keys —
and reports only through `Parser#error`, only when a construct is refused.
`tests/async/lower.js` enforces the four forbidden constructs at source level,
with a stated limitation: it guards the common allocation paths; a new traversal
written with a different allocation pattern must be caught by review, not by the
test. Measured: 10/10 probes (five sources, plain and `-O`) are byte-identical to
`ccf888c6`.

---

## 5. Lowering Backend B: WasmFX (design only)

### 5.1 The same AST, lowered differently

| Backend A | Backend B |
|---|---|
| allocate state struct, switch on `resumePoint` | `cont.new` over the async function body |
| `rt.park(record, …); return` | `suspend $tension_await` with the handle as payload |
| scheduler calls `f_resume(state)` from `runReady()` | scheduler/host `resume`s the continuation |
| task table holds state structs | continuation queue holds continuations |
| lifted locals | the continuation's own stack — **no lifting at all** |

### 5.2 Instruction set, verified

Counts in the proposal's own Explainer (verified today):
`cont.new` 13, `cont.bind` 20, **`cont.drop` 0**, `suspend` 94, `resume` 110,
`resume_throw` 39, `switch` 107. Two consequences:

- **No deallocation.** `cont.drop` does not exist; Wasmtime's tracking issue
  `#10248` lists "Support for deallocating continuations" as *not* in the initial
  implementation, and the engine's own doc says continuations remain allocated for
  the store's lifetime (`crates/wasmtime/src/runtime/store.rs:2156` on `main`). A
  long-running game with a task per frame would leak continuations without bound.
  A real design constraint on Backend B, not a footnote.
- **The scheduler is outside the instruction set.** The Explainer's reference
  `$scheduler1`/`$scheduler2` are written *in wasm* (`Explainer.md:281`, `:358`),
  and the bag-of-stacks design notes describe a tree of arena schedulers with the
  root yielding to the embedder's event loop — so a host-owned continuation queue
  is permitted but not mandated.

### 5.3 What changes in the runtime when Backend B lands

Unchanged from the reviewed draft: the suspend/resume mechanism; state structs
disappear and the task table becomes a continuation queue; the resume-queue owner
may move; lifted locals disappear. **What does not change:** the AST, `Task<T>`,
the handle representation, `await`'s type and value semantics, the error model,
the classes used, and every line of game code.

### 5.4 The one thing that would break Backend B

Sustained from the reviewed draft, and now derived rather than asserted (§4.6):
an over-eager *diagnostic* is the risk, not the AST nodes. The front-end must not
encode "await is illegal here" for any position whose legality is a backend
capability; the language rules are the seven in §1.2.

### 5.5 What in the AST design makes Backend B a drop-in

- **Syntax only in the AST** (§2.1).
- **Backend metadata in side tables keyed by node identity** — the transform's
  `Map<NodeRef, BackendRecord>`; a backend can be deleted without touching a node.
- **Shared concerns shared:** the return-type transformation, `Task<T>`, the
  record layout, the error model and the diagnostics are front-end concerns.
- **The seam is a transform** (§4.5), so Backend B is another transform or a
  codegen switch selected by the same option.

### 5.6 What Backend B inherits from closures

Only the rooting rule (§4.4) — for the different reason that a fiber stack is not
scanned. Nothing else.

### 5.7 Backend B's real gate: the engine, not a bug list — REVISED

`tension-core/Cargo.toml:20` pins `wasmtime = "=24.0.13"`. **That version has no
stack switching at all**: the crate contains no `wasm_stack_switching`,
`Continuation` or stack-switching symbol, and `Config` has no such method. The
feature appears only in later releases (`Config::wasm_stack_switching` on `main`
at `crates/wasmtime/src/config.rs:1277`, documented "This feature is `false` by
default"). So M3's gate is:

1. **A wasmtime re-pin in `tension-core`** to a release that exposes
   `wasm_stack_switching` — a host change the architect schedules, and one that
   drags whatever else that bump carries.
2. **x64-Linux only**: the stability table's `stack-switching` row is
   ❌/🚧/🚧/❌/❌/❌ with the footnote "Currently the implementation is only for
   x86\_64 Linux".
3. **No continuation deallocation** (`#10248` limitation).
4. **Windows support** (`#10248` limitation, unchecked).

`#14644` is closed and `#14509` open (both **fuel accounting**, relevant only if
the architect introduces metering — §9.3). The revised framing: **Backend A is the
only backend that can run on the current pin, on any platform**; Backend B ships
when the engine moves and the three upstream items clear.

---

## 6. Guest async runtime

### 6.1 Dispatch: which callbacks participate

Sustained from the reviewed draft — this section was confirmed by the review and
is kept, with citations refreshed.

Every class's default delivery mode, from `DEFAULT_CLASS_MODES`
(`arena.rs:250-260`): `DEVICE_LOST` 0 DIRECT; `JOB_FAILED` 1 DIRECT;
`RESOURCE_FAILED` 2 DIRECT; `SUBMISSION_REJECTED` 3 DIRECT;
**`JOB_DONE` 4 BATCHED**; **`RESOURCE_READY` 5 BATCHED**; `INPUT_KEY` 6 BATCHED;
`INPUT_MOUSE` 7 BATCHED; `LOG` 8 BATCHED; `FRAME` 9 **POLLED** (class ids at
`arena.rs:202-213`; capacities at `:241`).

> **`onBatch` must participate. There is no alternative.** `JOB_DONE` and
> `RESOURCE_READY` are `MODE_BATCHED`, so job and resource completions arrive
> through `onBatch`; `onEvent` carries the failure classes plus input and the
> device/submission errors. A design that hooked only `onEvent` would never see a
> successful completion of anything the async runtime exists to await.

`FRAME` being `MODE_POLLED` is the second useful fact: frame delivery is not a
callback at all, which is why `nextFrame()` is a tick awaitable (§6.5).

**Mechanics, verified at the invoke site** (`epoch.rs:192-216` for `onBatch`,
`:237-240` for `onEvent`): `onBatch(class, ptr, count)` receives `count`
**contiguous** records — append never wraps (a full sub-ring returns `Full`,
`subring.rs:181-183`), compaction happens once before appending (`:267-273`), and
overflow is counted rather than written (`:290-295`). A batch can mix several
tasks' completions, so the dispatcher is per-record: `ptr + i*32`, stride
`EVENT_RECORD_SIZE = 32` (`arena.rs:124`).

**Correction to a popular assumption, worth stating:** delivery is *not* gated on
subscription — the epoch flushes every class queue (`epoch.rs:142-165`) and the
invoke phase consults only the mode and the slot-disabled flag
(`epoch.rs:196-197`). Classes 4/5 are subscribed by default
(`posting.rs:280-282`). What *is* required is a registered `onBatch`: with no
callback, records stay in the ring and the delivery still counts
(`epoch.rs:198-203`) — i.e. a guest with no `onBatch` never sees a completion.

### 6.2 Wakeup encoding — the scheme chosen

**`a` = the producer's id; the runtime echoes nothing.** From §3.1: the task table
is keyed `(class-family, a)`. The dispatcher, per delivered record:

```
switch (record.class_) {
  case JOB_DONE:   case JOB_FAILED:     family = JOBS;   break;
  case RESOURCE_READY: case RESOURCE_FAILED: family = RESOURCES; break;
  default: ignore (INPUT_*, LOG, …)      // other classes are not ours
}
task = table.get(family, record.a)
```

and on a hit, the type-free copy of §3.2. On a miss, the record is ignored —
which is the correct behaviour for the input and log classes that ride the same
batched path.

**What this costs, and what it buys.** It costs nothing in the record, nothing in
the schema, nothing in any producer, and no host change — the only thing that
would otherwise require all three (review 2.2, 2.3). It buys a design whose
identity half is *already implemented* in the shipped capability
(`loader.cpp:439`), so M2 (§7.4) shrinks from a prerequisite to a separate,
optional plan about generic job submission.

**Not ours to reinterpret.** `flags` and `b`/`f0`/`f1` are producer-owned
(`INPUT.md:377-382` for `flags`; `loader.cpp:433-439` for `a`/`b`); the runtime
copies them and assigns no meaning beyond §3.4's status derivation.

### 6.3 The scheduler tick, inside the guest-owned frame loop

No new host import; the yield primitive exists. `RuntimeSession.wait(timeoutMs)`
is the yield, and `wait(0)` is by definition the non-blocking drain
(`mod.rs:1370-1385`). Shape:

```ts
export function _start_game(): void {
  // ... existing setup ...
  while (!done) {
    const timeout = rt.hasRunnable() ? 0 : frameTimeoutMs;
    RuntimeSession.wait(timeout);   // ← the yield. Host delivers here.
    rt.runReady();                  // ← the scheduler tick: resume + drop rule
    game.update();                  // ← the game's own frame logic
  }
}
```

Properties, unchanged from the reviewed draft and now grounded:

- **Composition is an insertion, not a rewrite** — the loop already calls `wait`.
- **`rt.runReady()` sits after `wait` returns, never before.** That position is
  what makes §6.4's guard true, and it is where a resumed task's session verbs are
  legal (`run_epoch_verb` only takes the session for the duration of an epoch,
  `mod.rs:1321-1332`; after `wait` returns, the session is back in the store).
- **The tick is where resume happens**, so by construction the session is idle:
  the reentrancy rule is satisfied by ordering, not by a guard.

### 6.4 Dropped and lost completions — a rule, with a control (new)

**The problem the review found.** The reviewed draft covered a completion that
arrives carrying failure, and covered resuming in the wrong place, but not a
completion that never arrives. Two paths lose one:

- `post_event` refused with `PostError::QueueFull → -ENOSPC` (`posting.rs:47-68`);
  the loader already handles its own case by failing the job explicitly
  (`loader.cpp:433-436`) and by saying plainly that a post is best-effort
  (`:501-507`).
- A record that reaches the class queue but finds the sub-ring full is counted as
  `dropped` and discarded, never overwritten (`subring.rs:290-295`).

Either way a parked task would hang forever while the frame loop spins.

**The mechanism already exists, and is already mirrored to the guest:**
per-class `dropped`/`delivered` in the ring header (`TABLE_DROPPED` at
`arena.rs:136`, `TABLE_DELIVERED` at `:135`; written each epoch at
`epoch.rs:162-164`) and the cross-class rollup `FrameState.droppedEvents`
(`FRAME_DROPPED_EVENTS = 4`, `arena.rs:179`; written at `epoch.rs:171-179`;
counter sum at `posting.rs:417-420`).

**The rule:**

> At each tick, `rt.runReady()` compares the drop rollup against the last value it
> observed. If it advanced, the runtime **cannot attribute the loss to a key** —
> drops are counted per class, not per record (`subring.rs:290-295`) — so it wakes
> every task parked on a class whose counter advanced, with
> `status = -EIO` ("completion lost"), and logs the class and the delta once. The
> game recovers through the capability's readers, which the design names as the
> truth: "events are advisory, the status table is the truth, and a dropped
> `JOB_DONE` costs a guest nothing it cannot read from the record"
> (`tension-ogre/DESIGN.md:1840-1848`).

**Why this rule and not another.** Waking with a distinguishable status is the
only option that neither hangs nor lies: the alternative — leaving tasks parked
and hoping — makes a lost record indistinguishable from a slow job, and per-key
attribution would require the host to keep the payload of a record it is
deliberately discarding (a host change, and one the frozen path does not need).
The failure is *loud* (a status and a log line) and *recoverable* (the region
readers), which is exactly the trade the design already makes everywhere else.

**Tested, not asserted.** The guest can shrink a class's ring at open —
`ConfigBuilder.ringCapacity(class_, capacity)` (`config.ts:67-69`,
`KEY_RING_CAPACITY_BASE = 0x0100` at `:25`), which `session_open` adopts
(`PostingSide::set_capacities`, `posting.rs:483`). So the harness's third control sets `JOB_DONE`'s capacity
to 1 and queues more loads than the ring can hold without a tick (§8.4, NC3).

### 6.5 Parking, resume, and ordering

- **Parking** registers `(family, key) → TaskRecord` in the task table and stores
  the task's resume state; the state struct holds the record reference (§4.4).
- **Resume** happens only in `runReady()`, in delivery order: class ascending, and
  within a class the order the records were flushed (§1.2 rule 6, §6.1). A task is
  moved out of the parked set before its resume function is called, so a resume
  that parks again (the next `await`) re-registers cleanly.
- **Idempotence**: `await` checks `record.done` first (§1.2 rule 4); a settled
  record resumes nothing.
- **Tick awaitables** (`nextTick()`, `nextFrame()`) have no class and no record;
  they are completed by the tick itself. Their relative order within one tick is
  the one thing this plan leaves to the implementation (§1.2's note), and it must
  be documented before they ship.
- **Double registration**: refused with a named error (§1.2 rule 5).
- **Floating tasks**: a task whose handle nobody awaits still runs; on settlement
  the runtime clears its parked entry and (if nothing references the record)
  ordinary GC reclaims it. Nothing needs to be awaited for a job to complete.

### 6.6 Preemption, metering, and what the runtime actually relies on — NEW

**Measured:** the host provides no preemption of any kind. The only production
engine is configured with `debug_info` and nothing else (`main.rs:573-575`); there
is no epoch deadline, no epoch-interrupting watchdog, no fuel budget anywhere in
`tension-core/src`. `_start_game` runs on the interpreter thread until it returns
or traps (`main.rs:1226`).

**Therefore the async runtime is fully cooperative, and this plan states the
contract:**

- **Yield points:** (i) `RuntimeSession.wait(timeoutMs)` — the guest's blocking
  yield, and the host's only delivery point (`mod.rs:1370-1385`); (ii)
  `RuntimeSession.wait(0)` — the non-blocking drain; (iii) a task's suspension
  (the `return` from `f_resume`, §4.1); (iv) `wait` returning on timeout, which
  still runs the epoch.
- **Resumption only at `runReady()`**, i.e. only outside an epoch's callbacks
  (§6.3). This is not a policy choice on top of the design; it is the only place
  resumption can be correct given §1.1's reentrancy.
- **Guest responsibility:** keep the loop's timeout bounded
  (`rt.hasRunnable() ? 0 : frameTimeout`); never block inside a callback (the
  reentrancy rules already refuse the verbs that would —
  `-EBADF`/`-EBUSY`, §1.1); never rely on the runtime to interrupt a runaway
  computation. A guest that never yields starves delivery, and the host will not
  rescue it because it has nothing to rescue it with.
- **What is not promised:** fairness beyond FIFO registration order; timeout
  enforcement by the runtime (a parked task with no completion stays parked unless
  §6.4's rule fires); any protection against a guest that loops forever — that is
  the status quo for every Tension guest today, and async neither worsens nor
  fixes it.

**If preemption is wanted later**, it is a host decision taken in the host's own
terms — `Config::epoch_interruption` with a watchdog, or fuel — and it interacts
with the async runtime only in one way worth naming now: a preemption that lands
*inside* a task's resume function must leave the task parked with a valid
`resumePoint` (the state machine makes that true by construction, because the
state is in memory before any suspension), and a preemption that lands inside a
*host callback* is already the session's fault path (`epoch.rs:283-296`).
Neither requires anything of this plan's design.

### 6.7 The dispatcher must be a plain function (consequence of a shipped guard)

`makeCallbacks` refuses any handler whose environment word is non-zero
(`runtime/callbacks.ts:33-35`), because the host resolves the table entry and
calls it directly with no call site to hand the environment over. The async
runtime's `onBatch`/`onEvent` dispatchers are therefore **module-level functions
with no captures** — a capturing arrow as a handler would abort at
`makeCallbacks`, which is the correct and already-tested behaviour
(`tension-framework/tests/guest-callbacks-guard.ts`). The async runtime keeps its
state in module-level managed globals (the task table, §4.4) rather than in a
closure, and that is a design requirement, not a style.

---

## 7. Host ABI and the job target

### 7.1 Every host import and export the async runtime uses — enumerated

**Guest → host, complete list** (all existing, none added):

- `session::open`, `close`, `wait`, `drain`, `subscribe`, `unsubscribe`,
  `pending` — `runtime/session.ts:18-35`; registered at `mod.rs:1519-1523` and
  neighbours.
- `tension::io::print`, `read_line`, `arg_count`, `arg`, `log`,
  `log_structured` — `assembly/io.ts:35-56`.
- The capability verbs that do the work: for the harness, `ogre::init`,
  `queue_mesh_load`, `mount_tns`, `job_state`, `job_release`, `last_error` —
  `ogre/index.ts:78-99`.

**Host → guest, complete list** (all existing, none added):

- The exported function table, resolved at `session_open` (`mod.rs:1233`).
- `_start_game` (or `_start`, `main.rs:1226-1232`).
- The two callback slots (`arena.rs:192-197`), invoked from the epoch
  (`epoch.rs:192-240`).

**No new import, no new export, no new record field, no new completion class,
no schema bump.** That is the claim the review checked and confirmed (finding
8.1), and §3.1's chosen correlation scheme is what keeps it true (§6.2). "No new
class" means no new **completion** class among the arena's ten (§3.1 rejects an
eleventh on `SessionInfo` layout grounds); the guest-side classes this plan adds
— `TaskRecord` in `std/assembly/task.ts`, the state structs, the framework's
record subclass — are ordinary guest classes and never appear at this boundary.

**Where the guest-side halves live (the D9 split, as implemented).** The task
machine is std source — `std/assembly/task-rt.ts`: the table keyed `(family, a)`,
the record reads and writes at §3.2's offsets, the ready queue and its order
(§1.2 rule 6), and §6.4's dropped-completion rule. The framework supplies what
only it knows: the record subclass, the class→family map, and the two call sites
— its `onBatch`/`onEvent` decode a delivered record into `__taskDeliver`, and its
frame loop calls `__taskTick`. The lower half of D9 ("std declares, the framework
provides the implementation") was not implementable: a bodiless `declare` in std
is a host import, and the compiler's only name-based linking path
(`requireFunction`, `program.ts:734`) would make every lowered program depend on
the framework being linked. The contract half holds: the transform names symbols,
never a path or an implementation.

### 7.2 The jobs target: the OGRE capability's pipeline — REVISED

The review's finding 9.1: the reviewed draft said "awaiting a host job has
nothing to await yet" and made a generic job system a prerequisite. That premise
was false for the capability path. What ships and works today:

| Piece | Evidence |
|---|---|
| Queue verbs returning a job id, or an errno | `ogre/index.ts:230-241`; `queueMeshLoad` returns `-ENOSPC` when the string half is full |
| A loader with a real worker thread | `loader.cpp:114-116` (`worker_ = std::thread([this]{ worker_main(); })`), `:634` |
| Completion posted from the render thread's drain | `adapter.cpp:347` (`loader.drain_completions` in the render loop), `:340` (`RESOURCE_READY`), `loader.cpp:427-440` (`JOB_DONE` / `JOB_FAILED`) |
| Failure paths that keep the process alive | `loader.cpp:433-436` (`-ENOSPC`), `:504-507`, `:718-720` (sweeps) |
| A JOB-region mirror the guest reads directly | `ogre/index.ts:213-215` (`jobRecord`, `JOB_SIZE = 64` at `ogre/wire.ts:656`), `:268-283` (`jobState`/`jobResult`/`jobError`) |
| The model: events advisory, region the truth | `tension-ogre/DESIGN.md:1840-1848` |
| A two-sided end-to-end test | `tension-ogre/tests/guest-jobs.ts` (5 clauses) asserted by `tension-core/tests/ogre_jobs.rs` ("ACID 5/5 passed", `:86-87`) |
| The exact awaited shape, already working as a *poll* | `guest-jobs.ts:47-53` (`settle()` loops `RuntimeSession.wait(10)` on `jobState`) |
| And as an *event*, with the payload the plan keys on | `tension-framework/tests/guest-ogre.ts:11-13` (the doc comment: "onEvent(JOB_DONE) -> job id in `a`, resource id in `b`") and `:47-51` (the code that reads them) |

So the honest statement is: **a generic, capability-agnostic job system does not
exist; a capability-owned job system does, and it is enough to prove this design.**
The core's `apply::sweep_jobs_to_failed` stub (`apply.rs:263`) is not on the
critical path.

### 7.3 What this removes

- **The harness's fabricated-completion problem** (review 8.2): the completion
  comes from the loader's worker through the render thread, so a test needs no new
  flag in `main.rs` and no production code. `--post-test-events` (`main.rs:1191-1216`)
  posts *before* the guest runs and remains what it is — a delivery test, not a
  suspension test.
- **The M2a blocker** (review 9.1): nothing depends on generic job submission.
- **D8 of the reviewed draft** (the request to add a test file to
  `tension-core`) **shrinks to a test file only** — `tension-core/tests/async_await.rs`
  following `ogre_jobs.rs`'s shape, with no production change of any kind.

### 7.4 What remains a separate plan

Generic job submission — a capability-agnostic queue, worker pool, back-pressure
policy, and job cancellation — is still a real, separate piece of host work with a
different discipline (threads, queues, `PostError::QueueFull`, the JOB region's
ownership). The revision's point is only that **this plan does not depend on it**.
If the architect wants it, it is M2, scheduled independently; the only interface
it must respect is §6.2's ("the identity word is the producer's id"), which is a
one-sentence contract, not a joint design.

---

## 8. Test harness — REVISED

### 8.1 Two harnesses, each for what it can prove

| Harness | Producer | Proves | Does not prove |
|---|---|---|---|
| `tension-framework/tests/guest-async.ts` (via `tests/run.sh` against the **stub adapter**, `run.sh:173`) | `ogre_stub_adapter.c` — same-thread, completes pending jobs and posts JOB_DONE during **publish** (`ogre_stub_adapter.c:382-400`; the file's own comment contrasts itself with "a real adapter [whose] render thread [would] fill the resource and hand the completion back") | ordering, payload mapping, both callbacks, the negative controls, the drop rule | **not suspension**: a busy-waiting guest would pass |
| `tension-core/tests/async_await.rs` (against **`libtension_ogre.so`**, `--renderer=null`, `--tns=fixtures.tns`) | the loader's worker thread + the render thread (`loader.cpp:114-116`, `adapter.cpp:347`) | suspension and resume across a **genuine cross-thread, delayed** completion | — |

The second is the meaningful one, and it is exactly `ogre_jobs.rs`'s shape
(`tension-core/tests/ogre_jobs.rs:63-88`: run the interpreter as a subprocess,
assert the guest's own transcript). The first is the fast loop, and it is honest
about what it cannot show. Both compile with the published compiler (§0.4).

### 8.2 Pass criteria for the meaningful harness

All four must hold, asserted by the guest (self-asserting, so the host's
assertion is one line) and by the host:

1. **Ordering.** The pre-await line precedes the post-await line, and the
   post-await line appears only after the epoch that carried the completion.
2. **Genuine yield, not spin.** The guest's loop advanced at least one tick while
   the task was parked (`frames-while-suspended >= 1`).
3. **Lifted locals survive.** A local assigned before the await and read after it
   holds its value — the assertion that catches the most likely Backend A bug.
4. **No reentrancy refusal in the normal path.** No `-EBADF` and no `-EBUSY` from
   any session verb during the run.

Plus the two cross-checks that make it *this* feature rather than a synthetic one:
`jobResult(job) == the awaited value`, and `jobState(job) == JOB_DONE` — the
same pair the shipped fixture already asserts (`tension-framework/tests/guest-ogre.ts:124`:
`assert(ogre.jobResult(job) == seenResource, "the record and the event disagree")`).

### 8.3 The fixture, and the details the review corrected

```ts
// tension-framework/tests/guest-async.ts — the smallest program that can be
// wrong in each interesting way, against a real loader.
let resumed: u32 = 0;
let framesWhileParked = 0;
let nestedVerbResult = 0;

async function awaitedTask(job: i32): u32 {
  let local: u32 = 41;                    // live across the await → must be lifted
  print("A:before");
  local = await rt.job(job);              // ← parks here; resumes at runReady()
  print("B:after " + local.toString());
  return local;
}

function onBatch(class_: u32, ptr: u32, count: u32): i32 { … }   // plain function (§6.7)
function onEvent(class_: u32, ptr: u32): i32 { … }

export function _start_game(): void {
  // … open, mount, ogre init, queue the load, rt.start(awaitedTask(job)) …
  while (ticks < limit) {
    RuntimeSession.wait(rt.hasRunnable() ? 0 : 16);
    rt.runReady();
    if (rt.isParked()) framesWhileParked++;
    if (rt.isDone()) break;
  }
  print("C:frames-while-parked=" + framesWhileParked.toString());
  print("D:value=" + resumed.toString());
}
```

Corrected against the review's finding 10.2:

- **The transcript uses `print`** (`assembly/io.ts:35`), which every existing
  fixture uses — **not** `process.stdout.write`. The AS `process` binding exposes
  only `argv` and `exit` (`std/assembly/bindings/node.ts:2-5`), and no Tension
  guest writes through `process.*`.
- **The harness records its compiler** (§0.4): `asc --version` plus the fork SHA,
  printed first and asserted by the host.
- **Missing fixtures panic by default.** `tests/support/ci.rs:26-45` refuses to
  skip unless `TENSION_TEST_ALLOW_SKIP=1`; the plan states this so a harness that
  "passes" in a CI without the DSO cannot be mistaken for coverage. The DSO,
  volume and `asc` prerequisites are named in the harness's own failure message.

### 8.4 Negative controls

- **NC1 — resuming inside a callback is refused by the runtime's own guard.** A
  variant whose `onEvent` calls `rt.runReady()` directly. Asserted: the guard
  refuses with a **named error in the transcript** — *not* a session fault. The
  host turns only a **trap** into a session failure (`fault_from_trap`,
  `epoch.rs:283-296`; policy stated at `DESIGN.md:1874-1879`), so a control that
  expected a session error would be asserting something no code produces.
- **NC2 — a nested session verb from inside a callback returns `-EBADF`.** The
  callback calls `RuntimeSession.wait(0)` and records the return; the host asserts
  **`-9`**. `run_epoch_verb` finds no session because the epoch took it
  (`mod.rs:1325-1328`), `EBADF = -9` (`mod.rs:80`) — not `-EBUSY` (which is what
  `subscribe`/`unsubscribe`/`pending` return via the depth guard, `mod.rs:1345-1353`).
- **NC3 — a dropped completion does not hang (new, §6.4).** The guest sets
  `JOB_DONE`'s ring to capacity 1 (`config.ts:67-69`), queues two loads, and does
  not tick between them. Asserted: the completion that was dropped wakes its task
  with `status = -EIO`, the runtime logs the class and delta, and the guest
  recovers through `jobState`/`jobResult` — i.e. the run *ends*, with a
  documented outcome, rather than spinning. This control is the reason §6.4's rule
  is testable rather than aspirational.
- **NC4 — the callback guard still refuses an environment-carrying handler.**
  Already shipped (`callbacks.ts:33-35`, `guest-callbacks-guard.ts`); re-asserted
  so the async runtime's dispatchers cannot quietly become closures (§6.7).

### 8.5 Platform

**Must run on Windows**, and the arrangement is unchanged from the reviewed draft:
the guest builds with the fork's `asc` (published, §0.4); the host test is a
normal `cargo test --no-default-features --features audio` (`AGENTS.md`); the
fixture prints and the host asserts on captured output; the AS build runs
out-of-tree (`build/assemblyscript/`); no WasmFX, no wasm threads, no
platform-specific syscalls. The **stub-adapter** harness (8.1, first row) is the
one that runs anywhere with no volume; the **DSO + volume** harness is the
Windows/Linux shared one and needs `tension-ogre/build.sh` and `pack.sh` to have
run.

---

## 9. Verification of the claims from v1, and of this revision

### 9.1 `moonbitlang/async` ships its own event loop — CONFIRMED

Unchanged from the reviewed draft: the wasm path exists (`event_loop.wasm.mbt`,
`event_bus.wasm.mbt`, …) and the event loop is unambiguously its own
(`PlatformEventLoopExtra` with `Unix`/`Windows` variants). It has per-platform
backends and **no integration point for an embedder-owned host loop**, which is
why it cannot solve this problem: there is no way to say "this task's completion
will be delivered by *my* host at *my* frame boundary."

### 9.2 Wasmtime `#13584` is closed — CONFIRMED

`state: closed`, `state_reason: completed`, closed 2026-07-28, 3 comments.

### 9.3 `#14644`/`#14509`, and the preemption claim — REVISED

- **`#14644` "cranelift: preserve fuel across stack-switching instructions" is
  CLOSED** — `closed_at: 2026-10-15T18:03:23Z`, 0 comments. (The reviewed draft
  said open, updated 2026-10-10.) It is struck from the gate text.
- **`#14509` "Stack-switching ops loses fuel accounting" is open** — updated
  2026-10-09, 0 comments.
- **The reviewed draft's reasoning is withdrawn.** It said these matter because
  "Tension, whose host uses **epoch interruption** for latency-critical
  preemption". The host uses neither epoch interruption nor fuel; the only
  production engine sets `debug_info` and nothing else (`main.rs:573-575`, §6.6).
  Fuel accounting can therefore not make "an epoch-driven preemption budget
  silently wrong" — there is no such budget. These issues matter only in a
  hypothetical where the architect introduces preemption, and they are listed as
  such: a note about a future option, not a present constraint.

### 9.4 WasmFX instruction set and `cont.drop` absence — CONFIRMED

Counts verified today in the proposal's Explainer: `cont.new` 13, `cont.bind` 20,
`suspend` 94, `resume_throw` 39, `resume` 110, `switch` 107, **`cont.drop` 0**.
Schedulers are written in wasm (`Explainer.md:281`, `:358`); a host-owned queue is
permitted, not mandated.

### 9.5 WasmFX Windows support is a roadmap item per `#10248` — CONFIRMED

`#10248` is open (updated 2026-10-05); its limitations list is quoted verbatim in
the reviewed draft and verified: "Support for ISAs other than x64", "Support for
`resume.throw` instructions", "Support for deallocating continuations",
"Integration with GC", **"Windows support"**, "Pulley support", "Winch support" —
all unchecked. The stability table's `stack-switching` row is ❌/🚧/🚧/❌/❌/❌ with
the footnote "Currently the implementation is only for x86\_64 Linux". Corroborated
by `Config::wasm_stack_switching`'s own doc, "This feature is `false` by default"
(`crates/wasmtime/src/config.rs:1277`, `main`).

**And the correction this revision adds:** none of that matters until the engine
moves at all, because the pinned `wasmtime =24.0.13` (`Cargo.toml:20`) has no
stack switching (§5.7). See §11's M3 gate.

### 9.6 The preemption model as it exists — NEW

Stated once, here, so no reader has to reconstruct it from the sections:

| Question | Answer | Evidence |
|---|---|---|
| Does the host preempt the guest? | No. | `main.rs:573-575`; no fuel/epoch symbols in `tension-core/src` |
| Is there metering? | No. | same |
| What yields? | `session::wait(timeout)` (and `wait(0)`), and a task's suspension. | `mod.rs:1370-1385`; §4.1 |
| Where do tasks resume? | Only in the guest's own tick, after `wait` returns. | `epoch.rs:192-240` + §6.3 |
| What must the guest do? | Bound the frame timeout; never block inside a callback. | §6.6 |
| What does Backend B need? | An engine re-pin exposing stack switching, plus three upstream items. | §5.7, `Cargo.toml:20`, `#10248` |
| If preemption is wanted later? | A host decision (epoch or fuel), independent of this plan. | §6.6 |

---

## 10. Open decisions requiring architect approval — updated

Each with a recommendation. Decisions the review's findings settle are marked
**settled by revision**, with the reasoning, so the architect can overrule with
full information rather than re-derive.

**D1 — Payload correlation.** ~~task id in `a`, await-point discriminator in `b`~~
**Settled by revision:** the runtime mints no ids; the key is the producer's
submit-time id, read from `a` (`loader.cpp:439`), with the failure class resolving
the same family. Justified against the frozen layout in §3.1: a new class breaks
`SessionInfo`'s field offsets (`arena.rs:96-97`, `:1326`), and the record has no
spare word (`arena.rs:147-150`).

**D2 — Whether `onBatch` participates in async dispatch.** **Yes, and it is not
optional** — `JOB_DONE`/`RESOURCE_READY` are `MODE_BATCHED` (`arena.rs:250-260`),
and a guest with no `onBatch` never sees a completion (`epoch.rs:198-203`).
Sub-decision: batched dispatch is per-record, stride 32 (`arena.rs:124`).

**D3 — Error model.** `status` on the handle, zero value on failure, plus
`Async.expect(h)`; errno vocabulary is the capability's; runtime logs non-zero
statuses; `status` is not cleared by `await` (§3.4).

**D4 — How the scheduler yields.** `RuntimeSession.wait(timeout)`; `wait(0)` is
the drain (`mod.rs:1370-1385`). No new import.

**D5 — Where the state struct and the record live.** Guest heap, managed;
`TaskRecord` fixed-layout and `T`-free; `Task<T>` a one-word handle in the std lib
(`std/assembly/task.ts`), precedent `Function<T>`. Rejected: wasm stack, static,
arena (§4.4).

**D6 — Backend-B-safe AST.** Three structural rules (i) syntax only in the AST;
(ii) backend metadata in side tables keyed by node identity; (iii) **no
`await`-legality rule in the parser or resolver** — §4.6's derivation. Retained
from the reviewed draft, with (iii) now resting on §1.2's stated rules.

**D7 — `await` inside closures.** Out of scope; closures are unimplemented
(`AS100: Not implemented: Closures`; the `CommonFlags.Closure` bit exists at
`common.ts:79` and is dead). **Revised**: the environment is *referenced* by the
state struct, never lifted or copied (`closures-plan.md` §0.4/§2.3/§7.1) — the
reviewed draft said otherwise and was struck (§4.4).

**D8 — The one place this plan touches `tension-core`.** A test file only:
`tension-core/tests/async_await.rs`, following `ogre_jobs.rs`, against the OGRE
DSO. **Revised**: no new host flag, no production code, and the reviewed draft's
"approved explicitly" ask is now simply "approved as a test file" (§7.3).

**D9 — The lowering seam.** **`afterParse` AST transform** (`cli/index.d.ts:277`,
`cli/index.js:697-701`), implemented as an in-tree module (`src/async/lower.ts`)
registered in the existing transforms collection (`cli/index.js:403-449`, one
line); alternative with zero `cli/` edits: ship the transform and select it with
`--transform`. **Revised** from the reviewed draft's custom-pass recommendation,
which the review showed cannot synthesize a managed class (§4.5).

**D10 — Where "await outside async" and friends are diagnosed.** A
backend-agnostic validation walk, now naturally a second pass of the same
transform infrastructure (§2.2). Retained.

**D11 — Package renaming.** **Revised, and mostly already answered in practice**:
the published artifact is `@acakar/tensionscript@0.1.0` while the fork's own
`package.json` says `name: assemblyscript`, `version: 0.0.0` — so the rename is
done by the publish step, and the `asc` binary keeps its name. What remains open
is only whether to rename in-tree (§0.4). **Recommend deferring**; it buys nothing
the publish does not already provide. (Whether anything in `lib/asc.js`'s
self-references needs attention at publish time is an implementation check for the
first publish of a lowering change, not a design decision: the published 0.1.0
tarball's `dist/asc.js` imports `../dist/asc.js` relatively and carries no bare
`assemblyscript` specifier, so that check is a confirmation, not an expected
repair.)

**D12 — `async` on ambient/`declare`d declarations and constructors.**
**Disallow** with a clear diagnostic, as in the reviewed draft (there is no body
to lower, and constructors can never be async in TS).

**D13 — Reference-typed await results.** **Out of scope for v2**; a reference is
obtained through the capability's reader (§3.3). A future extension would need a
per-capability reader registry — named, not smuggled.

**D14 — Tick-awaitable ordering** (`nextTick` vs `nextFrame` within one tick).
Left to implementation, must be documented before shipping (§6.5). Recorded so it
is a decision rather than an accident.

---

## 11. Milestones and dependency graph — REVISED

```
   [DONE] M0  fork: origin=TensionScript, upstream=reference-only,
   │          initial commit b6bda05c, arrow-this landed (HEAD 92809069),
   │          published as @acakar/tensionscript@0.1.0 (2026-10-16T16:54Z)
   │
   ├─ M1a  AST + parser + resolver + types
   │        NodeKind.Await, AwaitExpression, isAsync field, factory,
   │        parser modifier + prefix hooks, TWO resolver cases, the
   │        call-site return-type transformation, std/assembly/task.ts,
   │        extra/ast.ts serializer case
   │        ├── gate: tests/parser/async_*.ts.fixture.ts round-trips
   │        ├── gate: `await h` type-checks to T, including `(await h).x`
   │        └── gate: `await` outside async is a diagnostic, not an assert
   │
   ├─ M1b  Backend A lowering   (depends on M1a)
   │        src/async/lower.ts: state structs (synthesized class), lifted
   │        locals (conservative first), the entry/resume split with the
   │        synchronous prefix, parking/registration, terminal/cleanup
   │        └── gate: compiler fixtures for correctness cases §4.5 #1-#6
   │
   ├─ M1c  Guest runtime   (depends on M1a; parallel with M1b)
   │        task table (managed global), TaskRecord, onBatch + onEvent
   │        dispatch, payload capture, inCallback guard, runReady(),
   │        tick awaitables, the drop rule
   │        └── gate: unit tests independent of lowering; NC4 re-asserted
   │
   ├─ M1d  Harness   (depends on M1b AND M1c AND the publish step)
   │        guest-async.ts (stub adapter) + tension-core/tests/async_await.rs
   │        (libtension_ogre.so, --renderer=null, --tns=fixtures.tns)
   │        └── gate: §8.2 criteria 1-4, on Windows
   │        └── gate: NC1 (-EBADF is -9), NC2, NC3 (no hang), NC4
   │
   ├─ M2   Generic job system in tension-core   (SEPARATE PLAN, OPTIONAL)
   │        queue, worker pool, back-pressure, cancellation. NOT a
   │        prerequisite of M1d, and the only interface it must respect
   │        is "the identity word is the producer's id" (§6.2)
   │
   └─ M3   Backend B / WasmFX   (BLOCKED on the engine, not on time)
            (1) tension-core re-pins wasmtime past =24.0.13 to a release
                exposing Config::wasm_stack_switching
            (2) x64-Linux only (stability table)
            (3) no continuation deallocation   (#10248)
            (4) Windows support                (#10248)
```

**The publish step sits inside every milestone that changes the compiler**, and
it is not optional: the harness compiles with the published artifact (§0.4). The
sequence for M1b/M1d is: land in the fork → **publish (architect)** → bump the 15
consumers + lockfiles → reinstall → run the harness. A green run before the
bump proves the old artifact.

**Blocking summary.** M0 done. M1a blocks M1b and M1c, which are independent. M1d
needs both plus the publish. M2 is optional and independent. M3 depends on the
engine.

**What M1d proves and what it does not.** It proves suspension, resume,
lifted-local survival, wakeup dispatch through both slots, the drop rule, and
three negative controls — **against a real worker thread and a real loader**, with
zero production changes to `tension-core`. It does not prove a *generic* job round
trip, because no generic job system exists — and, per §7, it no longer needs to.

---

## 12. Risks — revised

| Risk | Severity | Mitigation |
|---|---|---|
| Local liveness for lifted locals is the real engineering risk | High | Conservative-first lifting; §8.2 assertion 3 guards it |
| A state transition crossing a loop boundary leaves a dangling block label (`flow.ts:251`, `:253`, `:634`, `:644`) | High | §4.5 case 6 — explicit compiler fixtures |
| The transform's injected class must precede its users in `source.statements` (`program.ts:1102-1113`) | Medium | §4.5's recorded trap; a compiler fixture where the async function is the file's first declaration |
| A dropped completion would hang a task without the rule | High | §6.4's rule; NC3 drives it deterministically through `ringCapacity` |
| A forgotten `status` check proceeds with a zero | Medium | Runtime logs every non-zero status; `Async.expect` is the documented default |
| The typed read at the await site is wrong about `T`'s width | Medium | §3.2's read table is closed (scalars only, §3.3); a compiler fixture per scalar width |
| `onBatch` dispatch appears to work but misses batched completions | Medium | §6.1 is code-grounded; the harness asserts a batched completion |
| A split identity (`{JOB_DONE, JOB_FAILED}` family) misses a class | Medium | §6.2's switch is explicit; NC3 asserts the failure path resolves the same await |
| The environment is copied into the state struct (double storage) | High | §4.4's storage table; the closures plan's §8.1 case 6 fails if it happens |
| The environment is not rooted across suspension | High | §4.4's root chain; NC3 and a suspension test with a captured binding |
| The publish step is skipped and the harness tests the old artifact | Medium | §0.4's transcript requirement (compiler version + fork SHA, asserted) |
| A capturing arrow becomes the dispatcher and `makeCallbacks` aborts | Low | §6.7; NC4 |
| Backend B's lack of `cont.drop` leaks continuations | Medium (future) | §5.2; a reason M3 is gated on deallocation, not merely on Windows |
| Backend B is unavailable on the pinned engine at all | High (future) | §5.7's gate is honest rather than optimistic |

**Not verified by this revision, and stated plainly:** no build was run and no
wasm executed, so every claim here is a *code* fact (file, line, structure) rather
than a measured runtime behaviour. The plan's own measurements are the ones it
cites from the tree and from the reviewed documents; the review's audit of those
is what this revision is built on.

---

## 13. What happens on approval (nothing before)

Nothing until the architect reviews this revision. On approval, M1a is the first
implementation milestone, and it is dispatched as a separate implementation agent
— not by the plan author, and not in this turn. The publish step (§0.4) is the
architect's, and each of M1b/M1c/M1d is a separate dispatch after review.

**No code has been written for this plan. No lowering exists. No commit was made
in this revision** — the working tree contains this file and the review beside it,
both uncommitted, per `AGENTS.md` rule 2.
