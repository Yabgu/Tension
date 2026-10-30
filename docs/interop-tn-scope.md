# Interop `T[N]` — scoping against the `-O3` tree

**Status:** scoping only. No source changed, no plan, no code.

> **Post-merge note (2026-10-30).** The OGRE-side citations in this document
> predate PR #38. Thirteen `ogre/wire.ts` declarations were pruned that day for
> zero consumers (commit `88012ee`) — `Mat4f` among them — and the record sizes
> moved: `SceneNode` 72, `LightRecord` 88, `Material` 200, `Renderable` 56,
> `MotionUpdate`/`BoneUpdate` 48. The OGRE lines below are historical. The
> `input.ts` claims are untouched by that change and are not re-verified here.
**Base:** Tension `build/optimize-level` @ `1c663ed` (PR 27); published
TensionScript `0.7.1` for compile-output claims.
**Landed on:** `main` @ `31a6626` (PR 26 merged 2026-10-22T00:50:11Z).
**Siblings:** `docs/interop-surface-scope.md` (lives on PR 27's branch,
`build/optimize-level`; not yet on `main`);
`docs/interop-arrays-scope.md`, `docs/interop-scope.md`,
`docs/interop-scope-addendum.md`, `docs/interop-scope-addendum-2.md` (on `main`
after PR 26; not modified). Also unmodified: `docs/async-complete.md`.

**Method.** Compile-output claims use the published
`@yabgu_gm/tensionscript@0.7.1` (`examples/log/node_modules/...`) with
`--target release --runtime incremental --optimizeLevel N`, emitting WAT with
`-t`. Function-body byte counts are parsed from the wasm code section
(`/tmp/tnprobe/dump.py`). Runtime claims from the earlier passes are cited, not
re-run. Fixtures live in `/tmp/tnprobe/`; none is in the repo.

**Conditional on PR 27.** PR 27 (`build: compile the tree at optimizeLevel 3`,
commit `cef127f`) is **OPEN** as of this document's landing, while **PR 26
merged** (2026-10-22T00:50:11Z, `main` @ `31a6626`). So the conditional stands:
PR 27 carries one unmet gate — the AI example at `-O3` against real llama.cpp
(PR 27 body, "Merge gate"). The `-O3` numbers in this document describe the
tree **only if PR 27 merges**. If that gate never closes, the tree remains at
`-O0`; §1 also reports the `-O0`
column, and §5 states what changes. `T[N]`'s own element access is call-free at
both levels when emitted directly, so the feature does not acquire a codegen
floor — but the tree's *named-field* economics stay at `-O0` (the struct phase's
`+161`-byte finding, `docs/interop-surface-scope.md` §2.1.2, remains true of the
tree as configured).

---

## 0. The answer up front

**`T[N]` is now a scope, not a candidate — but the array scoping's count-based
flip condition has not fired.** The `-O3` measurement removes the cost that
made the earlier scoping hesitate; it does not add a third C record.

1. **Field and constant-index array access are byte-identical at `-O3`.** A
   read of `m11` on a 16-`f32` `@unmanaged` record is a 7-byte function body
   (2 instructions, `local.get; f32.load offset=20`); a write is 9 bytes
   (3 instructions). The constant-index array form (`load<f32>(p + 20)`)
   compiles to the same bodies, and the optimized module **merges the two
   functions** (`readIdx5` is an alias of `readM11`; `writeIdx5` of `writeM11`,
   §1.4).
2. **Dynamic indexing is the hand-rolled form the tree already writes.** It is
   13 bytes / 6 instructions for a read and 15 / 7 for a write at `-O3`; at
   `-O0` it is 14 / 7 and 15 / 7 with **no accessor call**. The address
   arithmetic is already emitted; `T[N]` does not need Binaryen work.
3. **The layout rule is `N * elementSize` with *element* alignment**, and it is
   validated against both C records by manual expansion: `StateRecord` 96 bytes
   with `keys_held` at 16 and `mouse_dx` at 48 (`input.h:41-58`); `PadRecord`
   48 bytes with `axes` at 16 and `reserved1` at 40 (`input.h:64-72`). Both
   match to the byte (§3).
4. **The layout engine cannot take a `T[N]` field as-is.** It uses a field
   type's `byteSize` as both size and alignment and asserts the size is a power
   of two (`resolver.ts:3677-3682`). `f32[6]` is 24 bytes (assert fails);
   `u32[8]` is 32 bytes (the naive rule puts it at 32, not 16); `f32[4]` is
   16 bytes (naive rule puts it at 16, not 4). The array type needs size and
   alignment as separate values, and the layout loop needs an array case (§3.3).
5. **No hash move is implied.** `layout_hash()` takes no argument and folds
   host constants (`arena.rs:1030-1104`, field lists `:1110-1200`); guest
   declarations and guest `offsetof` sites are not inputs. The input records
   with array fields are not in the fold at all (`grep keys_held|axes
   tension-core/src/session/arena.rs` → no hits; the only `[6]` hit is
   `REGIONS[6].flags` at `arena.rs:1458`). A `T[N]` field in a guest
   `@unmanaged` class moves no hash (§5.3).
6. **Recommendation: `0.8.0`**, bundled with the `sizeof` semantics change and
   the `store<T>` refusal. This is a compiler release, not a coordinated layout
   release: no ABI, no adapter, no hash move. `T[N]` rides the release that is
   already breaking `sizeof`; it does not force a rebuild by itself. Span is
   independent and can ship before or after (`docs/interop-surface-scope.md`
   §5, §7).

**What this scoping does not re-litigate.** The `f32[4]` → `TS1005` parse error,
the `StaticArray<T>` arity-1/runtime-length finding, and the `StaticArray` field
being a 4-byte reference are measured facts from
`docs/interop-arrays-scope.md` §1-§2 and are used as given.

---

## 1. The field-access measurement at `-O3` (Item 1)

### 1.1 The probe

`@unmanaged class Mat` has 16 `f32` fields, `m00` … `m33`; the same shape as
the tree's `Mat4f` (`tension-framework/assembly/ogre/wire.ts:80-87`). Access is
through `changetype<Mat>(ptr).mXY`, read and write:

```ts
@unmanaged class Mat {
  m00: f32; m01: f32; m02: f32; m03: f32;
  m10: f32; m11: f32; m12: f32; m13: f32;
  m20: f32; m21: f32; m22: f32; m23: f32;
  m30: f32; m31: f32; m32: f32; m33: f32;
}
export function sizeMat(): i32 { return offsetof<Mat>(); }
export function offM33(): i32 { return offsetof<Mat>("m33"); }
export function readM00(ptr: usize): f32 { return changetype<Mat>(ptr).m00; }
export function writeM00(ptr: usize, v: f32): void { changetype<Mat>(ptr).m00 = v; }
export function readM11(ptr: usize): f32 { return changetype<Mat>(ptr).m11; }
export function writeM11(ptr: usize, v: f32): void { changetype<Mat>(ptr).m11 = v; }
export function readM33(ptr: usize): f32 { return changetype<Mat>(ptr).m33; }
export function writeM33(ptr: usize, v: f32): void { changetype<Mat>(ptr).m33 = v; }
// the shape a T[N] element access must emit, hand-rolled
export function readIdx(ptr: usize, i: i32): f32 { return load<f32>(ptr + (<usize>i << 2)); }
export function writeIdx(ptr: usize, i: i32, v: f32): void { store<f32>(ptr + (<usize>i << 2), v); }
// a constant index (what data[5] would fold to)
export function readIdx5(ptr: usize): f32 { return load<f32>(ptr + 20); }
export function writeIdx5(ptr: usize, v: f32): void { store<f32>(ptr + 20, v); }
```

`sizeMat()` returns **64** and `offM33()` returns **60** at both levels
(WAT constants; §1.2). The record is the 16-field expansion, not an array.

### 1.2 The ladder, same source and flags

| `--optimizeLevel` | wasm bytes | code-section bytes | accessor call sites | accessor functions |
|---|---|---|---|---|
| 0 | 417 | 156 | **6** | **6** |
| 1 | 318 | 107 | 0 | 0 |
| 2 | 292 | 85 | 0 | 0 |
| **3** | **292** | **85** | **0** | **0** |

The `-O3` module is 292 bytes, down from 417 at `-O0`; the code section is
85 bytes, down from 156. The accessor functions disappear at `-O1`, matching the
surface scoping's ladder (there: 335/230/204/204 bytes and 7/0/0/0 sites,
`docs/interop-surface-scope.md` §2.1).

### 1.3 Read and write, per instruction (WAT)

At `-O0` — a call to a two/three-instruction accessor:

```wat
(func $mat2/Mat#get:m11 (param $0 i32) (result f32)
  local.get $0
  f32.load offset=20 )
(func $mat2/readM11 (param $0 i32) (result f32)
  local.get $0
  call $mat2/Mat#get:m11
  return )
(func $mat2/Mat#set:m11 (param $0 i32) (param $1 f32)
  local.get $0
  local.get $1
  f32.store offset=20 )
(func $mat2/writeM11 (param $0 i32) (param $1 f32)
  local.get $0
  local.get $1
  call $mat2/Mat#set:m11 )
```

At `-O3` — one function, no call:

```wat
(func $mat2/readM11 (param $0 i32) (result f32)
  local.get $0
  f32.load offset=20 )
(func $mat2/writeM11 (param $0 i32) (param $1 f32)
  local.get $0
  local.get $1
  f32.store offset=20 )
```

At `-O3`, the constant-index raw access is the *same body*:

```wat
(func $mat2/readIdx5 (param $0 i32) (result f32)
  local.get $0
  f32.load offset=20 )
(func $mat2/writeIdx5 (param $0 i32) (param $1 f32)
  local.get $0
  local.get $1
  f32.store offset=20 )
```

and the export table records the merge:

```wat
(export "readIdx5" (func $mat2/readM11))
(export "writeIdx5" (func $mat2/writeM11))
```

The dynamic-index forms:

```wat
(func $mat2/readIdx (param $0 i32) (param $1 i32) (result f32)
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  f32.load )
(func $mat2/writeIdx (param $0 i32) (param $1 i32) (param $2 f32)
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  local.get $2
  f32.store )
```

Per-access counts (WAT instructions; body bytes include the locals declaration
and `end`):

| access | `-O0` instructions | `-O0` body bytes | `-O3` instructions | `-O3` body bytes | Δ bytes |
|---|---|---|---|---|---|
| read `m11` (named field) | 5 (caller 3 + accessor 2) | 14 (7 + 7) | **2** | **7** | **-7** |
| write `m11` (named field) | 6 (caller 3 + accessor 3) | 17 (8 + 9) | **3** | **9** | **-8** |
| read `data[5]` (constant index) | 5 | 11 | **2** | **7** | **-4** |
| write `data[5]` (constant index) | 5 | 12 | **3** | **9** | **-3** |
| read `data[i]` (dynamic index) | 7 | 14 | 6 | 13 | -1 |
| write `data[i]` (dynamic index) | 7 | 15 | 7 | 15 | 0 |

The `-O0` read/write instruction counts include the explicit `return`; the
`-O3` bodies omit it (`readM11` 2, `writeM11` 3). The accessor bodies
(`Mat#get:m11`, `Mat#set:m11`) are 7 and 9 bytes, exactly the size of the
inlined `-O3` body. The named-field row counts **one call site plus its
accessor body**; the accessor is emitted once per field and shared by every
call site. The marginal per additional read site is 7 bytes at both levels
(the caller body is 7 either way); per additional write site it is 8 bytes at
`-O0` and 9 at `-O3`. The 14/17 figures are the one-site module the probe
compiles, not a per-call-site cost.

**What the table decides.** At `-O3`, the cost of a `T[N]` element access is
**zero relative to a named field** for a constant index (7/9 bytes, 2/3
instructions; the same function in the binary) and is the already-emitted
hand-rolled sequence for a dynamic index (13/15 bytes). The `-O3` inliner is not
needed for the array shape: the dynamic form is call-free at `-O0` too (14/15
bytes, 7 instructions). If `T[N]` is lowered through a synthetic accessor, the
`-O0` call tax would return; if it is lowered to the address arithmetic the
probe writes by hand, it does not. That is an emission choice, not a Binaryen
floor (§5.1).

### 1.4 The 16-field expansion versus the hypothetical inline array

The tree's `Mat4f` is the 16-field expansion (`ogre/wire.ts:80-87`); its check
is `offsetof<Mat4f>("m33") == 60` and `+4 == 64` (`ogre/wire.ts:861`). A
hypothetical `data: f32[16]` cannot be compiled (§2.1), so the closest
expressible proxy is the hand-rolled `load<f32>(ptr + i*4)` /
`store<f32>(ptr + i*4, v)` the input reader already uses
(`tension-framework/assembly/input.ts:206-208`, `:217-218`).

| property | 16 named `f32` fields | hypothetical `f32[16]` | measured gap |
|---|---|---|---|
| record size | 64 (`offsetof<Mat>()`) | 64 by the rule (§3) | 0 |
| last element offset | 60 (`m33`) | 60 (`data[15]`) | 0 |
| constant-index read, `-O3` | 7 bytes / 2 instr | 7 bytes / 2 instr (proxy `readIdx5`, merged) | **0** |
| constant-index write, `-O3` | 9 bytes / 3 instr | 9 bytes / 3 instr (proxy `writeIdx5`, merged) | **0** |
| dynamic-index read, `-O3` | not expressible | 13 bytes / 6 instr (proxy `readIdx`) | declarative |
| dynamic-index write, `-O3` | not expressible | 15 bytes / 7 instr (proxy `writeIdx`) | declarative |
| constant-index read, `-O0` | 14 bytes / 5 instr | 11 bytes / 5 instr | **-3** (array smaller) |
| constant-index write, `-O0` | 17 bytes / 6 instr | 12 bytes / 5 instr | **-5** (array smaller) |
| declaration | 16 fields + 16 names | 1 field + 1 bound | declarative |
| bounds | none (index is a constant) | `i < 16` checkable | safety |

**The gap `T[N]` closes is declarative and dynamic-index expressibility, not
emitted code at `-O3`.** At `-O3` the constant-index code is identical; at
`-O0` the array form is smaller because it bypasses the accessor call. The
16-field expansion cannot express `data[i]` at all; that is the capability the
form adds, and the hand-rolled sequence is the code it would emit.

---

## 2. The parse error, the grammar shape, and the type constructor (Item 2)

### 2.1 The refusal, reproduced

```
$ tensionscript refuse.ts
ERROR TS1005: ']' expected.
 1 │ @unmanaged class A { data: f32[4]; }
   │                               ~
   └─ in refuse.ts(1,31)
FAILURE 1 parse error(s)
```

The caret is on the `[` (column 31; `4` is 32, `]` is 33). The same error for
the fixture shape is `fixture-refuse.ts(3,11)`, caret on `[`:

```
 3 │ arr: f32[4];
   │         ~
   └─ in fixture-refuse.ts(3,11)
```

The site is `parseType` (`third_party/assemblyscript/src/parser.ts:537`). Its
identifier branch builds a `NamedType`, then the postfix loop at
`parser.ts:739-752` consumes `[`; if the next token is not `]`, it reports
`DiagnosticCode._0_expected` and returns `null`:

```ts
while (tn.skip(Token.OpenBracket)) {
  let bracketStart = tn.tokenPos;
  if (!tn.skip(Token.CloseBracket)) {
    this.error(DiagnosticCode._0_expected, tn.range(), "]");
    return null;
  }
  ...
}
```

`_0_expected` is **1005** (`src/diagnosticMessages.json:69`,
`"' {0}' expected.": 1005`). This is a genuine syntax error in the parse pass,
not a resolver or codegen refusal: the CLI reports `FAILURE 1 parse error(s)`
and no symbol is looked up.

The control that fixes the meaning of the existing bracket form:

```ts
@unmanaged class B { a: i32; data: f32[]; b: i32 }
```

compiles; `offsetof<B>()` = **12**, `offsetof<B>("data")` = **4** — a 4-byte
reference to a managed `Array<f32>`, exactly the `Array<T>` creation at
`parser.ts:767-772` (`Node.createSimpleTypeName("Array", ...)`). So `T[]` is a
reference, and `T[N]` would be inline storage: two memory models one character
apart.

`StaticArray<f32, 4>` remains a parser refusal:

```
ERROR TS1110: Type expected.
 1 │ @unmanaged class A { data: StaticArray<f32, 4>; }
   │                                             ^
   └─ in arity.ts(1,45)
```

The type-argument loop accepts `TypeNode`s only (`parser.ts:681-696`); a numeric
literal is not a type. `StaticArray<T>` is arity-1 and its `length` is read from
the allocation header (`std/assembly/staticarray.ts:13`, `:60-62`), so it is not
a constructor for an inline array even if the arity were parsed.

### 2.2 The grammar shape, and the disambiguation

The current production is:

```
PostfixType ::= PrimaryType ( '[' ']' )*            // T[] -> Array<T>
PrimaryType ::= Identifier ( '<' Type (',' Type)* '>' )? | ...   // parser.ts:681-696
```

A production that accepts both forms is decided by the token immediately after
`[`:

```
PostfixType ::= PrimaryType ( '[' ']' | '[' IntegerLiteral ']' )*
```

- `[` `]` → `Array<T>` (unchanged; `parser.ts:739-772`).
- `[` `IntegerLiteral` `]` → the inline array (new type node).
- anything else → `TS1005` (unchanged; `parser.ts:743-746`).

**The disambiguation is a numeric literal token in the bracket.** The literal
productions are:

- `Token.IntegerLiteral` / `Token.FloatLiteral` are produced by the tokenizer's
  digit branch, `src/tokenizer.ts:758-773` (`testInteger()` → `IntegerLiteral`,
  else `FloatLiteral`), and the token names are declared at
  `src/tokenizer.ts:169-170`.
- `readInteger()` consumes the token (`src/tokenizer.ts:1306`); the expression
  grammar uses it at `src/parser.ts:4216-4219` (`Token.IntegerLiteral` →
  `Node.createIntegerLiteralExpression`).
- `parseType` has no literal production: its `else` reports `Type_expected`
  (`src/parser.ts:699-706`). The literal is therefore new in type position.

**A const identifier is not accepted by this shape.** `f32[N]` would present
`Token.Identifier` after `[`, not `IntegerLiteral`; it would fall into the
`TS1005` branch. The parser has no constant evaluation in type position —
identifiers in a type are parsed as type names (`parser.ts:681`), and constant
values are resolved later, not in `parseType`. The tree's C bounds are all
literals (`[8]` at `input.h:46`, `[6]` at `:69`, `[4]` in the fixture), so the
literal-only rule covers every instance the tree has. A const `N` would be a
second production and a resolver-level length, not a disambiguation necessity.

**The conflict with `T[]` is semantic, not grammatical.** The token after `[`
distinguishes the forms without lookahead beyond one token; there is no
ambiguous sentence. The cost is human: `T[]` is a managed reference, `T[N]` is
inline storage, and the two sit one character apart. The array scoping already
recorded this as a design cost, not a blocker
(`docs/interop-arrays-scope.md` §8.2, §8.6.2). A tuple type is a *leading*
`[` behind `Feature.MultiValue` (`parser.ts:613`), not a postfix form, so it does
not collide with `T[N]` either.

### 2.3 What the compiler would need: a new type kind, not just a parser case

The parser change alone cannot produce the layout or the access. The pieces the
compiler has today:

- **Type-node kinds:** `NamedType`, `FunctionType`, `TupleType` only
  (`src/ast.ts:50-53`, node classes at `:913`, `:940`, `:958`).
- **Resolver dispatch:** `resolveType` switches on exactly those three and
  asserts otherwise (`src/resolver.ts:167-180`).
- **Type representation:** scalars and references; class types are `usize`
  with the `Class` flag (`src/types.ts:28-100`; the `Usize` comment is "also the
  base of class types"; the struct scoping measured the consequence: a class is
  4 bytes, `sizeof` 4, `load`/`store` width 4,
  `docs/interop-scope.md` §1-§2). `byteSize` is `size + 7 >>> 3` and
  `alignLog2` is `31 - clz(byteSize)` (`src/types.ts:193-201`), which assumes a
  scalar-sized, power-of-two type.
- **Layout:** fields are laid out in declaration order; `byteSize` is used as
  the alignment, the field offset is rounded up to a power of two, and
  `assert(isPowerOf2(byteSize))` guards it (`src/resolver.ts:3677-3682`);
  `nextMemoryOffset` is the record size (`:3723`).
- **Element access:** a class-typed expression looks up an `IndexedGet`
  overload and calls it (`src/compiler.ts:7351-7390`); a field access compiles
  through the property's getter (`src/compiler.ts:9493-9590`), which is the call
  the `-O0` probe shows. `offsetof` reads `property.memoryOffset` and
  `classReference.nextMemoryOffset` (`src/builtins.ts:1278-1332`); `alignof`
  rejects a non-power-of-two `byteSize` (`:1256-1275`).

A fixed-size array therefore needs **a new `TypeNode` kind plus a `Type`
representing inline storage** (an element type and a length, with `byteSize =
N * elem.byteSize` and alignment = element alignment), a case in
`resolveType`, a case in the class-layout loop, and an element-access path that
computes `base + i * elemSize` instead of loading a reference. A parser special
case that rewrites `T[N]` to a named class would still leave the field as a
4-byte reference (measured: §4, cell 2a). The name of the new type is not the
scoping's question; the mechanism is a type kind, not a spelling alias.

---

## 3. The layout rule, against the C records (Item 3)

### 3.1 The rule

For `@unmanaged class Foo { a: i32; arr: T[N]; b: i32 }`:

- `arr` occupies `N * sizeof(T)` bytes inline, starting at the field offset;
- the field is aligned to `alignof(T)`, not to `N * sizeof(T)` and not to the
  record's largest scalar;
- `offsetof<Foo>("arr")` is the offset of `arr[0]`;
- `offsetof<Foo>()` is the total record size, including the array's whole
  extent;
- the next field follows at `offsetof("arr") + N * sizeof(T)` rounded to its
  own alignment.

For a flat scalar array there is no interior padding. The C headers state this
directly, and the manual expansions below reproduce it.

### 3.2 The two C records, and the measured manual expansions

`tension-input/src/input.h:41-58`:

| field | offset | size |
|---|---|---|
| `version` | 0 | 4 |
| `flags` | 4 | 4 |
| `pads_present` | 8 | 4 |
| `mouse_buttons` | 12 | 4 |
| `keys_held[8]` | **16** | **32** |
| `mouse_dx` | **48** | 4 |
| … | | |
| `mouse_dxf` | 56 | 4 (the header's own static_assert, `input.h:60`) |
| `seq` | 80 | 8 |
| `reserved` | 88 | 8 |
| **total** | | **96** (`static_assert` at `input.h:58`) |

`tension-input/src/input.h:64-72`:

| field | offset | size |
|---|---|---|
| `version` … `reserved0` | 0, 4, 8, 12 | 4 each |
| `axes[6]` | **16** | **24** |
| `reserved1` | **40** | 8 |
| **total** | | **48** (`static_assert` at `input.h:72`) |

The same byte tables are in the public header (`tension_input.h:133-157`,
`:166-178`) and the guest reads the records by number
(`tension-framework/assembly/input.ts:77-91`, `:206-208`, `:217-218`).

**Manual expansion probe.** Two `@unmanaged` classes spell the arrays as
consecutive scalars, with no array form:

```ts
@unmanaged class StateManual {
  version: u32; flags: u32; pads_present: u32; mouse_buttons: u32;
  k0: u32; k1: u32; k2: u32; k3: u32; k4: u32; k5: u32; k6: u32; k7: u32;
  mouse_dx: i32; mouse_dy: i32; mouse_dxf: f32; mouse_dyf: f32;
  mouse_x: i32; mouse_y: i32; wheel_x: f32; wheel_y: f32;
  seq: u64; reserved: u64;
}
@unmanaged class PadManual {
  version: u32; flags: u32; buttons: u32; reserved0: u32;
  a0: f32; a1: f32; a2: f32; a3: f32; a4: f32; a5: f32;
  reserved1: u64;
}
```

Compiled at `-O3`, the `offsetof` constants are:

| expression | measured | C header |
|---|---|---|
| `offsetof<StateManual>()` | **96** | 96 (`input.h:58`) |
| `offsetof<StateManual>("k0")` | **16** | 16 (`input.h:46`) |
| `offsetof<StateManual>("mouse_dx")` | **48** | 48 (`input.h:47`) |
| `offsetof<StateManual>("mouse_dxf")` | **56** | 56 (`input.h:60`) |
| `offsetof<StateManual>("seq")` | **80** | 80 (`input.h:55`) |
| `offsetof<PadManual>()` | **48** | 48 (`input.h:72`) |
| `offsetof<PadManual>("a0")` | **16** | 16 (`input.h:69`) |
| `offsetof<PadManual>("reserved1")` | **40** | 40 (`input.h:70`) |

Every value matches. The rule is therefore validated against real C bytes even
though the `T[N]` form itself does not compile: the manual expansion *is* the
layout the array must produce.

### 3.3 The layout engine's current assumption, and why the array type must carry alignment

The class-layout loop (`src/resolver.ts:3677-3682`) does this:

```ts
let byteSize = fieldType.byteSize;
assert(isPowerOf2(byteSize));
let mask = byteSize - 1;
if (memoryOffset & mask) memoryOffset = (memoryOffset | mask) + 1;
boundInstance.memoryOffset = memoryOffset;
memoryOffset += byteSize;
```

It uses the field type's **size as its alignment**, and it asserts the size is a
power of two. A `T[N]` field whose size is `N * elemSize` breaks both premises
for the tree's own arrays:

- `f32[4]` is 16 bytes (power of two): the naive loop aligns `arr` to 16, so
  `{ a: i32; arr: f32[4]; b: i32 }` becomes 4 bytes (a) + 12 bytes of padding +
  16 bytes (arr) + 4 bytes (b) = **36**, not the 24 in §4. The C rule puts
  `arr` at 4 (`input.h:69` puts `axes[6]` at 16 after four 4-byte words; there
  is no 24- or 32-byte alignment).
- `f32[6]` is 24 bytes, **not** a power of two: the `assert` at
  `resolver.ts:3678` fails. `axes[6]` is exactly this shape (`input.h:69`).
- `u32[8]` is 32 bytes (power of two): the naive loop aligns `keys_held` to 32,
  so `StateRecord` would place it at 32, not 16, and the next field at 64, not
  48 (`input.h:46-47`). The C header says 16/48.

So the array type cannot be a `Type` whose `byteSize` is `N * elemSize` and
whose alignment is inferred from that size. It needs **size and element
alignment as separate values** — whether carried by the new type or by the
layout loop. The layout loop needs a branch for the array case (or a general
`alignment` property on every field type). `alignof`/`offsetof` need a case
only if they are called on the array type itself; `offsetof<Foo>("arr")`
reads `property.memoryOffset` (`builtins.ts:1306-1321`), which the layout loop
sets. This is a required part of the phase; it is also the exact place a
half-fix would ship a wrong layout (§4, cell 2b).

### 3.4 Nesting and arrays of structs — both out, by the tree's evidence

- **`f32[4][4]` (2-D):** no guest-visible header contains `][`
  (`grep '\]\[' --include='*.h'` over the five guest-visible headers → 0);
  `Mat4f` is 16 flat `f32` fields (`ogre/wire.ts:80-87`), not a 4×4 type.
- **`Struct[N]` (array of `@unmanaged` structs):** no header declares a
  struct-typed array member (grep → 0). The 33 framework `@unmanaged` classes
  (24 in `ogre/wire.ts`, 9 in `runtime/wire.ts`) have **no class-typed field**:
  a field-type sweep finds 0 non-scalar fields; every field is a scalar
  (`f32`, `u32`, `u64`, `i32`, `f64`). Nested records are flattened by hand:
  `SceneNode` spells its transform as 12 `f32` fields (`ogre/wire.ts:138-173`),
  `Material` spells its eight texture slots as 32 scalars
  (`ogre/wire.ts:283-345`), and `Mat4f` is the 16-field matrix.

Both are out for the same reason the array scoping gave: the tree cannot express
the need because no C record it reads has the shape. If a future header declares
`float m[4][4]` or `struct point pts[4]`, that is the measurement that moves the
edge — not this scoping.

---

## 4. The three-way fixture, shaped (Item 4)

The fixture is the mixed record:

```ts
@unmanaged class WithArray {
  a: i32 = 0;      // 0
  arr: f32[4];     // 4 .. 19
  b: i32 = 0;      // 20
}                  // 24
```

**The expected offsets.** Under the rule validated in §3: `offsetof("a") = 0`,
`offsetof("arr") = 4`, `offsetof("b") = 20`, `offsetof<WithArray>() = 24`, and
`foo.arr[2]` reads/writes the four bytes at **12** (`4 + 2*4`), not 16.

**A correction to the dispatch's arithmetic.** The brief specifies
"`foo.arr[2]` reads at offset `8 + 8 = 16`". That offset does not follow from
`{ a: i32; arr: f32[4]; b: i32 }`: `a` is 4 bytes (`i32`), `f32` has 4-byte
alignment, so `arr` starts at 4 and element 2 is at 12. The manual expansion
measured exactly that: `MixedManual` is 24 bytes, `e0` at 4, `e2` at 12, `b` at
20 (`/tmp/tnprobe/fixture.ts`, WAT constants). An access at 16 would require
`arr` to start at 8 — for example `a: i64` (then the record is 28 bytes:
8 + 16 + 4) or an explicit 4-byte pad after `a` (also 28). Neither is the
24-byte shape the brief specifies. The cells below use the measured 12.

### Cell 1 — refuse (today)

`arr: f32[4]` in a field type is `TS1005: ']' expected`, caret on `[`
(`fixture-refuse.ts(3,11)`; §2.1). **Measured today; no execution needed.**

### Cell 2 — partial (the half-fix states)

**2a. The field is a reference (measured today).** The array scoping's
`StaticArray` field is the middle state the grammar could ship if it accepted
the field without changing its memory model:

```ts
@unmanaged class WithSA { a: i32; data: StaticArray<f32> | null; b: i32 }
```

Measured: `offsetof<WithSA>() = 12`, `offsetof("data") = 4`,
`offsetof("b") = 8` (`/tmp/tnprobe/partial.ts`). The field is four bytes; the
record is 12 where the C shape is 24; a field access loads a reference, not the
elements. This is the state the array scoping measured
(`docs/interop-arrays-scope.md` §2.2) and it is the "offsetof returns 4"
failure in the brief.

**2b. The field is inline but aligned by size (specified from the engine).**
If `T[N]` were given `byteSize = N * elemSize` and fed to the current layout
loop, the results are:

- `f32[4]` (16 bytes, power of two): `arr` at **16**, `b` at 32, total **36**
  (not 24);
- `f32[6]` (24 bytes, not a power of two): the `assert(isPowerOf2(byteSize))` at
  `resolver.ts:3678` fails;
- `u32[8]` (32 bytes, power of two): `keys_held` at **32**, `mouse_dx` at 64
  (C says 16 and 48).

This is not executable without the grammar; it is derived from
`resolver.ts:3677-3682` and is the failure the alignment property in §3.3
prevents.

### Cell 3 — fixed (specified)

`T[N]` parses; the array type carries size `N * elemSize` and alignment
`alignof(element)`; the layout loop lays it out inline. The cell's assertions:

| assertion | expected |
|---|---|
| `offsetof<WithArray>()` | **24** (4 + 16 + 4) |
| `offsetof<WithArray>("a")` | 0 |
| `offsetof<WithArray>("arr")` | **4** |
| `offsetof<WithArray>("b")` | **20** |
| `foo.arr[2] = 7.5` writes | four bytes at **12** |
| `foo.arr[2]` reads | the `f32` at **12** |
| `memory.copy(dst, src, offsetof<WithArray>())` | 24 bytes; `memory.compare(dst, src, 24) = 0` |
| host reading `f32` at 4, 8, 12, 16 | the four elements, in order |

The flat-record copy property is already measured over the 16-`f32` `Mat4f`
shape: `memory.copy(64)` reproduces all 64 bytes, `memory.compare = 0`
(`docs/interop-arrays-scope.md` §4.1, appendix E). The array adds no interior
padding, so the same property holds by construction; the fixture states it
rather than running it, because the grammar does not exist.

**Cells 1 and 3 are specified; cell 2a is measured today; cell 2b is derived
from the layout loop. Nothing in this fixture is executed as a `T[N]` record.**

---

## 5. The dependency graph under `-O3` (Item 5)

### 5.1 `T[N]` → codegen (Follow-up G)

**Hypothesis: at `-O3` the inliner eliminates accessor calls, so a `T[N]` field
access inlines to `base + i * elementSize` without new codegen work.**

**Measured: the emitted sequence is already the hand-rolled one, and the
constant-index case is identical to a named field.**

- Constant index, `-O3`: `readM11` and `readIdx5` are the same 7-byte,
  2-instruction function; the export table aliases them (§1.3-§1.4). A
  hypothetical `arr[5]` has the same shape.
- Dynamic index, `-O3`: 13 bytes / 6 instructions read, 15 / 7 write — the
  hand-rolled `base + i*4` sequence, no accessor call.
- Dynamic index, `-O0`: 14 / 7 and 15 / 7, still no accessor call. The `-O0`
  call tax is a property of *named-field* access, which goes through the
  property getter (`compiler.ts:9493-9590`); the raw load/store path is already
  inline.

**Edge:** if `T[N]` is implemented as a synthetic getter/accessor (the shape
`StaticArray` uses), the `-O0` call tax returns and the feature would depend on
Follow-up G or on the tree staying at `-O3`. If it is implemented by emitting
the address arithmetic directly, it depends on neither. The probe proves the
target sequence exists at both levels; the emission choice is in the compiler,
not in Binaryen. **No Binaryen/codegen floor; front-end emission work is still
required** (the element-access path, §2.3).

Follow-up G is the surface scoping's "compiler accessor inlining"; at `-O1+` the
inliner already does it (`docs/interop-surface-scope.md` §2.1, §3). `T[N]` does
not resurrect G.

### 5.2 `T[N]` → Span

**Independent.** `T[N]` is inline storage in a declared record; a Span-equivalent
is a `(ptr,len)` view over memory the caller supplies. The input records are
flat C records, not views (`input.h:41-72`); the guest reads them by number
(`input.ts:206-208`, `:217-218`). The ABI already passes `(ptr,len)` as two
scalars (`docs/interop-surface-scope.md` §2.4), so Span needs no `T[N]`, and
`T[N]` needs no Span. Neither is a prerequisite for the other
(`docs/interop-surface-scope.md` §3).

### 5.3 `T[N]` → the layout hash

**No move.** The fold is host-side and takes no guest input:

- `pub fn layout_hash() -> u32` (`arena.rs:1030`) hashes `REGIONS`, `TYPES`,
  the header geometry, the `*_FIELDS` tables (`CONTROL_FIELDS`,
  `SESSION_INFO_FIELDS`, `TABLE_FIELDS`, `REGION_DESC_FIELDS`,
  `CALLBACKS_FIELDS`, `EVENT_FIELDS`, `STRING_HALF_FIELDS`,
  `SUBSCRIPTION_FIELDS`, `FRAME_STATE_FIELDS`; `arena.rs:1110-1200`), and scalar
  mode/state constants. Every input is a Rust constant in `arena.rs`; no file,
  no guest module, no guest declaration is read.
- The guest's `offsetof` sites are compile-time checks inside the guest
  (`runtime/wire.ts:308-338`, `ogre/wire.ts:861-901`); they do not write the
  hash. The guest's generated `layout.ts` is produced from `session.json` by
  `tension-framework/build.sh:51-177`, not from guest declarations;
  `LAYOUT_HASH` is `786288195` (`layout.ts:16`).
- The two host records with array fields are input capability records, not in
  the fold: `grep -n 'keys_held\|axes' tension-core/src/session/arena.rs` → no
  hits (the only `[6]` hit is `REGIONS[6].flags`, `arena.rs:1458`). The input
  DSO checks its own structs with `static_assert` (`input.h:58-60`, `:72`), not
  with the hash.
- Measured demonstration that a guest declaration change does not move the
  hash: PR 27 compared two copies of the tree differing only in `wire.ts`
  (128-byte `SessionInfo` on PR 27's branch, 144-byte on the struct branch); the
  artifacts differ by 8 bytes of guest code (`13 682` vs `13 690`), and PR 27
  attributes the difference to the added `capacity12` offset check inside the
  guest, not to a hash move (PR 27 body, "Size delta — reconciled"). The
  branch's `layout_hash` is **786288195** (`layout.ts:16`; `arena.rs:1678`).
  The guest declaration is not an input to the fold.

**An `@unmanaged` class with an array field would not have its offsets folded.**
If a *host* record later gains an array field, the host's `*_FIELDS` constants
and `TYPES`/`REGIONS` entries move first, and the hash moves because the host
changed — not because the guest used `T[N]`. That is the extension shape the
surface scoping already stated (`docs/interop-surface-scope.md` §4.2), not a
cost of this phase.

### 5.4 The graph, stated

```
(0) PR 27: optimizeLevel 3        ← build-configuration; measured
    │  changes named-field economics (335/230/204/204 in the surface probe;
    │  §1: 417/318/292/292 here). Not a prerequisite for T[N]'s element
    │  emission: the raw load/store path is call-free at -O0 too.
    │
(1) T[N] = grammar + new type kind + layout + front-end emission
    ├─ codegen: no Binaryen floor; constant index 7/9 bytes at -O3
    │  (identical to a named field, functions merged); dynamic 13/15;
    │  at -O0 direct emission 11/12/14/15, no call. Follow-up G not required
    │  if emitted directly; required only if lowered through an accessor at -O0.
    ├─ Span: independent; no shared mechanism, no ABI change.
    └─ hash: independent; host-only fold; no move.
(2) Span (std) — independent, may ship before or after.
(3) Follow-up G — not a prerequisite at -O3; not a prerequisite for the direct
    emission at -O0.
```

---

## 6. The flip condition (Item 6)

### 6.1 The count today

**Two guest-visible C records with array fields:**

- `uint32_t keys_held[8]` at `input.h:46` (32 bytes at 16; next field at 48);
- `float axes[6]` at `input.h:69` (24 bytes at 16; next field at 40).

Both are 1-D scalar arrays with literal bounds, and both accesses are a single
`index * elementSize` (`input.ts:206-208`, `:217-218`). **Still two.**

Other `[N]` runs in the input tree are not wire records: `char driver_[32]`,
`char forced_[32]`, `uint32_t keys_held_[8]` are internal thread state
(`input.h:177`, `:180`, `:191`); `uint8_t out[64]` is an out-parameter
(`tension-ogre/src/loader.h:150`). No guest-visible header declares a 2-D array
(`grep '\]\['` → 0) or a struct-typed array member (grep → 0). The 33 framework
`@unmanaged` classes have 0 class-typed fields (§3.4).

### 6.2 What `-O3` changes, and what it does not

The flip condition was count-based: "a third instance … especially one whose
access is not a single `index * elementSize`." `-O3` adds no instance. It
changes the **cost side**:

- At `-O3`, the substitute (16 named fields) and the feature (constant-index
  inline array) are the same 7/9 bytes; the substitute is not cheaper in code.
- At `-O0`, the substitute is *more* expensive for a constant index (14/17
  bytes with the accessor call vs 11/12), because the array path bypasses the
  call. So the feature would buy bytes at `-O0`, and buys none at `-O3`.
- The remaining cost of not having `T[N]` is declarative: 16 names, hand
  offsets, and no dynamic index over a declared field.

**Status: the count threshold has not fired (two). The cost threshold has
moved: the implementation is now grammar + type/layout + front-end emission,
with no Binaryen floor and no hash move.** Whether that is enough to lower the
threshold from three to two is the architect's decision, not a measurement; this
scoping reports both sides and does not decide it in §6.

### 6.3 The declaration count, for the record

On `main` (`31a6626`, after PR 26) the framework has **33** `@unmanaged` class
declarations (24 in `ogre/wire.ts`, 9 in `runtime/wire.ts`) and **128**
`offsetof<` sites (52 in `ogre/wire.ts`, 76 in `runtime/wire.ts`); including
the one example declaration and its two sites, 34 and 130. The arrays scoping's
"33 declarations and 135 offsetof sites" is the struct branch's count
(`phase/interop-struct-impl` @ `62b4da1`). All of them are guest-side, and none
is an input to `layout_hash()` (§5.3).

---

## 7. The version boundary (Item 7)

### 7.1 What T[N] costs at the boundary

**A compiler release, not a coordinated layout release.** The change is parser +
type kind + resolver layout + front-end element emission (§2.3, §3.3). It moves
no ABI (`tension_adapter.h:17`, `:78`; no `(ptr,len)` change), no adapter, and
no hash (§5.3). The change is additive: no existing declaration uses the new
form, so no existing declaration's layout changes.

**The 0.8.0 bundle.** `sizeof` semantics, the `store<T>` refusal, and `T[N]`.
The first two are the struct phase's deferred breaking change
(`docs/interop-scope.md` §8; `docs/interop-surface-scope.md` §5, Option A). That
release rebuilds every adapter and consumer because of the `sizeof` semantics;
`T[N]` rides it and forces no rebuild of its own. Span is independent and may
ship before or after (`docs/interop-surface-scope.md` §5, §7). If the architect
prefers the incremental option, `T[N]` sits in the `0.8.0` half with `sizeof`
and `store`, and Span moves to `0.9.0`; the measurement supports either ordering
because the mechanisms are independent (§5.2).

### 7.2 If PR 27's llama gate never closes

The `-O3` column in §1 is not the tree; the `-O0` column is. What changes:

- Named-field access returns to the call shape (`-O0`: 14/17 bytes per
  read/write, `docs/interop-surface-scope.md` §2.1; the struct phase's
  `+161`-byte finding stands for the tree as configured).
- `T[N]`'s own element access is still call-free if emitted directly: 11/12
  bytes for a constant index, 14/15 for a dynamic index at `-O0` (§1.3). The
  phase does not acquire a codegen floor.
- The value proposition changes sign at `-O0`: `T[N]` is 3-5 bytes *smaller*
  than a named field for a constant element, because it bypasses the accessor;
  at `-O3` it is equal. The feature is not worse without PR 27; the rest of the
  tree is.
- The 0.8.0 bundle is unaffected. The "field access is free" half of the
  C#-gold goal waits on the flag (`docs/interop-surface-scope.md` §2.1, §7),
  not on `T[N]`.

### 7.3 What would force a "no"

1. **A grammar conflict that cannot be disambiguated.** None: the token after
   `[` is `]` or `IntegerLiteral` (`tokenizer.ts:758-773`), and the existing
   empty-bracket form is unchanged (`parser.ts:739-772`). A const `N` is an
   `Identifier` and would be a second production, not a conflict; the tree's
   bounds are literals.
2. **A layout rule that conflicts with declaration order.** None if the array
   type carries element alignment: declaration order is preserved and the
   layout loop gains an array case (§3.3). The *naive* size-as-alignment rule
   does conflict with the C byte tables (`f32[6]` assert, `u32[8]` at 32 not
   16), and that is the design to reject, not a reason to reject the feature.
3. **A codegen floor that `-O3` does not close.** None: the direct emission is
   the hand-rolled sequence at both levels; the constant-index form is identical
   to a named field at `-O3` (§1.3-§1.4).
4. **A hash move.** None implied (§5.3); a future host record with an array
   would move the host's constants first, which is the extension shape, not this
   phase.
5. **A generic or const length.** Out: no declaration in the tree is generic
   (the 33 framework declarations are concrete), and the C bounds are literals.
   A generic `T[N]` would need a type-expression mechanism the parser does not
   have (`docs/interop-arrays-scope.md` §5).

---

## 8. Recommendation

**`0.8.0` — the scoping is implementation-ready; the release is the bundle, not
a standalone compiler bump.**

The recommendation in the terms the dispatch asked for:

| option | what it buys | what it costs | status |
|---|---|---|---|
| **scope now** (implementation-ready; timing is the architect's) | the parser/type/layout work can start now; no waiting on the `sizeof` bundle for the design | a release decision separate from the `sizeof` bundle; if it ships alone, a separate compiler release and consumer transition for two live instances that are already served exactly; the count threshold is still two | supported by the cost, not by the count |
| **0.8.0** (bundle) | rides the release that already breaks `sizeof`; one adapter/consumer rebuild; the parser/type/layout work is bounded; no hash/ABI coordination | a larger 0.8.0 diff; `T[N]` is not independently attributable | **recommended** |
| **candidate** (wait for the third instance) | keeps the original count threshold; no compiler work now | the substitute is exact but declarative; the cost is now measured and bounded; the next C record pays the workaround again | defensible, but the measurement removes the cost objection |

**Why `0.8.0` rather than "scope now":** the count threshold has not fired
(two live records, both 1-D scalar with literal bounds, both served exactly by
`input.ts:206-208` and `:217-218`). The `-O3` measurement removes the
*codegen* objection — the phase is grammar + type/layout + front-end emission,
not grammar + layout + Binaryen work — and the hash check removes the
coordination objection. What remains is a compiler release; the tree already has
one scheduled for `sizeof`/`store`. Bundling is the cheaper use of that release,
and the `sizeof` break is the reason every adapter rebuilds anyway
(`docs/interop-surface-scope.md` §5). This is the
surface scoping's "then `T[N]`, as already scoped for 0.8.0"
(`docs/interop-surface-scope.md` §7), with the codegen question now measured.

**The bundle, stated:** `sizeof` semantics, `store<T>` refusal, `T[N]`. Span is
not in the bundle; it is a std type with no ABI or hash move and may ship before
or after (`docs/interop-surface-scope.md` §5, §7). If the architect chooses the
incremental option, `T[N]` stays in the `0.8.0` half.

**What would move the recommendation to "candidate":** holding the count
threshold as a hard rule. The measurement does not supply a third instance. If
the architect holds it, the correct action is to record this cost and wait; the
next guest-visible C record with an array field — especially one with a 2-D
index, a record-stride walk, or a non-literal bound — is the measurement that
fires it (`docs/interop-arrays-scope.md` §9).

**What would move it to "scope now":** deciding that two live records plus the
16-field `Mat4f` expansion and the `reservedN` runs are enough declarative
burden to justify the surface before the next C record arrives. The code cost
supports that reading at `-O3` (zero per access) and at `-O0` (the array form is
smaller); the need count does not.

---

## 9. What could not be measured read-only

- **The `T[N]` form itself** — parse, layout, field access, copy. The grammar
  does not exist; cells 1 and 3 of the fixture are specified, not executed.
  Cell 2a is measured with `StaticArray` (12 bytes / field at 4); cell 2b is
  derived from `resolver.ts:3677-3682`, not run.
- **The exact assertion failure for a 24-byte array field** (`f32[6]`) — derived
  from `assert(isPowerOf2(byteSize))` (`resolver.ts:3678`), not compiled.
- **A `T[N]` field in a host-read record and its hash** — not compilable. The
  fold is host-only (§5.3), so no move is implied; the host-side measurement
  would be a different phase (a C struct change, then `layout_hash()`).
- **The OGRE path at `-O3`** — PR 27's gate measured the four OGRE fixtures
  (5/5, 6/6, 8/8, 9/9) and the examples; this pass did not re-run them. The
  numbers are cited from PR 27, not re-measured.
- **The real `tension-input` DSO at runtime** — the input records need SDL3 and
  a window; the layout claim rests on the C byte tables (`input.h:41-72`,
  `tension_input.h:133-178`) and the measured manual expansions (§3.2).
- **The 16 external consumers at `-O3`** — PR 27 did not run them; this pass
  did not either.
- **The inliner on a synthetic `T[N]` accessor** — no such type exists; the
  direct emission is measured via the hand-rolled `load`/`store`, and the
  accessor-based alternative is the `-O0` call shape in §1.3.
- **Whether a const `N` is required** — a grammar design question, not a
  measurement. The tree's bounds are literals; a const would need a new
  type-expression path.
- **The full framework build at `-O0` and `-O3`** — the probes are
  module-sized; PR 27's example and fixture sizes are cited, not re-run.

---

## 10. Architecture decision — 0.8.0, bundled

**Decided by the architect:** 0.8.0 is the interop release, and it ships the
three pieces **together** — `sizeof` returning the layout size, the `store<T>`
refusal for `@unmanaged` struct copy, and `T[N]` inline arrays. Span is
independent and ships before or after, outside the bundle.

This section records the decision; §8 above is the scoping's own recommendation
and its tradeoff table, unchanged. Where §8 lists "scope now" and "candidate"
as live options, this decision closes them for this release.

The four reasons, as given:

1. **`T[N]` alone is incoherent while `sizeof` still returns 4.** A record with
   an inline array has a layout size of `N * elementSize` plus its scalars
   (§3.1, §4), and `sizeof<Foo>` returns 4 for every class today (the struct
   phase's root cause, `docs/interop-scope.md` §1-§2). A guest declaring
   `arr: f32[4]` could not state its own record's size. The two features are
   one surface.
2. **The flip condition has not fired.** Two guest-visible C records with array
   fields (`input.h:46`, `:69`), against a threshold of three (§6.1, §6.2).
   Shipping `T[N]` is therefore a decision about the release's coherence, not a
   response to a count that crossed.
3. **The bundle is affordable.** No hash move (§5.3), no adapter rebuild, no
   codegen floor (§5.1): a compiler release with the `sizeof` semantics change
   as its only coordination cost, and that collateral is measured in the struct
   phase. §1's numbers are conditional on PR 27 merging; the affordability does
   not depend on it (§7.2).
4. **The C#-gold claim is coherent only when the four pieces land.** The goal
   in `docs/interop-surface-scope.md` §4-§7 has four parts — declare once and
   the layout follows, size, field offset, copy — plus free field access. The
   access-cost half is PR 27's flag; the remaining three are `sizeof`,
   `T[N]`, and the named copy the `store<T>` refusal forces a caller onto. A
   subset leaves the claim half-true.

**What this changes in the scoping:** nothing measured. The `-O3` column, the
layout rule, the grammar disambiguation, the fixture, and the hash finding
stand as written. The recommendation is now the decision, and the next
deliverable is the 0.8.0 implementation scoping.

---

## Appendix — probes and citations

All probes in `/tmp/tnprobe/`, compiled with
`examples/log/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js`
(`Version 0.7.1`) and `--target release --runtime incremental`.

**A. Field access (`mat2.ts`).**

```
-O0: 417 wasm bytes, 156 code bytes, 6 accessor calls, 6 accessor functions
-O1: 318 wasm bytes, 107 code bytes, 0 calls, 0 accessors
-O2: 292 wasm bytes,  85 code bytes, 0 calls, 0 accessors
-O3: 292 wasm bytes,  85 code bytes, 0 calls, 0 accessors
sizeMat = 64, offM33 = 60 at both levels
```

**B. Body sizes (`dump.py`, wasm code section).**

```
-O0: readM11 caller 7 + accessor 7; writeM11 8 + 9; readIdx5 11;
     writeIdx5 12; readIdx 14; writeIdx 15
-O3: readM11 7; writeM11 9; readIdx5 = readM11 (alias); writeIdx5 = writeM11
     (alias); readIdx 13; writeIdx 15
```

**C. Layout (`layout.ts`, `cshape.ts`, `fixture.ts`).**

```
MixedManual: size 24, e0 4, e2 12, b 20
StateManual: size 96, k0 16, mouse_dx 48, mouse_dxf 56, seq 80
PadManual:   size 48, a0 16, reserved1 40
Align8:      x 8, size 16           (u64 alignment honored)
AxesManual:  a0 4, b 28, size 32    (24-byte run after i32, no interior padding)
```

**D. Refusals and controls.**

```
refuse.ts        @unmanaged class A { data: f32[4]; }        TS1005 (1,31)
fixture-refuse   arr: f32[4];                                TS1005 (3,11)
arity.ts         StaticArray<f32, 4>                         TS1110 (1,45)
partial.ts       StaticArray<f32> | null field                12 / 4 / 8
emptybr.ts       f32[] field                                  12 / 4
```

**E. Source citations.**

- Parser: `third_party/assemblyscript/src/parser.ts:537` (`parseType`),
  `:739-772` (bracket loop and `Array<T>`), `:743-746` (`_0_expected`),
  `:681-696` (type arguments), `:699-706` (type fallback), `:1062` (field type),
  `:613` (tuple behind `MultiValue`), `:4216-4219` (integer literal).
- Tokenizer: `src/tokenizer.ts:169-170` (literal token names), `:758-773`
  (digit branch), `:1306` (`readInteger`).
- Diagnostic: `src/diagnosticMessages.json:69` (`_0_expected` = 1005).
- AST: `src/ast.ts:50-53` (type node kinds), `:844` (`TypeNode`), `:913`,
  `:940`, `:958` (the three type nodes).
- Resolver: `src/resolver.ts:167-180` (`resolveType` dispatch), `:3595-3723`
  (class layout), `:3677-3682` (size/alignment/assert), `:3723`
  (`nextMemoryOffset`).
- Types: `src/types.ts:28-100` (`TypeKind`; class types are `Usize` + `Class`),
  `:193-201` (`byteSize`, `alignLog2`).
- Builtins: `src/builtins.ts:1256-1275` (`alignof`), `:1278-1332` (`offsetof`).
- Compiler: `src/compiler.ts:7351-7390` (element access via `IndexedGet`),
  `:9493-9590` (property/field access via the getter).
- Std: `std/assembly/staticarray.ts:13` (arity-1 class), `:60-62`
  (allocation-derived length).
- C headers: `tension-input/src/input.h:41-72`; `tension-input/include/
  tension_input.h:133-178`.
- Guest readers: `tension-framework/assembly/input.ts:77-91`, `:206-208`,
  `:217-218`; `tension-framework/assembly/ogre/wire.ts:80-87`, `:138-173`,
  `:283-345`, `:861-901`; `tension-framework/assembly/runtime/wire.ts:157-191`,
  `:308-338`.
- Hash: `tension-core/src/session/arena.rs:1030-1104` (the fold),
  `:1110-1200` (the field tables), `:1458` (the only `[6]` hit),
  `:1660-1685` (the recorded hash); `tension-framework/build.sh:51-177`
  (the generator); `tension-framework/assembly/runtime/layout.ts:16`
  (`786288195`).
- Prior scopes: `docs/interop-arrays-scope.md` §1-§2 (refusals,
  `StaticArray`), §4 (copy), §8.2/§8.6 (syntax tradeoffs), §9 (the flip
  condition); `docs/interop-surface-scope.md` §2.1/§2.3 (the `-O3` ladder,
  accessor calls), §2.4 (`(ptr,len)` ABI), §3 (dependency graph), §4.2 (hash
  extension), §5/§7 (the 0.8.0 bundle); `docs/interop-scope.md` §1-§2 (class ≡
  `usize`), §8 (the 0.8.0 reservation).
- PR 27: `gh pr view 27` (state OPEN, `mergeStateStatus: CLEAN`; the llama gate
  and the 128/144 `SessionInfo` size delta); commit `cef127f`.
