# Interop-arrays phase — scoping

**Status:** scoping only. No source changed, no plan, no code.
**Base:** TensionScript `next` @ `50cceb36`, package `0.7.1`; Tension `main`
working tree.
**Siblings:** `docs/interop-scope.md`, `docs/interop-scope-addendum.md`,
`docs/interop-scope-addendum-2.md` (all three unmodified), and
`docs/async-complete.md` (unmodified).

**Method.** Compile-output claims use the published
`@yabgu_gm/tensionscript@0.7.1`. Runtime claims use the real host,
`tension-core/target/debug/tension-core` (debug profile, no session, no
adapter), never `--runtime stub` and never Node. Fixtures live in
`/tmp/interop-probe/`; none is in the repo.

**The answer up front.** The capability does **not** exist under another name.
`StaticArray<T>` exists but is a runtime-length heap object, and as a field it is
a 4-byte reference (measured: outer record 12 bytes, not 24). `StaticArray<T, N>`
is a parse error. `f32[4]` is a parse error in the type grammar. So the gap is
real — but it is a **declaration** gap: the *runtime* can already address an
inline float block, and the tree already does so by hand.

**The recommendation** (§9) is **no for this phase as framed, and not because
the gap is imaginary**: the tree's demonstrated need is two C records
(`keys_held[8]`, `axes[6]`), both currently served exactly by raw offsets; the
fix is a grammar change, which is a compiler release; and the first thing that
change would buy is expressibility, not capability. The record of what the
change must do is in §9.

---

## 1. The parse error — where, what kind, which pass

### Reproduced

```
$ tensionscript arr1.ts        # @unmanaged class A { data: f32[4]; }
ERROR TS1005: ']' expected.
 1 │ @unmanaged class A { data: f32[4]; }
   │                               ~
  └─ in arr1.ts(1,31)
FAILURE 1 parse error(s)
```

The reported position is column 31 — the `[` (measured: `[` is at index 31 of
the line, `4` at 32, `]` at 33). Padded to `f32[   4444   ]` the position is
still column 31, so the diagnostic names the opening bracket, not the contents:
the parser consumed `[`, found something other than `]`, and reports there.

### The site

`src/parser.ts:537` is `parseType` (`:512` is `parseTypeName`). Its identifier branch parses a name, then a
`while` loop at **`src/parser.ts:739-752`** handles brackets:

```ts
// ... [][]
while (tn.skip(Token.OpenBracket)) {
  let bracketStart = tn.tokenPos;
  if (!tn.skip(Token.CloseBracket)) {
    if (!suppressErrors) {
      this.error(
        DiagnosticCode._0_expected,
        tn.range(), "]"
      );
    }
    return null;
  }
  ...
  type = Node.createNamedType(
    Node.createSimpleTypeName("Array", bracketRange),
    [ type ], ...
  );
```

The grammar has exactly one bracket type form — **`T[]` (empty brackets), which
means `Array<T>`** — and it refuses anything between the brackets: after the
`[` it requires `]` immediately, so any content is a syntax error.

### What kind of error

`DiagnosticCode._0_expected` is **1005** (`dist/assemblyscript.generated.d.ts:449`),
so this is **TS1005, a genuine syntax error** — not an AS100-style
`Not_implemented_0` refusal. The distinction matters for §6: the fix is
**adding grammar**, not turning on a declared-but-unbuilt feature.

### Which pass

**Parse.** The CLI reports `FAILURE 1 parse error(s)` and names `arr1.ts(1,31)`;
the error is raised inside `parseType`, which runs before resolve and before
codegen. Nothing reaches the resolver.

### The other forms, measured

| form | result | why |
|---|---|---|
| `f32[4]` | `TS1005 ']' expected` | `parseType`'s `T[]` loop |
| `i32[]` | compiles → `Array<i32>` | the one bracket form that exists (`parser.ts:739-752`) |
| `StaticArray<f32, 4>` | `TS1110 Type expected` at the `4` | arity-2 does not exist; the class is arity-1 (`std/assembly/staticarray.ts:13`) |
| `[f32, f32, f32, f32]` (tuple type) | `TS1110 Type expected` | behind `Feature.MultiValue` (`parser.ts:613`), and the CLI refuses the feature: `Feature 'multiValue' is unknown` |
| `f32[]` as a **field** | compiles; `offsetof` = 12 for `{i32, Array<f32>, i32}` — a 4-byte reference | measured; `Array<T>` is a managed class |

---

## 2. The reframe question — does `StaticArray` solve it?

**No. Measured, four ways.**

### 2.1 It exists, and it is runtime-length

`std/assembly/staticarray.ts:13`:

```ts
@final
export class StaticArray<T> {
  [key: number]: T;
  ...
  constructor(length: i32) { ... }
```

One type parameter. The length is a constructor argument and is read back from
the allocation header (`staticarray.ts:60-62`):

```ts
get length(): i32 {
  return changetype<OBJECT>(changetype<usize>(this) - TOTAL_OVERHEAD).rtSize >>> alignof<T>();
}
```

There is no `N`. `StaticArray<f32, 4>` is `TS1110`, measured.

### 2.2 As a field, it is a reference — not inline

```ts
@unmanaged class WithSA { a: i32; data: StaticArray<f32> | null; b: i32 }
```

Compiled and measured (published 0.7.1):

| expression | value |
|---|---|
| `offsetof<WithSA>()` | **12** — not 24 |
| `offsetof<WithSA>("data")` | **4** |
| `offsetof<WithSA>("b")` | **8** |
| `offsetof<StaticArray<f32>>()` | **0** |
| `sizeof<StaticArray<f32>>()` | 4 |

The field is four bytes. `i32 + StaticArray<f32> + i32` is 12 bytes where the C
shape (`int; float data[4]; int`) would be 24. So a `StaticArray` field cannot
describe `struct { f32 m[16]; }`.

### 2.3 Its own layout has no header fields — and that cuts both ways

`offsetof<StaticArray<f32>>() = 0` is real: the class declares no fields, its
data starts at offset 0 of the object pointer, and the element operators are
pointer arithmetic (`staticarray.ts:77-86`):

```ts
@operator("[]") private __get(index: i32): T {
  if (<u32>index >= <u32>this.length) throw new RangeError(E_INDEXOUTOFRANGE);
  let value = load<T>(changetype<usize>(this) + (<usize>index << alignof<T>()));
  ...
```

So a **view** over a raw block reads and writes correctly — measured on the real
host:

```
view = changetype<StaticArray<f32>>(rec)
view[0] = 1.5, view[3] = 4.5          ← read correct raw floats
view[1] = 9.75 → raw +4 = 9.75        ← write lands at the right offset
```

…but the length is the **allocator's** block size, not the array's:

| block | `changetype<StaticArray<f32>>(block).length` |
|---|---|
| `heap.alloc(16)` | **7** (a 4-element array should be 4) |
| `heap.alloc(64)` | **19** (16 elements would be 16) |
| `new StaticArray<f32>(4)` | **4** — correct, because it is a real allocation |

The bounds check in `__get` therefore consults a number that has nothing to do
with the array. The unchecked operator that would bypass it is std-internal only
— `v{5}` is `TS1012 Unexpected token` when a guest writes it.

**So the view trick is unsound as a general mechanism**, even though it happens
to work when the allocator's rounded block size exceeds the index. It is not a
substitute for a declaration form, and it should not be recommended as one.

### 2.4 Can it be a field at all?

Yes, syntactically — and the nullability makes no difference to the layout. All
three spellings compile and measure 12 bytes:

| field declaration | `offsetof<W>()` |
|---|---|
| `data: StaticArray<f32> \| null = null` | 12 |
| `data: StaticArray<f32> = new StaticArray<f32>(4)` | 12 |
| `data: StaticArray<f32>` (no initializer) | 12 |

It is simply a reference, and the pointed-to `StaticArray` must itself be a real
allocation (`new StaticArray<f32>(4)`), which is a managed object with a header.
A record holding one is not self-contained and cannot be copied to the host as
bytes.

### Verdict for item 2

**The capability gap is real.** `StaticArray` is a runtime-length heap object
used by reference; it cannot express a C inline array. No other form exists
(`T[]` is `Array<T>`; tuple types are off; arity-2 is a parse error).

**But the gap is in the declaration grammar, not in the runtime.** The runtime
addresses an inline float block correctly today, by pointer arithmetic, which is
what the tree does. That fact shapes the recommendation (§9) rather than
settling it.

---

## 3. What the tree needs — the C shapes

### 3.1 The demonstrated need: two C records with inline arrays

Both are in the input capability's wire, and both are read today by hand-coded
offsets because no declaration form exists.

| C record | array field | offset | size | header citation | guest reader |
|---|---|---|---|---|---|
| `input_state` (96 B) | `keys_held[8]` u32 | 16 | 32 | `tension-input/include/tension_input.h:142` | `tension-framework/assembly/input.ts:208` — `load<u32>(this.keysAt + (scancode>>5)*4)` |
| `input_pad` (48 B) | `axes[6]` f32 | 16 | 24 | `tension-input/include/tension_input.h:175` | `tension-framework/assembly/input.ts:218` — `load<f32>(padPtr + PAD_AXES_OFFSET + axis*4)` |

Neither has an `@unmanaged` declaration. `input.ts:73-91` is a block of offset
constants, and `InputState` (`input.ts:158`) is a **managed mirror** whose
`read` decodes the scalars and keeps `keysAt` (`:172`, `:189`) for the in-place
array read. That is the tree's workaround, stated in its own comment at
`input.ts:71-72`: *"a guest reads by number, like every other record in this
runtime."*

### 3.2 The manual expansions in the 33 `@unmanaged` declarations

| declaration | what is expanded | citation | conceptually an array? |
|---|---|---|---|
| `Mat4f` | 16 × `f32` (`m00`..`m33`) | `ogre/wire.ts:81-86` | yes — `f32[16]` (a 4×4 flattened) |
| `Material` | 8 slots × 4 × `u32` (`slot0Resource`..`slot7Uv`) | `ogre/wire.ts:305-312` | partly — `struct { resource, sampler, flags, uv } slot[8]` |
| `ArenaControl` | 24 × `u64` reserved (`reserved0`..`reserved23`) | `runtime/wire.ts:121-154` | yes — padding-by-array, `u64[24]` |
| `FrameState` | 6 × `u64` reserved | `runtime/wire.ts:246-251` | yes, `u64[6]` |
| `Callbacks` | 6 × `u64` reserved | `runtime/wire.ts:274-279` | yes, `u64[6]` |
| `SessionInfo` | 4 × `u64` reserved | `runtime/wire.ts:188-191` | yes, `u64[4]` |
| `Job` | `reserved`, `reserved2` | `ogre/wire.ts:521-522` | two words, not an array |
| `CameraRecord` | `reserved`, `reserved2` | `ogre/wire.ts:252-253` | two words |

Nine further `reservedN` runs exist across `ogre/wire.ts` (counted: 9), all
one- or two-word.

### 3.3 Which shapes the tree actually needs

| shape | needed? | citation |
|---|---|---|
| 1-D scalar, fixed N (`f32[4]`, `u32[8]`) | **yes** | `keys_held[8]` (`tension_input.h:142`), `axes[6]` (`:175`), `Mat4f` (`ogre/wire.ts:81`), pad runs |
| 2-D (`f32[4][4]`) | **no** — speculative | `Mat4f` is a 4×4 matrix but the wire is 16 flat `f32` (`ogre/wire.ts:81-86`); no guest-visible header contains `][` (grep over all five headers → 0) |
| array of structs (`Point pts[4]`) | **no** — speculative | no header declares a struct-typed array member (grep → 0); the 33 declarations embed no wire type (prior pass, category c = 0) |

### 3.4 What the host does with these shapes — split by capability

**The OGRE side is scalar on both ends.**

- `SceneNodeRecord`, `CameraRecord`, `LightRecord`, `MaterialRecord`,
  `RenderableRecord`, `MotionUpdate` — `tension-ogre/src/scene.h:103-145`, all
  named scalars, no array members.
- The OGRE math types are constructed from scalars:
  `Ogre::Quaternion(update.rw, update.rx, update.ry, update.rz)`
  (`tension-ogre/src/backend_ogre.cpp:1927`).
- `MaterialRecord` declares **one** slot (`slot0_*`, `scene.h:128`) where the
  guest declares eight (`ogre/wire.ts:305-312`) — a separate latent drift, noted
  here because it bears on `Material`, not acted on.

**The input side is a C struct with arrays, and this is the sharpest evidence
for the phase.** The host declares the records as real array members:

```c
struct StateRecord {                       // tension-input/src/input.h:41
    uint32_t version; uint32_t flags;
    uint32_t pads_present; uint32_t mouse_buttons;
    uint32_t keys_held[8]; /* 256 scancodes */   // :46
    int32_t mouse_dx; ...
};
struct PadRecord {
    uint32_t version; uint32_t flags;
    uint32_t buttons; uint32_t reserved0;
    float axes[6];                                // :69
    uint64_t reserved1;
};
```

and it fills them as arrays — `std::memcpy(out->keys_held, keys_held_,
sizeof(keys_held_))` (`input.cpp:651`), and element-wise for the axes
(`record.axes[a] = …`, `input.cpp:606`). The guest has no declaration that can
describe either field, so it addresses them as `base + index * 4`
(`input.ts:208`, `:218`).

**Consequence for the phase:** the need is real, narrow, and asymmetric — the
host has the C shape (`input.h:46`, `:69`, with `static_assert(sizeof(StateRecord) ==
TENSION_INPUT_STATE_SIZE)` at `input.h:58`), the guest cannot declare it, and the workaround is
arithmetic. Nothing in the tree is blocked, because the arithmetic is exact and
the bounds are compile-time constants from the header.

---

## 4. The named copy's interaction

### 4.1 The property, measured

The struct phase's named copy is `memory.copy(dst, src, offsetof<T>())`. For a
flat record the property holds today — measured on the real host with a
`Mat4f`-shaped record (16 `f32`, the `ogre/wire.ts:81-86` declaration):

```
offsetof<Mat4f> = 64
m33 at offsetof<Mat4f>("m33") = 60
field at +60 = 15.5
after memory.copy(64 bytes): m00 = 0.5, m33 = 15.5
memory.compare(dst, src, 64) = 0
```

So: a record whose fields are contiguous is copied byte-exactly by
`memory.copy` of `offsetof` bytes. **An inline array would be the same bytes** —
N elements at `i * alignof<T>()` — because that is exactly what the element
operator does (§2.3). The property is therefore established for any inline array
the grammar might allow, **conditionally on the layout rule** in §4.2.

### 4.2 What `offsetof` must return, if the form existed

Two rules would have to hold, and neither is measurable today because the form
does not parse:

1. a field `data: T[N]` contributes `N * sizeof(T)` — the element size, not the
   reference — to the record's layout, and the record's next field is aligned to
   `alignof(T[N])` (which is `alignof(T)`, or the element alignment rounded to
   the field's requirement);
2. `offsetof<Outer>("data")` is the array's first element, and `offsetof<Outer>()`
   grows by the array's whole extent.

The C records in §3.1 confirm the rule against real bytes: `keys_held[8]` is 32
bytes at 16, and the next field (`mouse_dx`) is at 48 (`tension_input.h:142`,
`:144`); `axes[6]` is 24 bytes at 16, next field reserved at 40 (`:175`, `:176`).
Both are `N * element size`, contiguous, with no padding inserted inside the
array.

### 4.3 The three-way fixture for the struct phase

**It needs no array cell.** That fixture's three cells are about `sizeof`,
`offsetof` and the copy over a mixed-scalar record (`docs/interop-scope.md`
§6.4); an array cell would be a cell for *this* phase's fixture, and adding one
to that fixture would couple the two phases' acceptance. **Reported, not
proposed** — that fixture is not to be changed.

---

## 5. Generic size and nesting — in or out

| edge | in or out | citation that decides it |
|---|---|---|
| `f32[N]` with `N` a generic parameter | **out** | no declaration in the tree is generic (`grep "class \w+<"` over both wire files → 0); the C headers fix every array bound at compile time (`tension_input.h:142` `[8]`, `:175` `[6]`); the generic-`@unmanaged` precedent (`MapEntry<K,V>`, `std/assembly/map.ts:24`) has no array field |
| `f32[4][4]` nested arrays | **out** | no guest-visible header contains `][` (grep → 0); `Mat4f` flattens to 16 scalars (`ogre/wire.ts:81-86`) |
| array of `@unmanaged` structs (`Point pts[4]`) | **out** | no header declares a struct-typed array member (grep → 0); the 33 declarations embed no wire type (prior sweep, category c = 0) |

Each is out for the same reason: **the tree cannot express the need because no
C record it reads has the shape.** If a future capability's header declares
`float m[4][4]` or `struct point pts[4]`, that is the measurement that moves the
edge — not a preference.

---

## 6. The version boundary

**A compiler change.** `f32[4]` is a TS1005 syntax error in `parseType`
(§1), and `StaticArray<T,N>` is TS1110 (§2.1). Neither is a std or framework
change:

- no std declaration can make `f32[4]` parse — the token sequence is rejected
  before any symbol is looked up;
- no framework change can make `StaticArray` inline — its layout is fixed by
  `staticarray.ts:60-62` (length from the allocation header) and by `__new`;
- `changetype` views (§2.3) are not a declaration form and are unsound for
  bounds.

So: **compiler release territory — 0.8.0**, the version the struct scoping
already reserved for intrinsics semantics (`docs/interop-scope.md` §8). Adoption
is not available because there is nothing to adopt.

---

## 7. The three-way fixture (specified; one cell measured)

Shape: an `@unmanaged` record with an inline array between two scalars, mirroring
`input_state`'s shape (`u32[8]` at 16, `tension_input.h:142`):

```ts
@unmanaged class WithArray {
  head: i32 = 0;          // 0
  data: f32[4];           // 4  ← the form this phase is about
  tail: i32 = 0;          // 20 (4 + 16), record size 24
}
```

| cell | state | expected |
|---|---|---|
| **1. refuse** | today | `data: f32[4]` → `TS1005 ']' expected` (measured, §1); `StaticArray<f32,4>` → `TS1110` (measured, §2.1). Passes today **as a refusal**. |
| **2. partial** | the middle state | It parses, but the layout is a reference: `offsetof<WithArray>()` = 12 (4 + 4 + 4) and `offsetof("data")` = 4 with `offsetof("tail")` = 8. This is **measured today** with `StaticArray<f32> | null` as the field (§2.2) — it is the state a half-fix ships in: the syntax accepts the field, the bytes are wrong. |
| **3. fixed** | after the change | `offsetof<WithArray>()` = 24; `offsetof("data")` = 4; `offsetof("tail")` = 20; `w.data[2] = 7.5` writes the four bytes at 12; `memory.copy(24)` reproduces all 24 bytes (`memory.compare` = 0); the host reading `f32` at 4, 8, 12, 16 sees the four elements. |

Only cell 2 was executed (it is the measured reference-field case). Cells 1 and 3
are specified: cell 1 needs nothing but the published compiler, and cell 3 cannot
run until the grammar exists.

**The discipline note is already satisfied by the tree**, which is why this
fixture is cheap: cell 2 is not hypothetical, it is what `StaticArray` fields do
today.

---

## 8. Design questions

### 8.1 Adoption vs new feature

**New feature — a grammar change.** Not adoption: no existing declaration form
gives an inline array (§2). The minimal gap is exactly one production in
`parseType`: accept `Type '[' IntegerLiteral ']'` after a type name, and define
its layout.

### 8.2 Syntax, if syntax is warranted — the tradeoffs

| form | for | against |
|---|---|---|
| `T[N]` (C-like) | matches C exactly; the tree's headers are written `keys_held[8]`; unambiguous at the `[` (`[` + integer vs `[` + `]`) | two bracket forms with different meanings (`T[]` = reference, `T[N]` = inline) is a foot-gun a reader must learn; `N` must be a compile-time literal or a const |
| `StaticArray<T, N>` | reuses a name guest authors already know; no new bracket semantics; a natural home for `.length` | the existing `StaticArray<T>` has runtime length and a heap header — the same name would denote two incompatible layouts; the arity-overload would be a silent behaviour split |
| a new form (`InlineArray<T, N>` / `T * N`) | no ambiguity at all | a third array spelling in a language that already has `Array`, `StaticArray`, and `T[]` |

Not chosen here. The one structural observation that bears on the choice: `T[N]`
is the only candidate that does not collide with an existing meaning
(`T[]` already means `Array<T>`, `parser.ts:739-752`), and it is the spelling the
C headers use.

### 8.3 Semantics

Inline layout, as §4.2 states it: `N * element size`, element alignment for the
field, `offsetof("field")` at the first element, record size grown by the whole
extent. Confirmed against both real C records (§3.1, §4.2).

### 8.4 Generic size and nesting

Out (§5), each with the citation that decides it.

### 8.5 Version boundary

Compiler release, 0.8.0 (§6).

### 8.6 What would force a "no"

1. **The tree's need is already met exactly.** It is: two records, both served
   by raw offsets, both with compile-time bounds. A grammar change buys
   expressibility, not capability — which is why the recommendation is "no for
   now" rather than "proceed".
2. **A syntax change that conflicts with `T[]`.** `T[]` is `Array<T>`
   (`parser.ts:739-752`); a `T[N]` form must be distinguishable at the `[`, which
   it is (an integer literal vs `]`), but the two meanings sitting one character
   apart is a real design cost, not a formality.
3. **A layout the host cannot read.** Not a risk here: the two C records are
   contiguous `N * element` arrays with no interior padding (§4.2), and the host
   reads them by number.
4. **An inline array that must be length-checked at runtime.** If the form
   carries `N`, a literal index is checkable at compile time; a dynamic index
   would
   need the `N` available at runtime. That is a codegen question, not a
   blocker, but it is the one place the existing `StaticArray` semantics
   (`staticarray.ts:60-62`, length from the header) cannot be reused at all.

---

## 9. Recommendation

**No for this phase as framed; record it as a 0.8.0 candidate with the
measurements below.**

The reasoning, in the order the evidence supports it:

1. **The capability gap is real and confirmed** — three independent refusals
   (`f32[4]` TS1005, `StaticArray<T,N>` TS1110, tuple types off) and one
   measured wrong-layout alternative (`StaticArray` field = 4-byte reference,
   record 12 not 24). This is not a case of "it already works, we just did not
   know the name."
2. **But the runtime already does the job, and the tree already does it.** An
   inline float block is addressed correctly today (`load<T>(ptr + i*alignof<T>())`),
   and the two C records that need it are served exactly (`input.ts:208`, `:218`)
   with bounds fixed at compile time by the C header. Nothing in the tree is
   blocked, and nothing in the tree is wrong today.
3. **The fix is a compiler release.** A grammar production in `parseType`, its
   layout rule, and the codegen for `offsetof`/field access on the new form —
   0.8.0 territory, alongside the `sizeof`/`store` semantics change the struct
   phase deferred. Doing it *with* that release is cheaper than doing it alone,
   because both touch the same layout question.
4. **The tree's two instances are both served exactly, and the wider need is
   prospective.** The input records (`input.h:46`, `:69`) are read by arithmetic
   with compile-time bounds; the OGRE records are scalar on both ends
   (`scene.h:103-145`); `Mat4f` is declared and offset-checked but never
   instantiated by a guest (4 references, all in `ogre/wire.ts` and its check).
   The tree's *shipping* code has no unmet need — what a grammar change buys is
   that the next C-shaped record need not be hand-expanded.

If the architect wants it anyway, the minimum viable shape is the one §7's
fixture describes: `T[N]` with a compile-time literal `N`, 1-D scalar elements
only, layout `N * sizeof(T)` contiguous, `offsetof` returning the first element,
and the three edges of §5 out. That is a smaller change than the full C-array
semantics and it serves every shape the tree has.

**What would flip the recommendation to "proceed":** a third instance of the
`keys_held[8]`/`axes[6]` pattern — a guest-visible C record with an array field —
especially one whose access is not a single `index * elementSize` (a 2-D index, a
record-stride walk, or an array whose bound is not a literal). Two instances is a
workaround with an exact substitute; three is a language gap. There are two
today, both 1-D scalar with literal bounds.

---

## 10. What could not be measured read-only

- **Cell 3 of the fixture** (§7) — it needs the grammar that does not exist.
  Specified, not run.
- **The layout of a `T[N]` field** — no such field can be compiled. §4.2's rule
  is derived from the two real C records' byte tables
  (`tension_input.h:142-144`, `:175-176`) and from the measured `Mat4f` copy,
  not from a compiled array field.
- **`StaticArray` on a `--runtime stub` build** — the view-length measurement
  used the incremental runtime on the real host; stub's block header differs and
  was not measured, because the incremental result already shows the length is
  allocation-derived rather than array-derived.
- **The `tension-input` DSO at runtime** — the input fixture reads the record
  through `load`/`store` in a bare guest; loading `libtension_input.so` and
  reading a live `input_state` was not done (the DSO needs SDL3 and a window).
  The layout claim rests on the header's byte table (`tension_input.h:133-157`)
  and the guest's reader (`input.ts:208`, `:218`), both cited.

## Appendix — this pass's probes

All in `/tmp/interop-probe/`, published 0.7.1 unless stated.

**A. Parse refusals.**

```
arr1.ts   @unmanaged class A { data: f32[4]; }        → TS1005 ']' expected (1,31)
arity.ts  @unmanaged class A { data: StaticArray<f32, 4>; } → TS1110 Type expected (1,45)
tuple.ts  @unmanaged class T { data: [f32, f32, f32, f32]; } → TS1110 Type expected (1,28)
emptyb.ts export function f(x: i32[]) …               → compiles (Array<i32>)
```

**B. StaticArray as a field** (`sa1.wat`, compile output):

```
sizeWithSA (offsetof<WithSA>)  12
dataOff    (offsetof("data"))   4
bOff       (offsetof("b"))      8
sizeSA     (offsetof<StaticArray<f32>>)  0
sizeofSA   (sizeof<StaticArray<f32>>)    4
```

**C. StaticArray view over a raw block** (`saview.wasm`, real host):

```
view[0] = 1.5, view[3] = 4.5
view.length (reads beyond the block) = 19
record tail still = 0x1234
after view[1]=9.75: raw +4 = 9.75
offsetof<StaticArray<f32>> = 0
```

**D. The view's length is allocation-derived** (`saview3.wasm`, real host):

```
view of 16-byte block: length = 7      (4 elements expected)
view of 64-byte block: length = 19     (16 elements expected)
real StaticArray<f32>(4): length = 4
```

**E. The named copy over a flat record** (`flat.wasm`, real host):

```
offsetof<Mat4f> = 64
field at +60 (m33) = 15.5
after memcpy: m00 = 0.5, m33 = 15.5
byte compare = 0
m33 offset via offsetof = 60
```

**F. Header shapes.** `grep "][`" over the five guest-visible headers → 0;
`grep` for struct-typed array members → 0; `tension_input.h:142` (`keys_held[8]`),
`:175` (`axes[6]`); the host's own C structs hold them as arrays —
`tension-input/src/input.h:46` and `:69` — filled by `memcpy`
(`input.cpp:651`) and element-wise (`input.cpp:606`); `scene.h:103-145` (all
records scalar, `MaterialRecord` with one slot at `:128`).
