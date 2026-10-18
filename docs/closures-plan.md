# Closures in TensionScript — PLAN (v2, revised against `ccf888c6`)

**Status:** proposal, awaiting architect review. **No implementation. No code
commits.**
**Supersedes:** the 2026-10-15 revision of this file, written against
`b6bda05c` (the pre-arrow-this, pre-runtime-migration, pre-async tree). This
revision answers `docs/closures-plan-review.md` finding by finding; that
disposition table is §0.2. The **C5 amendment** answers
`docs/closures-plan-c5-review.md`; its disposition table is §0.4. No finding is
dropped.
**Evidence basis:** the fork at `~/work/as-inspect/assemblyscript`, branch
`feat/async-phase3`, HEAD `ccf888c6`; the Tension tree at `main`. Every
`file:line` citation below is against `ccf888c6` unless it is marked otherwise.
The C5 amendment's citations and measurements are against `3490f6f8` (v0.3.3,
after C1-C4 and async Phase 4e) and are marked **measured** where a probe was
run (§0.4, §3.3, §4.7).

---

## 0. Revision record

### 0.1 The three facts that changed since the plan was written

1. **Arrow `this` shipped.** `Function<T>` gained no fields — `_index: u32`,
   `_env: usize` (`std/assembly/function.ts:3-5`), `__visit` tracing `_env`
   (`:34-37`) — but the compiler now *fills* `_env`: a this-capturing arrow is a
   heap `Function<T>` value whose `_env` is the creating function's **receiver**
   (`Compiler.makeCapturingFunctionValue`, `src/compiler.ts:7534-7558`), and every
   indirect call hands that word to the callee through a hidden mutable global
   `~env` (`BuiltinNames.env`, `src/builtins.ts:129`;
   `Compiler.ensureEnvGlobal`, `src/compiler.ts:6637-6650`;
   delivery in `makeCallIndirect`, `:7212-7227`). The callee's prologue reads the
   global into the `this` local the resolver created
   (`src/compiler.ts:1921-1934`; `Resolver.markCapturingArrows`,
   `src/resolver.ts:2284-2291`). The discriminator is `capturesThis` on the
   **prototype** (`src/program.ts:3722`) — a compile-time fact, not a bit in the
   word.
2. **The runtime migration landed.** `incremental` is the compiler default
   (`src/compiler.ts:244`), the framework's generated config
   (`tension-framework/build.sh:149-160`,
   `tension-framework/build/session.asconfig.json:3`), and all five examples
   (`examples/{ai,audio,io,log,res}/package.json:8`). The old plan's §0.3 blocker
   is history; the 32 B/closure measurement stays as the *reason* the migration
   was necessary.
3. **Async landed through Phase 4e.** A `TaskRecord` (managed, traced,
   `std/assembly/task.ts:22`), `Task<T>._record` (`:53-55`), `TaskState` and
   `TaskEnv` (`std/assembly/task-rt.ts:54-59`), and **one** `$env: TaskEnv | null`
   field on every lowered state struct (`src/async/lower.ts:175`, `:375-397`),
   which C4 now **populates**: a this-struct for an async method or an explicit
   `this:` function (`:754-780`), and the received closure env for an async
   function that is itself a closure value (§8.3(a), `:766-780`, `:866-890`). The
   lowering transform runs at `afterParse` (`cli/index.js:448-451`, `:705-707`),
   before `initializeProgram` (`:715-719`). What it still refuses, after C4: async
   arrow functions, async generic functions, an async function nested in a
   non-async body, a local without a declared type that crosses an await, a
   capturing function with an explicit `this:` (§8.3's collision — C5b), and
   `this` in a free async function (resolver `TS2332`).

### 0.2 Finding disposition — every review finding, addressed

| # | Finding | Disposition in this revision |
|---|---|---|
| **F1** | Staging: analysis at codegen cannot compose with the async transform at `afterParse`. | **Revised.** Closures are lowered at `afterParse`, **before** async, as an AST rewrite (§3). The async transform then sees ordinary code: an env local and ordinary field accesses. §8.5 lists the async-side contract. |
| **F2** | `_env` already means "the receiver"; the plan gave it a second meaning with no discriminator. | **Revised.** `envKind ∈ {None, Receiver, Struct}` on the function prototype, set at resolution time from a transform side table (§4.5, §7.1). `this` occupies field 0 of an env class **only when a struct exists**; a this-only arrow keeps the shipped `Receiver` path untouched. |
| **F3** | Direct calls to capturing function declarations have no environment delivery. | **Revised, and measured into a smaller problem than feared.** In this compiler a nested `function inner(){}` is *not* a direct-call target: it parses as `ExpressionStatement(FunctionExpression)` and is called through `call_indirect` (measured; §6.5). Every genuine `ElementKind.Function` direct call is either a top-level function (no enclosing locals to capture) or a method (`this` is `param 0`; block-scoped classes are refused, `src/compiler.ts:3608`). **No `compileCallDirect` change is required.** A fallback refusal by name is specified for any counterexample C1 finds. |
| **F4** | The shipped `$env` shape and the resume-function assumption. | **Revised.** One `$env` field of type `TaskEnv` or null, per state struct (§8.3). It is populated for async **methods** (a this-struct at field 0, Decision 4) and is the carrier of a capturing async function's env into `f$resume`. `f$resume(state)` takes only `state`; nothing is threaded as a parameter. |
| **F5** | The plan's call convention is not the shipped one; the host-callback restriction is missing. | **Revised.** §6.4 states the shipped `~env` save/set/restore and the prologue; §9 states that `makeCallbacks` refuses any capturing closure and specifies the shim pattern, the `call_indirect` builtin gap, and the "`~env` is not a root" rule. |
| **F6** | Analysis placement vs scope-entry allocation. | **Revised.** Analysis is compile-time only; **allocation happens at the scope entry of the scope that owns the captured bindings** (§5.3). One rule, one place. |
| **F7** | Per-iteration loop lowering was a requirement, not a design. | **Revised.** §2.3 and §5.4 specify the rule: a body block allocates its env at the top of the block (per iteration); a `for`-header binding clones its env at the *end* of the body, before the incrementor, so the increment mutates the next iteration's binding; `continue` runs the incrementor and therefore the clone. |
| **F8** | Case 6's deferral gate is understated. | **Revised.** §8.4 states the chain: closures → the async transform's refusals removed and `$env` populated → case 6 testable. The async-side changes are enumerated (§8.5) and are a separate dispatch. |
| **F9** | Case 3 asserts a bound method value; TS has none. | **Revised.** §7.3: method values are **unbound** (measured `TS2685` on `f()`), `Function<T>` has no `bind` (grep), and `f.call(c)` is the explicit-receiver path (measured ok). Case 3 is replaced. |
| **F10** | `super` in arrows is unaddressed. | **Revised.** §7.5: `super` in a capturing arrow is refused by name; the general fix stays with arrow-this D8. |
| **F11** | §0.1's mechanism claims and all citations are stale. | **Revised.** §1 replaces the old §0.1 with the shipped mechanism; every citation is at `ccf888c6`. The old plan's "writes `_env` exactly once, always zero" and "capture detected at exactly two sites" are marked historical in §1.2. |
| **F12** | D1 and D8 are resolved by the runtime migration. | **Revised.** §12 marks D1 and D8 resolved with citations; `stub` references are historical. |
| **F13** | Platform: the plan says Windows; the working host is Linux. | **Revised.** §13.3: Linux first gate, Windows second, as the runtime migration did. |
| **F14** | TDZ's runtime guard needs a concrete mechanism. | **Revised.** §2.5: the demotion removes AS's definite-assignment check, so an initialization flag plus `abort()`/`unreachable()` is **mandatory** for declarations without an initializer — not optional. The flag is emitted only for those declarations. |
| **F15** | `CommonFlags.Closure` is dead. | **Revised.** §12 D6: delete it; `envKind` in the side table is the fact, and a dead flag named `Closure` beside this feature misleads. |
| **F16** | §7.1's `_env`/`$env` naming is wrong. | **Revised.** §8.3 distinguishes `_env` (the `Function<T>` word), `$env` (the state-struct field), and the env locals (`$closureEnv`, `$closureEnvIn`). |
| **F17** | The plan's cost classification is two-way; the shipped mechanism has three cases. | **Revised.** §4.5's three-way table (`None` / `Receiver` / `Struct`) and the case-11 assertions. |
| **F18** | `TaskEnv` is not named as the environment base. | **Revised.** §5.2: **every synthesized env class extends `TaskEnv`**, because `$env` is typed `TaskEnv` or null and a single base keeps that carrier assignable without a per-function field type. |

### 0.3 What this revision keeps from the original plan

The central rule survives unchanged: **a captured binding's storage is the
environment** — one home per binding, never a second copy in the state struct
(original §0.4; adopted by `docs/async-await-plan-v2.md` §4.4, which strikes the
reviewed draft's "the environment would also have to be lifted" at
`async-await-plan-v2.md:807`). Also kept: capture by reference including `const`
(§2.1), per-scope-instance environments with a parent chain (§2.2), no hoisting
(§2.5), no new AST nodes (§3.5), no new `TypeKind` and no capture-ness in the
`Signature` string (§11), and the backend-neutrality argument (§10).

---

### 0.4 C5 review disposition (F1-F14)

The C5 review (`docs/closures-plan-c5-review.md`) found the chain design correct
and its specification incomplete. Every finding and its disposition here:

| # | Finding | Disposition |
|---|---|---|
| **F1** | C5 had no design section; its milestone described shipped work | **Addressed.** New §4.7; milestone restated (§14) |
| **F2** | `$parent` was conditioned on "the owner is itself a closure" | **Addressed.** §5.2 states the real condition (the scope has an owning ancestor) and the expected wat |
| **F3** | Nested owners were refused, so the nested two-scope shape was unreachable | **Addressed (C5a).** §4.7.3; §6.1; §7.1a's table |
| **F4** | The side table could not represent "owns and receives" | **Addressed.** §3.3 defines `ownEnv`, `receivesEnv`, `parentClass`, and who reads each |
| **F5** | `needed: Scope \| null` and `needScope`'s one-env rule had no replacement | **Addressed.** §4.7.2: `needed` is the innermost referenced scope; hops are counted over owning scopes |
| **F6** | No allocation/constructor rule for a parented scope | **Addressed.** §5.2's constructor rule; §5.3; §5.4; §6.1 |
| **F7** | `$init$` was written against one env and would not hop | **Addressed.** §4.7.2's `targetOf`; §2.5 notes the guard shares the value's walk |
| **F8** | `$env` had no chain meaning; §8.3(a)'s read-back was wrong for the collision | **Addressed.** §8.3: `$env` is the function-scope env (head); two read-back shapes; the runtime root chain |
| **F9** | The this-struct and the body env were two objects for one scope | **Addressed (C5b).** §4.7.5; `EnvInfo.hasThis` (§3.3); the two refusals lifted |
| **F10** | No C5 tests; the refusals being removed had no tests | **Addressed.** §13 cases 16-24, each labeled C5a/C5b/pre-C5 |
| **F11** | §7.1's `$this` placement disagreed with the shipped rule | **Addressed.** §7.1 restated: `$this` lives in the innermost needed env, which keeps it at the head under a chain |
| **F12** | The revision record was stale about C4 | **Addressed.** §0.1 fact 3; §6.1's "resolver-added" corrected to codegen |
| **F13** | §5.4 claimed a copy constructor per env class | **Addressed.** §5.4: only loop-header classes carry it |
| **F14** | The reserved-name refusal was not implemented, and C5 adds `$parent` | **Addressed outside this amendment, by ruling.** It is a separate pre-C5 commit (§4.6, §4.7.4, §14), with its own test (case 24). C5a must not start before it lands |

Nothing in the review is dismissed as unnecessary. The one scope reduction is by
ruling: the capture + explicit `this:` collision and the async-body `TS2332` move
to **C5b** rather than C5a (§4.7.6).

---

## 1. Ground truth — the mechanism this plan composes with

### 1.1 `Function<T>` and `_env`

```ts
@final export abstract class Function<T> {   // std/assembly/function.ts:3
  private _index: u32;                       // :4
  private _env: usize;                       // :5
  ...
  @unsafe private __visit(cookie: u32): void { __visit(this._env, cookie); }  // :34-37
}
```

- `_index` is written by `ensureRuntimeFunction` into a **static, memoized**
  memory segment for every ordinary function value (`src/compiler.ts:2194-2210`).
- `_env` is written as `0` there (`:2203`) and as a real value by
  `makeCapturingFunctionValue` for a this-capturing arrow (`:7534-7558`).
- The indirect call site reads `_env` and hands it to the callee
  (`:7212-7227`). The load is at `offset = usizeType.byteSize` — **4 on
  wasm32**, 8 on wasm64 — and `assertFunctionLayout` checks both offsets against
  the resolved class (`:7517-7520`).
- Non-capturing function values stay **static and allocation-free**; only
  capturing ones are heap instances. That distinction is preserved here.

### 1.2 The shipped `this` delivery (and the two stale claims it replaced)

`Resolver.markCapturingArrows` (`src/resolver.ts:2284-2291`) marks every arrow a
`this` lookup escaped, and gives each one a `this` local. `lookupThisExpression`
(`:2295-2402`) walks outward through arrows and stops at the nearest enclosing
**non-arrow** function. Codegen then:

1. emits a **prologue** at body start: `local.set this = global.get ~env`
   (`src/compiler.ts:1921-1934`), and
2. materialises a **heap** `Function<T>` with `_env` = the creating function's
   receiver (`makeCapturingFunctionValue`, `:7534-7558`).

`makeCallIndirect` saves the caller's `~env`, stores the callee's `_env`, calls,
and restores (`:7212-7227`). The `local.tee` shape at `:7223` is load-bearing:
a `local.set` + double read trips Binaryen's stack-IR assertion at
`optimizeLevel >= 2` (`docs/pipeline-notes.md`). Any new delivery code follows
the same shape.

**Historical, no longer true** (old plan §0.1:71-90): "the compiler writes `_env`
exactly once, always as zero" and "capture is detected at exactly two sites".
`_env` is now written per creation for capturing arrows, and `this` capture is
detected in the resolver, not only at the two `declaredByFlow` sites
(`src/compiler.ts:5771`, `:7747`, which still report `AS100: Not implemented:
Closures` for general capture).

### 1.3 What a "nested function declaration" is in this compiler — measured

**A nested `function inner() {}` is a function *expression*, not a declaration.**
`parseStatement` has no `Token.Function` case (`src/parser.ts:3083-3178`), so the
statement falls to `parseExpressionStatement`, and `parseExpression`'s
`Token.Function` arm calls `parseFunctionExpression` (`:4274-4278`). The
compiler then materialises a `Function<T>` value and binds the name as a scoped
local (`src/compiler.ts:7476-7505`).

Measured at `ccf888c6`:

```ts
export function outer(): i32 {
  let x: i32 = 1;
  function inner(): i32 { return 2; }
  return inner() + x;
}
```

emits `call $outer` for the outer call and **`call_indirect (type $0)` inside
`outer`**, preceded by the `~env` save/set/restore block. The call to `inner()` is
an **indirect** call through a `Function<T>` value.

This is the fact that shrinks F3 to nothing (§6.5).

### 1.4 The async state struct and the storage rule

`docs/async-await-plan-v2.md` §4.4 (adopted from the original closures plan):

> **A captured binding's storage *is* the environment.** … The storage rule for
> every binding: captured → **environment**; else live across an `await` →
> **state struct**; else **wasm local**. Capture wins over lifting, so the two
> never overlap.

The lowered shape is one `$env: TaskEnv | null` field per state struct
(`src/async/lower.ts:175`, `:375-397`), typed `TaskEnv` from
`std/assembly/task-rt.ts:54`. `f$resume` takes **one** parameter, the state
(`src/async/lower.ts:620`); the entry allocates the state, assigns the handle and
record, calls `f$resume(state)`, and returns the handle (`:517-560`).

This revision keeps the rule and changes *how the reference is carried*: the
closure transform produces an ordinary local of the synthesized env class, and the
async transform's existing lifting moves that local into a state field when it
crosses an await — a managed field of the concrete env class, which is the
"state struct references the environment" the rule requires. `$env` remains the
carrier for async **methods** (Decision 4) and for a capturing async function's
env as it crosses into `f$resume` (§8.3).

### 1.5 Memory model

- Guests build with `--runtime incremental`: the compiler default
  (`src/compiler.ts:244`), the generated framework config
  (`tension-framework/build.sh:154`), and all five examples.
- The guest heap starts at `MEMORY_BASE = 8388608`
  (`tension-framework/assembly/runtime/layout.ts:21`,
  `tension-framework/build/session.asconfig.json:6`). The arena below it is a
  fixed, session-scoped band with no allocator (original §0.2; unchanged).
- The collector's roots are `__visit_globals` plus the pin space plus a
  conservative scan of `[__stack_pointer, __heap_base)`
  (`std/assembly/rt/itcms.ts:155-173`, as cited by
  `docs/async-await-plan-v2.md` §4.4).
- Therefore the environment lives on the guest heap, managed, and every link that
  must survive a suspension is a managed field.

---

## 2. Semantics — match TypeScript

### 2.1 Capture by reference — one mechanism

All captured bindings are shared by reference, `const` included. The binding's
one home is an environment field; the owner and every closure read and write that
field. `const` is enforced at compile time by the transform (see §2.6), not by a
copy.

### 2.2 Environment granularity: per scope instance, chained

One environment per **scope instance** that owns at least one captured binding.
Every closure created in that instance shares it, so `inc`/`get` observe each
other's writes. Nested **owning** scopes chain via a `$parent` field, typed as the
parent env class; a scope that declares no captured binding has no env and no
link, so the chain is over owning scopes, not over lexical blocks.

A closure's `_env` names the **innermost** env it needs — its *head* — and a
reference to a binding further out walks `$parent` from there by a statically
known number of hops (§4.7.1, §6.2). That is what keeps one `_env` word able to
reach every scope a closure may legally capture from.

Rejected, with reasons: **per-closure** environments (two closures in one scope
would not share mutations); a **flat** env per closure (transitive capture needs
the chain); a **flat** env per top-of-scope (it would give every iteration's
closure the loop's last value, breaking §2.3).

### 2.3 Per-iteration bindings — the rule, not a hope

TypeScript creates a fresh binding per iteration for a `let`/`const` declared in
a `for` header. This plan matches it, with one rule:

> **A `for`-header binding that is captured lives in an environment; a fresh
> environment is created at the end of each iteration, before the incrementor
> runs, and the incrementor mutates the fresh one.**

Trace for `for (let i = 0; i < 3; i++) fns.push(() => i)`:

| step | env | `i` at body | closure captures |
|---|---|---|---|
| init | E1 | 0 | — |
| iter 1 body | E1 | 0 | E1 (i=0) |
| end of iter 1: clone → E2, `i++` on E2 | E2 | 1 | — |
| iter 2 body | E2 | 1 | E2 (i=1) |
| end of iter 2: clone → E3, `i++` on E3 | E3 | 2 | — |
| iter 3 body | E3 | 2 | E3 (i=2) |

Result `0,1,2`. The clone before the increment is what keeps iteration *k*'s
closure from observing iteration *k*'s increment.

`continue` runs the incrementor, so it must also run the clone; the transform
rewrites a `continue` that targets such a loop to `{ $clone; incr; continue; }`.
`break` skips both, correctly.

A binding declared **inside** a loop body is naturally per-iteration: the body is
a block, its env is allocated at the top of the block, and each iteration is a
new block instance. No clone is needed there.

`for…of`/`for…in` bind a fresh value per iteration: the transform allocates the
env at the top of the body and assigns the iteration value into it, using an
internal iteration variable when the user's binding is the captured one. If C1
finds this desugaring interacts badly with the iterator protocol, `for…of` captures
are refused by name ("a captured for-of binding (closures lowering)") and the gap
is documented — the rule is not weakened, the shape is refused.

### 2.4 `this` binding

- **Arrows bind `this` lexically.** The shipped resolver suffices for the
  `this`-only case; see §7.1 for the two-way split.
- **Regular function expressions have their own dynamic `this`.** Unchanged: the
  transform never rewrites `this` inside a non-arrow function.

### 2.5 Hoisting and TDZ

**AS has no hoisting of any kind.** Names resolve strictly in declaration order
(measured and unchanged from the original plan §1.5). This plan does not add
hoisting (D4).

The demotion changes what the compiler can check statically. A captured binding
is no longer a local, so:

- AS's definite-assignment analysis
  (`Variable_0_is_used_before_being_assigned`) no longer sees it;
- its field is zero-initialized by the env's constructor, so an unassigned read
  would silently return a zero.

**Rule.** For every captured binding declared **without an initializer**
(`let x: T;`), the env class gains an initialization flag field
`$init$<name>: bool`. The (rewritten) declaration sets it after the value is
stored; every read emits:

```ts
if (!$closureEnv.$init$x) abort("closures: read before assignment: x");
```

`abort` is the language's existing failure path (no exceptions; `Not implemented:
Exceptions`). For declarations **with** an initializer no flag is emitted: a
closure can only capture a binding declared before it, and a read can only follow
the declaration in declaration order, so the field is assigned before any read.

Cost: one `bool` field and one branch per read, only for the `let x: T;` shape.

**Under a chain (C5a)** the flag lives in the env that owns the binding, and it is
reached by the same hop walk as the value: `targetOf(binding, site)` supplies the
expression for the value read, the flag read and the flag write alike (§4.7.2).
The snippet above is that expression's `k = 0` case.

### 2.6 Checks the demotion moves

| Check | Today | After demotion |
|---|---|---|
| assign to a captured `const` | `TS2540` from the resolver | emitted by the transform (`DiagnosticCode.Cannot_assign_to_0_because_it_is_a_constant_or_a_read_only_property`, `src/diagnosticMessages.json:186`) at every assignment site it rewrites |
| read before assignment | `TS2454` (definite assignment) | runtime flag + `abort`, §2.5 |
| duplicate declaration / shadowing | resolver | unchanged — the transform mirrors the resolver's declaration-order scoping |
| captured binding without a declared type | n/a | refused by name (§4.6) |

### 2.7 What does not match TypeScript — the honest list

| Not supported | Why |
|---|---|
| Hoisting of function declarations and `var` | AS resolves in declaration order; orthogonal to closures (D4) |
| TDZ as a throw | no exceptions; §2.5's `abort` is the defined failure |
| `arguments` | does not exist in AS |
| `try`/`catch` across a closure call | no exceptions (async plan v2 §3.3's status model is unchanged) |
| `bind` | not implemented in AS and not added here (§7.3) |
| `eval`, `new Function` | no runtime compilation |
| generators / `yield` | unimplemented in AS |
| captured binding with an **inferred** type (`let n = 0`) | the transform runs before resolution and cannot name the field type — **refused by name** (§4.6). This is the plan's most visible divergence and is called out as D10. |
| captured binding whose type mentions a type parameter or a function-local type alias | not expressible as a top-level env field — refused by name (§4.6) |

---

## 3. Staging and transform architecture

### 3.1 `afterParse`, closures first, async second

Both transforms are AST rewrites at the same seam:

```
parse → afterParse[ ClosureLowerTransform → AsyncLowerTransform ] → initialize → compile
```

The reason is structural, not stylistic: the async transform refuses every
construct that could supply a capture (`src/async/lower.ts:293, :1332, :1463,
:1473-1480, :1993-1999`), and its lifting decision is made before resolution. If
closures ran later (or at codegen, as the original plan proposed), the async
transform would either refuse the capture or lift a captured binding into the
state struct — the double-storage bug §1.4 exists to prevent.

Running closures first turns the problem into ordinary code:

```ts
// user writes                          // after ClosureLowerTransform
function outer(): () => i32 {           function outer(): () => i32 {
  let n: i32 = 0;                         let $closureEnv: outer$Env = new outer$Env();
  return () => ++n;                       $closureEnv.n = 0;
}                                         return () => ++$closureEnvIn.n;
                                        }
```

(`$closureEnv` is the owner's env; the arrow reads the delivered one,
`$closureEnvIn` — §6.1.) The async transform then sees a local of a synthesized
class and ordinary field accesses; its existing rule lifts `$closureEnv` across an
await and leaves everything else alone. §8 works the composition through.

### 3.2 Registration and ordering — expressible today

`cli/index.js` builds a `transforms` array, instantiates each constructor
(`:455-472`), and `applyTransform` calls the hook **in array order**
(`:475-493`). The async transform is pushed at `:451`. The closure transform is
pushed on the line before it:

```js
transforms.push(assemblyscript.ClosureLowerTransform);   // new
transforms.push(assemblyscript.AsyncLowerTransform);     // existing, :451
```

and exported the same way as the async one (`src/index-js.ts:18` does
`export * from "./async/lower"`; a sibling `export * from "./closure/lower"` is
added). **No CLI machinery changes** — only one push and one export.

`afterParse` runs once, before `initializeProgram` (`cli/index.js:705-719`), so
both transforms are inside the same hook application and the ordering above is
the ordering that executes.

### 3.3 The side table

Capture facts are not AST facts (the clone hazard at
`src/compiler.ts:7331`+ and the generic-instantiation path make node metadata
unsafe). They live in a program-level table keyed by the function's declaration
node, mirroring the async transform's `src/async/ir.ts`
(`Map<AwaitExpression, AwaitSite>`, consulted by `src/compiler.ts`):

```ts
// src/closure/ir.ts
export const enum EnvKind { None, Receiver, Struct }

export class EnvInfo {
  kind: EnvKind = EnvKind.None;
  /** The class of the env this function's `_env` names — its HEAD env.
   *  Null when the function is not a closure value. */
  envClass: string | null = null;
  /** This function's body (or one of its nested scopes) allocates an env. */
  ownEnv: bool = false;
  /** This function is a closure value: it has `$closureEnvIn` and a prologue. */
  receivesEnv: bool = false;
  /** The class of the env this function's OWN body env links to (C5a);
   *  null at a root, or when the body owns nothing. */
  parentClass: string | null = null;
  /** C5b: the head env carries `$this` at field 0. */
  hasThis: bool = false;
  captures: Array<{ name: string; field: string; type: TypeNode }> = [];
}

export const envInfoOf = new Map<FunctionDeclaration, EnvInfo>();  // program-scoped
```

`EnvKind` stays three-valued (`None` / `Receiver` / `Struct`): a chain still
stores **one** env object in `_env`, so a `StructChain` kind would add a
distinction no consumer reads. What codegen and the transforms need beyond the
kind is the four facts above:

| field | read by | for |
|---|---|---|
| `kind`, `envClass` | `compileFunctionExpression` (`src/compiler.ts:7526-7535`) | which value shape to build, and which class its `_env` names |
| `kind == Struct` | `compileFunctionBody` (`src/compiler.ts:1830-1841`, `:1966-1985`) | the `$closureEnvIn` local and its prologue |
| `ownEnv`, `parentClass` | the closure transform | whether to allocate a body env and what constructor argument it takes (§4.7.3, §6.1) |
| `receivesEnv` | the closure transform | whether the body env has a parent at all (a nested owner that is itself a closure) |
| `hasThis` | the async transform (C5b) | which read-back shape §8.3(a) emits, and whether a this-struct is synthesized |

The table is keyed by the **original** declaration; generic clones inherit
through the prototype.

A second map records, per **creation site**, which local holds the environment to
store in the value's `_env`:

```ts
export const creationEnvOf = new Map<FunctionExpression, string>();
```

The same function can be created in more than one scope (a nested arrow inside a
block, the block executed twice), so the site is the key, not the declaration.
The local recorded is the one holding the closure's **head** — the `needed`
scope's local when the creating function owns it, otherwise `$closureEnvIn`
(§4.7.2). It is **not** "the innermost owning scope at the site": those differ
whenever a block owns an env for one closure and a sibling closure captures only
an outer binding. Measured on `p.ts`:

```ts
export function main(): i32 {
  let a: i32 = 1; let out: i32 = 0;
  { let b: i32 = 2;
    const h = (): i32 => b;      // needs the BLOCK env
    const g = (): i32 => a;      // needs the FUNCTION env, though its site is the block
    out = h() + g(); }
  return out;
}
```

Both creations are in the same block, and the shipped compiler already stores
different envs: `p.wat` loads `$closureEnv$1` for `h` and `$closureEnv` for `g`
(`$p/main`, the two `local.get`s before the `_env` stores). The plan's old
wording described neither.

### 3.4 What the transform does, in one pass over each source

1. **Detect.** If a source declares no function expression or arrow with a
   non-`this` capture, it is left byte-identical (§3.6). This is the fast path
   and the reason non-closure programs do not change.
2. **Analyse** free variables per function (§4).
3. **Synthesize** one env class per owning scope, hoisted to the source's top
   level (a class declaration inside a function body is block-scoped and refused
   by the compiler — `src/compiler.ts:3608` — so the class must be top-level).
4. **Rewrite**: allocations at scope entries, declarations into field
   assignments, references into `env.field` accesses, `this` into
   `env.$this` for Struct arrows, loop headers per §2.3.
5. **Mark**: record `EnvInfo` per function in the side table.

### 3.5 No new AST nodes and no new AST fields

The transform emits only existing node kinds (`ClassDeclaration`,
`FieldDeclaration`, `VariableStatement`, `PropertyAccess`, `CallExpression`,
a call to `abort`, `CommaExpression`). This keeps
`src/extra/ast.ts` untouched and keeps the AST free of lowering metadata, which
is what makes Backend B a swap (§10). The one structural addition is the
**side table**, which is program-level, not AST.

### 3.6 Byte-identity guarantee

A program with no non-`this` capture must compile to the same bytes as
`bb2dde70`. That includes this-only arrows, which stay on the shipped `Receiver`
path. The transform's fast path guarantees it structurally: it returns before
mutating anything when no function has a non-`this` capture. Verified in C2 with
the same three-program × plain/`--optimize` check the async work uses.

---

## 4. Capture analysis

### 4.1 Free variables

For each function expression/arrow `F`, walk its body with a scope stack that
mirrors the resolver's declaration-order rules and collect identifiers that
resolve to a binding declared in an **enclosing function scope** (parameter or
local, in an enclosing block or loop header).

Not free variables:
- module-level globals, imports, enum values, namespace members;
- class members (a method's `this` — handled separately);
- `F`'s own parameters and locals, including its own name for a named
  function expression.

Property names are not references: only `PropertyAccessExpression.expression` is
walked, never `.property` (the async transform's walker does the same,
`src/async/lower.ts:1429-1431`).

### 4.2 Scoping and shadowing

AS has no hoisting, so a name is visible only after its declaration in the same
or an enclosing block. The analysis mirrors that exactly:

- statements are walked in order; a declaration extends the current scope from
  that point onward;
- a nested block pushes/pops a scope;
- an inner declaration shadows an outer one from its declaration onward —
  references before it still resolve outward, because that is what the resolver
  does.

The transform does not attempt to re-implement type resolution; if its scoping
disagrees with the resolver, the rewritten AST fails to compile (an undefined
`$closureEnv`/field) rather than silently miscompiling. The test matrix includes
the shadowing cases so a disagreement is caught.

### 4.3 Transitivity

A function is **env-needing** if it captures at least one binding, or if any
function nested inside it is env-needing (it must pass the env along). Computed
bottom-up.

A function gets:
- `ownEnv` if it declares any captured binding (including `this` per §4.4),
- `receivesEnv` if it is env-needing but does not own the bindings it reaches —
  i.e. it is a closure value that must be handed an environment.

A function that is env-needing only because a descendant is, and that owns no
captures, still receives and forwards the env (its `_env` is the creating
scope's).

### 4.4 `this` attribution

`this` inside an arrow denotes the nearest enclosing **non-arrow** function's
receiver. The transform attributes a `$this` field to that function's env:

- If the arrow captures `this` and nothing else → **`Receiver`**, untouched by
  this transform (the shipped path).
- If the arrow captures `this` and at least one other binding → **`Struct`**,
  with `$this` at field 0 of the env owned by the nearest enclosing non-arrow
  function, initialized from that function's `this` at its scope entry.
- A `this` reference inside an arrow nested in another arrow resolves to the same
  nearest non-arrow function; the chain walk reaches its env.

A regular function expression's `this` is dynamic and is never captured.

### 4.5 Classification — three cases, not two

| Case | `envKind` | Value representation | Allocation |
|---|---|---|---|
| no capture | `None` | static `Function<T>`, `_env = 0` | none |
| `this` only (arrow) | `Receiver` | heap `Function<T>`, `_env` = receiver (shipped) | one heap value, **no env struct** |
| any non-`this` capture | `Struct` | heap `Function<T>`, `_env` = env object | one heap value + one env per scope instance |

`isCapturing` is not a boolean: a this-only arrow is a closure in the semantic
sense and still costs no environment. The cost table is what test case 11
asserts (§13).

### 4.6 v1 refusals (named, never silent)

- **A captured binding without a declared type** — `let n = 0;` — refused:
  `Not implemented: a captured local without a declared type (closures lowering)`.
  The transform runs before resolution and cannot name the field's type. This is
  the plan's sharpest divergence from TS and is D10.
- **A captured binding whose declared type mentions a type parameter** of an
  enclosing function — refused by name (a top-level env class cannot be generic
  in v1; the extension is a generic env class, deferred).
- **A captured binding whose declared type is a function-local type alias** —
  refused by name (the env class is top-level; the alias is not visible there).
- **A user declaration in the reserved namespace** — refused by name. The
  closure names are `$closureEnv`, `$closureEnvIn`, `$closureEnv$<n>`, `$this`,
  `$parent`, and `$init$…`; the async state struct already reserves `$env`,
  `resumePoint`, `result`, `handle`, and `record`
  (`src/async/lower.ts`'s `isReservedStateField`). **This refusal is not
  implemented in the tree yet** — measured: `let $parent: i32 = 7;` captured by
  an arrow compiles to `main$Env.$parent`. It lands as a **separate pre-C5
  commit** (F14, §4.7.4), before C5a introduces that field.

Each refusal is a `DiagnosticCode.Not_implemented_0` with the shape named, so a
program never reaches codegen with a half-rewritten body.

---

## 4.7 C5 — parent-chain captures, and one env per scope instance (new)

C5 makes §2.2's chain executable. It is split by the architect's ruling into
**C5a** (the chain and nested owners) and **C5b** (the receiver/body-env
unification), because the two un-refuse different shapes and carry independent
tests. Both are closure-transform work plus the side-table data in §3.3; neither
changes `compiler.ts`'s call convention, the `~env` delivery (§6.4), or the async
transform's planner.

### 4.7.1 The invariant

**The scopes a closure captures from are a path in the lexical scope tree**, and
every scope on that path that owns a captured binding has exactly one environment
object (§2.2). The closure's `_env` names the **innermost** such environment —
its *head* — and a reference to a binding owned further out is the field access
reached by following `$parent` links from the head; the number of links is a
compile-time constant (§6.2).

Three consequences, each load-bearing:

- **One storage location per binding.** The chain is object links; nothing is
  copied. A write at any depth is visible to every reader (§2.1).
- **The head is what the closure needs, not where the closure sits.** A closure
  created inside a block that owns an unrelated env still heads at the innermost
  env *it needs* (§4.7.2). This keeps `_env` minimal and the hop count exact.
- **The chain skips non-owning scopes.** A scope that declares no captured
  binding has no env class and no `$parent`; hops are counted over *owning*
  scopes, not lexical blocks.

### 4.7.2 C5a — the head, the hop, and multi-scope `needed`

Today `needScope` refuses a function's second distinct referenced scope
(`src/closure/lower.ts:610-615`) and `FunctionInfo.needed` holds one `Scope`.
C5a replaces the refusal with a selection:

> **`needed` is the innermost scope among the scopes whose bindings this function
> references.** Every other referenced scope is an ancestor of `needed` (the
> lexical path is unique), so a reference's hop count is the number of *owning*
> scopes on the path from `needed` (exclusive) to the binding's scope
> (inclusive).

The reference rewrite (§6.2) is unchanged in shape; what C5a adds is that `k` may
now exceed 1 and is derived, not restricted to 0 or 1.

- **At a creation site**, `creationEnvOf` records the local holding the head: the
  `needed` scope's local when the creating function owns it (`$closureEnv` /
  `$closureEnv$<n>`), otherwise `$closureEnvIn` (§3.3).
- **Inside a closure**, the head is `$closureEnvIn`, and the expression is
  `$closureEnvIn (. $parent!)*k . field`.
- **Inside an owner's own body**, the head is the innermost owning-scope local
  visible at the reference (`$closureEnv$<n>` or `$closureEnv`), and the walk goes
  outward the same way. A reference inside the scope that owns the binding has
  `k = 0`.
- **`$init$` flags use the same walk.** One `targetOf(binding, site)` supplies the
  expression for the value read, the flag read, the flag write and the `const`
  check; §2.5's snippet is its `k = 0` case.

**The canonical shape, worked through.** A loop header and a body block are two
owning scopes of `main`:

```ts
for (let i: i32 = 0; i < 3; i++) {
  let now: i32 = i * 10;
  fns.push((): i32 => i + now);
}
```

The closure `needed`s the body block (it owns `now`, the innermost) and hops one
link to the header env for `i`. Schematic (class names and `$n` numbering are
placeholders; the numbering is §5.6's source order):

```ts
let $closureEnv$1: main$Env$1 = new main$Env$1();                  // header, root
$closureEnv$1.i = 0;
for (; $closureEnv$1.i < 3; $closureEnv$1.i++) {
  let $closureEnv$2: main$Env$2 = new main$Env$2($closureEnv$1);   // body
  $closureEnv$2.now = $closureEnv$1.i * 10;
  fns.push((): i32 => $closureEnvIn.$parent.i + $closureEnvIn.now);
  $closureEnv$1 = new main$Env$1($closureEnv$1);                   // clone (§5.4)
}
```

The body env's parent is the header env **as it stands before the clone**: the
clone runs after the body, so iteration *k*'s body env keeps iteration *k*'s `i`.
The clone copies `$parent`, which does not change (§5.4).

`main`'s own function-body scope owns nothing here, so the header env is the root
and has no `$parent` field — the "skips non-owning scopes" rule in practice.

### 4.7.3 C5a — nested owners

The analysis runs per top-level function and per method today; a binding owned by
a nested owner is refused twice (`src/closure/lower.ts:512-514`, `:1013-1017`).
C5a removes both:

> **Any function or block that declares a captured binding owns an
> environment**, whatever its nesting: a nested `function`
> expression/declaration, a block-bodied arrow, a method, a top-level function.
> The allocation is at the owning scope's entry (§5.3); the class is hoisted to
> the source's top level (§5.2).

Two mechanical consequences:

- **Class naming.** The class is named after the **owning function**:
  `<ownerName>$Env` / `<ownerName>$Env$<n>`, with §5.2's counter for an anonymous
  owner and the async transform's collision check (`src/async/lower.ts:354`).
  The shipped naming loop uses `this.owner.name` for every function scope
  (`src/closure/lower.ts:508-530`); with nested owners, two owners would produce
  the same class name.
- **The owner's own parent.** A nested owner that is itself a closure value has
  both `$closureEnvIn` (the head it received) and its own body env; the body env's
  `$parent` is `$closureEnvIn`, passed to its constructor (§6.1). An owner that
  is not a closure value has a root body env. `EnvInfo.parentClass` records which
  class that link has — or null at a root.

A nested owner's body env is an ordinary local of its own body, so the async
transform's existing lifting rule carries it across an await (§8.3(b)); C5a adds
no async-specific rule.

What stays refused (§7.1a): a static method (no receiver value to store) and a
**top-level function expression** as an owner (its owner would be the module,
whose entry is the start function). Both are unchanged by C5a.

### 4.7.4 The reserved-name gate (F14) — pre-C5, separate commit

C5a adds a `$parent` field to synthesized classes, and a user binding named
`$parent` exists today (measured: `let $parent: i32 = 7; const f = () =>
$parent` compiles to `main$Env.$parent`). The guard in §4.6 therefore lands
**before** C5a, as its own commit with its own test (case 24). This amendment
does not implement it and does not specify its internals; it records the
dependency: **C5a must not start before the guard is on the tree.**

### 4.7.5 C5b — one env per scope instance, receivers included

Two objects already stand for one scope instance today. An async method that owns
a captured local and reads `this` compiles to `k/m$Env` (the captured local) and
`k/m$ThisEnv` (the receiver), with separate constructors and no link (measured:
the module carries both classes, and the state struct has both `$closureEnv` and
`$env` setters); the this-struct is `state.$env` and the body env is lifted as
`$closureEnv` (§8.3(b)). What no shape reaches is a *single closure needing
both*, because an arrow capturing `this` in an async body is refused (`TS2332`)
and a nested owner is refused. C5a removes the second; C5b removes the first by
unifying the two objects:

> **One environment per scope instance.** When a function's body owns an env and
> the function has a receiver, the **body env carries `$this` at field 0** and is
> the function-scope env; no this-struct is synthesized. When the body owns no
> env but the function has a receiver, the synthesized this-struct is the
> function-scope env (the head), and it carries `$parent` when the function is
> also a closure value.

The closure transform's `needsThis` currently fires only when an *arrow* captures
`this` (`src/closure/lower.ts:537-551`). C5b extends the condition: an owner with
a receiver whose **own body** reads `this` and owns an env sets it, and
`EnvInfo.hasThis` (§3.3) records the fact for the async transform.

Two refusals then lift:

- **Capture + explicit `this:`** (`src/async/lower.ts:426-434`) — `$env` now holds
  one object, so the receiver's struct and the captured env no longer compete for
  it; the closure env is `$env.$parent` (§8.3(a)'s second shape). Case 21.
- **`TS2332` for an arrow capturing `this` in an async body** — with `this` a
  field of the body env, the closure transform rewrites it before the resolver
  sees a `ThisExpression`, exactly as C2b does for a non-async method. Case 22.

The static-method refusal is untouched (there is no receiver value to store).

### 4.7.6 The boundary

| | C5a | C5b |
|---|---|---|
| two-scope capture | **yes** — multi-scope `needed`, hops, `$parent` | unchanged |
| nested owners | **yes** — nested functions and block-bodied arrows | unchanged |
| capture + explicit `this:` | **still refused** | **un-refused** |
| arrow capturing `this` in an async body (`TS2332`) | **still refused** | **un-refused** |
| async method with a body env **and** `this` | two objects, as today | **one object** |
| `_env` / `$env` meaning | unchanged from C4 (head env; §8.3 as shipped) | head env; both read-back shapes |
| reserved-name guard (F14) | **required before start** | — |
| tests | 16-20 | 21-23 |

C5a changes the closure transform and §3.3's data only. It is expected to need
**no** `compiler.ts` change: the prologue and the creation branch already key off
`EnvKind.Struct`/`envClass` (`src/compiler.ts:1830-1841`, `:7526-7535`). If a
counterexample is found, it is that branch, and the dispatch reports before
changing it. C5b adds `hasThis`'s recording and the async transform's second
read-back shape (§8.3), plus the two refusal deletions.

---

## 5. The environment

### 5.1 Where it lives

The guest heap above `MEMORY_BASE`, as a managed AS object. Rejected: the arena
(no allocator), `BUFFER_POOL` (a hand-carved static layout), the completion
record (transient), a static segment (aliases two live envs), the wasm stack (the
frame is gone by definition).

### 5.2 Layout and class synthesis

For each owning scope, the transform emits one class at the source's top level:

```ts
class window$Env$2 extends TaskEnv {
  $this: C = changetype<C>(0);         // field 0, only if the env carries a receiver (§7.1, C5b)
  $parent: window$Env$1 | null = null; // next, only if this scope has an owning ancestor
  n: i32 = 0;                          // one field per captured binding, declaration order
  $init$x: bool = false;               // only for declarations without initializer (§2.5)
}
```

Field order is fixed: `$this` first (field 0, per Decision 1), then `$parent`,
then the captured bindings in declaration order, then the `$init$` flags. The
order must be stable because every environment of the same scope shape shares
one class.

**When `$parent` exists.** It is emitted when the scope this class represents has
a nearest **owning** ancestor scope — that is, when walking outward from this
scope, the first scope that owns a captured binding exists. It is **not**
conditioned on the owner being a closure: the canonical two-scope shape's owner
is `main` (not a closure), and both its header env and its body env need the
link (§4.7.2). The root env of a chain has no `$parent` field at all, rather than
a permanently null one.

**Construction.** Every class with a `$parent` field takes the parent as a
constructor argument: `new X$Env(parentLocal)`. A loop-header class also carries
§5.4's copy constructor; because AS has no overloads, the two are one constructor
with two optional parameters —

```ts
constructor(source: X$Env | null = null, parent: Parent$Env | null = null)
```

— and `source` wins when both are given (the shipped optional-parameter trick,
`src/closure/lower.ts:1150-1198`). The copy path sets `$parent` from
`source.$parent`; the allocation path sets it from `parent`. A **root** class has
no `$parent` field and therefore no parent parameter; it is constructed with no
argument (or, for a loop header, with the source alone).

**The wat this should produce (expected, not yet measured).** For §4.7.2's
canonical shape: two classes (`<owner>$Env` for the loop header, `<owner>$Env$<n>`
for the body); accessors `<owner>$Env$<n>#get:$parent` / `#set:$parent` on the
body class; the body allocation calling its constructor with the header local;
and, inside the closure, a read of `i` compiled as `$closureEnvIn.$parent.i`
(`<owner>$Env$<n>#get:$parent`, then `#get:i`). The header class has no `$parent`
accessor, because it is the root.

- **Base: `TaskEnv`** (`std/assembly/task-rt.ts:54`). This is deliberate: the
  state struct's `$env` field is typed `TaskEnv | null`, and the environment must
  be assignable to it when an async method or a resumed async function carries
  it (§8.3). One base class serves both the closure env and the async-method
  this-struct; `TaskEnv` declares no fields, so it costs nothing but a type.
- **Managed.** Every field is traced by the generated visitor; a reference-typed
  capture and the `$parent` link are both reachable while a task is suspended.
- **Field types** are the bindings' declared types, copied verbatim. The env
  class is emitted at top level, so those types must be nameable there (§4.6).
- **Names** are `<ownerName>$Env` / `<ownerName>$Env$<n>`, where `ownerName` is
  the **owning function** — including a nested owner (C5a, §4.7.3). A counter
  disambiguates anonymous owners, and the transform checks the synthesized name
  against the source's declarations (the async transform's rule,
  `src/async/lower.ts:354`).

### 5.3 Allocation: at scope entry, not at analysis time

Analysis is a compile-time fact; allocation is a runtime event. The transform
inserts the allocation at the **entry of the scope instance that owns the
bindings**:

- function body → first statement of the body;
- block → first statement of the block;
- `for` header → before the loop (plus the per-iteration clone, §2.3);
- `for…of` body → first statement of the body.

One allocation per scope instance. Fields are zero-initialized by the env's
constructor; the rewritten declarations assign real values at their declaration
points. A closure created before a later declaration cannot occur (no hoisting).

**The parent at each site.** A function body's env is parented to
`$closureEnvIn` when the function is a closure value, and is a root otherwise. A
block or loop-body env is parented to the innermost enclosing owning scope's
local at that point — which, inside a header-capturing loop, is the iteration's
header env before the clone (§5.4).

### 5.4 Loop environments — the concrete rewrite

**Header binding (`for (let i = …; cond; incr) body`), when `i` is captured:**

```ts
// before
for (let i: i32 = 0; i < n; i++) body(i)
// after — schematically
let $closureEnv: f$Env = new f$Env();
$closureEnv.i = 0;
for (; $closureEnv.i < n; $closureEnv = new f$Env($closureEnv), $closureEnv.i++) body($closureEnv.i)
```

`new f$Env($closureEnv)` is the copy constructor the transform synthesizes — one
per **loop-header** env class, not one per env class (§4.7.3's constructor rule
covers a parent). It copies every value field, `$this`, the `$init$` flags, and
`$parent`; copying `$parent` is what keeps the enclosing link intact across the
clone. Because the clone is part of the incrementor, a `continue` executes it
(the language already runs the incrementor on `continue`), and a `break` skips
it. (The local is shown as
`$closureEnv`; a loop whose header scope is nested inside another owning scope
uses `$closureEnv$<n>`, §5.6.)

**Body binding (`for (…) { let x: i32 = …; const f = () => x; }`)** — the block's
env is allocated at the top of the body, so each iteration allocates its own:
no clone and no special case. Its `$parent` is the enclosing owning env at that
moment; inside a header-capturing loop that is **the header env before the
clone**, which is why iteration *k*'s body env keeps iteration *k*'s `i`
(§4.7.2).

**`for…of`:** allocate at the top of the body and assign the iteration value
(§2.3).

### 5.5 Lifetime and GC

Under `incremental`, an environment is collected when nothing reachable refers to
it. The chains that keep one alive:

- a closure value's `_env` (traced by `Function<T>.__visit`,
  `std/assembly/function.ts:34-37`);
- a state struct's lifted `$closureEnv` field (a managed field, generated
  visitor);
- a stack local (conservative scan);
- a parent env's `$parent` link (child → parent; the child is alive only through
  a closure or a local, so the parent follows).

A returned closure works: the heap value holds `_env`, the caller holds the
value, the collector follows it (case 7).

### 5.6 Names

- **`$closureEnv`** — the env owned by a function's **body** scope.
- **`$closureEnv$<n>`** — the env owned by a nested scope (block or loop body) of
  the same function, numbered in source order. Every owning scope needs its own
  local; a function may own several.
- **`$closureEnvIn`** — the env a function **received** (one per function; the
  local is added by codegen, §6.1).
- **`$parent`**, **`$this`**, **`$init$<name>`** — fields of an env class.
- **`<owner>$Env`** / **`<owner>$Env$<n>`** — the synthesized classes.

All of these are reserved: a user parameter, local, or declaration using one is
refused by name.

---

## 6. Lowering

### 6.1 The two locals

- **`$closureEnv`** — the environment this function's **body** owns (a nested
  owning scope uses `$closureEnv$<n>`, §5.6). Declared by the transform at the
  scope entry: `let $closureEnv: f$Env = new f$Env(parentLocal);` — the parent
  argument is present exactly when the class has a `$parent` field (§5.2), and is
  the head local in scope at that entry (`$closureEnvIn` for a nested owner that
  is itself a closure value).
- **`$closureEnvIn`** — the environment this function received. Its local is
  added by **codegen**, before the body is compiled (`src/compiler.ts:1830-1841`)
  — not by the resolver, which has no `$closureEnvIn` — and filled by the
  prologue from `~env` (`:1966-1985`), for a function whose prototype is
  `EnvKind.Struct`.

A function may have both (it owns bindings and is itself nested). Its body env's
constructor receives `$closureEnvIn` as the parent, so the link exists from the
first read and needs no separate assignment statement. The transform records that
link's class as `EnvInfo.parentClass` (§3.3).

**Nested owners (C5a).** Any function or block that declares a captured binding
owns an env, including a nested function or a block-bodied arrow (§4.7.3). The
analysis runs per owning function; the class is hoisted to the source top level
and named after the owning function (§5.2). The allocation stays at the owning
scope's entry (§5.3), so a nested owner's body env is an ordinary local of its own
body and the async transform's existing lifting rule carries it across an await
(§8.3(b)).

The compiler reads the creator's env local for a given creation site from
`creationEnvOf` (§3.3): it is the local holding the **head** the closure needs —
the `needed` scope's local when the creating function owns it (`$closureEnv`, a
`$closureEnv$<n>`), otherwise `$closureEnvIn` (§4.7.2).

### 6.2 Reference rewrite

A reference to a binding owned by scope `S` becomes, inside function `F`:

```
envExpr(F) ($parent! × k) . field
```

where `k` is the number of **owning** env layers between `F`'s head and `S`'s
env, known statically (§4.7.2): `k = depth(S) − depth(head)`, counted over scopes
that own a captured binding. Because each env class types its `$parent` as the
concrete parent class, the walk needs no casts — only a non-null assertion per
hop (the transform emits `!`, a normal AS expression).

The head is `$closureEnvIn` for a reference inside a closure, and the innermost
owning-scope local visible at the reference for one inside an owner's own body
(§6.1). `k = 0` is the single-env case the shipped C1-C4 code already emits;
`k = 1` is §4.7.2's canonical loop; `k > 1` is a chain of three or more owning
scopes.

One helper, `targetOf(binding, site)`, produces the expression for every use:
value read, the `$init$` flag read, the flag write, and the `const`-assignment
check. That is what keeps a guarded read from reading the flag off a different
object than the value (§2.5, F7).

Assignments, compound assignments, and `++`/`--` are rewritten to the same
target, which is what makes `let n: i32 = 0; const f = () => ++n;` share one
storage.

### 6.3 Creation site

One site: `compileFunctionExpression` (`src/compiler.ts:7331`), where the value
is materialised (`:7470-7475`). Today:

```ts
if (instance.prototype.capturesThis) expr = this.makeCapturingFunctionValue(instance);
else expr = <static instance from ensureRuntimeFunction(instance)>;
```

This revision adds the `Struct` branch:

```ts
if (instance.prototype.envKind == EnvKind.Struct) expr = this.makeEnvFunctionValue(instance, envLocalName);
else if (instance.prototype.capturesThis) expr = this.makeCapturingFunctionValue(instance);
else /* static */;
```

`makeEnvFunctionValue` is `makeCapturingFunctionValue` with the environment
expression sourced from the local recorded for **this creation site** in
`creationEnvOf` (§3.3) instead of from the `this` local. The `Receiver` path is
untouched, which is what keeps the shipped arrow-this output byte-identical.

### 6.4 Delivery at the call

**No change to `makeCallIndirect` is needed.** It already saves `~env`, stores
the callee's `_env` (offset `usizeType.byteSize`), calls, and restores
(`src/compiler.ts:7212-7227`) — for every indirect call, capturing or not. A
`Struct` closure's `_env` therefore arrives in `~env` exactly as a `Receiver`
arrow's receiver does.

The only new codegen is the **prologue** for a `Struct` function:

```wat
local.set $closureEnvIn (global.get $~env)
```

emitted at body start, after the body is compiled, mirroring the `capturesThis`
prologue (`:1921-1934`). It runs once on entry, so a nested call inside the body
cannot clobber the binding — the same property the `this` prologue has.

### 6.5 Direct calls — measured, and the fallback

**Finding: there is no direct call to a capturing function.** The three ways a
function can be called in this compiler:

| call shape | target | can it capture? |
|---|---|---|
| `f(args)` where `f` is a top-level declaration | `ElementKind.Function` direct (`src/compiler.ts:6234-6244`, `:7110-7117`) | **No** — no enclosing function scope |
| `obj.m(args)` | `ElementKind.Function` direct with `thisArg` | **No** — `this` is `param 0`; a method cannot be inside a function scope (block-scoped classes are refused, `:3608`) |
| `g(args)` where `g` is a local/field/parameter holding a function value | indirect (`compileCallIndirect`) | **Yes**, and `~env` is delivered |

Nested `function inner(){}` declarations are the third row, **measured** (§1.3).
So Decision 3's sub-problems dissolve:

- **(a) Static instance**: only relevant if a capturing function were reachable
  as a *static* value. It is not: every capturing function is created by
  `compileFunctionExpression`, which takes the `Struct` branch and builds a heap
  instance. No declaration-codegen rework.
- **(b) Direct-call delivery**: no site needs it. `compileCallDirect` is
  unchanged.

**Fallback.** If C1's implementation finds a `ElementKind.Function` call whose
callee is `Struct` (the only way: a future construct that puts a function scope
inside a class body, or block-scoped classes landing), the transform **refuses it
by name** — `Not implemented: a direct call to a capturing function (closures
lowering)` — and the gap is recorded. It does not silently pass a stale `~env`.

### 6.6 Codegen that is *not* needed

Because the transform rewrites captures into ordinary field accesses before
resolution, the two `declaredByFlow` error sites
(`src/compiler.ts:5771`, `:7747`) never fire for a lowered program, and no
capture-walk codegen is required at either site. The `AS100: Not implemented:
Closures` diagnostics there are deleted in C2's own commit once the transform
proves it handles the shapes (D7).

---

## 7. `this`, `super`, and methods

### 7.1 `Receiver` vs `Struct`

| arrow captures | `envKind` | `_env` holds | prologue |
|---|---|---|---|
| `this` only | `Receiver` | the receiver | reads `~env` into the `this` local (shipped) |
| `this` + a local | `Struct` | the env object | reads `~env` into `$closureEnvIn` |
| a local only | `Struct` | the env object | reads `~env` into `$closureEnvIn` |

In the `Struct` case, `this` is field 0 (`$this`) of the env of the **innermost
scope whose binding the arrow captures** — the body env when `this` is the only
local source, a block env when the arrow also captures a block binding. That is
the shipped C2b rule (`src/closure/lower.ts:537-551`, `let env =
innermost.needed`), not "the env of the nearest enclosing non-arrow function".
It is initialized at that scope's entry from the owner's `this` (a parameter, so
always available where a `this` exists at all). References to `this` inside the
arrow are rewritten to `env.$this`; the resolver never sees a `ThisExpression`
there, so `capturesThis` is not also set — no double storage.

The placement has a second, load-bearing property under a chain: because the env
holding `$this` is the one the arrow `needed`s, **`$this` is always a field of
the head**. A chain never hops to reach the receiver; only captured bindings
walk `$parent`.

**One exception (C5b).** A this-only arrow inside an async body cannot use the
`Receiver` path: the function creating it is `f$resume`, which has no `this` to
put in `~env`, and the resolver answers `TS2332` (measured). C5b classifies that
arrow as `Struct` against the enclosing function-scope env and stores the
receiver there (§4.7.5). Outside that exception a struct is created only when at
least one non-`this` capture justifies it, so a `$this`-only struct does not
occur in a non-async function.

### 7.1a Owner kinds — what may own an environment

The rules above say where `$this` lives; this says *whose* environment it can
live in. An **owner** is a function or block whose body declares bindings that a
nested function captures, and therefore allocates the environment.

| Owner kind | May own an environment | Why |
|---|---|---|
| a top-level `function` declaration | **yes** | its body declares the captured bindings |
| an instance or prototype **method** | **yes** | its body declares the bindings, and its `this` is `param 0`, so `$this` has a value to hold at scope entry |
| a function with an explicit **`this:` parameter** | **yes** | the explicit parameter supplies the receiver (`signature.explicitThisType`) |
| a **static method** | **no** | `this` there is the class object, not a receiver parameter; there is no value to store, and its members are globals |
| a function expression at the top level | **no** (C1 scope) | the environment's owner would be the module, whose "entry" is the start function; deferred |
| a **nested** `function` or block-bodied arrow | **yes (C5a)** | its own frame is where the environment is allocated, and §4.7's chain lets a deeper closure reach it; the class is hoisted and named after the owner (§4.7.3) |
| a nested **async** function | **yes** | lowered as an entry + `f$resume` pair; its body env is lifted as a state field (§8.3(b)) |

Two consequences:

- **`$this` is initialized at the owning scope's entry** from whatever the
  owner's `this` is — the method's `param 0`, or the explicit `this:` parameter.
  A block-scoped owner initializes it at the block's entry, where `this` is
  still in scope, so no parent chain is needed. (The nested-owner and
  body-env-carrying-`$this` rows are C5a/C5b; the rest are shipped.)
- **`$this` is field 0 whenever the environment carries a receiver.** It is the
  only field whose position is fixed; the captured bindings follow in
  declaration order, then the `$init$` flags.

A method that owns no environment is unchanged: the transform only rewrites the
bodies of methods that declare captured bindings, and a static method is skipped
entirely.

### 7.2 Arrows nested in arrows

The `this` walk stops at the nearest **non-arrow** function
(`src/resolver.ts:2295-2402`), so nested arrows share one `$this` field, reached
through the env chain. A nested arrow that captures a binding from its own
enclosing arrow's block gets that block's env; the chain links it to the outer
env that holds `$this`.

### 7.3 Methods are unbound — measured

```ts
class C { x: i32 = 7; m(): i32 { return this.x; } }
export function main(): i32 { const c = new C(); const f = c.m; return f(); }
```

**measured:** `TS2685: The 'this' types of each signature are incompatible.` —
the compiler refuses to call a detached method value without a receiver, which is
the TypeScript behaviour (unbound method, `this` undefined under strict mode).
`Function<T>` has **no `bind`** (grep: no occurrence in `std/assembly/` or
`src/builtins.ts`); `f.call(c)` is the supported explicit-receiver path and
**measured** to compile (`Function#call`, `src/builtins.ts:745`, `:3888-3921`,
which routes to `compileCallIndirect` and therefore delivers `~env`).

**Rule.** Method values are unbound; no receiver-binding mechanism is added.
Case 3 asserts the diagnostic and the `.call(c)` path (§13).

### 7.4 Async methods — `$env` populated unconditionally (Decision 4)

An async method's `this` must survive suspension, and a method has no `_env` of
its own. Per the architect's ruling:

- The async transform synthesizes `f$ThisEnv extends TaskEnv { $this: C }` for a
  method that owns **no** body env. It has no `$parent`: a method cannot capture
  from an enclosing function (methods are not nested), so its this-struct is
  always a root.
- The entry populates `state.$env = new f$ThisEnv(this)` **unconditionally** for
  every such method — before `f$resume(state)` — so the sync prefix runs with it
  in place. C5b's unification (D16) folds the receiver into the body env when the
  method owns one (§4.7.5), so exactly one object exists either way.
- `this` in the method body is rewritten, at each occurrence, to
  `changetype<f$ThisEnv>(state.$env).$this`, or — when the body env carries the
  receiver (C5b) — to `changetype<F$Env>(state.$closureEnv).$this`. **A read per
  occurrence, not a hoisted local**: a local would have to be lifted across every
  await to stay correct, and the field read is always current by construction.
- The same mechanism serves a free `async function` with an explicit `this:`
  parameter — the receiver is `param 0` there too, and the this-struct holds it
  (§7.1a).

This removes the need for a dedicated `$this` state field and keeps `$env`'s
meaning single: *the environment the suspended frame needs*.

**What C4 implemented, which is broader than the ruling's minimum.** The ruling
covers async *methods*. Two adjacent cases fell out of the same mechanism and are
now lowered too:

| shape | `$env` holds | how `this` reaches the resume body |
|---|---|---|
| async instance method | `f$ThisEnv { $this: C }` | `changetype<f$ThisEnv>(state.$env).$this` per occurrence |
| async function with explicit `this:` | the same | the same |
| async static method | — | **refused by name**: `this` there is the class object, not a receiver parameter (§7.1a) |

**Two shapes remain refused, and the reason is the transform order (§3.1).**
Closures lower *before* async, so a nested arrow in an async body that captures
`this` was already classified by the closure transform — as `Receiver`, with no
environment. **C5b un-refuses this** (§4.7.5): with `this` a field of the body
env, the closure transform rewrites the reference before the resolver sees it.
The static-method refusal above stays. That arrow's prologue then reads `~env`, and the function creating
it is `f$resume`, which has no `this` to store there. The result is a clean
compile error (`TS2332`), not a miscompile, and it is reported as a known
limitation rather than worked around. The fix, when it is wanted, is to let an
async body's `this` be an ordinary captured binding of the enclosing scope —
which needs the same treatment for `this` that C2b gave a method's `this`, and a
decision about which pass owns it.

### 7.5 `super`

`super` in a capturing arrow is **refused by name**:
`Not implemented: super in a capturing arrow (closures lowering)`. The shipped
resolver's `lookupSuperExpression` (`src/resolver.ts:2420`) has the same
`isInline`-then-parent shape that `this` had, and fixing it is arrow-this D8's
job, not this plan's. Non-capturing arrows are left exactly as they are today,
including whatever behaviour they have now; the negative control records it.

---

## 8. Interaction with async

### 8.1 The rule, restated with the new mechanism

A captured binding lives in the environment. The async state struct holds a
managed reference to the environment when the frame that owns it can be
suspended:

- **closure env local crosses an await** → the async transform's existing lifting
  rule moves `$closureEnv` into a state field of the env class type (managed,
  traced). This *is* §4.4's "state struct references the environment".
- **a capturing async function's entry hands the env to `f$resume`** → the entry
  stores it in `state.$env`; `f$resume` reads it back (§8.3).
- **a struct is never copied into a state field**; there is exactly one env
  object per scope instance.

### 8.2 What the async transform sees after the closure transform

| user code | after closures | after async |
|---|---|---|
| `let n: i32 = 0; const f = () => ++n; await h; f();` | `let $closureEnv: f$Env = new f$Env(); $closureEnv.n = 0; const f = () => ++$closureEnv.n; await h; f();` | `$closureEnv` lifted into a managed state field; `f`'s `_env` still points at that same object; the call after resume sees the same `n` |
| a nested function in an async body | an ordinary function value with `_env` | unchanged shape; the value is a heap `Function<T>` |

The async transform's walker already accepts `NewExpression`, `PropertyAccess`,
`CallExpression`, `Identifier`, `Binary`, `Unary`, and `Assertion`
(`src/async/lower.ts:1308-1455`), so the rewritten bodies are walkable. The
transform's `planStatement` already accepts a bare function-expression statement
(`:686-705`); a closure in a `const` initializer is still refused there
(`:1993-1999`) and becomes case 6's un-refusal item.

### 8.3 `$env`: the carrier, and the naming

Three different words, now named distinctly:

| name | what it is | who reads it |
|---|---|---|
| `_env` | the `usize` word inside every `Function<T>` | `makeCallIndirect`, the callee's prologue |
| `$env` | the state struct's `TaskEnv`-or-null field (`src/async/lower.ts:175`) | the **function-scope env** of the suspended frame: the received closure env, or the this-struct; null when the frame owns a body env and received nothing |
| `$closureEnv` / `$closureEnvIn` | the env locals of a function | capture accesses, creation, delivery |

**The head rule.** `$env` carries the env that must cross the entry → `f$resume`
boundary — the **function-scope env** in that boundary sense (§4.7.1). Only two
objects can occupy it: the **received env**, or the **this-struct** that stands
in for a receiver-only frame. A body env (§8.3(b)) is never stored there; it is
carried by its own lifted field, and its `$parent` names the received env. The
read-back follows from which object occupies `$env`:

| function shape | `state.$env` holds | `this` reads | `$closureEnvIn` read-back |
|---|---|---|---|
| closure value, no receiver, no body env | the received env `$E` | — | `changetype<$E>(state.$env)` |
| closure value, no receiver, owns a body env | the received env `$E`; the body env is lifted, parent `$E` | — | `changetype<$E>(state.$env)` |
| closure value, receiver, no body env (C5b's collision) | the this-struct `$T`, with `$T.$parent = $E` | `changetype<$T>(state.$env).$this` | `changetype<$E>(state.$env.$parent!)` |
| closure value, receiver, owns a body env (C5b) | the received env `$E`; the body env carries `$this` and is lifted, parent `$E` | from the body env | `changetype<$E>(state.$env)` |
| no received env, receiver, no body env | the this-struct `$T` | `changetype<$T>(state.$env).$this` | — |
| no received env, receiver, owns a body env (C5b) | null; the body env carries `$this` | from the body env | — |
| no received env, no receiver, owns a body env (§8.3(b)) | null | — | — |

**The two read-back shapes** are therefore exactly two expressions:

1. **head is a closure env** — `changetype<$E>(state.$env)`.
2. **head is the this-struct** — `changetype<$E>(state.$env.$parent!)` for the
   received env, and `changetype<$T>(state.$env).$this` for the receiver.

**The runtime root chain.** The task table holds the state; for a parked task the
collector reaches an environment through `table → state → state.$env → $parent* →
environment`, and through any lifted `$closureEnv` field. The `$closureEnvIn`
local is a view of the same object, never a second storage. Every link is a
managed field (§5.2, §5.5), so nothing needs a manual root.

There are two distinct async cases, and they use different carriers:

**(a) The async function *is* a closure value** — a nested async function (the
only async shape that can itself capture; an async arrow is refused, §0.1). The
env arrives through
`~env` at the **entry**, but the body lives in `f$resume`. The transform:

1. keeps the codegen-added `$closureEnvIn` local in the entry (§6.1),
2. emits `state.$env = $closureEnvIn;` before `f$resume(state)`,
3. emits at the top of `f$resume` its **own** declaration (a normal statement in
   the synthesized body, not a resolver-added local):
   `let $closureEnvIn: f$Env = changetype<f$Env>(state.$env);`

`f$resume`'s signature is unchanged — one parameter, `state`.

**With a receiver (C5b).** When the async function also has a receiver, the head
depends on whether its body owns an env (§4.7.5):

- **body owns no env** — the this-struct is synthesized (as today), but it is now
  the head and carries `$parent` when the function is a closure value: the entry
  emits `state.$env = new f$ThisEnv(this, $closureEnvIn)` (the parent argument is
  absent when there is no received env). Step 3's read-back becomes
  `changetype<f$Env>(state.$env.$parent!)`, and `this` stays
  `changetype<f$ThisEnv>(state.$env).$this`.
- **body owns an env** — that env carries `$this` at field 0 (§4.7.5) and no
  this-struct is synthesized. `state.$env` holds the **received** env when the
  function is a closure value (null otherwise); the body env is declared with its
  parent and lifted across the suspension by the ordinary rule, and every `this`
  read in the body compiles to `changetype<f$Env>(state.$closureEnv).$this` — the
  lifted field, not `state.$env`.

**(b) The async function is not itself a closure but contains one** — it owns the
env. The declaration `let $closureEnv: f$Env = new f$Env(parentLocal);` is written
in the body that moves into `f$resume` (`parentLocal` only when the class has a
`$parent`, §5.2), so the existing lifting rule lifts `$closureEnv`
into a state field of the env class: a managed reference to the environment,
which is §4.4 exactly. `state.$env` stays null in this case; nothing is carried
there because nothing needs to cross a function boundary.

For an **async method**, the entry populates `state.$env` with the this-struct
(§7.4) when the body owns no env — a method is not a closure value, so it has no
`$closureEnvIn` and its this-struct has no parent. **When the method's body owns
an env (C5b), the this-struct is not synthesized**: the body env carries `$this`
and `state.$env` stays null; the method's `this` is read from the lifted body
env. This is the measured `k/m$Env` + `k/m$ThisEnv` pair collapsing to one class
(§4.7.5).

**Case (b) is what C4 relies on, and it needed one addition to the async
transform.** When the async body creates a closure *before* an await, the
creation is a `function`-statement plan, which the resume function emits
**unguarded** (§4.2's `nestedFunction` rule) — so it re-reads its environment
local on every entry, including a resumed one. A local declared inside a guarded
region is out of scope there. The async transform therefore lifts the environment
local whenever a closure creation in the body reads it
(`AsyncLowerTransform#liftCreationEnvs`), and the creation reads the copy-in.
That is the same rule as any other cross-await local, applied to a local the
closure transform introduced.

The `$env` field type stays `TaskEnv | null`; `changetype` at read-back is the one
cast, and it is the same cast the plan already uses for `record!`-style
non-nullable fields.

### 8.4 Case 6 — the dependency chain, stated as three gates

**Gate 1 — closures land.** A capture can exist in a body: the closure transform
produces `$closureEnv`/`$closureEnvIn` and field accesses.

**Gate 2 — the async transform un-refuses.** Separate dispatch, async-side
changes:

- `this` in an async body: un-refuse for async **methods** only, with §7.4's
  `$env` population; a free async function still has no `this` (resolver
  `TS2332`).
- a nested function in an async body: un-refuse function expressions/arrows that
  capture, provided the closure transform has rewritten them.
- async methods: un-refuse the parser/member guard (`src/async/lower.ts:1463`)
  and lower the method shape (entry stays a method; `f$resume` is free and reads
  `this` from `state.$env`).

**Gate 3 — case 6 testable.** The test (§13, case 6) compiles an async body that
creates a closure, awaits, and calls it, and asserts the mutation is visible —
first as a **shape** assertion in Phase 3, then as a **value** assertion once the
scheduler exists (Phase 4).

Until Gate 2, `this` and nested functions in async bodies stay refused by name;
the closure plan does not weaken those refusals itself.

**Gate 2 landed with C4**, with two limits stated here so they are not
rediscovered as bugs:

- A **closure written as a value** (`const f = (): i32 => x;`) inside an async
  body must be lifted across an await, and lifting needs a declared type. With an
  explicit annotation (`const f: () => i32 = …`) it works; without one it is
  refused by name ("a local without a declared type that crosses an await"),
  which is the same gap as D10 in a second place.
- **Nested arrows capturing `this`** in an async body remain refused by the
  mechanism described in §7.4 (a `TS2332` from the resolver), because the closure
  transform classified them before the async transform moved the body.

**Parent-chain captures (C5a) and the receiver unification (C5b).** A capture
that crosses more than one environment is refused at this revision and is the
first thing §4.7 un-refuses. The chain is a separate mechanism (a `$parent` link
with statically decided depth, §4.7.1-§4.7.3), not a consequence of composition;
§8.3's head rule and its two read-back shapes are what let it coexist with the
async carriers. The collision (`capture + explicit this:`) and the async-body
`TS2332` are C5b's, not C5a's (§4.7.6); until C5b lands they stay refused by
name, and §8.3's this-struct row describes the shape C5b replaces.

### 8.5 The async contract this plan requires

For the async transform (Gate 2), the closure plan requires exactly:

1. Accept the closure transform's output in every position it already accepts
   ordinary code (env locals, field accesses, `new`, `!`).
2. Populate `$env` in the entry before `f$resume`, for capturing functions and
   for async methods.
3. Read `$env` back at the top of `f$resume`.
4. Do not lift a binding that is a field access (there is nothing to lift — the
   binding is no longer a local).
5. Keep the `$env` name reserved, and keep `$closureEnv`/`$closureEnvIn`
   unreserved so the lifting rule can lift them when they are body-local.
6. In case (a), do **not** lift the read-back `$closureEnvIn` into a second state
   field: its carrier is `state.$env`, and a second reference would be
   redundant even though it points at the same object.

---

## 9. Host boundary

### 9.1 `makeCallbacks` refuses capturing closures — both kinds

`tension-framework/assembly/runtime/callbacks.ts:34-36`:

```ts
assert(load<usize>(fn, sizeof<usize>()) == 0,
  "makeCallbacks: a handler that captures `this` cannot be called by the host");
```

The check is "the environment word is zero", not "this was captured". Therefore
it refuses **every** capturing closure: a `Receiver` arrow (its `_env` is the
receiver) and a `Struct` closure (its `_env` is the env object). The host has no
indirect-call site at which to set `~env`, so this is correct, not incidental.

**The plan's handling: host callbacks are refused for capturing closures.** The
supported pattern is a **shim**: a non-capturing, module-level handler that reads
the state it needs from a module-level (traced) binding:

```ts
let pending: i32 = 0;                                  // a traced module-level binding
function onBatchShim(class_: u32, ptr: u32, count: u32): i32 { /* uses pending */ }
// registered where the guest builds its callbacks:
//   makeCallbacks(onBatchShim)   — `_env` is 0, so the guard passes
```

The shim's `_env` is 0, so the guard passes; the closure that produced the state
is not the handler. This is a language-level consequence of the host ABI (no
environment word crosses it) and is documented in §9.4's "no ABI change".

**How the compile-time half is detected (C3).** The transform recognises a
registration call by the callee name `makeCallbacks` — the name the framework
exports and every guest uses (`tension-framework/assembly/runtime/callbacks.ts:56`).
It is the one place the closure transform names a framework symbol rather than a
std one, and it is what makes the refusal a compile-time message instead of the
runtime `assert`. **The coupling is real:** renaming that function would silently
drop the refusal back to the runtime guard. The test asserts both halves — the
transform's message for a capturing closure, and the acceptance of a
non-capturing handler — so the coupling is visible in a failing test rather than
discovered at run time.

### 9.2 The unsafe `call_indirect` builtin

`builtin_call_indirect` emits a raw `module.call_indirect` with no `~env`
hand-over (`src/builtins.ts:3788-3818`). A capturing closure invoked through it
reads whatever `~env` last held. The plan does not fix this builtin (it takes a
raw table index by design); it **documents** the limitation and adds a negative
control that asserts the guard-rail shape: the builtin is `@unsafe`, and the
closure case is named in the documentation. If the architect prefers an active
guard, the same `assert` shape as `makeCallbacks` can be emitted at the builtin's
site — recorded as an option, not adopted here.

### 9.3 `~env` is a delivery register, not a root

`~env` is a mutable `usize` global (`ensureEnvGlobal`, `src/compiler.ts:6637-6650`),
not a managed global, so `__visit_globals` does not trace it. That is fine while
it is transient: between the store and the callee's prologue the value is also
held by the closure value (`_env`, traced) and by a stack local (conservatively
scanned). **It must never be the only reference to an environment across a
suspension**; §8 makes the state struct / lifted local the carrier.

### 9.4 No ABI change

No export, no import, no record field, no host-visible signature changes. The
environment never crosses the host boundary; the completion record and
`BUFFER_POOL` are untouched. The one behavioural interaction is the existing
`makeCallbacks` guard (§9.1).

---

## 10. Backend B (WasmFX) compatibility

The environment design is backend-neutral: an env class with a fixed layout, an
allocation policy (scope entry), a capture access (`env.field`), and a call
convention that is the *existing* one (a `Function<T>` value plus the `~env`
register). None of these mention state machines.

| concern | where solved | backend-specific? |
|---|---|---|
| env layout | synthesized managed class (§5.2) | no |
| allocation policy | scope entry / per iteration (§5.3, §5.4) | no |
| capture reach | rewritten `env.field` (§6.2) | no |
| delivery | `~env` save/set/restore (§6.4) | no |
| rooting across suspension | state struct / lifted local (§8.1) | no |
| what an `await` becomes | async plan v2 §5 | **yes — the only one** |

Backend B specific hazard, restated: a suspended continuation's fiber stack is
not scanned by `visitStack`, so the env must be reachable from a traced root —
the same rule Backend A needs for the opposite reason. Under Backend B a
`Struct` function's prologue reads `~env` exactly as under Backend A; the value
is also held by the closure value, which is on a continuation stack, so the
*root* rule (not the register) is what must hold.

What would break Backend B, restated so it is avoided rather than discovered:
capture metadata on the AST; requiring the env to live in the state struct
instead of being *referenced* by a traced field; making the call convention carry
state-machine data; promoting a Backend A restriction to a language rule;
encoding capture-ness in the `Signature` string.

---

## 11. Type system

- **No new `TypeKind`, no new `TypeFlags`.** A closure's type is `Function<T>`,
  exactly like a non-capturing function value (`Type.getClassOrWrapper` over the
  signature; the original plan's §6.1 analysis is unchanged).
- **No subclass of `Function<T>`** — it is `@final abstract`
  (`std/assembly/function.ts:3`); the difference is in `_env` and `envKind`.
- **No capture-ness in the `Signature` string.** `Signature` interning keys on
  `toString()`, so two functions differing only in whether they capture would
  collide. Capture facts live in the side table (§3.3), keyed by declaration.
- **The env class is an ordinary class** — field offsets, `__visit`, and `__link`
  barriers come from the existing class machinery.
- **`envKind` is a `FunctionPrototype` field**, not a type: a compile-time
  representation fact.

---

## 12. Decisions register

| # | Decision | Status |
|---|---|---|
| **D1** | Guest runtime `stub` vs `incremental`. | **Resolved** by the runtime migration: compiler default `incremental` (`src/compiler.ts:244`), generated config (`tension-framework/build.sh:154`), five examples. The 32 B/closure measurement stays as history. |
| **D2** | Environment granularity. | **Keep**: one env per scope instance, `$parent` chain, per-iteration allocation for loop-header bindings (§2.2, §2.3). |
| **D3** | TDZ for captured bindings. | **Revised**: the demotion loses the static check, so a per-slot `$init$` flag plus `abort()` is **mandatory**, emitted only for declarations without an initializer (§2.5). `const` assignment is checked by the transform (`TS2540`). |
| **D4** | Hoisting. | **Keep out** (§2.5). Orthogonal, resolver-sized. |
| **D5** | ABI. | **Revised**: no implicit environment parameter. The register is `~env`, internal to the module; no host-visible change (§9.4). |
| **D6** | `CommonFlags.Closure = 1 << 29` (`src/common.ts:79`). | **Delete.** `envKind` in the side table is the fact; a dead flag beside this feature misleads. |
| **D7** | Diagnostic cleanup. | **Revised**: the two `AS100: Not implemented: Closures` sites (`src/compiler.ts:5771`, `:7747`) are deleted in C2 once the transform covers the shapes; the spurious `TS2454` companion disappears with the demotion (the field is always assigned); the shapes that remain refused get specific `Not implemented: <shape> (closures lowering)` messages. |
| **D8** | Runtime default. | **Resolved**: the compiler default is already `incremental`. |
| **D9** | Escape analysis / stack allocation. | **Deferred** (not v1). |
| **D10** | **Captured bindings with an inferred type are refused.** | New, and the sharpest divergence: `let n = 0;` cannot be given an env field before resolution. Refused by name; the fix (a resolver-stage type inference pass) is named, not smuggled. |
| **D11** | **Captured bindings typed by a type parameter or a function-local alias are refused** in v1. | New; generic env classes / hoisted aliases are the extension. |
| **D12** | **Host callbacks cannot be capturing closures.** | New; the shim pattern is the supported route (§9.1). |
| **D13** | **Async methods populate `$env` unconditionally** with a this-struct at field 0. | New (architect ruling); it is an async-transform change, scheduled with Gate 2 (§7.4, §8.4). Amended by D16 for the body-owns-an-env case. |
| **D14** | **`_env` names the innermost env the closure needs — its head — not the innermost owning scope at the creation site.** | New (C5 review F5). §3.3, §4.7.2, §6.2. |
| **D15** | **Nested functions and block-bodied arrows may own an environment (C5a).** The class is named after the owning function. | New. §4.7.3, §6.1, §7.1a. |
| **D16** | **One env per scope instance, receivers included (C5b).** A body env that coexists with a receiver carries `$this` at field 0; the separate this-struct exists only when the body owns no env. | New. §4.7.5, §8.3. |
| **D17** | **`$env` is the function-scope env, with two read-back shapes** (head-is-closure-env, head-is-this-struct). | New (architect ruling). §8.3. |

---

## 13. Test harness

### 13.1 Pass criteria

| # | Case | Expectation | Gate |
|---|---|---|---|
| 1 | function expression capturing a local | compiles, returns the value; env class emitted, `_env` non-zero | C2 |
| 2 | arrow capturing a local | same path | C2 |
| 3 | **method value** | `const f = c.m; f()` → `TS2685` (measured); `f.call(c)` → value | C2 |
| 4 | two closures sharing one binding | `inc`/`get` observe each other; **one** env allocation | C2 |
| 5 | closure in a loop | `0,1,2`; per-iteration env allocation count asserted | C3 |
| 6 | closure across an async suspend point | **landed** — the shape is `tests/compiler/async-closure-value.*.wat`; the value is `tests/async/runtime.js` (40 + 2 = 42; Phase 4, 4d) | C4 / Phase 4 |
| 7 | environment outliving its frame | returned counter increments across calls | C2 |
| 8 | environment reclaimed | unreachable env collected under `incremental` (leak check) | C4 |
| 9 | arrow `this` | unchanged behaviour (regression guard for the shipped path) | C2 |
| 10 | transitive capture through an intermediate function | value correct; intermediate receives and forwards the env | C2 |
| 11 | non-capturing value allocates nothing | **three-way**: `None` → no allocation; `Receiver` → heap value, no env; `Struct` → heap value + env | C2 |
| 12 | **host callback shim** | a capturing closure is refused by `makeCallbacks`; a non-capturing shim works | C4 |
| 13 | **for-header per-iteration shape** | clone-before-increment visible in the wat; the incrementor runs on the fresh env | C3 |
| 14 | **direct-call shape** | a nested `function` is a value; its call is `call_indirect` (measured baseline) | C1 |
| 15 | **`super` in a capturing arrow** | refused by name | C4 |
| 16 | **two-scope, canonical loop** | `33` (0 + 11 + 22) after the loop; wat: body class has `$parent`, its allocation takes the header env, the closure reads `$closureEnvIn.$parent.i` | C5a |
| 17 | **two-scope, nested owner** | `3` after `outer`'s frame is gone; wat: `mid$Env.$parent` typed `outer$Env` | C5a |
| 18 | **two-scope, mutation** | `11`: a write made through the link is read by the outer scope | C5a |
| 19 | **two-scope, escaped loop** | `33`; every per-iteration closure keeps its own `i`/`now` pair after the loop | C5a |
| 20 | **two-scope, async** | `3`, delivered after the park (4d's delivery shape (a)); wat: the block env lifted as a state field, `$parent` intact | C5a |
| 21 | **collision: capture + explicit `this:`** | the awaited result is `8`; wat: one head env carrying the receiver, the received env as its `$parent` | C5b |
| 22 | **this-only arrow in an async body** | today `TS2332` (measured, called method); after C5b `7` | C5b |
| 23 | **one env per scope instance** | an async method that owns a captured local and reads `this` emits **one** class (measured today: both `$Env` and `$ThisEnv`) and returns `8` | C5b |
| 24 | **reserved names** | `$parent`, `$this`, `$env`, `$closureEnv`, `$closureEnvIn`, `$closureEnv$1`, `$init$x`, `resumePoint`, `result`, `handle`, `record` as captured names → refused by name | pre-C5 (F14) |

The two refusal assertions C5 deletes — the two-environment message
(`src/closure/lower.ts:614`) and the collision message
(`src/async/lower.ts:434`) — are removed in the same commit as the un-refusal
(C5a and C5b respectively), so the diff shows the removal rather than hiding it.

### 13.2 Negative controls

- **NC1 — read before assignment.** `let x: i32; const f = () => x; f(); x = 1;`
  → the `$init$x` check aborts; the test asserts a **trap**, not a zero.
- **NC2 — `this` in a regular function expression vs an arrow.** The regular
  function is `TS2332`; the arrow sees the enclosing `this` (the arrow-this
  contract, unchanged).
- **NC3 — host callback.** A capturing closure passed to `makeCallbacks` trips the
  guard; the shim passes. The framework already exercises the refusal half
  (`tension-framework/tests/guest-callbacks-guard.ts`, per
  `docs/async-await-plan-v2-review.md` §6.5).
- **NC4 — non-capturing arrows.** A `map(x => x * 2)` arrow keeps the static
  instance and `_env = 0` (no regression in the common case).
- **NC5 — detached method value.** `TS2685` (measured), and `.call(c)` returns
  the value (measured).
- **NC6 — `super` in a capturing arrow.** Refused by name.

### 13.3 Platform

**Linux first, Windows second**, as the runtime migration did (its verification
documents are separate). A platform failure must not be confused with a closure
failure.

### 13.4 Byte-identity and suite

- Non-closure programs: three programs × plain/`--optimize` against `bb2dde70`,
  **6/6**. Programs: p1 arrow-this-in-method, p2 nested arrows, p3 indirect
  `this` — the same probe set the async work uses, which is exactly the corpus
  most at risk (this-only arrows must keep the `Receiver` path).
- Full compiler suite: 247 tests, 0 mismatches, `[SUCCESS]`; the capturing-arrow
  probe returns 7 — the async work's standing measurement at `ccf888c6`, re-run
  as a gate here rather than assumed.

---

## 14. Milestones

- **C0 — decisions.** This revision's D1-D17 confirmed. (Nothing to build.)
- **C1 — analysis + rewrite, no codegen.** `src/closure/` with the scoping walk,
  env-class synthesis, and the body rewrite; the side table; the direct-call
  measurement re-run as the first task (it is expected to confirm §6.5). Gate:
  rewritten ASTs are inspectable for cases 1, 4, 7, 10; **no** codegen change
  yet, so nothing compiles differently; byte identity holds trivially.
- **C2 — codegen.** Resolver flags + `$closureEnvIn` local; the prologue; the
  `Struct` branch in `compileFunctionExpression`; the `declaredByFlow` error
  sites removed. Gate: cases 1, 2, 3, 4, 7, 9, 10, 11 pass; byte identity 6/6;
  full suite green.
- **C3 — loops.** §5.4's clone-before-increment, body-block envs, `continue`
  rewriting; case 5, 13. Gate: `0,1,2` and the allocation count.
- **C4 — controls.** NC1-NC6, case 12, case 15; the `call_indirect` builtin
  documentation.
- **C5a — parent-chain captures and nested owners.** §4.7.1-§4.7.3 and §4.7.6:
  multi-scope `needed`, `$parent` emission and construction, the hop rewrite,
  nested owners, class naming, and the §3.3 side-table extension. **Gate: the F14
  reserved-name guard has landed** (its own commit, case 24), because C5a adds
  the `$parent` field. Gate: cases 16-20; the canonical loop's wat shows the body
  class's `$parent` and its allocation taking the header env; byte identity 6/6;
  full suite green.
- **C5b — receiver / body-env unification.** §4.7.5 and §8.3's two read-back
  shapes: the body env carries `$this` when the body owns one, the this-struct
  exists only when it does not, and the collision plus the async-body `TS2332`
  un-refuse. Gate: cases 21-23; exactly one env class per scope instance in the
  wat; full suite green.

Each milestone is its own dispatch with its own report; none is started by this
document.

---

## 15. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A capture escapes the analysis (shadowing, a declaration-order edge) | High | The rewrite fails closed: a missed capture leaves a name that the resolver reports (`TS2304`) rather than a silent miscompile; shadowing cases are in the test matrix (§4.2) |
| Per-iteration semantics wrong (`3,3,3`) | High | §2.3's clone-before-increment, case 5 and 13 assert values **and** the wat shape |
| Double storage (`env` field plus a state field, or a this-struct plus a body env) | High | §2.2/§8.1; the async transform lifts the env **local**, which is the single object; C5b's one-env rule (§4.7.5) and case 23 assert one class; case 6's value test (`tests/async/runtime.js`) would catch a copy |
| A captured binding's inferred type is the common case and is refused | Medium | D10: named refusal, documented; the fix path (resolver-stage inference) is stated |
| `task-rt`'s `TaskEnv` is pulled into non-async closure programs | Low | It is an empty class in a top-level std file that every build parses anyway; unused functions are DCE'd |
| The closure transform changes this-only arrow output | High | The fast path skips sources with no non-`this` capture; byte identity 6/6 is a gate |
| Host callbacks cannot be closures | Medium | §9.1's shim pattern; NC3 |
| `call_indirect` builtin with a closure reads a stale `~env` | Low | Documented; `@unsafe`; optional guard recorded |
| Env chain depth computed wrongly | High | Cases 16-20; the rewrite is `. $parent!` per hop with concrete parent types, so a wrong depth is a type error, not a wrong read. The head is the closure's `needed` scope, not the site's innermost owning scope (§3.3's measured `p.ts`), which is the rule that makes the depth exact |
| A user binding named `$parent` collides with the new field | High | F14's reserved-name guard lands before C5a (§4.7.4); case 24 asserts every reserved name |
| Two objects for one scope instance survive C5b | High | §4.7.5's one-env rule; case 23 asserts exactly one class in the wat, and case 22's this-only arrow reuses the same env |
| A nested owner's class name collides with its parent owner's | Medium | §4.7.3 names classes after the owning function with §5.2's counter; the transform's synthesized-name check (§3.3) catches a residual collision |

---

## 16. What happens on approval

Nothing until the architect reviews this document. On approval:

- **C1** starts with the direct-call measurement (§6.5) and the analysis pass,
  because it is the piece the other milestones depend on.
- **C5a** starts only after the F14 reserved-name guard has landed, and **C5b**
  after C5a; §4.7 is their specification. Neither is started by this document.
- This plan does not touch `tension-core`, `tension-ogre`, or the engine, and
  modifies no plan document other than itself.
