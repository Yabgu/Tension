# Closures in TensionScript — PLAN

**Status:** proposal, awaiting architect review. **No code written. No lowering
implemented. No commits beyond this document.**
**Consistent with:** `docs/async-await-plan-v2.md` (v2). Where this plan changes a
v2 decision, it says so and says why.

Date of evidence: 2026-10-15. Fork state: `origin` = `git@github.com:Yabgu/TensionScript.git`,
initial commit `b6bda05c`, submodule at `third_party/assemblyscript`.

---

## 0. The four things that had to be established — all four are settled

The mission listed four risks to resolve before designing anything. Three
resolved cleanly. **One resolved into a blocker that is not about the compiler at
all, and it changes the shape of what comes next.**

### 0.1 Risk 1 — FunctionExpression and arrows today: **partial mechanism, not a clean slate**

This is the single best piece of news in the plan, so it goes first.

**First-class functions are already implemented.** Upstream commit
`7de4745e feat: Implement first-class functions (#1384)` (verified via
`git log -S"_env" -- std/assembly/function.ts`). Function values exist today.

The AST is already the right shape and needs **no new nodes**:

- `FunctionExpression` (`src/ast.ts:1351-1359`) is a thin wrapper:
  ```ts
  export class FunctionExpression extends Expression {
    constructor(public declaration: FunctionDeclaration) {
      super(NodeKind.Function, declaration.range);
    }
  }
  ```
- `FunctionDeclaration extends DeclarationStatement` (`src/ast.ts:2090`, base at
  `:1753`) and carries `typeParameters`, `signature: FunctionTypeNode`,
  `body: Statement | null`, **`arrowKind: ArrowKind`**.
- `ArrowKind` (`src/ast.ts:2080-2088`) is `None | Parenthesized | Single` — so
  **arrow-ness is already a first-class AST fact**, which is exactly what the
  `this`-binding rule needs.
- `MethodDeclaration extends FunctionDeclaration` (`src/ast.ts:2215`) — one
  representation covers methods.

**The runtime value representation for closures already exists, and the compiler
never fills it in.** `std/assembly/function.ts` in full:

```ts
@final export abstract class Function<T> {
  private _index: u32;
  private _env: usize;

  get index(this: T): u32 {
    return load<u32>(changetype<usize>(this), offsetof<Function<T>>("_index"));
  }
  // ... name, length, call ...
  @unsafe private __visit(cookie: u32): void {
    // Env is either `null` (nop) or compiler-generated
    __visit(this._env, cookie);
  }
}
```

Three things follow, all verified:

1. **`_env` is the environment slot.** It exists, it is `usize`, and the
   collector already traces it — the comment says so: *"Env is either `null`
   (nop) or **compiler-generated**"*. The std lib was written in anticipation of
   this feature.
2. **The compiler writes it exactly once, always as zero.** `ensureRuntimeFunction`
   (`src/compiler.ts:2154-2177`) pushes the function onto a function table, resolves
   the `Function<T>` wrapper class, and writes `_index` = table index and
   **`_env` = 0** into a **static, memoized** memory segment
   (`compiler.ts:2168-2174`, memoized via `instance.memorySegment`). Grepping
   `src/` for `_env` returns that one write and nothing else.
3. **Capture is already *detected*, at exactly two sites.** Both are guarded by
   `declaredByFlow(flow)`:
   - `src/compiler.ts:5708` — the assignment-target path
   - `src/compiler.ts:7562` — the read path

   and `declaredByFlow` (`src/program.ts:3687`) is one line:
   ```ts
   declaredByFlow(flow: Flow): bool {
     return this.parent == flow.targetFunction;
   }
   ```

   That is the whole closure test: *does this `Local` belong to the function I am
   currently compiling?* If not, it is captured, and today that is an error.

**Exact current behaviour, measured:**

```
let x: i32 = 1; let f = (): i32 => x + 1;
  → ERROR TS2454: Variable 'x' is used before being assigned.
  → ERROR AS100: Not implemented: Closures
    FAILURE 2 compile error(s)
```

`AS100` is `DiagnosticCode.Not_implemented_0` (`"Not implemented: {0}": 100` in
`src/diagnosticMessages.json:2`) with `"Closures"` as the argument. Note the
**companion spurious diagnostic**: `TS2454` is misleading and should be
suppressed once capture is supported — a small correctness point for the
implementation.

Non-capturing uses **already work**: a nested `function` declaration assigned to
a function-typed variable compiles clean, and a non-capturing arrow
(`const f = (v: i32): i32 => v + 1`) compiles and runs clean. So only *capture* is
missing.

**`CommonFlags.Closure = 1 << 29` (`src/common.ts:79`) exists and is dead** —
grep for it across `src/` returns zero uses. Another piece of groundwork with no
implementation behind it.

**One semantic bug to fix, not just a missing feature:** arrow functions do **not**
lexically bind `this` today. Measured:

```
class C { x: i32 = 7; arrow(): () => i32 { return (): i32 => this.x; } }
  → ERROR TS2339: Property 'x' does not exist on type 'C#arrow'
```

`this` inside the arrow resolves to the arrow's *own* function type. My first
test of this appeared to pass; it was dead-code elimination — `arrow` was never
called, so its body was never resolved. When the closure is actually used, the
non-lexical binding shows. That is the first thing in this plan that is a
*divergence from TypeScript* rather than an absence of a feature.

Resolution path: `resolveThisExpression` (`src/resolver.ts:2234`) →
`lookupThisExpression`. There is already an `isInline` precedent for "`this`
belongs to an enclosing function": `lookupSuperExpression`
(`src/resolver.ts:2261-2275`) begins with `if (ctxFlow.isInline) { let superLocal =
ctxFlow.lookupLocal(CommonNames.super_); ... }`, i.e. inline flows look up `this`
and `super` as locals of the *target* function's flow. Arrow `this` needs the
same idea, keyed on `arrowKind != ArrowKind.None` instead of `isInline`.

**Verdict on Risk 1: partial mechanism.** The value representation, the type-system
hook, the GC tracing, the arrow-ness fact, and the capture *detector* all exist.
What is missing is capture *analysis*, environment synthesis, and the codegen that
fills `_env`.

### 0.2 Risk 2 — arena vs closure lifetime: **the premise is wrong, and the real answer is elsewhere**

The mission states: *"JS/TS semantics require captured bindings to outlive the
enclosing function. The arena sweeps."*

**The arena does not sweep. The arena is not an allocator at all.** I went looking
for the sweep and there isn't one. What is there:

`tension-core/src/session/arena.rs:1-10` (module doc):

> The layout is **frozen**: the twelve region kinds are `kind == index`, every
> region's offset is a compile-time constant, and `arena_size` only selects how
> much of the band is live.

`tension-framework/assembly/runtime/arena.ts:1-20` (guest-side doc), verbatim:

> **Nothing here allocates.** `changetype<T>(offset)` is a view: it costs nothing
> and it holds no reference, which is why these are functions and not a memoized
> global — a cached view would be a cached pointer into memory the guest may write.

The only thing in the arena that resembles reclamation is named a "reclaim
counter" and is something else entirely — `set_ring_tail` (`arena.rs:647-655`):

> Set a sub-ring's `tail` — **the guest's reclaim counter**. Called by
> `subring::compact_subring` and nowhere else: *the tail is the guest's to
> advance*, and the only reason the session ever writes it is to zero it when it
> has just consumed the reclaim by sliding records down.

That is a **consumer position in the event-delivery ring**, not memory
reclamation. Events, not objects.

What the arena *does* do is get **zeroed once per session open**, as the baseline
for a clever overlap test — `zero_band` (`arena.rs:969-978`), called from
`prepare_arena` (`session/mod.rs:514`):

> The session zeroes the whole band the module claims before instantiation, which
> is what turns "is the band still zero" into a complete test for a guest data
> segment landing in the arena.

So the arena's lifetime is the **session**, its content is **reset at open**, and
nothing inside it is per-object. It is a fixed, hand-partitioned, session-scoped
scratch band.

**The actual memory map**, verified, which is what makes the closure answer clean:

```
0x000000 .. 0x5F6020     the frozen arena layout (LAYOUT_FLOOR = 6,250,528)
0x5F6020 .. 0x800000     the canary lattice — a guard band, not usable memory
0x800000 ..              the guest heap  (memory_base = DEFAULT_MAX_ARENA_SIZE = 8 MiB)
```

- `LAYOUT_FLOOR = BUFFER_POOL_OFFSET + BUFFER_POOL_SIZE` (`arena.rs:366`),
  asserted `== 0x5F6020 == 6_250_528` (`arena.rs:1342-1343`).
- `mem.base` default is `DEFAULT_MAX_ARENA_SIZE = 8 * 1024 * 1024` (`arena.rs`,
  and the field is documented as *"The default reserved ceiling, and therefore the
  default `memoryBase`"*).
- `write_canary_lattice(data, LAYOUT_FLOOR, memory_base)` (`session/mod.rs:535`) —
  the lattice covers exactly the gap, so an overrun of the arena is *detected*
  rather than silent.

**Therefore: the closure environment lives on the guest heap, above
`memory_base`, exactly where v2 §4.4/D5 already put the async state struct.**
It does not touch the arena, and this is not a workaround — the arena was never a
candidate, because it has no allocation mechanism to lend.

Two consequences worth stating explicitly, because the mission asked:

- **The 32-byte completion record: untouched.** That record is event delivery, it
  is transient, and its ring slot is owned by the session. The async plan already
  restricts guest use of it to two generic payload words (`a` @ 16, `b` @ 20);
  closures add nothing and must not.
- **`BUFFER_POOL`: untouched, and must stay untouched.** Region 11
  (`arena.rs:311`, 4 MiB, `RD_GUEST_WRITES | RD_BYTES`) is not a pool with slots —
  it is a **hand-carved static sub-layout**: the motion table at its first byte,
  the bone table after it, then a procedural window at `PROCEDURAL_BASE` = 256 KiB
  (`tension-ogre/DESIGN.md:633, 648, 779, 1595`). Positions are compile-time
  constants. **There is no slot allocator, and therefore no "who owns slots"** —
  the question presupposes a mechanism that does not exist.

**So the honest answer to Risk 2 is: the arena is irrelevant to closure lifetime,
and the real question is which *guest runtime* manages the heap the environment
lives on.** Which brings us to the blocker.

### 0.3 Risk 2 continued — **the blocker: Tension's guests are built with `--runtime stub`**

This is the sharpest finding in the plan. It is not in the mission's list of
risks, and it is not a compiler problem.

Every example builds its guest with a **stub runtime**:

```
examples/ai/package.json:8      "build": "asc story.ts -o build/story.wasm --runtime stub --target release"
examples/audio/package.json:8   "build": "asc demo.ts -o build/demo.wasm --runtime stub --target release"
examples/io/package.json:8      ... --runtime stub ...
examples/log/package.json:8     ... --runtime stub ...
examples/res/package.json:8     ... --runtime stub ...
```

`std/assembly/rt/index-stub.ts` is exactly `import "./stub"`. And `stub.ts` is:

- `__alloc` — a **bump allocator**; it advances `offset` and never looks back.
- `__free(ptr)` — **only** discards when the block is the topmost one:
  ```ts
  if (ptr + block.mmInfo == offset) { // last block: discard
    offset = changetype<usize>(block);
  }
  ```
- `__link` — `// nop`
- `__collect` — `// nop`
- `__pin` — `return ptr`; `__unpin` — `// nop`
- **no reference counting anywhere.** Verified broadly: `__retain`/`__release`
  appear only in `src/bindings/js.ts` (JS-host glue), and nowhere in
  `std/assembly` or `src/`. AS's collectors are *tracing*, not refcounting:
  `itcms.ts` is *"An incremental Tri-Color Mark & Sweep garbage collector"*,
  `tcms.ts` is a two-color one.

**So under `--runtime stub`, nothing a closure allocates is ever reclaimed.**
Where the flag comes from, verified: `tension-framework/build.sh:149` generates
`tension-framework/build/session.asconfig.json` with `"runtime": "stub"` in its
`asconfig_doc`, and the OGRE examples build with
`asc game.ts --config ../../../tension-framework/build/session.asconfig.json`
(`examples/ogre/*/package.json:8`) — so they inherit it. The non-OGRE examples
state it directly (`examples/{ai,audio,io,log,res}/package.json:8`). Full detail
and the exact edit list are in D1.

I measured it rather than reasoning about it. A managed class with one `i32`
field — the smallest possible closure environment — allocated 100,000 times:

```
runtime=stub          grew 3,202,832 bytes  →  32.03 bytes per object
runtime=incremental   grew    36,960 bytes  →  all but a trace reclaimed
```

(The 32 bytes matches the arithmetic exactly: `BLOCK_OVERHEAD` 4 + `OBJECT_OVERHEAD`
16-aligned + a 4-byte payload → `computeSize` rounds to 32.)

**The arithmetic that makes this fatal**, using the session's own numbers:

- `tension-framework/session.json`: `maximum_pages: 512` → **32 MiB** ceiling;
  `memory_base` 8 MiB → **~24 MiB of heap**.
- 24 MiB ÷ 32 bytes = **~786,000 environments** before `memory.grow` fails. And
  `maybeGrowMemory` calls `unreachable()` on failure — so the failure mode is a
  wasm trap → session fault, not a quiet degradation.
- A game allocating **100 closures per frame** at 60 fps: 786,432 ÷ 6,000 ≈
  **131 seconds**.
- **One** closure per frame: ≈ **3.6 hours**.

So the mission's motivating examples — `array.map(x => x*f)`,
`events.on('click', e => handle(e))` — are not merely missing; **under the current
build configuration they are an unbounded leak that ends a session in minutes.**
Closures are a correctness feature *and* a memory-model change, and shipping the
compiler work without the runtime change would ship a footgun.

**The fix requires no host change and no ABI change.** `--runtime incremental` is
`import "./tlsf"; import "./itcms"` — a per-module compile flag:

- **No shadow stack needed, no host cooperation needed.** `visitStack`
  (`itcms.ts:167-173`) is a **conservative linear scan**:
  ```ts
  function visitStack(cookie: u32): void {
    let ptr = __stack_pointer;
    while (ptr < __heap_base) { __visit(load<usize>(ptr), cookie); ptr += sizeof<usize>(); }
  }
  ```
  It walks every word of the linear stack and asks `__visit` whether each looks
  like a traced object. `visitRoots` (`itcms.ts:155-164`) adds `__visit_globals`
  and the pin space. Collection self-triggers: `__new` does
  `if (total >= threshold) interrupt();` (`itcms.ts:262`).
- **The `stackSize`/`ShadowStackPass` path is separate** and the dependency runs
  the *other* way — `compiler.ts:540`: `let hasShadowStack = options.stackSize > 0;
  // implies runtime=incremental`. Shadow stack implies incremental; incremental
  does not imply shadow stack.
- **No codegen change is needed to benefit.** Write barriers are already emitted:
  I counted 3 `__link` call sites in a test module compiled under `stub` and 3 in
  the same module under `incremental` — identical, because the codegen path is
  shared. Under stub they are nops; under incremental they become real. A
  synthesized environment class with managed fields therefore gets correct
  barriers for free.
- **Cost, measured:** 932 bytes → 5,620 bytes of wasm on a trivial program. That
  is a fixed ~4.7 KB (the ITCMS runtime plus generated `~visit` per managed
  class), and it shrinks as a share of a real game module. Plus per-allocation
  cost and incremental collection pauses.
- **Bonus:** ITCMS has a real `__finalize` (`itcms.ts:250`) and `__pin`/`__unpin`
  (`:334, :348`) — useful later for closures holding external resources or for
  objects whose pointers cross to the host.

**This is an architect decision, not a plan detail** (it changes the build
configuration and the runtime cost of every guest), so it is D1 in §10. But the
direction is not in doubt: closures cannot be correct under `stub`.

### 0.4 Risk 3 — the async state struct: **designed together, and the hard case dissolves**

The mission calls this the hard case: *"A closure inside an async function whose
captured variables must survive suspension — the state struct must carry the
environment across suspend points, not just locals."*

There is a decision that makes this go away, and it is the central design idea of
this plan:

> **A captured binding's storage *is* the environment.**
> A local that is captured by any closure has exactly one home — an environment
> field — and is therefore never a wasm local and never a state-struct field.

This is not a trick to dodge the problem; it is what JS semantics require
anyway. JS captures the *binding*, not a copy of the value: the closure and the
enclosing function must observe each other's mutations. Two storage locations
would be a bug, not an implementation choice.

So the **storage rule for every binding**, one home each:

1. captured by any closure → **environment** (guest heap, managed object)
2. else live across an `await` → **state struct** (guest heap, managed) — v2 §4.3
3. else → **wasm local** (cheapest)

**Capture wins over lifting, so capture and lifting never overlap.** The async
state struct never needs to copy captured variables, because captured variables
have already left the lifting problem.

What the state struct *does* need is a **managed reference to the environment**,
because:

> Under Backend A, when a task is suspended its wasm frame is **gone**. The
> conservative stack scan (`visitStack`) only sees live stack. So anything a
> suspended task needs must be reachable from a **root**.

The chain is then: task table (a **managed global**, traced by `__visit_globals`)
→ state struct (managed, managed fields) → environment (managed) → captured
references (managed fields, `__visit`-traced). Every link must be a managed field
or the collector cannot see through it. This is why v2 D5's "managed, not
`@unmanaged`" requirement matters, and it extends to the environment.

**Async function inside a closure** is the easy direction and needs nothing new:
an `async` function is just a function; whether it is reached directly or through
a `Function<T>` value, the async lowering is unchanged. What it does need is that
the implicit environment parameter survives into the resume function — a one-line
consequence of the call convention in §5.

### 0.5 Risk 4 — closure × WasmFX: one genuine hazard, and it is not about lowering

Covered in full in §9 (Backend B compatibility), but the finding belongs here
because it is a *memory-model* interaction rather than a lowering one:

Under WasmFX, a suspended continuation's frames live on an **engine-managed fiber
stack**, not in the region `visitStack` scans (`[__stack_pointer, __heap_base)`).
So the conservative scan cannot see them. A reference held **only** on a suspended
continuation's stack would be invisible to the collector and could be reclaimed
while still live.

This does **not** break the design — but it does mean the rooting rule from §0.4
is required under *both* backends, for different reasons:

- Backend A: the frame is gone, so roots are the only way.
- Backend B: the frame exists but is not scanned, so roots are *still* the only way.

That is a nice property: a rule that would otherwise look like a Backend A
artifact is in fact backend-neutral, so it can be enforced everywhere without
baking in an assumption. It is written up as such in §9.

---

## 1. Semantics: match TypeScript

### 1.1 Capture by reference — one mechanism, not two

The mission says *"mutable bindings captured by reference, const captured by
value"*. I want to correct that precisely, because implementing it literally
would be extra machinery for no observable difference:

**In JS, `const` is captured by reference too.** The binding is immutable, so
nothing can observe the difference — but the mechanism is the same one.
Implementing a separate by-value path for `const` would be wasted work that adds
a second code path to test, and it would be *wrong* the moment someone wants
`const` in a class field or a destructuring pattern.

One nuance worth stating because it is the one place "by value" could bite:
`const o = {}; const f = () => { o.x = 1; }` — mutations *through* the reference
must be visible. By-reference sharing gives that for free; a copied reference also
gives it (same object). So there is no divergence either way, which is exactly why
the simpler single mechanism is the right call.

**Decision: all captured bindings are shared by reference, for `let` and `const`
alike. `const`'s immutability is enforced at compile time by AS's existing
const-assignment check, which already exists.**

### 1.2 Environment granularity: per scope instance, chained

The granularity choice is load-bearing, and the obvious alternative is wrong:

- **Per closure** (each closure gets its own env holding only its captures) —
  **wrong**. Two closures in one scope capturing the same variable would each get
  their own copy, so mutations would not be shared:
  ```ts
  let n = 0;
  const inc = () => ++n;
  const get = () => n;      // per-closure envs: get() never sees inc()'s write
  ```
- **Per scope instance** — correct. One env per scope instance that has any
  captured binding, shared by every closure created in that instance.

Nested capture across scopes needs a chain: each environment carries a **parent
link** to the environment of the enclosing scope. A captured reference compiles
to a statically-known **(depth, fieldIndex)** pair — walk `depth` parent links,
load field `fieldIndex`. Both numbers are known at compile time, so a capture
read costs a bounded number of loads and no search.

### 1.3 Per-iteration bindings — the case that breaks on the third call site

This is the single most important correctness obligation in the plan, and it is
exactly the kind of thing that fails late if it is not designed in:

```ts
const fns: (() => i32)[] = [];
for (let i = 0; i < 3; i++) fns.push(() => i);
// JS/TS: fns[0]() == 0, fns[1]() == 1, fns[2]() == 2
```

A `let` in a `for` header creates a **fresh binding per iteration**. One shared
environment for the whole loop yields `3, 3, 3` — the classic bug.

**Requirement: for bindings declared in a loop header (`for (let i = ...)`,
`for (const x of ...)`) that are captured, a fresh environment is allocated at the
top of each iteration, with the current value of the iteration variable copied
in.** This applies to the loop *body*'s env for those bindings; non-loop captured
bindings in the same scope still allocate once at scope entry.

Note the asymmetry that makes this subtle: the iteration variable needs copying
per iteration, but a binding declared *inside* the body is naturally per-iteration
because its scope instance is per-iteration. So the loop-header case is the one
that needs the explicit copy, and it gets its own test (§8).

### 1.4 `this` binding

TypeScript's rule, which we match:

- **Arrow functions bind `this` lexically.** In AS, a method's `this` is a local
  (`thisLocal`), so **`this` inside an arrow is simply another captured binding** —
  the same mechanism, no special case in the environment, no special call
  convention.
- **Regular `function` expressions have their own dynamic `this`.** That is what
  AS does today for all functions, so regular function expressions need **no
  change**.

So the whole `this` fix is: in an arrow (`arrowKind != ArrowKind.None`), `this`
must resolve to the enclosing function's `this` and be captured, instead of
resolving to the arrow's own. Measured today it resolves to the arrow's own
(`TS2339: Property 'x' does not exist on type 'C#arrow'`), which is both
non-lexical and, for a bare arrow, effectively unusable. This is a **semantic
bug**, not merely an absent feature.

### 1.5 Hoisting and TDZ — what AS actually does, and what we do about it

**AS has no hoisting of any kind.** Measured, all three:

```ts
// nested function declaration, called before its declaration
let r = inner(); function inner(): i32 { return 5; }   → TS2304: Cannot find name 'inner'
// arrow assigned to let, called before
let r = f(1); let f = (x: i32): i32 => x + 1;           → TS2304: Cannot find name 'f'
// var read before its declaration
let r = x; var x: i32 = 3;                              → TS2304: Cannot find name 'x'
```

Names resolve **strictly in declaration order**. There is no function hoisting, no
`var` hoisting, and therefore no TDZ either — a name simply does not exist until
its declaration is reached.

**Decision: this plan does not add hoisting.** Reasons:

1. It is **orthogonal to closures.** Nothing about capture requires it.
2. It is a **much larger change** than it looks: the resolver resolves in
   declaration order, so hoisting means a per-scope pre-pass that collects
   declarations before resolving bodies, plus the JS `var`-vs-`let` distinction
   (initialised-`undefined` vs TDZ), plus the error paths. That is a resolver
   rework with a whole plan of its own.
3. It is not a closure-specific divergence — **all** AS code behaves this way
   today. Fixing it belongs with the broader "be TypeScript-shaped" work, not
   smuggled into the closures plan.

**Consequences for closures, stated plainly:**

- A closure can only capture bindings **textually declared before it**. Stricter
  than TS, but consistent with every other name reference in the language.
- `var` behaves like `let` in AS (no hoisting, no pre-initialised `undefined`).
  Pre-existing divergence, documented, not introduced here.

**The residual TDZ hole, and what to do about it.** Because there is no
declaration-before-use, the only remaining case is:

```ts
let x: i32;                 // declared, not yet assigned
const f = (): i32 => x;     // captured — legal
f();                        // reads x before its assignment
x = 1;
```

Three options:

- **(a)** Rely on AS's existing flow-based definite-assignment analysis
  (`CommonFlags.DefinitelyAssigned`, `LocalFlags.Initialized` — the mechanism
  behind the existing `Variable_0_is_used_before_being_assigned` diagnostic).
  Cheap, already there, but the closure body is compiled in its **own flow**, so
  it will not always see the enclosing flow's facts.
- **(b)** An **initialization flag per captured `let`/`const` slot** in the
  environment, checked on read. Costs one word per captured mutable slot plus a
  branch per captured read, and turns the residual case into a **defined runtime
  error** instead of a silent zero.
- **(c)** Ignore it and read the zero value. **Rejected** — that is the plan
  silently lying about what it does, which the mission explicitly forbids.

**Recommendation: (a) + (b).** Use the existing flow analysis to reject every
statically-detectable case, and put the runtime guard on the remainder so the
residual case is loud. It is D3 in §10.

### 1.6 What breaks — the honest list

Things from JS/TS that will **not** work, with the reason:

| Not supported | Why |
|---|---|
| Hoisting (function declarations, `var`) | AS resolves in declaration order; orthogonal to closures; §1.5 |
| TDZ as a throw | No exceptions in the language (`AS100: Not implemented: Exceptions`); §1.5 uses a runtime guard + static rejection instead |
| `arguments` object | Does not exist in AS; arrow/function params are the interface |
| `try`/`catch` around a closure call | No exceptions; a failure inside a closure cannot be caught by its caller — this is v2 §3.3's checked-status model, unchanged |
| `Function.prototype.call`/`apply` with a dynamic `this` on an **arrow** | Arrows bind `this` lexically by design — matching TS, where this is also disallowed |
| `bind` | Not implemented in AS; not added here |
| `eval`, `new Function` | No runtime compilation |
| Generators / `yield` in closures | AS has `Token.Yield` reserved but `yield` is unimplemented (`parser.ts:3699-3701`); not in scope |
| Closures over `with` | `with` is reserved but unsupported |

---

## 2. AST changes

### 2.1 What captures look like in the AST: **nothing**

This is a deliberate, evidence-backed decision, and it is the answer to
"new node? field on existing node?" — **neither.**

**Closures add no new AST node and no new AST field.** The AST already carries
everything syntactic that closures need:

- function-as-an-expression → `FunctionExpression` wrapping `FunctionDeclaration`
  (`ast.ts:1351`, `:2090`)
- arrow-ness → `arrowKind: ArrowKind` (`ast.ts:2080-2088`)
- the body and signature → `FunctionDeclaration.body`, `.signature`
- identifiers → `IdentifierExpression` (already reused for `this`)

**The capture set is not syntax, and putting it on a node would be wrong for three
concrete reasons:**

1. **The AST gets cloned.** `compileFunctionExpression` begins with
   `let declaration = expression.declaration.clone(); // generic contexts can have
   multiple` (`compiler.ts:7223`). Metadata hung on the node is stale or wrong
   after a clone, and generic contexts produce several instances of one node.
2. **An unresolved AST has no elements to name.** Which binding is captured is a
   fact about *resolved* `Local` elements, which do not exist until resolution.
   The AST node is the wrong layer.
3. **Both backends need the same resolved fact, and neither owns it.** Hang it on
   a node and it becomes a place for a backend to write state-machine assumptions
   — precisely the failure v2 §5.3 warns about.

**Where capture information lives instead:** in the **resolved model**, keyed by
the `Function` element, as a **side table** — the same discipline as v2 §5.4's
"backend metadata lives in side tables keyed by node identity, never on the node."
Concretely, per closure-shaped `Function`:

```
CaptureInfo {
  captures:      (Local element, defining Function, fieldIndex)[]
  envChainDepth: how many parent links to walk            // for resolution
  envClass:      the synthesized environment class
  isCapturing:   bool                                     // false → zero-cost path
}
```

with, per reference site, a resolved `(depth, fieldIndex)` pair.

**What the AST must carry so Backend B can lower it later without a rewrite:** the
same thing it carries for Backend A — the syntax, and nothing else. Because the
environment is a plain managed object whose layout is fixed at analysis time, and
the call convention is `(tableIndex, env, args…)`, neither backend needs anything
extra in the AST. §9 makes this argument in full.

### 2.2 FunctionExpression and ArrowFunction today → what they become

They **keep their current shape**. What changes is not the node but three things
downstream:

1. `declaredByFlow` stops being an error condition and becomes a **query**
   (`is this local captured?`) that the capture analysis answers.
2. `ensureRuntimeFunction`'s static-instance path gains a **heap-instance path**
   for capturing functions (§5).
3. `this` inside an arrow resolves to the enclosing function (§1.4).

### 2.3 The async state struct extension

Per §0.4, the extension is minimal and is a *consequence* of the storage rule:

- The state struct gains one field per **live environment** (usually one, plus one
  per distinct enclosing scope whose environment is needed after a suspension).
- Those fields are **managed references**, so the collector traces
  state → env → captured bindings while the task is suspended.
- **No captured binding is copied into the state struct.** Ever. That is the rule
  that keeps the two features from fighting.
- The resume function's implicit environment parameter is threaded through, so a
  closure that resumes after a suspension still has its env (§5.2).

The storage rule from §0.4 is the thing to design once:

```
                    ┌────────────────────────────────────────────┐
   is the binding   │ captured by any closure?                   │──yes──▶ ENVIRONMENT
   used where?      └────────────────────────────────────────────┘        (guest heap, managed)
                              │ no
                              ▼
                    ┌────────────────────────────────────────────┐
                    │ live across an await?                      │──yes──▶ STATE STRUCT
                    └────────────────────────────────────────────┘        (guest heap, managed)
                              │ no
                              ▼
                          WASM LOCAL
```

One home per binding, decided once, at one place in the pipeline. If async had
been designed to lift locals and closures designed to copy captures, the two would
disagree about `let n = 0; const f = () => ++n; await x; f();` — the state struct
would hold a stale `n` and the env a second one. Designing them together is what
removes the case the mission flagged as the hard one.

---

## 3. Capture analysis

### 3.1 The algorithm

Per closure-shaped function (a nested `FunctionExpression`/arrow **used as a
value** — see §3.4), in two steps:

**Step 1 — collect free variables.** Walk the function's resolved body; for every
reference to a `Local` element `L`, if `L.parent != thisFunction`, then `L` is
free in this function. This is the **same test** that `declaredByFlow`
(`program.ts:3687`) already performs, and the same `resolver.lookupIdentifier`
call the compiler already makes at `compiler.ts:5708` and `:7562` — so the
analysis resolves identifiers exactly the way codegen does, and cannot disagree
with it.

**Step 2 — build the environment chain.** Group free variables by their defining
`Function`. For each defining scope that contributes captures, that scope owns an
environment; deeper scopes' environments link to shallower ones. Assign each
captured binding a `fieldIndex` within its own scope's environment, and each
reference a `(depth, fieldIndex)`.

Both steps are **syntactic-plus-resolved** — no type inference, no liveness. The
only ordering concern is that the environment's **field layout must be stable for
a given scope** even though closures are discovered in source order, so field
assignment is by declaration order of the captured bindings, not by discovery
order.

**Transitivity:** if an inner closure captures `x`, and the middle function also
references `x`, then the middle function is itself a capturer of `x` — it needs
`x` in *its* environment too (or, if the middle function is itself not a closure
but its child is, the middle function still owns an environment). The analysis must
propagate captures **outward**: a binding captured at depth *n* must be reachable
through every environment between its defining scope and the closure. This is the
standard upvalue propagation and it is the part most likely to be got wrong
subtly, so it is a dedicated test case (§8).

### 3.2 Where in the compiler it runs

**A per-function pass, immediately before that function's body is compiled**, not
a global pre-pass. Reasons:

- AS compiles lazily and per-function; a global pre-pass would have to walk the
  whole program for a fact that is needed one function at a time.
- It must run **before** `compileFunctionExpression` materializes a closure value
  (§5.1), because that is where the environment is allocated.
- It must run **before** the two `declaredByFlow` checks, because those become
  lookups into its results.

Natural home: a new `src/passes/closure.ts` (a pure addition) exposing something
like `analyze(function, flow): CaptureInfo | null`, called from `compileFunction`
and consulted by the capture sites. It is *not* a Binaryen pass — it operates on
the resolved AST/element model, before codegen — so it is a sibling of
`src/passes/*` in spirit, not in interface.

### 3.3 Fitting AS's index-based variable model

AS's model, precisely:

- A `Local` has `index: i32` — *"Zero-based index within the enclosing function"*
  (`src/program.ts:3667`) — i.e. a **wasm local index**.
- Locals are created by `flow.targetFunction.addLocal(type, name, declaration)`
  (`program.ts:3933-3947`), which appends to `localsByIndex`.
- Name resolution reaches them through the flow's scope chain
  (`ctxFlow.lookupLocal`).

**Capture does not change this model; it adds a second addressing form beside
it.** Recommendation:

- **Leave `Local.index` alone.** Do not overload it to mean "environment field
  when captured" — that would poison every existing `local_get`/`local_set` path
  with a conditional, and it is exactly the kind of edit that breaks on the third
  call site.
- **Add a resolved capture descriptor per reference site**, in a side table: for a
  captured reference, `(depth, fieldIndex)`; the codegen emits env-walk + load
  instead of `local_get`. Non-captured references are untouched.
- The environment's own fields are modelled as an ordinary **synthesized managed
  class** (one per scope shape), so its field offsets come from AS's existing
  class layout machinery rather than a parallel layout scheme. That also gets
  `__visit` generation and `__link` barriers for free (§0.3).

There is a partial precedent worth knowing: AS's **inline** mechanism
(`Flow.createInline(targetFunction, inlineFunction)`, `flow.ts:219-234`) compiles
one function's body *into another function's flow*, so the inlined body sees the
target's locals directly — the compiler already has the notion of "this body
belongs to another function's variable space", just in the opposite direction.
And `lookupSuperExpression` (`resolver.ts:2261`) shows the resolver consulting
`ctxFlow.isInline` to decide that `this`/`super` belong to the enclosing function.
That is the closest existing analogue to what closure resolution needs.

### 3.4 Which functions are closures

Not every nested function needs an environment. The analysis classifies:

- **No free variables** → *not* a closure. Zero allocation: the value stays the
  **static** per-function instance (`ensureRuntimeFunction`, `_env = 0`) exactly as
  today. This is the common case and it must stay free — `arr.map(x => x * 2)`
  allocates nothing.
- **Has free variables** → a closure. Heap-allocated instance + one environment
  allocation at creation time.

The classification is also what makes the optimization story honest: the cost of
closures is paid only where capture actually happens.

---

## 4. Memory model

### 4.1 Where the environment lives

**The guest heap, above `memory_base`, as a managed AS object.**

Rejected, with reasons, because each of these is a plausible-sounding wrong answer:

- **The arena.** Not an allocator (§0.2); no allocation mechanism, fixed regions
  under a layout hash, reset per session open. There is nothing to allocate from.
- **`BUFFER_POOL`.** A hand-carved static sub-layout with compile-time positions
  (§0.2). No slots, and adding a slot allocator to it would be a host-side ABI
  change.
- **The 32-byte completion record / event ring.** Transient event delivery, owned
  by the session. Nothing to do with object storage.
- **A static segment.** Would permit one live environment per closure *shape* —
  two closures of the same shape would alias each other. Fatal for any real use
  (two callbacks in one scope).
- **The wasm stack.** The environment must outlive the frame by definition. This
  is the entire reason the feature exists.

Managed (not `@unmanaged`) is **required, not preferred**: captured bindings can
be reference-typed (`String`, `Array<f32>`, a handle), and the collector must trace
them. An unmanaged buffer would let a captured reference be reclaimed while the
closure is still live — a dangling pointer that resumes the game with garbage.

### 4.2 When it is freed

**By AS's collector on the guest heap, which is chosen by the `--runtime` flag
(§0.3, D1).**

- Under `--runtime incremental` (ITCMS): a tracing mark-&-sweep collector, self
  triggered by a threshold, finds unreachable environments and frees them. An
  environment stays alive exactly as long as something reachable references it:
  the stack (conservative scan), a managed global, a traced field of another
  object, or a state struct rooted by the task table.
- Under `--runtime stub`: **never**. 32 bytes per environment, forever (§0.3).

There is **no reference counting** in AS to reason about — verified: `__retain`/
`__release` exist only in the JS-host bindings glue, and the collectors are
tracing (`itcms.ts`, `tcms.ts`). So any design that assumed "the env is freed when
its last reference drops" would be reasoning about a mechanism that does not
exist. This is worth stating because it is a very natural wrong assumption.

### 4.3 What happens if a closure outlives its scope

**It works, and that is the point of the design.** A returned closure holds its
environment alive through the normal trace chain:

```ts
export function counter(): () => i32 {
  let n: i32 = 0;
  return (): i32 => ++n;      // env allocated at scope entry; survives the return
}
```

The environment is a heap object; the returned `Function<T>` value holds `_env`;
the value is on the caller's stack or in a managed field; the collector traces it.
The enclosing frame returning is irrelevant because the environment never lived in
the frame.

This is also the **positive** memory control in §8: the env must be reclaimed once
the last reference to it is gone — which is observable under `incremental` and
demonstrably absent under `stub`.

### 4.4 Interaction with the frozen completion record and `BUFFER_POOL`

**None, and it should be none.** Restating §0.2 as a design constraint:

- **Environments never cross the host boundary.** `_env` is a guest address inside
  the guest heap; nothing in the ABI carries it, and nothing should. There is no
  new export, no new import, no new record field.
- **The 32-byte completion record is not touched.** Its payload words (`a` @ 16,
  `b` @ 20) remain, as v2 §6.2 assigns them, the async correlation channel. A
  closure completing a task does so through the ordinary runtime path, not through
  new record semantics.
- **`BUFFER_POOL` is not touched, and no slots are claimed from it** — because it
  has no slots to claim (§0.2). Stating it as a prohibition rather than a decision,
  since nothing about closures creates a reason to go near it.

### 4.5 The one place a closure's memory could still surprise you

The environment allocation happens at **scope entry** (§1.2), not at closure
creation. So a function whose *scope* declares a captured binding pays the
allocation even if the closure is never created on that path. For a hot function
that declares a captured binding and rarely makes the closure, that is a wasted
allocation.

This is the honest cost of choosing per-scope-instance environments (which
correctness requires, §1.2). The escape hatches, in order of preference: keep the
binding *uncaptured* where possible (a non-capturing arrow allocates nothing);
and, as a future optimization, **escape analysis** — if a closure provably does
not escape its scope, its environment can be a stack slot instead of a heap
object, eliminating the allocation entirely. Not in v1; listed so the cost is
known rather than discovered later.

---

## 5. Lowering

### 5.1 How a closure lowers to wasm

**Creation** (one site: where `compileFunctionExpression` materializes the value,
around `compiler.ts:7352` `let offset = this.ensureRuntimeFunction(instance);`):

1. If the function has no captures (§3.4) → today's path, unchanged: return the
   static, memoized `Function<T>` instance with `_env = 0`. **Zero allocation.**
2. If it has captures →
   a. allocate the **environment** (managed instance of the synthesized env class)
      — at scope entry for the scope in question, or per-iteration for a loop
      header (§1.3);
   b. populate it: for each captured binding, store the current value of the
      enclosing binding (which has itself been demoted into the environment — same
      slot, so this is a same-object store for outer-scope captures, and the
      iteration copy for loop headers);
   c. allocate a **heap** `Function<T>`-shaped instance (not the static one, since
      `_env` differs per closure instance);
   d. write `_index` = the entry function's table index, `_env` = the environment
      pointer.

Step (c) is a real design consequence worth naming: the static per-function
instance that `ensureRuntimeFunction` builds (`compiler.ts:2168-2174`) is memoized
per function and therefore cannot carry a per-instance environment. **Closure
values must be heap instances.** That is also what makes the trace chain work —
a heap instance is a recognized collector object, so its `__visit` actually runs
and `_env` is traced.

**Capture read/write** (the two sites that currently error):

- `compiler.ts:7562` (read) → walk `(depth, fieldIndex)` from the environment
  pointer and load. This replaces the error.
- `compiler.ts:5708` (assignment target) → same walk, then store.
- **The enclosing function's own accesses to a captured binding take the same
  path.** A captured binding is demoted: every access, inside or outside the
  closure, goes through the environment. That is what makes sharing work and is
  not an optimization opportunity to skip. (It *is* an optimization opportunity
  later: keep a wasm-local mirror inside a single function and sync at closure
  creation and call boundaries. Not v1 — it is where aliasing bugs live.)

**Call** — the closure call convention is:

```
call_indirect(tableIndex, env, arg0, arg1, …)
```

i.e. a capturing function's signature gains **one implicit leading `usize`
parameter**, the environment. Its body reads captures from it, so there is no
search, no per-call allocation, and no closure-vs-function special case at the
callee beyond the extra parameter. `this` in an arrow is captured like any binding
(§1.4), so no separate receiver plumbing is needed.

### 5.2 How it lowers under Backend A (state machines) and Backend B (WasmFX)

**The creation, capture, and call machinery in §5.1 is backend-independent** — it
is ordinary data movement and an ordinary indirect call, and neither backend
changes it. What differs is only what happens at an `await`:

| | Backend A (state machines) | Backend B (WasmFX) |
|---|---|---|
| An `await` becomes | a state transition + `return` to the scheduler | `suspend $tension_await` |
| Environment storage | guest heap, managed | guest heap, managed — **identical** |
| Environment reachability across suspension | state struct holds a managed env reference; the task table (a managed global) roots it | the continuation's stack holds it, **but that stack is not conservatively scanned** (§0.5), so it must *also* be rooted by the task/continuation table |
| Capture access | env walk `(depth, fieldIndex)` | env walk `(depth, fieldIndex)` — **identical** |
| Call convention | `(tableIndex, env, args…)` | **identical** |
| Lowered code | synthesized env class + entry function with implicit env param + resume function | same env class + entry function; no resume function, the continuation supplies the frames |

Two things follow that matter:

- The **environment layout, allocation policy, capture walk, and call ABI are all
  backend-neutral by construction.** They are solved in the front-end/resolved
  model (§2.1, §3.3), so neither backend owns them.
- The **rooting rule is also backend-neutral** (§0.5) — it looks like a Backend A
  artifact but Backend B needs it too, for the different reason that continuation
  stacks are not scanned. So it can be enforced unconditionally without baking in
  an assumption.

---

## 6. Type system

### 6.1 What type does an arrow/closure have

**A function type — the same type a function value has today. No new
`TypeKind`.**

The mechanism, verified:

- A function type is a **`Signature`** (`src/types.ts:934-1200`), created by
  `Signature.create(...)` and interned by `signature.toString()` in
  `program.uniqueSignatures` (`program.ts:484`).
- Its **value** type is obtained by `Type.getClassOrWrapper(program)`
  (`types.ts:301-323`), which for a signature resolves
  `program.resolver.resolveClass(program.functionPrototype, [type])` — i.e. the
  std `~lib/function/Function` prototype (`program.ts:539`) instantiated over the
  signature. So a function-typed value is `Function<T>` where `T` encodes the
  signature.

**Therefore a closure's type is `Function<T>`, exactly like a non-capturing
function value.** The difference between the two is a *representation* difference
(heap instance with `_env` set vs. static instance with `_env = 0`), and the type
system does not need to know about it. That is a good property: a closure is
assignable wherever a function is, with no new assignability rules, no new
`isAssignableTo` cases, and no new wrapper class.

Two consequences:

- **Do not subclass `Function<T>`.** It is `@final abstract`
  (`std/assembly/function.ts:3`). Recommendation: keep one representation for all
  function values and put the difference in `_env`. A distinct closure type would
  break assignability (a closure could not be passed where a function is expected)
  for no gain.
- **`this`-typed arrows.** An arrow capturing `this` has an enclosing `thisType`;
  for type-checking purposes the arrow's `thisType` must be the **enclosing**
  function's, not its own (§1.4). That is a resolver fix in
  `lookupThisExpression`, not a new type. `Signature` already carries
  `thisType: Type | null` (`types.ts`, the `Signature` constructor), so the
  machinery is present.

### 6.2 Does the type system need a new kind of type?

**No.** `TypeKind` (`types.ts:28-99`) is untouched. No new `TypeFlags`
(`types.ts:102-132`). The only type-system-adjacent work is:

1. the arrow `this` fix (§1.4, §6.1), and
2. synthesizing the **environment class** — one managed class per captured-scope
   shape, registered through the ordinary class machinery so its field offsets,
   `__visit`, and `__link` barriers are generated the normal way (§3.3).

Neither is a new *kind* of type.

One trap to record, carried over from v2 §2.4 and now with a second reason to
respect it: **do not encode closure-ness in the `Signature` string.** `Signature`
interning keys on `signature.toString()` (`types.ts:959-975`), so two functions
differing only in whether they capture would collide in the intern table. Capture
state lives in the side table (§2.1), keyed by the `Function` element — never in
the signature.

---

## 7. Interaction with async — the hard cases, concretely

### 7.1 A closure inside an async function, captures surviving suspension

```ts
async function run(): void {
  let ticks = 0;
  const bump = (): i32 => ++ticks;      // captures `ticks`
  await frameHandle();                  // ← suspends; the wasm frame is gone
  bump();                               // must see ticks == 1
}
```

What happens, step by step, under Backend A:

1. **Storage decision** (§0.4): `ticks` is captured → it lives in an environment.
   It is *not* lifted into the state struct.
2. **Environment allocation** at `run`'s scope entry; `ticks` lives at
   `env.field0`.
3. **`bump` creation**: heap `Function<T>` instance with `_env` = that environment.
4. **`await`**: the task suspends. The state struct holds `_env` as a **managed
   reference**; the state struct is rooted by the runtime's task table, which must
   be a **managed global** (`__visit_globals`). So the trace chain reaches
   `env.field0` while the frame is gone.
5. **Resume**: the state struct is re-entered; `bump`'s captured `_env` (or the
   state struct's copy) still points at the same environment, whose `field0` still
   reads `1`. The mutation is visible.

**The failure this design prevents:** if `ticks` had been lifted into the state
struct *and* copied into an environment, step 4's mutation through `bump` would
write the env while the resume read the struct — `ticks` would appear to reset, or
`bump()` would appear to do nothing. That is the bug the mission predicted, and the
single-storage rule is what removes it.

### 7.2 An async function inside a closure

```ts
const fetchAndStore = async (): i32 => {
  const v = await loadHandle();
  return v * 2;
};
```

Nothing new is required. The closure is an ordinary `Function<T>`; calling it
invokes the async function; the async function's own lowering is unchanged from
v2. Two details:

- The **implicit environment parameter is part of the async function's signature**,
  so the resume function must thread it through — a direct consequence of the call
  convention in §5.1, not a special case.
- **A task is not awaited inside a callback** (v2 §6.4): resuming happens in the
  guest's loop, after `wait` returns, never inside `onBatch`/`onEvent`. An async
  closure changes nothing about this — and per §9, "await in a callback" must
  remain a Backend A capability diagnostic, not a language rule.

### 7.3 What the runtime does across a suspend/resume

The runtime's obligations, all of which already exist in v2's design:

- The **task table** must be a managed global (so `__visit_globals` reaches it).
- The **state struct** must be managed with managed fields (v2 D5) — now also
  because it holds the environment reference.
- The scheduler's `runReady()` (v2 §6.3) resumes tasks **after** a callback has
  returned, never inside one.
- **Payload capture stays in dispatch** (v2 §6.5) — a completion's words are
  copied out of the transient ring slot during the callback, not at resume time.
  Closures do not change this and must not be used to defer it.

---

## 8. Test harness

### 8.1 Pass criteria — every closure shape

All of these must compile with the fork and produce the exact stated values,
running on Windows.

| # | Case | What it proves |
|---|---|---|
| 1 | **Function expression** capturing a local | the base case; `_env` is filled |
| 2 | **Arrow** capturing a local | arrows go through the same path |
| 3 | **Method reference** used as a value | `MethodDeclaration extends FunctionDeclaration`; a bound method value keeps its receiver |
| 4 | **Closure capturing mutable state** | two closures sharing one binding see each other's writes (`inc`/`get` from §1.2) — this is the shared-environment test the per-closure design would fail |
| 5 | **Closure in a loop** | `for (let i…){ fns.push(() => i) }` yields `0,1,2` — the per-iteration requirement (§1.3) |
| 6 | **Closure across an async suspend point** | §7.1: a capture mutated before `await` is visible after resume |
| 7 | **Environment outliving its frame** | §4.3: the returned counter increments across calls |
| 8 | **Environment reclaimed** | under `incremental`, an unreachable environment is collected — the leak check. (Not testable as stated under `stub`; see 8.3) |
| 9 | **Arrow `this`** | the arrow sees the enclosing method's `this` (§1.4) |
| 10 | **Transitive capture** | a binding captured two levels deep resolves through the env chain (§3.1) |
| 11 | **Non-capturing value allocates nothing** | `arr.map(x => x * 2)` — the optimization from §3.4, verified not to regress |

Cases 1–3 are the shapes; 4–6 are the ones that break if the design is casual;
7–8 are the memory model; 9–11 guard semantics and cost.

### 8.2 Negative controls

**NC1 — capture of an uninitialized binding.** The §1.5 case: a captured `let`
declared, captured, then read *before assignment*, from inside the closure. Asserts
the **defined** error (the static diagnostic first, then the runtime TDZ guard on
the residual case) — and specifically asserts **not** a silent zero.

**NC2 — use of `this` in a regular function expression vs an arrow.** A bare
`function` expression referencing `this` must **fail** (it has its own dynamic
`this` with no receiver — the existing `This_cannot_be_referenced` path), while
the arrow in the same position **succeeds** and sees the enclosing `this`. This is
the control that keeps §1.4 honest, and it is symmetric: asserting only the success
case would not prove the distinction exists.

**NC3 — the "call after the arena sweep" control, honestly reformulated.**
The mission asks for a negative control calling a closure after the arena sweeps.
**There is no arena sweep** (§0.2), so that control cannot be written as stated. The
meaningful pair, which is what I will implement:

- **NC3a (nothing is wrongly freed):** a closure held across a suspension point,
  and across an epoch boundary, is callable afterwards and its environment is
  intact. Asserts the env is *not* reclaimed while reachable — the failure mode
  the conservative-scan gap (§0.5) would cause.
- **NC3b (nothing is wrongly retained):** an environment whose last reference is
  dropped **is** reclaimed under `incremental` (the §8.1 case 8 leak check, as a
  control rather than a criterion).

`NC3b` is explicitly **not runnable under `--runtime stub`**, and that is the
point: it is the control that would have caught the §0.3 blocker.

### 8.3 Platform: Windows

Same constraints as v2 §8.4, and the same answer:

- The guest builds with the fork's `asc`; the build runs **out-of-tree** in
  `build/assemblyscript/` so nothing writes into `third_party/` (v2 §0.1).
- Closure-only cases (1–5, 7, 9–11) are **pure guest logic** and need **no host
  changes at all** — they run under the existing guest fixture harness
  (`tension-framework/tests/`, `guest-*.ts` + `run.sh`), emitting a transcript.
- Case 6 (closure across a suspend point) and NC3a need the host to deliver an
  event from a thread, so they reuse **v2's D8 harness request**
  (`tension-core/tests/async_await.rs`). This plan adds **no additional
  tension-core request** — it inherits exactly one, already on the table.

That contrast is worth noting explicitly: unlike v2, **this plan needs no
test-only code in `tension-core` of its own.** The one host-side test it depends on
is the one v2 already asked for. If D8 in v2 was not approved, case 6 and NC3a are
the only casualties; cases 1–5 and 7–11 still run.

---

## 9. Backend B compatibility check

### 9.1 Does the closure design support both backends, or does it bake in state machines?

**It supports both, and the reason is structural rather than a promise.**

The things a closure needs are: (a) an environment object with a fixed layout,
(b) an allocation policy, (c) a way to reach a captured binding from inside the
closure, and (d) a call convention. Under both backends:

| Closure concern | Where it is solved | Backend-specific? |
|---|---|---|
| Environment layout | synthesized managed class (§3.3) | No — ordinary class machinery |
| Allocation policy | scope entry / per iteration (§1.2, §1.3) | No — a front-end decision |
| Capture reach | resolved `(depth, fieldIndex)` walk (§3.3) | No — just loads |
| Call convention | `(tableIndex, env, args…)` (§5.1) | No — ordinary `call_indirect` |
| Rooting across suspension | task/continuation table (§7.3) | No — required under both (§0.5) |
| What an `await` becomes | backend | **Yes — and it is the only thing** |

The single backend-specific element is the lowering of `await` itself, which is
v2's design and stays v2's design. Closures do not add a second one.

### 9.2 What is a Backend A capability diagnostic, and what is a language rule

Applying v2 §5.3's discipline:

**Language rules** (true of the language, enforced in the front-end, valid under
both backends):

- capture is by reference, one binding one home (§1.1)
- per-iteration environments for loop-header bindings (§1.3)
- arrow `this` is lexical; regular function `this` is not (§1.4)
- names resolve in declaration order; no hoisting (§1.5)
- the TDZ rule and its residual runtime guard (§1.5)
- environments never cross the host boundary (§4.4)

**Backend A capability diagnostics** (must NOT become language rules):

- **"`await` is illegal inside a callback"** — v2 §5.3 already flagged this as
  Backend A only, because under WasmFX `suspend` inside a callback is meaningful.
  It stays a Backend A diagnostic and must not be moved into the parser or
  resolver.
- **Any diagnostic of the form "you cannot do X across a suspension."** Nothing in
  the closure design creates one — deliberately, because per §0.4 captured
  bindings never enter the lifting problem, so there is no capture-across-suspend
  restriction to encode.

The one place I want to be careful and explicit: it would be very tempting to make
**"a closure capturing a binding that is live across an `await`"** a warning or an
error, on the theory that it is expensive or subtle. **That must not be a
language rule.** It is legal, it is the design's whole point (§7.1), and it works
under both backends.

### 9.3 Does the AST carry enough for both without redesign

**Yes — because it carries no lowering metadata at all** (§2.1). The AST holds
syntax; capture facts live in the resolved model keyed by `Function`; the
environment is a synthesized class; the call convention is standard. There is no
node field that a backend could write an assumption into, which is the structural
guarantee that a redesign is not needed.

**What would break Backend B**, listed so it can be avoided rather than discovered:

1. **Putting capture metadata on the AST node.** Two failure modes: stale after
   the clone at `compiler.ts:7223`, and it becomes a place for Backend A to write
   state-machine specifics.
2. **Requiring the environment to live in the state struct.** That would make the
   environment a state-machine artifact and force Backend B to re-derive it. The
   environment must be its own heap object under both backends (§0.4).
3. **Making the closure call convention carry state-machine data** (e.g. passing
   the state struct as the closure's implicit parameter instead of a plain
   environment pointer). The implicit parameter is the **environment**, nothing
   more.
4. **Promoting any Backend A restriction to a language error** (§9.2).
5. **Encoding capture-ness in the `Signature` string** — the interning collision
   in §6.2, which would also make closure-ness a *type* fact instead of a
   representation fact, and thus visible to both backends.

**One residual hazard that is Backend B's own, restated because it is a memory
concern and not a lowering one:** the conservative `visitStack` scan does not cover
a suspended continuation's fiber stack (§0.5). So under Backend B, everything a
suspended task needs must be reachable from a traced root — the same rule Backend
A needs. If that is honored, Backend B is a swap; if a future Backend B lets
`visitStack` be the only thing keeping an environment alive across a suspension,
environments will be collected out from under live continuations. That is a
runtime-discipline requirement, and it is why the rule is enforced in the runtime
(§7.3) rather than left to each backend.

---

## 10. Open decisions requiring architect approval

Each with a recommendation. None decided unilaterally.

**D1 — Guest runtime: `--runtime stub` vs `--runtime incremental`.** *(The
blocking one.)*
Closures cannot be memory-correct under `stub`: every environment allocation is
permanent, and `free` only works on the topmost block (§0.3). Measured 32
bytes/closure with zero reclamation vs. full reclamation under `incremental`.
**Recommend switching the guests to `--runtime incremental`.**

**The change is smaller than it first looks, and here is exactly where it lives
(verified):**

- `tension-framework/build.sh:149` generates
  `tension-framework/build/session.asconfig.json` with `"runtime": "stub"`
  hard-coded in the `asconfig_doc` dict. **The OGRE examples inherit the runtime
  from that generated config** — e.g.
  `examples/ogre/bouncing-ball/package.json:8`:
  `asc game.ts --config ../../../tension-framework/build/session.asconfig.json -o build/game.wasm`.
  So for every OGRE example, this is **one line in the generator**, and it
  propagates on the next `build.sh` run.
- The **non-OGRE examples pass it explicitly on the command line** —
  `examples/{ai,audio,io,log}/package.json:8` and `examples/res/package.json:8`
  each read `--runtime stub`. Those are **five separate one-word edits**.
- Two documentation/echo sites also mention it and should be updated for honesty:
  `build.sh:19` (the flags list) and `build.sh:174` (the printed flags).

So: **one generator line + five example lines + two comments.** It requires no
host change, no shadow stack, and no ABI change; write barriers are already
emitted identically in both runtimes.

*Named cost:* ~4.7 KB fixed code size (measured 932 B → 5,620 B on a trivial
program) plus per-allocation and incremental-collection overhead. *Alternatives if
the size cost is unacceptable:* (i) keep `stub` and ship closures with a
documented, quantified leak — not recommended, it is the footgun from §0.3; (ii) a
third runtime variant (the fork could add an allocator-free-list-only runtime:
reuse freed env blocks without a full collector — bounded memory, no code-size
blowup, but it leaks anything that is not freed explicitly and cannot handle
reference cycles, so closures that capture each other still leak). **I would want
the architect's judgment on whether (ii) is worth prototyping before accepting
(i)'s cost.**

**D2 — Environment granularity and the chaining scheme.**
**Recommend one environment per scope instance, with a parent link, and
per-iteration allocation for loop-header bindings** (§1.2, §1.3). The alternatives
(per-closure environments) break shared mutation; a flat env per closure breaks
transitive capture. Not really a close call, but it is a structural decision that
is expensive to change later, so it is recorded.

**D3 — TDZ for captured bindings.**
**Recommend (a)+(b) from §1.5**: static rejection using AS's existing flow
definite-assignment analysis, plus an initialization flag per captured
`let`/`const` slot checked on read so the residual case is a defined error.
*Cost:* one word per captured mutable slot and a branch per captured read.
**Recommend against** silently reading the zero value — it is the plan lying about
what it does. The alternative if the architect wants zero runtime cost is
**static-only rejection (a) with a documented gap**, which rejects some legal TS
rather than accepting a silent hole. That trade is the architect's to make.

**D4 — Hoisting: not in this plan.**
**Recommend explicitly scoping hoisting out** (§1.5) and tracking it as its own
piece of "be TypeScript-shaped" work. It is orthogonal to closures, it requires a
resolver pre-pass, and adding it *here* would bury a resolver rework inside a
closures plan. Flagging it because the mission's wording ("match TS semantics")
could be read as requiring it, and I want that read decided rather than assumed.

**D5 — Does a capturing function's implicit environment parameter change any
existing ABI?**
It adds a leading `usize` to the wasm signature of **capturing functions only**,
which are exactly the functions that cannot be compiled today (they are errors).
Non-capturing functions are unchanged. So no existing signature, no export, and no
host-visible ABI is affected. **Recommend confirming this explicitly**, since it is
the kind of statement that is easy to accept casually and expensive to discover
otherwise.

**D6 — `CommonFlags.Closure = 1 << 29` (`common.ts:79`), currently dead.**
**Recommend** either using it as the "this function captures" bit or deleting it,
and recording which. It is not load-bearing (§2.1 puts capture in the resolved
model), so it is housekeeping — but a dead flag named `Closure` next to a feature
called closures will mislead the next reader.

**D7 — Diagnostic cleanup.**
The capture error currently emits a **spurious companion** `TS2454: Variable 'x'
is used before being assigned` alongside `AS100: Not implemented: Closures`
(measured, §0.1). **Recommend** that supporting capture suppresses the companion,
and that the two `declaredByFlow` sites gain real, specific diagnostics for the
cases that remain errors (transitive-capture-through-a-non-capturing-function, if
any survive).

**D8 — Does the fork take an `--runtime` default, or per-example flags?**
Related to D1 but distinct: whether `incremental` becomes the fork's default (and
`stub` the opt-out), or stays an explicit per-example flag. **Recommend** making it
the fork's default for Tension guests, because the failure mode of forgetting the
flag is silent unbounded growth (§0.3), which is the worst kind of default.

**D9 — Escape analysis / stack allocation of environments.**
**Recommend deferring** (§4.5). Noting it here because it is the answer to "will
this be slow", and the honest v1 answer is "capturing closures allocate; we accept
that."

---

## 11. Fork model and commits

**Detached fork. Upstream is reference only. No compatibility patches.**
Restating v2 §0 exactly, since nothing has changed: `origin` =
`git@github.com:Yabgu/TensionScript.git`, `upstream` = fetch-only with its push URL
disabled, initial commit `b6bda05c`. We are not obligated to cherry-pick and will
not carry patches whose only purpose is mergeability.

**Pure additions (new files):**

- `src/passes/closure.ts` — capture analysis (§3.2).
- Environment-class synthesis helper (may live in the same file).
- `tests/parser/closure_*.ts.fixture.ts`, `tests/compiler/closure_*.ts` +
  generated `.wat`/`.js`/`.d.ts` fixtures.
- `tension-framework/tests/guest-closures.ts` (+ the case-6 fixture).

**Core files modified** — and this is the honest comparison the mission asks for:
**closures are more core-invasive than async.**

| File | Nature of edit | Why it cannot be additive |
|---|---|---|
| `src/compiler.ts` | The two capture sites (`:5708`, `:7562`); closure creation at `ensureRuntimeFunction`/`compileFunctionExpression` (`:2154`, `:7352`); the `This`-in-arrow path; calling the analysis pass | These **are** the feature. The two sites are where capture is decided today. |
| `src/resolver.ts` | `lookupThisExpression` for arrows — lexical `this` (§1.4); arrow `thisType` (§6.1) | `this` in an arrow is resolved here; no other layer can fix it. |
| `src/program.ts` | Capture side table keyed by `Function`; `declaredByFlow` becomes a query; env class registration | The resolved model lives here. |
| `src/ast.ts` | **Nothing required.** `arrowKind` already exists; no new node (§2.1) | — |
| `src/tokenizer.ts` | **Nothing.** | — |
| `src/extra/ast.ts` | **Nothing** — no new node means no serializer case (unlike v2 §0.2, which needed one for `AwaitExpression`) | — |
| `std/assembly/function.ts` | **Nothing** — `_env` is already there and already traced (§0.1) | — |
| `std/assembly/rt/**` | **Nothing** — the fix is a build flag, not new runtime code (D1) | — |
| `tension-framework/**` | The `--runtime` flag in the build config (D1/D8); test fixtures | Build configuration, not compiler work |

**The striking asymmetry, stated because it shapes the work:** async needed new
AST nodes and a serializer case but only one resolver case and one compiler case;
closures need **zero** AST changes but edits across `compiler.ts`, `resolver.ts`,
and `program.ts`, plus a new analysis pass. The mission's expectation — that
closures are the bigger feature in compiler surface area — **is correct**, and the
AST is the one layer that needs nothing, because upstream already built the AST
and the value representation for first-class functions (#1384) and stopped exactly
where capture analysis would have begun.

**No `parser.ts` change is required by this plan at all.** v2 needed it for
`async`/`await` keywords (v2 §2.2/§5, its D-M3); closures need nothing from the
parser, because arrow functions, function expressions, and `this` are all already
parsed. That is worth stating plainly so it is not assumed otherwise.

---

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Closures ship on `--runtime stub` and leak** | **Critical** | D1. The measured 32 B/closure with zero reclamation, and the ~131-second figure at 100 closures/frame, are the argument. The fix is one line in `tension-framework/build.sh:149` plus five explicit example flags. Do not ship the compiler work without deciding D1. |
| Transitive capture propagation (a binding captured through an intervening function) is analysed incompletely | High | Dedicated test case (§8.1 case 10); analysis resolves identifiers via the *same* `lookupIdentifier` path as codegen, so the two cannot disagree |
| Per-iteration environments missed for loop headers | High | §1.3 states it as a requirement, not an optimization; §8.1 case 5 is exactly `0,1,2` |
| A captured binding also gets lifted into the state struct (double home) | High | §0.4's single-storage rule; §8.1 case 6 fails if it happens (shared mutation across a suspend) |
| Environment reference not rooted across suspension → collected while live | High | §7.3: task table a managed global, state struct managed with managed fields; NC3a asserts it. And this is the same hazard Backend B has for its own reason (§0.5) |
| Performance regression: every access to a captured binding becomes a memory walk | Medium | Accepted for v1; §4.5 and D9 note the escape-analysis and local-mirror optimizations. Non-capturing closures (the common `map` case) allocate nothing (§3.4) and are unaffected |
| Arrow `this` fix changes behaviour for existing code that relied on the (wrong) non-lexical binding | Medium | Such code is arguably already broken — it resolves `this` to the arrow's own type and fails with `TS2339` in most uses (§0.1). Verify against existing examples before landing |
| TDZ residual hole reads a zero value silently | Medium | D3 — the explicit trade, with the silent option recommended against |
| Switching to `incremental` changes timing/behaviour of existing examples | Medium | It adds cost and collection pauses; measure on the existing examples before making it the default (D8) |
| `@final` on `Function<T>` blocks a future distinct closure type | Low | Deliberate — one representation for all function values (§6.1); if a distinct type is ever needed, that is the time to revisit `@final` |
| Dead `CommonFlags.Closure` bit misleads future readers | Low | D6 |

---

## 13. What happens on approval (nothing before)

Nothing until the architect reviews this document. On approval, the milestones
run in this order:

- **C0** — D1 decided (the runtime), because everything downstream's test results
  depend on it.
- **C1** — capture analysis + resolved-model side table + environment class
  synthesis (`src/passes/closure.ts`, `src/program.ts`). Gate: analysis is
  inspectable for the §8.1 cases, with no codegen yet.
- **C2** — codegen: creation, capture read/write at the two sites, call
  convention, arrow `this`. Gate: cases 1–5 and 7, 9–11 pass.
- **C3** — negative controls: NC1, NC2, NC3a, NC3b.
- **C4** — closure × async: case 6, on v2's D8 harness. Gate: mutation across a
  suspend is visible.
- **C5** — the game example that reads like TypeScript: closures and `await`
  together, which is the actual win condition.

Each is a separate dispatch after review; none is started by the plan author.
**No code has been written for this plan.** The Tension working tree contains the
staged submodule addition, `docs/async-await-plan.md`,
`docs/async-await-plan-v2.md`, and this document.
