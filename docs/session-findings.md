# Session findings

**Status:** record. Findings from framework phases, each with the measurement that
established it and the follow-up it leaves open.

**Why this file exists here.** The TensionScript repo keeps its own
`docs/session-findings.md` for compiler findings. This one is the tree's: things
learned about the guest SDK, the adapters and the record layouts, which are
Tension's to own. Created with the framework record-writer cleanup (2026-10-26).

---

## 2026-10-26 — Record writers: what the conversion actually was

### PR #26's claim is correct, and the report that contradicted it was pre-#26

`bones.ts` (`BoneBatch#write`, `:139-160`) and `motion.ts`
(`MotionBatch#set`, `:80-97`; `setPose`, `:112-129`) write their records with
`@unmanaged` struct field assignment, not raw stores. The conversion landed as
commit `62b4da1`, squash-merged in PR #26 as `31a6626`, which is an ancestor of
`origin/main`.

Measured, on `origin/main` at `f1a0a90`:

```
grep -n "store<" tension-framework/assembly/ogre/bones.ts   → no matches
grep -n "store<" tension-framework/assembly/ogre/motion.ts  → no matches
```

The report that showed fifteen raw stores in `bones.ts` was read from the primary
checkout while it sat on `build/optimize-level` at `1c663ed` — a branch that
predates #26. **A branch name is not a claim about content**; check the commit,
or grep for something the phase introduced, before trusting a line number.

### The residual, classified

Framework-wide, 47 raw `store<` sites remain. None of them is a record writer in
the bones/motion sense:

| Where | Count | Shape | Convertible now? |
|---|---|---|---|
| `ogre/skin.ts` | 6 | one 32-byte record, no declaration | no — needs the record declared |
| `solver.ts` | 25 | wire header + config slots | no — slot addresses, not a record |
| `physics.ts` | 16 | RK4 derivative slots, `dyPtr + (base + i) * 8` | no — needs a vector type |

The three offset-check `offsetof` counts, unchanged by this phase: **128
field-argument** (76 `runtime/wire.ts`, 52 `ogre/wire.ts`) and **2 no-argument**
(`examples/solver/collision/game.ts`, one a comment).

### Finding: `skin-record-undeclared`

`SkinMatrixBatch#set` (`skin.ts:86-92`) writes a 32-byte record by offset. There
is **no declaration anywhere** — no `SkinUpdate` in `assembly/`, none in
`tension-ogre/`, and no `offsetof` check (it could not have one, since there is
no type). `SKIN_SIZE = 32` is a bare constant (`ogre/wire.ts:746`).

Known from the stores: `@0` renderableId (u32), `@8` bytes (u32), `@12` flags
(bit 0 = matrices are model-space), `@16` and `@24` two reserved u64. Stride 32,
table capacity 64, matrix window 256 KiB.

**Unknown, and gating:** `@4` is written from `this.used`, a running byte offset
into the matrix window — but whether the adapter reads that word as an offset or
as a usage counter has not been checked. The field's name follows from the
answer, so declaring the record is a measurement against `tension-ogre`'s reader,
not a transcription of the writer. Declaring it wrong would be worse than leaving
it raw: the stores are at least honest about being offsets.

Order of work when it is picked up: read the adapter's consumer, decide the `@4`
semantics, declare the struct with that name, add its `offsetof` checks, convert
the stores, then `sizeof<SkinUpdate>()` for the stride.

### Finding: `state-vector-declarations`

`solver.ts` (25 sites) and `physics.ts` (16 sites) write into memory that is
**not a record**: the solver's wire header is a fixed field sequence, but the
config slots (`solver.ts:235-270`) and the RK4 derivatives
(`physics.ts:154-219`) are addressed as `base + <usize>(i) * 8` over a flattened
`f64` state vector.

Field assignment needs named fields; a state vector has indices whose meaning
depends on a `config.dim` the guest reads at runtime. Expressing it as a struct
would mean either a fixed dimension (contradicting the variable-dim contract) or
a type whose layout is decided per call. That is a design question, not a
mechanical conversion, and it is filed rather than forced.

### Finding: the accessor tax is gone — measured, not assumed

The reason the raw stores existed — that `changetype<T>(at).field = v` once paid
an accessor call — no longer holds at `-O3`. A probe writing four fields both
ways:

```
raw:      local.get $0 / i32.const 7 / i32.store
          local.get $0 / i32.const 9 / i32.store offset=4
field:    local.get $0 / i32.const 7 / i32.store
          local.get $0 / i32.const 9 / i32.store offset=4
```

The compiler **deduplicated the two functions into one symbol** — the strongest
form of the equality: not merely equal output, but one function. Any old comment
arguing for raw stores on performance grounds is obsolete.

Consequence for this phase: deriving the stride from the declaration
(`sizeof<BoneUpdate>()` in place of `BONE_SIZE`) is free. Measured on
`tension-framework`'s `index.wasm` at `-O3`: `ff42c221527bacfaf3215d6610402586`,
65 628 bytes, identical before and after — and the **wat** identical too, so
`sizeof<T>()` folds to the same constant rather than merely costing the same
bytes.

### Finding: strengthening a live check cannot be byte-identical

`ogre/wire.ts` binds the records' sizes to their declarations:

```ts
if (offsetof<MotionUpdate>("pad2") + 4 != 64) return "MotionUpdate size";
if (offsetof<BoneUpdate>("pad2") + 4 != BONE_SIZE) return "BoneUpdate size";
```

Both forms catch a field moved *before* `pad2` and miss one appended *after* it —
the record grows, the constant still matches the offset arithmetic, and the table
stride silently disagrees with the slot size. Replacing the constant with
`sizeof<T>()` closes that:

```ts
if (offsetof<X>("pad2") + sizeof<f32>() != sizeof<X>()) return "X size";
```

Probed with a field appended after `pad2`: the old form returns **true** (no
problem seen), the new form returns **false**. The improvement is real.

**It is not free, and it cannot be.** These check functions are live wasm
exports, so changing their bodies necessarily changes the module: measured
65 627 bytes, `e1427710762d9c22464711dfbf8277f0`, one byte under the baseline.
The diff is confined to the three offset-check functions and a
`~lib/string/String.__eq` the compiler no longer needs; **all three record
writers stay byte-identical**, and every fixture (framework suite, four OGRE
fixtures, the three drift cells) passes with it.

So a byte-identity gate and a strengthened live check are mutually exclusive.
The strengthening is held back for a decision rather than slipped in under a
"no output change" claim that would be false. Whenever it lands, the honest
statement is: *one byte, confined to the offset-check functions, no behaviour
change on any input that has no appended field.*

---

## unmanaged-struct-array-views (filed)

`T[N]` of **records** is a missing capability, and it is the type-system gap
behind the framework's manual index arithmetic.

Current state, measured:

- **`T[N]` of scalars works.** `u32[8]`, `f32[6]` — shipped in 0.8.0, used for
  the input records.
- **`T[N]` of records does not compose.** A `BoneUpdate[256]` field would be
  `256 * 4` bytes (one 4-byte pointer per element), not `256 * 64`, and element
  access does not index through to a record. Declared, it is unusable.
- **Consequence:** `base + index * sizeof<BoneUpdate>()` is a workaround for a
  missing type. It is correct — the offsets come from the declaration and the
  size-binding check guards the stride — but there is no way to write "a
  contiguous array of N inline records, indexable as `arr[i].field`".

What would be needed: an array view over contiguous records — N × 64-byte
records, `arr[i].field` compiling to `load(base + i * 64 + fieldOffset)`.

Design questions for a future scoping:

- Does `T[N]` of an `@unmanaged` struct mean N **inline records** (C semantics)
  or N **pointers** (the current default)? The current answer is pointers, which
  is why the record case does not compose.
- Does `changetype<T[N]>(ptr)` produce the inline view, or is the view a distinct
  type (C++ `[N]T`, Zig `*[N]T`)?
- Value semantics or pointer semantics for iteration?
- Interaction with `@inline struct`: a `@inline T[N]` field would need inline
  storage inside a record — the deferred inline-nesting case.
- The drift check: an inline array field's `offsetof` is checked today, but the
  element-access codegen path is new and needs its own fixtures.

Scope: substantial — a new array-of-records layout rule, a new element-access
codegen path, and the pointer-vs-inline decision. Its own scoping, not a
refactor.

Not blocking 0.10.0 adoption or the release. The bone table's manual arithmetic
is correct, just verbose.

## recordAt-helper-does-not-inline (filed)

Attempting to extract the slot arithmetic into a helper —

```ts
private recordAt(index: u32): MotionUpdate {
  return changetype<MotionUpdate>(this.base + <usize>index * sizeof<MotionUpdate>());
}
```

— **is not free, and `@inline` does not rescue it.** Measured on
`guest-motion.wasm`:

| Form | `MotionBatch#set` | guest wasm |
|---|---|---|
| direct `changetype` at the call site | 2069 B | 172935 B |
| helper | 2693 B | larger |
| helper + `@inline` | — | 172942 B |

`MotionBatch#set` grows by **624 bytes**, and the wat shows why: the function
gains a `block $folding-inner0` and a `stack_pointer ± 4` path. Returning an
`@unmanaged struct` produces a **reference value**, and a reference return needs
a shadow-stack temporary even after the body is inlined — so the stack-frame
bookkeeping appears where the direct `changetype` had none.

This is exactly the accessor tax the field-assignment conversion was supposed to
be free of, coming back through a different door. The direct form stays.

The general rule it leaves: **at `-O3`, `changetype<T>(expr).field = v` is free;
wrapping that `changetype` in a function that returns `T` is not.** The free part
is the field store's offset resolution, not the value's lifetime.
