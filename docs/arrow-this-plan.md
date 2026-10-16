# Arrow `this` — PLAN

**Status:** proposal, awaiting architect review. **No code written.**
**Class:** correctness bug, not a missing feature. `this` inside an arrow function
does not lexically bind, and correct TypeScript does not compile.

Date of evidence: 2026-10-15. Compiler: `asc 0.28.20` (the version Tension builds
with), source read at `/tmp/as-inspect/assemblyscript` (the fork's base,
`b6bda05c`).

**Supersedes nothing.** This plan is consistent with `docs/closures-plan.md`
(which found the bug) and `docs/async-await-plan-v2.md`.

---

## 0. The five facts, established

### Fact 1 — Arrow `this` today: resolves to the lexical *parent element*, not the receiver

The whole mechanism is one function. `lookupThisExpression`
(`src/resolver.ts:2200-2228`), verbatim:

```ts
lookupThisExpression(node, ctxFlow, ctxType, reportMode): Element | null {
  if (ctxFlow.isInline) {                                  // :2210
    let thisLocal = ctxFlow.lookupLocal(CommonNames.this_);
    if (thisLocal) { ... return thisLocal; }
  }
  let parent = ctxFlow.sourceFunction.parent;              // :2217
  if (parent) {
    this.currentThisExpression = null;
    this.currentElementExpression = null;
    return parent;                                         // :2222
  }
  if (reportMode == ReportMode.Report) {
    this.error(
      DiagnosticCode._this_cannot_be_referenced_in_current_location,  // :2226
      node.range
    );
  }
  return null;
}
```

`this` is resolved to **`ctxFlow.sourceFunction.parent`** — the *element* that
lexically contains the current function. `resolveThisExpression`
(`resolver.ts:2234-2250`) then takes `getTypeOfElement` of that element.

The bug follows directly: for an arrow, `ctxFlow.sourceFunction` **is the arrow**,
so `.parent` is whatever encloses the arrow — a method, a constructor, another
arrow, or the file. `getTypeOfElement` of a *function* element yields that
function's **function type**, named after the element. Hence the reported type is
the enclosing function's name, never the receiver:

| where the arrow sits | `this` is typed as | error |
|---|---|---|
| inside method `m` of class `C` | `C#m` | `TS2339: Property 'x' does not exist on type 'C#m'` |
| inside a class field initializer | `C#constructor` | same, against `C#constructor` |
| inside another arrow in `m` | `C#m~anonymous\|0` | same |
| inside static method `C.sm` | `C.sm` | same |
| at module scope | *(the file element)* | `TS2339 ... on type 'C'` for `this.x`; `TS2332` for bare `this` |

Measuring the failure across every placement (all **called**, never
dead-code-eliminated): arrow-in-method, arrow-in-field-initializer,
arrow-in-static-method, arrow in an inherited method, arrow via a detached method
reference, nested arrow, arrow immediately invoked, and arrow passed to an
`@inline` consumer. **All eight fail identically.** There is no placement where
an arrow's `this` works.

**Where the fix must land, established from the pipeline order:** the failure is
in the **resolver** — `lookupThisExpression` returns the wrong element and
`resolveThisExpression` types it wrongly. Nothing downstream is reached.

### Fact 2 — `this` is an ordinary leading wasm parameter

`this` in a method today is **`param $0`**. Emitted for
`class C { x: i32 = 7; m(): i32 { return this.x; } }`:

```wat
(func $m1/C#m (param $0 i32) (result i32)
 (local $1 i32)
 ...
 local.get $0            ;; this
 local.set $1
 ...
 local.get $1
 call $m1/C#get:x
```

The constructor is the same shape — `(func $m1/C#constructor (param $0 i32)` —
with the `i32.eqz` check that distinguishes "allocate" from "initialise".

Codegen for `this`, `compileExpression` case `NodeKind.This`
(`src/compiler.ts:7440-7467`), verbatim in the parts that matter:

```ts
case NodeKind.This: {
  let thisType = sourceFunction.signature.thisType;        // :7441
  if (!thisType) {
    this.error(DiagnosticCode._this_cannot_be_referenced_in_current_location, ...);  // :7444
    this.currentType = this.options.usizeType;
    return module.unreachable();
  }
  ...
  let thisLocal = assert(flow.lookupLocal(CommonNames.this_));   // :7463
  flow.set(FlowFlags.AccessesThis);
  this.currentType = thisType;
  return module.local_get(thisLocal.index, thisType.toRef());
}
```

Two things follow, and they are the load-bearing facts for the design:

- `this` compiles to `local_get` of **the current function's own `this` local**.
  It never walks outward. There is no "enclosing `this`" notion in codegen at all.
- If `sourceFunction.signature.thisType` is null, codegen **rejects** with
  `TS2332` (`'this' cannot be referenced in current location.`,
  `src/diagnosticMessages.json` → 2332). And `:7463` is a hard `assert`, so if the
  null check were bypassed, the compiler would abort.

### Fact 3 — An arrow can never acquire a `thisType`, so `this` is always rejected

`resolveFunction` (`src/resolver.ts:2833-2847`) is where a function's `thisType`
is decided:

```ts
let thisType: Type | null = null;                      // :2833
let explicitThisType = signatureNode.explicitThisType; // :2834
if (explicitThisType) {
  thisType = this.resolveType(explicitThisType, null, prototype.parent, ctxTypes, reportMode);
  ...
  ctxTypes.set(CommonNames.this_, thisType);           // :2844
} else if (classInstance) {
  thisType = classInstance.type;                       // :2846
  ctxTypes.set(CommonNames.this_, thisType);
}
```

and `classInstance` is set only for a genuine class member
(`src/resolver.ts:2791`):

```ts
if (prototype.is(CommonFlags.Instance)) {
  classInstance = assert(prototype.getBoundClassOrInterface());
```

**An arrow is never `CommonFlags.Instance`** — an arrow is an expression, and a
class field whose value *is* an arrow is a `FieldDeclaration` whose initializer
runs in the constructor. So `classInstance` is null and `explicitThisType` is
absent.

**The other route is closed too:** an explicit `this` parameter on an arrow is a
**parse error** — `const f = (this: C): i32 => this.x;` →
`TS1005: ')' expected.` Same as TypeScript, which also forbids `this` parameters
on arrows.

**Therefore: an arrow's `signature.thisType` is always null.** Consequences:

- The type checker rejects `this.x` in an arrow with a **misleading** diagnostic
  (`TS2339`, naming the enclosing *function*).
- Bare `this` in an arrow resolves to the parent element's type and then codegen
  rejects it with `TS2332`. (Measured: `const f = (): i32 => this;` at module
  scope → `TS2332`.)
- **There is no silent miscompilation and no wrong runtime value**, because
  **nothing is emitted** — the compile fails. The bug is that correct TypeScript
  cannot be compiled, with a diagnostic that points at the wrong thing.

### Fact 4 — Upstream has no implementation *and no divergent decision*

- **No upstream issue proposes non-lexical arrow `this`.** Searches for
  `"this" arrow in:title`, `this binding in:title`, `lexical in:title` return
  **0** results each. Nothing in the corpus states an intent to diverge.
- **No test and no std-lib code exercises it.** `grep -rn "=> *this\b\|=> this\."`
  over `tests/` → **0 hits**; over `std/assembly/` → **0 hits**. It is untested,
  which is why it was never noticed.
- **No documentation page states the semantics.** `functions.html`,
  `types.html`, `compiler.html` contain no statement about arrow `this`.
- **Upstream's own closures proposal already anticipates the fix.** Open issue
  **#798 "Implement closures"** (95 comments) contains the design sketch, and it
  says, verbatim:

  > **`ClosureContext` will not created when only `this` was captured. In this
  > case `ctx` param use to pass this reference.**

  That is the design this plan adopts (§C). Upstream's proposal also establishes
  the general mechanism — a generated lambda takes a `ctx: usize` parameter — which
  is what `Function<T>._env` exists to carry.

**Verdict: this is a gap, not an intentional design.** Following TypeScript is
consistent with upstream's stated intent. Per the architect's standing direction,
Tension Script follows TypeScript.

### Fact 5 — The dead-code-elimination trap, reproduced independently

The closures plan reported that its first test appeared to pass. Confirmed, and
it is a real trap for anyone testing this:

```
class C { x: i32 = 7; arrow(): () => i32 { return (): i32 => this.x; } }
export function main(): i32 { return 1; }        // `arrow` never called
  → compiles CLEAN

same file, with main() calling arrow():
  → ERROR TS2339: Property 'x' does not exist on type 'dce2/C#arrow'
```

`this` inside an arrow is resolved **only when the arrow body is reached during
resolution or compilation**. An arrow that is declared but never used is never
resolved, and its `this` is never type-checked. **Every test in this plan's
harness must call what it declares.** §H makes that a structural rule rather than
a discipline.

---

## A. Bug statement

### A.1 What is wrong

In TypeScript, an arrow function does not have its own `this`: it closes over the
`this` of the nearest enclosing **non-arrow** function. Every idiomatic pattern
depends on it:

```ts
array.map(x => this.scale(x))
button.on('click', e => this.handle(e))
items.forEach(item => this.items.push(item))
```

In Tension Script today, **none of these compile.** `this` inside an arrow is
resolved to the arrow's lexically enclosing *element* — a method, a constructor,
another arrow, or the file — and typed as that element's **function type**. Since
a function type has none of the receiver's members, the access fails with
`TS2339`, naming the enclosing function.

The bug is not that `this` has the wrong value at runtime. It is that **the code
cannot be compiled at all**, and the diagnostic names the wrong thing — it tells
the author their property does not exist on `C#m`, which is not a type they wrote
or can fix.

### A.2 Minimal reproduction

`docs/closures-plan.md`'s case, confirmed and generalized:

```ts
class C {
  x: i32 = 7;
  arrow(): () => i32 { return (): i32 => this.x; }
}
export function main(): i32 { return new C().arrow()(); }
```

```
ERROR TS2339: Property 'x' does not exist on type 'C#arrow'.
```

Note `C#arrow` — the **method** `arrow`, not the class `C`. That name is the
whole diagnosis: `this` resolved to the enclosing method element. The obvious
"fix" the message suggests — add `x` to `arrow` — is impossible, which is how you
can tell the message is wrong.

### A.3 The test that exposes it, and why it is not dead-code-eliminated

**The shape every harness case must have:** the arrow is assigned to a value
that is **called**, and the result is **returned from `main` and compared**. Two
independent guards against the DCE trap:

1. The arrow is *invoked*, so resolution reaches its body.
2. The result flows to `main`'s return value, so codegen cannot drop it.

```ts
class C { x: i32 = 7; m(): i32 { const f = (): i32 => this.x; return f(); } }
export function main(): i32 { return new C().m(); }
// expect 7; today: TS2339: Property 'x' does not exist on type 'C#m'.
```

Measured: **fails today.** This is the harness's first case.

---

## B. Correct semantics — TypeScript's rules

One rule generates all of them, and it is TypeScript's:

> **`this` is found by walking outward through enclosing *arrow* functions. The
> first non-arrow function encountered supplies the `this` — its receiver type
> for a method, its own dynamic `this` for a regular function, or nothing for a
> module-scope function.**

A regular function **stops** the walk; an arrow **passes it through**. Each case
below is a separate correctness requirement with its own test (§H).

### B.1 Arrow in a method → the receiver

```ts
class C { x: i32 = 7; m(): i32 { const f = (): i32 => this.x; return f(); } }
```
`this` is `C` (the receiver). Expect **7**. Fails today (`C#m`).

### B.2 Arrow nested in an arrow in a method → still the receiver

```ts
class C { x: i32 = 7; m(): i32 {
  const a = (): i32 => { const b = (): i32 => this.x; return b(); };
  return a();
} }
```
The walk passes through **both** arrows. Expect **7**. Fails today
(`C#m~anonymous|0`).

### B.3 Arrow in a class field initializer → the instance

```ts
class C { x: i32 = 7; f: () => i32 = (): i32 => this.x; }
```
`this` is `C`. Expect **7**. Fails today (`C#constructor`). This is the
`addEventListener` shape and the most common one in real TypeScript.

### B.4 Arrow in a static method → the class

```ts
class C { x: i32 = 7; static sm(): i32 { const f = (): i32 => 1; return f(); } }
```
TypeScript types `this` in a static method as the class itself (`typeof C`), not
an instance. AS has no `typeof C` type; the class *type* `C` is the closest
available, and the fix must be explicit about that. Fails today (`C.sm`).
**Decision D3.**

### B.5 Arrow in a regular function → the regular function's own `this`

```ts
function outer(this: C): () => i32 { return (): i32 => this.x; }
```
The arrow lexically binds to `outer`'s `this`, which is itself dynamically
provided. The **type** comes from `outer`'s `thisType`; the **value** travels
with the arrow. This is the negative control that proves the walk stops at a
non-arrow function *and* forwards its receiver rather than continuing outward.

### B.6 Regular function expression → its own dynamic `this`, unchanged

```ts
const f = function (this: C): i32 { return this.x; };
f.call(c);
```
Already correct today (the explicit `this` sets `thisType`, `resolver.ts:2835-2844`).
**No change.** A regular function *without* an explicit `this` that references
`this` is a `TS2332` — correct, and it must stay that way (§B.9).

### B.7 Method → the receiver. Unchanged, and the control for everything else.

### B.8 Arrow at module scope → rejected

TypeScript strict mode: `this` at module scope is `undefined`. AS already
**rejects** it — measured, `const f = (): i32 => this;` at module scope gives
`TS2332: 'this' cannot be referenced in current location.` **That is the correct
outcome and the fix must preserve it.** AS has no `undefined` value for `this` to
be, so rejecting is the honest equivalent of TS strict.

> **Finding for the closures plan, not a correction of it:** the closures plan's
> §1.5 asks whether AS has module-scope `this`. It does not — the resolver's
> `parent == null` branch rejects it — and `TS2332` is the right answer.
> Recorded here rather than edited into that document, per this task's constraints.

### B.9 Regular function referencing `this` with no `thisType` → `TS2332`. Unchanged.

```ts
function h(): i32 { return this; }   // TS2332, correct
```

### B.10 What will *not* match TypeScript, listed

- **`this` in a static method is the class *type*, not `typeof C`.** AS has no
  constructor-type. Closest correct alternative; D3.
- **No TDZ-style "`this` before `super()`" refinement.** Out of scope; AS's
  constructor rules are unchanged.
- **`this` in a class field initializer that runs before the constructor body**
  is the same instance under both AS and TS, so no gap.
- **`this` inside a *regular* function nested in a method** stays `TS2332`, where
  TS under `noImplicitThis` also errors. The **diagnostic is currently
  misleading** (it can surface as `TS2339 ... on type 'C#m'`) and should be
  corrected to `TS2332` — a diagnostic-quality fix, not a semantic one (§C.3).

---

## C. Where the fix lives

### C.1 The pipeline order, and the one stage that is semantically wrong

`parse` → resolve (`src/resolver.ts`) → instantiate → compile
(`src/compiler.ts`) → Binaryen passes.

**The semantic error is in the resolver.** `lookupThisExpression`
(`resolver.ts:2217-2222`) returns the lexical parent *element*. It must instead
walk outward through arrow functions and return the first non-arrow function's
`this`.

**One semantic change, in one function.** The fix is *not* spread across stages:
parse needs nothing, the AST needs nothing (§D), and the type system needs no new
kind of type.

**Codegen needs a second, mechanical change** (§C.2) — not because the semantics
are split, but because the arrow's wasm frame has no `this` to load, so the value
must be *delivered*. That is one site plus the call convention, and it is shared
with the closures plan's mechanism.

### C.2 The exact shape of the resolver change

```
lookupThisExpression(node, ctxFlow, reportMode):
  1. if ctxFlow.isInline:                          // existing, :2210-2216 — unchanged
       thisLocal = ctxFlow.lookupLocal("this");  if found → return it
  2. f = ctxFlow.sourceFunction
     while f is an arrow (f.prototype.arrowKind != ArrowKind.None
                          or the resolved function's arrowKind is set):
       f = f.parent
     // f is now the nearest enclosing NON-arrow function (or the class for a
     // method, which is what makes B.7 keep working)
  3. return the element whose type is f's thisType, or null if f has none
     → the null case already produces TS2332 at :2226, and the compiler
       independently enforces it at compiler.ts:7444
```

The walk needs `arrowKind` at the *resolved* `Function`, not only on the
declaration. **Verification needed at implementation time:** whether `Function`
carries `arrowKind` or whether it must be read from `prototype.functionTypeNode`/
the declaration. The AST has it (§D); the resolved element may not. This is the
one research item the fix must close, and it is small — flagged rather than
guessed.

### C.3 The diagnostic correction (same stage, no new semantics)

Two diagnostics are produced today for the same class of mistake, and one is
wrong:

| source | today | should be |
|---|---|---|
| `this.x` in an arrow in a method | `TS2339 ... on type 'C#m'` | after the fix: compiles |
| `this.x` in a *regular* function in a method | `TS2339 ... on type 'C#m'` | **`TS2332`** — that function has no `this` |
| bare `this` with no bindable `this` | `TS2332` (from codegen `:7444`) | `TS2332` (from the resolver) — same code, earlier and clearer |

So the fix makes `this` resolution **stop at a regular function** rather than
falling through to its parent element. That single rule change both fixes arrows
and repairs the nested-regular-function diagnostic. `TS2332` already exists
(2332) and is already the right message: *"`this` cannot be referenced in current
location."*

### C.4 Codegen: delivering the value

`this` is `param $0` of the enclosing method (Fact 2). An arrow is a **separate
wasm function** with its own parameter list, so it cannot read its caller's
frame. The value must be passed, which is what `Function<T>`'s `_env` field is
for.

**`_env` is already there, already traced, and already wired to be filled.**
`std/assembly/function.ts:4-5`:

```ts
private _index: u32;
private _env: usize;
```

with `__visit` tracing `_env` (`:34-37`) and the comment *"Env is either `null`
(nop) or compiler-generated"*.

**Layout, measured** (runtime probe, not inference — see §H.4 for how):
`_index` at **offset 0**, `_env` at **offset 8**, with 4 bytes of padding between
them so `_env` is 8-byte aligned. `ensureRuntimeFunction`
(`src/compiler.ts:2168-2174`) writes both into a **static, memoized** per-function
instance:

```ts
let rtInstance = assert(this.resolver.resolveClass(program.functionPrototype, [ instance.type ]));
let buf = rtInstance.createBuffer();
assert(rtInstance.writeField("_index", index, buf));
assert(rtInstance.writeField("_env", 0, buf));      // always 0 today
instance.memorySegment = memorySegment = this.addRuntimeMemorySegment(buf);
```

**And the indirect-call site already reads `_index` from the function value.** One
place, `makeCallIndirect` (`src/compiler.ts:7142`), verbatim:

```ts
let expr = module.call_indirect(
  null, // TODO: handle multiple tables
  module.load(4, false, functionArgWithVararg, TypeRef.I32), // ._index
  operands,
  signature.paramRefs,
  signature.resultRefs
);
```

> **A trap worth recording:** the `4` is Binaryen's *byte width*, not an offset
> (`module.load(bytes, signed, ptr, type, offset = 0, align = bytes)` —
> `src/module.ts:1617-1625`). `_index` is at **offset 0**. An implementer who
> reads `load(4, …)` as "offset 4" will conclude `_index` and `_env` overlap —
> I made exactly that misreading before checking it, which is why the layout was
> probed at runtime.

So the codegen change is confined to two sites that already handle the exact data:

- **At the call site** (`makeCallIndirect`): load `_env` (offset 8) from the same
  `functionArg`, and prepend it to the operand list when the callee signature
  declares an environment. `functionArg` and `operands` are both already in hand.
- **At creation** (`compileFunctionExpression`, `src/compiler.ts:7218`, value
  materialised at `:7352`): for an arrow that binds `this`, allocate a **heap**
  `Function<T>` instance instead of using the static memoized one — because the
  static instance is shared by every reference to that function and cannot carry
  a per-instance `_env`. This is the same finding as the closures plan's
  "capturing functions must be heap instances".

### C.5 Why one stage is not enough — stated plainly

The semantic rule is one function. The **delivery** needs the call convention,
because a wasm function cannot read its caller's locals. That is not a spreading
fix; it is the irreducible cost of lexical scope in WebAssembly, and it is the
same cost the closures plan already accepted. **`this` is the one capture that
needs no analysis: it is always available, and it is immutable.**

---

## D. AST changes — none

**No new nodes. No new fields.**

Everything needed is already an AST fact:

- **Arrow-ness** — `ArrowKind` (`src/ast.ts:2080-2088`), verbatim:
  ```ts
  export const enum ArrowKind { None, Parenthesized, Single }
  ```
  carried on `FunctionDeclaration` as `arrowKind: ArrowKind`
  (`src/ast.ts:2105`), and `FunctionDeclaration` covers methods
  (`MethodDeclaration extends FunctionDeclaration`, `ast.ts:2215`) and arrows
  (`FunctionExpression` wraps a `FunctionDeclaration`, `ast.ts:1351-1359`).
- **`this`** — `ThisExpression` exists and is already parsed.
- **Class-ness** — the resolver has `CommonFlags.Instance` and
  `getBoundClassOrInterface()`.

The closures plan reached the same conclusion for its own purposes
(`ARROW: ast.ts:2080-2088`; its §2.1 "Closures add no new AST node and no new AST
field"). **Confirmed independently here**, and for `this` the case is even
stronger: nothing about lexical `this` is representable-at-parse-time that isn't
already there.

**The only AST-adjacent gap is on the *resolved* model**, not the AST: whether a
resolved `Function` reports its arrow-ness (§C.2). If it does not, the fix reads
it from the declaration the `Function` already points at. Either way, **no AST
change.**

---

## E. Interaction with closures

**`this` binding is a capture, so the arrow `this` fix *is* the closures
mechanism — restricted to the one capture that needs no analysis.**

The closures plan (§1.4) says exactly this: *"In AS, a method's `this` is a local
(`thisLocal`), so `this` inside an arrow is simply another captured binding — the
same mechanism, no special case in the environment, no special call convention."*
This plan adopts that, and adds the part that makes it implementable **now,
before closures land**:

> **`this` is the one captured binding with no analysis burden:**
> - it is **always available** — the enclosing non-arrow function either has a
>   `this` parameter or has no `this` at all (→ `TS2332`); no liveness or
>   escape analysis is needed;
> - it is **immutable** — `this` cannot be reassigned in AS or TS, so a *flat
>   copy* into every nested arrow's environment is semantically exact. **No chain
>   is required**, unlike general captures where shared mutable slots force one.
> - there is **at most one per function**.

So the `this`-only environment is a **strict subset** of the closures
environment: one field, no chain, no analysis. It composes rather than competes:

- The environment struct is the closures plan's struct. When closures land, it
  grows fields; `this` keeps its slot.
- `_env` is the same field, filled at the same moment (closure creation).
- The call convention — an implicit leading `usize` environment parameter before
  the declared parameters — is the closures plan's convention. §C.4 shows the
  single call site that must learn it.
- The **rooting rule** is the closures plan's too: under Backend A a suspended
  task's frame is gone, so the environment must be reachable from a traced root
  (closures plan §0.4/§7.3). `this`-only environments are ordinary managed
  objects and need nothing extra.

**Upstream's own proposal agrees, verbatim (#798):** *"`ClosureContext` will not
created when only `this` was captured. In this case `ctx` param use to pass this
reference."* That is the allocation-free special case: when `this` is the only
capture, the environment pointer **is** the receiver, and no struct is allocated.
**Decision D1.**

**What does not compose, and must be decided:** the closures plan's capture
analysis assigns environment field indices dynamically per capture set. If
`this` occupies a *dynamically assigned* field, then the "environment pointer is
the receiver" optimization is impossible and every arrow-that-uses-`this`
allocates. **Recommendation:** reserve `this` a **fixed slot** (field 0) so both
representations stay available, and let the compiler choose per function —
statically, so creation and access always agree. **D1.**

---

## F. Interaction with async

### F.1 `await` inside an async arrow: `this` survives suspension

```ts
class Loader {
  url: string = "/x";
  run(): void {
    const go = async (): void => {
      const buf = await fetchHandle();
      this.use(this.url, buf);        // `this` must still be the Loader
    };
    go();
  }
}
```

`this` is captured at arrow creation, **before** the first `await`. The value
lives in the environment, and the environment is reachable across the suspension
by the same chain as any other captured object (state struct → environment, with
the task table as the root — async plan v2 §7.1/§7.3). **`this` needs no
merge**, because it never changes: the async plan's hard case (a captured binding
mutated across a suspension, v2 §0.4) does not arise for `this`, since `this` is
immutable.

**Composition rule, stated once:** `this` is captured **once, at creation**, and
the async lowering's suspended-state handling is unchanged. There is no
`this`-specific work in async.

### F.2 Backend A artifact vs language rule

Applying async plan v2 §5.3's discipline:

- **Language rule:** `this` in an arrow is the enclosing non-arrow function's
  `this`; the walk stops at a non-arrow function; `TS2332` when nothing is
  bindable. True under both backends.
- **Backend A artifact:** *nothing.* Unlike v2's "`await` is illegal inside a
  callback" — which is a Backend A capability restriction that must **not**
  become a language rule — the `this` rule is identical under state machines and
  WasmFX, because it is resolved at compile time and delivered through the
  environment, not through control flow.

**Explicit instruction to the implementer:** do **not** add any diagnostic of the
form "`this` cannot be used in an async arrow" or "`this` does not survive
`await`". There is no such restriction.

---

## G. Backend B (WasmFX) compatibility

**`this` does not interact with the fiber-stack/`visitStack` gap. It is a Backend
B problem, not a `this` problem.**

The reasoning, concretely:

- Under Backend B a suspended continuation's frames live on an engine-managed
  fiber stack that `visitStack` (a scan of `[__stack_pointer, __heap_base)`) does
  not cover — async plan v2 §8, closures plan §0.5.
- **`this` is not held on that stack.** It lives in the arrow's environment, which
  is a managed heap object reached from a traced root (the task table). That is
  the *same* discipline both backends require, for different reasons (Backend A:
  the frame is gone; Backend B: the frame is not scanned).
- So `this` inherits the rooting rule that closures already require and adds no
  new constraint. **If the rooting rule is honored, `this` works under both
  backends; if it is violated, `this` breaks in exactly the way closures do.**

**What is backend-specific: nothing.** The environment layout, the capture walk,
the call convention, and the `TS2332` rule are all compile-time facts about the
module. Only `await`'s lowering differs. **Same AST, same lowering input, both
backends.**

---

## H. Test harness

### H.1 Structural rule: no case may be dead-code-eliminated

Every case has this shape, and the harness must reject a case that does not:

1. the arrow is **assigned** to a binding that is **called** (so resolution
   reaches the body);
2. the result is **returned from `main`** (so codegen cannot drop it);
3. the host **compares the returned value** to the expected number (so the test
   observes a value, not a compile success).

Fact 5 shows exactly what happens without (1): the uncalled version compiles
clean. A harness case that compiles is *not* evidence; a harness case that
**returns the expected number** is.

### H.2 One case per rule in §B

| # | case | expects | today |
|---|---|---|---|
| 1 | arrow in method, `this.x` | 7 | **TS2339 `C#m`** |
| 2 | arrow nested in arrow in method | 7 | **TS2339 `…~anonymous\|0`** |
| 3 | arrow in class field initializer | 7 | **TS2339 `C#constructor`** |
| 4 | arrow in static method (class type, D3) | per D3 | **TS2339 `C.sm`** |
| 5 | arrow in a regular function with explicit `this` | 7 | **TS2339** |
| 6 | regular function expression with explicit `this` | 7 | works — regression guard |
| 7 | method `this` | 7 | works — regression guard |
| 8 | module-scope arrow using `this` | **`TS2332`** | `TS2332` — guard that it stays rejected |
| 9 | arrow calling a method through `this` (`this.handle(v)`) | correct | **TS2339** |
| 10 | arrow passed to a function-typed parameter (the `map` shape) | correct | **TS2339** |

Case 10 is the one that exercises the call convention end to end: the arrow
escapes as a value, so its environment must travel with it through a parameter of
function type and out the other side.

### H.3 Negative controls

- **NC1 — `this` in a nested arrow still resolves outward** (§B.2). Not merely
  "does the outer arrow work": the *inner* arrow's `this` must be the receiver
  two levels out.
- **NC2 — `this` in an arrow inside a regular function binds to the *regular
  function's* `this`, not to a class further out.** This is the control that
  proves the walk **stops** at a non-arrow function. `function outer(this: C) {
  return () => this.x; }` — and the harness must check that a *different*
  receiver passed to `outer` produces a *different* result, i.e. the binding is
  dynamic at the `outer` level and lexical only at the arrow level.
- **NC3 — `this` in an arrow passed to a host import.** The arrow escapes to the
  host boundary entirely; the environment must still be intact when the host
  calls back. (The ABI is unchanged — see §H.5.)
- **NC4 — an arrow with no `this` compiles and behaves exactly as today.** The
  fix must not change non-capturing arrows: they should keep the **static**
  `_env = 0` instance and allocate nothing.
- **NC5 — `this` in a nested *regular* function is `TS2332`, not `TS2339`.** The
  §C.3 diagnostic correction, as its own control.

### H.4 The DCE guard, in the harness itself

`tools/` gets a runner whose cases are all "return a number, compare it", plus a
**meta-test that would fail if a case were silently eliminated**: compile the
case, and assert the returned i32 **is not zero** where the expected value is
non-zero, and assert the emitted module is non-trivially different. The measured
layout facts (Fact 2's `param $0`, `_index` @ 0, `_env` @ 8) were obtained this
way — by *running* the wasm and reading its memory — and the harness should keep
doing that rather than trusting the source.

### H.5 Platform

**Linux**, per the task. All of §H.2's cases are pure guest logic plus a host that
reads a return value — no host change, no ABI change, no new import
(§C.4 adds an argument to an existing indirect call, which is internal to the
module). The existing measurement runner (`tools/runtime-migration/wtrunner`,
wasmtime pinned to the version `tension-core` uses) is the natural host.

---

## I. Interaction with the current test suite

### I.1 Nothing depends on the buggy behaviour

Measured across every plausible owner:

| corpus | `grep -rn "=> *this\b\|=> this\."` |
|---|---|
| Tension framework + examples + input | **0 hits** |
| AS `tests/` | **0 hits** |
| AS `std/assembly/` | **0 hits** |

**No test, no example, and no library code relies on arrow `this`.** The fix
cannot break existing code, because existing code cannot use the feature.

### I.2 No upstream fixture asserts the current error

Searched `tests/compiler/*.json` and `*.ts` for a fixture expecting `TS2339`
against a `#`-named function type (`#arrow`, `#m`, etc.): **none**. `TS2332`
fixtures exist and must keep passing — the fix *widens* `TS2332`'s application
(nested regular functions, §C.3), so **any fixture expecting `TS2339` where
`TS2332` is now correct is a fixture to update**, and that set is currently empty.

### I.3 Examples

**Enumerated, and the answer is "none change".** No example uses `this` in an
arrow (I.1), so every example's transcript is unaffected. The runtime-migration
work's byte-identical transcript gate is unaffected, and the `stub`/`incremental`
build matrix is unaffected — this fix changes no runtime choice and no
initial-memory requirement.

### I.4 The `ogre/bouncing-ball` page shortfall and the tail-latency cause are
**parked and untouched**, per this task's constraints. Named here only so the
next reader does not think they were overlooked.

---

## J. Fork model

**Detached fork. Upstream is reference only.** `origin` =
`git@github.com:Yabgu/TensionScript.git`; `upstream` fetch-only with its push URL
disabled. No compatibility patches to preserve upstream mergeability.

**This fix will not be upstreamed as-is, and that is expected.** Upstream's
`lookupThisExpression` is on the binaryen-era VM path and its closures design
(#798) is unlanded; a correct lexical-`this` fix requires the environment
mechanism, which upstream has not decided. We are not waiting.

| change | file(s) | kind |
|---|---|---|
| `lookupThisExpression` walks outward through arrows, stops at a non-arrow function | `src/resolver.ts` | **core** |
| `TS2332`/`TS2339` diagnostic correction for nested regular functions | `src/resolver.ts` | **core** |
| indirect-call site prepends the environment operand | `src/compiler.ts:7142` (`makeCallIndirect`) | **core** |
| capturing arrows materialise a heap `Function<T>` instance with `_env` set | `src/compiler.ts:7218`/`:7352` (`compileFunctionExpression`), `:2168` (`ensureRuntimeFunction`) | **core** |
| `this` in an arrow compiles to the environment, not a local | `src/compiler.ts:7440-7467` (`NodeKind.This`) | **core** |
| harness + fixtures | `tools/` and `tests/` | **additions** |
| **AST, tokenizer, parser, std lib, runtime** | — | **no change** (§D, and no runtime change per the constraint) |

**`src/ast.ts` is not touched.** That is worth stating because the closures plan
and async plan v2 both needed AST work; this fix needs none (§D).

---

## K. Open decisions for the architect

**D1 — How the `this`-only environment is represented.**
*Options:* (a) the environment pointer **is** the receiver, no allocation
(upstream #798's proposal); (b) always a one-field environment struct, `this` at
field 0, one allocation per arrow-that-binds-`this`.
**Recommend (a), with (b)'s struct as the general case** — and the choice made
**per function at compile time**, so the creation site and the access site always
agree. (a) is allocation-free, which matters for `map(x => this.f(x))` in a hot
loop, and it matches upstream's design. The cost is that `_env`'s meaning depends
on the function, which is fine because the *function's own code* is what
interprets it. The reason to reserve `this` a **fixed slot** rather than a
dynamically assigned one is that a dynamic slot would make (a) impossible.

**D2 — Does the environment argument change function *assignability*?**
**Recommend no.** The environment is an implicit leading parameter the compiler
adds and consumes; the *type* of a `this`-binding arrow stays `() => i32`. If the
type changed, `Array.map(f)` would stop accepting `f` — which would defeat the
purpose. This is the closure call convention (closures plan §5.1) and the
`makeCallIndirect` site already handles the analogous `thisType` case by
incrementing the operand counts (`compiler.ts:7094-7098`). **Confirming it
explicitly** because getting it wrong breaks the primary use case.

**D3 — What is `this` in a static method's arrow?**
TypeScript types it as `typeof C`; AS has no constructor-type. *Options:* (a) the
class **type** `C` (closest available); (b) reject with `TS2332`.
**Recommend (a)** — in a static method, `this` is the class object, and typing it
as the class type lets `this.staticField` and `this.staticMethod()` work, which is
what the pattern is for. (b) would leave a common TS pattern uncompilable for a
language-limitation reason rather than a semantic one.

**D4 — Is `this` in a nested *regular* function an error?**
**Recommend yes, `TS2332`** (§C.3), matching TS's `noImplicitThis` behavior in
strict mode, and correcting the diagnostic from `TS2339` against a
function-type name. Not a semantic change — AS already rejects it; only the
message improves.

**D5 — Does the fix require the method-decorator/`@inline` path to change?**
**Recommend no**, and note: `lookupThisExpression`'s existing `isInline` branch
(`resolver.ts:2210-2216`) already resolves `this` to the *target* function's
local, i.e. lexical `this` already works for **inlined** bodies. The fix must
**preserve** that branch and must not double-apply the walk when `isInline` is
set. Verify with a test: an `@inline`d arrow-using method.

**D6 — Should the environment parameter be added to *all* arrows, or only
capturing ones?**
**Recommend only capturing ones** (arrows that bind `this`). Non-capturing
arrows keep the static instance and `_env = 0` — NC4. Adding the parameter
universally would change every function value's signature for no benefit.

**D7 — `Function<T>` layout: hardcode `_env`'s offset, or derive it?**
The compiler already hardcodes `_index`'s offset **0** via `module.load(4, …)`
(`compiler.ts:7142`) and `ensureRuntimeFunction` writes both fields **by name**
through `writeField` (`:2170-2171`). **Recommend deriving both offsets from the
class layout** (`offsetof`/`writeField`) rather than adding a second magic number,
because two hardcoded offsets that must agree with a std-lib class is a drift bug
waiting to happen — and §C.4's trap shows how easy the misreading is.

**D8 — Scope: is the `super` interaction in scope?**
`lookupSuperExpression` (`resolver.ts:2252-2280`) has the same
`isInline`-then-parent shape, so `super` in an arrow is plausibly wrong in the
same way. **Recommend explicitly out of scope here** and noted as a follow-up: it
is the same *class* of bug, but `super` needs the base-class element rather than
the receiver, and bundling it would expand this fix past a correctness repair
into a redesign of `this`/`super` resolution. Flagged, not silently omitted.

---

## L. What happens on approval (nothing before)

Nothing until the architect reviews this document. On approval:

- **T0** — close the one research item: does a resolved `Function` report
  `arrowKind`, or must the walk read it from the declaration? (§C.2)
- **T1** — the resolver change: the walk, plus the `TS2332` correction.
  Gate: §H.2 cases 1-5, 9, 10 return their expected values; case 8 still rejects.
- **T2** — codegen: the environment operand at the indirect-call site, and heap
  instances for capturing arrows. Gate: case 10 (the escaping `map` shape) and
  NC3 (host import).
- **T3** — controls: NC1-NC5, plus the DCE meta-guard (§H.4).
- **T4** — the diagnostic-fixture sweep (§I.2) — currently empty, but it must be
  run rather than assumed.

Each is a separate dispatch after review. **No code has been written for this
plan.**

**Working tree:** the branch is `feat/runtime-migration` with the runtime
migration landed. This plan does **not** modify `tension-core`, does not modify
`docs/closures-plan.md` or `docs/async-await-plan-v2.md`, and does not propose any
runtime change — `incremental` stays as confirmed.
